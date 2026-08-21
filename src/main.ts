import {
  BoxRenderable,
  RGBA,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core"

type SyncState = "synced" | "added" | "modified" | "deleted"

type MockFile = {
  name: string
  icon: string
  size: string
  state: SyncState
  selected: boolean
  directory?: boolean
}

const COLORS = {
  background: "#12131C",
  surface: "#1E1E2E",
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
  { name: "configs/", icon: "󰒓", size: "—", state: "modified", selected: false, directory: true },
  { name: "build-artifact.tar.gz", icon: "󰡨", size: "45 MB", state: "added", selected: false },
]

const remoteFiles: MockFile[] = [
  { name: "architecture-diagram.md", icon: "󰈙", size: "14 KB", state: "modified", selected: false },
  { name: "daily-todo.txt", icon: "󰈙", size: "2 KB", state: "synced", selected: false },
  { name: "configs/", icon: "󰒓", size: "—", state: "modified", selected: false, directory: true },
  { name: "release-v1.tar.gz", icon: "󰡨", size: "45 MB", state: "added", selected: false },
]

let activePane: "local" | "remote" = "local"
let localCursor = 0
let remoteCursor = 0
let status = "Ready — select files to stage a mock transfer"
let renderer: CliRenderer

function stateGlyph(state: SyncState): string {
  return { synced: "•", added: "+", modified: "~", deleted: "-" }[state]
}

function stateColor(state: SyncState): string {
  return {
    synced: COLORS.muted,
    added: COLORS.success,
    modified: COLORS.warning,
    deleted: COLORS.danger,
  }[state]
}

function makeText(content: string, fg: string, id: string): TextRenderable {
  return new TextRenderable(renderer, { id, content, fg })
}

function paneView(title: string, path: string, files: MockFile[], cursor: number, focused: boolean): BoxRenderable {
  const pane = new BoxRenderable(renderer, {
    id: `${title.toLowerCase()}-pane`,
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
      id: `${title.toLowerCase()}-${index}`,
      flexDirection: "row",
      height: 1,
      backgroundColor: index === cursor && focused ? "#263244" : COLORS.surface,
    })

    const marker = file.selected ? "✓" : " "
    const glyph = `${stateGlyph(file.state)} `
    const text = `${marker} ${glyph}${file.icon} ${file.name}`
    const nameColor = index === cursor && focused ? COLORS.text : COLORS.muted
    row.add(makeText(text, nameColor, `${title.toLowerCase()}-text-${index}`))
    row.add(makeText(`  ${file.size}`, COLORS.muted, `${title.toLowerCase()}-size-${index}`))
    row.add(makeText(`  ${file.state}`, stateColor(file.state), `${title.toLowerCase()}-state-${index}`))
    pane.add(row)
  })

  return pane
}

function renderApp(): void {
  renderer.root.removeAll()

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
  header.add(makeText("SyncWeave", COLORS.focus, "brand"))
  header.add(makeText("  v0.1.0", COLORS.muted, "version"))
  header.add(makeText("                         ", COLORS.text, "spacer"))
  header.add(makeText("● mDNS: Active", COLORS.success, "mdns"))
  header.add(makeText("  • Peers: 2 Online", COLORS.remote, "peers"))
  root.add(header)

  const workspace = new BoxRenderable(renderer, {
    id: "workspace",
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
    marginTop: 1,
    marginBottom: 1,
  })
  root.add(workspace)

  workspace.add(paneView("LOCAL WORKSPACE", "~/projects/notes", localFiles, localCursor, activePane === "local"))
  workspace.add(paneView("REMOTE STAGING", "MacBook-M3: ~/notes", remoteFiles, remoteCursor, activePane === "remote"))

  const activity = new BoxRenderable(renderer, {
    id: "activity",
    height: 3,
    border: true,
    borderColor: COLORS.border,
    flexDirection: "column",
    paddingLeft: 1,
  })
  activity.add(makeText(`Active Stream: ${status}`, COLORS.text, "activity-status"))
  activity.add(makeText("Progress: ⣀⣄⣤⣦⣶⣷⣿   0%  •  Mock transport idle", COLORS.muted, "activity-progress"))
  root.add(activity)

  const footer = new BoxRenderable(renderer, {
    id: "footer",
    height: 2,
    flexDirection: "row",
    marginTop: 1,
  })
  footer.add(makeText("[↑↓] Navigate  [Tab] Pane  [Space] Select  [s] Mock Sync  [d] Diff  [q] Pair  [?] Help  [Ctrl+C] Exit", COLORS.text, "footer-actions"))
  root.add(footer)
}

function activeFiles(): MockFile[] {
  return activePane === "local" ? localFiles : remoteFiles
}

function activeCursor(): number {
  return activePane === "local" ? localCursor : remoteCursor
}

function setActiveCursor(value: number): void {
  if (activePane === "local") localCursor = value
  else remoteCursor = value
}

function handleKey(key: KeyEvent): void {
  if (key.ctrl && key.name === "c") {
    renderer.stop()
    return
  }

  const files = activeFiles()
  const cursor = activeCursor()

  if (key.name === "tab") {
    activePane = activePane === "local" ? "remote" : "local"
    status = `Focused ${activePane} workspace`
  } else if (key.name === "up") {
    setActiveCursor(Math.max(0, cursor - 1))
  } else if (key.name === "down") {
    setActiveCursor(Math.min(files.length - 1, cursor + 1))
  } else if (key.name === "space") {
    files[cursor].selected = !files[cursor].selected
    status = `${files[cursor].selected ? "Staged" : "Unstaged"} ${files[cursor].name}`
  } else if (key.name === "s") {
    const selected = [...localFiles, ...remoteFiles].filter((file) => file.selected)
    status = selected.length === 0
      ? "Nothing staged — press Space on a file first"
      : `Mock transfer queued: ${selected.length} file${selected.length === 1 ? "" : "s"}`
  } else if (key.name === "d") {
    const file = files[cursor]
    status = file.state === "modified" ? `Mock diff opened: ${file.name}` : `No divergence to inspect: ${file.name}`
  } else if (key.name === "q") {
    status = "Mock pairing flow ready — QR UI is next"
  } else if (key.name === "?") {
    status = "Help: Tab switches panes • Space stages • s syncs • d inspects • q pairs"
  }

  renderApp()
}

async function main(): Promise<void> {
  renderer = await createCliRenderer({ exitOnCtrlC: false })
  renderer.setBackgroundColor(RGBA.fromHex(COLORS.background))
  renderer.keyInput.on("keypress", handleKey)
  renderApp()
  renderer.start()
}

await main()
