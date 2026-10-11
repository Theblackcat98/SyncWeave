import type { MockEntry, Pane } from "../domain.js"

export interface FileSystemService {
  list(pane: Pane, path: string): MockEntry[]
  parentPath(path: string): string
  markSynced(pane: Pane, ids: string[]): void
  getDiff(id: string): string[]
}

type Tree = Record<Pane, Record<string, MockEntry[]>>

function entry(id: string, name: string, kind: "file" | "directory", bytes: number, state: MockEntry["state"], summary?: string): MockEntry {
  return { id, name, kind, bytes, state, summary }
}

const rootPath: Record<Pane, string> = { local: "~/projects/notes", remote: "MacBook-M3: ~/notes" }

const scenario: Tree = {
  local: {
    [rootPath.local]: [
      entry("architecture", "architecture-diagram.md", "file", 12_288, "modified", "Transport and retry policy diverged"),
      entry("todo", "daily-todo.txt", "file", 2_048, "synced"),
      entry("configs", "configs/", "directory", 0, "modified"),
      entry("build", "build-artifact.tar.gz", "file", 47_185_920, "added"),
      entry("launch", "launch-checklist.md", "file", 5_632, "modified"),
      entry("notes", "meeting-notes.txt", "file", 3_072, "synced"),
      entry("research", "research/", "directory", 0, "added"),
      entry("readme", "README.md", "file", 8_704, "modified"),
      entry("palette", "theme-preview.png", "file", 228_352, "added"),
      entry("log", "transfer-log.json", "file", 1_024, "deleted"),
      entry("guide", "termux-setup.md", "file", 6_144, "synced"),
    ],
    [`${rootPath.local}/configs`]: [
      entry("settings", "settings.json", "file", 1_536, "modified"),
      entry("defaults", "defaults.toml", "file", 2_560, "synced"),
      entry("env-example", ".env.example", "file", 512, "added"),
    ],
    [`${rootPath.local}/research`]: [
      entry("benchmarks", "benchmarks.md", "file", 4_608, "modified"),
      entry("protocol-notes", "protocol-notes.txt", "file", 2_816, "added"),
    ],
  },
  remote: {
    [rootPath.remote]: [
      entry("architecture-remote", "architecture-diagram.md", "file", 14_336, "modified", "Remote transport section changed"),
      entry("todo-remote", "daily-todo.txt", "file", 2_048, "synced"),
      entry("configs-remote", "configs/", "directory", 0, "modified"),
      entry("release", "release-v1.tar.gz", "file", 47_185_920, "added"),
      entry("design", "design-decisions.md", "file", 7_168, "modified"),
      entry("assets", "assets/", "directory", 0, "synced"),
      entry("changelog", "CHANGELOG.md", "file", 3_584, "synced"),
      entry("screenshot", "terminal-capture.png", "file", 182_272, "added"),
      entry("scripts", "scripts/", "directory", 0, "modified"),
      entry("release-notes", "release-notes.md", "file", 4_096, "synced"),
      entry("history", "sync-history.json", "file", 2_048, "deleted"),
    ],
    [`${rootPath.remote}/configs`]: [
      entry("settings-remote", "settings.json", "file", 1_408, "modified"),
      entry("defaults-remote", "defaults.toml", "file", 2_560, "synced"),
    ],
    [`${rootPath.remote}/assets`]: [
      entry("logo", "syncweave-logo.svg", "file", 2_304, "added"),
      entry("terminal-shot", "terminal.png", "file", 96_256, "synced"),
    ],
    [`${rootPath.remote}/scripts`]: [
      entry("sync-script", "sync.sh", "file", 4_096, "modified"),
    ],
  },
}

const diffs: Record<string, string[]> = {
  architecture: [
    "  # SyncWeave Architecture",
    "  ## Transfer flow",
    "- Prefer WebSocket fallback",
    "+ Use a documented, direct LAN transport",
    "  ## State",
    "- Retry: 3 attempts",
    "+ Retry: bounded, user-visible backoff",
    "  Preview before transfer",
  ],
  settings: [
    "  [ui]",
    "- accent = \"blue\"",
    "+ accent = \"electric-cyan\"",
    "  reduced_motion = false",
  ],
  "architecture-remote": [
    "  # SyncWeave Architecture",
    "  ## Transfer flow",
    "- Use a documented, direct LAN transport",
    "+ Prefer WebSocket fallback",
    "  ## State",
    "+ Retry: 3 attempts",
    "- Retry: bounded, user-visible backoff",
    "  Preview before transfer",
  ],
}

export class MockFileSystemService implements FileSystemService {
  readonly paths = rootPath
  private readonly files: Tree = structuredClone(scenario)

  list(pane: Pane, path: string): MockEntry[] {
    return (this.files[pane][path] ?? []).map((item) => ({ ...item }))
  }

  parentPath(path: string): string {
    if (Object.values(rootPath).includes(path)) return path
    const marker = path.lastIndexOf("/")
    if (marker <= 0) return path
    return path.slice(0, marker)
  }

  markSynced(pane: Pane, ids: string[]): void {
    const accepted = new Set(ids)
    for (const entries of Object.values(this.files[pane])) {
      for (const item of entries) {
        if (accepted.has(item.id)) item.state = "synced"
      }
    }
  }

  getDiff(id: string): string[] {
    return diffs[id] ?? ["  No content diff is available in this mock scenario."]
  }
}
