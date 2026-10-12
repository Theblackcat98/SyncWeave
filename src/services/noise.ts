import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
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

const P25519 = (1n << 255n) - 19n
const A24 = 121665n // (486662 - 2) / 4, per RFC 7748 §5

function modMul(a: bigint, b: bigint): bigint {
  return (a * b) % P25519
}

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n
  let b = ((base % P25519) + P25519) % P25519
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = modMul(result, b)
    b = modMul(b, b)
    e >>= 1n
  }
  return result
}

/**
 * X25519 scalar multiplication (RFC 7748 Montgomery ladder), x-coordinate
 * only. Used to derive a public key from a raw private key on runtimes whose
 * key import is too strict for private-only JWKs, and exported for tests.
 * The actual session Diffie-Hellman still uses node:crypto.
 */
export function x25519ScalarMult(scalarBytes: Uint8Array, uBytes: Uint8Array): Uint8Array {
  const clamped = Uint8Array.from(scalarBytes)
  clamped[0] &= 248
  clamped[31] &= 127
  clamped[31] |= 64
  let scalar = 0n
  for (let i = 31; i >= 0; i--) {
    scalar = (scalar << 8n) | BigInt(clamped[i]!)
  }
  let u = 0n
  for (let i = 31; i >= 0; i--) {
    u = (u << 8n) | BigInt(uBytes[i]!)
  }
  u %= P25519

  const x1 = u
  let x2 = 1n, z2 = 0n, x3 = u, z3 = 1n
  // RFC 7748 §5 Montgomery ladder. The accumulating `swap` state is load-
  // bearing: `swap ^= k_t` then conditional-swap, then `swap = k_t`.
  let swap = 0n
  for (let t = 254; t >= 0; t--) {
    const kt = (scalar >> BigInt(t)) & 1n
    swap ^= kt
    if (swap === 1n) {
      ;[x2, x3] = [x3, x2]
      ;[z2, z3] = [z3, z2]
    }
    swap = kt
    const a = (x2 + z2) % P25519
    const aa = modMul(a, a)
    const b = (x2 - z2 + P25519) % P25519
    const bb = modMul(b, b)
    const e = (aa - bb + P25519) % P25519
    const c = (x3 + z3) % P25519
    const d = (x3 - z3 + P25519) % P25519
    const da = modMul(d, a)
    const cb = modMul(c, b)
    const sum = (da + cb) % P25519
    const diff = (da - cb + P25519) % P25519
    x3 = modMul(sum, sum)
    z3 = modMul(x1, modMul(diff, diff))
    x2 = modMul(aa, bb)
    z2 = modMul(e, (aa + A24 * e) % P25519)
  }
  // Final conditional swap, per RFC 7748 §5.
  if (swap === 1n) {
    ;[x2, x3] = [x3, x2]
    ;[z2, z3] = [z3, z2]
  }
  const result = modMul(x2, modPow(z2, P25519 - 2n))
  const out = new Uint8Array(32)
  let r = result
  for (let i = 0; i < 32; i++) {
    out[i] = Number(r & 0xffn)
    r >>= 8n
  }
  return out
}

/** Derive an X25519 keypair from a raw 32-byte private key. */
export function x25519FromPrivate(privateBytes: Uint8Array): X25519Keypair {
  if (privateBytes.length !== 32) {
    throw new Error("X25519 private key must be 32 bytes")
  }
  const publicKey = x25519ScalarMult(privateBytes, (() => { const b = new Uint8Array(32); b[0] = 9; return b })())
  const privateKey = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "X25519",
      x: Buffer.from(publicKey).toString("base64url"),
      d: Buffer.from(privateBytes).toString("base64url"),
    },
    format: "jwk",
  })
  return { privateKey, publicKey }
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

  get hasKey(): boolean {
    return this.k !== null
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.k === null) {
      return Uint8Array.from(plaintext)
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

  mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
    const [ck, tempH, tempK] = hkdf(this.ck, inputKeyMaterial, 3)
    this.ck = ck!
    this.mixHash(tempH!)
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

  constructor(options: NoiseHandshakeOptions) {
    this.initiator = options.initiator
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
    const turn = this.initiator ? index % 2 === 0 : index % 2 === 1
    if (!turn) {
      throw new Error("Noise: not this side's turn to write")
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
    const turn = this.initiator ? index % 2 === 1 : index % 2 === 0
    if (!turn) {
      throw new Error("Noise: not this side's turn to read")
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
    const [c1, c2] = this.symmetric.split()
    return this.initiator ? { send: c2, receive: c1 } : { send: c1, receive: c2 }
  }

  /** The peer's static public key, available after their `s` token. */
  get remoteStatic(): Uint8Array | null {
    return this.rs && Uint8Array.from(this.rs)
  }
}

export type { CipherState }
