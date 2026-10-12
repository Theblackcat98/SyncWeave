import { lstatSync, readdirSync, readlinkSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { MockEntry, Pane } from "../domain.js"
import type { FileSystemService } from "./ports.js"
import { isTemporaryPartialName } from "./safe-receive-sink.js"

/** Maximum entries returned by one listing call when no paging options are given.
 *  Larger folders are truncated (sorted, first N); use `offset` to reach the rest. */
export const MAX_DIRECTORY_ENTRIES = 10_000

/** Upper bound on how long a cached listing is reused without a directory change. */
const LISTING_CACHE_MAX_AGE_MS = 1000

export interface ListOptions {
  /** Index of the first entry to return (sorted order). Defaults to 0. */
  offset?: number
  /** Maximum number of entries to return. Defaults to MAX_DIRECTORY_ENTRIES. */
  limit?: number
}

/** A listing entry. `symlinkTarget` is the unfollowed readlink() value for symlinks. */
export type FsEntry = MockEntry & { symlinkTarget?: string }

export interface RealFileSystemOptions {
  /** Show dotfiles (default true). Staging partials are always hidden. */
  showHidden?: boolean
}

interface ListingCache {
  directory: string
  /** Directory mtime/ctime plus the hidden-file setting; a change rebuilds the listing. */
  key: string
  /** When the listing was built. Coarse kernel timestamps can hide a change made in the same tick. */
  builtAt: number
  /** Visible names, sorted, after filtering. */
  names: string[]
  /** Built entries by name; `null` records a name that vanished or could not be stated. */
  built: Map<string, FsEntry | null>
}

/**
 * Expand a leading `~` to the user's home directory. Absolute and relative
 * paths without a leading `~` are returned unchanged.
 */
export function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/")) return join(homedir(), path.slice(2))
  return path
}

function readLinkTarget(path: string): string | undefined {
  try {
    return readlinkSync(path)
  } catch {
    return undefined
  }
}

/** Build one entry with lstat. Returns null when the name vanished or cannot be stated. */
function describeEntry(absolute: string, name: string): FsEntry | null {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(absolute)
  } catch {
    return null
  }
  const common = { id: absolute, state: "synced" as const }
  if (stat.isSymbolicLink()) {
    // Never follow symlinks; never send them (target could be /dev/zero, a
    // FIFO, or outside the shared tree). The target is shown for review.
    const symlinkTarget = readLinkTarget(absolute)
    return {
      ...common,
      name,
      kind: "file",
      bytes: 0,
      unsupported: "symlink",
      ...(symlinkTarget !== undefined ? { symlinkTarget } : {}),
    }
  }
  if (stat.isDirectory()) return { ...common, name: `${name}/`, kind: "directory", bytes: 0 }
  if (stat.isFile()) return { ...common, name, kind: "file", bytes: stat.size }
  const unsupported = stat.isFIFO() ? "FIFO" : stat.isSocket() ? "socket" : "special file"
  return { ...common, name, kind: "file", bytes: 0, unsupported }
}

/**
 * `FileSystemService` backed by the real local filesystem. Only the local
 * pane has a filesystem: the remote pane deliberately has none — the real
 * app must not show the receiver's files (out of scope).
 *
 * Symlinks are listed but never followed (lstat, never stat): a symlink is
 * reported as an unsupported file with size 0 and its readlink() target, so
 * directory cycles cannot be traversed. Special files are unsupported. Entries
 * that cannot be stated (vanished or unreadable) are skipped gracefully
 * instead of failing the whole listing.
 *
 * Listings are cached per directory and rebuilt when the directory's mtime or
 * ctime changes. An in-place size change of an existing file is not noticed
 * until the directory itself changes.
 */
export class RealFileSystemService implements FileSystemService {
  readonly paths: Record<Pane, string>
  /** Total visible entries in the last list() call (before any paging or cap). */
  lastListTotal = 0
  /** Error from the last list() call, if the directory could not be read. */
  lastListError: string | null = null
  private showHiddenFiles: boolean
  private cache: ListingCache | null = null

  listTotal(): number | undefined {
    return this.lastListTotal
  }

  listError(): string | null {
    return this.lastListError
  }

  constructor(rootDirectory: string = homedir(), options: RealFileSystemOptions = {}) {
    this.paths = { local: expandHome(rootDirectory), remote: "" }
    this.showHiddenFiles = options.showHidden ?? true
  }

  /** Whether dotfiles are listed. Staging partials are hidden either way. */
  get showHidden(): boolean {
    return this.showHiddenFiles
  }

  setShowHidden(show: boolean): void {
    this.showHiddenFiles = show
  }

  list(pane: Pane, path: string, options: ListOptions = {}): FsEntry[] {
    if (pane === "remote") return []
    const directory = expandHome(path)
    let cache: ListingCache
    try {
      const dirStat = statSync(directory)
      const key = `${dirStat.mtimeMs}:${dirStat.ctimeMs}:${this.showHiddenFiles}`
      if (this.cache?.directory === directory && this.cache.key === key && Date.now() - this.cache.builtAt < LISTING_CACHE_MAX_AGE_MS) {
        cache = this.cache
      } else {
        // Hide our own staging temp files: they must never be listed or sent.
        const names = readdirSync(directory)
          .filter((name) => !isTemporaryPartialName(name) && (this.showHiddenFiles || !name.startsWith(".")))
          .sort()
        cache = { directory, key, builtAt: Date.now(), names, built: new Map() }
        this.cache = cache
      }
      this.lastListError = null
    } catch (error) {
      this.cache = null
      this.lastListError = error instanceof Error ? error.message : String(error)
      this.lastListTotal = 0
      return []
    }

    this.lastListTotal = cache.names.length
    const start = Math.min(Math.max(0, Math.floor(options.offset ?? 0)), cache.names.length)
    const limit = Math.max(0, Math.floor(options.limit ?? MAX_DIRECTORY_ENTRIES))
    const entries: FsEntry[] = []
    for (const name of cache.names.slice(start, start + limit)) {
      let entry = cache.built.get(name)
      if (entry === undefined) {
        entry = describeEntry(join(cache.directory, name), name)
        cache.built.set(name, entry)
      }
      if (entry) entries.push(entry)
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
