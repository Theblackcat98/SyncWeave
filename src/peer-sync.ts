import type { MockPeer } from "./domain.js"
import type { DiscoveredPeer } from "./services/discovery.js"

/**
 * Map discovery peers onto the peer-list shape the UI renders (P2-8).
 * Pure: extracted from app.ts's real-mode `syncPeers` closure so the
 * dedup logic is unit-testable without the TUI renderer.
 *
 * listPeers() already includes manual peers (same discovery map), so the
 * full list is mapped and deduped by id — never re-append the previous
 * array, or entries duplicate every sync tick (the bug Nick saw live).
 */
export function syncDiscoveredPeers(discovered: DiscoveredPeer[]): MockPeer[] {
  const seen = new Set<string>()
  return discovered
    .map((d) => ({
      id: d.peerId,
      name: d.alias,
      host: d.address,
      port: d.tcpPort,
      fingerprint: d.peerId,
      // Manual peers were never probed; discovered peers were seen via
      // multicast within the expiry window.
      online: !d.peerId.startsWith("manual:"),
    }))
    .filter((p) => {
      if (seen.has(p.id)) return false
      seen.add(p.id)
      return true
    })
}
