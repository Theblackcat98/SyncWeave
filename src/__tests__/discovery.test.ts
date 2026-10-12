import { describe, expect, test } from "bun:test"
import {
  ANNOUNCE_INTERVAL_MS,
  buildAnnouncement,
  DISCOVERY_MULTICAST_GROUP,
  DISCOVERY_PORT,
  DISCOVERY_PROTOCOL_VERSION,
  type DiscoveredPeer,
  DiscoveryService,
  parseAnnouncement,
  PEER_EXPIRY_MS,
} from "../services/discovery.js"
import { generateEphemeralIdentity } from "../services/peer-id.js"

const enc = new TextEncoder()
// Real ephemeral Peer IDs (fresh per call, never persisted).
const PEER_A = generateEphemeralIdentity().peerId
const PEER_B = generateEphemeralIdentity().peerId
const PEER_SELF = generateEphemeralIdentity().peerId

function validDatagram(overrides: Record<string, unknown> = {}): Uint8Array {
  return enc.encode(
    JSON.stringify({ v: 1, alias: "nick-laptop", peerId: PEER_B, tcpPort: 24816, ...overrides }),
  )
}

/** Inject the service's own Peer ID without binding a socket (test seam). */
function withSelf(svc: DiscoveryService, peerId: string = PEER_SELF): DiscoveryService {
  ;(svc as unknown as { ownPeerId: string }).ownPeerId = peerId
  return svc
}

describe("ephemeral Peer IDs as discovery identity", () => {
  test("peer IDs are fresh per generation (unlinkable across restarts)", () => {
    expect(PEER_A).not.toBe(PEER_B)
    expect(PEER_A.length).toBeGreaterThan(0)
    expect(PEER_A.length).toBeLessThanOrEqual(128)
  })
})

describe("buildAnnouncement", () => {
  test("exact wire format is small versioned JSON with peerId", () => {
    const bytes = buildAnnouncement("nick-laptop", PEER_A, 24816)
    expect(bytes.length).toBeLessThan(512)
    const parsed = JSON.parse(new TextDecoder().decode(bytes))
    expect(parsed).toEqual({ v: 1, alias: "nick-laptop", peerId: PEER_A, tcpPort: 24816 })
    expect(DISCOVERY_PROTOCOL_VERSION).toBe(1)
    expect(DISCOVERY_PORT).toBe(24817)
    expect(DISCOVERY_MULTICAST_GROUP).toBe("224.0.0.167")
  })
})

describe("parseAnnouncement (fail closed)", () => {
  test("accepts a well-formed announcement", () => {
    expect(parseAnnouncement(validDatagram())).toEqual({
      v: 1,
      alias: "nick-laptop",
      peerId: PEER_B,
      tcpPort: 24816,
    })
  })

  test("ignores extra fields (forward compatible)", () => {
    expect(parseAnnouncement(validDatagram({ extra: "field" }))?.alias).toBe("nick-laptop")
  })

  test("rejects malformed JSON, empty, and oversized datagrams", () => {
    expect(parseAnnouncement(enc.encode("{not json"))).toBeNull()
    expect(parseAnnouncement(new Uint8Array(0))).toBeNull()
    expect(parseAnnouncement(new Uint8Array(513))).toBeNull()
    expect(parseAnnouncement(enc.encode("[]"))).toBeNull()
    expect(parseAnnouncement(enc.encode('"str"'))).toBeNull()
    expect(parseAnnouncement(enc.encode("42"))).toBeNull()
  })

  test("rejects wrong protocol version", () => {
    expect(parseAnnouncement(validDatagram({ v: 2 }))).toBeNull()
    expect(parseAnnouncement(validDatagram({ v: "1" }))).toBeNull()
  })

  test("rejects bad alias", () => {
    expect(parseAnnouncement(validDatagram({ alias: "" }))).toBeNull()
    expect(parseAnnouncement(validDatagram({ alias: "x".repeat(65) }))).toBeNull()
    expect(parseAnnouncement(validDatagram({ alias: 42 }))).toBeNull()
    const missing = JSON.parse(new TextDecoder().decode(validDatagram())) as Record<string, unknown>
    delete missing["alias"]
    expect(parseAnnouncement(enc.encode(JSON.stringify(missing)))).toBeNull()
  })

  test("rejects bad peerId", () => {
    expect(parseAnnouncement(validDatagram({ peerId: "" }))).toBeNull()
    expect(parseAnnouncement(validDatagram({ peerId: "x".repeat(129) }))).toBeNull()
    expect(parseAnnouncement(validDatagram({ peerId: 123 }))).toBeNull()
    const missing = JSON.parse(new TextDecoder().decode(validDatagram())) as Record<string, unknown>
    delete missing["peerId"]
    expect(parseAnnouncement(enc.encode(JSON.stringify(missing)))).toBeNull()
  })

  test("rejects bad tcpPort", () => {
    expect(parseAnnouncement(validDatagram({ tcpPort: 0 }))).toBeNull()
    expect(parseAnnouncement(validDatagram({ tcpPort: 70000 }))).toBeNull()
    expect(parseAnnouncement(validDatagram({ tcpPort: 24816.5 }))).toBeNull()
    expect(parseAnnouncement(validDatagram({ tcpPort: "24816" }))).toBeNull()
  })

  test("rejects the legacy id/port field names", () => {
    const legacy = { v: 1, alias: "x", id: "a".repeat(32), port: 24816 }
    expect(parseAnnouncement(enc.encode(JSON.stringify(legacy)))).toBeNull()
  })
})

describe("DiscoveryService validation", () => {
  test("start rejects bad alias, peerId, and port before binding", async () => {
    const svc = new DiscoveryService()
    await expect(svc.start({ alias: "", peerId: PEER_SELF, tcpPort: 24816 })).rejects.toThrow()
    await expect(
      svc.start({ alias: "x".repeat(65), peerId: PEER_SELF, tcpPort: 24816 }),
    ).rejects.toThrow()
    await expect(svc.start({ alias: "ok", peerId: "", tcpPort: 24816 })).rejects.toThrow()
    await expect(svc.start({ alias: "ok", peerId: PEER_SELF, tcpPort: 0 })).rejects.toThrow()
    await expect(svc.start({ alias: "ok", peerId: PEER_SELF, tcpPort: 70000 })).rejects.toThrow()
    expect(svc.isStarted).toBe(false)
  })

  test("start records the app-provided peerId", async () => {
    const svc = new DiscoveryService()
    await svc.start({ alias: "t", peerId: PEER_SELF, tcpPort: 24816, discoveryPort: 24971 })
    expect(svc.peerId).toBe(PEER_SELF)
    svc.stop()
  })

  test("start twice throws", async () => {
    const svc = new DiscoveryService()
    await svc.start({ alias: "t", peerId: PEER_SELF, tcpPort: 24816, discoveryPort: 24972 })
    await expect(
      svc.start({ alias: "t", peerId: PEER_SELF, tcpPort: 24816, discoveryPort: 24973 }),
    ).rejects.toThrow("already started")
    svc.stop()
  })
})

describe("DiscoveryService peer tracking (via handleDatagram seam)", () => {
  test("ignores our own announcements (by peerId)", () => {
    const svc = withSelf(new DiscoveryService())
    svc.handleDatagram(buildAnnouncement("me", PEER_SELF, 24816), "127.0.0.1")
    expect(svc.listPeers()).toEqual([])
  })

  test("adds a peer keyed by peerId and reports address + tcpPort", () => {
    const svc = withSelf(new DiscoveryService())
    let changed: DiscoveredPeer[] = []
    ;(svc as unknown as { events: unknown }).events = {
      onPeersChanged: (p: DiscoveredPeer[]) => (changed = p),
    }
    svc.handleDatagram(validDatagram(), "192.168.1.20")
    const peers = svc.listPeers()
    expect(peers).toHaveLength(1)
    expect(peers[0]).toMatchObject({
      peerId: PEER_B,
      alias: "nick-laptop",
      address: "192.168.1.20",
      tcpPort: 24816,
    })
    expect(typeof peers[0].lastSeen).toBe("number")
    expect(changed).toHaveLength(1)
  })

  test("two different peerIds are two peers; re-announcement updates without duplicating", () => {
    const svc = withSelf(new DiscoveryService())
    let emissions = 0
    ;(svc as unknown as { events: unknown }).events = {
      onPeersChanged: (_p: DiscoveredPeer[]) => emissions++,
    }
    svc.handleDatagram(validDatagram(), "192.168.1.20")
    svc.handleDatagram(validDatagram({ peerId: PEER_A, alias: "other" }), "192.168.1.21")
    expect(svc.listPeers()).toHaveLength(2)
    svc.handleDatagram(validDatagram({ alias: "renamed" }), "192.168.1.20")
    const peers = svc.listPeers()
    expect(peers).toHaveLength(2)
    expect(peers.find((p) => p.peerId === PEER_B)?.alias).toBe("renamed")
    // One emission per new peer, plus one when an existing peer's
    // address/alias changes (surfaces spoofed re-announcements).
    expect(emissions).toBe(3)
  })

  test("ignores malformed datagrams", () => {
    const svc = withSelf(new DiscoveryService())
    svc.handleDatagram(enc.encode("{nope"), "192.168.1.20")
    svc.handleDatagram(validDatagram({ v: 2 }), "192.168.1.20")
    expect(svc.listPeers()).toEqual([])
  })

  test("rejects announcements claiming the reserved manual: namespace", () => {
    const svc = withSelf(new DiscoveryService())
    // A network announcement must not hijack the local manual-peer
    // namespace (never expires, TOFU on send).
    expect(parseAnnouncement(validDatagram({ peerId: "manual:1.2.3.4:24816" }))).toBeNull()
    svc.handleDatagram(validDatagram({ peerId: "manual:1.2.3.4:24816" }), "192.168.1.99")
    expect(svc.listPeers()).toEqual([])
  })

  test("strips control characters from aliases (terminal escape injection)", () => {
    const parsed = parseAnnouncement(validDatagram({ alias: "evil\x1b]0;pwned\x07\n" }))
    expect(parsed).not.toBeNull()
    expect(parsed!.alias).toBe("evil]0;pwned")
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(parsed!.alias)).toBe(false)
  })

  test("alias of only control characters is rejected", () => {
    expect(parseAnnouncement(validDatagram({ alias: "\x1b\x07" }))).toBeNull()
  })

  test("addManualPeer validates its fields", () => {
    const svc = withSelf(new DiscoveryService())
    const good: DiscoveredPeer = { peerId: "manual:1.2.3.4:24816", alias: "1.2.3.4:24816", address: "1.2.3.4", tcpPort: 24816, lastSeen: Date.now() }
    svc.addManualPeer(good)
    expect(svc.listPeers()).toHaveLength(1)
    expect(() => svc.addManualPeer({ ...good, peerId: "" })).toThrow()
    expect(() => svc.addManualPeer({ ...good, tcpPort: 99999 })).toThrow()
    expect(() => svc.addManualPeer({ ...good, alias: "" })).toThrow()
  })

  test("expires peers after 15s of silence", () => {
    const svc = withSelf(new DiscoveryService())
    const seen: number[][] = []
    ;(svc as unknown as { events: unknown }).events = {
      onPeersChanged: (p: DiscoveredPeer[]) => seen.push(p.map((_x) => 1)),
    }
    svc.handleDatagram(validDatagram(), "192.168.1.20")
    expect(svc.listPeers()).toHaveLength(1)
    // Still fresh just before the deadline.
    svc.sweepExpired(Date.now() + PEER_EXPIRY_MS - 1000)
    expect(svc.listPeers()).toHaveLength(1)
    // Gone after the deadline, with a change emission.
    svc.sweepExpired(Date.now() + PEER_EXPIRY_MS + 1)
    expect(svc.listPeers()).toEqual([])
    expect(seen.at(-1)).toEqual([])
    expect(PEER_EXPIRY_MS).toBe(15000)
    expect(ANNOUNCE_INTERVAL_MS).toBe(5000)
  })

  test("stop clears peers and timers", async () => {
    const svc = new DiscoveryService()
    await svc.start({ alias: "t", peerId: PEER_SELF, tcpPort: 24816, discoveryPort: 24974 })
    svc.handleDatagram(validDatagram(), "192.168.1.20")
    expect(svc.listPeers()).toHaveLength(1)
    svc.stop()
    expect(svc.isStarted).toBe(false)
    expect(svc.listPeers()).toEqual([])
  })
})

describe("live multicast announce/listen (best effort)", () => {
  test("a listener sees a raw announcement, or the environment skips", async () => {
    const svc = new DiscoveryService()
    const errors: string[] = []
    let started = false
    try {
      await svc.start({
        alias: "listener",
        peerId: PEER_SELF,
        tcpPort: 24816,
        discoveryPort: 24981,
        events: { onError: (e) => errors.push(e.message) },
      })
      started = true
    } catch (e) {
      console.log(`SKIP live discovery: cannot bind (${(e as Error).message})`)
      return
    }
    try {
      // Send one announcement from an ephemeral socket straight at the group.
      const sender = await Bun.udpSocket({ port: 0 })
      let sent = false
      try {
        sender.send(buildAnnouncement("sender", PEER_B, 24816), 24981, DISCOVERY_MULTICAST_GROUP)
        sent = true
      } catch (e) {
        console.log(`SKIP live discovery: multicast send blocked (${(e as Error).message})`)
      } finally {
        sender.close()
      }
      if (!sent) return
      const deadline = Date.now() + 2500
      while (Date.now() < deadline && svc.listPeers().length === 0) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (svc.listPeers().length === 0) {
        console.log("SKIP live discovery: no multicast delivery in this environment")
        return
      }
      expect(svc.listPeers()[0]).toMatchObject({ peerId: PEER_B, alias: "sender", tcpPort: 24816 })
    } finally {
      if (started) svc.stop()
    }
    expect(errors.join(" ")).not.toMatch(/crash/i)
  }, 10000)
})

describe("P2-9: 256-peer eviction and onPeersChanged change-semantics", () => {
  function freshPeerIds(n: number): string[] {
    return Array.from({ length: n }, () => generateEphemeralIdentity().peerId)
  }

  test("oldest non-manual entries are evicted first past 256", () => {
    const svc = withSelf(new DiscoveryService())
    const ids = freshPeerIds(260)
    // Stagger lastSeen so eviction order is deterministic: feed in order,
    // then wait a tick between batches so timestamps differ.
    for (let i = 0; i < 260; i++) {
      svc.handleDatagram(
        buildAnnouncement(`peer-${i}`, ids[i]!, 24816),
        `192.168.1.${(i % 250) + 1}`,
      )
    }
    const peers = svc.listPeers()
    expect(peers).toHaveLength(256)
    const idsNow = new Set(peers.map((p) => p.peerId))
    // The first four (oldest) were evicted; the rest survived.
    for (let i = 0; i < 4; i++) expect(idsNow.has(ids[i]!)).toBe(false)
    for (let i = 4; i < 260; i++) expect(idsNow.has(ids[i]!)).toBe(true)
  })

  test("manual peers are never evicted by the cap", () => {
    const svc = withSelf(new DiscoveryService())
    svc.addManualPeer({ alias: "office", peerId: "manual:office", address: "10.0.0.5", tcpPort: 24816, lastSeen: Date.now() })
    const ids = freshPeerIds(260)
    for (let i = 0; i < 260; i++) {
      svc.handleDatagram(buildAnnouncement(`peer-${i}`, ids[i]!, 24816), "192.168.1.1")
    }
    const peers = svc.listPeers()
    expect(peers.some((p) => p.peerId === "manual:office")).toBe(true)
    // Manual peer occupies one slot; 255 discovered + 1 manual.
    expect(peers).toHaveLength(256)
  })

  test("onPeersChanged fires on add, on change, and never on identical re-announce", () => {
    const svc = withSelf(new DiscoveryService())
    let emissions = 0
    ;(svc as unknown as { events: unknown }).events = {
      onPeersChanged: (_p: DiscoveredPeer[]) => emissions++,
    }
    const id = generateEphemeralIdentity().peerId
    svc.handleDatagram(buildAnnouncement("nick-laptop", id, 24816), "192.168.1.20")
    expect(emissions).toBe(1)
    // Identical re-announcement: no emission (change-semantics hold).
    svc.handleDatagram(buildAnnouncement("nick-laptop", id, 24816), "192.168.1.20")
    expect(emissions).toBe(1)
    // Alias change: emission (surfaces spoofed re-announcements).
    svc.handleDatagram(buildAnnouncement("renamed", id, 24816), "192.168.1.20")
    expect(emissions).toBe(2)
    // Address change: emission.
    svc.handleDatagram(buildAnnouncement("renamed", id, 24816), "192.168.1.99")
    expect(emissions).toBe(3)
    expect(svc.listPeers()).toHaveLength(1)
  })
})
