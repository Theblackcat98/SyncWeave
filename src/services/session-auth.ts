import { createHash, getRandomValues, timingSafeEqual } from "node:crypto"

/**
 * Ephemeral, memory-only session authorization for the Phase 2 direct-transfer
 * profile (see phase2.md: "Conditionally selected MVP profile" and
 * "Protocol-agnostic session authorization gates").
 *
 * Model:
 * - Every session gets a fresh unpredictable 128-bit session id and nonce.
 *   Identity keys/ids are created per session by the transport layer; this
 *   module binds authorizations to the *presented* peer identity bytes without
 *   persisting them.
 * - Gate B (two independent out-of-band identity confirmations) is recorded
 *   per session: both endpoints must confirm the matching session-bound value
 *   before any peer/file metadata may be authorized.
 * - Gate C (separate receiver acceptance) is a distinct action: the receiver
 *   accepts the exact pending session and selected file set. Consent for one
 *   session or file set never authorizes another.
 * - Authorizations are single-use tokens bound to (session id, peer identity,
 *   nonce, exact file set). Wrong, expired, replayed, duplicate, or
 *   cross-session presentations are rejected (fail closed).
 * - All state is memory-only. `destroySession` wipes it; after a restart no
 *   session can resume or authorize bytes. Nothing here writes to disk.
 *
 * A content hash authenticates file bytes against corruption; it does not
 * authenticate the peer. Peer authentication is the transport layer's job
 * (Noise-authenticated connection with full Peer ID comparison); this module
 * binds the application's consent decisions to whatever identity the
 * transport verified for this exact connection.
 */
export const SESSION_ID_BYTES = 16
export const NONCE_BYTES = 16
export const TOKEN_BYTES = 32

export interface SessionDescriptor {
  /** Unpredictable, short-lived session identifier. */
  readonly id: Uint8Array
  /** Fresh per-session nonce binding confirmations and authorizations. */
  readonly nonce: Uint8Array
  /** "sender" or "receiver" role for this endpoint. */
  readonly role: "sender" | "receiver"
  /** Monotonic creation time (ms). */
  readonly createdAt: number
}

export interface AuthorizedFile {
  readonly name: string
  readonly bytes: number
  /** Expected SHA-256 hex digest of the file content. */
  readonly sha256: string
}

export interface TransferAuthorization {
  /** Single-use authorization token. */
  readonly token: Uint8Array
  /** Session this authorization belongs to. */
  readonly sessionId: Uint8Array
  /** The exact file set authorized. */
  readonly files: readonly AuthorizedFile[]
}

export interface AcceptedTransfer {
  readonly sessionId: Uint8Array
  /** The exact subset the receiver accepted; nothing else is authorized. */
  readonly acceptedFiles: readonly AuthorizedFile[]
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuthorizationError"
  }
}

export interface SessionManagerOptions {
  /** Session lifetime in ms (default 10 minutes). Expired sessions fail closed. */
  sessionTtlMs?: number
  /** Clock for tests (default Date.now). */
  now?: () => number
}

interface SessionRecord {
  descriptor: SessionDescriptor
  /** Identity bytes the transport verified for the peer on this connection. */
  peerIdentity: Uint8Array | null
  confirmations: Set<"local" | "remote">
  usedTokens: Set<string>
  destroyed: boolean
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  getRandomValues(out)
  return out
}

function filesBinding(files: readonly AuthorizedFile[]): Uint8Array {
  const canonical = [...files]
    .map((f) => `${f.name}\0${f.bytes}\0${f.sha256}`)
    .sort()
    .join("\n")
  return createHash("sha256").update(canonical, "utf8").digest()
}

function tokenFor(
  session: SessionRecord,
  files: readonly AuthorizedFile[],
): Uint8Array {
  // Domain-separated binding of session id, nonce, verified peer identity,
  // and the exact file set. The token is opaque to the caller: validation
  // recomputes the expected token and compares in constant time.
  return createHash("sha256")
    .update("syncweave-transfer-auth-v1", "utf8")
    .update(session.descriptor.id)
    .update(session.descriptor.nonce)
    .update(session.peerIdentity ?? new Uint8Array(0))
    .update(filesBinding(files))
    .digest()
}

function hexKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionTtlMs: number
  private readonly now: () => number

  constructor(options: SessionManagerOptions = {}) {
    this.sessionTtlMs = options.sessionTtlMs ?? 10 * 60 * 1000
    this.now = options.now ?? Date.now
  }

  /** Create a fresh ephemeral session. Identity keys/ids are created per
   *  session by the transport layer and never loaded from durable storage. */
  createSession(role: "sender" | "receiver"): SessionDescriptor {
    const descriptor: SessionDescriptor = {
      id: randomBytes(SESSION_ID_BYTES),
      nonce: randomBytes(NONCE_BYTES),
      role,
      createdAt: this.now(),
    }
    this.sessions.set(hexKey(descriptor.id), {
      descriptor,
      peerIdentity: null,
      confirmations: new Set(),
      usedTokens: new Set(),
      destroyed: false,
    })
    return descriptor
  }

  /**
   * Record one endpoint's out-of-band identity confirmation (Gate B). The
   * transport must have verified `verifiedPeerIdentity` on this exact
   * connection before calling. Both "local" and "remote" confirmations are
   * required before metadata or transfers are authorized; one endpoint's
   * confirmation never stands in for the other's.
   */
  recordIdentityConfirmation(
    sessionId: Uint8Array,
    endpoint: "local" | "remote",
    verifiedPeerIdentity: Uint8Array,
  ): void {
    const session = this.requireLiveSession(sessionId)
    if (session.peerIdentity === null) {
      session.peerIdentity = Uint8Array.from(verifiedPeerIdentity)
    } else if (
      session.peerIdentity.length !== verifiedPeerIdentity.length ||
      !timingSafeEqual(session.peerIdentity, Uint8Array.from(verifiedPeerIdentity))
    ) {
      // Identity or transcript mismatch fails closed.
      this.destroySession(sessionId)
      throw new AuthorizationError("Peer identity mismatch: session destroyed")
    }
    session.confirmations.add(endpoint)
  }

  /** True only after both endpoints independently confirmed. */
  isIdentityConfirmed(sessionId: Uint8Array): boolean {
    const session = this.requireLiveSession(sessionId)
    return session.confirmations.has("local") && session.confirmations.has("remote")
  }

  /**
   * Authorize a transfer request for the exact file set. Requires Gate B
   * (both identity confirmations). The returned token is single-use and
   * bound to this session, peer, nonce, and file set.
   */
  authorizeTransfer(
    sessionId: Uint8Array,
    files: readonly AuthorizedFile[],
  ): TransferAuthorization {
    const session = this.requireLiveSession(sessionId)
    if (!this.isIdentityConfirmed(sessionId)) {
      throw new AuthorizationError(
        "Transfer authorization requires both identity confirmations (Gate B)",
      )
    }
    if (files.length === 0) {
      throw new AuthorizationError("Cannot authorize an empty file set")
    }
    const token = tokenFor(session, files)
    return { token, sessionId: Uint8Array.from(sessionId), files }
  }

  /**
   * Validate a presented authorization: session liveness, peer identity,
   * exact file set, single use. Rejects wrong, expired, replayed, duplicate,
   * or cross-session presentations (fail closed).
   */
  validateAuthorization(
    presented: TransferAuthorization,
    verifiedPeerIdentity: Uint8Array,
  ): void {
    const session = this.checkAuthorization(presented, verifiedPeerIdentity)
    session.usedTokens.add(hexKey(presented.token))
  }

  /**
   * Gate C: the receiver's separate, explicit acceptance of the exact pending
   * session and selected file set. Requires Gate B first. The accepted subset
   * must be a non-empty subset of the authorized files; anything not accepted
   * is not authorized. A rejected subset does not consume the token: only a
   * fully valid acceptance does. Discovery, peer selection, identity
   * confirmation, a prior transfer, or a saved destination never substitutes
   * for this action.
   */
  acceptTransfer(
    presented: TransferAuthorization,
    verifiedPeerIdentity: Uint8Array,
    acceptedFiles: readonly AuthorizedFile[],
  ): AcceptedTransfer {
    const session = this.checkAuthorization(presented, verifiedPeerIdentity)
    if (acceptedFiles.length === 0) {
      throw new AuthorizationError("Acceptance requires at least one file")
    }
    const authorized = new Set(presented.files.map((f) => `${f.name}\0${f.bytes}\0${f.sha256}`))
    for (const file of acceptedFiles) {
      if (!authorized.has(`${file.name}\0${file.bytes}\0${file.sha256}`)) {
        throw new AuthorizationError("Accepted file was not in the authorized set")
      }
    }
    session.usedTokens.add(hexKey(presented.token))
    return { sessionId: Uint8Array.from(presented.sessionId), acceptedFiles }
  }

  /**
   * Check authenticity and liveness without consuming the token. Returns the
   * session record on success so the caller can mark the token used only
   * after all further checks pass.
   */
  private checkAuthorization(
    presented: TransferAuthorization,
    verifiedPeerIdentity: Uint8Array,
  ): SessionRecord {
    const session = this.requireLiveSession(presented.sessionId)
    if (session.peerIdentity === null) {
      throw new AuthorizationError("No verified peer identity for session")
    }
    const presentedIdentity = Uint8Array.from(verifiedPeerIdentity)
    if (
      presentedIdentity.length !== session.peerIdentity.length ||
      !timingSafeEqual(presentedIdentity, session.peerIdentity)
    ) {
      throw new AuthorizationError("Peer identity does not match the session binding")
    }
    const expected = tokenFor(session, presented.files)
    if (
      presented.token.length !== expected.length ||
      !timingSafeEqual(Uint8Array.from(presented.token), expected)
    ) {
      throw new AuthorizationError("Authorization token does not match session binding")
    }
    const key = hexKey(presented.token)
    if (session.usedTokens.has(key)) {
      throw new AuthorizationError("Authorization token already used (replay rejected)")
    }
    return session
  }

  /** Destroy a session and wipe its memory-only state. After this, nothing
   *  from the session can authorize bytes. */
  destroySession(sessionId: Uint8Array): void {
    const key = hexKey(sessionId)
    const record = this.sessions.get(key)
    if (record) {
      record.descriptor.id.fill(0)
      record.descriptor.nonce.fill(0)
      record.peerIdentity?.fill(0)
      record.peerIdentity = null
      record.confirmations.clear()
      record.usedTokens.clear()
      record.destroyed = true
      this.sessions.delete(key)
    }
  }

  get activeSessionCount(): number {
    return this.sessions.size
  }

  private requireLiveSession(sessionId: Uint8Array): SessionRecord {
    const record = this.sessions.get(hexKey(sessionId))
    if (!record || record.destroyed) {
      throw new AuthorizationError("Unknown or destroyed session")
    }
    if (this.now() - record.descriptor.createdAt > this.sessionTtlMs) {
      this.destroySession(sessionId)
      throw new AuthorizationError("Session expired")
    }
    return record
  }
}
