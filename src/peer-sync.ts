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
 *
 * D1: the discovery peerId is a display hint only. It is never an identity
 * claim, and aliases from the network are marked as claimed. Peers that
 * share an alias are both flagged so the UI can warn about the collision.
 */
export function syncDiscoveredPeers(discovered: DiscoveredPeer[]): MockPeer[] {
  const seen = new Set<string>()
  const unique = discovered.filter((d) => {
    if (seen.has(d.peerId)) return false
    seen.add(d.peerId)
    return true
  })
  const aliasKey = (alias: string): string => alias.trim().toLowerCase()
  const aliasCounts = new Map<string, number>()
  for (const d of unique) {
    aliasCounts.set(aliasKey(d.alias), (aliasCounts.get(aliasKey(d.alias)) ?? 0) + 1)
  }
  return unique.map((d) => {
    const manual = d.peerId.startsWith("manual:")
    return {
      id: d.peerId,
      name: d.alias,
      host: d.address,
      port: d.tcpPort,
      fingerprint: d.peerId,
      // Manual peers were never probed; discovered peers were seen via
      // multicast within the expiry window.
      online: !manual,
      // Manual aliases are typed locally; network aliases are claims.
      aliasClaimed: !manual,
      aliasDuplicate: (aliasCounts.get(aliasKey(d.alias)) ?? 0) > 1,
      changedAt: d.changedAt,
    }
  })
}
