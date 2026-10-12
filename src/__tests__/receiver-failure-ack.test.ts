import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  generateEphemeralIdentity,
  listenNoise,
  ReceiveAbortedError,
  receiveFiles,
  SendAbortedError,
  sendFiles,
  type ReceiveResult,
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

type ReceiverSettlement =
  | { ok: true; result: ReceiveResult }
  | { ok: false; error: unknown }

async function cleanup(h: Harness): Promise<void> {
  await h.closeListener()
  await rm(h.senderDir, { recursive: true, force: true })
  await rm(h.destDir, { recursive: true, force: true })
}

test("P1-45: missing destination dir → sender does not report success", async () => {
  const h = await startHarness()
  const missingDir = join(tmpdir(), `sw-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    const p1 = await writeTestFile(h.senderDir, "a.txt", 1_000)
    const p2 = await writeTestFile(h.senderDir, "b.txt", 2_000)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()

    const receiverDone: Promise<ReceiverSettlement> = (async () => {
      const hs = await h.nextChannel()
      try {
        const result = await receiveFiles({
          channel: hs.channel,
          handshakeHash: hs.handshakeHash,
          expectedPeerId: senderIdentity.peerId,
          identity: receiverIdentity,
          destinationDirectory: missingDir, // never created
          onTransferRequest: async (req) => req.files,
        })
        return { ok: true as const, result }
      } catch (error) {
        return { ok: false as const, error }
      }
    })()

    // Either the receiver's ERROR frame or the close reaches the sender:
    // both reject. What must NOT happen is a resolved SendResult with ok:true.
    const sendErr = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [
        { path: p1, name: "a.txt" },
        { path: p2, name: "b.txt" },
      ],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(sendErr).not.toBeNull()

    const r = await receiverDone
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(ReceiveAbortedError)
      expect((r.error as ReceiveAbortedError).receivedFiles).toHaveLength(0)
    }
  } finally {
    await rm(missingDir, { recursive: true, force: true })
    await cleanup(h)
  }
}, 30_000)

test("P1-45: read-only destination dir → sender does not report success", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    // chmod-based read-only dirs are still writable for root; the scenario
    // is exercised for real under non-root CI.
    console.log("skip: running as root, read-only dir test is a no-op")
    return
  }
  const h = await startHarness()
  const roDir = await makeTempDir("sw-ro-")
  try {
    await chmod(roDir, 0o555)
    const p1 = await writeTestFile(h.senderDir, "a.txt", 1_000)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()

    const receiverDone: Promise<ReceiverSettlement> = (async () => {
      const hs = await h.nextChannel()
      try {
        const result = await receiveFiles({
          channel: hs.channel,
          handshakeHash: hs.handshakeHash,
          expectedPeerId: senderIdentity.peerId,
          identity: receiverIdentity,
          destinationDirectory: roDir,
          onTransferRequest: async (req) => req.files,
        })
        return { ok: true as const, result }
      } catch (error) {
        return { ok: false as const, error }
      }
    })()

    const sendErr = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "a.txt" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(sendErr).not.toBeNull()

    const r = await receiverDone
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBeInstanceOf(ReceiveAbortedError)
  } finally {
    await chmod(roDir, 0o755).catch(() => {})
    await rm(roDir, { recursive: true, force: true })
    await cleanup(h)
  }
}, 30_000)

test("P1-45: file corrupted between hash and stream → outcome ok:false E_HASH_MISMATCH", async () => {
  const h = await startHarness()
  try {
    const size = 300_000 // multi-chunk
    const p1 = await writeTestFile(h.senderDir, "fragile.bin", size)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    let corrupted = false

    const receiverDone: Promise<ReceiverSettlement> = (async () => {
      const hs = await h.nextChannel()
      try {
        const result = await receiveFiles({
          channel: hs.channel,
          handshakeHash: hs.handshakeHash,
          expectedPeerId: senderIdentity.peerId,
          identity: receiverIdentity,
          destinationDirectory: h.destDir,
          onTransferRequest: async (req) => req.files,
        })
        return { ok: true as const, result }
      } catch (error) {
        return { ok: false as const, error }
      }
    })()

    // The sender hashed the original bytes up front. Corrupt the file in
    // place (same length) before the first chunk is read: the stream then
    // carries bytes that no longer match the advertised SHA-256, and the
    // receiver's integrity check is the backstop.
    const sendResult = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "fragile.bin" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
      onProgress: () => {
        if (!corrupted) {
          corrupted = true
          writeFileSync(p1, Buffer.alloc(size, 0xaa))
        }
      },
    })
    expect(corrupted).toBe(true)

    // The send RESOLVES (session stayed in sync) but the outcome reports
    // the failure — "Sent" is never claimed for a file the receiver
    // could not verify.
    expect(sendResult.outcomes).toHaveLength(1)
    expect(sendResult.outcomes[0]!.ok).toBe(false)
    expect(sendResult.outcomes[0]!.errorCode).toBe("E_HASH_MISMATCH")
    expect(sendResult.outcomes[0]!.finalName).toBeUndefined()

    const r = await receiverDone
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result.files).toHaveLength(0)
    // The failed file left nothing behind in the destination.
    expect(await readdir(h.destDir)).toHaveLength(0)
  } finally {
    await cleanup(h)
  }
}, 30_000)

test("P1-45: receiver closes before FILE_RESULT → sender treats it as failure, not success", async () => {
  const h = await startHarness()
  try {
    const p1 = await writeTestFile(h.senderDir, "cutoff.bin", 200_000)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    let closed = false

    const receiverDone: Promise<ReceiverSettlement> = (async () => {
      const hs = await h.nextChannel()
      try {
        const result = await receiveFiles({
          channel: hs.channel,
          handshakeHash: hs.handshakeHash,
          expectedPeerId: senderIdentity.peerId,
          identity: receiverIdentity,
          destinationDirectory: h.destDir,
          onTransferRequest: async (req) => req.files,
          onProgress: (_i, _name, bytesReceived, fileBytes) => {
            if (!closed && bytesReceived >= fileBytes) {
              // All bytes arrived, but the channel is destroyed before the
              // FILE_RESULT acknowledgement is sent.
              closed = true
              hs.channel.close()
            }
          },
        })
        return { ok: true as const, result }
      } catch (error) {
        return { ok: false as const, error }
      }
    })()

    // A close before the result is a failure (P0-2): the sender must reject
    // instead of reporting "Sent".
    const sendErr = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "cutoff.bin" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(closed).toBe(true)
    expect(sendErr).not.toBeNull()
    expect(sendErr).toBeInstanceOf(SendAbortedError)

    const r = await receiverDone
    expect(r.ok).toBe(false)
  } finally {
    await cleanup(h)
  }
}, 30_000)
