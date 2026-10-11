import { BoxRenderable, MouseButton, TextRenderable, type CliRenderer } from "@opentui/core"
import type { SyncState } from "../domain.js"
import { icons, theme } from "../theme.js"

export type CommandHandler = (command: string) => void

export function label(renderer: CliRenderer, id: string, content: string, fg: string = theme.color.text): TextRenderable {
  return new TextRenderable(renderer, { id, content, fg })
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
  options: { fg?: string; bg?: string; disabled?: boolean } = {},
): BoxRenderable {
  const fg = options.disabled ? theme.component.disabled : options.fg ?? theme.component.active
  const item = new BoxRenderable(renderer, {
    id,
    height: 1,
    flexDirection: "row",
    paddingLeft: 1,
    paddingRight: 1,
    marginRight: 1,
    backgroundColor: options.disabled ? theme.color.surface : options.bg ?? theme.color.surfaceRaised,
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
    flexDirection: compact ? "column" : "row",
    flexWrap: "wrap",
    gap: compact ? 0 : 1,
    marginTop: 1,
  })
  buttons.forEach((button) => row.add(button))
  return row
}

export function truncate(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  if (value.length <= maxWidth) return value
  if (maxWidth <= 1) return value.slice(0, maxWidth)
  return `${value.slice(0, maxWidth - 1)}…`
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
  const partials = ["", "⡀", "⡄", "⡆", "⡇", "⣇", "⣧", "⣷"]
  return "⣿".repeat(full) + (fraction ? partials[fraction] : "") + "⣀".repeat(Math.max(0, safeWidth - full - (fraction ? 1 : 0)))
}
