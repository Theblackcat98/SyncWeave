import { BoxRenderable } from "@opentui/core"
import { COLORS, SIZING } from "../theme"
import { formatBytes } from "../utils"
import { box, text } from "./components"
import type { UiContext } from "./context"

export function addActivity(ctx: UiContext, root: BoxRenderable): void {
  const snapshot = ctx.transfers.snapshot()
  const transferring = snapshot.state === "transferring"
  const activity = box(ctx.renderer, {
    id: "activity-panel",
    height: SIZING.activityHeight,
    border: true,
    borderColor: transferring ? COLORS.focus : COLORS.border,
    flexDirection: "column",
    paddingLeft: 1,
  })
  const selected = ctx.filesystem.selectedFiles()
  const selectedLabel = selected.length === 0 ? "No staged files" : `${selected.length} staged • ${formatBytes(ctx.filesystem.selectedBytes())}`
  const filled = Math.floor((snapshot.progress / 100) * SIZING.activityGaugeWidth)
  const gauge = "█".repeat(filled) + "░".repeat(SIZING.activityGaugeWidth - filled)
  const stream = transferring
    ? `${snapshot.activeFileName}  [chunk ${snapshot.chunkIndex}/${snapshot.chunkTotal}]`
    : ctx.state.status
  activity.add(text(ctx.renderer, `Active Stream: ${stream}`, COLORS.text, "activity-status"))
  activity.add(
    text(
      ctx.renderer,
      `Progress: ⣾⣷⣯⣟⡿⢿  [${gauge}] ${snapshot.progress}%  •  ${selectedLabel}`,
      transferring ? COLORS.focus : COLORS.muted,
      "activity-progress",
    ),
  )
  root.add(activity)
}
