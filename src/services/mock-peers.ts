import type { Peer, PeerService } from "../types"

const mockPeers: Peer[] = [
  { id: "macbook-m3", name: "MacBook-M3", online: true },
  { id: "termux-pixel", name: "Pixel-Termux", online: true },
]

export function createMockPeers(): PeerService {
  return {
    peers(): readonly Peer[] {
      return mockPeers
    },
    onlineCount(): number {
      return mockPeers.filter((peer) => peer.online).length
    },
  }
}
