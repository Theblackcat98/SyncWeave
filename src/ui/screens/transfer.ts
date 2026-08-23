import { BoxRenderable } from "@opentui/core"
import { COLORS, SIZING } from "../../theme"
import { formatBytes } from "../../utils"
import { addFooter } from "../components"
import type { UiContext } from "../context"
import { addModal } from "../modal"

export function renderTransfer(ctx: UiContext, root: BoxRenderable): void {
  const snapshot = ctx.transfers.snapshot()
  const complete = snapshot.state === "complete"
  const stateLine = complete ? "✓ Transfer complete — workspace synchronized" : "⠋ Transferring staged files…"
  const filled = Math.floor((snapshot.progress / 100) * SIZING.transferGaugeWidth)
  const gauge = "█".repeat(filled) + "░".repeat(SIZING.transferGaugeWidth - filled)
  const eta = complete ? "done" : `${Math.max(0, Math.ceil((100 - snapshot.progress) / 18) / 10).toFixed(1)}s`
  addModal(ctx, root, "Sync Staged Changes", [
    "",
    stateLine,
    "",
    `  ${gauge}  ${snapshot.progress}%`,
    `  Speed: ${complete ? "—" : "14.2 MB/s"}    ETA: ${eta}`,
    "",
    `  Files: ${ctx.filesystem.selectedFiles().length}    Size: ${formatBytes(ctx.filesystem.selectedBytes())}`,
    "",
    complete ? "  [Enter] Return to Workspace" : "  [Esc] Cancel",
  ], complete ? COLORS.success : COLORS.focus)
  addFooter(ctx, root, complete ? "[Enter] Return  [Ctrl+C] Exit" : "[Esc] Cancel  [Ctrl+C] Exit")
}
