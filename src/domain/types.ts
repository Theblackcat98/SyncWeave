export type SyncState = "synced" | "added" | "modified" | "deleted" | "conflict"
export type FileKind = "file" | "directory"
export type Pane = "local" | "remote"
export type Screen = "workspace" | "pairing" | "diff" | "transfer"
export type TransferState = "idle" | "transferring" | "complete" | "failed" | "cancelled"
export type PeerStatus = "online" | "offline" | "connecting" | "authenticating"

export interface MockFile {
  id: string
  name: string
  path: string
  kind: FileKind
  icon: string
  size: string
  bytes: number
  state: SyncState
  selected: boolean
}

export interface MockPeer {
  id: string
  name: string
  platform: string
  path: string
  status: PeerStatus
  transport: "direct" | "relay"
}

export interface DiffLine {
  kind: "context" | "added" | "removed" | "modified"
  line: number
  local: string
  remote: string
}

export interface TransferJob {
  id: string
  fileIds: string[]
  state: TransferState
  progress: number
  bytesTotal: number
  bytesTransferred: number
  speedMbps: number
  etaSeconds: number
}

export interface AppState {
  screen: Screen
  activePane: Pane
  localCursor: number
  remoteCursor: number
  status: string
  localPath: string
  remotePath: string
  localFiles: MockFile[]
  remoteFiles: MockFile[]
  peers: MockPeer[]
  connectedPeerId: string | null
  transfer: TransferJob | null
  pairingStep: number
  selectedHunk: number
}
