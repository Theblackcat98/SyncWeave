import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto"

/**
 * Test-only X25519 helpers. Production code never derives keys from raw
 * scalars: `x25519Generate` returns node:crypto KeyObjects. The BigInt
 * Montgomery ladder lives here so the official Noise vectors can be
 * replayed with fixed keys, and so the ladder can be cross-checked against
 * node:crypto Diffie-Hellman.
 */

export interface TestX25519Keypair {
  privateKey: KeyObject
  publicKey: Uint8Array
}

/** PKCS#8 DER prefix for an X25519 private key (RFC 8410), then the 32-byte scalar. */
const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex")

/** Derive the X25519 keypair for a raw 32-byte private scalar, via node:crypto. */
export function x25519FromPrivate(privateBytes: Uint8Array): TestX25519Keypair {
  if (privateBytes.length !== 32) {
    throw new Error("X25519 private key must be 32 bytes")
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, Buffer.from(privateBytes)]),
    format: "der",
    type: "pkcs8",
  })
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer
  return { privateKey, publicKey: new Uint8Array(spki.subarray(-32)) }
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

/** RFC 7748 X25519 Montgomery ladder (x-coordinate). Test cross-check only. */
export function x25519ScalarMult(scalarBytes: Uint8Array, uBytes: Uint8Array): Uint8Array {
  const clamped = Uint8Array.from(scalarBytes)
  clamped[0]! &= 248
  clamped[31]! &= 127
  clamped[31]! |= 64
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
