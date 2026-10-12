/**
 * Pure cursor-movement helpers for the TUI panes (P2-7). app.ts needs the
 * full OpenTUI renderer to instantiate, so the selection logic lives here
 * as pure functions that the app delegates to and the tests drive directly.
 */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Step a pane cursor by `delta` rows over `entryCount` entries.
 * The cursor never leaves [0, entryCount - 1]; an empty list pins at 0.
 * This is the receiver-pane peer cycling (Tab to the pane, up/down to
 * choose) with the renderer stripped out.
 */
export function stepCursor(cursor: number, delta: number, entryCount: number): number {
  return clamp(cursor + delta, 0, Math.max(0, entryCount - 1))
}
