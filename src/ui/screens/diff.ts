import { BoxRenderable } from "@opentui/core"
import { COLORS } from "../../theme"
import { mockDiffRows, DIFF_FILE_NAME } from "../../services/mock-diff"
import { addFooter } from "../components"
import type { UiContext } from "../context"
import { addModal } from "../modal"

export function renderDiff(ctx: UiContext, root: BoxRenderable): void {
  const rows = mockDiffRows()
  addModal(ctx, root, `Diff Inspector · ${DIFF_FILE_NAME}`, [
    "",
    " LOCAL                                      REMOTE",
    "────────────────────────────────────────────────────────────────",
    ...rows.map(({ label, left, right }) => `${label.padEnd(5)} ${left.padEnd(39)} │ ${right}`),
    "",
    "  ~ 2 changed hunks   [Tab] Next Hunk   [Enter] Stage Hunk   [Esc] Close",
  ], COLORS.warning)
  addFooter(ctx, root, "[Tab] Next Hunk  [Enter] Stage Hunk  [Esc] Close  [Ctrl+C] Exit")
}
