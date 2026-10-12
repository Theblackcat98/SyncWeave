import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { FrameType } from "../services/frame-parser.js"
import { dialNoise } from "../services/transport.js"
import {
  ConsentTimeoutError,
  generateEphemeralIdentity,
  PeerCancelledError,
  receiveFiles,
  ReceiveAbortedError,
  sendFiles,
  sessionIdFromHandshakeHash,
  signProof,
  TransferDeclinedError,
  type ProtocolFile,
} from "../services/transfer-protocol.js"
import { RawPeer, startProtoHarness, writeProtoFile } from "./helpers/proto-harness.js"

// D3 / R3 / P1-10b: the consent prompt's signal ends when the sender leaves,
// cancels, or the deadline passes. P1-9: a consent timeout is a DECLINE.

const FILES: ProtocolFile[] = [{ name: "c.bin", bytes: 10, sha256: "a".repeat(64) }]

/** Start a receiver whose prompt stays open and records its consent signal. */
function startStalledReceiver(
  h: Awaited<ReturnType<typeof startProtoHarness>>,
  receiverIdentity: ReturnType<typeof generateEphemeralIdentity>,
  options: { consentTimeoutMs?: number; signal?: AbortSignal } = {},
) {
  let consentSignal: AbortSignal | undefined
  let consentStarted!: () => void
  const started = new Promise<void>((resolve) => (consentStarted = resolve))
  const done = (async () => {
    const hs = await h.nextChannel()
    return receiveFiles({
      channel: hs.channel,
      handshakeHash: hs.handshakeHash,
      identity: receiverIdentity,
      destinationDirectory: h.destDir,
      consentTimeoutMs: options.consentTimeoutMs,
      signal: options.signal,
      onTransferRequest: ({ signal }) => {
        consentSignal = signal
        consentStarted()
        // The user never answers.
        return new Promise<ProtocolFile[]>(() => undefined)
      },
    })
  })().then(
    () => null,
    (error: unknown) => error,
  )
  return {
    done,
    started,
    signal: () => consentSignal,
  }
}

test("D3/R3: the sender's CANCEL during consent aborts the prompt's signal at once", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "c.bin", 2_000)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const receiver = startStalledReceiver(h, receiverIdentity)
    const aborter = new AbortController()

    const senderDone = sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "c.bin" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
      signal: aborter.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    )

    await receiver.started
    const started = Date.now()
    aborter.abort(new Error("sender cancelled"))
    await senderDone
    const receiverError = await receiver.done
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(receiver.signal()?.aborted).toBe(true)
    expect(receiver.signal()?.reason).toBeInstanceOf(PeerCancelledError)
    expect(receiverError).toBeInstanceOf(PeerCancelledError)
    expect(await readdir(h.destDir)).toEqual([])
  } finally {
    await h.close()
  }
}, 30_000)

test("D3/R3: the sender disconnecting during consent aborts the prompt's signal, well before the deadline", async () => {
  const h = await startProtoHarness()
  try {
    const receiverIdentity = generateEphemeralIdentity()
    const senderIdentity = generateEphemeralIdentity()
    const receiver = startStalledReceiver(h, receiverIdentity, { consentTimeoutMs: 60_000 })

    // A raw sender: propose a transfer, then drop the connection with no CANCEL.
    const hs = await dialNoise("127.0.0.1", h.port)
    const peer = new RawPeer(hs.channel)
    const sid = sessionIdFromHandshakeHash(hs.handshakeHash)
    await peer.sendJson(FrameType.SessionOpen, signProof(senderIdentity, hs.handshakeHash, "sender"), sid)
    await peer.expect(FrameType.IdentityConfirm)
    await peer.sendJson(FrameType.TransferRequest, { v: 2, files: FILES }, sid, [
      [0x03, new Uint8Array(16).fill(7)],
    ])

    await receiver.started
    const started = Date.now()
    hs.channel.abort()
    const receiverError = await receiver.done
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(receiver.signal()?.aborted).toBe(true)
    expect(receiverError).toBeInstanceOf(ReceiveAbortedError)
    expect((receiverError as Error).message).toMatch(/peer closed/)
  } finally {
    await h.close()
  }
}, 30_000)

test("D3: a local abort of the receiver ends the prompt and sends CANCEL to the sender", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "l.bin", 2_000)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const localAbort = new AbortController()
    const receiver = startStalledReceiver(h, receiverIdentity, { signal: localAbort.signal })

    const senderDone = sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "l.bin" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    }).then(
      () => null,
      (error: unknown) => error,
    )

    await receiver.started
    localAbort.abort(new Error("receiver closed the window"))
    const receiverError = await receiver.done
    expect(receiver.signal()?.aborted).toBe(true)
    expect(receiverError).toBeInstanceOf(ReceiveAbortedError)
    // The sender learns the reason from the CANCEL that the receiver sent.
    const senderError = await senderDone
    expect(senderError).toBeInstanceOf(PeerCancelledError)
    expect((senderError as PeerCancelledError).code).toBe("local-cancel")
  } finally {
    await h.close()
  }
}, 30_000)

test("P1-9: a consent timeout sends DECLINE with code E_CONSENT_TIMEOUT, not ERROR", async () => {
  const h = await startProtoHarness()
  try {
    const p1 = await writeProtoFile(h.senderDir, "t.bin", 500)
    const senderIdentity = generateEphemeralIdentity()
    const receiverIdentity = generateEphemeralIdentity()
    const receiver = startStalledReceiver(h, receiverIdentity, { consentTimeoutMs: 300 })

    const senderError = await sendFiles({
      host: "127.0.0.1",
      port: h.port,
      files: [{ path: p1, name: "t.bin" }],
      expectedPeerId: receiverIdentity.peerId,
      identity: senderIdentity,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    const receiverError = await receiver.done
    expect(senderError).toBeInstanceOf(TransferDeclinedError)
    expect((senderError as TransferDeclinedError).code).toBe("E_CONSENT_TIMEOUT")
    expect(receiverError).toBeInstanceOf(ConsentTimeoutError)
    expect((receiverError as Error).message).toMatch(/consent timed out after 300ms/)
  } finally {
    await h.close()
  }
}, 30_000)
