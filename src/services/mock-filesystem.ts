import type { FileEntry, FilesystemService, Pane } from "../types"

const localFiles: FileEntry[] = [
  { name: "architecture-diagram.md", icon: "󰈙", size: "12 KB", bytes: 12288, state: "modified", selected: false },
  { name: "daily-todo.txt", icon: "󰈙", size: "2 KB", bytes: 2048, state: "synced", selected: false },
  { name: "configs/", icon: "󰒓", size: "—", bytes: 0, state: "modified", selected: false },
  { name: "build-artifact.tar.gz", icon: "󰡨", size: "45 MB", bytes: 47185920, state: "added", selected: false },
]

const remoteFiles: FileEntry[] = [
  { name: "architecture-diagram.md", icon: "󰈙", size: "14 KB", bytes: 14336, state: "modified", selected: false },
  { name: "daily-todo.txt", icon: "󰈙", size: "2 KB", bytes: 2048, state: "synced", selected: false },
  { name: "configs/", icon: "󰒓", size: "—", bytes: 0, state: "modified", selected: false },
  { name: "release-v1.tar.gz", icon: "󰡨", size: "45 MB", bytes: 47185920, state: "added", selected: false },
]

export function createMockFilesystem(): FilesystemService {
  return {
    filesFor(pane: Pane): FileEntry[] {
      return pane === "local" ? localFiles : remoteFiles
    },
    allFiles(): FileEntry[] {
      return [...localFiles, ...remoteFiles]
    },
    selectedFiles(): FileEntry[] {
      return this.allFiles().filter((file) => file.selected)
    },
    selectedBytes(): number {
      return this.selectedFiles().reduce((total, file) => total + file.bytes, 0)
    },
    toggleAt(pane: Pane, index: number): void {
      const files = pane === "local" ? localFiles : remoteFiles
      const file = files[index]
      if (file) file.selected = !file.selected
    },
    markSynced(entries: readonly FileEntry[]): void {
      entries.forEach((entry) => {
        entry.selected = false
        entry.state = "synced"
      })
    },
  }
}
