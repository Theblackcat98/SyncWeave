/**
 * Persistent diagnostic log. Failures in the TUI are otherwise ephemeral
 * status-line text; this gives users something to attach to a bug report.
 *
 * Location: $XDG_STATE_HOME/syncweave/syncweave.log, falling back to
 * ~/.local/share/syncweave/syncweave.log. Best effort: logging never throws.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

let stateDir: string | null = null
let stateDisabled = false

/** Resolve (creating) the state dir. Exported for destinations.json. */
export function resolveStateDir(): string | null {
  if (stateDir) return stateDir
  if (stateDisabled) return null
  try {
    const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "share")
    stateDir = join(base, "syncweave")
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    return stateDir
  } catch {
    stateDisabled = true
    return null
  }
}

/** Append a timestamped line to the diagnostic log. Never throws. */
export function logEvent(event: string, detail?: string): void {
  try {
    const dir = resolveStateDir()
    if (!dir) return
    const ts = new Date().toISOString()
    appendFileSync(join(dir, "syncweave.log"), `${ts} ${event}${detail ? ` ${detail}` : ""}\n`)
  } catch {
    // Logging is best effort.
  }
}

/** For tests: reset the cached path. */
export function resetLogPathForTests(): void {
  stateDir = null
  stateDisabled = false
}
