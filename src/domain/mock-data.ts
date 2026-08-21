import type { AppState, DiffLine, MockFile, MockPeer } from "./types"

const localRoot = "~/projects/notes"
const remoteRoot = "~/notes"

export const MOCK_LOCAL_FILES: MockFile[] = [
  { id: "local:architecture", name: "architecture-diagram.md", path: "architecture-diagram.md", kind: "file", icon: "󰈙", size: "12 KB", bytes: 12_288, state: "modified", selected: false },
  { id: "local:todo", name: "daily-todo.txt", path: "daily-todo.txt", kind: "file", icon: "󰈙", size: "2 KB", bytes: 2_048, state: "synced", selected: false },
  { id: "local:configs", name: "configs/", path: "configs/", kind: "directory", icon: "󰒓", size: "—", bytes: 0, state: "modified", selected: false },
  { id: "local:artifact", name: "build-artifact.tar.gz", path: "build-artifact.tar.gz", kind: "file", icon: "󰡨", size: "45 MB", bytes: 47_185_920, state: "added", selected: false },
  { id: "local:readme", name: "README.md", path: "README.md", kind: "file", icon: "󰈙", size: "6 KB", bytes: 6_144, state: "synced", selected: false },
  { id: "local:roadmap", name: "roadmap.md", path: "roadmap.md", kind: "file", icon: "󰈙", size: "8 KB", bytes: 8_192, state: "modified", selected: false },
  { id: "local:env", name: ".env.example", path: ".env.example", kind: "file", icon: "󰈙", size: "1 KB", bytes: 1_024, state: "synced", selected: false },
  { id: "local:design", name: "design-notes.md", path: "design-notes.md", kind: "file", icon: "󰈙", size: "9 KB", bytes: 9_216, state: "deleted", selected: false },
  { id: "local:assets", name: "assets/", path: "assets/", kind: "directory", icon: "󰒓", size: "—", bytes: 0, state: "synced", selected: false },
  { id: "local:lock", name: "bun.lock", path: "bun.lock", kind: "file", icon: "󰈙", size: "21 KB", bytes: 21_504, state: "synced", selected: false },
  { id: "local:notes", name: "meeting-notes.md", path: "meeting-notes.md", kind: "file", icon: "󰈙", size: "4 KB", bytes: 4_096, state: "conflict", selected: false },
  { id: "local:release", name: "release-checklist.md", path: "release-checklist.md", kind: "file", icon: "󰈙", size: "3 KB", bytes: 3_072, state: "added", selected: false },
]

export const MOCK_REMOTE_FILES: MockFile[] = [
  { id: "remote:architecture", name: "architecture-diagram.md", path: "architecture-diagram.md", kind: "file", icon: "󰈙", size: "14 KB", bytes: 14_336, state: "modified", selected: false },
  { id: "remote:todo", name: "daily-todo.txt", path: "daily-todo.txt", kind: "file", icon: "󰈙", size: "2 KB", bytes: 2_048, state: "synced", selected: false },
  { id: "remote:configs", name: "configs/", path: "configs/", kind: "directory", icon: "󰒓", size: "—", bytes: 0, state: "modified", selected: false },
  { id: "remote:release", name: "release-v1.tar.gz", path: "release-v1.tar.gz", kind: "file", icon: "󰡨", size: "45 MB", bytes: 47_185_920, state: "added", selected: false },
  { id: "remote:readme", name: "README.md", path: "README.md", kind: "file", icon: "󰈙", size: "6 KB", bytes: 6_144, state: "synced", selected: false },
  { id: "remote:roadmap", name: "roadmap.md", path: "roadmap.md", kind: "file", icon: "󰈙", size: "7 KB", bytes: 7_168, state: "modified", selected: false },
  { id: "remote:env", name: ".env.example", path: ".env.example", kind: "file", icon: "󰈙", size: "1 KB", bytes: 1_024, state: "synced", selected: false },
  { id: "remote:design", name: "design-notes.md", path: "design-notes.md", kind: "file", icon: "󰈙", size: "—", bytes: 0, state: "deleted", selected: false },
  { id: "remote:assets", name: "assets/", path: "assets/", kind: "directory", icon: "󰒓", size: "—", bytes: 0, state: "synced", selected: false },
  { id: "remote:lock", name: "bun.lock", path: "bun.lock", kind: "file", icon: "󰈙", size: "21 KB", bytes: 21_504, state: "synced", selected: false },
  { id: "remote:notes", name: "meeting-notes.md", path: "meeting-notes.md", kind: "file", icon: "󰈙", size: "5 KB", bytes: 5_120, state: "conflict", selected: false },
  { id: "remote:release-check", name: "release-checklist.md", path: "release-checklist.md", kind: "file", icon: "󰈙", size: "3 KB", bytes: 3_072, state: "added", selected: false },
]

const localConfigs: MockFile[] = [
  { id: "local:termux", name: "termux.properties", path: "configs/termux.properties", kind: "file", icon: "󰒓", size: "1 KB", bytes: 1_024, state: "modified", selected: false },
  { id: "local:shell", name: "shell.conf", path: "configs/shell.conf", kind: "file", icon: "󰒓", size: "2 KB", bytes: 2_048, state: "synced", selected: false },
  { id: "local:git", name: "gitconfig", path: "configs/gitconfig", kind: "file", icon: "󰒓", size: "1 KB", bytes: 1_024, state: "added", selected: false },
]

const remoteConfigs: MockFile[] = [
  { id: "remote:termux", name: "termux.properties", path: "configs/termux.properties", kind: "file", icon: "󰒓", size: "1 KB", bytes: 1_024, state: "modified", selected: false },
  { id: "remote:shell", name: "shell.conf", path: "configs/shell.conf", kind: "file", icon: "󰒓", size: "2 KB", bytes: 2_048, state: "synced", selected: false },
  { id: "remote:git", name: "gitconfig", path: "configs/gitconfig", kind: "file", icon: "󰒓", size: "1 KB", bytes: 1_024, state: "conflict", selected: false },
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

export function cloneFiles(files: MockFile[]): MockFile[] { return files.map((file) => ({ ...file })) }
function cloneMap(map: Record<string, MockFile[]>): Record<string, MockFile[]> { return Object.fromEntries(Object.entries(map).map(([path, files]) => [path, cloneFiles(files)])) }

export function createInitialState(): AppState {
  const localDirectoryMap = cloneMap({ [localRoot]: MOCK_LOCAL_FILES, [`${localRoot}/configs`]: localConfigs })
  const remoteDirectoryMap = cloneMap({ [remoteRoot]: MOCK_REMOTE_FILES, [`${remoteRoot}/configs`]: remoteConfigs })
  return {
    screen: "workspace",
    activePane: "local",
    localCursor: 0,
    remoteCursor: 0,
    localScroll: 0,
    remoteScroll: 0,
    status: "Ready — select files to stage a mock transfer",
    localPath: localRoot,
    remotePath: remoteRoot,
    localFiles: cloneFiles(MOCK_LOCAL_FILES),
    remoteFiles: cloneFiles(MOCK_REMOTE_FILES),
    localDirectoryStack: [localRoot],
    remoteDirectoryStack: [remoteRoot],
    localDirectoryMap,
    remoteDirectoryMap,
    peers: MOCK_PEERS.map((peer) => ({ ...peer })),
    connectedPeerId: "peer:macbook",
    transfer: null,
    pairingStep: 0,
    selectedHunk: 0,
  }
}
