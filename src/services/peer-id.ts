import { generateKeyPairSync, type KeyObject } from "node:crypto"

/**
 * Session-ephemeral peer identity for the Phase 2 direct-transfer profile.
 *
 * Each session generates a fresh Ed25519 identity keypair. The Peer ID is
 * `z` + base58btc(`08 01 12 20 <32-byte Ed25519 key>`): the protobuf
 * encoding of the public key, with no multihash wrapper. It is NOT a libp2p
 * Peer ID: there is no identity-multihash header (`00 24`) and no
 * `12D3KooW` prefix. The encoding is always exactly PEER_ID_LENGTH (50)
 * characters, because the 36-byte input always starts with `08`.
 *
 * The two users exchange and independently verify each other's COMPLETE
 * Peer ID out of band (read on screen, compared character by character).
 * Abbreviated IDs, device labels, and in-band claims do not count. The
 * application compares the expected Peer ID against the identity verified
 * on the exact authenticated Noise connection before any peer/file metadata
 * flows (see transfer-protocol.ts). Identity keys and IDs are memory-only
 * and never persisted.
 */

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  let value = 0n
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte)
  }
  let out = ""
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out
    value /= 58n
  }
  return "1".repeat(zeros) + out
}

/** Protobuf encoding of an Ed25519 public key: field 1 (type=1, varint),
 *  field 2 (data, 32 bytes). */
function protobufMarshalEd25519PublicKey(rawPublicKey: Uint8Array): Uint8Array {
  if (rawPublicKey.length !== 32) {
    throw new Error("Ed25519 public key must be 32 bytes")
  }
  const out = new Uint8Array(36)
  out[0] = 0x08 // field 1, varint
  out[1] = 0x01 // KeyType.Ed25519
  out[2] = 0x12 // field 2, length-delimited
  out[3] = 0x20 // 32 bytes
  out.set(rawPublicKey, 4)
  return out
}

/** Every Peer ID produced by peerIdFromPublicKey has exactly this many characters. */
export const PEER_ID_LENGTH = 50

/** Random characters shown by formatPeerFingerprint (4 groups of 4). */
export const PEER_FINGERPRINT_CHARS = 16

/** Derive the Peer ID string from a raw 32-byte Ed25519 public key. */
export function peerIdFromPublicKey(rawPublicKey: Uint8Array): string {
  return "z" + base58btcEncode(protobufMarshalEd25519PublicKey(rawPublicKey))
}

/**
 * Short display form of a Peer ID for the UI (P1-35). The leading characters
 * of a Peer ID are fixed by the key-type header, so only the trailing
 * characters carry key material: this returns the last
 * PEER_FINGERPRINT_CHARS characters, grouped in 4s (`ABCD-EFGH-IJKL-MNOP`).
 * It is a human aid only; comparisons must use the complete Peer ID.
 */
export function formatPeerFingerprint(peerId: string): string {
  if (!/^z[1-9A-HJ-NP-Za-km-z]{49}$/.test(peerId)) {
    throw new TypeError("formatPeerFingerprint: not a well-formed Peer ID")
  }
  const tail = peerId.slice(-PEER_FINGERPRINT_CHARS)
  const groups: string[] = []
  for (let i = 0; i < tail.length; i += 4) groups.push(tail.slice(i, i + 4))
  return groups.join("-")
}

export interface EphemeralIdentity {
  /** Complete Peer ID string (`z` + 49 base58 characters), for out-of-band display. */
  readonly peerId: string
  /** Raw 32-byte Ed25519 public key. */
  readonly publicKey: Uint8Array
  /** Private key (memory-only; never serialized). */
  readonly privateKey: KeyObject
}

/** Generate a fresh ephemeral identity for one session. */
export function generateEphemeralIdentity(): EphemeralIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const rawPublic = new Uint8Array(
    (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32),
  )
  return {
    peerId: peerIdFromPublicKey(rawPublic),
    publicKey: rawPublic,
    privateKey,
  }
}

/**
 * Verify that an out-of-band-provided Peer ID string is well-formed and
 * matches the expected value, in constant time. Returns true only on exact
 * equality of the complete strings.
 */
export function verifyPeerId(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i)
  }
  return diff === 0 && expected.startsWith("z") && expected.length > 10
}
