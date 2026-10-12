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
  lastSeen: number
}

export interface DiscoveryEvents {
  onPeersChanged?: (peers: DiscoveredPeer[]) => void
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
  const peerId = parsed["peerId"]
  // Ephemeral Peer IDs are base58btc ("z"-prefixed) encodings of a 36-byte
  // protobuf key: well under 128 chars. Bound the length without
  // over-coupling to the exact encoding.
  if (typeof peerId !== "string" || peerId.length === 0 || peerId.length > 128) {
    return null
  }
  const tcpPort = parsed["tcpPort"]
  if (typeof tcpPort !== "number" || !Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
    return null
  }
  return { v: 1, alias, peerId, tcpPort }
}

function validateAlias(alias: unknown): string {
  if (typeof alias !== "string") {
    throw new Error("discovery alias must be a string")
  }
  const trimmed = alias.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_ALIAS_CHARS) {
    throw new Error("discovery alias must be 1-64 characters")
  }
  return trimmed
}

function validatePeerId(peerId: unknown): string {
  if (typeof peerId !== "string" || peerId.length === 0 || peerId.length > 128) {
    throw new Error("discovery peerId must be a non-empty string (<=128 chars)")
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
  private announceTimer: ReturnType<typeof setInterval> | null = null
  private expiryTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  private sendErrorNotified = false

  /** Our ephemeral Peer ID (for tests). */
  get peerId(): string {
    return this.ownPeerId
  }

  get isStarted(): boolean {
    return this.started
  }

  async start(options: DiscoveryStartOptions): Promise<void> {
    if (this.started) {
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

    const socket: Bun.udp.Socket<"buffer"> = await Bun.udpSocket({
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

    this.started = true
    this.announce()
    this.announceTimer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS)
    this.expiryTimer = setInterval(() => this.sweepExpired(), ANNOUNCE_INTERVAL_MS)
    // Don't keep the process alive just for discovery.
    this.announceTimer.unref?.()
    this.expiryTimer.unref?.()
  }

  stop(): void {
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
    if (this.peers.size > 0) {
      this.peers.clear()
      this.events.onPeersChanged?.([])
    }
  }

  /** Currently known peers, sorted by alias. */
  listPeers(): DiscoveredPeer[] {
    return [...this.peers.values()].sort((a, b) => a.alias.localeCompare(b.alias))
  }

  /**
   * Process one received datagram. Public as a test seam; `start()` wires
   * it to the UDP socket's data handler.
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
    const existed = this.peers.has(announcement.peerId)
    this.peers.set(announcement.peerId, {
      peerId: announcement.peerId,
      alias: announcement.alias,
      address,
      tcpPort: announcement.tcpPort,
      lastSeen: Date.now(),
    })
    if (!existed) {
      this.events.onPeersChanged?.(this.listPeers())
    }
  }

  /** Drop peers silent for longer than PEER_EXPIRY_MS. `now` is injectable for tests. */
  sweepExpired(now: number = Date.now()): void {
    let changed = false
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > PEER_EXPIRY_MS) {
        this.peers.delete(id)
        changed = true
      }
    }
    if (changed) {
      this.events.onPeersChanged?.(this.listPeers())
    }
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
