import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  generateEphemeralIdentity,
  listenNoise,
  receiveFiles,
  sendFiles,
  type ProtocolFile,
} from "../services/transfer-protocol.js"

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

interface Harness {
  senderDir: string
  destDir: string
  port: number
  closeListener: () => Promise<void>
  nextChannel: () => Promise<import("../services/transport.js").HandshakeResult>
}

async function startHarness(): Promise<Harness> {
  const senderDir = await makeTempDir("sw-send-")
  const destDir = await makeTempDir("sw-dest-")
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  const accepted: Array<import("../services/transport.js").HandshakeResult> = []
  const waiters: Array<(v: import("../services/transport.js").HandshakeResult) => void> = []
  ;(async () => {
    for await (const hs of listener.accept()) {
      const w = waiters.shift()
      if (w) w(hs)
      else accepted.push(hs)
    }
  })()
  return {
    senderDir,
    destDir,
    port: listener.port,
    closeListener: () => listener.close(),
    nextChannel: () =>
      new Promise((resolve) => {
        const pending = accepted.shift()
        if (pending) resolve(pending)
        else waiters.push(resolve)
      }),
  }
}

async function writeTestFile(dir: string, name: string, bytes: number): Promise<string> {
  const path = join(dir, name)
  const data = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) {
    data[i] = (i * 31 + 7) & 0xff
  }
  await writeFile(path, data)
  return path
}

test("loopback: two files transfer end-to-end with verified bytes and hashes", async () => {
  const h = await startHarness()
  try {
    const p1 = await writeTestFile(h.senderDir, "hello.txt", 1_234)
    const p2 = await writeTestFile(h.senderDir, "blob.bin", 200_000) // multi-chunk

    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()

    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      return receiveFiles({
        channel: hs.channel,
        handshakeHash: hs.handshakeHash,
        expectedPeerId: senderIdentity.peerId,
        identity: receiverIdentity,
        destinationDirectory: h.destDir,
        onTransferRequest: async (req) => {
          expect(req.files).toHaveLength(2)
          return req.files // accept all
        },
      })
    })()

    const sendResult = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [
        { path: p1, name: "hello.txt" },
        { path: p2, name: "blob.bin" },
      ],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    })
    // P0-2: success is reported only on receiver acknowledgement.
    expect(sendResult.outcomes).toHaveLength(2)
    for (const o of sendResult.outcomes) {
      expect(o.ok).toBe(true)
      expect(o.errorCode).toBeUndefined()
    }
    expect(sendResult.outcomes[0]!.name).toBe("hello.txt")
    expect(sendResult.verifiedPeerId).toBe(receiverIdentity.peerId)
    expect(sendResult.sas).toMatch(/^\d{4}-\d{4}-\d{4}$/)
    // Both ends derive the same SAS from the handshake hash.
    const receiverResult = await receiverDone
    expect(receiverResult.sas).toBe(sendResult.sas)
    expect(receiverResult.verifiedPeerId).toBe(senderIdentity.peerId)
    expect(receiverResult.sas).toMatch(/^\d{4}-\d{4}-\d{4}$/)
    const received = receiverResult.files
    expect(received).toHaveLength(2)
    for (const [original, got] of [
      [p1, received[0]!],
      [p2, received[1]!],
    ] as const) {
      const originalBytes = await readFile(original)
      const receivedBytes = await readFile(got.path)
      expect(receivedBytes.equals(originalBytes)).toBe(true)
      expect(got.bytes).toBe(originalBytes.length)
      expect(got.sha256).toHaveLength(64)
    }
  } finally {
    await h.closeListener()
    await rm(h.senderDir, { recursive: true, force: true })
    await rm(h.destDir, { recursive: true, force: true })
  }
}, 30_000)

test("loopback: filename collision auto-renames instead of overwriting", async () => {
  const h = await startHarness()
  try {
    const p1 = await writeTestFile(h.senderDir, "report.txt", 100)
    await writeFile(join(h.destDir, "report.txt"), "pre-existing content")

    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()

    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      return receiveFiles({
        channel: hs.channel,
        handshakeHash: hs.handshakeHash,
        expectedPeerId: senderIdentity.peerId,
        identity: receiverIdentity,
        destinationDirectory: h.destDir,
        onTransferRequest: async (req) => req.files,
      })
    })()

    await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "report.txt" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    })

    const result = await receiverDone
    const received = result.files
    expect(received).toHaveLength(1)
    expect(received[0]!.name).toBe("report (1).txt")
    // The pre-existing file is untouched.
    expect((await readFile(join(h.destDir, "report.txt"))).toString()).toBe("pre-existing content")
    expect((await readFile(received[0]!.path)).equals(await readFile(p1))).toBe(true)
  } finally {
    await h.closeListener()
    await rm(h.senderDir, { recursive: true, force: true })
    await rm(h.destDir, { recursive: true, force: true })
  }
}, 30_000)

test("loopback: subset acceptance transfers only the accepted file", async () => {
  const h = await startHarness()
  try {
    const p1 = await writeTestFile(h.senderDir, "keep.txt", 50)
    const p2 = await writeTestFile(h.senderDir, "skip.txt", 60)

    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()

    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      return receiveFiles({
        channel: hs.channel,
        handshakeHash: hs.handshakeHash,
        expectedPeerId: senderIdentity.peerId,
        identity: receiverIdentity,
        destinationDirectory: h.destDir,
        onTransferRequest: async (req) => req.files.filter((f) => f.name === "keep.txt"),
      })
    })()

    await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [
        { path: p1, name: "keep.txt" },
        { path: p2, name: "skip.txt" },
      ],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    })

    const received = (await receiverDone).files
    expect(received).toHaveLength(1)
    expect(received[0]!.name).toBe("keep.txt")
  } finally {
    await h.closeListener()
    await rm(h.senderDir, { recursive: true, force: true })
    await rm(h.destDir, { recursive: true, force: true })
  }
}, 30_000)

test("loopback: wrong expected Peer ID aborts before any file metadata flows", async () => {
  const h = await startHarness()
  try {
    const p1 = await writeTestFile(h.senderDir, "secret.txt", 100)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const impostorIdentity = generateEphemeralIdentity()

    let requestSeen = false
    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      try {
        await receiveFiles({
          channel: hs.channel,
          handshakeHash: hs.handshakeHash,
          expectedPeerId: senderIdentity.peerId,
          identity: receiverIdentity,
          destinationDirectory: h.destDir,
          onTransferRequest: async (req: { files: ProtocolFile[] }) => {
            requestSeen = true
            return req.files
          },
        })
      } catch {
        // Expected: the receiver aborts on identity mismatch.
      }
    })()

    // Sender presents a valid proof, but for the WRONG identity: the
    // receiver must reject before any transfer request is processed.
    await expect(
      sendFiles({
        host: "127.0.0.1",
        port: h.port,
        files: [{ path: p1, name: "secret.txt" }],
        expectedPeerId: receiverIdentity.peerId,
        identity: impostorIdentity,
      }),
    ).rejects.toThrow()
    await receiverDone
    expect(requestSeen).toBe(false)
  } finally {
    await h.closeListener()
    await rm(h.senderDir, { recursive: true, force: true })
    await rm(h.destDir, { recursive: true, force: true })
  }
}, 30_000)

test("loopback: receiver decline sends an explicit DECLINE frame, no file bytes", async () => {
  const h = await startHarness()
  try {
    const p1 = await writeTestFile(h.senderDir, "nope.txt", 100)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()

    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      await expect(
        receiveFiles({
          channel: hs.channel,
          handshakeHash: hs.handshakeHash,
          expectedPeerId: senderIdentity.peerId,
          identity: receiverIdentity,
          destinationDirectory: h.destDir,
          onTransferRequest: async () => [],
        }),
        // P1-9: the receiver reports "declined", and the sender sees an
        // explicit DECLINE frame — not a bare close or exception text.
      ).rejects.toThrow(/declined by user/)
    })()

    await expect(
      sendFiles({
        host: "127.0.0.1",
        port: h.port,
        files: [{ path: p1, name: "nope.txt" }],
        expectedPeerId: receiverIdentity.peerId,
        identity: senderIdentity,
      }),
    ).rejects.toThrow(/declined by receiver/)
    await receiverDone
    // Nothing was written to the destination.
    expect(await readdir(h.destDir)).toHaveLength(0)
  } finally {
    await h.closeListener()
    await rm(h.senderDir, { recursive: true, force: true })
    await rm(h.destDir, { recursive: true, force: true })
  }
}, 30_000)

test("peer-id: generated identities are unique and verify exactly", async () => {
  const { peerIdFromPublicKey, verifyPeerId } = await import("../services/peer-id.js")
  const a = generateEphemeralIdentity()
  const b = generateEphemeralIdentity()
  expect(a.peerId).not.toBe(b.peerId)
  expect(a.peerId.startsWith("z")).toBe(true)
  expect(verifyPeerId(a.peerId, a.peerId)).toBe(true)
  expect(verifyPeerId(a.peerId, b.peerId)).toBe(false)
  // Flip the last character to a *different* base58 char (the old test used
  // a fixed "x", which is a no-op when the ID already ends in "x" — flaky).
  const last = a.peerId[a.peerId.length - 1]
  const flipped = last === "1" ? "2" : "1"
  expect(verifyPeerId(a.peerId, a.peerId.slice(0, -1) + flipped)).toBe(false)
  expect(peerIdFromPublicKey(a.publicKey)).toBe(a.peerId)
  await mkdir(tmpdir(), { recursive: true })
})

import {
  enforceBudgets,
  validateProtocolFiles,
  validateIdentityProofBody,
  validateTransferAcceptBody,
  validateFileResultBody,
  validateSessionResultBody,
  validateSignalBody,
  sasFromHandshakeHash,
  sessionIdFromHandshakeHash,
  signProof,
  verifyProof,
  BUDGET_MAX_FILES,
} from "../services/transfer-protocol.js"

function goodFile(name = "a.txt", bytes = 100): { name: string; bytes: number; sha256: string } {
  return { name, bytes, sha256: "a".repeat(64) }
}

test("budgets: receiver-side enforcement rejects over-limit sessions", () => {
  // 26 files
  expect(() =>
    enforceBudgets(Array.from({ length: BUDGET_MAX_FILES + 1 }, (_, i) => goodFile(`f${i}.txt`)), "receive"),
  ).toThrow(/file count/)
  // total over 10 GiB via many 2 GiB files
  expect(() =>
    enforceBudgets(Array.from({ length: 6 }, (_, i) => goodFile(`f${i}.txt`, 2 * 1024 * 1024 * 1024)), "receive"),
  ).toThrow(/session total/)
  // single file over 2 GiB
  expect(() => enforceBudgets([goodFile("big.bin", 2 * 1024 * 1024 * 1024 + 1)], "receive")).toThrow(/too large/)
  // negative / non-integer sizes
  expect(() => enforceBudgets([{ ...goodFile(), bytes: -5 }], "receive")).toThrow(/invalid file size/)
  expect(() => enforceBudgets([{ ...goodFile(), bytes: 1.5 }], "receive")).toThrow(/invalid file size/)
  // empty set
  expect(() => enforceBudgets([], "receive")).toThrow(/file count/)
  // exactly at limits passes
  expect(() =>
    enforceBudgets(Array.from({ length: BUDGET_MAX_FILES }, (_, i) => goodFile(`f${i}.txt`, 10)), "receive"),
  ).not.toThrow()
})

test("validation: malformed protocol JSON fails closed", () => {
  expect(() => validateProtocolFiles("nope", "t")).toThrow(/not an array/)
  expect(() => validateProtocolFiles([null], "t")).toThrow(/not an object/)
  expect(() => validateProtocolFiles([{ ...goodFile(), name: "" }], "t")).toThrow(/bad file name/)
  expect(() => validateProtocolFiles([{ ...goodFile(), sha256: "zzz" }], "t")).toThrow(/bad sha256/)
  expect(() => validateProtocolFiles([{ ...goodFile(), sha256: "A".repeat(64) }], "t")).toThrow(/bad sha256/)
  expect(() => validateIdentityProofBody({})).toThrow(/bad version/)
  expect(() =>
    validateIdentityProofBody({ v: 2, role: "sender", peerId: "x", identityPublicKey: "y" }),
  ).toThrow(/bad identitySignature/)
  expect(() =>
    validateIdentityProofBody({ v: 2, role: "sender", peerId: "x", identityPublicKey: "y", identitySignature: "z" }),
  ).not.toThrow()
})

test("v2: SAS is deterministic and formatted as three digit groups", () => {
  const h1 = new Uint8Array(32).fill(7)
  const h2 = new Uint8Array(32).fill(8)
  expect(sasFromHandshakeHash(h1)).toMatch(/^\d{4}-\d{4}-\d{4}$/)
  expect(sasFromHandshakeHash(h1)).toBe(sasFromHandshakeHash(h1))
  expect(sasFromHandshakeHash(h1)).not.toBe(sasFromHandshakeHash(h2))
})

test("v2: session id is 16 bytes, deterministic per transcript", () => {
  const h1 = new Uint8Array(32).fill(7)
  const h2 = new Uint8Array(32).fill(8)
  const id1 = sessionIdFromHandshakeHash(h1)
  expect(id1).toHaveLength(16)
  expect(Buffer.from(id1).equals(Buffer.from(sessionIdFromHandshakeHash(h1)))).toBe(true)
  expect(Buffer.from(id1).equals(Buffer.from(sessionIdFromHandshakeHash(h2)))).toBe(false)
})

test("v2: identity proof is role-bound and rejects self/reflection", () => {
  const hash = new Uint8Array(32).fill(9)
  const alice = generateEphemeralIdentity()
  const bob = generateEphemeralIdentity()

  const proof = signProof(alice, hash, "sender")
  expect(proof.v).toBe(2)
  expect(proof.role).toBe("sender")
  // Correct role verifies.
  expect(verifyProof(proof, hash, undefined, { expectedRole: "sender", ownPeerId: bob.peerId })).toBe(
    alice.peerId,
  )
  // Wrong expected role fails: the signature binds the role.
  expect(() =>
    verifyProof(proof, hash, undefined, { expectedRole: "receiver", ownPeerId: bob.peerId }),
  ).toThrow(/role/)
  // A proof of our OWN identity is rejected (reflection / self-connect).
  expect(() =>
    verifyProof(proof, hash, undefined, { expectedRole: "sender", ownPeerId: alice.peerId }),
  ).toThrow(/own identity/)
  // A proof signed for a different session hash fails.
  const otherHash = new Uint8Array(32).fill(10)
  expect(() =>
    verifyProof(proof, otherHash, undefined, { expectedRole: "sender", ownPeerId: bob.peerId }),
  ).toThrow(/signature/)
  // Tampering with the claimed role invalidates the signature.
  const tampered = { ...proof, role: "receiver" as const }
  expect(() =>
    verifyProof(tampered, hash, undefined, { expectedRole: "receiver", ownPeerId: bob.peerId }),
  ).toThrow()
})

test("v2: identity reuse across sessions is forbidden (P1-13)", async () => {
  const h = await startHarness()
  try {
    const p1 = await writeTestFile(h.senderDir, "a.txt", 10)
    const id = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      return receiveFiles({
        channel: hs.channel,
        handshakeHash: hs.handshakeHash,
        expectedPeerId: id.peerId,
        identity: receiverIdentity,
        destinationDirectory: h.destDir,
        onTransferRequest: async (req) => req.files,
      })
    })()
    await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "a.txt" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: id,
    })
    await receiverDone
    // Second session with the same identity must fail closed.
    await expect(
      sendFiles({
        host: "127.0.0.1",
        port: h.port,
        files: [{ path: p1, name: "a.txt" }],
        expectedPeerId: receiverIdentity.peerId,
        identity: id,
      }),
    ).rejects.toThrow(/reuse/)
  } finally {
    await h.closeListener()
    await rm(h.senderDir, { recursive: true, force: true })
    await rm(h.destDir, { recursive: true, force: true })
  }
}, 30_000)

test("v2: wire body validators fail closed", () => {
  const token = Buffer.from(new Uint8Array(16)).toString("base64")
  expect(() => validateTransferAcceptBody({ acceptedIndices: [0, 2], transferToken: token })).not.toThrow()
  expect(() => validateTransferAcceptBody({ acceptedIndices: [-1], transferToken: token })).toThrow()
  expect(() => validateTransferAcceptBody({ acceptedIndices: [1.5], transferToken: token })).toThrow()
  expect(() => validateTransferAcceptBody({ acceptedIndices: [0] })).toThrow()

  expect(() =>
    validateFileResultBody({ index: 0, ok: true, finalName: "a.txt", bytes: 10, sha256: "a".repeat(64) }),
  ).not.toThrow()
  expect(() => validateFileResultBody({ index: 0, ok: false, errorCode: "E_NOSPC" })).not.toThrow()
  expect(() => validateFileResultBody({ index: 0, ok: false })).toThrow(/errorCode/)
  expect(() => validateFileResultBody({ index: 0, ok: true, finalName: "a.txt", bytes: 10 })).toThrow()

  expect(() => validateSessionResultBody({ ok: true })).not.toThrow()
  expect(() => validateSessionResultBody({ ok: false, error: "boom" })).not.toThrow()
  expect(() => validateSessionResultBody({ ok: "yes" })).toThrow()

  expect(() => validateSignalBody({ code: "local-cancel", reason: "user" }, "cancel")).not.toThrow()
  expect(() => validateSignalBody({ code: "", reason: "x" }, "cancel")).toThrow(/code/)
  expect(() => validateSignalBody({ code: "c" }, "cancel")).toThrow(/reason/)
})

test("v2: identity proof body must be v2 with a valid role", () => {
  const good = {
    v: 2,
    role: "sender",
    peerId: "x",
    identityPublicKey: "y",
    identitySignature: "z",
  }
  expect(() => validateIdentityProofBody(good)).not.toThrow()
  expect(() => validateIdentityProofBody({ ...good, v: 1 })).toThrow(/version/)
  expect(() => validateIdentityProofBody({ ...good, role: "mallory" })).toThrow(/role/)
})
