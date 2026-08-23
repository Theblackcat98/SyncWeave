import { BoxRenderable } from "@opentui/core"
import { COLORS, SIZING, stateColor, stateGlyph } from "../theme"
import type { Pane } from "../types"
import { box, text } from "./components"
import type { UiContext } from "./context"

export function buildPane(ctx: UiContext, pane: Pane, title: string, path: string): BoxRenderable {
  const files = ctx.filesystem.filesFor(pane)
  const focused = ctx.state.activePane === pane
  const panel = box(ctx.renderer, {
    id: `${pane}-pane`,
    flexGrow: 1,
    flexDirection: "column",
    border: true,
    borderColor: focused ? COLORS.focus : COLORS.border,
    title: `${title}  ${path}`,
    titleAlignment: "left",
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 1,
  })

  const cursor = pane === "local" ? ctx.state.localCursor : ctx.state.remoteCursor

  files.forEach((file, index) => {
    const row = box(ctx.renderer, {
      id: `${pane}-row-${index}`,
      height: 1,
      flexDirection: "row",
      backgroundColor: index === cursor && focused ? COLORS.selected : COLORS.surface,
    })
    const marker = file.selected ? "✓" : " "
    const content = `${marker} ${stateGlyph(file.state)} ${file.icon} ${file.name.padEnd(SIZING.fileNameColumnWidth)} ${file.size.padStart(SIZING.fileSizeColumnWidth)}  ${file.state}`
    row.add(text(ctx.renderer, content, index === cursor && focused ? COLORS.text : stateColor(file.state), `${pane}-text-${index}`))
    panel.add(row)
  })
  return panel
}

export function addWorkspace(ctx: UiContext, root: BoxRenderable): void {
  const workspace = box(ctx.renderer, {
    id: "workspace",
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
    marginTop: 1,
    marginBottom: 1,
  })
  workspace.add(buildPane(ctx, "local", "LOCAL WORKSPACE", "~/projects/notes"))
  workspace.add(buildPane(ctx, "remote", "REMOTE STAGING", "MacBook-M3: ~/notes"))
  root.add(workspace)
}
