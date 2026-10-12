import { expect, test } from "bun:test"
import {
  SessionManager,
  type AuthorizedFile,
  type TransferAuthorization,
} from "../services/session-auth.js"

// Verified identities are complete, fixed-length Peer IDs (P1-36).
const PEER_A = new TextEncoder().encode(`z${"1".repeat(49)}`)
const PEER_B = new TextEncoder().encode(`z${"2".repeat(49)}`)

const FILES: AuthorizedFile[] = [
  { name: "report.pdf", bytes: 1_024, sha256: "a".repeat(64) },
  { name: "photo.png", bytes: 2_048, sha256: "b".repeat(64) },
]

function confirmedSession(manager: SessionManager, peer = PEER_A) {
  const session = manager.createSession("receiver")
  manager.recordIdentityConfirmation(session.id, "local", peer)
  manager.recordIdentityConfirmation(session.id, "remote", peer)
  return session
}

test("Gate B: both independent confirmations are required before authorization", () => {
  const manager = new SessionManager()
  const session = manager.createSession("receiver")
  expect(manager.isIdentityConfirmed(session.id)).toBe(false)
  expect(() => manager.authorizeTransfer(session.id, FILES)).toThrow()

  manager.recordIdentityConfirmation(session.id, "local", PEER_A)
  expect(manager.isIdentityConfirmed(session.id)).toBe(false)
  // One confirmation is not enough: a compliant endpoint authorizes nothing.
  expect(() => manager.authorizeTransfer(session.id, FILES)).toThrow()

  manager.recordIdentityConfirmation(session.id, "remote", PEER_A)
  expect(manager.isIdentityConfirmed(session.id)).toBe(true)
  expect(() => manager.authorizeTransfer(session.id, FILES)).not.toThrow()
})

test("identity mismatch between the two confirmations fails closed and destroys the session", () => {
  const manager = new SessionManager()
  const session = manager.createSession("receiver")
  manager.recordIdentityConfirmation(session.id, "local", PEER_A)
  expect(() => manager.recordIdentityConfirmation(session.id, "remote", PEER_B)).toThrow()
  // The session is gone: nothing from it can authorize bytes afterwards.
  expect(() => manager.authorizeTransfer(session.id, FILES)).toThrow()
  expect(manager.activeSessionCount).toBe(0)
})

test("authorization tokens are single-use: replay is rejected", () => {
  const manager = new SessionManager()
  const session = confirmedSession(manager)
  const auth = manager.authorizeTransfer(session.id, FILES)
  expect(() => manager.acceptTransfer(auth, PEER_A, FILES)).not.toThrow()
  expect(() => manager.acceptTransfer(auth, PEER_A, FILES)).toThrow()
})

test("cross-session token presentation is rejected", () => {
  const manager = new SessionManager()
  const first = confirmedSession(manager)
  const second = confirmedSession(manager)
  const auth = manager.authorizeTransfer(first.id, FILES)
  const forged: TransferAuthorization = { ...auth, sessionId: second.id }
  expect(() => manager.acceptTransfer(forged, PEER_A, FILES)).toThrow()
})

test("wrong peer identity fails the token validation", () => {
  const manager = new SessionManager()
  const session = confirmedSession(manager)
  const auth = manager.authorizeTransfer(session.id, FILES)
  expect(() => manager.acceptTransfer(auth, PEER_B, FILES)).toThrow()
})

test("altered file set invalidates the authorization", () => {
  const manager = new SessionManager()
  const session = confirmedSession(manager)
  const auth = manager.authorizeTransfer(session.id, FILES)
  const tampered: TransferAuthorization = {
    ...auth,
    files: [{ name: "evil.sh", bytes: 64, sha256: "c".repeat(64) }],
  }
  expect(() => manager.acceptTransfer(tampered, PEER_A, FILES)).toThrow()
})

test("expired sessions fail closed", () => {
  let now = 1_000_000
  const manager = new SessionManager({ sessionTtlMs: 60_000, now: () => now })
  const session = confirmedSession(manager)
  const auth = manager.authorizeTransfer(session.id, FILES)
  now += 61_000
  expect(() => manager.acceptTransfer(auth, PEER_A, FILES)).toThrow()
  expect(manager.activeSessionCount).toBe(0)
})

test("destroyed sessions cannot authorize: restart-equivalent state is gone", () => {
  const manager = new SessionManager()
  const session = confirmedSession(manager)
  const auth = manager.authorizeTransfer(session.id, FILES)
  manager.destroySession(session.id)
  expect(() => manager.acceptTransfer(auth, PEER_A, FILES)).toThrow()
  expect(() => manager.authorizeTransfer(session.id, FILES)).toThrow()
  expect(manager.activeSessionCount).toBe(0)
})

test("Gate C: receiver acceptance is a separate action requiring the exact pending session and file set", () => {
  const manager = new SessionManager()
  const session = confirmedSession(manager)
  const auth = manager.authorizeTransfer(session.id, FILES)

  // Accepting a file that was not authorized fails.
  expect(() =>
    manager.acceptTransfer(auth, PEER_A, [
      { name: "other.txt", bytes: 10, sha256: "d".repeat(64) },
    ]),
  ).toThrow()

  // An explicit subset of the authorized set is fine; anything unselected
  // stays unauthorized.
  const accepted = manager.acceptTransfer(auth, PEER_A, [FILES[0]!])
  expect(accepted.acceptedFiles).toHaveLength(1)
  expect(accepted.acceptedFiles[0]!.name).toBe("report.pdf")

  // Empty acceptance is not consent.
  const manager2 = new SessionManager()
  const session2 = confirmedSession(manager2)
  const auth2 = manager2.authorizeTransfer(session2.id, FILES)
  expect(() => manager2.acceptTransfer(auth2, PEER_A, [])).toThrow()
})

test("acceptance without Gate B confirmations is impossible", () => {
  const manager = new SessionManager()
  const session = manager.createSession("receiver")
  // Forge an authorization-shaped object: without confirmations the session
  // cannot have produced a valid token, so validation must fail.
  const forged: TransferAuthorization = {
    token: new Uint8Array(32),
    sessionId: session.id,
    files: FILES,
  }
  expect(() => manager.acceptTransfer(forged, PEER_A, FILES)).toThrow()
})

test("session ids and nonces are unpredictable and unique per session", () => {
  const manager = new SessionManager()
  const ids = new Set<string>()
  for (let i = 0; i < 50; i++) {
    const session = manager.createSession(i % 2 === 0 ? "sender" : "receiver")
    ids.add(Buffer.from(session.id).toString("hex"))
    expect(session.id).toHaveLength(16)
    expect(session.nonce).toHaveLength(16)
  }
  expect(ids.size).toBe(50)
})

test("role swap invalidates: a sender-session token is bound to its session, not its role label", () => {
  // The binding is (session id, peer identity, nonce, file set). A token
  // minted for one session never validates against another, regardless of
  // role claims — there is no role field to swap that survives validation.
  const manager = new SessionManager()
  const sender = manager.createSession("sender")
  manager.recordIdentityConfirmation(sender.id, "local", PEER_A)
  manager.recordIdentityConfirmation(sender.id, "remote", PEER_A)
  const auth = manager.authorizeTransfer(sender.id, FILES)

  const receiver = manager.createSession("receiver")
  manager.recordIdentityConfirmation(receiver.id, "local", PEER_A)
  manager.recordIdentityConfirmation(receiver.id, "remote", PEER_A)
  const replayed: TransferAuthorization = { ...auth, sessionId: receiver.id }
  expect(() => manager.acceptTransfer(replayed, PEER_A, FILES)).toThrow()
})

test("gate state machine: transitions are forward-only and ordered (P1-14)", () => {
  const manager = new SessionManager()
  const session = manager.createSession("receiver")
  // No skipping: authorization before both confirmations fails.
  expect(() => manager.authorizeTransfer(session.id, FILES)).toThrow(/Gate B/)
  manager.recordIdentityConfirmation(session.id, "local", PEER_A)
  manager.recordIdentityConfirmation(session.id, "remote", PEER_A)
  const auth = manager.authorizeTransfer(session.id, FILES)
  // Authorizing twice is rejected: the gate already moved on.
  expect(() => manager.authorizeTransfer(session.id, FILES)).toThrow()
  // Acceptance consumes the token; a second acceptance is a replay.
  expect(() => manager.acceptTransfer(auth, PEER_A, FILES)).not.toThrow()
  expect(() => manager.acceptTransfer(auth, PEER_A, FILES)).toThrow(/already used/)
})

test("transcript-derived session ids are accepted; duplicates rejected (P1-12)", () => {
  const manager = new SessionManager()
  const id = new Uint8Array(16).fill(3)
  const s = manager.createSession("sender", id)
  expect(Buffer.from(s.id).equals(Buffer.from(id))).toBe(true)
  expect(() => manager.createSession("receiver", id)).toThrow(/collision/)
  expect(() => manager.createSession("sender", new Uint8Array(8))).toThrow(/16 bytes/)
})

test("sweepExpired removes dead sessions", () => {
  let now = 1_000_000
  const manager = new SessionManager({ sessionTtlMs: 60_000, now: () => now })
  manager.createSession("sender")
  manager.createSession("receiver")
  expect(manager.activeSessionCount).toBe(2)
  now += 61_000
  expect(manager.sweepExpired()).toBe(2)
  expect(manager.activeSessionCount).toBe(0)
})
