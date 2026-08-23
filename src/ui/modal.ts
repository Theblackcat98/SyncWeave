import { BoxRenderable } from "@opentui/core"
import { COLORS, SPACING } from "../theme"
import { box, text } from "./components"
import type { UiContext } from "./context"

export function addModal(ctx: UiContext, root: BoxRenderable, title: string, lines: string[], accent: string = COLORS.focus): void {
  const modal = box(ctx.renderer, {
    id: "modal",
    flexGrow: 1,
    flexDirection: "column",
    border: true,
    borderColor: accent,
    backgroundColor: COLORS.surface,
    padding: SPACING.modalPadding,
    marginTop: 1,
    marginBottom: 1,
  })
  modal.add(text(ctx.renderer, `╭─ ${title} ─╮`, accent, "modal-title"))
  for (const [index, line] of lines.entries()) modal.add(text(ctx.renderer, line, COLORS.text, `modal-line-${index}`))
  root.add(modal)
}
