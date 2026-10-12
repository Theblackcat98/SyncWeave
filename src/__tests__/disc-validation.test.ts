import { describe, expect, test } from "bun:test"
import { buildAnnouncement, DiscoveryService, parseAnnouncement } from "../services/discovery.js"
import { generateEphemeralIdentity } from "../services/peer-id.js"

// P1-32: announced peerIds must be well-formed, and aliases must not carry
// bidi overrides or zero-width characters into the TUI.

const enc = new TextEncoder()
const VALID_ID = generateEphemeralIdentity().peerId
const SELF = generateEphemeralIdentity().peerId

function datagram(fields: Record<string, unknown>): Uint8Array {
  return enc.encode(JSON.stringify({ v: 1, alias: "bob", peerId: VALID_ID, tcpPort: 24816, ...fields }))
}

describe("P1-32: announced peerId format", () => {
  test("a generated Peer ID is accepted", () => {
    expect(parseAnnouncement(datagram({ peerId: VALID_ID }))?.peerId).toBe(VALID_ID)
  })

  test("the base58btc alphabet boundary is accepted (z + 127 base58 chars = 128)", () => {
    const max = "z" + "A".repeat(127)
    expect(max.length).toBe(128)
    expect(parseAnnouncement(datagram({ peerId: max }))?.peerId).toBe(max)
  })

  test("a 129-character peerId is rejected", () => {
    expect(parseAnnouncement(datagram({ peerId: "z" + "A".repeat(128) }))).toBeNull()
  })

  test("an escape sequence in the peerId is rejected", () => {
    expect(parseAnnouncement(datagram({ peerId: "zABC\u001b[2J\u001b[31m" }))).toBeNull()
  })

  test("non-base58 characters are rejected (0, O, I, l, and punctuation)", () => {
    for (const bad of ["z0OIl", "zABC!!", "zABC DEF", "zABC/def", "zABC\u0000", "zABC​"]) {
      expect(parseAnnouncement(datagram({ peerId: bad }))).toBeNull()
    }
  })

  test("a peerId without the z multibase prefix is rejected", () => {
    expect(parseAnnouncement(datagram({ peerId: "ABCDEFGHJK" }))).toBeNull()
    expect(parseAnnouncement(datagram({ peerId: "ZABCDEFGHJK" }))).toBeNull()
    expect(parseAnnouncement(datagram({ peerId: "12D3KooWABCDEFG" }))).toBeNull()
  })

  test("the manual: namespace is still rejected", () => {
    expect(parseAnnouncement(datagram({ peerId: "manual:1.2.3.4:24816" }))).toBeNull()
  })

  test("a malformed peerId never reaches the peer table", () => {
    const svc = new DiscoveryService()
    ;(svc as unknown as { ownPeerId: string }).ownPeerId = SELF
    svc.handleDatagram(datagram({ peerId: "zABC\u001b[2J" }), "192.168.1.20")
    svc.handleDatagram(datagram({ peerId: "z0OIl!!" }), "192.168.1.20")
    expect(svc.listPeers()).toEqual([])
  })

  test("start() rejects a self peerId with a malformed format before binding", async () => {
    const svc = new DiscoveryService()
    await expect(svc.start({ alias: "ok", peerId: "zABC\u001b[2J", tcpPort: 24816 })).rejects.toThrow("peerId")
    await expect(svc.start({ alias: "ok", peerId: "0OIl", tcpPort: 24816 })).rejects.toThrow("peerId")
    expect(svc.isStarted).toBe(false)
  })

  test("buildAnnouncement output with a valid ID round-trips", () => {
    expect(parseAnnouncement(buildAnnouncement("bob", VALID_ID, 24816))).toEqual({
      v: 1,
      alias: "bob",
      peerId: VALID_ID,
      tcpPort: 24816,
    })
  })
})

describe("P1-32: alias sanitization (Cc and Cf stripped)", () => {
  test("a right-to-left override (U+202E) is removed, so the name cannot be visually spoofed", () => {
    const parsed = parseAnnouncement(datagram({ alias: "‮gnp.exe" }))
    expect(parsed?.alias).toBe("gnp.exe")
  })

  test("zero-width characters are removed", () => {
    expect(parseAnnouncement(datagram({ alias: "ev​il" }))?.alias).toBe("evil")
    expect(parseAnnouncement(datagram({ alias: "a‍b﻿c" }))?.alias).toBe("abc")
  })

  test("bidi isolates (U+2066..U+2069) are removed", () => {
    expect(parseAnnouncement(datagram({ alias: "x⁧y⁩z" }))?.alias).toBe("xyz")
  })

  test("C1 control characters (U+0080..U+009F) are removed", () => {
    expect(parseAnnouncement(datagram({ alias: "a\u0085b\u009Bc" }))?.alias).toBe("abc")
  })

  test("ordinary Unicode in aliases is kept", () => {
    expect(parseAnnouncement(datagram({ alias: "Zoë's laptop" }))?.alias).toBe("Zoë's laptop")
    expect(parseAnnouncement(datagram({ alias: "数据 Ünïcode" }))?.alias).toBe("数据 Ünïcode")
  })

  test("an alias made only of format characters is rejected", () => {
    expect(parseAnnouncement(datagram({ alias: "​‮⁦" }))).toBeNull()
  })

  test("the stored alias is the sanitized one", () => {
    const svc = new DiscoveryService()
    ;(svc as unknown as { ownPeerId: string }).ownPeerId = SELF
    svc.handleDatagram(datagram({ alias: "‮gnp.exe​" }), "192.168.1.20")
    expect(svc.listPeers()[0]?.alias).toBe("gnp.exe")
  })

  test("our own alias is sanitized on start() too, and an alias that sanitizes to nothing is refused", async () => {
    const svc = new DiscoveryService()
    await expect(svc.start({ alias: "​‮", peerId: SELF, tcpPort: 24816 })).rejects.toThrow("alias")
    expect(svc.isStarted).toBe(false)
  })
})
