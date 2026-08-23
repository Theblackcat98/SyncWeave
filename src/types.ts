export type SyncState = "synced" | "added" | "modified" | "deleted"
export type Pane = "local" | "remote"
export type Screen = "workspace" | "pairing" | "diff" | "transfer"
export type TransferState = "idle" | "transferring" | "complete"
export type PairingStepName = "waiting" | "authenticating" | "connected"

export interface FileEntry {
  name: string
  icon: string
  size: string
  bytes: number
  state: SyncState
  selected: boolean
}

export interface Peer {
  id: string
  name: string
  online: boolean
}

export interface DiffRow {
  label: string
  left: string
  right: string
}

export interface TransferSnapshot {
  state: TransferState
  progress: number
  activeFileName: string
  chunkIndex: number
  chunkTotal: number
}

export interface TransferCallbacks {
  onUpdate: () => void
  onComplete: (entries: readonly FileEntry[]) => void
}

export interface FilesystemService {
  filesFor(pane: Pane): FileEntry[]
  allFiles(): FileEntry[]
  selectedFiles(): FileEntry[]
  selectedBytes(): number
  toggleAt(pane: Pane, index: number): void
  markSynced(entries: readonly FileEntry[]): void
}

export interface PeerService {
  peers(): readonly Peer[]
  onlineCount(): number
}

export interface PairingService {
  start(onUpdate: () => void): void
  cancel(): void
  step(): PairingStepName
}

export interface TransferService {
  start(entries: readonly FileEntry[], callbacks: TransferCallbacks): void
  cancel(): void
  snapshot(): TransferSnapshot
}
