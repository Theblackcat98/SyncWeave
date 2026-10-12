import { expect, test } from "bun:test"
import {
  formatPeerFingerprint,
  generateEphemeralIdentity,
  PEER_ID_LENGTH,
  PEER_FINGERPRINT_CHARS,
} from "../services/peer-id.js"
import { SessionManager } from "../services/session-auth.js"
import { receiveFiles } from "../services/transfer-protocol.js"
import { dialNoise } from "../services/transport.js"
import { startProtoHarness } from "./helpers/proto-harness.js"

// P1-35: the Peer ID has a fixed length, and the UI shows a fingerprint whose
// characters all carry key material. P1-36: session-auth refuses identities
// that are not complete Peer IDs.

test("P1-35: every Peer ID is exactly 50 characters, base58, with the z prefix", () => {
  const seen = new Set<string>()
  for (let i = 0; i < 300; i++) {
    const { peerId } = generateEphemeralIdentity()
    expect(peerId.length).toBe(PEER_ID_LENGTH)
    expect(peerId).toMatch(/^z[1-9A-HJ-NP-Za-km-z]{49}$/)
    seen.add(peerId)
  }
  expect(seen.size).toBe(300)
})

test("P1-35: the fingerprint is 16 trailing characters in groups of 4, distinct per key", () => {
  const fingerprints = new Set<string>()
  for (let i = 0; i < 300; i++) {
    const { peerId } = generateEphemeralIdentity()
    const fp = formatPeerFingerprint(peerId)
    expect(fp).toMatch(/^[1-9A-HJ-NP-Za-km-z]{4}(-[1-9A-HJ-NP-Za-km-z]{4}){3}$/)
    expect(fp.replaceAll("-", "")).toBe(peerId.slice(-PEER_FINGERPRINT_CHARS))
    fingerprints.add(fp)
  }
  expect(PEER_FINGERPRINT_CHARS).toBeGreaterThanOrEqual(16)
  expect(fingerprints.size).toBe(300)
})

test("P1-35: the fingerprint refuses anything that is not a well-formed Peer ID", () => {
  expect(() => formatPeerFingerprint("12D3KooWabcdefghijklmnopqrstuvwxyz0123456789")).toThrow(/well-formed/)
  expect(() => formatPeerFingerprint("z0OIl")).toThrow(/well-formed/)
  expect(() => formatPeerFingerprint("")).toThrow(/well-formed/)
})

const PEER = new TextEncoder().encode(`z${"1".repeat(49)}`)

test("P1-36: an empty identity is never accepted as confirmed", () => {
  const manager = new SessionManager()
  const session = manager.createSession("receiver")
  expect(() => manager.recordIdentityConfirmation(session.id, "local", new Uint8Array(0))).toThrow(
    /exactly 50 bytes/,
  )
  expect(() => manager.recordIdentityConfirmation(session.id, "remote", new Uint8Array(0))).toThrow(
    /exactly 50 bytes/,
  )
  expect(manager.isIdentityConfirmed(session.id)).toBe(false)
})

test("P1-36: a partial or oversize identity is refused; a complete Peer ID is accepted", () => {
  const manager = new SessionManager()
  const session = manager.createSession("receiver")
  expect(() => manager.recordIdentityConfirmation(session.id, "local", PEER.subarray(0, 49))).toThrow()
  expect(() =>
    manager.recordIdentityConfirmation(session.id, "local", new Uint8Array(PEER_ID_LENGTH + 1)),
  ).toThrow()
  manager.recordIdentityConfirmation(session.id, "local", PEER)
  manager.recordIdentityConfirmation(session.id, "remote", PEER)
  expect(manager.isIdentityConfirmed(session.id)).toBe(true)
})

test("N8: reusing an identity fails closed and closes the accepted channel", async () => {
  const h = await startProtoHarness()
  try {
    const reused = generateEphemeralIdentity()
    // First session: the sender leaves at once, so this receive fails quickly.
    const firstChannel = h.nextChannel()
    const dialer1 = await dialNoise("127.0.0.1", h.port)
    dialer1.channel.abort()
    const firstHs = await firstChannel
    const first = await receiveFiles({
      channel: firstHs.channel,
      handshakeHash: firstHs.handshakeHash,
      identity: reused,
      destinationDirectory: h.destDir,
      onTransferRequest: async ({ files }) => files,
    }).catch((error: unknown) => error)
    expect(first).toBeInstanceOf(Error)

    // Second session presents the same identity on a fresh connection.
    const secondChannel = h.nextChannel()
    const dialer2 = await dialNoise("127.0.0.1", h.port)
    const hs = await secondChannel
    const error = await receiveFiles({
      channel: hs.channel,
      handshakeHash: hs.handshakeHash,
      identity: reused,
      destinationDirectory: h.destDir,
      onTransferRequest: async ({ files }) => files,
    }).catch((e: unknown) => e)
    expect((error as Error).message).toMatch(/identity reuse/)
    expect(hs.channel.isClosed).toBe(true)
    dialer2.channel.abort()
  } finally {
    await h.close()
  }
}, 30_000)
