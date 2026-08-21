import { BoxRenderable, RGBA, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core"
import { createInitialState, MOCK_DIFF } from "./domain/mock-data"
import type { AppState, MockFile, Pane } from "./domain/types"
import { SyncWeaveStore } from "./domain/store"
import { MockPeerService } from "./mocks/services"
import { createActionRail, createModal, createPanel, createText } from "./ui/primitives"
import { COLORS, DIMENSIONS, stateColor, stateGlyph } from "./ui/theme"

const store = new SyncWeaveStore()
let renderer: CliRenderer
let transferTimer: ReturnType<typeof setInterval> | undefined
let pairingTimer: ReturnType<typeof setInterval> | undefined
const peerService = new MockPeerService(createInitialState().peers)

function filesFor(state: AppState, pane: Pane): MockFile[] { return pane === "local" ? state.localFiles : state.remoteFiles }
function cursorFor(state: AppState, pane: Pane): number { return pane === "local" ? state.localCursor : state.remoteCursor }
function formatBytes(bytes: number): string { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB` }
function selectedFiles(state: AppState): MockFile[] { return [...state.localFiles, ...state.remoteFiles].filter((file) => file.selected && file.kind === "file") }

function qrBlock(seed: number): string[] {
  const size = 13
  return Array.from({ length: size }, (_, y) => {
    let line = ""
    for (let x = 0; x < size; x += 1) {
      const finder = (x < 5 && y < 5) || (x >= 8 && y < 5) || (x < 5 && y >= 8)
      const border = finder && (x === 0 || x === 4 || y === 0 || y === 4 || (x >= 8 && x === 8) || (y >= 8 && y === 8))
      const center = finder && ((x >= 1 && x <= 3 && y >= 1 && y <= 3) || (x >= 9 && x <= 11 && y >= 1 && y <= 3) || (x >= 1 && x <= 3 && y >= 9 && y <= 11))
      const data = ((x * 17 + y * 31 + seed * 7) % 5) < 2
      line += border || center || data ? "██" : "  "
    }
    return line
  })
}

function buildPane(state: AppState, pane: Pane, title: string, path: string): BoxRenderable {
  const files = filesFor(state, pane)
  const cursor = cursorFor(state, pane)
  const focused = state.activePane === pane
  const panel = createPanel(renderer, `${pane}-pane`, { flexGrow: 1, flexDirection: "column", borderColor: focused ? COLORS.focus : COLORS.border, title: `${title}  ${path}`, titleAlignment: "left", paddingTop: 1 })
  files.forEach((file, index) => {
    const row = new BoxRenderable(renderer, { id: `${pane}-row-${index}`, height: 1, flexDirection: "row", backgroundColor: index === cursor && focused ? COLORS.selected : COLORS.surface })
    const marker = file.selected ? "✓" : " "
    const content = `${marker} ${stateGlyph(file.state)} ${file.icon} ${file.name.padEnd(28)} ${file.size.padStart(7)}  ${file.state}`
    row.add(createText(renderer, `${pane}-text-${index}`, content, index === cursor && focused ? COLORS.text : stateColor(file.state)))
    panel.add(row)
  })
  return panel
}

function addHeader(root: BoxRenderable, state: AppState): void {
  const onlinePeers = peerService.listPeers().filter((peer) => peer.status === "online").length
  const header = createPanel(renderer, "header", { height: DIMENSIONS.headerHeight, flexDirection: "row", paddingLeft: 1, paddingRight: 1 })
  header.add(createText(renderer, "brand", "SyncWeave", COLORS.focus))
  header.add(createText(renderer, "version", "  v0.1.0", COLORS.muted))
  header.add(createText(renderer, "header-space", "                         "))
  header.add(createText(renderer, "mdns", "● mDNS: Active", COLORS.success))
  header.add(createText(renderer, "peers", `  • Peers: ${onlinePeers} Online`, COLORS.remote))
  header.add(createText(renderer, "connection", `  • ${state.connectedPeerId ? "Connected" : "Disconnected"}`, state.connectedPeerId ? COLORS.success : COLORS.muted))
  root.add(header)
}
function addFooter(root: BoxRenderable, content: string): void { root.add(createActionRail(renderer, content)) }
function addActivity(root: BoxRenderable, state: AppState): void {
  const selected = selectedFiles(state)
  const progress = state.transfer?.progress ?? 0
  const gaugeSize = 28
  const filled = Math.floor((progress / 100) * gaugeSize)
  const gauge = "█".repeat(filled) + "░".repeat(gaugeSize - filled)
  const selectedLabel = selected.length === 0 ? "No staged files" : `${selected.length} staged • ${formatBytes(selected.reduce((sum, file) => sum + file.bytes, 0))}`
  const stream = state.transfer?.state === "transferring" ? `architecture-diagram.md  [chunk ${Math.max(1, Math.ceil(progress / 8))}/13]` : state.status
  const activity = createPanel(renderer, "activity-panel", { height: DIMENSIONS.activityHeight, borderColor: state.transfer?.state === "transferring" ? COLORS.focus : COLORS.border, flexDirection: "column" })
  activity.add(createText(renderer, "activity-status", `Active Stream: ${stream}`))
  activity.add(createText(renderer, "activity-progress", `Progress: ⣾⣷⣯⣟⡿⢿  [${gauge}] ${progress}%  •  ${selectedLabel}`, state.transfer?.state === "transferring" ? COLORS.focus : COLORS.muted))
  root.add(activity)
}
function addModal(root: BoxRenderable, title: string, lines: string[], accent = COLORS.focus): void {
  const modal = createModal(renderer, "modal", accent)
  modal.add(createText(renderer, "modal-title", `╭─ ${title} ─╮`, accent))
  lines.forEach((line, index) => modal.add(createText(renderer, `modal-line-${index}`, line)))
  root.add(modal)
}
function renderPairing(root: BoxRenderable, state: AppState): void {
  const qr = qrBlock(42).map((line) => `    ${line}`)
  const pairingStatus = ["Waiting for peer…", "Peer discovered — authenticating…", "Connected — pairing complete!"][state.pairingStep]
  addModal(root, "Peer Pairing · Scan with Camera or Termux", ["", ...qr, "", "    Code: 8492-AXQ1     Relay: Direct P2P", "    Auth: Ed25519 Ephemeral", `    ${pairingStatus}`, "", "    [Esc] Cancel"], state.pairingStep === 2 ? COLORS.success : COLORS.remote)
  addFooter(root, "[Enter] Simulate Scan  [Esc] Cancel  [Ctrl+C] Exit")
}
function renderDiff(root: BoxRenderable, state: AppState): void {
  const lines = MOCK_DIFF.map((line) => `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "} ${String(line.line).padStart(2, "0")}  ${line.local.padEnd(38)} │ ${line.remote}`)
  addModal(root, "Diff Inspector · architecture-diagram.md", ["", " LOCAL                                      REMOTE", "────────────────────────────────────────────────────────────────", ...lines, "", `  ~ 2 changed hunks   Hunk ${state.selectedHunk + 1}/2`, "", "  [Tab] Next Hunk   [Enter] Stage Hunk   [Esc] Close"], COLORS.warning)
  addFooter(root, "[Tab] Next Hunk  [Enter] Stage Hunk  [Esc] Close  [Ctrl+C] Exit")
}
function renderTransfer(root: BoxRenderable, state: AppState): void {
  const transfer = state.transfer
  const progress = transfer?.progress ?? 0
  const complete = transfer?.state === "complete"
  const selected = selectedFiles(state)
  const filled = Math.floor((progress / 100) * 34)
  const gauge = "█".repeat(filled) + "░".repeat(34 - filled)
  addModal(root, "Sync Staged Changes", ["", complete ? "✓ Transfer complete — workspace synchronized" : "⠋ Transferring staged files…", "", `  ${gauge}  ${progress}%`, `  Speed: ${complete ? "—" : `${transfer?.speedMbps.toFixed(1) ?? "14.2"} MB/s`}    ETA: ${complete ? "done" : `${transfer?.etaSeconds ?? 1}s`}`, "", `  Files: ${selected.length || transfer?.fileIds.length || 0}    Size: ${formatBytes(transfer?.bytesTotal ?? selected.reduce((sum, file) => sum + file.bytes, 0))}`, "", complete ? "  [Enter] Return to Workspace" : "  [Esc] Cancel"], complete ? COLORS.success : COLORS.focus)
  addFooter(root, complete ? "[Enter] Return  [Ctrl+C] Exit" : "[Esc] Cancel  [Ctrl+C] Exit")
}
function buildUI(): void {
  const state = store.getState()
  renderer.root.removeAll()
  const root = new BoxRenderable(renderer, { id: "root", flexGrow: 1, flexDirection: "column", backgroundColor: COLORS.background, padding: 1 })
  renderer.root.add(root)
  addHeader(root, state)
  if (state.screen === "workspace") {
    const workspace = new BoxRenderable(renderer, { id: "workspace", flexGrow: 1, flexDirection: "row", gap: 1, marginTop: 1, marginBottom: 1 })
    workspace.add(buildPane(state, "local", "LOCAL WORKSPACE", state.localPath))
    workspace.add(buildPane(state, "remote", "REMOTE STAGING", `${state.connectedPeerId ? "MacBook-M3: " : "Remote: "}${state.remotePath}`))
    root.add(workspace)
    addActivity(root, state)
    addFooter(root, "[↑↓] Navigate  [Tab] Pane  [Space] Stage  [s] Sync  [d] Diff  [q] Pair  [?] Help  [Ctrl+C] Exit")
  } else if (state.screen === "pairing") renderPairing(root, state)
  else if (state.screen === "diff") renderDiff(root, state)
  else renderTransfer(root, state)
}
function stopTimer(timer: ReturnType<typeof setInterval> | undefined): void { if (timer) clearInterval(timer) }
function startPairing(): void {
  stopTimer(pairingTimer)
  peerService.cancelPairing()
  void peerService.beginPairing("peer:macbook")
  store.dispatch({ type: "open-pairing" })
  buildUI()
  pairingTimer = setInterval(() => {
    store.dispatch({ type: "pairing-step" })
    buildUI()
    if (store.getState().pairingStep >= 2) stopTimer(pairingTimer)
  }, 900)
}
function startTransfer(): void {
  store.dispatch({ type: "start-transfer" })
  if (!store.getState().transfer) return void buildUI()
  stopTimer(transferTimer)
  buildUI()
  transferTimer = setInterval(() => {
    store.dispatch({ type: "tick-transfer" })
    if (store.getState().transfer?.state === "complete") {
      store.dispatch({ type: "complete-transfer" })
      stopTimer(transferTimer)
    }
    buildUI()
  }, 180)
}
function handleKey(key: KeyEvent): void {
  if (key.ctrl && key.name === "c") {
    stopTimer(transferTimer)
    stopTimer(pairingTimer)
    renderer.stop()
    return
  }
  const state = store.getState()
  if (state.screen === "pairing") {
    if (key.name === "escape") {
      stopTimer(pairingTimer)
      peerService.cancelPairing()
      store.dispatch({ type: "cancel-pairing" })
      buildUI()
    }
    return
  }
  if (state.screen === "diff") {
    if (key.name === "escape") store.dispatch({ type: "close-overlay" })
    else if (key.name === "tab") store.dispatch({ type: "next-hunk" })
    else if (key.name === "return") store.dispatch({ type: "stage-hunk" })
    buildUI()
    return
  }
  if (state.screen === "transfer") {
    if (key.name === "escape" && state.transfer?.state === "transferring") {
      stopTimer(transferTimer)
      store.dispatch({ type: "cancel-transfer" })
      buildUI()
    } else if (key.name === "return" && state.transfer?.state === "complete") {
      store.dispatch({ type: "close-overlay" })
      store.dispatch({ type: "set-status", status: "Ready — select files to stage another mock transfer" })
      buildUI()
    }
    return
  }
  switch (key.name) {
    case "tab": store.dispatch({ type: "focus-pane", pane: state.activePane === "local" ? "remote" : "local" }); break
    case "up": store.dispatch({ type: "move-cursor", delta: -1 }); break
    case "down": store.dispatch({ type: "move-cursor", delta: 1 }); break
    case "space": store.dispatch({ type: "toggle-selection" }); break
    case "s": startTransfer(); return
    case "d": {
      const files = filesFor(state, state.activePane)
      const cursor = cursorFor(state, state.activePane)
      if (files[cursor]?.state === "modified") store.dispatch({ type: "open-diff" })
      else store.dispatch({ type: "set-status", status: `No divergence to inspect: ${files[cursor]?.name ?? "selection"}` })
      break
    }
    case "q": startPairing(); return
    case "?": store.dispatch({ type: "set-status", status: "Help: Tab panes • Space stage • s sync • d diff • q pair" }); break
    default: return
  }
  buildUI()
}
async function main(): Promise<void> {
  renderer = await createCliRenderer({ exitOnCtrlC: false })
  renderer.setBackgroundColor(RGBA.fromHex(COLORS.background))
  renderer.keyInput.on("keypress", handleKey)
  buildUI()
  renderer.start()
}
await main()
