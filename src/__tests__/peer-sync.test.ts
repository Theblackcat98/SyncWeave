import { describe, expect, test } from "bun:test"
import { syncDiscoveredPeers } from "../peer-sync.js"
import type { DiscoveredPeer } from "../services/discovery.js"
import { generateEphemeralIdentity } from "../services/peer-id.js"

function discovered(overrides: Partial<DiscoveredPeer> = {}): DiscoveredPeer {
  return {
    peerId: generateEphemeralIdentity().peerId,
    alias: "laptop",
    address: "192.168.1.20",
    tcpPort: 24816,
    lastSeen: Date.now(),
    ...overrides,
  }
}

describe("P2-8: syncDiscoveredPeers dedup regression", () => {
  test("duplicate peerIds in one sync collapse to a single entry", () => {
    const dup = discovered()
    const peers = syncDiscoveredPeers([dup, dup, dup])
    expect(peers).toHaveLength(1)
    expect(peers[0]!.id).toBe(dup.peerId)
  })

  test("repeated syncs with the same list never accumulate duplicates", () => {
    const list = [discovered(), discovered()]
    let peers = syncDiscoveredPeers(list)
    expect(peers).toHaveLength(2)
    // Simulate the 2s sync tick feeding the same discovery list again.
    peers = syncDiscoveredPeers(list)
    peers = syncDiscoveredPeers(list)
    expect(peers).toHaveLength(2)
  })

  test("maps fields onto the UI peer shape; manual peers are not probed", () => {
    const net = discovered({ alias: "nick-laptop", address: "192.168.1.20" })
    const manual = discovered({ peerId: "manual:office", alias: "office", address: "10.0.0.5" })
    const peers = syncDiscoveredPeers([net, manual])
    expect(peers[0]).toMatchObject({
      id: net.peerId,
      name: "nick-laptop",
      host: "192.168.1.20",
      port: 24816,
      fingerprint: net.peerId,
      online: true,
    })
    expect(peers[1]).toMatchObject({ id: "manual:office", online: false })
  })

  test("empty discovery list yields an empty peer list", () => {
    expect(syncDiscoveredPeers([])).toEqual([])
  })
})
