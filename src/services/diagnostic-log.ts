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

let logPath: string | null = null
let logDisabled = false

function resolveLogPath(): string | null {
  if (logPath) return logPath
  if (logDisabled) return null
  try {
    const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "share")
    const dir = join(base, "syncweave")
    mkdirSync(dir, { recursive: true })
    logPath = join(dir, "syncweave.log")
    return logPath
  } catch {
    logDisabled = true
    return null
  }
}

/** Append a timestamped line to the diagnostic log. Never throws. */
export function logEvent(event: string, detail?: string): void {
  try {
    const path = resolveLogPath()
    if (!path) return
    const ts = new Date().toISOString()
    appendFileSync(path, `${ts} ${event}${detail ? ` ${detail}` : ""}\n`)
  } catch {
    // Logging is best effort.
  }
}

/** For tests: reset the cached path. */
export function resetLogPathForTests(): void {
  logPath = null
  logDisabled = false
}
