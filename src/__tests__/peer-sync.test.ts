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

describe("P0-1 (D1): discovery aliases are claims, not identities", () => {
  test("network-discovered aliases are marked claimed; manual aliases are not", () => {
    const net = discovered({ alias: "nick-laptop" })
    const manual = discovered({ peerId: "manual:office", alias: "office", address: "10.0.0.5" })
    const [a, b] = syncDiscoveredPeers([net, manual])
    expect(a).toMatchObject({ id: net.peerId, aliasClaimed: true })
    expect(b).toMatchObject({ id: "manual:office", aliasClaimed: false })
  })

  test("the fingerprint is the discovery peerId, a display hint only", () => {
    const net = discovered()
    const [p] = syncDiscoveredPeers([net])
    expect(p!.fingerprint).toBe(net.peerId)
  })

  test("peers sharing an alias are both flagged as duplicates", () => {
    const a = discovered({ alias: "laptop" })
    const b = discovered({ alias: "laptop" })
    const c = discovered({ alias: "desktop" })
    const peers = syncDiscoveredPeers([a, b, c])
    expect(peers.find((p) => p.id === a.peerId)?.aliasDuplicate).toBe(true)
    expect(peers.find((p) => p.id === b.peerId)?.aliasDuplicate).toBe(true)
    expect(peers.find((p) => p.id === c.peerId)?.aliasDuplicate).toBe(false)
  })

  test("alias collisions are detected case-insensitively and ignore surrounding spaces", () => {
    const a = discovered({ alias: "Laptop" })
    const b = discovered({ alias: " laptop " })
    const peers = syncDiscoveredPeers([a, b])
    expect(peers.every((p) => p.aliasDuplicate === true)).toBe(true)
  })

  test("a manual peer's alias that collides with a network alias is also flagged", () => {
    const net = discovered({ alias: "office" })
    const manual = discovered({ peerId: "manual:office", alias: "office", address: "10.0.0.5" })
    const peers = syncDiscoveredPeers([net, manual])
    expect(peers.every((p) => p.aliasDuplicate === true)).toBe(true)
  })

  test("a unique alias is not flagged", () => {
    const peers = syncDiscoveredPeers([discovered({ alias: "one" }), discovered({ alias: "two" })])
    expect(peers.every((p) => p.aliasDuplicate === false)).toBe(true)
  })

  test("changedAt is carried over from the discovery entry; absent when never changed", () => {
    const changed = discovered({ changedAt: 1234 })
    const fresh = discovered()
    const [a, b] = syncDiscoveredPeers([changed, fresh])
    expect(a!.changedAt).toBe(1234)
    expect(b!.changedAt).toBeUndefined()
  })
})
