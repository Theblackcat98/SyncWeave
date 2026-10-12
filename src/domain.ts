export type SyncState = "synced" | "added" | "modified" | "deleted"
export type Pane = "local" | "remote"
/** "mock" renders the deterministic simulation; "real" renders the local
 *  filesystem and a receiver status panel instead of the receiver's files. */
export type AppMode = "mock" | "real"
export type Screen = "workspace" | "send-review" | "consent" | "transfer" | "peer" | "favorites" | "diff" | "help" | "queue"
export type TransferStatus = "queued" | "transferring" | "complete" | "declined" | "cancelled" | "failed"
export type EntryKind = "file" | "directory"
export type ConsentMode = "incoming" | "outgoing"

export interface MockEntry {
  id: string
  name: string
  kind: EntryKind
  bytes: number
  state: SyncState
  summary?: string
  /** Set for entries that cannot be sent (symlink, FIFO, socket, device). */
  unsupported?: string
}

export interface MockPeer {
  id: string
  name: string
  host: string
  port: number
  fingerprint: string
  online: boolean
  /** The alias is self-asserted by a discovery announcement (unverified). */
  aliasClaimed?: boolean
  /** Another listed peer has the same alias. */
  aliasDuplicate?: boolean
  /** performance.now() of the last alias, address or port change seen for this peer. */
  changedAt?: number
}

/** A favorite is only a locally remembered destination; it is not verified trust. */
export interface FavoriteDestination {
  peerId: string
  alias: string
  host: string
  port: number
  fingerprint: string
  savedAt: number
}

export interface ConsentFile {
  id: string
  name: string
  bytes: number
  accepted: boolean
  renamed: boolean
}

export interface ConsentRequest {
  id: string
  mode: ConsentMode
  peer: MockPeer
  files: ConsentFile[]
  createdAt: number
  sourcePane?: Pane
  /** Short auth string for out-of-band confirmation (real incoming only). */
  sas?: string
}

export interface TransferRecord {
  id: string
  direction: ConsentMode
  peerName: string
  files: string[]
  acceptedFiles: string[]
  acceptedBytes: number
  destination: string
  fileIds: string[]
  sourcePane?: Pane
  status: TransferStatus
  progress: number
  createdAt: number
  error?: string
}

export interface AppState {
  screen: Screen
  activePane: Pane
  cursors: Record<Pane, number>
  paths: Record<Pane, string>
  scrollOffsets: Record<Pane, number>
  staged: Record<Pane, Set<string>>
  status: string
  identityStep: number
  discoveryFrame: number
  focusFrame: number
  revealFrame: number
  peerIndex: number
  favoriteCursor: number
  diffHunk: number
  request: ConsentRequest | null
  selectedConsentFile: number
  consentScrollOffset: number
  receiveDestinationIndex: number
  /** Non-null while the user is typing a new destination path (issue #27). */
  destinationInput: string | null
  transferQueue: TransferRecord[]
  activeTransferId: string | null
  reducedMotion: boolean
  /**
   * Real mode: sender-side SAS confirmation prompt (P0-1). Non-null while
   * the sender must compare `sas` with the receiver's screen before any file
   * metadata is sent. The app owns the state; render shows it on send-review.
   */
  sendSasConfirm: { sas: string; peerFingerprint: string; peerName: string } | null
  /** Real mode: true while a send is in flight (P0-9). */
  sending: boolean
}

export const OTHER_PANE: Record<Pane, Pane> = { local: "remote", remote: "local" }

const SIZE_UNITS = ["KB", "MB", "GB", "TB"] as const

/**
 * Human-readable size. The unit is chosen after rounding, so 1048575 bytes
 * reads as "1.0 MB" rather than "1024 KB" (P2-11).
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown"
  let scaled = Math.max(0, bytes)
  if (scaled < 1024) return `${Math.round(scaled)} B`
  let unit = 0
  scaled /= 1024
  // Round first: a value that rounds up to 1024 moves to the next unit.
  while (unit < SIZE_UNITS.length - 1 && Number(scaled.toFixed(unit === 0 ? 0 : 1)) >= 1024) {
    scaled /= 1024
    unit += 1
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 1)} ${SIZE_UNITS[unit]}`
}
