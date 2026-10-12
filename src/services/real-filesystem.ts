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
  /** Total entries in the last list() call (before the 500-entry cap). */
  lastListTotal = 0
  /** Error from the last list() call, if the directory could not be read. */
  lastListError: string | null = null

  listTotal(): number | undefined {
    return this.lastListTotal
  }

  listError(): string | null {
    return this.lastListError
  }

  constructor(rootDirectory: string = homedir()) {
    this.paths = { local: expandHome(rootDirectory), remote: "" }
  }

  list(pane: Pane, path: string): MockEntry[] {
    if (pane === "remote") return []
    const directory = expandHome(path)
    let names: string[]
    try {
      names = readdirSync(directory)
      this.lastListError = null
    } catch (error) {
      this.lastListError = error instanceof Error ? error.message : String(error)
      this.lastListTotal = 0
      return []
    }
    // Hide our own staging temp files: they must never be listed or sent.
    const visible = names.filter((n) => !n.startsWith(".syncweave-")).sort()
    this.lastListTotal = visible.length
    const entries: MockEntry[] = []
    for (const name of visible) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) break
      const absolute = join(directory, name)
      let isDirectory = false
      let unsupported: string | undefined
      let bytes = 0
      try {
        const stat = lstatSync(absolute)
        if (stat.isSymbolicLink()) {
          // Never follow symlinks; never send them (target could be
          // /dev/zero, a FIFO, or outside the shared tree).
          unsupported = "symlink"
        } else if (stat.isDirectory()) {
          isDirectory = true
        } else if (stat.isFile()) {
          bytes = stat.size
        } else if (stat.isFIFO()) {
          unsupported = "FIFO"
        } else if (stat.isSocket()) {
          unsupported = "socket"
        } else {
          unsupported = "special file"
        }
      } catch {
        continue
      }
      entries.push({
        id: absolute,
        name: isDirectory ? `${name}/` : name,
        kind: isDirectory ? "directory" : "file",
        bytes,
        state: "synced",
        ...(unsupported ? { unsupported } : {}),
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
