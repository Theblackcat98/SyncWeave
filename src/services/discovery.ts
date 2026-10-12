/**
 * UDP-multicast peer discovery for SyncWeave (LocalSend-style).
 *
 * - Announcements go to multicast group 224.0.0.167 (same group as
 *   LocalSend) on SyncWeave's own discovery port 24817, so we never
 *   collide with real LocalSend traffic (its discovery port differs).
 * - The announcement carries only the minimum fields needed to locate a
 *   candidate session: protocol version, a user-chosen alias, the app's
 *   ephemeral Peer ID, and the TCP port the Noise listener is on.
 * - The `peerId` is the app's session-ephemeral Ed25519 Peer ID
 *   (see peer-id.ts `generateEphemeralIdentity`): generated fresh at app
 *   startup, never persisted. It is therefore random, session-scoped, and
 *   unlinkable across restarts, satisfying the decisions.md privacy
 *   constraint. It doubles as the peer-list dedup key.
 * - Discovery never authorizes anything: picking a discovered peer only
 *   fills in the dial address. Gate B (out-of-band Peer ID comparison on
 *   the exact Noise connection) still happens before any metadata flows.
 * - Announcements are unauthenticated. The table is therefore bounded per
 *   source address and new IDs are rate-limited, and a live entry is never
 *   evicted to make room for a newcomer (see handleDatagram).
 */

/** Multicast group for announcements (shared with LocalSend). */
export const DISCOVERY_MULTICAST_GROUP = "224.0.0.167"
/** SyncWeave's discovery port (transport default is 24816). */
export const DISCOVERY_PORT = 24817
/** Protocol version in the announcement payload. */
export const DISCOVERY_PROTOCOL_VERSION = 1
/** How often we announce our presence. */
export const ANNOUNCE_INTERVAL_MS = 5000
/** A peer is dropped after this long without an announcement. */
export const PEER_EXPIRY_MS = 15000
/** Reject announcement datagrams larger than this. */
const MAX_ANNOUNCE_BYTES = 512
/** Alias length bounds (characters). */
const MAX_ALIAS_CHARS = 64
/** Peer ID length bound (characters). */
const MAX_PEER_ID_CHARS = 128
/** Upper bound on tracked peers. A newcomer is dropped, not a live entry evicted, when full. */
const MAX_DISCOVERED_PEERS = 256
/** Flood cap: maximum tracked (non-manual) peers announced from one source address. */
export const MAX_PEERS_PER_SOURCE = 4
/** Rate limit: maximum NEW peer IDs accepted from one source address per PEER_EXPIRY_MS window. */
export const MAX_NEW_PEERS_PER_SOURCE_WINDOW = 4
/** Bound on source addresses tracked by the rate limiter (spoofed sources must not grow it without limit). */
const MAX_RATE_LIMITED_SOURCES = 1024
/** Peer IDs are "z" + base58btc (no 0, O, I or l). */
const PEER_ID_PATTERN = /^z[1-9A-HJ-NP-Za-km-z]+$/
/** Control (C0, DEL, C1) and format (bidi overrides, zero-width) characters. */
const ALIAS_STRIP_PATTERN = /[\p{Cc}\p{Cf}]/gu

export interface Announcement {
  v: 1
  alias: string
  /** The announcer's ephemeral Peer ID (see peer-id.ts). Dedup key. */
  peerId: string
  /** TCP port of the Noise listener. */
  tcpPort: number
}

export interface DiscoveredPeer {
  /** The announcer's ephemeral Peer ID. */
  peerId: string
  alias: string
  /** Sender IP the announcement arrived from (numeric). */
  address: string
  tcpPort: number
  /** performance.now() (monotonic) of the last announcement from this peer. */
  lastSeen: number
  /** performance.now() of the last alias, address or port change for this peerId. Unset until the first change. */
  changedAt?: number
}

export type DiscoveryChangeReason = "added" | "updated" | "expired" | "cleared"

/** Why onPeersChanged fired. */
export interface DiscoveryChange {
  reason: DiscoveryChangeReason
  /** Peer IDs this change affects. */
  peerIds: string[]
  /** "updated" only: which announced fields differ from the previous entry. */
  fields?: Array<"alias" | "address" | "tcpPort">
  /** "updated" only: the entry before the change. */
  previous?: DiscoveredPeer
}

export interface DiscoveryEvents {
  /** Fires with the full peer list and the reason. */
  onPeersChanged?: (peers: DiscoveredPeer[], change: DiscoveryChange) => void
  /** Non-fatal discovery failures: multicast join, socket errors, announce failures. */
  onError?: (error: Error) => void
}

export interface DiscoveryStartOptions {
  /** User-chosen device name, 1-64 characters. */
  alias: string
  /** Our ephemeral Peer ID (from generateEphemeralIdentity, app startup). */
  peerId: string
  /** TCP port our Noise listener is on. */
  tcpPort: number
  /** Discovery UDP port. Defaults to DISCOVERY_PORT. */
  discoveryPort?: number
  events?: DiscoveryEvents
}

/** Build the exact wire bytes for an announcement. */
export function buildAnnouncement(alias: string, peerId: string, tcpPort: number): Uint8Array {
  const payload: Announcement = { v: DISCOVERY_PROTOCOL_VERSION, alias, peerId, tcpPort }
  return new TextEncoder().encode(JSON.stringify(payload))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isValidPeerId(peerId: unknown): peerId is string {
  return typeof peerId === "string" && peerId.length <= MAX_PEER_ID_CHARS && PEER_ID_PATTERN.test(peerId)
}

/**
 * Strictly validate an incoming announcement datagram. Returns the parsed
 * announcement, or null for anything malformed (fail closed: malformed
 * packets are ignored, never acted on).
 */
export function parseAnnouncement(data: Uint8Array): Announcement | null {
  if (data.length === 0 || data.length > MAX_ANNOUNCE_BYTES) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(data))
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) {
    return null
  }
  if (parsed["v"] !== DISCOVERY_PROTOCOL_VERSION) {
    return null
  }
  const alias = parsed["alias"]
  if (typeof alias !== "string" || alias.length === 0 || alias.length > MAX_ALIAS_CHARS) {
    return null
  }
  // Aliases are rendered in the TUI: strip control and format characters to
  // block terminal escape injection and bidi/zero-width spoofing.
  const cleanAlias = alias.replace(ALIAS_STRIP_PATTERN, "")
  if (cleanAlias.length === 0) {
    return null
  }
  const peerId = parsed["peerId"]
  // Ephemeral Peer IDs are "z" + base58btc of a 36-byte protobuf key.
  // Reject anything else (control bytes, non-base58 characters, over-length).
  if (!isValidPeerId(peerId)) {
    return null
  }
  // "manual:" is a reserved local namespace (never expires; identity is
  // confirmed by SAS on send).
  // A network announcement must not be able to claim it.
  if (peerId.startsWith("manual:")) {
    return null
  }
  const tcpPort = parsed["tcpPort"]
  if (typeof tcpPort !== "number" || !Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
    return null
  }
  return { v: 1, alias: cleanAlias, peerId, tcpPort }
}

function validateAlias(alias: unknown): string {
  if (typeof alias !== "string") {
    throw new Error("discovery alias must be a string")
  }
  const trimmed = alias.replace(ALIAS_STRIP_PATTERN, "").trim()
  if (trimmed.length === 0 || trimmed.length > MAX_ALIAS_CHARS) {
    throw new Error("discovery alias must be 1-64 characters")
  }
  return trimmed
}

function validatePeerId(peerId: unknown): string {
  if (!isValidPeerId(peerId)) {
    throw new Error("discovery peerId must be a z-prefixed base58 string (<=128 chars)")
  }
  return peerId
}

function validateTcpPort(port: unknown): number {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("discovery tcpPort must be an integer 1-65535")
  }
  return port
}

export class DiscoveryService {
  private socket: Bun.udp.Socket<"buffer"> | null = null
  private ownPeerId = ""
  private alias = ""
  private tcpPort = 0
  private discoveryPort = DISCOVERY_PORT
  private events: DiscoveryEvents = {}
  private readonly peers = new Map<string, DiscoveredPeer>()
  /** Per source address: performance.now() stamps of recently accepted NEW peer IDs. */
  private readonly newPeerTimes = new Map<string, number[]>()
  private announceTimer: ReturnType<typeof setInterval> | null = null
  private expiryTimer: ReturnType<typeof setInterval> | null = null
  /** True from the start of start() until its socket is bound and wired up. */
  private starting = false
  private started = false
  /** Bumped by stop(). A start() whose generation changed while binding was stopped and must release its socket. */
  private generation = 0
  private sendErrorNotified = false
  private readonly bindUdp: typeof Bun.udpSocket

  /** `bindUdp` is a test seam; production uses Bun.udpSocket. */
  constructor(bindUdp: typeof Bun.udpSocket = Bun.udpSocket) {
    this.bindUdp = bindUdp
  }

  /** Our ephemeral Peer ID (for tests). */
  get peerId(): string {
    return this.ownPeerId
  }

  get isStarted(): boolean {
    return this.started
  }

  async start(options: DiscoveryStartOptions): Promise<void> {
    if (this.started || this.starting) {
      throw new Error("discovery already started")
    }
    this.alias = validateAlias(options.alias)
    this.ownPeerId = validatePeerId(options.peerId)
    this.tcpPort = validateTcpPort(options.tcpPort)
    this.discoveryPort = options.discoveryPort ?? DISCOVERY_PORT
    if (
      typeof this.discoveryPort !== "number" ||
      !Number.isInteger(this.discoveryPort) ||
      this.discoveryPort < 1 ||
      this.discoveryPort > 65535
    ) {
      throw new Error("discovery port must be an integer 1-65535")
    }
    this.events = options.events ?? {}

    // Set the flag before awaiting so stop() during the bind is visible.
    const generation = this.generation
    this.starting = true
    let socket: Bun.udp.Socket<"buffer">
    try {
      socket = await this.bindUdp({
        port: this.discoveryPort,
        socket: {
          data: (_sock, buf, _port, addr) => {
            this.handleDatagram(new Uint8Array(buf), addr)
          },
          error: (_sock, error) => {
            this.events.onError?.(error instanceof Error ? error : new Error(String(error)))
          },
        },
      })
    } catch (error) {
      if (generation === this.generation) this.starting = false
      throw error
    }
    // Re-check after the await: stop() may have run while we were binding.
    if (generation !== this.generation) {
      try {
        socket.close()
      } catch {
        // Best effort: the port must be released either way.
      }
      throw new Error("discovery start cancelled by stop()")
    }
    this.socket = socket
    // Link-local only: announcements must not leave the LAN.
    try {
      socket.setMulticastTTL(1)
    } catch {
      // Non-fatal; best effort.
    }
    try {
      socket.setMulticastLoopback(true)
    } catch {
      // Non-fatal; best effort.
    }
    try {
      socket.addMembership(DISCOVERY_MULTICAST_GROUP)
    } catch (error) {
      // Some networks block multicast: report it and continue in
      // announce-only mode instead of crashing.
      this.events.onError?.(
        new Error(
          `multicast join failed (discovery receive disabled): ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    }

    this.starting = false
    this.started = true
    this.announce()
    this.announceTimer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS)
    this.expiryTimer = setInterval(() => this.sweepExpired(), ANNOUNCE_INTERVAL_MS)
    // Don't keep the process alive just for discovery.
    this.announceTimer.unref?.()
    this.expiryTimer.unref?.()
  }

  stop(): void {
    // Cancels any start() still binding (it closes its own socket on resume).
    this.generation++
    this.starting = false
    if (this.announceTimer) {
      clearInterval(this.announceTimer)
      this.announceTimer = null
    }
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer)
      this.expiryTimer = null
    }
    try {
      this.socket?.close()
    } catch {
      // Best effort.
    }
    this.socket = null
    this.started = false
    this.newPeerTimes.clear()
    if (this.peers.size > 0) {
      const peerIds = [...this.peers.keys()]
      this.peers.clear()
      this.events.onPeersChanged?.([], { reason: "cleared", peerIds })
    }
  }

  /** Currently known peers, sorted by alias. */
  listPeers(): DiscoveredPeer[] {
    return [...this.peers.values()].sort((a, b) => a.alias.localeCompare(b.alias))
  }

  /**
   * Seed a manually-entered peer (e.g. from --peer). Manual peers never
   * expire and are marked with a `manual:` peerId prefix. Their Peer ID is
   * unknown until a transfer verifies it (SAS comparison on send).
   */
  addManualPeer(peer: DiscoveredPeer): void {
    // Validate at the trust boundary: callers build these from CLI input.
    if (typeof peer.peerId !== "string" || !peer.peerId.startsWith("manual:") || peer.peerId.length > MAX_PEER_ID_CHARS) {
      throw new Error('manual peer: peerId must start with "manual:" and be at most 128 characters')
    }
    if (typeof peer.alias !== "string" || peer.alias.length === 0 || peer.alias.length > MAX_ALIAS_CHARS) {
      throw new Error("manual peer: alias must be 1-64 characters")
    }
    if (!Number.isInteger(peer.tcpPort) || peer.tcpPort < 1 || peer.tcpPort > 65535) {
      throw new Error("manual peer: tcpPort must be an integer 1-65535")
    }
    if (typeof peer.address !== "string" || peer.address.length === 0) {
      throw new Error("manual peer: address must be a non-empty string")
    }
    // lastSeen is always taken from this service's monotonic clock.
    this.peers.set(peer.peerId, { ...peer, lastSeen: performance.now() })
    this.events.onPeersChanged?.(this.listPeers(), { reason: "added", peerIds: [peer.peerId] })
  }

  /**
   * Process one received datagram. Public as a test seam; `start()` wires
   * it to the UDP socket's data handler.
   *
   * Admission rules (announcements are unauthenticated):
   * - A known peerId may refresh, or move to a new address or alias. Each
   *   change is reported through onPeersChanged with its fields.
   * - A new peerId needs room under the per-source cap and the per-source
   *   new-ID rate limit. Otherwise it is dropped.
   * - When the table is full, only entries past their expiry are reclaimed.
   *   A live entry is never evicted for a newcomer.
   */
  handleDatagram(data: Uint8Array, address: string): void {
    const announcement = parseAnnouncement(data)
    if (!announcement) {
      return
    }
    // Ignore our own announcements.
    if (announcement.peerId === this.ownPeerId) {
      return
    }
    const now = performance.now()
    const existing = this.peers.get(announcement.peerId)
    // Never let a network announcement overwrite a manual entry (the
    // "manual:" namespace is reserved; parseAnnouncement already rejects
    // such announcements, this is defense in depth).
    if (existing && existing.peerId.startsWith("manual:")) {
      return
    }
    if (existing) {
      // Moving a known ID onto an address that is already at its cap is refused.
      if (existing.address !== address && this.countFromSource(address) >= MAX_PEERS_PER_SOURCE) {
        return
      }
    } else {
      if (this.countFromSource(address) >= MAX_PEERS_PER_SOURCE) {
        return
      }
      if (!this.takeNewPeerSlot(address, now)) {
        return
      }
      if (this.peers.size >= MAX_DISCOVERED_PEERS) {
        this.removeExpired(now)
        if (this.peers.size >= MAX_DISCOVERED_PEERS) {
          // Table is full of live entries: drop the newcomer.
          return
        }
      }
    }

    const fields: Array<"alias" | "address" | "tcpPort"> = []
    if (existing) {
      if (existing.alias !== announcement.alias) fields.push("alias")
      if (existing.address !== address) fields.push("address")
      if (existing.tcpPort !== announcement.tcpPort) fields.push("tcpPort")
    }
    this.peers.set(announcement.peerId, {
      peerId: announcement.peerId,
      alias: announcement.alias,
      address,
      tcpPort: announcement.tcpPort,
      lastSeen: now,
      changedAt: fields.length > 0 ? now : existing?.changedAt,
    })
    if (!existing) {
      this.events.onPeersChanged?.(this.listPeers(), { reason: "added", peerIds: [announcement.peerId] })
    } else if (fields.length > 0) {
      // Surface address/alias/port changes for a known ID: a spoofed
      // re-announcement that would redirect sends is worth the UI noticing.
      this.events.onPeersChanged?.(this.listPeers(), {
        reason: "updated",
        peerIds: [announcement.peerId],
        fields,
        previous: existing,
      })
    }
  }

  /**
   * Drop peers silent for longer than PEER_EXPIRY_MS. `now` is injectable for
   * tests and uses the same monotonic clock as lastSeen.
   */
  sweepExpired(now: number = performance.now()): void {
    const expired = this.removeExpired(now)
    for (const [address, times] of this.newPeerTimes) {
      if (times.length === 0 || times[times.length - 1]! <= now - PEER_EXPIRY_MS) {
        this.newPeerTimes.delete(address)
      }
    }
    if (expired.length > 0) {
      this.events.onPeersChanged?.(this.listPeers(), { reason: "expired", peerIds: expired })
    }
  }

  /** Remove non-manual entries past expiry. Returns the removed IDs. */
  private removeExpired(now: number): string[] {
    const removed: string[] = []
    for (const [id, peer] of this.peers) {
      // Manual peers never expire.
      if (id.startsWith("manual:")) continue
      if (now - peer.lastSeen > PEER_EXPIRY_MS) {
        this.peers.delete(id)
        removed.push(id)
      }
    }
    return removed
  }

  /** Number of tracked non-manual peers announced from this source address. */
  private countFromSource(address: string): number {
    let count = 0
    for (const [id, peer] of this.peers) {
      if (peer.address === address && !id.startsWith("manual:")) count++
    }
    return count
  }

  /** Rate limit: take one new-ID slot for this source, or refuse if the window is full. */
  private takeNewPeerSlot(address: string, now: number): boolean {
    let times = this.newPeerTimes.get(address)
    if (!times) {
      if (this.newPeerTimes.size >= MAX_RATE_LIMITED_SOURCES) {
        return false
      }
      times = []
      this.newPeerTimes.set(address, times)
    }
    const cutoff = now - PEER_EXPIRY_MS
    while (times.length > 0 && times[0]! <= cutoff) {
      times.shift()
    }
    if (times.length >= MAX_NEW_PEERS_PER_SOURCE_WINDOW) {
      return false
    }
    times.push(now)
    return true
  }

  private announce(): void {
    if (!this.socket) {
      return
    }
    try {
      this.socket.send(
        buildAnnouncement(this.alias, this.ownPeerId, this.tcpPort),
        this.discoveryPort,
        DISCOVERY_MULTICAST_GROUP,
      )
      this.sendErrorNotified = false
    } catch (error) {
      // E.g. EPERM on networks that block multicast sends. Report once
      // until a send succeeds; never crash the timer loop.
      if (!this.sendErrorNotified) {
        this.sendErrorNotified = true
        this.events.onError?.(
          new Error(`discovery announce failed: ${error instanceof Error ? error.message : String(error)}`),
        )
      }
    }
  }
}
