import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  generateEphemeralIdentity,
  listenNoise,
  ReceiveAbortedError,
  receiveFiles,
  SendAbortedError,
  sendFiles,
  TransferDeclinedError,
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

async function cleanup(h: Harness): Promise<void> {
  await h.closeListener()
  await rm(h.senderDir, { recursive: true, force: true })
  await rm(h.destDir, { recursive: true, force: true })
}

test("e2e: send → accept → bytes verified, outcomes ok, SAS matches both ends", async () => {
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
          expect(req.peerId).toBe(senderIdentity.peerId)
          expect(req.sas).toMatch(/^\d{4}-\d{4}-\d{4}$/)
          expect(req.files).toHaveLength(2)
          return req.files
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

    // P0-2: per-file outcomes are all ok, each acknowledged by the receiver.
    expect(sendResult.outcomes).toHaveLength(2)
    for (const o of sendResult.outcomes) {
      expect(o.ok).toBe(true)
      expect(o.errorCode).toBeUndefined()
      expect(o.finalName).toBeDefined()
      expect(o.sha256).toHaveLength(64)
    }
    expect(sendResult.outcomes[0]!.name).toBe("hello.txt")
    expect(sendResult.outcomes[0]!.finalName).toBe("hello.txt")
    expect(sendResult.verifiedPeerId).toBe(receiverIdentity.peerId)
    expect(sendResult.sas).toMatch(/^\d{4}-\d{4}-\d{4}$/)

    // Both ends derive the same SAS from the handshake hash.
    const receiverResult = await receiverDone
    expect(receiverResult.sas).toBe(sendResult.sas)
    expect(receiverResult.verifiedPeerId).toBe(senderIdentity.peerId)
    expect(receiverResult.files).toHaveLength(2)
    for (const [original, got] of [
      [p1, receiverResult.files[0]!],
      [p2, receiverResult.files[1]!],
    ] as const) {
      expect((await readFile(got.path)).equals(await readFile(original))).toBe(true)
      expect(got.bytes).toBe((await readFile(original)).length)
    }
  } finally {
    await cleanup(h)
  }
}, 30_000)

test("e2e: decline → sender gets TransferDeclinedError and the receiver saw the request", async () => {
  const h = await startHarness()
  try {
    const p1 = await writeTestFile(h.senderDir, "nope.txt", 100)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()

    let requestSeen = false
    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      await expect(
        receiveFiles({
          channel: hs.channel,
          handshakeHash: hs.handshakeHash,
          expectedPeerId: senderIdentity.peerId,
          identity: receiverIdentity,
          destinationDirectory: h.destDir,
          onTransferRequest: async () => {
            requestSeen = true
            return [] // decline
          },
        }),
      ).rejects.toBeInstanceOf(TransferDeclinedError)
    })()

    const sendErr = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "nope.txt" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(sendErr).toBeInstanceOf(TransferDeclinedError)
    expect((sendErr as Error).message).toMatch(/declined by receiver/)
    // The receiver made an explicit, informed decision: it saw the request.
    expect(requestSeen).toBe(true)
    await receiverDone
    expect(await readdir(h.destDir)).toHaveLength(0)
  } finally {
    await cleanup(h)
  }
}, 30_000)

test("e2e: sender abort mid-transfer → SendAbortedError; receiver sees peer close", async () => {
  const h = await startHarness()
  try {
    const p1 = await writeTestFile(h.senderDir, "big.bin", 256 * 1024) // 4 chunks
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const senderCtl = new AbortController()
    let aborted = false

    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      // NOTE (transport bug, reported): the sender DOES send a CANCEL frame,
      // but NoiseChannel.receive() drops already-buffered frames once the
      // socket 'close' fires (its `while (!this.isClosed)` guard exits the
      // generator before yielding them). A receiver doing disk I/O is slower
      // than the sender's FIN, so it sees EOF ("peer closed the session")
      // instead of the CANCEL. When that is fixed, this assertion should
      // become `rejects.toBeInstanceOf(PeerCancelledError)`.
      await expect(
        receiveFiles({
          channel: hs.channel,
          handshakeHash: hs.handshakeHash,
          expectedPeerId: senderIdentity.peerId,
          identity: receiverIdentity,
          destinationDirectory: h.destDir,
          onTransferRequest: async (req) => req.files,
        }),
      ).rejects.toBeInstanceOf(ReceiveAbortedError)
    })()

    const sendErr = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "big.bin" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
      signal: senderCtl.signal,
      onProgress: (_i, _name, sentBytes) => {
        // Abort deterministically after the first chunk lands: the transfer
        // is provably mid-flight, never complete.
        if (!aborted && sentBytes > 0) {
          aborted = true
          senderCtl.abort()
        }
      },
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(aborted).toBe(true)
    expect(sendErr).toBeInstanceOf(SendAbortedError)
    expect((sendErr as SendAbortedError).outcomes).toBeInstanceOf(Array)
    await receiverDone
  } finally {
    await cleanup(h)
  }
}, 30_000)

test("e2e: receiver destination missing → sender never reports success", async () => {
  const h = await startHarness()
  const missingDir = join(tmpdir(), `sw-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    const p1 = await writeTestFile(h.senderDir, "doomed.txt", 500)
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
          destinationDirectory: missingDir, // never created
          onTransferRequest: async (req) => req.files,
        }),
      ).rejects.toBeInstanceOf(ReceiveAbortedError)
    })()

    // The sender must not resolve with ok:true outcomes: it either gets the
    // receiver's ERROR frame or sees the close — both are rejections.
    await expect(
      sendFiles({
        host: "127.0.0.1",
        port: h.port,
        files: [{ path: p1, name: "doomed.txt" }],
        expectedPeerId: receiverIdentity.peerId,
        identity: senderIdentity,
      }),
    ).rejects.toThrow()
    await receiverDone
  } finally {
    await rm(missingDir, { recursive: true, force: true })
    await cleanup(h)
  }
}, 30_000)

test("e2e: wrong expectedPeerId → sender throws mismatch; receiver never sees the request", async () => {
  const h = await startHarness()
  try {
    const p1 = await writeTestFile(h.senderDir, "secret.txt", 100)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const wrongIdentity = generateEphemeralIdentity()

    let requestSeen = false
    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      // The sender aborts after the proof check and sends an ERROR frame,
      // so the receiver fails while waiting for the transfer request.
      await expect(
        receiveFiles({
          channel: hs.channel,
          handshakeHash: hs.handshakeHash,
          expectedPeerId: senderIdentity.peerId,
          identity: receiverIdentity,
          destinationDirectory: h.destDir,
          onTransferRequest: async () => {
            requestSeen = true
            return []
          },
        }),
      ).rejects.toThrow()
    })()

    await expect(
      sendFiles({
        host: "127.0.0.1",
        port: h.port,
        files: [{ path: p1, name: "secret.txt" }],
        expectedPeerId: wrongIdentity.peerId, // valid shape, wrong identity
        identity: senderIdentity,
      }),
    ).rejects.toThrow(/does not match/)
    await receiverDone
    // Gate B: no transfer metadata flowed — the receiver never saw a request.
    expect(requestSeen).toBe(false)
    expect(await readdir(h.destDir)).toHaveLength(0)
  } finally {
    await cleanup(h)
  }
}, 30_000)
