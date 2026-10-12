import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
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

    await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [
        { path: p1, name: "hello.txt" },
        { path: p2, name: "blob.bin" },
      ],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    })

    const received = await receiverDone
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

    const received = await receiverDone
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

    const received = await receiverDone
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

test("loopback: receiver decline sends no bytes and fails the sender", async () => {
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
      ).rejects.toThrow()
    })()

    await expect(
      sendFiles({
        host: "127.0.0.1",
        port: h.port,
        files: [{ path: p1, name: "nope.txt" }],
        expectedPeerId: receiverIdentity.peerId,
        identity: senderIdentity,
      }),
    ).rejects.toThrow()
    await receiverDone
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
  expect(verifyPeerId(a.peerId, a.peerId.slice(0, -1) + "x")).toBe(false)
  expect(peerIdFromPublicKey(a.publicKey)).toBe(a.peerId)
  await mkdir(tmpdir(), { recursive: true })
})

import {
  enforceBudgets,
  validateProtocolFiles,
  validateIdentityProofBody,
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
  expect(() => validateIdentityProofBody({})).toThrow(/bad peerId/)
  expect(() =>
    validateIdentityProofBody({ peerId: "x", identityPublicKey: "y" }),
  ).toThrow(/bad identitySignature/)
  expect(() =>
    validateIdentityProofBody({ peerId: "x", identityPublicKey: "y", identitySignature: "z" }),
  ).not.toThrow()
})
