import {
  BoxRenderable,
  RGBA,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core"

type SyncState = "synced" | "added" | "modified" | "deleted"
type Pane = "local" | "remote"
type Screen = "workspace" | "pairing" | "diff" | "transfer"
type TransferState = "idle" | "transferring" | "complete"

type MockFile = {
  name: string
  icon: string
  size: string
  bytes: number
  state: SyncState
  selected: boolean
}

const COLORS = {
  background: "#12131C",
  surface: "#1E1E2E",
  selected: "#263244",
  border: "#64748B",
  focus: "#38BDF8",
  remote: "#A855F7",
  success: "#4ADE80",
  warning: "#FBBF24",
  danger: "#F87171",
  muted: "#94A3B8",
  text: "#E2E8F0",
}

const localFiles: MockFile[] = [
  { name: "architecture-diagram.md", icon: "󰈙", size: "12 KB", bytes: 12288, state: "modified", selected: false },
  { name: "daily-todo.txt", icon: "󰈙", size: "2 KB", bytes: 2048, state: "synced", selected: false },
  { name: "configs/", icon: "󰒓", size: "—", bytes: 0, state: "modified", selected: false },
  { name: "build-artifact.tar.gz", icon: "󰡨", size: "45 MB", bytes: 47185920, state: "added", selected: false },
]

const remoteFiles: MockFile[] = [
  { name: "architecture-diagram.md", icon: "󰈙", size: "14 KB", bytes: 14336, state: "modified", selected: false },
  { name: "daily-todo.txt", icon: "󰈙", size: "2 KB", bytes: 2048, state: "synced", selected: false },
  { name: "configs/", icon: "󰒓", size: "—", bytes: 0, state: "modified", selected: false },
  { name: "release-v1.tar.gz", icon: "󰡨", size: "45 MB", bytes: 47185920, state: "added", selected: false },
]

const diffLines = [
  ["  01", "# SyncWeave Architecture", "# SyncWeave Architecture"],
  ["  02", "", ""],
  ["  03", "## Transport", "## Transport"],
  ["- 04", "- WebSocket fallback", ""],
  ["+ 04", "", "+ QUIC primary transport"],
  ["  05", "- Chunked streams", "- Chunked streams"],
  ["- 06", "- Retry: 3", ""],
  ["+ 06", "", "+ Retry: adaptive"],
  ["  07", "", ""],
  ["  08", "## State", "## State"],
  ["  09", "Preview before sync", "Preview before sync"],
]

let renderer: CliRenderer
let activePane: Pane = "local"
let localCursor = 0
let remoteCursor = 0
let screen: Screen = "workspace"
let status = "Ready — select files to stage a mock transfer"
let transferState: TransferState = "idle"
let transferProgress = 0
let pairingStep = 0
let transferTimer: ReturnType<typeof setInterval> | undefined
let pairingTimer: ReturnType<typeof setInterval> | undefined

function stateGlyph(state: SyncState): string {
  return { synced: "•", added: "+", modified: "~", deleted: "-" }[state]
}

function stateColor(state: SyncState): string {
  return { synced: COLORS.muted, added: COLORS.success, modified: COLORS.warning, deleted: COLORS.danger }[state]
}

function text(content: string, fg: string, id: string): TextRenderable {
  return new TextRenderable(renderer, { id, content, fg })
}

function filesFor(pane: Pane): MockFile[] {
  return pane === "local" ? localFiles : remoteFiles
}

function cursorFor(pane: Pane): number {
  return pane === "local" ? localCursor : remoteCursor
}

function setCursor(pane: Pane, value: number): void {
  if (pane === "local") localCursor = value
  else remoteCursor = value
}

function qrBlock(seed: number): string[] {
  const size = 13
  const lines: string[] = []
  for (let y = 0; y < size; y += 1) {
    let line = ""
    for (let x = 0; x < size; x += 1) {
      const finder = (x < 5 && y < 5) || (x >= 8 && y < 5) || (x < 5 && y >= 8)
      const border = finder && (x === 0 || x === 4 || y === 0 || y === 4 || (x >= 8 && x === 8) || (y >= 8 && y === 8))
      const center = finder && ((x >= 1 && x <= 3 && y >= 1 && y <= 3) || (x >= 9 && x <= 11 && y >= 1 && y <= 3) || (x >= 1 && x <= 3 && y >= 9 && y <= 11))
      const data = ((x * 17 + y * 31 + seed * 7) % 5) < 2
      line += border || center || data ? "██" : "  "
    }
    lines.push(line)
  }
  return lines
}

function selectedFiles(): MockFile[] {
  return [...localFiles, ...remoteFiles].filter((file) => file.selected)
}

function selectedBytes(): number {
  return selectedFiles().reduce((total, file) => total + file.bytes, 0)
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function buildPane(pane: Pane, title: string, path: string): BoxRenderable {
  const files = filesFor(pane)
  const focused = activePane === pane
  const panel = new BoxRenderable(renderer, {
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

  files.forEach((file, index) => {
    const row = new BoxRenderable(renderer, {
      id: `${pane}-row-${index}`,
      height: 1,
      flexDirection: "row",
      backgroundColor: index === cursorFor(pane) && focused ? COLORS.selected : COLORS.surface,
    })
    const marker = file.selected ? "✓" : " "
    const content = `${marker} ${stateGlyph(file.state)} ${file.icon} ${file.name.padEnd(28)} ${file.size.padStart(7)}  ${file.state}`
    row.add(text(content, index === cursorFor(pane) && focused ? COLORS.text : stateColor(file.state), `${pane}-text-${index}`))
    panel.add(row)
  })
  return panel
}

function addHeader(root: BoxRenderable): void {
  const header = new BoxRenderable(renderer, {
    id: "header",
    height: 3,
    flexDirection: "row",
    border: true,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    paddingLeft: 1,
    paddingRight: 1,
  })
  header.add(text("SyncWeave", COLORS.focus, "brand"))
  header.add(text("  v0.1.0", COLORS.muted, "version"))
  header.add(text("                         ", COLORS.text, "header-space"))
  header.add(text("● mDNS: Active", COLORS.success, "mdns"))
  header.add(text("  • Peers: 2 Online", COLORS.remote, "peers"))
  root.add(header)
}

function addFooter(root: BoxRenderable, content: string): void {
  const footer = new BoxRenderable(renderer, {
    id: "footer",
    height: 2,
    flexDirection: "row",
    marginTop: 1,
  })
  footer.add(text(content, COLORS.text, "footer-actions"))
  root.add(footer)
}

function addWorkspace(root: BoxRenderable): void {
  const workspace = new BoxRenderable(renderer, {
    id: "workspace",
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
    marginTop: 1,
    marginBottom: 1,
  })
  workspace.add(buildPane("local", "LOCAL WORKSPACE", "~/projects/notes"))
  workspace.add(buildPane("remote", "REMOTE STAGING", "MacBook-M3: ~/notes"))
  root.add(workspace)
}

function addActivity(root: BoxRenderable): void {
  const activity = new BoxRenderable(renderer, {
    id: "activity-panel",
    height: 3,
    border: true,
    borderColor: transferState === "transferring" ? COLORS.focus : COLORS.border,
    flexDirection: "column",
    paddingLeft: 1,
  })
  const selected = selectedFiles()
  const selectedLabel = selected.length === 0 ? "No staged files" : `${selected.length} staged • ${formatBytes(selectedBytes())}`
  const gaugeSize = 28
  const filled = Math.floor((transferProgress / 100) * gaugeSize)
  const gauge = "█".repeat(filled) + "░".repeat(gaugeSize - filled)
  const stream = transferState === "transferring" ? `architecture-diagram.md  [chunk ${Math.max(1, Math.ceil(transferProgress / 8))}/13]` : status
  activity.add(text(`Active Stream: ${stream}`, COLORS.text, "activity-status"))
  activity.add(text(`Progress: ⣾⣷⣯⣟⡿⢿  [${gauge}] ${transferProgress}%  •  ${selectedLabel}`, transferState === "transferring" ? COLORS.focus : COLORS.muted, "activity-progress"))
  root.add(activity)
}

function addModal(root: BoxRenderable, title: string, lines: string[], accent = COLORS.focus): void {
  const modal = new BoxRenderable(renderer, {
    id: "modal",
    flexGrow: 1,
    flexDirection: "column",
    border: true,
    borderColor: accent,
    backgroundColor: COLORS.surface,
    padding: 2,
    marginTop: 1,
    marginBottom: 1,
  })
  modal.add(text(`╭─ ${title} ─╮`, accent, "modal-title"))
  for (const [index, line] of lines.entries()) modal.add(text(line, COLORS.text, `modal-line-${index}`))
  root.add(modal)
}

function renderPairing(root: BoxRenderable): void {
  const qr = qrBlock(42).map((line) => `    ${line}`)
  const state = ["Waiting for peer…", "Peer discovered — authenticating…", "Connected — pairing complete!"][pairingStep]
  addModal(root, "Peer Pairing · Scan with Camera or Termux", [
    "",
    ...qr,
    "",
    "    Code: 8492-AXQ1     Relay: Direct P2P",
    "    Auth: Ed25519 Ephemeral",
    `    ${state}`,
    "",
    "    [Esc] Cancel",
  ], pairingStep === 2 ? COLORS.success : COLORS.remote)
  addFooter(root, "[Enter] Simulate Scan  [Esc] Cancel  [Ctrl+C] Exit")
}

function renderDiff(root: BoxRenderable): void {
  addModal(root, "Diff Inspector · architecture-diagram.md", [
    "",
    " LOCAL                                      REMOTE",
    "────────────────────────────────────────────────────────────────",
    ...diffLines.map(([label, left, right]) => `${label.padEnd(5)} ${left.padEnd(39)} │ ${right}`),
    "",
    "  ~ 2 changed hunks   [Tab] Next Hunk   [Enter] Stage Hunk   [Esc] Close",
  ], COLORS.warning)
  addFooter(root, "[Tab] Next Hunk  [Enter] Stage Hunk  [Esc] Close  [Ctrl+C] Exit")
}

function renderTransfer(root: BoxRenderable): void {
  const stateLine = transferState === "complete" ? "✓ Transfer complete — workspace synchronized" : "⠋ Transferring staged files…"
  const filled = Math.floor((transferProgress / 100) * 34)
  const gauge = "█".repeat(filled) + "░".repeat(34 - filled)
  addModal(root, "Sync Staged Changes", [
    "",
    stateLine,
    "",
    `  ${gauge}  ${transferProgress}%`,
    `  Speed: ${transferState === "complete" ? "—" : "14.2 MB/s"}    ETA: ${transferState === "complete" ? "done" : `${Math.max(0, Math.ceil((100 - transferProgress) / 18) / 10).toFixed(1)}s`}`,
    "",
    `  Files: ${selectedFiles().length}    Size: ${formatBytes(selectedBytes())}`,
    "",
    transferState === "complete" ? "  [Enter] Return to Workspace" : "  [Esc] Cancel",
  ], transferState === "complete" ? COLORS.success : COLORS.focus)
  addFooter(root, transferState === "complete" ? "[Enter] Return  [Ctrl+C] Exit" : "[Esc] Cancel  [Ctrl+C] Exit")
}

function buildUI(): void {
  renderer.root.removeAll()
  const root = new BoxRenderable(renderer, {
    id: "root",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: COLORS.background,
    padding: 1,
  })
  renderer.root.add(root)
  addHeader(root)

  if (screen === "workspace") {
    addWorkspace(root)
    addActivity(root)
    addFooter(root, "[↑↓] Navigate  [Tab] Pane  [Space] Stage  [s] Sync  [d] Diff  [q] Pair  [?] Help  [Ctrl+C] Exit")
  } else if (screen === "pairing") {
    renderPairing(root)
  } else if (screen === "diff") {
    renderDiff(root)
  } else {
    renderTransfer(root)
  }
}

function stopTimer(timer: ReturnType<typeof setInterval> | undefined): void {
  if (timer) clearInterval(timer)
}

function startPairing(): void {
  stopTimer(pairingTimer)
  pairingStep = 0
  screen = "pairing"
  buildUI()
  pairingTimer = setInterval(() => {
    pairingStep += 1
    if (pairingStep >= 2) stopTimer(pairingTimer)
    buildUI()
  }, 900)
}

function startTransfer(): void {
  const selected = selectedFiles()
  if (selected.length === 0) {
    status = "Nothing staged — press Space on a file first"
    buildUI()
    return
  }
  stopTimer(transferTimer)
  transferProgress = 0
  transferState = "transferring"
  screen = "transfer"
  buildUI()
  transferTimer = setInterval(() => {
    transferProgress = Math.min(100, transferProgress + 8)
    if (transferProgress >= 100) {
      transferState = "complete"
      selected.forEach((file) => { file.selected = false; file.state = "synced" })
      status = "Sync complete — all staged changes are synchronized"
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

  if (screen === "pairing") {
    if (key.name === "escape") {
      stopTimer(pairingTimer)
      screen = "workspace"
      status = "Pairing cancelled"
      buildUI()
    }
    return
  }

  if (screen === "diff") {
    if (key.name === "escape") {
      screen = "workspace"
      status = "Diff closed"
      buildUI()
    } else if (key.name === "tab") {
      status = "Next diff hunk: Transport retry policy"
      buildUI()
    } else if (key.name === "return") {
      status = "Mock hunk staged"
      buildUI()
    }
    return
  }

  if (screen === "transfer") {
    if (key.name === "escape" && transferState === "transferring") {
      stopTimer(transferTimer)
      transferState = "idle"
      screen = "workspace"
      status = "Mock transfer cancelled"
      buildUI()
    } else if (key.name === "return" && transferState === "complete") {
      transferState = "idle"
      screen = "workspace"
      buildUI()
    }
    return
  }

  const files = filesFor(activePane)
  const cursor = cursorFor(activePane)

  switch (key.name) {
    case "tab":
      activePane = activePane === "local" ? "remote" : "local"
      status = `Focused ${activePane} workspace`
      break
    case "up":
      setCursor(activePane, Math.max(0, cursor - 1))
      break
    case "down":
      setCursor(activePane, Math.min(files.length - 1, cursor + 1))
      break
    case "space":
      files[cursor].selected = !files[cursor].selected
      status = `${files[cursor].selected ? "Staged" : "Unstaged"} ${files[cursor].name}`
      break
    case "s":
      startTransfer()
      return
    case "d":
      if (files[cursor].state === "modified") {
        screen = "diff"
        buildUI()
      } else {
        status = `No divergence to inspect: ${files[cursor].name}`
        buildUI()
      }
      return
    case "q":
      startPairing()
      return
    case "?":
      status = "Help: Tab panes • Space stage • s sync • d diff • q pair"
      break
    default:
      return
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
