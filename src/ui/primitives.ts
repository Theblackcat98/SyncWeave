import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"
import { BORDERS, COLORS, SPACING } from "./theme"

export function createPanel(renderer: CliRenderer, id: string, options: Partial<ConstructorParameters<typeof BoxRenderable>[1]> = {}): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    border: BORDERS.panel,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    paddingLeft: SPACING.sm,
    paddingRight: SPACING.sm,
    ...options,
  })
}

export function createText(renderer: CliRenderer, id: string, content: string, fg = COLORS.text): TextRenderable {
  return new TextRenderable(renderer, { id, content, fg })
}

export function createActionRail(renderer: CliRenderer, content: string): BoxRenderable {
  const rail = new BoxRenderable(renderer, {
    id: "action-rail",
    height: 2,
    flexDirection: "row",
    marginTop: SPACING.sm,
  })
  rail.add(createText(renderer, "action-rail-text", content))
  return rail
}

export function createModal(renderer: CliRenderer, id: string, accent = COLORS.focus): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    flexGrow: 1,
    flexDirection: "column",
    border: BORDERS.modal,
    borderColor: accent,
    backgroundColor: COLORS.surface,
    padding: SPACING.md,
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
  })
}
