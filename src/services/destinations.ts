/**
 * Receive-destination management (issue #27).
 *
 * The receiver picks where incoming files land. Destinations persist across
 * restarts in `destinations.json` under the same state dir as the diagnostic
 * log ($XDG_STATE_HOME/syncweave, falling back to ~/.local/share/syncweave).
 *
 * Invariants:
 * - The first entry is always the default receive directory (~/Downloads);
 *   it can never be removed.
 * - At least one destination always exists.
 * - Persistence is best effort: corrupt or missing files fall back to the
 *   default; writes never throw.
 * - Persisted entries are re-validated on load; invalid ones are dropped.
 */
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { resolveStateDir } from "./diagnostic-log.js"

const FILE_NAME = "destinations.json"

export interface LoadedDestinations {
  /** Default directory first, then every persisted entry that re-validated. */
  dests: string[]
  /** Persisted entries dropped on load, with the reason from validateDestinationPath. */
  dropped: Array<{ path: string; reason: string }>
}

/**
 * Load saved destinations; the default directory is always first. Persisted
 * entries are re-validated (nothing is created) and dropped with a reason.
 */
export function loadDestinationsDetailed(defaultDir: string): LoadedDestinations {
  const dir = resolveStateDir()
  if (!dir) return { dests: [defaultDir], dropped: [] }
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, FILE_NAME), "utf8"))
    if (!Array.isArray(raw)) return { dests: [defaultDir], dropped: [] }
    const valid = raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    // Default dir is always first; drop duplicates (seen-before wins).
    const seen = new Set<string>([defaultDir])
    const rest: string[] = []
    const dropped: Array<{ path: string; reason: string }> = []
    for (const d of valid) {
      const checked = validateDestinationPath(d)
      if (!checked.ok) {
        dropped.push({ path: d, reason: checked.reason })
        continue
      }
      if (!seen.has(checked.dir)) {
        seen.add(checked.dir)
        rest.push(checked.dir)
      }
    }
    return { dests: [defaultDir, ...rest], dropped }
  } catch {
    // Missing file, unreadable file, or corrupt JSON: start fresh.
    return { dests: [defaultDir], dropped: [] }
  }
}

/** Load saved destinations; the default directory is always first. */
export function loadDestinations(defaultDir: string): string[] {
  return loadDestinationsDetailed(defaultDir).dests
}

/** Persist destinations atomically-ish (temp file + rename). Never throws. */
export function saveDestinations(dests: readonly string[]): void {
  try {
    const dir = resolveStateDir()
    if (!dir) return
    const target = join(dir, FILE_NAME)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, `${JSON.stringify(dests, null, 2)}\n`)
    renameSync(tmp, target)
  } catch {
    // Best effort: the in-session list still works.
  }
}

export type PathValidation = { ok: true; dir: string } | { ok: false; reason: string }

export interface ValidateDestinationOptions {
  /** Create a missing directory (mode 0700). Honoured only under $HOME. */
  create?: boolean
}

/** Top-level system trees a receive destination may never be inside. */
const SYSTEM_TOP_LEVEL = new Set(["bin", "boot", "dev", "etc", "proc", "sbin", "sys", "usr"])

function isWithin(path: string, base: string): boolean {
  if (path === base) return true
  if (base === sep) return path.startsWith(sep)
  return path.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** The system tree `abs` falls inside, if any (`/var/tmp` is allowed). */
function systemTreeOf(abs: string): string | null {
  const top = abs.split(sep).filter(Boolean)[0] ?? ""
  if (top === "var") return isWithin(abs, "/var/tmp") ? null : "/var"
  if (SYSTEM_TOP_LEVEL.has(top) || top.startsWith("lib")) return `/${top}`
  return null
}

/** The first of `path` and its ancestors that is world-writable without the sticky bit. */
function worldWritableWithoutSticky(path: string): string | null {
  let current = path
  for (;;) {
    const mode = statSync(current).mode
    if ((mode & 0o002) !== 0 && (mode & 0o1000) === 0) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Validate a receive destination. Used when adding one, when loading persisted
 * ones, and by callers right before a receive accepts a transfer.
 *
 * Accepted input is an absolute path or `~/…` (the current user's home only;
 * `~user` and relative paths are rejected). Refused: the filesystem root;
 * system trees (/bin /boot /dev /etc /lib* /proc /sbin /sys /usr /var, except
 * /var/tmp); /root unless it is $HOME; any dot-directory below $HOME (~/.ssh,
 * ~/.config, …); symlinks; and directories that are world-writable without the
 * sticky bit, or sit under such a directory. A missing directory is created
 * only when `options.create` is set, and then only under $HOME.
 */
export function validateDestinationPath(raw: string, options: ValidateDestinationOptions = {}): PathValidation {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: "empty path" }
  if (/[\0-\x1f\x7f]/.test(trimmed)) return { ok: false, reason: "path contains control characters" }
  const home = resolve(homedir())
  let abs: string
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    abs = resolve(join(home, trimmed.slice(1)))
  } else if (trimmed.startsWith("~")) {
    return { ok: false, reason: "only ~/ (your own home directory) is supported" }
  } else if (!isAbsolute(trimmed)) {
    return { ok: false, reason: "path must be absolute or start with ~/" }
  } else {
    abs = resolve(trimmed)
  }

  if (abs === sep) return { ok: false, reason: "the filesystem root cannot be a destination" }
  const system = systemTreeOf(abs)
  if (system) return { ok: false, reason: `${system} is a system directory` }
  if (isWithin(abs, "/root") && !isWithin(abs, home)) {
    return { ok: false, reason: "/root is only allowed when it is your home directory" }
  }
  const underHome = isWithin(abs, home)
  const pathBelowHome = underHome ? relative(home, abs) : abs
  const dotPart = pathBelowHome.split(sep).find((part) => part.startsWith("."))
  if (dotPart !== undefined) return { ok: false, reason: `dot-directories are not allowed (${dotPart})` }

  try {
    let existing: ReturnType<typeof lstatSync>
    try {
      existing = lstatSync(abs)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { ok: false, reason: `cannot access: ${(error as Error).message}` }
      }
      if (!options.create) return { ok: false, reason: "directory does not exist" }
      if (!underHome) return { ok: false, reason: "directories can only be created under your home directory" }
      try {
        mkdirSync(abs, { recursive: true, mode: 0o700 })
      } catch (mkdirError) {
        return { ok: false, reason: `cannot create: ${(mkdirError as Error).message}` }
      }
      existing = lstatSync(abs)
    }
    if (existing.isSymbolicLink()) return { ok: false, reason: "symbolic links are not allowed as destinations" }
    if (!existing.isDirectory()) return { ok: false, reason: "not a directory" }
    const unsafe = worldWritableWithoutSticky(abs)
    if (unsafe) return { ok: false, reason: `world-writable without the sticky bit: ${unsafe}` }
    accessSync(abs, constants.W_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EACCES" || code === "EPERM") return { ok: false, reason: "directory is not writable" }
    return { ok: false, reason: `cannot access: ${(error as Error).message}` }
  }
  return { ok: true, dir: abs }
}

/** Append a validated directory; duplicates are a no-op. */
export function addDestination(dests: readonly string[], dir: string): string[] {
  return dests.includes(dir) ? [...dests] : [...dests, dir]
}

export interface RemoveResult {
  dests: string[]
  removed: string | null
  reason?: string
}

/**
 * Remove the destination at `index`. The default (index 0) and the last
 * remaining destination are protected.
 */
export function removeDestination(dests: readonly string[], index: number): RemoveResult {
  if (index <= 0) return { dests: [...dests], removed: null, reason: "the default destination cannot be removed" }
  if (dests.length <= 1) return { dests: [...dests], removed: null, reason: "cannot remove the last destination" }
  if (index >= dests.length) return { dests: [...dests], removed: null, reason: "no destination at that position" }
  const removed = dests[index]!
  return { dests: dests.filter((_, i) => i !== index), removed }
}

/** Advance the active-destination index with wraparound. */
export function cycleDestinationIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return (index + 1) % length
}
