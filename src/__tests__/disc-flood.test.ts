import { describe, expect, test } from "bun:test"
import {
  buildAnnouncement,
  type DiscoveredPeer,
  DiscoveryService,
  MAX_NEW_PEERS_PER_SOURCE_WINDOW,
  MAX_PEERS_PER_SOURCE,
  PEER_EXPIRY_MS,
} from "../services/discovery.js"
import { generateEphemeralIdentity } from "../services/peer-id.js"

// P1-28: announcements are unauthenticated, so one LAN host must not be able
// to push a live peer out of the table.

const LIVE_PEER = generateEphemeralIdentity().peerId
const SELF = generateEphemeralIdentity().peerId

function newService(): DiscoveryService {
  const svc = new DiscoveryService()
  ;(svc as unknown as { ownPeerId: string }).ownPeerId = SELF
  return svc
}

function forged(i: number): { datagram: Uint8Array; peerId: string } {
  const peerId = generateEphemeralIdentity().peerId
  return { datagram: buildAnnouncement(`spoof-${i}`, peerId, 1), peerId }
}

/** Test-only: pretend every tracked entry was last seen long ago (expired). */
function ageAllEntries(svc: DiscoveryService): void {
  const peers = (svc as unknown as { peers: Map<string, DiscoveredPeer> }).peers
  for (const p of peers.values()) {
    p.lastSeen -= PEER_EXPIRY_MS + 1000
  }
}

describe("P1-28: flood resistance", () => {
  test("300 forged announcements from one IP do not evict a live peer from another IP", () => {
    const svc = newService()
    svc.handleDatagram(buildAnnouncement("bob-laptop", LIVE_PEER, 24816), "192.168.1.20")
    for (let i = 0; i < 300; i++) {
      const f = forged(i)
      svc.handleDatagram(f.datagram, "192.168.1.66")
    }
    const peers = svc.listPeers()
    expect(peers.some((p) => p.peerId === LIVE_PEER && p.address === "192.168.1.20")).toBe(true)
    // The attacker is bounded by the per-source cap, never the whole table.
    const fromAttacker = peers.filter((p) => p.address === "192.168.1.66").length
    expect(fromAttacker).toBeLessThanOrEqual(MAX_PEERS_PER_SOURCE)
    expect(peers.length).toBeLessThanOrEqual(MAX_PEERS_PER_SOURCE + 1)
  })

  test("one address holds at most MAX_PEERS_PER_SOURCE entries, however many IDs it sends", () => {
    const svc = newService()
    // 50 distinct IDs in one burst: the cap (and the new-ID window) keep it at 4.
    for (let i = 0; i < 50; i++) {
      svc.handleDatagram(forged(i).datagram, "192.168.1.66")
    }
    expect(svc.listPeers().length).toBe(Math.min(MAX_PEERS_PER_SOURCE, MAX_NEW_PEERS_PER_SOURCE_WINDOW))
  })

  test("new peer IDs from one source are rate-limited even after their entries leave the table", () => {
    const svc = newService()
    for (let i = 0; i < MAX_NEW_PEERS_PER_SOURCE_WINDOW; i++) {
      svc.handleDatagram(forged(i).datagram, "192.168.1.66")
    }
    expect(svc.listPeers()).toHaveLength(MAX_NEW_PEERS_PER_SOURCE_WINDOW)
    // Drop the entries without touching the rate window (white-box): the
    // source has used its new-ID budget for this window.
    ;(svc as unknown as { peers: Map<string, DiscoveredPeer> }).peers.clear()
    svc.handleDatagram(forged(99).datagram, "192.168.1.66")
    expect(svc.listPeers()).toEqual([])
    // Another source is unaffected by this source's budget.
    svc.handleDatagram(forged(100).datagram, "192.168.1.67")
    expect(svc.listPeers()).toHaveLength(1)
  })

  test("the concurrent per-source cap holds even when the new-ID rate window is clear", () => {
    const svc = newService()
    for (let i = 0; i < MAX_PEERS_PER_SOURCE; i++) {
      svc.handleDatagram(forged(i).datagram, "192.168.1.66")
    }
    // White-box: forget the rate window, so only the concurrent cap can refuse.
    ;(svc as unknown as { newPeerTimes: Map<string, number[]> }).newPeerTimes.clear()
    svc.handleDatagram(forged(50).datagram, "192.168.1.66")
    expect(svc.listPeers()).toHaveLength(MAX_PEERS_PER_SOURCE)
  })

  test("a known peer re-announcing is never dropped by the flood limits", () => {
    const svc = newService()
    svc.handleDatagram(buildAnnouncement("bob", LIVE_PEER, 24816), "192.168.1.20")
    for (let i = 0; i < 20; i++) {
      svc.handleDatagram(buildAnnouncement("bob", LIVE_PEER, 24816), "192.168.1.20")
    }
    expect(svc.listPeers()).toHaveLength(1)
    expect(svc.listPeers()[0]!.lastSeen).toBeGreaterThan(0)
  })

  test("a known peer cannot be moved onto a source address that is already at its cap", () => {
    const svc = newService()
    svc.handleDatagram(buildAnnouncement("bob", LIVE_PEER, 24816), "192.168.1.20")
    for (let i = 0; i < MAX_PEERS_PER_SOURCE; i++) {
      svc.handleDatagram(forged(i).datagram, "192.168.1.66")
    }
    // The attacker's source is full: moving bob's ID onto it is refused.
    svc.handleDatagram(buildAnnouncement("bob", LIVE_PEER, 24816), "192.168.1.66")
    const bob = svc.listPeers().find((p) => p.peerId === LIVE_PEER)
    expect(bob?.address).toBe("192.168.1.20")
  })

  test("a full table of live entries drops the newcomer and emits nothing for it", () => {
    const svc = newService()
    const events: string[] = []
    ;(svc as unknown as { events: unknown }).events = {
      onPeersChanged: (_p: DiscoveredPeer[], change: { reason: string }) => events.push(change.reason),
    }
    // 256 live entries from 64 sources (4 each): the table is exactly full.
    for (let i = 0; i < 256; i++) {
      svc.handleDatagram(forged(i).datagram, `10.1.${Math.floor(i / 4)}.1`)
    }
    expect(svc.listPeers()).toHaveLength(256)
    const before = events.length
    // A newcomer from a fresh source is refused, not admitted by eviction.
    svc.handleDatagram(forged(999).datagram, "172.16.0.1")
    expect(svc.listPeers()).toHaveLength(256)
    expect(events.length).toBe(before)
  })

  test("entries past their expiry are reclaimed to make room when the table is full", () => {
    const svc = newService()
    for (let i = 0; i < 256; i++) {
      svc.handleDatagram(forged(i).datagram, `10.2.${Math.floor(i / 4)}.1`)
    }
    expect(svc.listPeers()).toHaveLength(256)
    ageAllEntries(svc)
    // Stale entries (not seen within the expiry window) make way for a newcomer.
    svc.handleDatagram(forged(999).datagram, "172.16.0.2")
    expect(svc.listPeers()).toHaveLength(1)
  })

  test("the source rate table cannot grow without bound from spoofed sources", () => {
    const svc = newService()
    const rates = (svc as unknown as { newPeerTimes: Map<string, number[]> }).newPeerTimes
    for (let i = 0; i < 1500; i++) {
      svc.handleDatagram(forged(i).datagram, `203.0.${Math.floor(i / 250)}.${i % 250}`)
    }
    expect(rates.size).toBeLessThanOrEqual(1024)
  })
})
