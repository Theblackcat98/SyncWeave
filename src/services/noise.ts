import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "node:crypto"

/**
 * Noise_XX_25519_AESGCM_SHA256, implemented on node:crypto.
 *
 * Rationale (see docs/decisions.md): Bun's node:crypto provides
 * hardware-backed AES-256-GCM but no ChaCha20-Poly1305, so the AES-GCM
 * Noise suite is used instead of the ChaChaPoly one. This is a standard
 * Noise protocol name ("Noise_XX_25519_AESGCM_SHA256"). The implementation
 * is verified against the official Noise test vector for this exact suite
 * (see src/__tests__/noise.test.ts).
 *
 * XX handshake:
 *   -> e
 *   <- e, ee, s, es
 *   -> s, se
 * After the handshake, Split() derives two transport keys: the initiator
 * sends with c1 and receives with c2; the responder does the opposite.
 *
 * This module handles the Noise handshake and record layer only. Peer
 * identity binding (comparing the expected Peer ID on this exact connection)
 * is the caller's responsibility — see peer-id.ts and transfer-protocol.ts.
 */

export const NOISE_PROTOCOL_NAME = "Noise_XX_25519_AESGCM_SHA256"
const HASHLEN = 32
const NONCE_BYTES = 12

/**
 * v2 handshake prologue (P0-1). Binds the Noise session to SyncWeave so a
 * handshake transcript cannot be transplanted into another protocol's
 * session. transport.ts passes it as `prologue` on both dial and listen.
 * Changing the prologue is a coordinated change: both ends must agree or
 * the handshake fails.
 */
export const NOISE_PROLOGUE_V2 = new TextEncoder().encode("syncweave-noise-prologue-v2")

/**
 * Noise spec §5.1: a transport message (payload + 16-byte AEAD tag) must
 * not exceed 65535 bytes, so the largest legal plaintext is 65519 bytes.
 * Enforced here so no caller can emit or accept an over-limit message
 * (P0-6).
 */
export const MAX_NOISE_MESSAGE_BYTES = 65535
export const MAX_NOISE_PLAINTEXT_BYTES = MAX_NOISE_MESSAGE_BYTES - 16

/** Noise_XX has three handshake messages. */
const HANDSHAKE_MESSAGE_COUNT = 3
/**
 * Exact handshake message sizes with empty payloads (P0-6):
 *   msg1 -> e                 = 32
 *   msg2 <- e, ee, s, es      = 32 + (32 + 16) + 16
 *   msg3 -> s, se             = (32 + 16) + 16
 */
const HANDSHAKE_EMPTY_PAYLOAD_LENGTHS = [32, 96, 64] as const

export interface X25519Keypair {
  privateKey: KeyObject
  publicKey: Uint8Array
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function toU8(bytes: Uint8Array | Buffer | DataView): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

export function x25519Generate(): X25519Keypair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519")
  const publicDer = publicKey.export({ format: "der", type: "spki" })
  // SPKI DER for X25519 ends with the 32-byte raw public key.
  return { privateKey, publicKey: toU8(publicDer).subarray(-32) }
}

function x25519Dh(privateKey: KeyObject, publicKeyBytes: Uint8Array): Uint8Array {
  const peerKey = createPublicKey({
    key: {
      kty: "OKP",
      crv: "X25519",
      x: Buffer.from(publicKeyBytes).toString("base64url"),
    },
    format: "jwk",
  })
  return toU8(diffieHellman({ privateKey, publicKey: peerKey }) as Buffer)
}

function hash(data: Uint8Array): Uint8Array {
  return toU8(createHash("sha256").update(data).digest())
}

/**
 * HKDF(chaining_key, input_key_material, num_outputs) per Noise §4:
 * temp_key = HMAC-HASH(chaining_key, input_key_material).
 */
function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array, outputs: number): Uint8Array[] {
  const okm = hkdfSync(
    "sha256",
    Buffer.from(inputKeyMaterial),
    Buffer.from(chainingKey),
    "",
    HASHLEN * outputs,
  )
  const bytes = new Uint8Array(okm)
  const out: Uint8Array[] = []
  for (let i = 0; i < outputs; i++) {
    out.push(bytes.subarray(i * HASHLEN, (i + 1) * HASHLEN))
  }
  return out
}

/** 96-bit nonce: 32 zero bits followed by big-endian 64-bit n. */
function nonceBytes(n: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES)
  const view = new DataView(nonce.buffer)
  view.setUint32(4, Math.floor(n / 0x100000000))
  view.setUint32(8, n >>> 0)
  return nonce
}

class CipherState {
  private k: Uint8Array | null = null
  private n = 0

  initializeKey(key: Uint8Array): void {
    this.k = Uint8Array.from(key)
    this.n = 0
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.k === null) {
      return Uint8Array.from(plaintext)
    }
    if (plaintext.length > MAX_NOISE_PLAINTEXT_BYTES) {
      throw new Error(
        `Noise plaintext ${plaintext.length} bytes exceeds the 65535-byte message limit`,
      )
    }
    if (this.n >= 0xffffffff) {
      throw new Error("Noise nonce overflow")
    }
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(this.k), Buffer.from(nonceBytes(this.n)))
    cipher.setAAD(Buffer.from(ad))
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()])
    const tag = cipher.getAuthTag()
    this.n += 1
    return concat(toU8(ciphertext), toU8(tag))
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.k === null) {
      return Uint8Array.from(ciphertext)
    }
    if (this.n >= 0xffffffff) {
      throw new Error("Noise nonce overflow")
    }
    if (ciphertext.length < 16) {
      throw new Error("Noise ciphertext too short")
    }
    if (ciphertext.length > MAX_NOISE_MESSAGE_BYTES) {
      throw new Error(
        `Noise ciphertext ${ciphertext.length} bytes exceeds the 65535-byte message limit`,
      )
    }
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(this.k), Buffer.from(nonceBytes(this.n)))
    decipher.setAAD(Buffer.from(ad))
    decipher.setAuthTag(Buffer.from(ciphertext.subarray(ciphertext.length - 16)))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertext.subarray(0, ciphertext.length - 16))),
      decipher.final(),
    ])
    this.n += 1
    return toU8(plaintext)
  }
}

class SymmetricState {
  private ck: Uint8Array
  private h: Uint8Array
  private readonly cipher = new CipherState()

  constructor(protocolName: string) {
    const nameBytes = new TextEncoder().encode(protocolName)
    if (nameBytes.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN)
      this.h.set(nameBytes)
    } else {
      this.h = hash(nameBytes)
    }
    this.ck = Uint8Array.from(this.h)
  }

  mixHash(data: Uint8Array): void {
    this.h = hash(concat(this.h, data))
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [ck, tempK] = hkdf(this.ck, inputKeyMaterial, 2)
    this.ck = ck!
    this.cipher.initializeKey(tempK!)
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, new Uint8Array(0), 2)
    const c1 = new CipherState()
    const c2 = new CipherState()
    c1.initializeKey(k1!)
    c2.initializeKey(k2!)
    return [c1, c2]
  }

  get handshakeHash(): Uint8Array {
    return Uint8Array.from(this.h)
  }
}

export interface NoiseHandshakeOptions {
  initiator: boolean
  /**
   * Allow non-empty handshake payloads. Off by default: SyncWeave's handshake
   * carries empty payloads, so the three messages have exact lengths 32, 96
   * and 64 bytes (P0-6). Only the official test vectors need payloads.
   */
  allowHandshakePayload?: boolean
  prologue?: Uint8Array
  /** Fixed static key (tests / vectors). Generated if omitted. */
  staticKey?: X25519Keypair
  /** Fixed ephemeral key (tests / vectors). Generated per handshake if omitted. */
  ephemeralKey?: X25519Keypair
}

/**
 * One side of a Noise_XX handshake. Drive with writeMessage() /
 * readMessage() alternately; after the third message, split() yields the
 * transport cipher states.
 */
export class NoiseHandshake {
  private readonly symmetric: SymmetricState
  private readonly initiator: boolean
  private readonly s: X25519Keypair
  private e: X25519Keypair
  private rs: Uint8Array | null = null
  private re: Uint8Array | null = null
  private messageIndex = 0
  private splitDone = false
  private readonly allowPayload: boolean

  constructor(options: NoiseHandshakeOptions) {
    this.initiator = options.initiator
    this.allowPayload = options.allowHandshakePayload ?? false
    this.symmetric = new SymmetricState(NOISE_PROTOCOL_NAME)
    this.symmetric.mixHash(options.prologue ?? new Uint8Array(0))
    this.s = options.staticKey ?? x25519Generate()
    this.e = options.ephemeralKey ?? x25519Generate()
  }

  get isInitiator(): boolean {
    return this.initiator
  }

  get handshakeHash(): Uint8Array {
    return this.symmetric.handshakeHash
  }

  /** Produce the next handshake message for the given payload. */
  writeMessage(payload: Uint8Array): Uint8Array {
    const index = this.messageIndex
    // P1-33: XX has exactly three messages (index 0..2).
    if (index >= HANDSHAKE_MESSAGE_COUNT) {
      throw new Error("Noise: handshake already complete (no further messages)")
    }
    const turn = this.initiator ? index % 2 === 0 : index % 2 === 1
    if (!turn) {
      throw new Error("Noise: not this side's turn to write")
    }
    if (!this.allowPayload && payload.length !== 0) {
      throw new Error("Noise: handshake payloads must be empty for this protocol")
    }
    // P0-6: the largest per-step overhead is 48 (encrypted s) + 16 (tag);
    // keep the emitted message within the Noise 65535-byte limit.
    if (payload.length > MAX_NOISE_PLAINTEXT_BYTES - 64) {
      throw new Error("Noise: handshake payload too large")
    }
    let buffer: Uint8Array
    if (this.initiator) {
      if (index === 0) {
        // -> e
        this.symmetric.mixHash(this.e.publicKey)
        buffer = this.e.publicKey
      } else {
        // -> s, se
        const parts: Uint8Array[] = [this.symmetric.encryptAndHash(this.s.publicKey)]
        this.symmetric.mixKey(x25519Dh(this.s.privateKey, this.re!))
        buffer = concat(...parts)
      }
    } else {
      // <- e, ee, s, es
      this.symmetric.mixHash(this.e.publicKey)
      this.symmetric.mixKey(x25519Dh(this.e.privateKey, this.re!))
      const parts: Uint8Array[] = [
        this.e.publicKey,
        this.symmetric.encryptAndHash(this.s.publicKey),
      ]
      this.symmetric.mixKey(x25519Dh(this.s.privateKey, this.re!))
      buffer = concat(...parts)
    }
    const out = concat(buffer, this.symmetric.encryptAndHash(payload))
    this.messageIndex += 1
    return out
  }

  /** Consume the peer's next handshake message, returning its payload. */
  readMessage(message: Uint8Array): Uint8Array {
    const index = this.messageIndex
    if (index >= HANDSHAKE_MESSAGE_COUNT) {
      throw new Error("Noise: handshake already complete (no further messages)")
    }
    const turn = this.initiator ? index % 2 === 1 : index % 2 === 0
    if (!turn) {
      throw new Error("Noise: not this side's turn to read")
    }
    // P0-6: bound pre-auth allocation. With empty payloads the XX messages
    // have exact sizes: msg1 = 32 (e); msg2 = 32 (e) + 48 (enc s) + 16 (tag);
    // msg3 = 48 (enc s) + 16 (tag). Anything else is rejected before decrypt.
    if (message.length > MAX_NOISE_MESSAGE_BYTES) {
      throw new Error("Noise: handshake message exceeds the 65535-byte message limit")
    }
    const exactLength = HANDSHAKE_EMPTY_PAYLOAD_LENGTHS[index]!
    if (message.length < exactLength) {
      throw new Error(`Noise: handshake message too short (${message.length} < ${exactLength})`)
    }
    if (!this.allowPayload && message.length !== exactLength) {
      throw new Error(
        `Noise: handshake message has unexpected length (${message.length} != ${exactLength})`,
      )
    }
    let offset: number
    if (this.initiator) {
      // <- e, ee, s, es
      this.re = message.subarray(0, 32)
      this.symmetric.mixHash(this.re)
      this.symmetric.mixKey(x25519Dh(this.e.privateKey, this.re))
      const sCiphertext = message.subarray(32, 32 + 48)
      this.rs = this.symmetric.decryptAndHash(sCiphertext)
      this.symmetric.mixKey(x25519Dh(this.e.privateKey, this.rs))
      offset = 32 + 48
    } else if (index === 0) {
      // -> e
      this.re = message.subarray(0, 32)
      this.symmetric.mixHash(this.re)
      offset = 32
    } else {
      // -> s, se : DH(e_responder_priv, s_initiator_pub)
      const sCiphertext = message.subarray(0, 48)
      this.rs = this.symmetric.decryptAndHash(sCiphertext)
      this.symmetric.mixKey(x25519Dh(this.e.privateKey, this.rs))
      offset = 48
    }
    const payload = this.symmetric.decryptAndHash(message.subarray(offset))
    this.messageIndex += 1
    return payload
  }

  get handshakeComplete(): boolean {
    return this.messageIndex >= 3
  }

  /**
   * Split into transport cipher states. Returns [send, receive].
   *
   * Assignment verified against the official Noise test vector for
   * Noise_XX_25519_AESGCM_SHA256: the initiator encrypts transport
   * messages with the SECOND Split output and the responder with the
   * first. (This is the opposite of the common misreading; the vector
   * is authoritative for interop.)
   */
  split(): { send: CipherState; receive: CipherState } {
    if (!this.handshakeComplete) {
      throw new Error("Noise: handshake not complete")
    }
    // P1-33: a second split would hand out identical nonce-0 ciphers.
    if (this.splitDone) {
      throw new Error("Noise: split() may only be called once per handshake")
    }
    this.splitDone = true
    const [c1, c2] = this.symmetric.split()
    return this.initiator ? { send: c2, receive: c1 } : { send: c1, receive: c2 }
  }

  /** The peer's static public key, available after their `s` token. */
  get remoteStatic(): Uint8Array | null {
    return this.rs && Uint8Array.from(this.rs)
  }
}

export type { CipherState }
