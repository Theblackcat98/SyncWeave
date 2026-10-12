import { lstatSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { MockEntry, Pane } from "../domain.js"
import type { FileSystemService } from "./ports.js"

/** Maximum directory entries returned by a single listing. Large directories
 *  are truncated (sorted, first N) rather than failing. */
export const MAX_DIRECTORY_ENTRIES = 500

/**
 * Expand a leading `~` to the user's home directory. Absolute and relative
 * paths without a leading `~` are returned unchanged.
 */
export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

/**
 * `FileSystemService` backed by the real local filesystem. Only the local
 * pane has a filesystem: the remote pane deliberately has none — the real
 * app must not show the receiver's files (out of scope).
 *
 * Symlinks are listed but never followed (lstat, never stat): a symlink is
 * reported as a file with size 0 so directory cycles cannot be traversed.
 * Entries that cannot be stated (vanished or unreadable) are skipped
 * gracefully instead of failing the whole listing.
 */
export class RealFileSystemService implements FileSystemService {
  readonly paths: Record<Pane, string>

  constructor(rootDirectory: string = process.cwd()) {
    this.paths = { local: expandHome(rootDirectory), remote: "" }
  }

  list(pane: Pane, path: string): MockEntry[] {
    if (pane === "remote") return []
    const directory = expandHome(path)
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      return []
    }
    const entries: MockEntry[] = []
    for (const name of names.sort()) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) break
      const absolute = join(directory, name)
      let isDirectory = false
      let isLink = false
      let bytes = 0
      try {
        const stat = lstatSync(absolute)
        isLink = stat.isSymbolicLink()
        isDirectory = stat.isDirectory() && !isLink
        bytes = isLink || stat.isDirectory() ? 0 : stat.size
      } catch {
        continue
      }
      entries.push({
        id: absolute,
        name: isDirectory ? `${name}/` : name,
        kind: isDirectory ? "directory" : "file",
        bytes,
        state: "synced",
      })
    }
    return entries
  }

  parentPath(path: string): string {
    // dirname("/") === "/", so this can never escape the filesystem root.
    return dirname(resolve(expandHome(path)))
  }

  markSynced(_pane: Pane, _ids: string[]): void {
    // Real files carry no mock synchronization state.
  }

  getDiff(_id: string): string[] {
    // Real diffing is out of scope.
    return []
  }
}
