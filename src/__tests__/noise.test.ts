import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NoiseHandshake, NOISE_PROTOCOL_NAME } from "../services/noise.js"
import { x25519FromPrivate, x25519ScalarMult } from "./helpers/x25519.js"

test("X25519 ladder agrees with node:crypto DH and derives stable public keys", () => {
  // Directly validate the pure-TS Montgomery ladder against the platform
  // Diffie-Hellman: both must produce the same shared secret. This proves
  // the ladder (also used for public-key derivation) is correct.
  const vector = loadVector()
  const crypto = require("node:crypto") as typeof import("node:crypto")
  const toKeyObject = (pub: Uint8Array) =>
    crypto.createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: Buffer.from(pub).toString("base64url") },
      format: "jwk",
    })
  const pairs: Array<[string, string]> = [
    [vector.init_static, vector.resp_static],
    [vector.init_ephemeral, vector.resp_ephemeral],
    [vector.resp_static, vector.init_ephemeral],
  ]
  for (const [privHex, peerPrivHex] of pairs) {
    const a = x25519FromPrivate(hex(privHex))
    const bPub = x25519FromPrivate(hex(peerPrivHex)).publicKey
    // Deterministic public-key derivation.
    expect(hexOf(x25519FromPrivate(hex(privHex)).publicKey)).toBe(hexOf(a.publicKey))
    expect(a.publicKey.length).toBe(32)
    const ladderSecret = hexOf(x25519ScalarMult(hex(privHex), bPub))
    const nodeSecret = Buffer.from(
      crypto.diffieHellman({ privateKey: a.privateKey, publicKey: toKeyObject(bPub) }) as Buffer,
    ).toString("hex")
    expect(ladderSecret).toBe(nodeSecret)
  }
})

interface VectorMessage {
  payload: string
  ciphertext: string
}
interface TestVector {
  protocol_name: string
  init_prologue: string
  init_ephemeral: string
  init_static: string
  resp_prologue: string
  resp_ephemeral: string
  resp_static: string
  messages: VectorMessage[]
}

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "hex"))
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString("hex")

function loadVector(): TestVector {
  const path = join(import.meta.dir, "fixtures", "noise-xx-25519-aesgcm-sha256.json")
  return JSON.parse(readFileSync(path, "utf8")) as TestVector
}

test("Noise_XX_25519_AESGCM_SHA256 matches the official test vector", () => {
  const vector = loadVector()
  expect(vector.protocol_name).toBe(NOISE_PROTOCOL_NAME)

  // The official vector carries 32-byte payloads in every message.
  const init = new NoiseHandshake({
    initiator: true,
    allowHandshakePayload: true,
    prologue: hex(vector.init_prologue),
    staticKey: x25519FromPrivate(hex(vector.init_static)),
    ephemeralKey: x25519FromPrivate(hex(vector.init_ephemeral)),
  })
  const resp = new NoiseHandshake({
    initiator: false,
    allowHandshakePayload: true,
    prologue: hex(vector.resp_prologue),
    staticKey: x25519FromPrivate(hex(vector.resp_static)),
    ephemeralKey: x25519FromPrivate(hex(vector.resp_ephemeral)),
  })

  // Message 1: -> e
  const msg1 = init.writeMessage(hex(vector.messages[0]!.payload))
  expect(hexOf(msg1)).toBe(vector.messages[0]!.ciphertext)
  expect(hexOf(resp.readMessage(msg1))).toBe(vector.messages[0]!.payload)

  // Message 2: <- e, ee, s, es
  const msg2 = resp.writeMessage(hex(vector.messages[1]!.payload))
  expect(hexOf(msg2)).toBe(vector.messages[1]!.ciphertext)
  expect(hexOf(init.readMessage(msg2))).toBe(vector.messages[1]!.payload)

  // Message 3: -> s, se
  const msg3 = init.writeMessage(hex(vector.messages[2]!.payload))
  expect(hexOf(msg3)).toBe(vector.messages[2]!.ciphertext)
  expect(hexOf(resp.readMessage(msg3))).toBe(vector.messages[2]!.payload)

  expect(init.handshakeComplete).toBe(true)
  expect(resp.handshakeComplete).toBe(true)

  // Transport messages: initiator sends with c1, responder with c2.
  const initKeys = init.split()
  const respKeys = resp.split()
  const ad = new Uint8Array(0)

  const t1 = initKeys.send.encryptWithAd(ad, hex(vector.messages[3]!.payload))
  expect(hexOf(t1)).toBe(vector.messages[3]!.ciphertext)
  expect(hexOf(respKeys.receive.decryptWithAd(ad, t1))).toBe(vector.messages[3]!.payload)

  const t2 = respKeys.send.encryptWithAd(ad, hex(vector.messages[4]!.payload))
  expect(hexOf(t2)).toBe(vector.messages[4]!.ciphertext)
  expect(hexOf(initKeys.receive.decryptWithAd(ad, t2))).toBe(vector.messages[4]!.payload)
})

test("handshake tampering is detected: wrong ciphertext fails authentication", () => {
  const init = new NoiseHandshake({ initiator: true })
  const resp = new NoiseHandshake({ initiator: false })
  const msg1 = init.writeMessage(new Uint8Array(0))
  resp.readMessage(msg1)
  const msg2 = resp.writeMessage(new Uint8Array(0))
  msg2[msg2.length - 1] ^= 0xff // flip a bit in the auth tag
  expect(() => init.readMessage(msg2)).toThrow()
})

test("fresh handshakes agree on transport keys in both directions", () => {
  const init = new NoiseHandshake({ initiator: true })
  const resp = new NoiseHandshake({ initiator: false })
  const empty = new Uint8Array(0)
  resp.readMessage(init.writeMessage(empty))
  init.readMessage(resp.writeMessage(empty))
  resp.readMessage(init.writeMessage(empty))

  const initKeys = init.split()
  const respKeys = resp.split()
  const ad = new Uint8Array(0)
  const plaintext = new TextEncoder().encode("hello from initiator")

  const c1 = initKeys.send.encryptWithAd(ad, plaintext)
  expect(respKeys.receive.decryptWithAd(ad, c1)).toEqual(plaintext)

  const reply = new TextEncoder().encode("hello from responder")
  const c2 = respKeys.send.encryptWithAd(ad, reply)
  expect(initKeys.receive.decryptWithAd(ad, c2)).toEqual(reply)

  // Nonces advance: re-encrypting the same plaintext differs.
  const c1b = initKeys.send.encryptWithAd(ad, plaintext)
  expect(Buffer.from(c1b).equals(Buffer.from(c1))).toBe(false)
  expect(respKeys.receive.decryptWithAd(ad, c1b)).toEqual(plaintext)
})

test("remote static key is exposed after the peer's s token", () => {
  const init = new NoiseHandshake({ initiator: true })
  const resp = new NoiseHandshake({ initiator: false })
  expect(init.remoteStatic).toBeNull()
  const empty = new Uint8Array(0)
  resp.readMessage(init.writeMessage(empty))
  init.readMessage(resp.writeMessage(empty))
  expect(init.remoteStatic).not.toBeNull()
  expect(init.remoteStatic!.length).toBe(32)
})

test("v2: handshake messages with impossible lengths are rejected pre-auth", async () => {
  const { MAX_NOISE_MESSAGE_BYTES } = await import("../services/noise.js")
  const a = new NoiseHandshake({ initiator: true })
  const b = new NoiseHandshake({ initiator: false })
  // Responder's first read (-> e) needs at least 32 bytes.
  expect(() => b.readMessage(new Uint8Array(10))).toThrow(/too short/)
  const m1 = a.writeMessage(new Uint8Array(0))
  expect(m1).toHaveLength(32)
  // Initiator's read (<- e, ee, s, es) needs at least 96 bytes (P0-6).
  expect(() => a.readMessage(new Uint8Array(40))).toThrow(/too short/)
  // Oversized messages are rejected before any decryption work.
  expect(() => b.readMessage(new Uint8Array(MAX_NOISE_MESSAGE_BYTES + 1))).toThrow(/exceeds/)
})

test("P0-6: with empty payloads the three handshake messages are exactly 32, 96 and 64 bytes", () => {
  const a = new NoiseHandshake({ initiator: true })
  const b = new NoiseHandshake({ initiator: false })
  const m1 = a.writeMessage(new Uint8Array(0))
  expect(m1).toHaveLength(32)
  // A 65,000-byte first message (the probe case) is not a legal -> e.
  expect(() => b.readMessage(new Uint8Array(65_000))).toThrow(/unexpected length/)
  // Padding a legal message with trailing bytes is rejected too.
  const padded = new Uint8Array(m1.length + 1)
  padded.set(m1)
  expect(() => b.readMessage(padded)).toThrow(/unexpected length/)
  b.readMessage(m1)
  const m2 = b.writeMessage(new Uint8Array(0))
  expect(m2).toHaveLength(96)
  expect(() => a.readMessage(new Uint8Array([...m2, 0]))).toThrow(/unexpected length/)
  a.readMessage(m2)
  const m3 = a.writeMessage(new Uint8Array(0))
  expect(m3).toHaveLength(64)
  // Non-empty payloads cannot be written under the empty-payload policy.
  expect(() => new NoiseHandshake({ initiator: true }).writeMessage(new Uint8Array([1]))).toThrow(/must be empty/)
})

test("P1-33: split() is single-use and the handshake emits no fourth message", () => {
  const a = new NoiseHandshake({ initiator: true })
  const b = new NoiseHandshake({ initiator: false })
  b.readMessage(a.writeMessage(new Uint8Array(0)))
  a.readMessage(b.writeMessage(new Uint8Array(0)))
  b.readMessage(a.writeMessage(new Uint8Array(0)))
  // Fourth message: neither side may write or read one.
  expect(() => b.writeMessage(new Uint8Array(0))).toThrow(/already complete/)
  expect(() => a.writeMessage(new Uint8Array(0))).toThrow(/already complete/)
  expect(() => a.readMessage(new Uint8Array(96))).toThrow(/already complete/)
  a.split()
  // A second split would reuse nonce 0 under the same keys.
  expect(() => a.split()).toThrow(/only be called once/)
})

test("v2: transport plaintext/ciphertext bounded by the Noise message limit", async () => {
  const { MAX_NOISE_MESSAGE_BYTES, MAX_NOISE_PLAINTEXT_BYTES } = await import(
    "../services/noise.js"
  )
  const empty = new Uint8Array(0)
  const a = new NoiseHandshake({ initiator: true })
  const b = new NoiseHandshake({ initiator: false })
  const m1 = a.writeMessage(empty)
  const m2 = b.readMessage(m1)
  void m2
  const m2out = b.writeMessage(empty)
  const m3in = a.readMessage(m2out)
  void m3in
  const m3 = a.writeMessage(empty)
  b.readMessage(m3)
  const ac = a.split()
  const bc = b.split()
  const ad = new Uint8Array(0)
  // A full-size round trip works (do this first: each encrypt consumes a nonce).
  const ct = ac.send.encryptWithAd(ad, new Uint8Array(MAX_NOISE_PLAINTEXT_BYTES))
  expect(ct).toHaveLength(MAX_NOISE_MESSAGE_BYTES)
  const pt = bc.receive.decryptWithAd(ad, ct)
  expect(pt).toHaveLength(MAX_NOISE_PLAINTEXT_BYTES)
  // One byte over the plaintext limit throws instead of emitting.
  expect(() =>
    ac.send.encryptWithAd(ad, new Uint8Array(MAX_NOISE_PLAINTEXT_BYTES + 1)),
  ).toThrow(/exceeds/)
  // Ciphertext over 65535 bytes is rejected before decryption.
  expect(() =>
    bc.receive.decryptWithAd(ad, new Uint8Array(MAX_NOISE_MESSAGE_BYTES + 1)),
  ).toThrow(/exceeds/)
})
