import type { FavoriteDestination, MockPeer } from "../domain.js"

export interface PeerService {
  discover(): MockPeer[]
  pulse(): MockPeer[]
  favorites(): FavoriteDestination[]
  toggleFavorite(peer: MockPeer): boolean
}

const mockPeers: MockPeer[] = [
  { id: "macbook", name: "MacBook-M3", host: "192.168.1.42", port: 53317, fingerprint: "SHA-256 7B:21:90:AC:4F:18:DE:72", online: true },
  { id: "pixel", name: "Pixel-8", host: "192.168.1.57", port: 53317, fingerprint: "SHA-256 91:0E:55:2C:8A:34:11:EF", online: true },
]

export class MockPeerService implements PeerService {
  private readonly saved = new Map<string, FavoriteDestination>()
  private readonly peers = mockPeers.map((peer) => ({ ...peer }))
  private pulseCount = 0

  discover(): MockPeer[] {
    return this.peers.map((peer) => ({ ...peer }))
  }

  /** Toggle a mock destination's presence at a slow, deterministic heartbeat cadence. */
  pulse(): MockPeer[] {
    this.pulseCount += 1
    if (this.pulseCount % 4 === 0) {
      const intermittent = this.peers.find((peer) => peer.id === "pixel")
      if (intermittent) intermittent.online = !intermittent.online
    }
    return this.discover()
  }

  favorites(): FavoriteDestination[] {
    return [...this.saved.values()].map((favorite) => ({ ...favorite }))
  }

  toggleFavorite(peer: MockPeer): boolean {
    if (this.saved.has(peer.id)) {
      this.saved.delete(peer.id)
      return false
    }
    this.saved.set(peer.id, {
      peerId: peer.id,
      alias: peer.name,
      host: peer.host,
      port: peer.port,
      fingerprint: peer.fingerprint,
      savedAt: Date.now(),
    })
    return true
  }
}
