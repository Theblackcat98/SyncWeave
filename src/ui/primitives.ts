import { BoxRenderable, MouseButton, TextRenderable, type CliRenderer } from "@opentui/core"
import type { SyncState } from "../domain.js"
import { icons, theme } from "../theme.js"

export type CommandHandler = (command: string) => void

/**
 * Single-cell glyphs with a one-cell ASCII stand-in. Used only in ASCII mode,
 * and only for swaps that keep the width, so truncated text stays aligned.
 * Strings from the app (status lines) are covered here too.
 */
const ASCII_SWAPS: ReadonlyArray<[string, string]> = [
  ["·", "|"], ["…", "."], ["—", "-"], ["→", ">"], ["←", "<"], ["↑", "^"], ["↓", "v"],
  ["▸", ">"], ["‹", "<"], ["›", ">"], ["●", "*"], ["○", "o"], ["◆", "*"], ["▌", "_"],
  ["█", "#"], ["✓", "x"], ["“", "\""], ["”", "\""], ["‘", "'"], ["’", "'"],
]

/** Swap display-only glyphs for ASCII when the ASCII icon set is active. */
export function asciiSafe(text: string): string {
  if (icons.dot !== "|") return text
  let out = text
  for (const [from, to] of ASCII_SWAPS) out = out.replaceAll(from, to)
  return out
}

export function label(renderer: CliRenderer, id: string, content: string, fg: string = theme.color.text): TextRenderable {
  // Labels never wrap: a wrapped line would paint over the row below it.
  // flexShrink 0: an overfull card clips its last rows instead of squeezing them onto each other.
  return new TextRenderable(renderer, { id, content: asciiSafe(content), fg, wrapMode: "none", flexShrink: 0 })
}

export function panel(
  renderer: CliRenderer,
  id: string,
  options: ConstructorParameters<typeof BoxRenderable>[1] = {},
): BoxRenderable {
  return new BoxRenderable(renderer, { id, flexDirection: "column", ...options })
}

export function actionButton(
  renderer: CliRenderer,
  id: string,
  caption: string,
  command: string,
  onCommand: CommandHandler,
  options: { fg?: string; disabled?: boolean } = {},
): BoxRenderable {
  const fg = options.disabled ? theme.component.disabled : options.fg ?? theme.component.active
  const item = new BoxRenderable(renderer, {
    id,
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    paddingLeft: 1,
    paddingRight: 1,
    marginRight: 1,
    backgroundColor: options.disabled ? theme.color.surface : theme.color.surfaceRaised,
    onMouseDown: (event) => {
      if (!options.disabled && event.button === MouseButton.LEFT) {
        event.stopPropagation()
        onCommand(command)
      }
    },
  })
  item.add(label(renderer, `${id}-label`, caption, fg))
  return item
}

export function actionRow(renderer: CliRenderer, id: string, buttons: BoxRenderable[], compact = false): BoxRenderable {
  const row = new BoxRenderable(renderer, {
    id,
    flexShrink: 0,
    flexDirection: compact ? "column" : "row",
    flexWrap: "wrap",
    gap: compact ? 0 : 1,
    marginTop: 1,
  })
  buttons.forEach((button) => row.add(button))
  return row
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/**
 * Cut to at most `maxWidth` terminal cells, at grapheme boundaries, with an
 * ellipsis when cut. Widths are display cells (CJK and emoji count as two),
 * never UTF-16 units (P2-9).
 */
export function truncate(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  if (Bun.stringWidth(value) <= maxWidth) return value
  const ellipsis = icons.ellipsis
  const ellipsisWidth = Bun.stringWidth(ellipsis)
  if (maxWidth <= ellipsisWidth) return ellipsis.slice(0, maxWidth)
  const budget = maxWidth - ellipsisWidth
  let out = ""
  let used = 0
  for (const { segment } of graphemes.segment(value)) {
    const width = Bun.stringWidth(segment)
    if (used + width > budget) break
    out += segment
    used += width
  }
  return out + ellipsis
}

export function stateGlyph(state: SyncState): string {
  return {
    synced: icons.synced,
    added: icons.added,
    modified: icons.modified,
    deleted: icons.deleted,
  }[state]
}

export function stateColor(state: SyncState): string {
  return {
    synced: theme.color.muted,
    added: theme.color.success,
    modified: theme.color.warning,
    deleted: theme.color.danger,
  }[state]
}

export function progressGauge(percent: number, width: number): string {
  const safeWidth = Math.max(1, width)
  const bounded = Math.max(0, Math.min(100, percent))
  const eighths = Math.round((bounded / 100) * safeWidth * 8)
  const full = Math.floor(eighths / 8)
  const fraction = eighths % 8
  const partial = fraction ? icons.gaugeEighths[fraction] ?? "" : ""
  return icons.gaugeFull.repeat(full) + partial + icons.gaugeEmpty.repeat(Math.max(0, safeWidth - full - (fraction ? 1 : 0)))
}
