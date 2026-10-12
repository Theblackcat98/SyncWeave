import { createHash, createPublicKey, sign, verify } from "node:crypto"
import { createReadStream, promises as fs } from "node:fs"
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
 * Phase 2 direct-transfer protocol (see phase2.md and docs/decisions.md).
 *
 * Wire flow (all application frames travel inside the Noise-encrypted
 * channel; handshake messages are Noise, not application frames):
 *
 *   Sender -> Receiver: SESSION_OPEN      (sender's identity proof)
 *   Receiver -> Sender: IDENTITY_CONFIRM  (receiver's identity proof)
 *   Sender -> Receiver: TRANSFER_REQUEST  (file metadata, after Gate B)
 *   Receiver -> Sender: TRANSFER_ACCEPT   (Gate C: exact accepted subset)
 *   Sender -> Receiver: FILE_HEADER, FILE_CHUNK*, FILE_END per file
 *   Either -> Either:   CANCEL | ERROR
 *
 * Identity binding: each side signs the Noise handshake hash with its
 * session-ephemeral Ed25519 identity key and sends the public key + Peer ID
 * in its first encrypted frame. The peer verifies the signature over the
 * handshake hash (binding the identity to this exact connection), derives
 * the Peer ID from the public key, and compares the COMPLETE Peer ID with
 * the out-of-band expected value. A mismatch aborts the session before any
 * file metadata flows.
 *
 * Gate B (two independent confirmations): the local user's confirmation is
 * their act of providing the expected Peer ID; the remote user's
 * confirmation is their valid IDENTITY_CONFIRM/SESSION_OPEN proof.
 * Gate C (separate receiver acceptance): the receiver's explicit subset
 * choice, sent as TRANSFER_ACCEPT. The sender emits no file-body bytes
 * before receiving it.
 *
 * Files stream in 64 KiB FILE_CHUNK frames; whole files are never buffered.
 * Received files are written via the safe receive sink with automatic
 * rename on collision (`name (1).ext`). SHA-256 is verified before
 * finalization. Sessions are memory-only; restart-from-zero on failure.
 */

const CHUNK_BYTES = 64 * 1024
const APP_MAX_BODY = 16 * 1024 * 1024
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

interface IdentityProofBody {
  peerId: string
  identityPublicKey: string // base64
  identitySignature: string // base64, Ed25519 over the Noise handshake hash
}

function transcriptConfirmation(handshakeHash: Uint8Array, sessionId: Uint8Array): string {
  const digest = createHash("sha256")
    .update("syncweave-transcript-confirmation-v1", "utf8")
    .update(handshakeHash)
    .update(sessionId)
    .digest("hex")
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`
}

function signProof(identity: EphemeralIdentity, handshakeHash: Uint8Array): IdentityProofBody {
  const signature = sign(null, Buffer.from(handshakeHash), identity.privateKey)
  return {
    peerId: identity.peerId,
    identityPublicKey: Buffer.from(identity.publicKey).toString("base64"),
    identitySignature: signature.toString("base64"),
  }
}

/**
 * Verify an identity proof: signature over the handshake hash with the
 * presented key, Peer ID derived from that key, exact match with the
 * out-of-band expected Peer ID. Returns the verified Peer ID string for
 * session binding. Throws on any failure (fail closed).
 */
function verifyProof(
  proof: IdentityProofBody,
  handshakeHash: Uint8Array,
  expectedPeerId: string,
): string {
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
  const valid = verify(null, Buffer.from(handshakeHash), keyObject, signature)
  if (!valid) {
    throw new Error("identity proof: signature does not bind to this session")
  }
  // Re-derive the Peer ID from the verified key and compare the complete
  // string with the out-of-band expected value.
  const derived = peerIdFromPublicKey(publicKey)
  if (!verifyPeerId(expectedPeerId, derived) || !verifyPeerId(expectedPeerId, proof.peerId)) {
    throw new Error("identity proof: Peer ID does not match the expected out-of-band identity")
  }
  return derived
}

function parseJsonBody(header: FrameHeader, body: Uint8Array, what: string): unknown {
  void header
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

async function readFrame(
  parser: FrameParser,
  signal?: AbortSignal,
): Promise<{ header: FrameHeader; body: Uint8Array }> {
  const outcome = await parser.readHeader(signal)
  if (outcome.kind === "eof") {
    throw new Error("peer closed the session")
  }
  if (outcome.kind === "rejected") {
    throw new Error(`frame rejected: ${outcome.reason}`)
  }
  const body = await parser.readBody(outcome.header, signal)
  return { header: outcome.header, body }
}

/** Resolve a collision-free destination name: `name (1).ext`, `name (2).ext`, … */
async function resolveDestination(directory: string, peerFileName: string): Promise<string> {
  const safe = sanitizePeerBasename(peerFileName, APP_MAX_NAME_BYTES)
  const dot = safe.lastIndexOf(".")
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ""
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? safe : `${stem} (${i})${ext}`
    try {
      await fs.access(join(directory, candidate))
    } catch {
      return candidate // does not exist: usable
    }
    if (i > 9999) {
      throw new Error("too many name collisions")
    }
  }
}

async function sha256File(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256")
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    bytes += (chunk as Buffer).length
  }
  return { bytes, sha256: hash.digest("hex") }
}

function extSessionId(sessionId: Uint8Array): Map<number, Uint8Array> {
  return new Map([[ExtensionKey.SessionId, sessionId]])
}

export interface SendOptions {
  host: string
  port: number
  /** Local files to send. `sha256`/`bytes` are verified by reading the file. */
  files: Array<{ path: string; name: string }>
  /** The receiver's complete Peer ID, verified out of band by the user. */
  expectedPeerId: string
  /** Inject a pre-generated identity (tests). Generated fresh if omitted. */
  identity?: EphemeralIdentity
  signal?: AbortSignal
}

/** Sender side: dial, handshake, Gate B, Gate C, then stream files. */
export async function sendFiles(options: SendOptions): Promise<void> {
  const { host, port, expectedPeerId, signal } = options
  if (options.files.length === 0 || options.files.length > BUDGET_MAX_FILES) {
    throw new Error(`file count must be 1-${BUDGET_MAX_FILES}`)
  }
  // Hash and measure every file up front (bounded: 25 files).
  const files: Array<ProtocolFile & { path: string }> = []
  for (const f of options.files) {
    const { bytes, sha256 } = await sha256File(f.path)
    files.push({ path: f.path, name: f.name, bytes, sha256 })
  }
  enforceBudgets(files, "send")

  const identity = options.identity ?? generateEphemeralIdentity()
  const sessions = new SessionManager()
  let channel: NoiseChannel | null = null
  try {
    const hs: HandshakeResult = await dialNoise(host, port, signal)
    channel = hs.channel
    const session = sessions.createSession("sender")
    const confirmation = transcriptConfirmation(hs.handshakeHash, session.id)

    // Gate B, local side: the user provided the expected Peer ID out of band.
    sessions.recordIdentityConfirmation(session.id, "local", new TextEncoder().encode(expectedPeerId))

    // 1. SESSION_OPEN with our identity proof.
    await channel.send(
      encodeFrame(FrameType.SessionOpen, Buffer.from(JSON.stringify(signProof(identity, hs.handshakeHash))), extSessionId(session.id), APP_MAX_BODY),
    )

    // 2. Await the receiver's IDENTITY_CONFIRM and verify their proof.
    const parser = new FrameParser(channel.asByteSource(signal), { maxBodyLength: APP_MAX_BODY })
    parser.transitionTo("awaiting-confirm")
    const confirm = await readFrame(parser, signal)
    if (confirm.header.type !== FrameType.IdentityConfirm) {
      throw new Error("expected identity confirmation")
    }
    const proofBody: unknown = parseJsonBody(confirm.header, confirm.body, "identity proof")
    validateIdentityProofBody(proofBody)
    const verifiedPeerId = verifyProof(proofBody, hs.handshakeHash, expectedPeerId)
    const verifiedIdentity = new TextEncoder().encode(verifiedPeerId)
    sessions.recordIdentityConfirmation(session.id, "remote", verifiedIdentity)

    // 3. Gate B complete: authorize and send the transfer request (metadata only).
    const authorized = files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 }))
    const auth = sessions.authorizeTransfer(session.id, authorized)
    const requestId = Buffer.from(createHash("sha256").update(auth.token).digest()).subarray(0, 16)
    const requestExt = new Map([
      [ExtensionKey.SessionId, session.id],
      [ExtensionKey.RequestId, requestId],
    ])
    await channel.send(
      encodeFrame(FrameType.TransferRequest, Buffer.from(JSON.stringify({ files: authorized })), requestExt, APP_MAX_BODY),
    )

    // 4. Gate C: await the receiver's explicit acceptance before any file bytes.
    parser.transitionTo("awaiting-accept")
    const accept = await readFrame(parser, signal)
    if (accept.header.type !== FrameType.TransferAccept) {
      throw new Error("expected transfer acceptance")
    }
    const acceptedRaw: unknown = parseJsonBody(accept.header, accept.body, "transfer acceptance")
    if (!isRecord(acceptedRaw)) throw new Error("malformed transfer acceptance: not an object")
    validateProtocolFiles(acceptedRaw.files, "transfer acceptance")
    const acceptedBody = acceptedRaw as { files: ProtocolFile[] }
    const accepted = sessions.acceptTransfer(auth, verifiedIdentity, acceptedBody.files)
    parser.transitionTo("sending")

    // 5. Stream each accepted file: header, chunks, end.
    let fileIndex = 0
    for (const file of accepted.acceptedFiles) {
      const local = files.find((f) => f.name === file.name && f.bytes === file.bytes && f.sha256 === file.sha256)
      if (!local) {
        throw new Error("accepted file not in local set")
      }
      const fileId = createHash("sha256").update(auth.token).update(file.name).digest().subarray(0, 16)
      const headerExt = new Map([
        [ExtensionKey.SessionId, session.id],
        [ExtensionKey.FileId, fileId],
        [ExtensionKey.FileIndex, new Uint8Array([fileIndex])],
      ])
      await channel.send(
        encodeFrame(FrameType.FileHeader, Buffer.from(JSON.stringify({ name: file.name, bytes: file.bytes, sha256: file.sha256 })), headerExt, APP_MAX_BODY),
      )
      for await (const chunk of createReadStream(local.path, { highWaterMark: CHUNK_BYTES })) {
        const chunkExt = new Map([
          [ExtensionKey.SessionId, session.id],
          [ExtensionKey.FileId, fileId],
        ])
        await channel.send(encodeFrame(FrameType.FileChunk, new Uint8Array(chunk as Buffer), chunkExt, APP_MAX_BODY))
      }
      const endExt = new Map([
        [ExtensionKey.SessionId, session.id],
        [ExtensionKey.FileId, fileId],
      ])
      await channel.send(
        encodeFrame(FrameType.FileEnd, Buffer.from(JSON.stringify({ sha256: file.sha256 })), endExt, APP_MAX_BODY),
      )
      fileIndex++
    }
    // Do not close yet: wait for the receiver to consume every byte and
    // close first (it closes on success). Our FIN only goes out after that,
    // so a fast sender can never truncate a slow receiver.
    await channel.waitForPeerClose(10_000)
    void confirmation
  } finally {
    channel?.close()
  }
}

export interface ReceiveOptions {
  channel: NoiseChannel
  handshakeHash: Uint8Array
  /** The sender's complete Peer ID, verified out of band by the user. */
  expectedPeerId: string
  destinationDirectory: string
  /** Called with the verified request; returns the exact subset to accept. */
  onTransferRequest: (request: { peerId: string; files: ProtocolFile[] }) => Promise<ProtocolFile[]>
  /** Inject a pre-generated identity (tests). Generated fresh if omitted. */
  identity?: EphemeralIdentity
  signal?: AbortSignal
}

/** Receiver side: verify, Gate B, present request, Gate C, then receive. */
export async function receiveFiles(options: ReceiveOptions): Promise<ReceivedFile[]> {
  const { channel, handshakeHash, expectedPeerId, destinationDirectory, onTransferRequest, signal } = options
  const identity = options.identity ?? generateEphemeralIdentity()
  const sessions = new SessionManager()
  const received: ReceivedFile[] = []
  try {
    const session = sessions.createSession("receiver")
    const parser = new FrameParser(channel.asByteSource(signal), { maxBodyLength: APP_MAX_BODY })

    // 1. SESSION_OPEN: verify the sender's identity proof before anything else.
    const open = await readFrame(parser, signal)
    if (open.header.type !== FrameType.SessionOpen) {
      throw new Error("expected session open")
    }
    const senderProofBody: unknown = parseJsonBody(open.header, open.body, "identity proof")
    validateIdentityProofBody(senderProofBody)
    const verifiedSenderId = verifyProof(senderProofBody, handshakeHash, expectedPeerId)
    const senderIdentity = new TextEncoder().encode(verifiedSenderId)
    sessions.recordIdentityConfirmation(session.id, "local", new TextEncoder().encode(expectedPeerId))
    sessions.recordIdentityConfirmation(session.id, "remote", senderIdentity)
    parser.transitionTo("handshake")

    // 2. IDENTITY_CONFIRM with our own proof.
    await channel.send(
      encodeFrame(FrameType.IdentityConfirm, Buffer.from(JSON.stringify(signProof(identity, handshakeHash))), extSessionId(session.id), APP_MAX_BODY),
    )
    parser.transitionTo("identity-confirmed")

    // 3. TRANSFER_REQUEST: metadata only, no bytes flow yet.
    const request = await readFrame(parser, signal)
    if (request.header.type !== FrameType.TransferRequest) {
      throw new Error("expected transfer request")
    }
    const requestRaw: unknown = parseJsonBody(request.header, request.body, "transfer request")
    if (!isRecord(requestRaw)) throw new Error("malformed transfer request: not an object")
    validateProtocolFiles(requestRaw.files, "transfer request")
    const requestBody = requestRaw as { files: ProtocolFile[] }
    // Mirror the sender budgets on the receiver: a malicious sender must
    // not be able to make us authorize an over-budget session.
    enforceBudgets(requestBody.files, "receive")
    const auth = sessions.authorizeTransfer(session.id, requestBody.files)
    parser.transitionTo("request-review")

    // 4. Gate C: the user's explicit, separate acceptance of the exact set.
    const accepted = await onTransferRequest({ peerId: senderProofBody.peerId, files: requestBody.files })
    const acceptedTransfer = sessions.acceptTransfer(auth, senderIdentity, accepted)
    const requestId = request.header.extension.get(ExtensionKey.RequestId) ?? new Uint8Array(0)
    const acceptExt = new Map([
      [ExtensionKey.SessionId, session.id],
      [ExtensionKey.RequestId, requestId],
    ])
    await channel.send(
      encodeFrame(FrameType.TransferAccept, Buffer.from(JSON.stringify({ files: acceptedTransfer.acceptedFiles })), acceptExt, APP_MAX_BODY),
    )
    parser.transitionTo("receiving")

    // 5. Receive each file into the safe sink with autorename on collision.
    for (const file of acceptedTransfer.acceptedFiles) {
      const header = await readFrame(parser, signal)
      if (header.header.type !== FrameType.FileHeader) {
        throw new Error("expected file header")
      }
      const fileMetaRaw: unknown = parseJsonBody(header.header, header.body, "file header")
      validateProtocolFiles([fileMetaRaw], "file header")
      const fileMeta = fileMetaRaw as ProtocolFile
      if (fileMeta.sha256 !== file.sha256 || fileMeta.bytes !== file.bytes) {
        throw new Error("file header does not match the accepted file")
      }
      const fileId = header.header.extension.get(ExtensionKey.FileId)
      const destinationName = await resolveDestination(destinationDirectory, file.name)

      async function* chunks(): AsyncGenerator<Uint8Array> {
        for (;;) {
          const frame = await readFrame(parser, signal)
          if (frame.header.type === FrameType.FileEnd) {
            const endRaw: unknown = parseJsonBody(frame.header, frame.body, "file end")
            validateSha256Body(endRaw)
            const endBody = endRaw
            if (endBody.sha256 !== file.sha256) {
              throw new Error("file end hash mismatch")
            }
            return
          }
          if (frame.header.type !== FrameType.FileChunk) {
            throw new Error(`unexpected frame during file receive: 0x${frame.header.type.toString(16)}`)
          }
          const chunkFileId = frame.header.extension.get(ExtensionKey.FileId)
          if (!fileId || !chunkFileId || !equalBytes(fileId, chunkFileId)) {
            throw new Error("chunk for wrong file")
          }
          yield frame.body
        }
      }

      const result = await receiveToFile(chunks(), {
        destinationDirectory,
        peerFileName: destinationName,
        maxBytes: 2 * 1024 * 1024 * 1024,
        maxNameBytes: APP_MAX_NAME_BYTES,
        expectedBytes: file.bytes,
        expectedSha256: file.sha256,
        signal,
      })
      received.push({ name: result.name, bytes: result.bytes, sha256: result.sha256, path: result.path })
    }
    return received
  } finally {
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
