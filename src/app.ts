import { BoxRenderable, RGBA } from "@opentui/core"
import type { CliRenderer, KeyEvent } from "@opentui/core"
import { AppState } from "./app-state"
import { createMockFilesystem } from "./services/mock-filesystem"
import { createMockPairing } from "./services/mock-pairing"
import { createMockPeers } from "./services/mock-peers"
import { createMockTransfers } from "./services/mock-transfers"
import type { FileEntry, Pane } from "./types"
import { addActivity } from "./ui/activity"
import { addFooter, addHeader } from "./ui/components"
import type { UiContext } from "./ui/context"
import { renderDiff } from "./ui/screens/diff"
import { renderPairing } from "./ui/screens/pairing"
import { renderTransfer } from "./ui/screens/transfer"
import { addWorkspace } from "./ui/workspace"
import { COLORS } from "./theme"

export type { UiContext } from "./ui/context"

export function createApp(renderer: CliRenderer): UiContext {
  const state = new AppState()
  const ctx: UiContext = {
    renderer,
    state,
    filesystem: createMockFilesystem(),
    peers: createMockPeers(),
    pairing: createMockPairing(),
    transfers: createMockTransfers(),
  }

  renderer.setBackgroundColor(RGBA.fromHex(COLORS.background))
  renderer.keyInput.on("keypress", handleKey(ctx))
  buildUI(ctx)
  return ctx
}

export function disposeApp(ctx: UiContext): void {
  ctx.pairing.cancel()
  ctx.transfers.cancel()
}

function cursorFor(ctx: UiContext, pane: Pane): number {
  return pane === "local" ? ctx.state.localCursor : ctx.state.remoteCursor
}

function setCursor(ctx: UiContext, pane: Pane, value: number): void {
  if (pane === "local") ctx.state.localCursor = value
  else ctx.state.remoteCursor = value
}

function buildUI(ctx: UiContext): void {
  for (const child of ctx.renderer.root.getChildren()) {
    ctx.renderer.root.remove(child)
  }
  const root = new BoxRenderable(ctx.renderer, {
    id: "root",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: COLORS.background,
    padding: 1,
  })
  ctx.renderer.root.add(root)
  addHeader(ctx, root)

  switch (ctx.state.screen) {
    case "workspace":
      addWorkspace(ctx, root)
      addActivity(ctx, root)
      addFooter(ctx, root, "[↑↓] Navigate  [Tab] Pane  [Space] Stage  [s] Sync  [d] Diff  [q] Pair  [?] Help  [Ctrl+C] Exit")
      break
    case "pairing":
      renderPairing(ctx, root)
      break
    case "diff":
      renderDiff(ctx, root)
      break
    case "transfer":
      renderTransfer(ctx, root)
      break
  }
}

function startPairing(ctx: UiContext): void {
  ctx.state.screen = "pairing"
  ctx.pairing.start(() => buildUI(ctx))
  buildUI(ctx)
}

function startTransfer(ctx: UiContext): void {
  const selected = ctx.filesystem.selectedFiles()
  if (selected.length === 0) {
    ctx.state.status = "Nothing staged — press Space on a file first"
    buildUI(ctx)
    return
  }
  ctx.transfers.start(selected, {
    onUpdate: () => buildUI(ctx),
    onComplete: (entries: readonly FileEntry[]) => {
      ctx.filesystem.markSynced(entries)
      ctx.state.status = "Sync complete — all staged changes are synchronized"
    },
  })
  ctx.state.screen = "transfer"
  buildUI(ctx)
}

function handleKey(ctx: UiContext): (key: KeyEvent) => void {
  return (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") {
      disposeApp(ctx)
      ctx.renderer.stop()
      return
    }

    switch (ctx.state.screen) {
      case "pairing":
        handlePairingKey(ctx, key.name)
        return
      case "diff":
        handleDiffKey(ctx, key.name)
        return
      case "transfer":
        handleTransferKey(ctx, key.name)
        return
      case "workspace":
        handleWorkspaceKey(ctx, key.name)
        return
    }
  }
}

function handlePairingKey(ctx: UiContext, name: string): void {
  if (name === "escape") {
    ctx.pairing.cancel()
    ctx.state.screen = "workspace"
    ctx.state.status = "Pairing cancelled"
    buildUI(ctx)
  }
}

function handleDiffKey(ctx: UiContext, name: string): void {
  switch (name) {
    case "escape":
      ctx.state.screen = "workspace"
      ctx.state.status = "Diff closed"
      buildUI(ctx)
      break
    case "tab":
      ctx.state.status = "Next diff hunk: Transport retry policy"
      buildUI(ctx)
      break
    case "return":
      ctx.state.status = "Mock hunk staged"
      buildUI(ctx)
      break
  }
}

function handleTransferKey(ctx: UiContext, name: string): void {
  const transferring = ctx.transfers.snapshot().state === "transferring"
  const complete = ctx.transfers.snapshot().state === "complete"
  if (name === "escape" && transferring) {
    ctx.transfers.cancel()
    ctx.state.screen = "workspace"
    ctx.state.status = "Mock transfer cancelled"
    buildUI(ctx)
  } else if (name === "return" && complete) {
    ctx.state.screen = "workspace"
    buildUI(ctx)
  }
}

function handleWorkspaceKey(ctx: UiContext, name: string): void {
  const files = ctx.filesystem.filesFor(ctx.state.activePane)
  const cursor = cursorFor(ctx, ctx.state.activePane)

  switch (name) {
    case "tab":
      ctx.state.activePane = ctx.state.activePane === "local" ? "remote" : "local"
      ctx.state.status = `Focused ${ctx.state.activePane} workspace`
      break
    case "up":
      setCursor(ctx, ctx.state.activePane, Math.max(0, cursor - 1))
      break
    case "down":
      setCursor(ctx, ctx.state.activePane, Math.min(files.length - 1, cursor + 1))
      break
    case "space": {
      ctx.filesystem.toggleAt(ctx.state.activePane, cursor)
      const file = files[cursor]
      if (file) ctx.state.status = `${file.selected ? "Staged" : "Unstaged"} ${file.name}`
      break
    }
    case "s":
      startTransfer(ctx)
      return
    case "d":
      if (files[cursor]?.state === "modified") {
        ctx.state.screen = "diff"
        buildUI(ctx)
      } else {
        ctx.state.status = `No divergence to inspect: ${files[cursor]?.name ?? ""}`
        buildUI(ctx)
      }
      return
    case "q":
      startPairing(ctx)
      return
    case "?":
      ctx.state.status = "Help: Tab panes • Space stage • s sync • d diff • q pair"
      break
    default:
      return
  }

  buildUI(ctx)
}
