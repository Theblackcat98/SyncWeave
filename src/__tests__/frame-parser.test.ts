import { expect, test } from "bun:test"
import {
  ExtensionKey,
  FRAME_MAGIC_0,
  FRAME_MAGIC_1,
  FRAME_VERSION,
  FrameParser,
  FrameType,
  type ByteSource,
  type FrameHeader,
} from "../services/frame-parser.js"

/** Instrumented in-memory source: counts every byte yielded so tests can
 *  distinguish source-yielded bytes from parser-consumed bytes. */
class ScriptedSource implements ByteSource {
  yieldedBytes = 0
  bodyReadCalls = 0
  private readonly chunks: Uint8Array[]
  private offset = 0

  constructor(chunks: Uint8Array[]) {
    this.chunks = chunks
  }

  async read(n: number, _signal?: AbortSignal): Promise<Uint8Array | null> {
    if (this.offset >= this.chunks.length) {
      return null
    }
    const chunk = this.chunks[this.offset]!
    if (chunk.length === 0) {
      this.offset++
      return null
    }
    const take = chunk.subarray(0, n)
    this.yieldedBytes += take.length
    if (take.length === chunk.length) {
      this.offset++
    } else {
      this.chunks[this.offset] = chunk.subarray(n)
    }
    return take
  }
}

function encodeFrame(
  type: number,
  body: Uint8Array,
  extension: Array<[number, Uint8Array]> = [],
  version: number = FRAME_VERSION,
): Uint8Array {
  const extBytes: number[] = [extension.length]
  for (const [key, value] of extension) {
    extBytes.push(key, value.length, ...value)
  }
  const out = new Uint8Array(8 + extBytes.length + body.length)
  out[0] = FRAME_MAGIC_0
  out[1] = FRAME_MAGIC_1
  out[2] = version
  out[3] = type
  const view = new DataView(out.buffer)
  view.setUint32(4, body.length)
  out.set(extBytes, 8)
  out.set(body, 8 + extBytes.length)
  return out
}

function parserFor(bytes: Uint8Array, maxBodyLength = 1_000_000) {
  const source = new ScriptedSource([bytes])
  const parser = new FrameParser(source, { maxBodyLength, headerTimeoutMs: 2_000 })
  return { parser, source }
}

const sessionId = new Uint8Array([1, 2, 3, 4])

test("happy path: session-open then identity-confirm advance the state machine", async () => {
  const bytes = Buffer.concat([
    encodeFrame(FrameType.SessionOpen, new Uint8Array(0), [[ExtensionKey.SessionId, sessionId]]),
    encodeFrame(FrameType.IdentityConfirm, new Uint8Array(0), [[ExtensionKey.SessionId, sessionId]]),
  ])
  const { parser } = parserFor(bytes)
  const first = await parser.readHeader()
  expect(first.kind).toBe("header")
  expect((first as { header: FrameHeader }).header.type).toBe(FrameType.SessionOpen)
  parser.transitionTo("handshake")
  const second = await parser.readHeader()
  expect(second.kind).toBe("header")
  expect(parser.state).toBe("handshake")
})

test("adversarial (a): early transfer-request metadata before confirmation is rejected on the header and its body is never read", async () => {
  // Receiver is still in awaiting-session-open: a metadata frame arrives with
  // a declared body. The parser must reject on the header alone.
  const maliciousBody = new Uint8Array(10_000).fill(0x41)
  const bytes = encodeFrame(FrameType.TransferRequest, maliciousBody, [
    [ExtensionKey.SessionId, sessionId],
  ])
  const { parser, source } = parserFor(bytes)
  const outcome = await parser.readHeader()
  expect(outcome.kind).toBe("rejected")
  expect(parser.state).toBe("closed")
  // Rejected on the fixed prefix alone (wrong state for this frame type):
  // the extension section and body were never requested, allocated, or decoded.
  expect(parser.counters.bodyBytesConsumed).toBe(0)
  expect(parser.counters.headerBytesConsumed).toBe(8)
  // The source still holds the entire 10_000-byte unauthorized body plus the
  // unparsed extension: the parser consumed only the 8-byte prefix.
  expect(source.yieldedBytes).toBe(8)
})

test("adversarial (a2): oversized declared body on an early metadata frame fails closed on the header", async () => {
  const bytes = encodeFrame(FrameType.TransferRequest, new Uint8Array(0), [
    [ExtensionKey.SessionId, sessionId],
  ])
  // Tamper the declared length to 4 GiB without providing the bytes.
  new DataView(bytes.buffer).setUint32(4, 0xffff_ffff)
  const { parser } = parserFor(bytes, 1_000_000)
  const outcome = await parser.readHeader()
  expect(outcome.kind).toBe("rejected")
  expect(parser.state).toBe("closed")
  expect(parser.counters.bodyBytesConsumed).toBe(0)
})

test("adversarial (b): file-body frame after bilateral confirmation but before receiver acceptance is rejected without a body read", async () => {
  const bytes = Buffer.concat([
    encodeFrame(FrameType.SessionOpen, new Uint8Array(0), [[ExtensionKey.SessionId, sessionId]]),
    encodeFrame(FrameType.IdentityConfirm, new Uint8Array(0), [[ExtensionKey.SessionId, sessionId]]),
    encodeFrame(FrameType.TransferRequest, new Uint8Array([9, 9]), [[ExtensionKey.SessionId, sessionId]]),
    encodeFrame(FrameType.FileChunk, new Uint8Array(5_000).fill(0x42), [
      [ExtensionKey.SessionId, sessionId],
      [ExtensionKey.FileId, new Uint8Array([7])],
    ]),
  ])
  const { parser, source } = parserFor(bytes)
  expect((await parser.readHeader()).kind).toBe("header")
  parser.transitionTo("handshake")
  expect((await parser.readHeader()).kind).toBe("header")
  parser.transitionTo("identity-confirmed")
  expect((await parser.readHeader()).kind).toBe("header")
  // Receiver has confirmed identity but has NOT accepted the transfer:
  // request-review allows no file frames.
  parser.transitionTo("request-review")
  const hostile = await parser.readHeader()
  expect(hostile.kind).toBe("rejected")
  expect(parser.state).toBe("closed")
  expect(parser.counters.bodyBytesConsumed).toBe(0)
  // The 5_000 hostile body bytes remain unconsumed in the source: the three
  // allowed headers (15 + 15 + 17) plus the rejected frame's 8-byte prefix
  // (state rejection happens before extension parsing) were ever yielded.
  expect(source.yieldedBytes).toBe(53)
})

test("adversarial (c1): unknown protected key in session-open is rejected before its value is consumed", async () => {
  const secret = new Uint8Array(32).fill(0x99)
  const bytes = encodeFrame(FrameType.SessionOpen, new Uint8Array(0), [
    [ExtensionKey.SessionId, sessionId],
    [0xf0, secret], // unknown protected key
  ])
  const { parser, source } = parserFor(bytes)
  const outcome = await parser.readHeader()
  expect(outcome.kind).toBe("rejected")
  // Rejected on the key byte: the 32-byte value was never consumed.
  expect(source.yieldedBytes).toBe(8 + 1 + 6 + 1)
  expect(parser.counters.bodyBytesConsumed).toBe(0)
})

test("adversarial (c2): transfer-request fields piggybacked in session-open are rejected", async () => {
  const bytes = encodeFrame(FrameType.SessionOpen, new Uint8Array(0), [
    [ExtensionKey.SessionId, sessionId],
    [ExtensionKey.RequestId, new Uint8Array([1])], // not allowed on session-open
  ])
  const { parser } = parserFor(bytes)
  expect((await parser.readHeader()).kind).toBe("rejected")
  expect(parser.state).toBe("closed")
})

test("adversarial (c3): session-open fields piggybacked in identity-confirmation are rejected", async () => {
  const bytes = Buffer.concat([
    encodeFrame(FrameType.SessionOpen, new Uint8Array(0), [[ExtensionKey.SessionId, sessionId]]),
    encodeFrame(FrameType.IdentityConfirm, new Uint8Array(0), [
      [ExtensionKey.SessionId, sessionId],
      [ExtensionKey.RequestId, new Uint8Array([1])], // not allowed on identity-confirm
    ]),
  ])
  const { parser } = parserFor(bytes)
  expect((await parser.readHeader()).kind).toBe("header")
  parser.transitionTo("handshake")
  expect((await parser.readHeader()).kind).toBe("rejected")
  expect(parser.state).toBe("closed")
})

test("byte accounting: header, body, and rejected-body bytes are counted separately", async () => {
  const body = new Uint8Array([1, 2, 3, 4, 5])
  const bytes = Buffer.concat([
    encodeFrame(FrameType.SessionOpen, new Uint8Array(0), [[ExtensionKey.SessionId, sessionId]]),
    encodeFrame(FrameType.IdentityConfirm, new Uint8Array(0), [[ExtensionKey.SessionId, sessionId]]),
    encodeFrame(FrameType.TransferRequest, body, [[ExtensionKey.SessionId, sessionId]]),
  ])
  const { parser, source } = parserFor(bytes)
  await parser.readHeader()
  parser.transitionTo("handshake")
  await parser.readHeader()
  parser.transitionTo("identity-confirmed")
  const outcome = await parser.readHeader()
  expect(outcome.kind).toBe("header")
  const header = (outcome as { header: FrameHeader }).header
  const read = await parser.readBody(header)
  expect(read).toEqual(body)
  // Header bytes: 3 frames x (8 prefix + 1 count + 6 ext) = 45. Body: 5.
  expect(parser.counters.headerBytesConsumed).toBe(45)
  expect(parser.counters.bodyBytesConsumed).toBe(5)
  expect(source.yieldedBytes).toBe(50)
})

test("readBody refuses a body the state forbids even when asked directly", async () => {
  const bytes = encodeFrame(FrameType.FileChunk, new Uint8Array([1, 2, 3]), [
    [ExtensionKey.SessionId, sessionId],
    [ExtensionKey.FileId, new Uint8Array([7])],
  ])
  const { parser } = parserFor(bytes)
  // Forge a header object: the parser must still refuse the body read because
  // the receiver state does not permit file frames.
  const forged: FrameHeader = {
    type: FrameType.FileChunk,
    bodyLength: 3,
    extension: new Map(),
    headerBytes: 8,
  }
  await expect(parser.readBody(forged)).rejects.toThrow()
  expect(parser.counters.bodyBytesConsumed).toBe(0)
})

test("bad magic, unsupported version, and unknown frame type fail closed", async () => {
  const badMagic = encodeFrame(FrameType.SessionOpen, new Uint8Array(0))
  badMagic[0] = 0x00
  expect((await parserFor(badMagic).parser.readHeader()).kind).toBe("rejected")

  const badVersion = encodeFrame(FrameType.SessionOpen, new Uint8Array(0), [], 0x7f)
  expect((await parserFor(badVersion).parser.readHeader()).kind).toBe("rejected")

  const badType = encodeFrame(0xaa, new Uint8Array(0))
  expect((await parserFor(badType).parser.readHeader()).kind).toBe("rejected")
})

test("truncated stream reports eof instead of hanging", async () => {
  const { parser } = parserFor(new Uint8Array(0))
  expect((await parser.readHeader()).kind).toBe("eof")
})

test("header read timeout fails closed without consuming a body", async () => {
  const slow: ByteSource = {
    read: (_n: number, signal?: AbortSignal) =>
      new Promise<Uint8Array | null>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const error = new DOMException("aborted", "AbortError")
          reject(error)
        })
      }),
  }
  const parser = new FrameParser(slow, { maxBodyLength: 1024, headerTimeoutMs: 50 })
  const outcome = await parser.readHeader()
  expect(outcome.kind).toBe("rejected")
  expect(parser.state).toBe("closed")
  expect(parser.counters.bodyBytesConsumed).toBe(0)
})

test("P1-18: readHeader(null) has no parser budget; a per-call number overrides the default", async () => {
  // A source that yields the header only after a delay (longer than the 20 ms default).
  const frame = encodeFrame(FrameType.SessionOpen, new Uint8Array([1]), [[ExtensionKey.SessionId, sessionId]])
  const delayed = (bytes: Uint8Array): ByteSource => {
    const inner = new ScriptedSource([bytes])
    return {
      read: (n: number, signal?: AbortSignal) =>
        new Promise<Uint8Array | null>((resolve, reject) => {
          const timer = setTimeout(() => {
            inner.read(n, signal).then(resolve, reject)
          }, 60)
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer)
              reject(new DOMException("aborted", "AbortError"))
            },
            { once: true },
          )
        }),
    }
  }
  const unbounded = new FrameParser(delayed(frame), { maxBodyLength: 1024, headerTimeoutMs: 20 })
  const outcome = await unbounded.readHeader(undefined, null)
  expect(outcome.kind).toBe("header")

  // With a per-call budget shorter than the delay, the same read fails closed.
  const bounded = new FrameParser(delayed(frame), { maxBodyLength: 1024, headerTimeoutMs: 20 })
  const rejected = await bounded.readHeader(undefined, 10)
  expect(rejected.kind).toBe("rejected")
  expect(bounded.state).toBe("closed")
})

test("extension section bounds are enforced", async () => {
  // Too many entries.
  const many: Array<[number, Uint8Array]> = []
  for (let i = 0; i < 20; i++) {
    many.push([ExtensionKey.SessionId, new Uint8Array([i])])
  }
  expect((await parserFor(encodeFrame(FrameType.SessionOpen, new Uint8Array(0), many)).parser.readHeader()).kind).toBe(
    "rejected",
  )
  // Oversized value.
  const big: Array<[number, Uint8Array]> = [[ExtensionKey.SessionId, new Uint8Array(65)]]
  expect((await parserFor(encodeFrame(FrameType.SessionOpen, new Uint8Array(0), big)).parser.readHeader()).kind).toBe(
    "rejected",
  )
})

test("v2: v1 frames are rejected", async () => {
  const v1 = encodeFrame(FrameType.SessionOpen, new Uint8Array(0), [], 0x01)
  const outcome = await parserFor(v1).parser.readHeader()
  expect(outcome.kind).toBe("rejected")
  if (outcome.kind === "rejected") {
    expect(outcome.reason).toMatch(/version/)
  }
})

test("v2: per-type body caps reject oversized declarations on the header", async () => {
  const mk = (declared: number) => {
    const forged = encodeFrame(FrameType.SessionOpen, new Uint8Array(10))
    new DataView(forged.buffer).setUint32(4, declared)
    const source = new ScriptedSource([forged])
    return new FrameParser(source, {
      maxBodyLength: 1_000_000,
      maxBodyLengthByType: { [FrameType.SessionOpen]: 4096 },
      headerTimeoutMs: 2_000,
    })
  }
  // 5000 > 4096 cap: rejected before any body read.
  const over = await mk(5000).readHeader()
  expect(over.kind).toBe("rejected")
  if (over.kind === "rejected") expect(over.reason).toMatch(/cap/)
  // 4000 <= 4096: header accepted.
  const under = await mk(4000).readHeader()
  expect(under.kind).toBe("header")
})

/** A source that stalls forever, until its abort signal fires (P2-10). */
class StallingSource implements ByteSource {
  async read(_n: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    if (signal?.aborted) throw signal.reason
    await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
    throw new Error("unreachable")
  }
}

test("P2-10: header arrives but body never completes → body timeout fires with the phase-specific message", async () => {
  const parser = new FrameParser(new StallingSource(), {
    maxBodyLength: 64 * 1024,
    bodyTimeoutMs: 300,
  })
  parser.transitionTo("receiving")
  const header: FrameHeader = {
    type: FrameType.FileChunk,
    bodyLength: 100,
    extension: new Map(),
    headerBytes: 8,
  }
  const err = await parser.readBody(header).then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(Error)
  // Phase-specific: names the body phase and the cause, not bare "aborted".
  expect((err as Error).message).toMatch(/frame body timed out after 0\.3s: sender stalled mid-frame/)
})

test("P2-10: a source that yields body bytes before stalling still hits the timeout", async () => {
  // First read yields 10 of 100 bytes, then stalls: the timeout bounds the
  // *whole* body read, not just the first byte.
  let calls = 0
  const dribble: ByteSource = {
    async read(n: number, signal?: AbortSignal): Promise<Uint8Array | null> {
      calls++
      if (calls === 1) return new Uint8Array(10)
      if (signal?.aborted) throw signal.reason
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
      throw new Error("unreachable")
    },
  }
  const parser = new FrameParser(dribble, { maxBodyLength: 64 * 1024, bodyTimeoutMs: 300 })
  parser.transitionTo("receiving")
  const header: FrameHeader = {
    type: FrameType.FileChunk,
    bodyLength: 100,
    extension: new Map(),
    headerBytes: 8,
  }
  await expect(parser.readBody(header)).rejects.toThrow(/frame body timed out/)
})
