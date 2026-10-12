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
 */
import { accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { resolveStateDir } from "./diagnostic-log.js"

const FILE_NAME = "destinations.json"

/** Load saved destinations; the default directory is always first. */
export function loadDestinations(defaultDir: string): string[] {
  const dir = resolveStateDir()
  if (!dir) return [defaultDir]
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, FILE_NAME), "utf8"))
    if (!Array.isArray(raw)) return [defaultDir]
    const valid = raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    // Default dir is always first; drop duplicates (seen-before wins).
    const seen = new Set<string>([defaultDir])
    const rest: string[] = []
    for (const d of valid) {
      if (!seen.has(d)) {
        seen.add(d)
        rest.push(d)
      }
    }
    return [defaultDir, ...rest]
  } catch {
    // Missing file, unreadable file, or corrupt JSON: start fresh.
    return [defaultDir]
  }
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

/**
 * Validate a user-typed destination path. Expands `~/`, resolves to an
 * absolute path, creates the directory (mode 0700, like ~/Downloads) when
 * missing, and requires it to be an existing writable directory.
 */
export function validateDestinationPath(raw: string): PathValidation {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: "empty path" }
  if (/[\0-\x1f\x7f]/.test(trimmed)) return { ok: false, reason: "path contains control characters" }
  const expanded =
    trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed
  const abs = isAbsolute(expanded) ? expanded : resolve(expanded)
  try {
    if (!statSync(abs).isDirectory()) return { ok: false, reason: "not a directory" }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, reason: `cannot access: ${(error as Error).message}` }
    }
    try {
      mkdirSync(abs, { recursive: true, mode: 0o700 })
    } catch (mkdirError) {
      return { ok: false, reason: `cannot create: ${(mkdirError as Error).message}` }
    }
  }
  try {
    accessSync(abs, constants.W_OK)
  } catch {
    return { ok: false, reason: "directory is not writable" }
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
