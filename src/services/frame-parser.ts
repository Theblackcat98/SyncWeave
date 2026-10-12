/**
 * Application-layer frame parser for the Phase 2 direct-transfer protocol.
 *
 * Implements the phase2.md "Receiver parser: state-first, header-before-body"
 * requirement as transport-agnostic, testable code. This module defines the
 * application framing only; it does not select a transport, perform discovery,
 * authenticate peers, or send bytes. A hostile sender can always transmit
 * bytes on the wire — this parser guarantees that unauthorized frame bodies
 * are never requested, allocated, decoded, admitted to transfer state,
 * staged, persisted, or written by the receiver application.
 *
 * Framing (all integers big-endian):
 *   fixed prefix (8 bytes): magic "SW", version u8, frame type u8, body length u32
 *   extension section: u8 entry count, then entries of (u8 key, u8 value length,
 *     value bytes). The extension is bounded (see options) and parsed as a
 *     stream: an unknown or disallowed key is rejected as soon as it is
 *     recognized, before its value is consumed or decoded.
 *   body: exactly `bodyLength` bytes, read only when the receiver's protocol
 *     state permits that frame type. The parser never buffers a whole frame
 *     before the consent checks.
 *
 * State machine (receiver side):
 *   awaiting-session-open -> handshake -> identity-confirmed -> request-review
 *   -> receiving -> (closed). Any protocol violation closes the session.
 *
 * Byte accounting is reported through `counters`, split into
 * source-yielded bytes (bytes the source handed out — tracked by the caller
 * via an instrumented source) and parser-consumed bytes (header bytes and
 * body bytes the parser actually read, counted separately). Uninstrumented
 * boundaries (socket reads, wire captures) are the caller's to measure and
 * must be labelled "not measured" if they are not.
 */
export const FRAME_MAGIC_0 = 0x53 // "S"
export const FRAME_MAGIC_1 = 0x57 // "W"
export const FRAME_VERSION = 0x01
export const FIXED_PREFIX_BYTES = 8
export const MAX_EXTENSION_ENTRIES = 16
export const MAX_EXTENSION_VALUE_BYTES = 64

export const FrameType = {
  SessionOpen: 0x01,
  IdentityConfirm: 0x02,
  TransferRequest: 0x10,
  TransferAccept: 0x11,
  FileHeader: 0x20,
  FileChunk: 0x21,
  FileEnd: 0x22,
  Cancel: 0x30,
  Error: 0x31,
} as const
export type FrameType = (typeof FrameType)[keyof typeof FrameType]

/** Protected extension keys. Only random, session-scoped values — never
 *  stable peer identities, filenames, or transfer details before confirmation. */
export const ExtensionKey = {
  SessionId: 0x01,
  TranscriptConfirmation: 0x02,
  RequestId: 0x03,
  FileId: 0x04,
  FileIndex: 0x05,
} as const
export type ExtensionKey = (typeof ExtensionKey)[keyof typeof ExtensionKey]

export type ReceiverState =
  | "awaiting-session-open"
  | "handshake"
  | "identity-confirmed"
  | "request-review"
  | "receiving"
  | "awaiting-confirm"
  | "awaiting-accept"
  | "sending"
  | "closed"

export interface ByteSource {
  /** Returns exactly n bytes, or null on end-of-stream. May return fewer only
   *  at end-of-stream; a short read mid-stream is a source error. */
  read(n: number, signal?: AbortSignal): Promise<Uint8Array | null>
}

export interface FrameHeader {
  type: FrameType
  bodyLength: number
  /** Protected extension fields, validated against the per-type allowlist. */
  extension: ReadonlyMap<number, Uint8Array>
  /** Total header bytes consumed (prefix + extension section). */
  headerBytes: number
}

export type HeaderOutcome =
  | { kind: "header"; header: FrameHeader }
  | { kind: "rejected"; reason: string }
  | { kind: "eof" }

export interface FrameParserOptions {
  /** Maximum accepted declared body length (bytes). Larger declarations are
   *  rejected on the header, before any body read. Required, no default. */
  maxBodyLength: number
  /** Maximum accepted extension section bytes (default 512). */
  maxExtensionBytes?: number
  /** Header read timeout in ms (default 15_000). */
  headerTimeoutMs?: number
  /** Body read timeout in ms (default 60_000): a sender that stalls mid-body
   *  must not hang the receiver forever. */
  bodyTimeoutMs?: number
}

export interface ParserCounters {
  /** Header bytes the parser consumed from the source. */
  headerBytesConsumed: number
  /** Body bytes the parser consumed from the source. */
  bodyBytesConsumed: number
  /** Headers rejected (state, type, bounds, or extension violations). */
  headersRejected: number
}

export class FrameRejectedError extends Error {
  constructor(
    message: string,
    readonly protocolState: ReceiverState,
  ) {
    super(message)
    this.name = "FrameRejectedError"
  }
}

/** Frame types the receiver may accept in each protocol state. Everything
 *  else — including file/transfer metadata before bilateral confirmation and
 *  file bodies before the receiver's explicit per-transfer acceptance — is
 *  rejected on the header and the session is closed. */
const allowedTypes: Record<Exclude<ReceiverState, "closed">, ReadonlySet<number>> = {
  "awaiting-session-open": new Set([FrameType.SessionOpen]),
  handshake: new Set([FrameType.IdentityConfirm, FrameType.Cancel, FrameType.Error]),
  "identity-confirmed": new Set([FrameType.TransferRequest, FrameType.Cancel, FrameType.Error]),
  "request-review": new Set([FrameType.Cancel, FrameType.Error]),
  receiving: new Set([
    FrameType.FileHeader,
    FrameType.FileChunk,
    FrameType.FileEnd,
    FrameType.Cancel,
    FrameType.Error,
  ]),
  // Sender-side states: the sender parses the receiver's replies with the
  // same header-first strictness.
  "awaiting-confirm": new Set([FrameType.IdentityConfirm, FrameType.Cancel, FrameType.Error]),
  "awaiting-accept": new Set([FrameType.TransferAccept, FrameType.Cancel, FrameType.Error]),
  sending: new Set([FrameType.Cancel, FrameType.Error]),
}

/** Protected extension keys allowed per frame type. Unknown or disallowed
 *  keys are rejected as soon as the key byte is recognized. */
const allowedExtensionKeys: Record<number, ReadonlySet<number>> = {
  [FrameType.SessionOpen]: new Set([ExtensionKey.SessionId, ExtensionKey.TranscriptConfirmation]),
  [FrameType.IdentityConfirm]: new Set([ExtensionKey.SessionId, ExtensionKey.TranscriptConfirmation]),
  [FrameType.TransferRequest]: new Set([ExtensionKey.SessionId, ExtensionKey.RequestId]),
  [FrameType.TransferAccept]: new Set([ExtensionKey.SessionId, ExtensionKey.RequestId]),
  [FrameType.FileHeader]: new Set([ExtensionKey.SessionId, ExtensionKey.FileId, ExtensionKey.FileIndex]),
  [FrameType.FileChunk]: new Set([ExtensionKey.SessionId, ExtensionKey.FileId]),
  [FrameType.FileEnd]: new Set([ExtensionKey.SessionId, ExtensionKey.FileId]),
  [FrameType.Cancel]: new Set([ExtensionKey.SessionId]),
  [FrameType.Error]: new Set([ExtensionKey.SessionId]),
}

function isFrameType(value: number): value is FrameType {
  return Object.values(FrameType).includes(value as FrameType)
}

export class FrameParser {
  private protocolState: ReceiverState = "awaiting-session-open"
  private readonly maxExtensionBytes: number
  private readonly headerTimeoutMs: number
  readonly counters: ParserCounters = {
    headerBytesConsumed: 0,
    bodyBytesConsumed: 0,
    headersRejected: 0,
  }

  constructor(
    private readonly source: ByteSource,
    private readonly options: FrameParserOptions,
  ) {
    if (!Number.isSafeInteger(options.maxBodyLength) || options.maxBodyLength <= 0) {
      throw new RangeError("maxBodyLength must be a positive safe integer")
    }
    this.maxExtensionBytes = options.maxExtensionBytes ?? 512
    this.headerTimeoutMs = options.headerTimeoutMs ?? 15_000
  }

  get state(): ReceiverState {
    return this.protocolState
  }

  /** Advance the receiver state. Only the session layer calls this, after the
   *  corresponding authorization event (identity confirmation, receiver
   *  acceptance). Forward-only; any violation closes the session. */
  transitionTo(next: ReceiverState): void {
    if (this.protocolState === "closed") {
      throw new FrameRejectedError("Session is closed", this.protocolState)
    }
    const order: ReceiverState[] = [
      "awaiting-session-open",
      "handshake",
      "identity-confirmed",
      "request-review",
      "receiving",
      "awaiting-confirm",
      "awaiting-accept",
      "sending",
      "closed",
    ]
    if (order.indexOf(next) < order.indexOf(this.protocolState)) {
      throw new FrameRejectedError(
        `Invalid backward state transition ${this.protocolState} -> ${next}`,
        this.protocolState,
      )
    }
    this.protocolState = next
  }

  close(reason: string): void {
    this.protocolState = "closed"
    this.closeReason = reason
  }

  private closeReason: string | null = null

  get reason(): string | null {
    return this.closeReason
  }

  /**
   * Read and validate exactly one frame header. Validates magic, version,
   * frame type, declared body length, and the current protocol state before
   * any body byte is requested or allocated. On any violation the header is
   * rejected, the session is closed, and the body is never read.
   */
  async readHeader(signal?: AbortSignal): Promise<HeaderOutcome> {
    if (this.protocolState === "closed") {
      return { kind: "rejected", reason: this.closeReason ?? "session closed" }
    }
    const timeout = AbortSignal.timeout(this.headerTimeoutMs)
    const combined = signal
      ? AbortSignal.any([signal, timeout])
      : timeout
    let prefix: Uint8Array | null
    try {
      prefix = await this.source.read(FIXED_PREFIX_BYTES, combined)
    } catch (error) {
      return this.reject(`header read failed: ${String(error)}`)
    }
    if (prefix === null || prefix.length === 0) {
      return { kind: "eof" }
    }
    if (prefix.length !== FIXED_PREFIX_BYTES) {
      return this.reject("truncated frame prefix")
    }
    this.counters.headerBytesConsumed += FIXED_PREFIX_BYTES

    if (prefix[0] !== FRAME_MAGIC_0 || prefix[1] !== FRAME_MAGIC_1) {
      return this.reject("bad frame magic")
    }
    if (prefix[2] !== FRAME_VERSION) {
      return this.reject(`unsupported frame version ${prefix[2]}`)
    }
    const type = prefix[3]!
    if (!isFrameType(type)) {
      return this.reject(`unknown frame type 0x${type.toString(16)}`)
    }
    const bodyLength =
      prefix[4]! * 0x1000000 + prefix[5]! * 0x10000 + prefix[6]! * 0x100 + prefix[7]!
    if (bodyLength > this.options.maxBodyLength) {
      return this.reject(
        `declared body length ${bodyLength} exceeds maximum ${this.options.maxBodyLength}`,
      )
    }
    if (!allowedTypes[this.protocolState].has(type)) {
      return this.reject(
        `frame type 0x${type.toString(16)} not allowed in state ${this.protocolState}`,
      )
    }

    const extension = await this.readExtensionSection(type, combined)
    if (extension.kind === "rejected") {
      return extension
    }
    return {
      kind: "header",
      header: {
        type,
        bodyLength,
        extension: extension.fields,
        headerBytes: FIXED_PREFIX_BYTES + extension.bytes,
      },
    }
  }

  /**
   * Stream the bounded extension section entry-by-entry. Each key byte is
   * validated against the frame type's allowlist before its value length and
   * value are consumed: an unknown or disallowed key is rejected as soon as
   * it is recognized, without consuming or decoding its value.
   */
  private async readExtensionSection(
    frameType: number,
    signal: AbortSignal,
  ): Promise<
    | { kind: "rejected"; reason: string }
    | { kind: "ok"; fields: Map<number, Uint8Array>; bytes: number }
  > {
    const countBytes = await this.readExact(1, signal)
    if (countBytes === "eof") {
      return { kind: "rejected", reason: "truncated extension count" }
    }
    if (countBytes === "aborted") {
      return { kind: "rejected", reason: "extension read aborted" }
    }
    let bytes = 1
    this.counters.headerBytesConsumed += 1
    const count = countBytes[0]!
    if (count > MAX_EXTENSION_ENTRIES) {
      return this.reject(`extension entry count ${count} exceeds maximum ${MAX_EXTENSION_ENTRIES}`)
    }
    const allowed = allowedExtensionKeys[frameType] ?? new Set<number>()
    const fields = new Map<number, Uint8Array>()
    for (let i = 0; i < count; i++) {
      const keyBytes = await this.readExact(1, signal)
      if (keyBytes === "eof") {
        return this.reject("truncated extension key")
      }
      if (keyBytes === "aborted") {
        return this.reject("extension read aborted")
      }
      bytes += 1
      this.counters.headerBytesConsumed += 1
      const key = keyBytes[0]!
      if (!allowed.has(key)) {
        // Reject on the key byte alone: the value length and value are never
        // consumed or decoded for an unrecognized protected field.
        return this.reject(
          `unknown or disallowed extension key 0x${key.toString(16)} for frame type 0x${frameType.toString(16)}`,
        )
      }
      const lenBytes = await this.readExact(1, signal)
      if (lenBytes === "eof" || lenBytes === "aborted") {
        return this.reject("truncated extension value length")
      }
      bytes += 1
      this.counters.headerBytesConsumed += 1
      const valueLength = lenBytes[0]!
      if (valueLength > MAX_EXTENSION_VALUE_BYTES) {
        return this.reject(`extension value length ${valueLength} exceeds maximum`)
      }
      if (bytes + valueLength > this.maxExtensionBytes) {
        return this.reject("extension section exceeds byte bound")
      }
      const value = await this.readExact(valueLength, signal)
      if (value === "eof" || value === "aborted") {
        return this.reject("truncated extension value")
      }
      bytes += valueLength
      this.counters.headerBytesConsumed += valueLength
      fields.set(key, value)
    }
    return { kind: "ok", fields, bytes }
  }

  private async readExact(
    n: number,
    signal: AbortSignal,
  ): Promise<Uint8Array | "eof" | "aborted"> {
    try {
      const chunk = await this.source.read(n, signal)
      if (chunk === null) {
        return "eof"
      }
      if (chunk.length !== n) {
        return "eof"
      }
      return chunk
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return "aborted"
      }
      throw error
    }
  }

  /**
   * Read exactly `header.bodyLength` body bytes. Throws unless the current
   * protocol state permits body consumption for this header — the parser
   * never reads a body for a frame the state forbids, even if the caller
   * asks. Callers must only invoke this after `readHeader` returned a header
   * and the session layer has verified the applicable consent gate.
   */
  async readBody(header: FrameHeader, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.protocolState === "closed") {
      throw new FrameRejectedError("Session is closed", this.protocolState)
    }
    if (!allowedTypes[this.protocolState].has(header.type)) {
      throw new FrameRejectedError(
        `body read for frame type 0x${header.type.toString(16)} not allowed in state ${this.protocolState}`,
        this.protocolState,
      )
    }
    if (header.bodyLength > this.options.maxBodyLength) {
      throw new FrameRejectedError("declared body length exceeds maximum", this.protocolState)
    }
    const out = new Uint8Array(header.bodyLength)
    let offset = 0
    // Bound the whole body read: a sender dribbling bytes forever must not
    // hang the receiver. (Header reads already have their own timeout.)
    const bodyTimeout = AbortSignal.timeout(this.options.bodyTimeoutMs ?? 60_000)
    const bodySignal = signal ? AbortSignal.any([signal, bodyTimeout]) : bodyTimeout
    while (offset < header.bodyLength) {
      const chunk = await this.source.read(header.bodyLength - offset, bodySignal)
      if (chunk === null || chunk.length === 0) {
        throw new FrameRejectedError("truncated frame body", this.protocolState)
      }
      out.set(chunk.subarray(0, header.bodyLength - offset), offset)
      offset += Math.min(chunk.length, header.bodyLength - offset)
    }
    this.counters.bodyBytesConsumed += header.bodyLength
    return out
  }

  private reject(reason: string): { kind: "rejected"; reason: string } {
    this.counters.headersRejected += 1
    this.close(reason)
    return { kind: "rejected", reason }
  }
}

/**
 * Encode one application frame: fixed 8-byte prefix, bounded extension
 * section, then the body. Keys/values are validated against the same
 * per-type allowlists and bounds the parser enforces, so an encoder-side
 * violation is a programming error, not a wire event.
 */
export function encodeFrame(
  type: FrameType,
  body: Uint8Array,
  extension: ReadonlyMap<number, Uint8Array> = new Map(),
  maxBodyLength = 16 * 1024 * 1024,
): Uint8Array {
  if (!Object.values(FrameType).includes(type as FrameType)) {
    throw new Error(`encodeFrame: unknown frame type 0x${type.toString(16)}`)
  }
  if (body.length > maxBodyLength) {
    throw new Error(`encodeFrame: body length ${body.length} exceeds maximum ${maxBodyLength}`)
  }
  const allowed = allowedExtensionKeys[type] ?? new Set<number>()
  if (extension.size > MAX_EXTENSION_ENTRIES) {
    throw new Error("encodeFrame: too many extension entries")
  }
  const extBytes: number[] = [extension.size]
  for (const [key, value] of extension) {
    if (!allowed.has(key)) {
      throw new Error(`encodeFrame: key 0x${key.toString(16)} not allowed for frame type 0x${type.toString(16)}`)
    }
    if (value.length > MAX_EXTENSION_VALUE_BYTES) {
      throw new Error("encodeFrame: extension value too long")
    }
    extBytes.push(key, value.length, ...value)
  }
  const out = new Uint8Array(8 + extBytes.length + body.length)
  out[0] = FRAME_MAGIC_0
  out[1] = FRAME_MAGIC_1
  out[2] = FRAME_VERSION
  out[3] = type
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(4, body.length)
  out.set(extBytes, 8)
  out.set(body, 8 + extBytes.length)
  return out
}
