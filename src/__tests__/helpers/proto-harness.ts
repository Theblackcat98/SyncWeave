import { createHash, getRandomValues } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeFrame, ExtensionKey, FrameType } from "../../services/frame-parser.js"
import type { EphemeralIdentity } from "../../services/peer-id.js"
import {
  listenNoise,
  sessionIdFromHandshakeHash,
  signProof,
  type ProtocolFile,
} from "../../services/transfer-protocol.js"
import type { HandshakeResult, NoiseChannel } from "../../services/transport.js"

/**
 * Shared helpers for the protocol tests (proto-*.test.ts): a loopback
 * listener, a raw frame decoder, and a scripted peer that speaks the real
 * wire format over a real Noise channel. Tests use these to play the peer
 * that the production code does not implement (a receiver that stalls, lies,
 * or fails mid-file).
 */

export interface ProtoHarness {
  senderDir: string
  destDir: string
  port: number
  /** Resolves with the next handshake the listener completes. */
  nextChannel(): Promise<HandshakeResult>
  close(): Promise<void>
}

export async function startProtoHarness(): Promise<ProtoHarness> {
  const senderDir = await mkdtemp(join(tmpdir(), "proto-send-"))
  const destDir = await mkdtemp(join(tmpdir(), "proto-dest-"))
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  const accepted: HandshakeResult[] = []
  const waiters: Array<(hs: HandshakeResult) => void> = []
  ;(async () => {
    try {
      for await (const hs of listener.accept()) {
        const waiter = waiters.shift()
        if (waiter) waiter(hs)
        else accepted.push(hs)
      }
    } catch {
      /* listener closed */
    }
  })()
  return {
    senderDir,
    destDir,
    port: listener.port,
    nextChannel: () =>
      new Promise<HandshakeResult>((resolve) => {
        const ready = accepted.shift()
        if (ready) resolve(ready)
        else waiters.push(resolve)
      }),
    close: async () => {
      await listener.close()
      await rm(senderDir, { recursive: true, force: true })
      await rm(destDir, { recursive: true, force: true })
    },
  }
}

/** Write a deterministic file of `bytes` bytes into `dir`. */
export async function writeProtoFile(dir: string, name: string, bytes: number): Promise<string> {
  const path = join(dir, name)
  const data = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) data[i] = (i * 31 + 7) & 0xff
  await writeFile(path, data)
  return path
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** A decoded wire frame: prefix type, extension entries, body. */
export interface RawFrame {
  type: number
  ext: Map<number, Uint8Array>
  body: Uint8Array
}

/** Decode one application frame (one Noise message carries exactly one frame). */
export function decodeRawFrame(bytes: Uint8Array): RawFrame {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = bytes[3]!
  const bodyLength = view.getUint32(4)
  const count = bytes[8]!
  const ext = new Map<number, Uint8Array>()
  let offset = 9
  for (let i = 0; i < count; i++) {
    const key = bytes[offset]!
    const length = bytes[offset + 1]!
    ext.set(key, bytes.subarray(offset + 2, offset + 2 + length))
    offset += 2 + length
  }
  return { type, ext, body: bytes.subarray(offset, offset + bodyLength) }
}

export function jsonOf(frame: RawFrame): any {
  return JSON.parse(Buffer.from(frame.body).toString("utf8"))
}

/**
 * A scripted peer on one side of a real channel. It reads and writes whole
 * frames; the production state machine is not involved. Use `next()` to
 * read and `send()` to write.
 */
export class RawPeer {
  private readonly iterator: AsyncIterator<Uint8Array>

  constructor(readonly channel: NoiseChannel) {
    this.iterator = channel.receive()[Symbol.asyncIterator]()
  }

  async next(): Promise<RawFrame | null> {
    const result = await this.iterator.next()
    return result.done ? null : decodeRawFrame(result.value)
  }

  /** Read the next frame and fail the test unless it has the expected type. */
  async expect(type: number): Promise<RawFrame> {
    const frame = await this.next()
    if (frame === null) throw new Error(`peer closed while waiting for frame 0x${type.toString(16)}`)
    if (frame.type !== type) {
      throw new Error(`expected frame 0x${type.toString(16)}, got 0x${frame.type.toString(16)}`)
    }
    return frame
  }

  send(type: number, body: Uint8Array, ext: ReadonlyMap<number, Uint8Array>): Promise<void> {
    return this.channel.send(encodeFrame(type as FrameType, body, ext))
  }

  sendJson(type: number, value: unknown, sessionId: Uint8Array, extra: Array<[number, Uint8Array]> = []): Promise<void> {
    return this.send(
      type,
      Buffer.from(JSON.stringify(value), "utf8"),
      new Map<number, Uint8Array>([[ExtensionKey.SessionId, sessionId], ...extra]),
    )
  }
}

/**
 * Play the receiver's identity half: read SESSION_OPEN and answer with a
 * valid IDENTITY_CONFIRM. Returns the session id both sides derived.
 */
export async function scriptedReceiverIdentity(
  peer: RawPeer,
  hs: HandshakeResult,
  identity: EphemeralIdentity,
): Promise<Uint8Array> {
  const sessionId = sessionIdFromHandshakeHash(hs.handshakeHash)
  await peer.expect(FrameType.SessionOpen)
  await peer.sendJson(FrameType.IdentityConfirm, signProof(identity, hs.handshakeHash, "receiver"), sessionId)
  return sessionId
}

/** Read TRANSFER_REQUEST and return its files and request id. */
export async function scriptedReadRequest(peer: RawPeer): Promise<{ files: ProtocolFile[]; requestId: Uint8Array }> {
  const request = await peer.expect(FrameType.TransferRequest)
  const requestId = request.ext.get(ExtensionKey.RequestId)
  if (!requestId) throw new Error("request without a request id")
  return { files: jsonOf(request).files as ProtocolFile[], requestId }
}

/** Send TRANSFER_ACCEPT for `indices` and return the transfer token. */
export async function scriptedAccept(
  peer: RawPeer,
  sessionId: Uint8Array,
  requestId: Uint8Array,
  indices: number[],
): Promise<Uint8Array> {
  const token = new Uint8Array(16)
  getRandomValues(token)
  await peer.send(
    FrameType.TransferAccept,
    Buffer.from(JSON.stringify({ acceptedIndices: indices, transferToken: Buffer.from(token).toString("base64") }), "utf8"),
    new Map<number, Uint8Array>([
      [ExtensionKey.SessionId, sessionId],
      [ExtensionKey.RequestId, requestId],
    ]),
  )
  return token
}

/**
 * Receive `count` accepted files as a truthful receiver would: collect the
 * bytes, then acknowledge each with its real size and digest, and finish
 * with SESSION_RESULT ok. `ackOverride` lets a test lie in FILE_RESULT.
 */
export async function scriptedReceiveAll(
  peer: RawPeer,
  sessionId: Uint8Array,
  count: number,
  ackOverride?: (index: number, real: { bytes: number; sha256: string }) => { bytes: number; sha256: string },
): Promise<Array<{ name: string; bytes: number; sha256: string }>> {
  const received: Array<{ name: string; bytes: number; sha256: string }> = []
  for (let index = 0; index < count; index++) {
    const header = await peer.expect(FrameType.FileHeader)
    const meta = jsonOf(header) as { name: string }
    const parts: Uint8Array[] = []
    for (;;) {
      const frame = await peer.next()
      if (frame === null) throw new Error("sender closed mid-file")
      if (frame.type === FrameType.FileEnd) break
      if (frame.type !== FrameType.FileChunk) throw new Error(`unexpected frame 0x${frame.type.toString(16)}`)
      parts.push(new Uint8Array(frame.body))
    }
    const data = Buffer.concat(parts)
    const real = { bytes: data.length, sha256: sha256Hex(data) }
    received.push({ name: meta.name, ...real })
    const ack = ackOverride ? ackOverride(index, real) : real
    await peer.sendJson(
      FrameType.FileResult,
      { index, ok: true, finalName: meta.name, bytes: ack.bytes, sha256: ack.sha256 },
      sessionId,
    )
  }
  await peer.sendJson(FrameType.SessionResult, { ok: true, filesReceived: count }, sessionId)
  return received
}
