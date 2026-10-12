import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { FrameType } from "../services/frame-parser.js"
import {
  generateEphemeralIdentity,
  PeerSignalledError,
  receiveFiles,
  SendAbortedError,
  sendFiles,
} from "../services/transfer-protocol.js"
import {
  RawPeer,
  scriptedAccept,
  scriptedReadRequest,
  scriptedReceiveAll,
  scriptedReceiverIdentity,
  startProtoHarness,
  writeProtoFile,
} from "./helpers/proto-harness.js"

// Acceptance (D2, P0-7), stage deadlines (R2), completion (P0-2) and
// peer-teardown visibility while streaming (R12).

test("D2: two identical files in one request both transfer (accepted by object reference)", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "one.bin", 3_000)
    const p2 = await writeProtoFile(h.senderDir, "two.bin", 3_000)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()

    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      return receiveFiles({
        channel: hs.channel,
        handshakeHash: hs.handshakeHash,
        identity: receiverIdentity,
        destinationDirectory: h.destDir,
        // Return the request's own entries, as the contract says.
        onTransferRequest: async ({ files }) => files,
      })
    })()

    const sent = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [
        { path: p1, name: "same.bin" },
        { path: p2, name: "same.bin" },
      ],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    })
    const received = await receiverDone
    expect(sent.outcomes.map((o) => o.ok)).toEqual([true, true])
    expect(received.files.map((f) => f.name)).toEqual(["same.bin", "same (1).bin"])
    expect((await readdir(h.destDir)).sort()).toEqual(["same (1).bin", "same.bin"])
  } finally {
    await h.close()
  }
}, 30_000)

test("D2: returning one entry by reference transfers exactly that entry", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "first.bin", 1_000)
    const p2 = await writeProtoFile(h.senderDir, "second.bin", 1_000)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()

    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      return receiveFiles({
        channel: hs.channel,
        handshakeHash: hs.handshakeHash,
        identity: receiverIdentity,
        destinationDirectory: h.destDir,
        onTransferRequest: async ({ files }) => [files[1]!],
      })
    })()

    const sent = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [
        { path: p1, name: "same.bin" },
        { path: p2, name: "same.bin" },
      ],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    })
    const received = await receiverDone
    expect(sent.outcomes).toHaveLength(1)
    expect(received.files).toHaveLength(1)
    expect((await readFile(join(h.destDir, "same.bin"))).equals(await readFile(p2))).toBe(true)
  } finally {
    await h.close()
  }
}, 30_000)

test("D2: a copy of one of two identical entries is ambiguous and is refused", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "a.bin", 800)
    const p2 = await writeProtoFile(h.senderDir, "b.bin", 800)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()

    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      return receiveFiles({
        channel: hs.channel,
        handshakeHash: hs.handshakeHash,
        identity: receiverIdentity,
        destinationDirectory: h.destDir,
        onTransferRequest: async ({ files }) => [{ ...files[0]! }],
      })
    })().then(
      () => null,
      (error: unknown) => error,
    )

    const sendError = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [
        { path: p1, name: "same.bin" },
        { path: p2, name: "same.bin" },
      ],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    // The receiver tears the session down; the sender reports the peer's reason.
    expect(sendError).toBeInstanceOf(PeerSignalledError)
    expect((sendError as Error).message).toMatch(/request's own entries/)
    expect((await receiverDone as Error).message).toMatch(/request's own entries/)
    expect(await readdir(h.destDir)).toEqual([])
  } finally {
    await h.close()
  }
}, 30_000)

test("R2: a receiver that holds the prompt for 17 s still completes the transfer", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "slow.bin", 2_000)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const hsPromise = h.nextChannel()

    const receiver = (async () => {
      const hs = await hsPromise
      const peer = new RawPeer(hs.channel)
      const sid = await scriptedReceiverIdentity(peer, hs, receiverIdentity)
      const { files, requestId } = await scriptedReadRequest(peer)
      // The user takes 17 s: well past the old 15 s header budget.
      await new Promise((resolve) => setTimeout(resolve, 17_000))
      await scriptedAccept(peer, sid, requestId, files.map((_, i) => i))
      await scriptedReceiveAll(peer, sid, files.length)
      hs.channel.close()
    })()

    const sent = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "slow.bin" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    })
    await receiver
    expect(sent.outcomes.every((o) => o.ok)).toBe(true)
  } finally {
    await h.close()
  }
}, 60_000)

test("R2: TRANSFER_ACCEPT wait is bounded by acceptTimeoutMs and reports the stage", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "late.bin", 500)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const hsPromise = h.nextChannel()

    const receiver = (async () => {
      const hs = await hsPromise
      const peer = new RawPeer(hs.channel)
      const sid = await scriptedReceiverIdentity(peer, hs, receiverIdentity)
      const { files, requestId } = await scriptedReadRequest(peer)
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      await scriptedAccept(peer, sid, requestId, files.map((_, i) => i)).catch(() => undefined)
      hs.channel.abort()
    })()

    const sendError = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "late.bin" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
      acceptTimeoutMs: 300,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    await receiver
    expect(sendError).toBeInstanceOf(SendAbortedError)
    expect((sendError as Error).message).toMatch(/timed out after 300ms waiting for the receiver's decision/)
  } finally {
    await h.close()
  }
}, 30_000)

test("P0-2/R2: a silent receiver after FILE_END fails the send at resultTimeoutMs, not never", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "quiet.bin", 500)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const hsPromise = h.nextChannel()
    let closeReceiver: (() => void) | undefined

    const receiver = (async () => {
      const hs = await hsPromise
      closeReceiver = () => hs.channel.abort()
      const peer = new RawPeer(hs.channel)
      const sid = await scriptedReceiverIdentity(peer, hs, receiverIdentity)
      const { files, requestId } = await scriptedReadRequest(peer)
      await scriptedAccept(peer, sid, requestId, files.map((_, i) => i))
      // Read every byte, then say nothing.
      for (let i = 0; i < files.length; i++) {
        await peer.expect(FrameType.FileHeader)
        for (;;) {
          const frame = await peer.next()
          if (!frame || frame.type === FrameType.FileEnd) break
        }
      }
    })().catch(() => undefined)

    const sendError = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "quiet.bin" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
      resultTimeoutMs: 300,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    closeReceiver?.()
    await receiver
    expect(sendError).toBeInstanceOf(SendAbortedError)
    expect((sendError as Error).message).toMatch(/timed out after 300ms waiting for the receiver's result/)
  } finally {
    await h.close()
  }
}, 30_000)

test("P0-2: a FILE_RESULT that acknowledges different bytes is a failure, not a success", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "lie.bin", 1_500)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const hsPromise = h.nextChannel()

    const receiver = (async () => {
      const hs = await hsPromise
      const peer = new RawPeer(hs.channel)
      const sid = await scriptedReceiverIdentity(peer, hs, receiverIdentity)
      const { files, requestId } = await scriptedReadRequest(peer)
      await scriptedAccept(peer, sid, requestId, files.map((_, i) => i))
      await scriptedReceiveAll(peer, sid, files.length, () => ({ bytes: 1, sha256: "0".repeat(64) }))
    })().catch(() => undefined)

    const sendError = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "lie.bin" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    await receiver
    expect(sendError).toBeInstanceOf(SendAbortedError)
    expect((sendError as SendAbortedError).outcomes).toHaveLength(0)
    expect((sendError as Error).message).toMatch(/acknowledged different content for lie\.bin/)
  } finally {
    await h.close()
  }
}, 30_000)

test("R12: a receiver ERROR while the sender is streaming ends the send with the receiver's reason", async () => {
  const h = await startProtoHarness()
  try {
    // Large enough that the sender is still streaming when the error lands.
    const p1 = await writeProtoFile(h.senderDir, "big.bin", 8 * 1024 * 1024)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const hsPromise = h.nextChannel()

    const receiver = (async () => {
      const hs = await hsPromise
      const peer = new RawPeer(hs.channel)
      const sid = await scriptedReceiverIdentity(peer, hs, receiverIdentity)
      const { requestId } = await scriptedReadRequest(peer)
      await scriptedAccept(peer, sid, requestId, [0])
      await peer.expect(FrameType.FileHeader)
      await peer.expect(FrameType.FileChunk)
      // The disk fills up after one chunk: say so, then stop reading.
      await peer.sendJson(FrameType.Error, { code: "E_NOSPC", reason: "simulated disk full" }, sid)
      hs.channel.close()
    })().catch(() => undefined)

    const sendError = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "big.bin" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    await receiver
    expect(sendError).toBeInstanceOf(PeerSignalledError)
    expect((sendError as PeerSignalledError).code).toBe("E_NOSPC")
    expect((sendError as Error).message).toMatch(/simulated disk full/)
  } finally {
    await h.close()
  }
}, 30_000)
