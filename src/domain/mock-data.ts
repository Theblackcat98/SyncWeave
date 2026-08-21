import type { AppState, DiffLine, MockFile, MockPeer } from "./types"

export const MOCK_LOCAL_FILES: MockFile[] = [
  { id: "local:architecture", name: "architecture-diagram.md", path: "architecture-diagram.md", kind: "file", icon: "󰈙", size: "12 KB", bytes: 12_288, state: "modified", selected: false },
  { id: "local:todo", name: "daily-todo.txt", path: "daily-todo.txt", kind: "file", icon: "󰈙", size: "2 KB", bytes: 2_048, state: "synced", selected: false },
  { id: "local:configs", name: "configs/", path: "configs/", kind: "directory", icon: "󰒓", size: "—", bytes: 0, state: "modified", selected: false },
  { id: "local:artifact", name: "build-artifact.tar.gz", path: "build-artifact.tar.gz", kind: "file", icon: "󰡨", size: "45 MB", bytes: 47_185_920, state: "added", selected: false },
]

export const MOCK_REMOTE_FILES: MockFile[] = [
  { id: "remote:architecture", name: "architecture-diagram.md", path: "architecture-diagram.md", kind: "file", icon: "󰈙", size: "14 KB", bytes: 14_336, state: "modified", selected: false },
  { id: "remote:todo", name: "daily-todo.txt", path: "daily-todo.txt", kind: "file", icon: "󰈙", size: "2 KB", bytes: 2_048, state: "synced", selected: false },
  { id: "remote:configs", name: "configs/", path: "configs/", kind: "directory", icon: "󰒓", size: "—", bytes: 0, state: "modified", selected: false },
  { id: "remote:release", name: "release-v1.tar.gz", path: "release-v1.tar.gz", kind: "file", icon: "󰡨", size: "45 MB", bytes: 47_185_920, state: "added", selected: false },
]

export const MOCK_PEERS: MockPeer[] = [
  { id: "peer:macbook", name: "MacBook-M3", platform: "macOS", path: "~/notes", status: "online", transport: "direct" },
  { id: "peer:pixel", name: "Pixel-10-Pro", platform: "Android / Termux", path: "~/notes", status: "online", transport: "direct" },
  { id: "peer:server", name: "Home-Server", platform: "Linux", path: "~/sync", status: "offline", transport: "relay" },
]

export const MOCK_DIFF: DiffLine[] = [
  { kind: "context", line: 1, local: "# SyncWeave Architecture", remote: "# SyncWeave Architecture" },
  { kind: "context", line: 2, local: "", remote: "" },
  { kind: "context", line: 3, local: "## Transport", remote: "## Transport" },
  { kind: "removed", line: 4, local: "- WebSocket fallback", remote: "" },
  { kind: "added", line: 4, local: "", remote: "+ QUIC primary transport" },
  { kind: "context", line: 5, local: "- Chunked streams", remote: "- Chunked streams" },
  { kind: "removed", line: 6, local: "- Retry: 3", remote: "" },
  { kind: "added", line: 6, local: "", remote: "+ Retry: adaptive" },
  { kind: "context", line: 7, local: "", remote: "" },
  { kind: "context", line: 8, local: "## State", remote: "## State" },
  { kind: "context", line: 9, local: "Preview before sync", remote: "Preview before sync" },
]

export function cloneFiles(files: MockFile[]): MockFile[] {
  return files.map((file) => ({ ...file }))
}

export function createInitialState(): AppState {
  return {
    screen: "workspace",
    activePane: "local",
    localCursor: 0,
    remoteCursor: 0,
    status: "Ready — select files to stage a mock transfer",
    localPath: "~/projects/notes",
    remotePath: "~/notes",
    localFiles: cloneFiles(MOCK_LOCAL_FILES),
    remoteFiles: cloneFiles(MOCK_REMOTE_FILES),
    peers: MOCK_PEERS.map((peer) => ({ ...peer })),
    connectedPeerId: "peer:macbook",
    transfer: null,
    pairingStep: 0,
    selectedHunk: 0,
  }
}
