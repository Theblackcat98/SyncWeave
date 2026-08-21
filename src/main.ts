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

type MockFile = {
  name: string
  icon: string
  size: string
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
  { name: "architecture-diagram.md", icon: "󰈙", size: "12 KB", state: "synced", selected: false },
  { name: "daily-todo.txt", icon: "󰈙", size: "2 KB", state: "synced", selected: false },
  { name: "configs/", icon: "󰒓", size: "—", state: "modified", selected: false },
  { name: "build-artifact.tar.gz", icon: "󰡨", size: "45 MB", state: "added", selected: false },
]

const remoteFiles: MockFile[] = [
  { name: "architecture-diagram.md", icon: "󰈙", size: "14 KB", state: "modified", selected: false },
  { name: "daily-todo.txt", icon: "󰈙", size: "2 KB", state: "synced", selected: false },
  { name: "configs/", icon: "󰒓", size: "—", state: "modified", selected: false },
  { name: "release-v1.tar.gz", icon: "󰡨", size: "45 MB", state: "added", selected: false },
]

let renderer: CliRenderer
let activePane: Pane = "local"
let localCursor = 0
let remoteCursor = 0
let status = "Ready — select files to stage a mock transfer"

const ui = {
  localPane: null as BoxRenderable | null,
  remotePane: null as BoxRenderable | null,
  localRows: [] as BoxRenderable[],
  remoteRows: [] as BoxRenderable[],
  localTexts: [] as TextRenderable[],
  remoteTexts: [] as TextRenderable[],
  activity: null as TextRenderable | null,
}

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

  const rows = pane === "local" ? ui.localRows : ui.remoteRows
  const texts = pane === "local" ? ui.localTexts : ui.remoteTexts
  const prefix = pane === "local" ? "local" : "remote"

  files.forEach((file, index) => {
    const row = new BoxRenderable(renderer, {
      id: `${prefix}-row-${index}`,
      height: 1,
      flexDirection: "row",
      backgroundColor: index === cursorFor(pane) && focused ? COLORS.selected : COLORS.surface,
    })
    const line = text("", COLORS.text, `${prefix}-text-${index}`)
    row.add(line)
    panel.add(row)
    rows.push(row)
    texts.push(line)
  })

  if (pane === "local") ui.localPane = panel
  else ui.remotePane = panel
  return panel
}

function updatePane(pane: Pane): void {
  const files = filesFor(pane)
  const cursor = cursorFor(pane)
  const focused = activePane === pane
  const rows = pane === "local" ? ui.localRows : ui.remoteRows
  const texts = pane === "local" ? ui.localTexts : ui.remoteTexts

  rows.forEach((row, index) => {
    const file = files[index]
    const marker = file.selected ? "✓" : " "
    row.backgroundColor = index === cursor && focused ? COLORS.selected : COLORS.surface
    texts[index].content = `${marker} ${stateGlyph(file.state)} ${file.icon} ${file.name.padEnd(27)} ${file.size.padStart(7)}  ${file.state}`
    texts[index].fg = index === cursor && focused ? COLORS.text : stateColor(file.state)
  })

  const panel = pane === "local" ? ui.localPane : ui.remotePane
  if (panel) panel.borderColor = focused ? COLORS.focus : COLORS.border
}

function updateActivity(): void {
  if (ui.activity) ui.activity.content = `Active Stream: ${status}`
}

function updateUI(): void {
  updatePane("local")
  updatePane("remote")
  updateActivity()
}

function buildUI(): void {
  const root = new BoxRenderable(renderer, {
    id: "root",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: COLORS.background,
    padding: 1,
  })
  renderer.root.add(root)

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

  const activity = new BoxRenderable(renderer, {
    id: "activity-panel",
    height: 3,
    border: true,
    borderColor: COLORS.border,
    flexDirection: "column",
    paddingLeft: 1,
  })
  ui.activity = text("", COLORS.text, "activity-status")
  activity.add(ui.activity)
  activity.add(text("Progress: ⣀⣄⣤⣦⣶⣷⣿   0%  •  Mock transport idle", COLORS.muted, "activity-progress"))
  root.add(activity)

  const footer = new BoxRenderable(renderer, {
    id: "footer",
    height: 2,
    flexDirection: "row",
    marginTop: 1,
  })
  footer.add(text("[↑↓] Navigate  [Tab] Pane  [Space] Select  [s] Mock Sync  [d] Diff  [q] Pair  [?] Help  [Ctrl+C] Exit", COLORS.text, "footer-actions"))
  root.add(footer)

  updateUI()
}

function handleKey(key: KeyEvent): void {
  if (key.ctrl && key.name === "c") {
    renderer.stop()
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
    case "s": {
      const selected = [...localFiles, ...remoteFiles].filter((file) => file.selected)
      status = selected.length === 0
        ? "Nothing staged — press Space on a file first"
        : `Mock transfer queued: ${selected.length} file${selected.length === 1 ? "" : "s"}`
      break
    }
    case "d": {
      const file = files[cursor]
      status = file.state === "modified" ? `Mock diff opened: ${file.name}` : `No divergence to inspect: ${file.name}`
      break
    }
    case "q":
      status = "Mock pairing flow ready — QR UI is next"
      break
    case "?":
      status = "Help: Tab switches panes • Space stages • s syncs • d inspects • q pairs"
      break
    default:
      return
  }

  updateUI()
}

async function main(): Promise<void> {
  renderer = await createCliRenderer({ exitOnCtrlC: false })
  renderer.setBackgroundColor(RGBA.fromHex(COLORS.background))
  renderer.keyInput.on("keypress", handleKey)
  buildUI()
  renderer.start()
}

await main()
