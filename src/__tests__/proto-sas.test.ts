import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { FrameType } from "../services/frame-parser.js"
import {
  generateEphemeralIdentity,
  PeerCancelledError,
  receiveFiles,
  SasRejectedError,
  SendAbortedError,
  sendFiles,
  sessionIdFromHandshakeHash,
  signProof,
} from "../services/transfer-protocol.js"
import {
  RawPeer,
  scriptedReceiverIdentity,
  startProtoHarness,
  writeProtoFile,
} from "./helpers/proto-harness.js"

// P0-1 / D1: the sender confirms the SAS before any file metadata is sent.

test("P0-1/D1: a confirmed SAS lets the transfer proceed; both ends show the same SAS", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "note.txt", 4_000)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    let gateSas = ""
    let gatePeer = ""
    let gateSignalAborted = true
    let receiverSas = ""
    const progress: number[] = []

    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      return receiveFiles({
        channel: hs.channel,
        handshakeHash: hs.handshakeHash,
        identity: receiverIdentity,
        expectedPeerId: senderIdentity.peerId,
        destinationDirectory: h.destDir,
        onTransferRequest: async ({ files, sas }) => {
          receiverSas = sas
          return files
        },
      })
    })()

    const sendResult = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "note.txt" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
      confirmSas: async ({ sas, peerId, signal }) => {
        gateSas = sas
        gatePeer = peerId
        gateSignalAborted = signal.aborted
        return true
      },
      onProgress: (_index, _name, sent, total) => progress.push(sent, total),
    })

    const received = await receiverDone
    expect(sendResult.outcomes.every((o) => o.ok)).toBe(true)
    expect(gateSas).toMatch(/^\d{4}-\d{4}-\d{4}$/)
    expect(gateSas).toBe(receiverSas)
    expect(gateSas).toBe(sendResult.sas)
    expect(gatePeer).toBe(receiverIdentity.peerId)
    expect(gateSignalAborted).toBe(false)
    expect(received.files).toHaveLength(1)
    expect((await readFile(join(h.destDir, "note.txt"))).equals(await readFile(p1))).toBe(true)
    // Progress values are whole numbers that never leave [0, size] (P2-12).
    for (let i = 0; i < progress.length; i += 2) {
      const sent = progress[i]!
      const total = progress[i + 1]!
      expect(Number.isInteger(sent)).toBe(true)
      expect(sent).toBeGreaterThanOrEqual(0)
      expect(sent).toBeLessThanOrEqual(total)
    }
  } finally {
    await h.close()
  }
}, 30_000)

test("P0-1/D1: a rejected SAS sends CANCEL; the receiver never prompts and gets no metadata", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "private.txt", 500)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    let consentAsked = false

    const receiverDone = (async () => {
      const hs = await h.nextChannel()
      return receiveFiles({
        channel: hs.channel,
        handshakeHash: hs.handshakeHash,
        identity: receiverIdentity,
        destinationDirectory: h.destDir,
        onTransferRequest: async ({ files }) => {
          consentAsked = true
          return files
        },
      })
    })().then(
      () => null,
      (error: unknown) => error,
    )

    const sendError = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "private.txt" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
      confirmSas: async () => false,
    }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(sendError).toBeInstanceOf(SasRejectedError)
    const receiverError = await receiverDone
    expect(receiverError).toBeInstanceOf(PeerCancelledError)
    expect((receiverError as PeerCancelledError).code).toBe("sas-rejected")
    expect(consentAsked).toBe(false)
  } finally {
    await h.close()
  }
}, 30_000)

test("P0-1/D1: a peer CANCEL while the SAS gate is open ends the gate with the peer's reason", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "wait.txt", 500)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const hsPromise = h.nextChannel()

    const scripted = (async () => {
      const hs = await hsPromise
      const peer = new RawPeer(hs.channel)
      const sid = await scriptedReceiverIdentity(peer, hs, receiverIdentity)
      await peer.sendJson(FrameType.Cancel, { code: "receiver-left", reason: "user closed the window" }, sid)
    })()

    const sendError = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "wait.txt" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
      // Never answers: only the peer's CANCEL can end the gate.
      confirmSas: () => new Promise<boolean>(() => undefined),
    }).then(
      () => null,
      (error: unknown) => error,
    )
    await scripted
    expect(sendError).toBeInstanceOf(PeerCancelledError)
    expect((sendError as PeerCancelledError).code).toBe("receiver-left")
  } finally {
    await h.close()
  }
}, 30_000)

test("P0-1/D1: a closed channel aborts the SAS gate's signal, and the send fails", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "gone.txt", 500)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const hsPromise = h.nextChannel()

    const scripted = (async () => {
      const hs = await hsPromise
      const peer = new RawPeer(hs.channel)
      await scriptedReceiverIdentity(peer, hs, receiverIdentity)
      // The receiver drops the connection without a word.
      hs.channel.abort()
    })()

    const started = Date.now()
    const sendError = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "gone.txt" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
      confirmSas: ({ signal }) =>
        new Promise<boolean>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
    }).then(
      () => null,
      (error: unknown) => error,
    )
    await scripted
    expect(sendError).toBeInstanceOf(SendAbortedError)
    // The gate ended because the channel closed, not because of a timeout.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect((sendError as Error).message).toMatch(/peer closed/)
  } finally {
    await h.close()
  }
}, 30_000)

test("P0-1: the receiver's proof is verified before the SAS gate runs (no gate on a bad proof)", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "x.txt", 100)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const impostor = generateEphemeralIdentity()
    let gateCalls = 0
    const hsPromise = h.nextChannel()

    // The scripted "receiver" presents a proof signed by the wrong key.
    void (async () => {
      const hs = await hsPromise
      const peer = new RawPeer(hs.channel)
      const sid = sessionIdFromHandshakeHash(hs.handshakeHash)
      await peer.expect(FrameType.SessionOpen)
      const forged = { ...signProof(impostor, hs.handshakeHash, "receiver"), peerId: receiverIdentity.peerId }
      await peer.sendJson(FrameType.IdentityConfirm, forged, sid)
    })()

    const sendError = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "x.txt" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
      confirmSas: async () => {
        gateCalls++
        return true
      },
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(sendError).toBeInstanceOf(SendAbortedError)
    expect(gateCalls).toBe(0)
  } finally {
    await h.close()
  }
}, 30_000)
