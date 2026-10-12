import { createHash, createPublicKey, getRandomValues, sign, verify } from "node:crypto"
import { constants as fsConstants, promises as fs, type Stats } from "node:fs"
import { type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import {
  encodeFrame,
  ExtensionKey,
  FrameParser,
  FrameType,
  type FrameHeader,
} from "./frame-parser.js"
import { NoiseChannel, dialNoise, type HandshakeResult } from "./transport.js"
import { generateEphemeralIdentity, peerIdFromPublicKey, verifyPeerId, type EphemeralIdentity } from "./peer-id.js"
import {
  SessionManager,
  type AuthorizedFile,
} from "./session-auth.js"
import { receiveToFile, sanitizePeerBasename } from "./safe-receive-sink.js"

/**
 * Phase 2 direct-transfer protocol, version 2 (see docs/networking.md
 * "Protocol v2" and docs/decisions.md).
 *
 * Wire flow (all application frames travel inside the Noise-encrypted
 * channel; handshake messages are Noise, not application frames):
 *
 *   Sender -> Receiver: SESSION_OPEN      (sender's v2 identity proof)
 *   Receiver -> Sender: IDENTITY_CONFIRM  (receiver's v2 identity proof)
 *   Sender -> Receiver: TRANSFER_REQUEST  (file metadata, after Gate B)
 *   Receiver -> Sender: TRANSFER_ACCEPT   (Gate C: accepted *indices* + transfer token)
 *                      | DECLINE           (explicit decline, P1-9)
 *   Sender -> Receiver: FILE_HEADER, FILE_CHUNK*, FILE_END per file
 *   Receiver -> Sender: FILE_RESULT       (per-file acknowledgement, P0-2)
 *   Receiver -> Sender: SESSION_RESULT    (final session outcome, P0-2)
 *   Either -> Either:   CANCEL | ERROR    (reason-coded teardown, P1-10)
 *
 * Identity binding (P0-1): each side signs a TAGGED, ROLE-BOUND v2 proof
 * message — "syncweave-id-proof-v2" || role || version || handshake hash —
 * with its session-ephemeral Ed25519 identity key. The peer verifies the
 * signature, derives the Peer ID from the key, compares the COMPLETE Peer
 * ID with the out-of-band expected value, and rejects a proof whose Peer
 * ID equals its own (no self-accept / reflection). A short authentication
 * string (SAS) derived from the handshake hash is exposed on both ends so
 * the users can confirm identity out of band; the UI must display it.
 *
 * Gate B (two independent confirmations): the local user's confirmation is
 * their act of providing the expected Peer ID; the remote user's
 * confirmation is their valid IDENTITY_CONFIRM/SESSION_OPEN proof.
 * Gate C (separate receiver acceptance): the receiver's explicit subset
 * choice, sent as TRANSFER_ACCEPT carrying request INDICES (P0-7) and a
 * receiver-issued transfer token echoed on every FILE_HEADER (P1-12).
 * The sender emits no file-body bytes before receiving it.
 *
 * Completion (P0-2): the sender reports success ONLY after receiving a
 * matching FILE_RESULT per file and a final SESSION_RESULT. A close before
 * the result, or a timeout, is a failure.
 *
 * The session id is derived from the Noise transcript hash so both
 * endpoints agree on it (P1-12); every frame's SessionId extension is
 * validated. Frame bodies are capped per type (P0-6) and FILE_CHUNK is
 * sized so the Noise ciphertext never exceeds 65535 bytes.
 *
 * Files stream in ~64 KiB FILE_CHUNK frames; whole files are never
 * buffered. Received files are written via the safe receive sink with
 * automatic rename on collision (`name (1).ext`). SHA-256 is verified
 * before finalization. Sessions are memory-only; restart-from-zero on
 * failure. `destroySession` runs in a finally on both ends (P1-14).
 */

/** Protocol version 2: v1 frames are rejected by the frame parser. */
export const PROTOCOL_VERSION = 2

/**
 * Largest FILE_CHUNK body whose encrypted frame fits in one Noise message:
 * 65535 (Noise limit) - 16 (AEAD tag) - 8 (frame prefix) - 37 (extension:
 * 1 count byte + SessionId 18 + FileId 18). The old 64 KiB chunk produced
 * 65,597-byte ciphertexts, over the Noise limit (P0-6).
 */
const CHUNK_BYTES = 65535 - 16 - 8 - 37
/** Receiver-issued transfer token length (P1-12). */
const TRANSFER_TOKEN_BYTES = 16
/** How long the sender waits for each FILE_RESULT / SESSION_RESULT (P0-2). */
const RESULT_TIMEOUT_MS = 60_000
/** Receiver consent window: how long the prompt may stay open (P0-3). */
const CONSENT_TIMEOUT_MS = 60_000
/**
 * Sender wait for TRANSFER_ACCEPT (R2): the receiver may hold the prompt for
 * the whole consent window, so the wait is that window plus a margin.
 */
const ACCEPT_TIMEOUT_MS = CONSENT_TIMEOUT_MS + 15_000
/** Silent-peer deadline for each identity-proof reply (P0-3). */
const HANDSHAKE_TIMEOUT_MS = 15_000
/**
 * Receiver wait for TRANSFER_REQUEST. The sender confirms the SAS before it
 * sends metadata (P0-1), so this covers a human comparing two screens.
 */
const REQUEST_TIMEOUT_MS = 120_000
/** Per-frame idle budget while a file streams (receiver side). */
const FRAME_IDLE_TIMEOUT_MS = 15_000

/**
 * Per-frame-type body caps (P0-6), enforced by the parser on the header
 * before any body byte is read or allocated: handshake-adjacent frames are
 * small, metadata frames fit 25 files, and no frame approaches the 16 MiB
 * pre-auth allocation the old code allowed.
 */
const BODY_CAPS_V2: Partial<Record<number, number>> = {
  [FrameType.SessionOpen]: 4 * 1024,
  [FrameType.IdentityConfirm]: 4 * 1024,
  [FrameType.TransferRequest]: 64 * 1024,
  [FrameType.TransferAccept]: 64 * 1024,
  [FrameType.Decline]: 1024,
  [FrameType.FileHeader]: 4 * 1024,
  [FrameType.FileChunk]: 64 * 1024,
  [FrameType.FileEnd]: 1024,
  [FrameType.FileResult]: 4 * 1024,
  [FrameType.SessionResult]: 4 * 1024,
  [FrameType.Cancel]: 1024,
  [FrameType.Error]: 2 * 1024,
}

const APP_MAX_NAME_BYTES = 255
/** Resource budgets (Nick's recorded decisions): enforced on BOTH endpoints.
 * The sender checks before transmitting; the receiver re-checks the
 * advertised metadata before authorizing, so a malicious sender cannot
 * make the receiver accept an over-budget session. */
export const BUDGET_MAX_FILES = 25
export const BUDGET_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
export const BUDGET_MAX_SESSION_BYTES = 10 * 1024 * 1024 * 1024

/** Fail closed unless the advertised file set fits every budget. */
export function enforceBudgets(files: readonly ProtocolFile[], what: string): void {
  if (files.length === 0 || files.length > BUDGET_MAX_FILES) {
    throw new Error(`${what}: file count must be 1-${BUDGET_MAX_FILES}`)
  }
  let total = 0
  for (const f of files) {
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0) {
      throw new Error(`${what}: invalid file size for ${f.name}`)
    }
    if (f.bytes > BUDGET_MAX_FILE_BYTES) {
      throw new Error(`${what}: file too large: ${f.name}`)
    }
    total += f.bytes
    if (total > BUDGET_MAX_SESSION_BYTES) {
      throw new Error(`${what}: session total exceeds 10 GiB`)
    }
  }
}

export interface ProtocolFile {
  name: string
  bytes: number
  sha256: string
}

export interface ReceivedFile extends ProtocolFile {
  path: string
}

/** Short authentication string: 3 groups of 4 digits (~40 bits) derived
 *  from the Noise handshake hash. Both endpoints compute the same value;
 *  the UI must show it on the send-review and consent screens so the two
 *  humans can confirm they are talking to each other (P0-1). */
export function sasFromHandshakeHash(handshakeHash: Uint8Array): string {
  const digest = createHash("sha256")
    .update("syncweave-sas-v2", "utf8")
    .update(handshakeHash)
    .digest()
  const group = (i: number): string =>
    (((digest[i]! << 8) | digest[i + 1]!) % 10000).toString().padStart(4, "0")
  return `${group(0)}-${group(2)}-${group(4)}`
}

/** Session id both endpoints agree on without a round trip (P1-12). */
export function sessionIdFromHandshakeHash(handshakeHash: Uint8Array): Uint8Array {
  return createHash("sha256")
    .update("syncweave-session-id-v2", "utf8")
    .update(handshakeHash)
    .digest()
    .subarray(0, 16)
}

export type ProofRole = "sender" | "receiver"

interface IdentityProofBody {
  v: 2
  role: ProofRole
  peerId: string
  identityPublicKey: string // base64
  /** base64 Ed25519 signature over the TAGGED v2 proof message (below). */
  identitySignature: string
}

const ID_PROOF_DOMAIN_V2 = "syncweave-id-proof-v2"

/**
 * The v2 proof message (P0-1): domain tag || role || version byte ||
 * handshake hash. The tag and role prevent cross-protocol and
 * cross-role proof replay; the version binds the proof to protocol v2.
 */
function proofMessageV2(role: ProofRole, handshakeHash: Uint8Array): Uint8Array {
  return Buffer.concat([
    Buffer.from(ID_PROOF_DOMAIN_V2, "utf8"),
    Buffer.from(role, "utf8"),
    Buffer.from([PROTOCOL_VERSION]),
    Buffer.from(handshakeHash),
  ])
}

/** Exported for tests: build a v2 identity proof. */
export function signProof(
  identity: EphemeralIdentity,
  handshakeHash: Uint8Array,
  role: ProofRole,
): IdentityProofBody {
  const signature = sign(null, proofMessageV2(role, handshakeHash), identity.privateKey)
  return {
    v: 2,
    role,
    peerId: identity.peerId,
    identityPublicKey: Buffer.from(identity.publicKey).toString("base64"),
    identitySignature: signature.toString("base64"),
  }
}

/**
 * Verify an identity proof (P0-1): the body must claim v2 and the expected
 * role, the signature must bind the tagged message to this exact session,
 * the Peer ID must be re-derived from the proved key, must match the
 * out-of-band expected value when one was provided, and must NOT be our
 * own identity (self-connection / reflection rejected). Returns the
 * verified Peer ID string for session binding. Throws on any failure
 * (fail closed). Exported for tests.
 */
export function verifyProof(
  proof: IdentityProofBody,
  handshakeHash: Uint8Array,
  expectedPeerId: string | undefined,
  opts: { expectedRole: ProofRole; ownPeerId: string },
): string {
  if (proof.v !== 2) {
    throw new Error("identity proof: unsupported proof version")
  }
  if (proof.role !== opts.expectedRole) {
    throw new Error(`identity proof: unexpected role ${proof.role}`)
  }
  let publicKey: Uint8Array
  try {
    publicKey = new Uint8Array(Buffer.from(proof.identityPublicKey, "base64"))
  } catch {
    throw new Error("identity proof: malformed public key")
  }
  if (publicKey.length !== 32) {
    throw new Error("identity proof: public key must be 32 bytes")
  }
  const keyObject = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") },
    format: "jwk",
  })
  let signature: Buffer
  try {
    signature = Buffer.from(proof.identitySignature, "base64")
  } catch {
    throw new Error("identity proof: malformed signature")
  }
  // Verify against the EXPECTED role, not the claimed one: flipping the
  // role string in the body invalidates the signature.
  const valid = verify(null, proofMessageV2(opts.expectedRole, handshakeHash), keyObject, signature)
  if (!valid) {
    throw new Error("identity proof: signature does not bind to this session")
  }
  const derived = peerIdFromPublicKey(publicKey)
  if (verifyPeerId(derived, opts.ownPeerId)) {
    throw new Error("identity proof: peer presented our own identity (self-connection or reflection)")
  }
  // Re-derive the Peer ID from the verified key. If an out-of-band expected
  // value was provided, compare the complete string exactly; otherwise the
  // caller is responsible for presenting the verified ID to the user
  // (trust-on-first-use via an explicit accept action).
  if (expectedPeerId !== undefined) {
    if (!verifyPeerId(expectedPeerId, derived) || !verifyPeerId(expectedPeerId, proof.peerId)) {
      throw new Error("identity proof: Peer ID does not match the expected out-of-band identity")
    }
  } else if (!verifyPeerId(proof.peerId, derived)) {
    throw new Error("identity proof: Peer ID does not match the proved key")
  }
  return derived
}

/**
 * Per-session identity discipline (P1-13): an ephemeral identity must
 * never be reused across sessions. The transfer protocol generates a fresh
 * identity per send/receive call; callers that inject one (tests) must
 * also use it only once. A reused identity fails closed here.
 */
const claimedIdentities = new Set<string>()
/** Bound on remembered claims (N8). Identities are random per session, so an
 *  evicted claim cannot be presented again by accident. */
const CLAIMED_IDENTITY_LIMIT = 1024
function claimIdentity(identity: EphemeralIdentity): void {
  if (claimedIdentities.has(identity.peerId)) {
    throw new Error(
      "identity reuse across sessions is forbidden: generate a fresh ephemeral identity per session",
    )
  }
  claimedIdentities.add(identity.peerId)
  if (claimedIdentities.size > CLAIMED_IDENTITY_LIMIT) {
    const oldest = claimedIdentities.values().next().value
    if (oldest !== undefined) claimedIdentities.delete(oldest)
  }
}

function parseJsonBody(body: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"))
  } catch {
    throw new Error(`malformed ${what} body`)
  }
}

/**
 * Shape validation for incoming JSON protocol bodies. JSON.parse returns
 * `unknown`; every field the protocol acts on is checked here so a
 * malformed or hostile body fails closed instead of flowing into
 * authorization, file I/O, or crypto as a blind `as` cast.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function validateProtocolFiles(files: unknown, what: string): asserts files is ProtocolFile[] {
  if (!Array.isArray(files)) {
    throw new Error(`malformed ${what}: files is not an array`)
  }
  for (const f of files) {
    if (!isRecord(f)) {
      throw new Error(`malformed ${what}: file entry is not an object`)
    }
    if (typeof f.name !== "string" || f.name.length === 0 || Buffer.byteLength(f.name, "utf8") > APP_MAX_NAME_BYTES) {
      throw new Error(`malformed ${what}: bad file name`)
    }
    // Reject control characters and bidi/zero-width format characters in
    // advertised names: they misrender on the consent screen ("line1\nline2"
    // displays as "line1"; U+202E flips the visible name).
    if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u2029\u202a-\u202e\u2066-\u2069\ufeff]/.test(f.name)) {
      throw new Error(`malformed ${what}: file name contains control or format characters`)
    }
    if (typeof f.bytes !== "number" || !Number.isSafeInteger(f.bytes) || f.bytes < 0) {
      throw new Error(`malformed ${what}: bad file size for ${f.name}`)
    }
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) {
      throw new Error(`malformed ${what}: bad sha256 for ${f.name}`)
    }
  }
}

export function validateIdentityProofBody(body: unknown): asserts body is IdentityProofBody {
  if (!isRecord(body)) {
    throw new Error("malformed identity proof: not an object")
  }
  if (body.v !== 2) {
    throw new Error("malformed identity proof: bad version")
  }
  if (body.role !== "sender" && body.role !== "receiver") {
    throw new Error("malformed identity proof: bad role")
  }
  for (const k of ["peerId", "identityPublicKey", "identitySignature"] as const) {
    if (typeof body[k] !== "string" || (body[k] as string).length === 0) {
      throw new Error(`malformed identity proof: bad ${k}`)
    }
  }
}

export function validateSha256Body(body: unknown): asserts body is { sha256: string } {
  if (!isRecord(body) || typeof body.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.sha256)) {
    throw new Error("malformed file-end: bad sha256")
  }
}

/** v2 TRANSFER_ACCEPT body: accepted REQUEST INDICES (P0-7) + transfer token. */
export interface TransferAcceptBody {
  acceptedIndices: number[]
  /** base64 receiver-issued transfer token, echoed on every FILE_HEADER. */
  transferToken: string
}

export function validateTransferAcceptBody(body: unknown): asserts body is TransferAcceptBody {
  if (!isRecord(body)) {
    throw new Error("malformed transfer acceptance: not an object")
  }
  if (!Array.isArray(body.acceptedIndices)) {
    throw new Error("malformed transfer acceptance: acceptedIndices is not an array")
  }
  for (const i of body.acceptedIndices) {
    if (typeof i !== "number" || !Number.isSafeInteger(i) || i < 0) {
      throw new Error("malformed transfer acceptance: bad index")
    }
  }
  if (
    typeof body.transferToken !== "string" ||
    body.transferToken.length === 0 ||
    body.transferToken.length > 64
  ) {
    throw new Error("malformed transfer acceptance: bad transferToken")
  }
}

export interface FileResultBody {
  index: number
  ok: boolean
  /** Receiver-reported final name (after autorename); present when ok. */
  finalName?: string
  bytes?: number
  sha256?: string
  /** Machine-readable failure code; present when !ok. */
  errorCode?: string
}

export function validateFileResultBody(body: unknown): asserts body is FileResultBody {
  if (!isRecord(body)) {
    throw new Error("malformed file result: not an object")
  }
  if (typeof body.index !== "number" || !Number.isSafeInteger(body.index) || body.index < 0) {
    throw new Error("malformed file result: bad index")
  }
  if (typeof body.ok !== "boolean") {
    throw new Error("malformed file result: bad ok")
  }
  if (body.ok) {
    if (typeof body.finalName !== "string" || body.finalName.length === 0 || body.finalName.length > APP_MAX_NAME_BYTES) {
      throw new Error("malformed file result: bad finalName")
    }
    if (typeof body.bytes !== "number" || !Number.isSafeInteger(body.bytes) || body.bytes < 0) {
      throw new Error("malformed file result: bad bytes")
    }
    if (typeof body.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.sha256)) {
      throw new Error("malformed file result: bad sha256")
    }
  } else if (typeof body.errorCode !== "string" || body.errorCode.length === 0 || body.errorCode.length > 64) {
    throw new Error("malformed file result: bad errorCode")
  }
}

export function validateSessionResultBody(body: unknown): asserts body is { ok: boolean; error?: string } {
  if (!isRecord(body) || typeof body.ok !== "boolean") {
    throw new Error("malformed session result: not an object")
  }
  if (body.error !== undefined && (typeof body.error !== "string" || body.error.length > 512)) {
    throw new Error("malformed session result: bad error")
  }
}

/** Reason-coded CANCEL / ERROR / DECLINE bodies (P1-10, P1-9). */
export function validateSignalBody(body: unknown, what: string): asserts body is { code: string; reason: string } {
  if (!isRecord(body)) {
    throw new Error(`malformed ${what}: not an object`)
  }
  if (typeof body.code !== "string" || body.code.length === 0 || body.code.length > 64) {
    throw new Error(`malformed ${what}: bad code`)
  }
  if (typeof body.reason !== "string" || body.reason.length > 512) {
    throw new Error(`malformed ${what}: bad reason`)
  }
}

/** The receiver explicitly declined (P1-9). `code` is the DECLINE code, e.g. E_CONSENT_TIMEOUT. */
export class TransferDeclinedError extends Error {
  constructor(
    message = "transfer declined",
    readonly code?: string,
  ) {
    super(message)
    this.name = "TransferDeclinedError"
  }
}

/** The receiver's consent window ended without an answer (P1-9). Sent to the
 *  sender as DECLINE with code E_CONSENT_TIMEOUT, not as ERROR. */
export class ConsentTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`consent timed out after ${timeoutMs}ms: no answer on this device`)
    this.name = "ConsentTimeoutError"
  }
}

/** The sender did not confirm the SAS (P0-1). A CANCEL was sent before any
 *  file metadata, so the receiver never shows a consent prompt. */
export class SasRejectedError extends Error {
  constructor(readonly sas: string) {
    super(`SAS ${sas} was not confirmed: transfer cancelled before any file metadata was sent`)
    this.name = "SasRejectedError"
  }
}

/** The peer sent CANCEL (P1-10). */
export class PeerCancelledError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
  ) {
    super(`cancelled by peer (${code}): ${reason}`)
    this.name = "PeerCancelledError"
  }
}

/** The peer sent ERROR (P1-10). */
export class PeerSignalledError extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
  ) {
    super(`peer error (${code}): ${reason}`)
    this.name = "PeerSignalledError"
  }
}

/**
 * A send failed partway (P1-11): `outcomes` carries every file that
 * completed (ok or receiver-reported failure) before the failure, so a
 * multi-file failure never discards completed files.
 */
export class SendAbortedError extends Error {
  constructor(
    message: string,
    readonly outcomes: SendFileOutcome[],
  ) {
    super(message)
    this.name = "SendAbortedError"
  }
}

/** A receive failed partway (P1-11): files already saved to disk. */
export class ReceiveAbortedError extends Error {
  constructor(
    message: string,
    readonly receivedFiles: ReceivedFile[],
  ) {
    super(message)
    this.name = "ReceiveAbortedError"
  }
}

/**
 * Read one frame and enforce the v2 wire bindings: the SessionId extension
 * must equal our transcript-derived session id on EVERY frame (P1-12), and
 * peer-initiated teardown frames are translated into typed errors (P1-9,
 * P1-10) instead of "unexpected frame" failures. `headerTimeoutMs` overrides
 * the parser's per-header budget; `null` leaves the deadline to the caller.
 */
async function readFrame(
  parser: FrameParser,
  sessionId: Uint8Array,
  signal?: AbortSignal,
  headerTimeoutMs?: number | null,
): Promise<{ header: FrameHeader; body: Uint8Array }> {
  const outcome = await parser.readHeader(signal, headerTimeoutMs)
  if (outcome.kind === "eof") {
    throw new Error("peer closed the session")
  }
  if (outcome.kind === "rejected") {
    throw new Error(`frame rejected: ${outcome.reason}`)
  }
  const { header } = outcome
  const extSessionId = header.extension.get(ExtensionKey.SessionId)
  if (!extSessionId || !equalBytes(extSessionId, sessionId)) {
    throw new Error("frame session id mismatch: not our session")
  }
  const body = await parser.readBody(header, signal)
  if (header.type === FrameType.Cancel) {
    const raw: unknown = parseJsonBody(body, "cancel")
    validateSignalBody(raw, "cancel")
    throw new PeerCancelledError(raw.code, raw.reason)
  }
  if (header.type === FrameType.Error) {
    const raw: unknown = parseJsonBody(body, "error")
    validateSignalBody(raw, "error")
    throw new PeerSignalledError(raw.code, raw.reason)
  }
  if (header.type === FrameType.Decline) {
    const raw: unknown = parseJsonBody(body, "decline")
    validateSignalBody(raw, "decline")
    throw new TransferDeclinedError(
      `transfer declined by receiver${raw.reason ? `: ${raw.reason}` : ""}`,
      raw.code,
    )
  }
  return { header, body }
}

/**
 * The single reader of one session's frames after the handshake (P1-10, R12,
 * D3). At most one read is outstanding. Waits race a deadline and an abort
 * against that read, but never cancel it, so a timed-out wait cannot consume
 * and drop a frame. `watch()` lets a sender that is busy writing, or a
 * receiver whose prompt is open, fail at once on the peer's CANCEL/ERROR or a
 * closed channel.
 */
interface InboundFrame {
  header: FrameHeader
  body: Uint8Array
}

class FrameInbox {
  private pending: Promise<InboundFrame> | null = null

  constructor(
    private readonly parser: FrameParser,
    private readonly sessionId: Uint8Array,
    private readonly signal?: AbortSignal,
  ) {}

  /** The outstanding read, started if none is in flight. Its failure is
   *  handled here, so an unobserved read error is never unhandled. */
  private arm(): Promise<InboundFrame> {
    if (this.pending === null) {
      const read = readFrame(this.parser, this.sessionId, this.signal, null)
      read.catch(() => undefined)
      this.pending = read
    }
    return this.pending
  }

  /** Next frame, or a rejection on timeout, abort, or a failed read. */
  async next(timeoutMs: number | null, what: string, signal?: AbortSignal): Promise<InboundFrame> {
    const frame = await withDeadline(this.arm(), timeoutMs, what, signal)
    this.pending = null
    return frame
  }

  /** Never resolves. Rejects as soon as the peer sends anything (a CANCEL or
   *  ERROR is rethrown as its typed error) or the channel fails. */
  watch(): Promise<never> {
    const unexpected = this.arm().then((frame) => {
      throw new Error(`unexpected frame 0x${frame.header.type.toString(16)} from peer`)
    })
    unexpected.catch(() => undefined)
    return unexpected
  }
}

/**
 * Race `promise` against an optional deadline and an optional abort. Neither
 * settles the underlying promise: a late result stays with its owner.
 */
function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number | null,
  what: string,
  signal?: AbortSignal,
): Promise<T> {
  if (timeoutMs === null && signal === undefined) return promise
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    const onAbort = (): void => {
      if (settled) return
      finish()
      reject(signal?.reason ?? new Error("aborted"))
    }
    promise.then(
      (value) => {
        if (settled) return
        finish()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        finish()
        reject(error)
      },
    )
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        if (settled) return
        finish()
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${what}`))
      }, timeoutMs)
    }
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}

/** Await a write while the peer's teardown is watched (R12): the first to settle decides. */
function guardWrite(write: Promise<void>, peerGone: Promise<never>, signal?: AbortSignal): Promise<void> {
  return withDeadline(Promise.race([write, peerGone]), null, "the write", signal)
}

/** Progress values shown to the user are whole numbers within [0, total] (P2-12). */
function clampProgress(value: number, total: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(Math.floor(value), 0), total)
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/** Longest prefix of `value` whose UTF-8 encoding is at most `maxBytes`. */
function truncateToBytes(value: string, maxBytes: number): string {
  let used = 0
  let out = ""
  for (const character of value) {
    const bytes = utf8Length(character)
    if (used + bytes > maxBytes) break
    out += character
    used += bytes
  }
  return out
}

/** A candidate name is free only when lstat reports ENOENT. A dangling
 *  symlink is found by lstat and is therefore taken (P1-20). */
async function isFreeName(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
  }
}

/**
 * Resolve a collision-free destination leaf name: `name.ext`, then
 * `name (1).ext`, `name (2).ext`, ... (P1-20).
 *  - The stem is cut to a byte budget so the whole candidate fits the
 *    255-byte limit; the " (n).ext" suffix is never cut.
 *  - Existence is checked with lstat: any entry, including a dangling
 *    symlink, is taken, and only ENOENT means the name is free.
 */
export async function resolveDestination(directory: string, peerFileName: string): Promise<string> {
  const safe = sanitizePeerBasename(peerFileName, APP_MAX_NAME_BYTES)
  if (await isFreeName(join(directory, safe))) return safe
  const dot = safe.lastIndexOf(".")
  const ext = dot > 0 && utf8Length(safe.slice(dot)) <= 32 ? safe.slice(dot) : ""
  const stem = ext ? safe.slice(0, dot) : safe
  for (let i = 1; i <= 9999; i++) {
    const suffix = ` (${i})${ext}`
    const candidate = truncateToBytes(stem, APP_MAX_NAME_BYTES - utf8Length(suffix)) + suffix
    if (await isFreeName(join(directory, candidate))) return candidate
  }
  throw new Error("too many name collisions")
}

/**
 * Hash a file through an already-open handle (P0-2): the fstat size
 * snapshot and the hash see the same open file description, so a
 * replace-between-open (open TOCTOU) cannot make the hash and the later
 * stream disagree about which file they read. Modification *between* the
 * hash pass and the stream pass is caught by the receiver's SHA-256
 * verification, which is the integrity backstop. The signal is checked per
 * 128 KiB read, so a cancel during hashing is honoured (R7).
 */
async function hashFileHandle(handle: FileHandle, size: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256")
  const buf = Buffer.alloc(128 * 1024)
  let offset = 0
  while (offset < size) {
    signal?.throwIfAborted()
    const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - offset), offset)
    if (bytesRead === 0) {
      throw new Error("file changed while reading")
    }
    hash.update(buf.subarray(0, bytesRead))
    offset += bytesRead
  }
  return hash.digest("hex")
}

interface FileSnapshot {
  handle: FileHandle
  path: string
  name: string
  bytes: number
  sha256: string
}

function nonRegularReason(st: Stats): string {
  if (st.isDirectory()) return "it is a directory"
  if (st.isFIFO()) return "it is a named pipe"
  if (st.isSocket()) return "it is a socket"
  if (st.isCharacterDevice() || st.isBlockDevice()) return "it is a device"
  return "it is not a regular file"
}

/**
 * Stat every source before any byte is hashed (P0-11): the count, each
 * file's type and size, and the session total are checked first, so a FIFO,
 * a directory or an oversize file is refused without being read.
 */
async function checkSendSources(
  sources: ReadonlyArray<{ path: string; name: string }>,
  signal?: AbortSignal,
): Promise<void> {
  if (sources.length === 0 || sources.length > BUDGET_MAX_FILES) {
    throw new Error(`file count must be 1-${BUDGET_MAX_FILES}`)
  }
  let total = 0
  for (const source of sources) {
    signal?.throwIfAborted()
    const st = await fs.stat(source.path)
    if (!st.isFile()) {
      throw new Error(`cannot send ${source.name}: ${nonRegularReason(st)}`)
    }
    if (st.size > BUDGET_MAX_FILE_BYTES) {
      throw new Error(`send: file too large: ${source.name}`)
    }
    total += st.size
    if (total > BUDGET_MAX_SESSION_BYTES) {
      throw new Error("send: session total exceeds 10 GiB")
    }
  }
}

/**
 * Open once, fstat, hash through the same fd. O_NONBLOCK means a FIFO that
 * replaced the file after the stat cannot block the open (P0-11); fstat then
 * refuses anything that is not a regular file.
 */
async function snapshotFile(
  source: { path: string; name: string },
  index: number,
  count: number,
  signal?: AbortSignal,
  onHashProgress?: (fileIndex: number, fileCount: number, fileName: string) => void,
): Promise<FileSnapshot> {
  const handle = await fs.open(source.path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK)
  try {
    const st = await handle.stat()
    if (!st.isFile()) {
      throw new Error(`cannot send ${source.name}: ${nonRegularReason(st)}`)
    }
    if (st.size > BUDGET_MAX_FILE_BYTES) {
      throw new Error(`send: file too large: ${source.name}`)
    }
    onHashProgress?.(index, count, source.name)
    const sha256 = await hashFileHandle(handle, st.size, signal)
    return { handle, path: source.path, name: source.name, bytes: st.size, sha256 }
  } catch (error) {
    await handle.close()
    throw error
  }
}

function extSessionId(sessionId: Uint8Array): Map<number, Uint8Array> {
  return new Map([[ExtensionKey.SessionId, sessionId]])
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8")
}

/** Map a receive-side failure to a wire error code (P0-2). */
function receiveErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (code === "ENOSPC") return "E_NOSPC"
  // The name was taken between resolveDestination and the sink's link (P1-20).
  if (code === "EEXIST") return "E_EXISTS"
  const message = error instanceof Error ? error.message : String(error)
  if (/sha-256|digest/i.test(message)) return "E_HASH_MISMATCH"
  if (/exceed|too large|limit/i.test(message)) return "E_LIMIT"
  if (/integrity/i.test(message)) return "E_INTEGRITY"
  if (/cancel|abort/i.test(message)) return "E_CANCELLED"
  return "E_RECEIVE_FAILED"
}

export interface SendOptions {
  host: string
  port: number
  /** Local files to send. `sha256`/`bytes` are verified by reading the file. */
  files: Array<{ path: string; name: string }>
  /**
   * The receiver's complete Peer ID, verified out of band by the user.
   * If omitted, the verified Peer ID from the session proof is used
   * (trust-on-first-use; the UI must display it AND the SAS). If provided,
   * it must match exactly.
   */
  expectedPeerId?: string
  /**
   * Inject a pre-generated identity (tests). Generated fresh if omitted.
   * P1-13: an identity must never be reused across sessions — passing an
   * identity that already completed a session throws.
   */
  identity?: EphemeralIdentity
  signal?: AbortSignal
  /**
   * Sender-side SAS gate (P0-1 / D1). Called after the receiver's identity proof
   * verifies and BEFORE any file metadata (TRANSFER_REQUEST) is sent. The UI
   * shows `sas` (and `peerId`) and resolves true only when the user confirms
   * it matches the receiver's screen. Resolving anything but true sends CANCEL
   * and throws SasRejectedError. `signal` aborts on a local abort, when the
   * peer sends CANCEL/ERROR, or when the channel closes. If omitted, no
   * sender-side confirmation is performed (tests).
   */
  confirmSas?: (info: { sas: string; peerId: string; signal: AbortSignal }) => Promise<boolean>
  /** Progress callback for UI: (fileIndex, fileName, bytesSent, fileBytes). */
  onProgress?: (fileIndex: number, fileName: string, bytesSent: number, fileBytes: number) => void
  /** Hash-phase progress before dialing (P2-1): (fileIndex, fileCount, fileName). */
  onHashProgress?: (fileIndex: number, fileCount: number, fileName: string) => void
  /**
   * How long to wait for TRANSFER_ACCEPT. Defaults to the receiver's consent
   * window plus a margin (R2). Tests may shorten it.
   */
  acceptTimeoutMs?: number
  /** How long to wait for each FILE_RESULT and for SESSION_RESULT. Defaults to 60 s (P0-2). */
  resultTimeoutMs?: number
}

export interface SendFileOutcome {
  name: string
  bytes: number
  sha256: string
  ok: boolean
  /** Receiver-reported final name (after autorename); present when ok. */
  finalName?: string
  /** Machine-readable failure code; present when !ok. */
  errorCode?: string
}

export interface SendResult {
  /** Per-file outcomes, in transfer order (P0-2). */
  outcomes: SendFileOutcome[]
  /** The receiver's verified Peer ID. */
  verifiedPeerId: string
  /** Short auth string: the UI must show it for out-of-band confirmation. */
  sas: string
}

/** Sender side: dial, handshake, SAS gate, Gate B, Gate C, stream files, collect results. */
export async function sendFiles(options: SendOptions): Promise<SendResult> {
  const { host, port, signal } = options
  const expectedPeerId = options.expectedPeerId
  const acceptTimeoutMs = options.acceptTimeoutMs ?? ACCEPT_TIMEOUT_MS
  const resultTimeoutMs = options.resultTimeoutMs ?? RESULT_TIMEOUT_MS
  // P0-11: count, type, size and budget are checked before any byte is hashed.
  await checkSendSources(options.files, signal)
  // Single-fd snapshots (P0-2): open once, fstat, hash through the same fd.
  const snapshots: FileSnapshot[] = []
  const closeSnapshots = async (): Promise<void> => {
    for (const s of snapshots) {
      try {
        await s.handle.close()
      } catch {
        /* ignore */
      }
    }
  }
  try {
    for (const [index, source] of options.files.entries()) {
      snapshots.push(await snapshotFile(source, index, options.files.length, signal, options.onHashProgress))
    }
  } catch (error) {
    await closeSnapshots()
    if (signal?.aborted) {
      throw new SendAbortedError("send cancelled before connecting", [])
    }
    throw error
  }
  const files: ProtocolFile[] = snapshots.map((s) => ({
    name: s.name,
    bytes: s.bytes,
    sha256: s.sha256,
  }))
  // Budget and identity checks must not leak the open snapshots on failure.
  try {
    enforceBudgets(files, "send")
  } catch (error) {
    await closeSnapshots()
    throw error
  }

  const identity = options.identity ?? generateEphemeralIdentity()
  try {
    claimIdentity(identity)
  } catch (error) {
    await closeSnapshots()
    throw error
  }
  const sessions = new SessionManager()
  let channel: NoiseChannel | null = null
  let sessionId: Uint8Array | null = null
  const outcomes: SendFileOutcome[] = []
  /** Fail the whole send but keep every completed per-file outcome (P1-11). */
  const fail = (message: string): never => {
    throw new SendAbortedError(message, outcomes)
  }

  try {
    const hs: HandshakeResult = await dialNoise(host, port, signal)
    channel = hs.channel
    sessionId = sessionIdFromHandshakeHash(hs.handshakeHash)
    const sas = sasFromHandshakeHash(hs.handshakeHash)
    const session = sessions.createSession("sender", sessionId)

    // Gate B, local side: the user provided the expected Peer ID out of band,
    // or (no expected ID: the normal real-mode path) the user's SAS
    // confirmation below is the local confirmation. Nothing is pinned.
    if (expectedPeerId !== undefined) {
      sessions.recordIdentityConfirmation(session.id, "local", new TextEncoder().encode(expectedPeerId))
    }

    const parser = new FrameParser(channel.asByteSource(signal), {
      maxBodyLength: 64 * 1024,
      maxBodyLengthByType: BODY_CAPS_V2,
      headerTimeoutMs: HANDSHAKE_TIMEOUT_MS,
      bodyTimeoutMs: 60_000,
    })
    const inbox = new FrameInbox(parser, session.id, signal)
    const sendFrame = (
      type: FrameType,
      body: Uint8Array,
      ext: ReadonlyMap<number, Uint8Array>,
    ): Promise<void> => channel!.send(encodeFrame(type, body, ext))

    // 1. SESSION_OPEN with our v2 identity proof.
    await sendFrame(
      FrameType.SessionOpen,
      jsonBytes(signProof(identity, hs.handshakeHash, "sender")),
      extSessionId(session.id),
    )

    // 2. Await the receiver's IDENTITY_CONFIRM and verify their proof.
    parser.transitionTo("awaiting-confirm")
    const confirm = await inbox.next(HANDSHAKE_TIMEOUT_MS, "the receiver's identity proof", signal)
    if (confirm.header.type !== FrameType.IdentityConfirm) {
      throw new Error("expected identity confirmation")
    }
    const proofBody: unknown = parseJsonBody(confirm.body, "identity proof")
    validateIdentityProofBody(proofBody)
    const verifiedPeerId = verifyProof(proofBody, hs.handshakeHash, expectedPeerId, {
      expectedRole: "receiver",
      ownPeerId: identity.peerId,
    })
    const verifiedIdentity = new TextEncoder().encode(verifiedPeerId)
    sessions.recordIdentityConfirmation(session.id, "remote", verifiedIdentity)

    // 3. SAS gate (P0-1 / D1): nothing about the files leaves until the user
    //    confirms that the SAS matches the receiver's screen. The gate's
    //    signal ends when the peer sends CANCEL/ERROR or the channel closes.
    if (options.confirmSas) {
      const gateAbort = new AbortController()
      const peerGone = inbox.watch()
      peerGone.catch((error: unknown) => gateAbort.abort(error))
      const gateSignal = signal ? AbortSignal.any([signal, gateAbort.signal]) : gateAbort.signal
      const approved = await withDeadline(
        Promise.race([options.confirmSas({ sas, peerId: verifiedPeerId, signal: gateSignal }), peerGone]),
        null,
        "SAS confirmation",
        signal,
      )
      if (approved !== true) {
        await sendFrame(
          FrameType.Cancel,
          jsonBytes({ code: "sas-rejected", reason: "sender did not confirm the SAS" }),
          extSessionId(session.id),
        )
        throw new SasRejectedError(sas)
      }
    }
    if (expectedPeerId === undefined) {
      // No expected ID: the confirmed SAS (or the send action, without a gate) is the local confirmation.
      sessions.recordIdentityConfirmation(session.id, "local", verifiedIdentity)
    }

    // 4. Gate B complete: authorize and send the transfer request (metadata only).
    const auth = sessions.authorizeTransfer(session.id, files)
    const requestId = createHash("sha256").update(auth.token).digest().subarray(0, 16)
    parser.transitionTo("awaiting-accept")
    await sendFrame(
      FrameType.TransferRequest,
      jsonBytes({ v: PROTOCOL_VERSION, files }),
      new Map([
        [ExtensionKey.SessionId, session.id],
        [ExtensionKey.RequestId, requestId],
      ]),
    )

    // 5. Gate C: the receiver's explicit acceptance, BY REQUEST INDEX (P0-7).
    const accept = await inbox.next(acceptTimeoutMs, "the receiver's decision", signal)
    if (accept.header.type !== FrameType.TransferAccept) {
      throw new Error("expected transfer acceptance")
    }
    const acceptRequestId = accept.header.extension.get(ExtensionKey.RequestId)
    if (!acceptRequestId || !equalBytes(acceptRequestId, requestId)) {
      throw new Error("transfer acceptance: request id mismatch")
    }
    const acceptedRaw: unknown = parseJsonBody(accept.body, "transfer acceptance")
    validateTransferAcceptBody(acceptedRaw)
    const indices = acceptedRaw.acceptedIndices
    if (indices.length === 0) {
      throw new Error("transfer acceptance: empty index set")
    }
    if (new Set(indices).size !== indices.length) {
      throw new Error("transfer acceptance: duplicate indices")
    }
    const acceptedFiles: ProtocolFile[] = indices.map((i) => {
      if (i >= files.length) {
        throw new Error("transfer acceptance: index out of range")
      }
      return files[i]!
    })
    // The accepted subset must itself fit the budgets (P0-7).
    enforceBudgets(acceptedFiles, "send-accepted")
    const accepted = sessions.acceptTransfer(auth, verifiedIdentity, acceptedFiles)
    const transferToken = Buffer.from(acceptedRaw.transferToken, "base64")
    if (transferToken.length !== TRANSFER_TOKEN_BYTES) {
      throw new Error("transfer acceptance: bad transfer token")
    }
    parser.transitionTo("sending")

    // 6. Stream each accepted file, then await its FILE_RESULT (P0-2).
    //    Success is reported ONLY on a matching acknowledgement; a close
    //    before the result, or a timeout, is a failure.
    let fileNumber = 0
    for (const file of accepted.acceptedFiles) {
      const snap = snapshots.find(
        (s) => s.name === file.name && s.bytes === file.bytes && s.sha256 === file.sha256,
      )
      if (!snap) {
        throw new Error("accepted file not in local set")
      }
      const fileId = createHash("sha256")
        .update(session.id)
        .update(transferToken)
        .update(file.name, "utf8")
        .digest()
        .subarray(0, 16)
      const fileExt = new Map([
        [ExtensionKey.SessionId, session.id],
        [ExtensionKey.FileId, fileId],
      ])
      const headerExt = new Map([
        ...fileExt,
        [ExtensionKey.FileIndex, new Uint8Array([fileNumber])],
        [ExtensionKey.TransferToken, new Uint8Array(transferToken)],
      ])
      const outcome: SendFileOutcome = {
        name: file.name,
        bytes: file.bytes,
        sha256: file.sha256,
        ok: false,
      }
      try {
        options.onProgress?.(fileNumber, file.name, 0, file.bytes)
        // While this file streams, the receiver's CANCEL/ERROR (or a closed
        // channel) ends the send at once with the peer's reason (R12).
        const peerGone = inbox.watch()
        await guardWrite(
          sendFrame(FrameType.FileHeader, jsonBytes({ name: file.name, bytes: file.bytes, sha256: file.sha256 }), headerExt),
          peerGone,
          signal,
        )
        const chunkBuf = Buffer.alloc(CHUNK_BYTES)
        let sentBytes = 0
        while (sentBytes < snap.bytes) {
          signal?.throwIfAborted()
          const want = Math.min(CHUNK_BYTES, snap.bytes - sentBytes)
          const { bytesRead } = await snap.handle.read(chunkBuf, 0, want, sentBytes)
          if (bytesRead === 0) {
            throw new Error(`file shrank during send: ${file.name}`)
          }
          await guardWrite(
            sendFrame(FrameType.FileChunk, chunkBuf.subarray(0, bytesRead), fileExt),
            peerGone,
            signal,
          )
          sentBytes += bytesRead
          options.onProgress?.(fileNumber, file.name, clampProgress(sentBytes, file.bytes), file.bytes)
        }
        await sendFrame(FrameType.FileEnd, jsonBytes({ sha256: file.sha256 }), fileExt)
        const result = await inbox.next(resultTimeoutMs, `the receiver's result for ${file.name}`, signal)
        if (result.header.type !== FrameType.FileResult) {
          throw new Error("expected file result")
        }
        const resultRaw: unknown = parseJsonBody(result.body, "file result")
        validateFileResultBody(resultRaw)
        if (resultRaw.index !== fileNumber) {
          throw new Error("file result: index mismatch")
        }
        // P0-2: a success acknowledgement must describe the bytes we sent.
        if (resultRaw.ok && (resultRaw.bytes !== file.bytes || resultRaw.sha256 !== file.sha256)) {
          throw new Error(`receiver acknowledged different content for ${file.name}`)
        }
        outcome.ok = resultRaw.ok
        outcome.finalName = resultRaw.finalName
        outcome.errorCode = resultRaw.errorCode
      } catch (error) {
        if (
          error instanceof PeerCancelledError ||
          error instanceof PeerSignalledError ||
          error instanceof TransferDeclinedError
        ) {
          throw error
        }
        // Local per-file failure: the session cannot continue this file, so
        // fail the whole send — keeping every completed outcome (P1-11).
        // The outer catch sends the peer teardown signal.
        fail(`send failed on ${file.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      outcomes.push(outcome)
      fileNumber++
    }

    // 7. Final session result (P0-2), then done.
    const sessionResult = await inbox.next(resultTimeoutMs, "the receiver's final result", signal)
    if (sessionResult.header.type !== FrameType.SessionResult) {
      throw new Error("expected session result")
    }
    const srRaw: unknown = parseJsonBody(sessionResult.body, "session result")
    validateSessionResultBody(srRaw)
    if (!srRaw.ok) {
      fail(`receiver reported session failure: ${srRaw.error ?? "unknown"}`)
    }
    return { outcomes, verifiedPeerId, sas }
  } catch (error) {
    // Errors the peer or the SAS gate already signalled need no teardown frame.
    const signalled =
      error instanceof TransferDeclinedError ||
      error instanceof PeerCancelledError ||
      error instanceof PeerSignalledError ||
      error instanceof SasRejectedError
    if (!signalled && channel !== null && sessionId !== null && !channel.isClosed) {
      // Best-effort teardown signal on local abort/failure (P1-10).
      try {
        const type = signal?.aborted ? FrameType.Cancel : FrameType.Error
        const code = signal?.aborted ? "local-cancel" : "E_LOCAL_ERROR"
        await channel.send(
          encodeFrame(
            type,
            jsonBytes({ code, reason: error instanceof Error ? error.message : String(error) }),
            extSessionId(sessionId),
          ),
        )
      } catch {
        /* best effort */
      }
    }
    if (error instanceof SendAbortedError || signalled) {
      throw error
    }
    throw new SendAbortedError(error instanceof Error ? error.message : String(error), outcomes)
  } finally {
    if (sessionId !== null) {
      sessions.destroySession(sessionId)
    }
    await closeSnapshots()
    channel?.close()
  }
}

export interface ReceiveOptions {
  channel: NoiseChannel
  handshakeHash: Uint8Array
  /**
   * The sender's complete Peer ID, verified out of band by the user.
   * If omitted, the verified Peer ID from the session proof is used and the
   * consent UI is responsible for showing it AND the SAS to the user
   * (trust-on-first-use via the accept action). If provided, it must match
   * exactly.
   */
  expectedPeerId?: string
  /**
   * Where to write received files. May be a function so the TUI can let the
   * user pick the destination on the consent screen (issue #27) — it is
   * resolved per file, after acceptance.
   */
  destinationDirectory: string | (() => string)
  /**
   * Called with the verified request; returns the exact subset to accept.
   * The SAS is provided so the consent screen can show it (P0-1). An empty
   * return sends an explicit DECLINE frame (P1-9).
   */
  onTransferRequest: (request: {
    peerId: string
    /**
     * Requested files. Return a subset of THESE object references: acceptance
     * is mapped back to request indices by reference (identical files in one
     * request must remain distinguishable).
     */
    files: ProtocolFile[]
    sas: string
    /**
     * Aborts when the consent window ends without an answer: sender
     * disconnect/cancel, consent deadline, or local abort. The UI must tear
     * down its prompt when this fires.
     */
    signal: AbortSignal
  }) => Promise<ProtocolFile[]>
  /**
   * Inject a pre-generated identity (tests). Generated fresh if omitted.
   * P1-13: an identity must never be reused across sessions.
   */
  identity?: EphemeralIdentity
  signal?: AbortSignal
  /**
   * Consent deadline in milliseconds. Defaults to 60s: a peer that
   * handshakes then goes silent must not hold the receiver's prompt
   * forever. Expiry sends DECLINE with code E_CONSENT_TIMEOUT (P1-9).
   */
  consentTimeoutMs?: number
  /**
   * How long to wait for the sender's TRANSFER_REQUEST after the identity
   * exchange. Defaults to 120s, which covers the sender's SAS confirmation.
   */
  requestTimeoutMs?: number
  /** Progress callback for UI: (fileIndex, fileName, bytesReceived, fileBytes). */
  onProgress?: (fileIndex: number, fileName: string, bytesReceived: number, fileBytes: number) => void
}

export interface ReceiveResult {
  files: ReceivedFile[]
  verifiedPeerId: string
  /** Short auth string: the UI must show it for out-of-band confirmation. */
  sas: string
}

/** Two entries describe the same file when name, size and digest all match. */
function sameFile(a: ProtocolFile, b: ProtocolFile): boolean {
  return a.name === b.name && a.bytes === b.bytes && a.sha256 === b.sha256
}

/** Receiver side: verify, Gate B, present request, Gate C, receive, acknowledge. */
export async function receiveFiles(options: ReceiveOptions): Promise<ReceiveResult> {
  const { channel, handshakeHash, onTransferRequest, signal } = options
  // Resolved per file, after acceptance — the consent screen may change it.
  const destDir = () =>
    typeof options.destinationDirectory === "function" ? options.destinationDirectory() : options.destinationDirectory
  const identity = options.identity ?? generateEphemeralIdentity()
  try {
    claimIdentity(identity)
  } catch (error) {
    // N8: a claim failure must not leave the accepted channel open.
    channel.close()
    throw error
  }
  const sessions = new SessionManager()
  const sessionId = sessionIdFromHandshakeHash(handshakeHash)
  const sas = sasFromHandshakeHash(handshakeHash)
  const session = sessions.createSession("receiver", sessionId)
  const received: ReceivedFile[] = []
  /** Fail the whole receive but keep every file already saved (P1-11). */
  const fail = (message: string): never => {
    throw new ReceiveAbortedError(message, received)
  }

  const parser = new FrameParser(channel.asByteSource(signal), {
    maxBodyLength: 64 * 1024,
    maxBodyLengthByType: BODY_CAPS_V2,
    headerTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    bodyTimeoutMs: 60_000,
  })
  const inbox = new FrameInbox(parser, session.id, signal)
  const sendFrame = (
    type: FrameType,
    body: Uint8Array,
    ext: ReadonlyMap<number, Uint8Array>,
  ): Promise<void> => channel.send(encodeFrame(type, body, ext))
  /** Best-effort peer teardown signal (P1-10). */
  const signalPeer = async (
    type: FrameType,
    code: string,
    reason: string,
  ): Promise<void> => {
    if (channel.isClosed) return
    try {
      await channel.send(encodeFrame(type, jsonBytes({ code, reason }), extSessionId(session.id)))
    } catch {
      /* best effort */
    }
  }

  try {
    // 1. SESSION_OPEN: verify the sender's v2 identity proof before anything else.
    const open = await inbox.next(HANDSHAKE_TIMEOUT_MS, "the sender's identity proof", signal)
    if (open.header.type !== FrameType.SessionOpen) {
      throw new Error("expected session open")
    }
    const senderProofBody: unknown = parseJsonBody(open.body, "identity proof")
    validateIdentityProofBody(senderProofBody)
    const verifiedSenderId = verifyProof(senderProofBody, handshakeHash, options.expectedPeerId, {
      expectedRole: "sender",
      ownPeerId: identity.peerId,
    })
    const senderIdentity = new TextEncoder().encode(verifiedSenderId)
    // Gate B, local side: with an out-of-band expected ID it was provided up
    // front; otherwise the user's accept action in onTransferRequest (after
    // comparing the SAS) is the local confirmation, recorded after they approve.
    if (options.expectedPeerId !== undefined) {
      sessions.recordIdentityConfirmation(session.id, "local", new TextEncoder().encode(options.expectedPeerId))
    }
    sessions.recordIdentityConfirmation(session.id, "remote", senderIdentity)
    parser.transitionTo("handshake")

    // 2. IDENTITY_CONFIRM with our own v2 proof.
    parser.transitionTo("identity-confirmed")
    await sendFrame(
      FrameType.IdentityConfirm,
      jsonBytes(signProof(identity, handshakeHash, "receiver")),
      extSessionId(session.id),
    )

    // 3. TRANSFER_REQUEST: metadata only, no bytes flow yet.
    const request = await inbox.next(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, "the transfer request", signal)
    if (request.header.type !== FrameType.TransferRequest) {
      throw new Error("expected transfer request")
    }
    const requestRaw: unknown = parseJsonBody(request.body, "transfer request")
    if (!isRecord(requestRaw)) throw new Error("malformed transfer request: not an object")
    if (requestRaw.v !== undefined && requestRaw.v !== PROTOCOL_VERSION) {
      throw new Error("transfer request: unsupported protocol version")
    }
    validateProtocolFiles(requestRaw.files, "transfer request")
    const requestFiles = requestRaw.files as ProtocolFile[]
    // Mirror the sender budgets on the receiver: a malicious sender must
    // not be able to make us authorize an over-budget session.
    enforceBudgets(requestFiles, "receive")
    const requestId = request.header.extension.get(ExtensionKey.RequestId)
    if (!requestId || requestId.length === 0) {
      throw new Error("transfer request: missing request id")
    }
    parser.transitionTo("request-review")

    // 4. Gate C: the user's explicit, separate acceptance of the exact set.
    //    The prompt's signal ends on the consent deadline, a local abort, or
    //    anything the sender does while the prompt is open (D3): a CANCEL, an
    //    ERROR, a protocol violation or a closed channel.
    const consentMs = options.consentTimeoutMs ?? CONSENT_TIMEOUT_MS
    const consent = new AbortController()
    const consentTimer = setTimeout(() => consent.abort(new ConsentTimeoutError(consentMs)), consentMs)
    const onLocalAbort = (): void => consent.abort(signal?.reason ?? new Error("aborted"))
    if (signal?.aborted) onLocalAbort()
    else signal?.addEventListener("abort", onLocalAbort, { once: true })
    let consentOpen = true
    const senderGone = inbox.watch()
    senderGone.catch((error: unknown) => {
      if (consentOpen) consent.abort(error)
    })
    let accepted: ProtocolFile[]
    try {
      accepted = await withDeadline(
        Promise.resolve().then(() =>
          onTransferRequest({ peerId: verifiedSenderId, files: requestFiles, sas, signal: consent.signal }),
        ),
        null,
        "the receiver's consent",
        consent.signal,
      )
    } catch (error) {
      if (error instanceof ConsentTimeoutError) {
        await signalPeer(FrameType.Decline, "E_CONSENT_TIMEOUT", error.message)
      }
      throw error
    } finally {
      consentOpen = false
      clearTimeout(consentTimer)
      signal?.removeEventListener("abort", onLocalAbort)
    }
    if (!Array.isArray(accepted)) {
      throw new Error("consent: onTransferRequest must resolve to a list of files")
    }
    if (options.expectedPeerId === undefined) {
      sessions.recordIdentityConfirmation(session.id, "local", senderIdentity)
    }
    if (accepted.length === 0) {
      // Explicit DECLINE frame instead of decline-as-exception (P1-9).
      await sendFrame(
        FrameType.Decline,
        jsonBytes({ code: "declined", reason: "declined by user" }),
        extSessionId(session.id),
      )
      throw new TransferDeclinedError("transfer declined by user", "declined")
    }
    const auth = sessions.authorizeTransfer(session.id, requestFiles)
    // Map the accepted subset to REQUEST INDICES (P0-7). D2: an entry is
    // matched by object reference, so identical files in one request stay
    // distinct. A copy falls back to a content match only when exactly one
    // request entry has that content.
    const seen = new Set<number>()
    const acceptedIndices: number[] = []
    for (const f of accepted) {
      let i = requestFiles.indexOf(f)
      if (i < 0) {
        const matches = requestFiles.flatMap((r, index) => (sameFile(r, f) ? [index] : []))
        if (matches.length !== 1) {
          throw new Error("accepted file was not in the request (return the request's own entries)")
        }
        i = matches[0]!
      }
      if (seen.has(i)) {
        throw new Error("duplicate accepted file")
      }
      seen.add(i)
      acceptedIndices.push(i)
    }
    const acceptedTransfer = sessions.acceptTransfer(
      auth,
      senderIdentity,
      acceptedIndices.map((i) => requestFiles[i]!),
    )
    // Receiver-issued transfer token (P1-12): echoed on every FILE_HEADER,
    // binding the file stream to this Gate C decision.
    const transferToken = new Uint8Array(TRANSFER_TOKEN_BYTES)
    getRandomValues(transferToken)
    // The state moves first, so the sender's first file frame is parsed in "receiving".
    parser.transitionTo("receiving")
    await sendFrame(
      FrameType.TransferAccept,
      jsonBytes({
        acceptedIndices,
        transferToken: Buffer.from(transferToken).toString("base64"),
      }),
      new Map([
        [ExtensionKey.SessionId, session.id],
        [ExtensionKey.RequestId, requestId],
      ]),
    )

    // 5. Receive each file into the safe sink, acknowledging each one
    //    with FILE_RESULT — including failures with error codes (P0-2).
    let fileNumber = 0
    for (const file of acceptedTransfer.acceptedFiles) {
      const header = await inbox.next(FRAME_IDLE_TIMEOUT_MS, "the next file header", signal)
      if (header.header.type !== FrameType.FileHeader) {
        throw new Error("expected file header")
      }
      const fileMetaRaw: unknown = parseJsonBody(header.body, "file header")
      validateProtocolFiles([fileMetaRaw], "file header")
      const fileMeta = fileMetaRaw as ProtocolFile
      if (fileMeta.sha256 !== file.sha256 || fileMeta.bytes !== file.bytes || fileMeta.name !== file.name) {
        throw new Error("file header does not match the accepted file")
      }
      const fileIndexExt = header.header.extension.get(ExtensionKey.FileIndex)
      if (!fileIndexExt || fileIndexExt.length !== 1 || fileIndexExt[0] !== fileNumber) {
        throw new Error("file header: file index mismatch")
      }
      const tokenExt = header.header.extension.get(ExtensionKey.TransferToken)
      if (!tokenExt || !equalBytes(tokenExt, transferToken)) {
        throw new Error("file header: transfer token mismatch")
      }
      const fileIdExt = header.header.extension.get(ExtensionKey.FileId)
      if (!fileIdExt || fileIdExt.length === 0) {
        throw new Error("file header: missing file id")
      }
      const fileId: Uint8Array = fileIdExt
      const destinationName = await resolveDestination(destDir(), file.name)

      let sawFileEnd = false
      async function* chunks(): AsyncGenerator<Uint8Array> {
        let receivedBytes = 0
        for (;;) {
          const frame = await inbox.next(FRAME_IDLE_TIMEOUT_MS, `data for ${file.name}`, signal)
          if (frame.header.type === FrameType.FileEnd) {
            const endRaw: unknown = parseJsonBody(frame.body, "file end")
            validateSha256Body(endRaw)
            if (endRaw.sha256 !== file.sha256) {
              throw new Error("file end hash mismatch")
            }
            sawFileEnd = true
            return
          }
          if (frame.header.type !== FrameType.FileChunk) {
            throw new Error(`unexpected frame during file receive: 0x${frame.header.type.toString(16)}`)
          }
          const chunkFileId = frame.header.extension.get(ExtensionKey.FileId)
          if (!chunkFileId || !equalBytes(fileId, chunkFileId)) {
            throw new Error("chunk for wrong file")
          }
          receivedBytes += frame.body.length
          options.onProgress?.(fileNumber, file.name, clampProgress(receivedBytes, file.bytes), file.bytes)
          yield frame.body
        }
      }

      try {
        const result = await receiveToFile(chunks(), {
          destinationDirectory: destDir(),
          peerFileName: destinationName,
          maxBytes: BUDGET_MAX_FILE_BYTES,
          maxNameBytes: APP_MAX_NAME_BYTES,
          expectedBytes: file.bytes,
          expectedSha256: file.sha256,
          signal,
        })
        received.push({ name: result.name, bytes: result.bytes, sha256: result.sha256, path: result.path })
        await sendFrame(
          FrameType.FileResult,
          jsonBytes({
            index: fileNumber,
            ok: true,
            finalName: result.name,
            bytes: result.bytes,
            sha256: result.sha256,
          }),
          extSessionId(session.id),
        )
      } catch (error) {
        const errorCode = receiveErrorCode(error)
        if (sawFileEnd) {
          // The sender's stream is at a file boundary (hash/size check
          // failed at finalize): report and continue with the next file.
          await sendFrame(
            FrameType.FileResult,
            jsonBytes({ index: fileNumber, ok: false, errorCode }),
            extSessionId(session.id),
          )
        } else {
          // Mid-stream failure: the byte stream is out of sync and the
          // sender would deadlock on backpressure, so a teardown frame ends
          // the session instead (CANCEL on local abort, ERROR otherwise).
          await signalPeer(
            signal?.aborted ? FrameType.Cancel : FrameType.Error,
            signal?.aborted ? "local-cancel" : errorCode,
            error instanceof Error ? error.message : String(error),
          )
          fail(`receive failed on ${file.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      fileNumber++
    }

    // 6. Final session result, then close. The sender's SESSION_RESULT read
    //    is its explicit acknowledgement (P0-2).
    await sendFrame(
      FrameType.SessionResult,
      jsonBytes({ ok: true, filesReceived: received.length }),
      extSessionId(session.id),
    )
    return { files: received, verifiedPeerId: verifiedSenderId, sas }
  } catch (error) {
    // Errors the peer or the consent deadline already signalled need no teardown frame.
    const signalled =
      error instanceof TransferDeclinedError ||
      error instanceof PeerCancelledError ||
      error instanceof PeerSignalledError ||
      error instanceof ConsentTimeoutError
    if (!signalled && !channel.isClosed) {
      // Best-effort teardown signal on local abort/failure (P1-10).
      try {
        const type = signal?.aborted ? FrameType.Cancel : FrameType.Error
        const code = signal?.aborted ? "local-cancel" : "E_LOCAL_ERROR"
        await channel.send(
          encodeFrame(
            type,
            jsonBytes({ code, reason: error instanceof Error ? error.message : String(error) }),
            extSessionId(session.id),
          ),
        )
      } catch {
        /* best effort */
      }
    }
    if (error instanceof ReceiveAbortedError || signalled) {
      throw error
    }
    throw new ReceiveAbortedError(error instanceof Error ? error.message : String(error), received)
  } finally {
    sessions.destroySession(session.id)
    channel.close()
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

// Re-exports for tests and future UI wiring.
export { dialNoise, listenNoise, DEFAULT_PORT } from "./transport.js"
export { generateEphemeralIdentity, peerIdFromPublicKey, verifyPeerId } from "./peer-id.js"
export { NOISE_PROLOGUE_V2, MAX_NOISE_MESSAGE_BYTES, MAX_NOISE_PLAINTEXT_BYTES } from "./noise.js"
