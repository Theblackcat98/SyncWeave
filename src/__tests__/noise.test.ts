import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  NoiseHandshake,
  NOISE_PROTOCOL_NAME,
  x25519FromPrivate,
  x25519ScalarMult,
} from "../services/noise.js"

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

  const init = new NoiseHandshake({
    initiator: true,
    prologue: hex(vector.init_prologue),
    staticKey: x25519FromPrivate(hex(vector.init_static)),
    ephemeralKey: x25519FromPrivate(hex(vector.init_ephemeral)),
  })
  const resp = new NoiseHandshake({
    initiator: false,
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
