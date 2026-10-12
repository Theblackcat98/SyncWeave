import { BoxRenderable, MouseButton, RGBA, type CliRenderer } from "@opentui/core"
import type { AppMode, AppState, ConsentFile, MockEntry, MockPeer, Pane, Screen, TransferRecord } from "../domain.js"
import { formatBytes, OTHER_PANE } from "../domain.js"
import type { FileSystemService, PeerService } from "../services/ports.js"
import { icons, motion, theme } from "../theme.js"
import { actionButton, actionRow, label, panel, progressGauge, stateColor, stateGlyph, truncate, type CommandHandler } from "./primitives.js"
import { statusLabel, totalBytes } from "./transfer-presentation.js"

export interface RenderActions {
  command: CommandHandler
  selectEntry(pane: Pane, index: number): void
  scrollPane(pane: Pane, direction: "up" | "down"): void
  selectConsentFile(index: number): void
  toggleConsentFile(index: number): void
  selectFavorite(index: number): void
}

export interface RenderData {
  renderer: CliRenderer
  state: AppState
  mode: AppMode
  filesystem: FileSystemService
  peerService: PeerService
  receiveDestinations: readonly [string, ...string[]]
  peers: MockPeer[]
  favorites: ReturnType<PeerService["favorites"]>
  queue: TransferRecord[]
  actions: RenderActions
  real?: { bindAddr: string; tcpPort: number } | null
}

export function renderApp(data: RenderData): void {
  const { renderer, state } = data
  const width = Math.max(20, renderer.terminalWidth || 80)
  const height = Math.max(6, renderer.terminalHeight || 24)
  const compact = height <= theme.layout.compactHeight
  for (const child of renderer.root.getChildren()) {
    renderer.root.remove(child)
    child.destroyRecursively()
  }
  renderer.setBackgroundColor(RGBA.fromHex(theme.color.background))

  const root = panel(renderer, "app-root", {
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: theme.color.background,
    paddingLeft: width < theme.layout.veryNarrowWidth ? 0 : 1,
    paddingRight: width < theme.layout.veryNarrowWidth ? 0 : 1,
    paddingTop: 0,
    paddingBottom: 0,
  })
  renderer.root.add(root)
  root.add(renderHeader(data, width, compact))

  const body = panel(renderer, "app-body", { flexGrow: 1, minHeight: 1, flexDirection: "column" })
  root.add(body)
  switch (state.screen) {
    case "workspace": renderWorkspace(body, data, width, height, compact); break
    case "send-review": renderSendReview(body, data, width); break
    case "consent": renderConsent(body, data, width); break
    case "transfer": renderTransfer(body, data, width); break
    case "peer": renderPeer(body, data, width); break
    case "favorites": renderFavorites(body, data, width); break
    case "diff": renderDiff(body, data, width); break
    case "help": renderHelp(body, data, width); break
    case "queue": renderQueue(body, data, width); break
  }

  if (state.screen === "workspace") addActivity(root, data, width, compact)
  root.add(renderFooter(data, width, compact))
}

function renderHeader(data: RenderData, width: number, compact: boolean): BoxRenderable {
  const { renderer, state, mode, peers } = data
  const header = panel(renderer, "header", {
    height: width < theme.layout.veryNarrowWidth ? 4 : compact ? 1 : 3,
    flexDirection: width < theme.layout.veryNarrowWidth ? "column" : "row",
    alignItems: "center",
    border: !compact,
    // OpenTUI forces a border when borderColor is set even with border:false.
    ...(compact ? {} : { borderColor: theme.border.subtle }),
    backgroundColor: theme.color.surface,
    paddingLeft: width < theme.layout.veryNarrowWidth ? 0 : 1,
    paddingRight: 1,
  })
  header.add(label(renderer, "brand", "◆ SyncWeave 0.1.0", theme.typography.brand))
  const wideHeader = width >= theme.layout.dualPaneMinWidth && !compact
  if (wideHeader) {
    header.add(label(renderer, "header-tagline", "  TUI FILE TRANSFER", theme.color.muted))
    header.add(label(renderer, "header-spacer", "  ", theme.color.text))
  }
  const frame = motion.discovery[state.discoveryFrame % motion.discovery.length]
  const onlineCount = peers.filter((peer) => peer.online).length
  const discoveryLabel = data.mode === "real" ? "DISCOVERY" : "MOCK DISCOVERY"
  const peerText = wideHeader ? `  ${frame} ${discoveryLabel} · ${onlineCount} peers` : `  ${frame} ${onlineCount} ${data.mode === "real" ? "peers" : "mock peers"}`
  header.add(label(renderer, "mock-discovery", truncate(peerText, Math.max(12, width - 22)), theme.color.success))
  if (data.mode === "real" && wideHeader) {
    const bind = data.real?.bindAddr ?? "::"
    const port = data.real?.tcpPort ?? 0
    header.add(label(renderer, "listen-indicator", `  · LISTENING [${bind}]:${port}`, theme.color.muted))
  }
  if (wideHeader) {
    const activePeer = peers[state.peerIndex % Math.max(1, peers.length)]
    header.add(label(renderer, "active-peer", `  → ${truncate(activePeer?.name ?? "No peer", 18)}`, theme.color.remote))
    header.add(label(renderer, "phase-label", mode === "real" ? "  · REAL FILES" : "  · SIMULATION", theme.color.warning))
  }
  return header
}

function renderWorkspace(parent: BoxRenderable, data: RenderData, width: number, height: number, compact: boolean): void {
  const { renderer, state, mode, actions, filesystem, peers } = data
  const bodyHeader = panel(renderer, "workspace-toolbar", {
    height: width < theme.layout.veryNarrowWidth ? 3 : compact ? 1 : 2,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 1,
  })
  bodyHeader.add(label(renderer, "workspace-title", compact || width < theme.layout.dualPaneMinWidth ? "WORKSPACE" : "  WORKSPACE  ·  Local changes, clearly staged", theme.typography.heading))
  if (width < theme.layout.dualPaneMinWidth) {
    bodyHeader.add(actionButton(renderer, "tab-local", "1 Local", "pane-local", actions.command, { fg: state.activePane === "local" ? theme.color.focus : theme.color.muted }))
    bodyHeader.add(actionButton(renderer, "tab-remote", mode === "real" ? "2 Receiver" : "2 Remote", "pane-remote", actions.command, { fg: state.activePane === "remote" ? theme.color.remote : theme.color.muted }))
    bodyHeader.add(actionButton(renderer, "toolbar-stage", "Stage · Space", "toggle-current", actions.command))
    bodyHeader.add(actionButton(renderer, "toolbar-send", "Send", "send-review", actions.command))
    bodyHeader.add(actionButton(renderer, "toolbar-receive", "Receive", "incoming", actions.command, { fg: theme.color.success }))
  }
  if (width >= theme.layout.dualPaneMinWidth && !compact) {
    bodyHeader.add(actionButton(renderer, "toolbar-stage", "Stage", "toggle-current", actions.command))
    bodyHeader.add(actionButton(renderer, "toolbar-send", "Send", "send-review", actions.command))
    bodyHeader.add(actionButton(renderer, "toolbar-receive", "Receive", "incoming", actions.command, { fg: theme.color.success }))
    bodyHeader.add(actionButton(renderer, "toolbar-peers", "Peers", "peer", actions.command, { fg: theme.color.remote }))
    bodyHeader.add(actionButton(renderer, "toolbar-favorites", "Favorites", "favorites", actions.command, { fg: theme.color.warning }))
    bodyHeader.add(actionButton(renderer, "toolbar-queue", "Queue", "queue", actions.command, { fg: theme.color.muted }))
  }
  parent.add(bodyHeader)

  const workspace = panel(renderer, "workspace-panes", {
    flexGrow: 1,
    minHeight: 1,
    flexDirection: width >= theme.layout.dualPaneMinWidth ? "row" : "column",
    gap: 1,
  })
  parent.add(workspace)
  if (width >= theme.layout.dualPaneMinWidth) {
    workspace.add(renderPane(data, "local", Math.floor((width - 8) / 2), height, compact))
    // In real mode the receiver's files are never shown: the remote pane is
    // a status panel, not a file list (out of scope).
    workspace.add(
      mode === "real"
        ? renderRemoteStatus(data, Math.floor((width - 8) / 2), height, compact)
        : renderPane(data, "remote", Math.floor((width - 8) / 2), height, compact),
    )
  } else {
    const showRemoteStatus = mode === "real" && state.activePane === "remote"
    workspace.add(
      showRemoteStatus
        ? renderRemoteStatus(data, width - 2, height, compact)
        : renderPane(data, state.activePane, width - 2, height, compact),
    )
    if (!compact) {
      const note = peers[state.peerIndex % Math.max(1, peers.length)]
      const noteText =
        mode === "real"
          ? `Target: ${note?.name ?? "No peer"}  ·  local files are real  ·  receiver files are not shown`
          : `Target: ${note?.name ?? "No mock peer"}  ·  ${state.activePane === "local" ? "Local → Remote" : "Remote → Local"}  ·  all data is simulated`
      workspace.add(label(renderer, "narrow-peer-note", noteText, theme.color.muted))
    }
  }
}

function renderPane(data: RenderData, pane: Pane, paneWidth: number, height: number, compact: boolean): BoxRenderable {
  const { renderer, state, filesystem, actions } = data
  const path = state.paths[pane]
  const entries = filesystem.list(pane, path)
  const cursor = Math.min(state.cursors[pane], Math.max(entries.length - 1, 0))
  const rows = height <= theme.layout.compactHeight ? 2 : Math.max(2, Math.min(14, height - 18))
  const maxOffset = Math.max(0, entries.length - rows)
  const offset = Math.min(state.scrollOffsets[pane], maxOffset)
  const focusedColor = state.activePane === pane
    ? state.focusFrame < motion.focusGlow.length - 1
      ? motion.focusGlow[state.focusFrame]
      : pane === "local" ? theme.border.localFocus : theme.border.remoteFocus
    : theme.border.subtle
  const borderColor = focusedColor
  const paneBox = panel(renderer, `${pane}-pane`, {
    flexGrow: 1,
    minWidth: 20,
    minHeight: 1,
    flexDirection: "column",
    border: true,
    borderColor,
    title: ` ${pane === "local" ? "LOCAL SOURCE" : "REMOTE DESTINATION"} `,
    titleColor: borderColor,
    backgroundColor: theme.color.surface,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: compact || height <= 26 ? 0 : 1,
    onMouseScroll: (event) => {
      if (event.scroll) actions.scrollPane(pane, event.scroll.direction === "down" ? "down" : "up")
    },
  })
  paneBox.add(label(renderer, `${pane}-path`, truncate(path, Math.max(10, paneWidth - 8)), theme.color.muted))
  if (offset > 0) paneBox.add(label(renderer, `${pane}-scroll-top`, `↑ ${offset} more above`, theme.color.dim))

  entries.slice(offset, offset + rows).forEach((entry, visibleIndex) => {
    const index = offset + visibleIndex
    const focused = state.activePane === pane && index === cursor
    const selected = state.staged[pane].has(entry.id)
    const icon = entry.kind === "directory" ? icons.directory : entry.name.endsWith(".gz") ? icons.archive : icons.file
    // Real mode has no sync-state model; the mock SYNC badge would lie.
    const realMode = data.mode === "real"
    const stateLabel = entry.kind === "directory" ? "" : ({ synced: "SYNC", added: "NEW", modified: "EDIT", deleted: "DEL" } as const)[entry.state]
    const left = `${selected ? icons.check : " "} ${realMode ? "" : `${stateGlyph(entry.state)} `}${icon} `
    const right = ` ${entry.kind === "directory" ? "DIR" : formatBytes(entry.bytes).padStart(7)}`
    const nameWidth = Math.max(8, paneWidth - left.length - right.length - 7)
    const row = panel(renderer, `${pane}-entry-${entry.id}`, {
      height: 1,
      flexDirection: "row",
      backgroundColor: focused ? theme.color.selected : theme.color.surface,
      onMouseDown: (event) => {
        if (event.button === MouseButton.LEFT) actions.selectEntry(pane, index)
      },
    })
    row.add(label(renderer, `${pane}-entry-state-${entry.id}`, left, focused ? theme.color.white : stateColor(entry.state)))
    // Unsupported entries (symlink, FIFO…) show their reason instead of a size.
    const displayName = entry.unsupported ? `${entry.name} [${entry.unsupported}]` : entry.name
    row.add(label(renderer, `${pane}-entry-name-${entry.id}`, truncate(displayName, nameWidth), focused ? theme.color.white : entry.unsupported ? theme.color.muted : theme.color.text))
    const meta = entry.kind === "directory" ? "DIR" : realMode ? right.slice(1) : `${right.slice(1)} ${stateLabel}`
    row.add(label(renderer, `${pane}-entry-meta-${entry.id}`, truncate(` ${meta}`, 16), stateColor(entry.state)))
    paneBox.add(row)
  })

  if (offset + rows < entries.length) paneBox.add(label(renderer, `${pane}-scroll-bottom`, `↓ ${entries.length - offset - rows} more · mouse wheel to scroll`, theme.color.dim))
  if (entries.length === 0) {
    const listErr = data.filesystem.listError?.(pane, state.paths[pane])
    const emptyText = listErr
      ? `Cannot read folder: ${listErr}`
      : data.mode === "real" ? "This folder is empty." : "This mock folder is empty."
    paneBox.add(label(renderer, `${pane}-empty`, emptyText, listErr ? theme.color.danger : theme.color.muted))
  } else {
    const total = data.filesystem.listTotal?.(pane, state.paths[pane])
    if (total !== undefined && total > entries.length) {
      paneBox.add(label(renderer, `${pane}-truncated`, `Showing first ${entries.length} of ${total} entries`, theme.color.muted))
    }
  }
  return paneBox
}

/**
 * Real-mode replacement for the remote file list. The receiver's files are
 * never shown (out of scope): this panel reports peer/session state and
 * transfer status only, with no file rows and no staging controls.
 */
function renderRemoteStatus(data: RenderData, paneWidth: number, height: number, compact: boolean): BoxRenderable {
  const { renderer, state, peers, queue } = data
  const focused = state.activePane === "remote"
  const borderColor = focused
    ? state.focusFrame < motion.focusGlow.length - 1
      ? motion.focusGlow[state.focusFrame]
      : theme.border.remoteFocus
    : theme.border.subtle
  const box = panel(renderer, "remote-status", {
    flexGrow: 1,
    minWidth: 20,
    minHeight: 1,
    flexDirection: "column",
    border: true,
    borderColor,
    title: " REMOTE RECEIVER ",
    titleColor: borderColor,
    backgroundColor: theme.color.surface,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: compact || height <= 26 ? 0 : 1,
  })
  const peer = peers[state.peerIndex % Math.max(1, peers.length)]
  const active = queue.find((record) => record.id === state.activeTransferId)
  const latest = queue[queue.length - 1]
  const lines: Array<[string, string]> = [
    ["status-peer", `Peer: ${peer ? `${peer.name} (${peer.host}:${peer.port})` : "none selected"}`],
    ["status-session", `Session: ${active ? `transfer ${active.status}` : "no active session"}`],
    ["status-transfer", `Transfer: ${active ? `${active.acceptedFiles.length} files · ${active.progress}%` : latest ? `last ${latest.status}` : "idle"}`],
  ]
  for (const [id, text] of lines) {
    box.add(label(renderer, id, truncate(text, Math.max(10, paneWidth - 4)), theme.color.text))
  }
  // Peer list: ↑/↓ cycles the send target when this pane is focused.
  if (peers.length === 0) {
    box.add(label(renderer, "status-no-peers", truncate("No peers yet · discovering… (or add --peer host:port)", Math.max(10, paneWidth - 4)), theme.color.muted))
  } else {
    box.add(label(renderer, "status-peer-hint", truncate(`↑/↓ select target · ${peers.length} peer${peers.length === 1 ? "" : "s"}`, Math.max(10, paneWidth - 4)), theme.color.muted))
    peers.slice(0, 8).forEach((p, i) => {
      const selected = i === state.peerIndex % Math.max(1, peers.length)
      // Manual peers were never probed; discovered peers were seen via multicast.
      const stateTag = p.online ? "" : " [not probed]"
      box.add(label(
        renderer,
        `status-peer-${i}`,
        truncate(`${selected ? "▸" : " "} ${p.name}  ${p.host}:${p.port}${stateTag}`, Math.max(10, paneWidth - 4)),
        selected ? theme.color.focus : theme.color.text,
      ))
    })
    if (peers.length > 8) {
      box.add(label(renderer, "status-peer-overflow", truncate(`  + ${peers.length - 8} more`, Math.max(10, paneWidth - 4)), theme.color.muted))
    }
  }
  box.add(label(renderer, "status-scope-1", truncate("The receiver's files are not shown here.", Math.max(10, paneWidth - 4)), theme.color.muted))
  box.add(label(renderer, "status-scope-2", truncate("Browsing a peer's filesystem is out of scope.", Math.max(10, paneWidth - 4)), theme.color.muted))
  box.add(label(renderer, "status-scope-3", truncate("Each transfer needs the receiver's consent.", Math.max(10, paneWidth - 4)), theme.color.muted))
  return box
}

function addActivity(parent: BoxRenderable, data: RenderData, width: number, compact: boolean): void {
  const { renderer, state, filesystem } = data
  const stagedCount = state.staged.local.size + state.staged.remote.size
  const selectedPaneFiles = filesystem.list(state.activePane, state.paths[state.activePane]).filter((entry) => state.staged[state.activePane].has(entry.id))
  const stagedBytes = selectedPaneFiles.reduce((sum, entry) => sum + entry.bytes, 0)
  const narrow = width < theme.layout.dualPaneMinWidth
  const activity = panel(renderer, "activity", {
    height: compact ? 1 : 4,
    flexDirection: "column",
    border: !compact,
    // OpenTUI forces a border when borderColor is set even with border:false.
    ...(compact ? {} : { borderColor: theme.border.subtle }),
    backgroundColor: compact ? theme.color.background : theme.color.surface,
    paddingLeft: compact ? 0 : 1,
  })
  const status = narrow && state.status.startsWith("Ready") ? "Ready" : state.status
  const firstLine = narrow
    ? `  ${stagedCount} staged · ${formatBytes(stagedBytes)} ${state.activePane} · ${status}`
    : `  ${stagedCount} staged  ·  ${formatBytes(stagedBytes)} in ${state.activePane}  ·  ${state.status}`
  activity.add(label(renderer, "activity-summary", truncate(firstLine, Math.max(12, width - 6)), stagedCount ? theme.color.focus : theme.color.muted))
  if (!compact && data.mode !== "real") {
    const legend = narrow
      ? `  ${icons.synced} sync  ${icons.added} add  ${icons.modified} edit  ${icons.deleted} del`
      : `  ${icons.synced} synced  ${icons.added} added  ${icons.modified} modified  ${icons.deleted} deleted  ·  0 network connections`
    activity.add(label(renderer, "activity-legend", truncate(legend, Math.max(12, width - 6)), theme.color.dim))
  }
  parent.add(activity)
}

function renderSendReview(parent: BoxRenderable, data: RenderData, width: number): void {
  const { renderer, state, filesystem, actions, peers, mode } = data
  // Real mode always sends from the Local staged set, regardless of focus.
  const sendPane = mode === "real" ? "local" : state.activePane
  const files = filesystem.list(sendPane, state.paths[sendPane]).filter((entry) => state.staged[sendPane].has(entry.id))
  const peer = peers[state.peerIndex % Math.max(1, peers.length)]
  const card = pageCard(renderer, "send-review", "Review outgoing files", theme.color.focus, state.revealFrame)
  card.add(label(renderer, "send-direction", `${sendPane === "local" ? "Local" : "Remote"} → ${peer?.name ?? "no peer selected"}`, theme.color.remote))
  if (mode !== "real") {
    card.add(label(renderer, "send-mock-note", "Mock preview only · no files or network requests are sent.", theme.color.warning))
  }
  card.add(label(renderer, "send-count", `${files.length} staged  ·  ${formatBytes(files.reduce((sum, file) => sum + file.bytes, 0))}`, theme.color.white))
  files.slice(0, 8).forEach((file, index) => card.add(label(renderer, `send-file-${index}`, `  ✓ ${file.name}  ${formatBytes(file.bytes)}`, theme.color.text)))
  if (files.length > 8) card.add(label(renderer, "send-overflow", `  + ${files.length - 8} more`, theme.color.muted))
  card.add(label(renderer, "send-consent-explainer", mode === "real"
    ? "Next: the receiver reviews and accepts. Files stream only after their consent."
    : "Next: preview a receiver-hosted request. Accepted files alone advance to mock progress.", theme.color.muted))
  card.add(actionRow(renderer, "send-actions", [
    actionButton(renderer, "send-submit", "Ask receiver · Enter", "send-to-consent", actions.command, { disabled: files.length === 0 }),
    actionButton(renderer, "send-back", "Back · Esc", "workspace", actions.command, { fg: theme.color.muted }),
    actionButton(renderer, "send-peers", "Choose peer · Q", "peer", actions.command, { fg: theme.color.remote }),
  ], width < theme.layout.veryNarrowWidth))
  parent.add(card)
}

function renderConsent(parent: BoxRenderable, data: RenderData, width: number): void {
  const { renderer, state, actions } = data
  const request = state.request
  const card = pageCard(renderer, "consent-review", request?.mode === "incoming" ? "Incoming transfer request" : "Mock receiver consent", theme.color.success, state.revealFrame)
  if (!request) {
    card.add(label(renderer, "consent-empty", "There is no active request.", theme.color.muted))
    parent.add(card)
    return
  }
  card.add(label(renderer, "consent-sender", `${request.mode === "incoming" ? "Sender" : "Mock receiver"}: ${request.peer.name}  ·  ${request.peer.host}:${request.peer.port}`, theme.color.remote))
  // The SAS is the human-confirmable identity: the sender's screen shows the
  // same code. Confirm it out of band before accepting — the alias above is
  // attacker-chosen.
  if (request.sas) {
    card.add(label(renderer, "consent-sas", `Security code: ${request.sas} · confirm with the sender before accepting`, theme.color.warning))
  }
  card.add(label(renderer, "consent-count", `${request.files.length} proposed  ·  ${request.files.filter((file) => file.accepted).length} selected  ·  ${totalBytes(request.files.filter((file) => file.accepted))}`, theme.color.white))
  card.add(label(renderer, "consent-destination", `Destination: ${data.receiveDestinations[state.receiveDestinationIndex % data.receiveDestinations.length]}  [D] change`, theme.color.muted))
  card.add(label(renderer, "consent-scope", "Review every item. Nothing streams until you accept this transfer.", theme.color.warning))
  const list = panel(renderer, "consent-file-list", { flexDirection: "column", flexGrow: 1, minHeight: 1, marginTop: 1 })
  // Scrollable window: the list can hold 25 files but only ~10 rows fit.
  const windowSize = 10
  const offset = Math.min(state.consentScrollOffset, Math.max(0, request.files.length - windowSize))
  const visible = request.files.slice(offset, offset + windowSize)
  visible.forEach((file, i) => list.add(renderConsentFile(renderer, file, offset + i, state, actions, width)))
  if (request.files.length > windowSize) {
    const acceptedCount = request.files.filter((f) => f.accepted).length
    const moreAbove = offset > 0 ? `↑ ${offset} more` : ""
    const moreBelow = offset + windowSize < request.files.length ? `↓ ${request.files.length - offset - windowSize} more` : ""
    card.add(label(renderer, "consent-scroll-hint", `${moreAbove}${moreAbove && moreBelow ? " · " : ""}${moreBelow} · ${acceptedCount}/${request.files.length} accepted`, theme.color.muted))
  }
  card.add(list)
  const focused = request.files[state.selectedConsentFile]
  card.add(actionRow(renderer, "consent-file-options", [
    actionButton(renderer, "toggle-selected", `${focused?.accepted ? "Skip" : "Include"} file · Space`, "toggle-consent", actions.command, { fg: theme.color.warning }),
    // Rename and Destination are mock-era controls with no real effect;
    // hide them in real mode.
    ...(request.mode === "incoming" ? [] : [
      actionButton(renderer, "rename-selected", `${focused?.renamed ? "Undo rename" : "Rename"} · R`, "rename-consent", actions.command, { fg: theme.color.remote }),
      actionButton(renderer, "destination-select", "Destination · D", "cycle-destination", actions.command, { fg: theme.color.muted }),
    ]),
  ], width < theme.layout.veryNarrowWidth))
  card.add(label(renderer, "consent-separation", "Per-transfer choice only · Favorites and manual fingerprint comparison do not grant consent.", theme.color.dim))
  card.add(actionRow(renderer, "consent-actions", [
    actionButton(renderer, "accept-all", "Accept all · A", "consent-all", actions.command, { fg: theme.color.success }),
    actionButton(renderer, "accept-subset", "Accept selected · Enter", "consent-accept", actions.command, { fg: theme.color.focus, disabled: !request.files.some((file) => file.accepted) }),
    actionButton(renderer, "decline-request", "Decline · X", "consent-decline", actions.command, { fg: theme.color.danger }),
  ], width < theme.layout.veryNarrowWidth))
  parent.add(card)
}

function renderConsentFile(renderer: CliRenderer, file: ConsentFile, index: number, state: AppState, actions: RenderActions, width: number): BoxRenderable {
  const selected = state.selectedConsentFile === index
  const row = panel(renderer, `consent-file-${index}`, {
    height: 1,
    flexDirection: "row",
    backgroundColor: selected ? theme.color.selected : theme.color.surface,
    onMouseDown: (event) => {
      if (event.button === MouseButton.LEFT) actions.toggleConsentFile(index)
    },
  })
  const checkbox = file.accepted ? icons.check : "[ ]"
  const name = file.renamed ? renamePreview(file.name) : file.name
  row.add(label(renderer, `consent-check-${index}`, ` ${checkbox} `, file.accepted ? theme.color.success : theme.color.dim))
  row.add(label(renderer, `consent-name-${index}`, truncate(name, Math.max(10, width - 22)), selected ? theme.color.white : theme.color.text))
  row.add(label(renderer, `consent-size-${index}`, `  ${formatBytes(file.bytes)}`, theme.color.muted))
  return row
}

function renderTransfer(parent: BoxRenderable, data: RenderData, width: number): void {
  const { renderer, state, actions, queue, mode } = data
  const transfer = queue.find((item) => item.id === state.activeTransferId)
  const card = pageCard(renderer, "transfer-status", mode === "real" ? "Transfer" : "Mock transfer", transfer?.status === "complete" ? theme.color.success : transfer?.status === "failed" ? theme.color.danger : theme.color.focus, state.revealFrame)
  if (!transfer) {
    card.add(label(renderer, "transfer-missing", "No transfer is active.", theme.color.muted))
    parent.add(card)
    return
  }
  const isActive = transfer.status === "queued" || transfer.status === "transferring"
  const spinner = state.reducedMotion ? "·" : motion.spinner[state.identityStep % motion.spinner.length]
  card.add(label(renderer, "transfer-state", `${spinner}  ${statusLabel(transfer.status)}  ·  simulation only, no file bytes are sent`, transfer.status === "failed" ? theme.color.danger : theme.color.focus))
  card.add(label(renderer, "transfer-peer", `${transfer.direction === "incoming" ? "From" : "To"} ${transfer.peerName}  ·  ${transfer.acceptedFiles.length} accepted`, theme.color.remote))
  card.add(label(renderer, "transfer-gauge", `[${progressGauge(transfer.progress, Math.max(12, Math.min(36, width - 22)))}] ${transfer.progress}%`, theme.color.success))
  const tickMs = state.reducedMotion ? 320 : motion.transferTickMs
  const secondsToComplete = (100 / motion.transferStep) * tickMs / 1000
  const simulatedSpeed = secondsToComplete > 0 ? transfer.acceptedBytes / secondsToComplete : 0
  const eta = transfer.status === "complete" ? "done" : `${((100 - transfer.progress) / motion.transferStep * tickMs / 1000).toFixed(1)}s`
  card.add(label(renderer, "transfer-metrics", `  ${transfer.acceptedFiles.length} file${transfer.acceptedFiles.length === 1 ? "" : "s"}  ·  ${formatBytes(transfer.acceptedBytes)}  ·  simulated ${formatBytes(Math.round(simulatedSpeed))}/s  ·  ETA ${eta}`, theme.color.muted))
  card.add(label(renderer, "transfer-destination", `Destination: ${transfer.destination}`, theme.color.text))
  if (transfer.error) card.add(label(renderer, "transfer-error", `Error: ${transfer.error}`, theme.color.danger))
  card.add(label(renderer, "transfer-staged-files", truncate(`  ${transfer.acceptedFiles.join(" · ")}`, Math.max(18, width - 8)), theme.color.muted))
  const buttons = isActive
    ? [actionButton(renderer, "cancel-transfer", "Cancel · Esc", "transfer-cancel", actions.command, { fg: theme.color.danger }), actionButton(renderer, "simulate-failure", "Simulate error · E", "transfer-fail", actions.command, { fg: theme.color.warning })]
    : transfer.status === "failed"
      ? [actionButton(renderer, "retry-transfer", "Retry · R", "transfer-retry", actions.command, { fg: theme.color.focus }), actionButton(renderer, "return-transfer", "Return · Enter", "transfer-return", actions.command, { fg: theme.color.muted })]
      : [actionButton(renderer, "return-transfer", "Return · Enter", "transfer-return", actions.command, { fg: theme.color.success })]
  card.add(actionRow(renderer, "transfer-actions", buttons, width < theme.layout.veryNarrowWidth))
  parent.add(card)
}

function renderPeer(parent: BoxRenderable, data: RenderData, width: number): void {
  const { renderer, state, peers, favorites, actions } = data
  const peer = peers[state.peerIndex % Math.max(1, peers.length)]
  const card = pageCard(renderer, "peer-identity", "Peer setup · mock identity preview", theme.color.remote, state.revealFrame)
  if (!peer) {
    card.add(label(renderer, "peer-empty", "No mock peers are available.", theme.color.muted))
    parent.add(card)
    return
  }
  card.add(label(renderer, "peer-discovery", `‹ ${peer.name} ›   ${peer.online ? "● online (mock)" : "○ offline (mock)"}   ${state.peerIndex + 1}/${peers.length} peers`, theme.color.success))
  card.add(label(renderer, "peer-navigation", "Use ← / → to browse discovered mock destinations.", theme.color.muted))
  const pattern = decorativePattern(state.peerIndex)
  pattern.forEach((line, index) => card.add(label(renderer, `identity-pattern-${index}`, `    ${line}`, theme.color.remote)))
  card.add(label(renderer, "pattern-warning", "Decorative pattern only · not a scannable invitation or identity proof.", theme.color.warning))
  card.add(label(renderer, "peer-endpoint", `Destination record: ${peer.host}:${peer.port}`, theme.color.text))
  card.add(label(renderer, "peer-fingerprint", `Fingerprint for manual comparison: ${peer.fingerprint}`, theme.color.focus))
  card.add(label(renderer, "manual-verify-note", "Compare this value out-of-band yourself. This app saves no “verified” state.", theme.color.muted))
  if (state.status.startsWith("Fingerprint shown for manual comparison")) card.add(label(renderer, "manual-compare-feedback", "Fingerprint displayed for comparison · no verified state was saved.", theme.color.focus))
  const isFavorite = favorites.some((item) => item.peerId === peer.id)
  card.add(label(renderer, "favorite-status", isFavorite ? "Local Favorite saved · shortcut only, not trusted or paired" : "Not a Favorite · saved destinations do not become trusted peers", theme.color.warning))
  const discoveryStatus = state.identityStep === 3
    ? "Mock discovery timed out · no connection was created"
    : ["Looking for a peer", "A mock destination appeared", "Ready to request a transfer after consent"][Math.min(state.identityStep, 2)]
  card.add(label(renderer, "identity-flow", `Mock discovery preview: ${discoveryStatus}`, state.identityStep === 3 ? theme.color.warning : theme.color.text))
  card.add(actionRow(renderer, "peer-actions", [
    actionButton(renderer, "compare-fingerprint", "Compare manually · V", "manual-compare", actions.command, { fg: theme.color.focus }),
    actionButton(renderer, "peer-timeout", "Simulate timeout · E", "peer-timeout", actions.command, { fg: theme.color.warning }),
    actionButton(renderer, "peer-retry", "Retry preview · R", "peer-retry", actions.command, { fg: theme.color.success }),
    actionButton(renderer, "toggle-favorite", `${isFavorite ? "Remove Favorite" : "Save Favorite locally"} · F`, "toggle-favorite", actions.command, { fg: theme.color.warning }),
    actionButton(renderer, "open-favorites", "Favorites · P", "favorites", actions.command, { fg: theme.color.remote }),
    actionButton(renderer, "peer-close", "Back · Esc", "workspace", actions.command, { fg: theme.color.muted }),
  ], width < theme.layout.veryNarrowWidth))
  card.add(label(renderer, "peer-consent-separation", "Identity comparison, local Favorites, and per-transfer consent are separate actions.", theme.color.dim))
  parent.add(card)
}

function renderFavorites(parent: BoxRenderable, data: RenderData, width: number): void {
  const { renderer, state, favorites, actions } = data
  const card = pageCard(renderer, "favorites-screen", "Local Favorites", theme.color.warning, state.revealFrame)
  card.add(label(renderer, "favorites-disclaimer", "Saved destination shortcuts only · not a pairing, verification, or auto-accept rule.", theme.color.warning))
  if (favorites.length === 0) card.add(label(renderer, "favorites-empty", "No Favorites yet. Open Peers and save a destination locally.", theme.color.muted))
  favorites.forEach((favorite, index) => {
    const selected = index === state.favoriteCursor
    const row = panel(renderer, `favorite-${favorite.peerId}`, {
      height: 2,
      flexDirection: "column",
      backgroundColor: selected ? theme.color.selected : theme.color.surface,
      onMouseDown: (event) => { if (event.button === MouseButton.LEFT) actions.selectFavorite(index) },
    })
    row.add(label(renderer, `favorite-name-${favorite.peerId}`, `  ${selected ? "›" : "•"} ${truncate(favorite.alias, Math.max(12, width - 20))}`, theme.color.text))
    row.add(label(renderer, `favorite-host-${favorite.peerId}`, `    ${favorite.host}:${favorite.port}  ·  fingerprint ${favorite.fingerprint}`, theme.color.muted))
    card.add(row)
  })
  card.add(actionRow(renderer, "favorites-actions", [
    actionButton(renderer, "favorite-open-peer", "View selected · Enter", "favorite-open", actions.command, { fg: theme.color.focus, disabled: favorites.length === 0 }),
    actionButton(renderer, "favorite-remove", "Remove selected · F", "favorite-remove", actions.command, { fg: theme.color.danger, disabled: favorites.length === 0 }),
    actionButton(renderer, "favorites-back", "Back · Esc", "workspace", actions.command, { fg: theme.color.muted }),
  ], width < theme.layout.veryNarrowWidth))
  parent.add(card)
}

function renderDiff(parent: BoxRenderable, data: RenderData, width: number): void {
  const { renderer, state, filesystem, actions } = data
  const entries = filesystem.list(state.activePane, state.paths[state.activePane])
  const entry = entries[state.cursors[state.activePane]]
  const card = pageCard(renderer, "diff-inspector", `Diff inspector · ${entry?.name ?? "file"}`, theme.color.warning, state.revealFrame)
  card.add(label(renderer, "diff-caption", "Mock content · no local files are read.", theme.color.muted))
  const lines = filesystem.getDiff(entry?.id ?? "")
  const hunk = Math.max(0, Math.min(state.diffHunk, Math.max(0, lines.length - 1)))
  lines.forEach((line, index) => {
    const accent = line.startsWith("+") ? theme.color.success : line.startsWith("-") ? theme.color.danger : theme.color.text
    card.add(label(renderer, `diff-line-${index}`, `  ${String(index + 1).padStart(2, "0")}  ${truncate(line, Math.max(10, width - 16))}${index === hunk ? "  ‹" : ""}`, accent))
  })
  card.add(label(renderer, "diff-hunk-status", `Hunk cursor ${hunk + 1}/${lines.length}  ·  Tab next  ·  Enter stage current file`, theme.color.muted))
  card.add(actionRow(renderer, "diff-actions", [
    actionButton(renderer, "diff-next", "Next hunk · Tab", "diff-next", actions.command, { fg: theme.color.warning }),
    actionButton(renderer, "diff-stage", "Stage file · Enter", "diff-stage", actions.command, { fg: theme.color.focus }),
    actionButton(renderer, "diff-close", "Close · Esc", "workspace", actions.command, { fg: theme.color.muted }),
  ], width < theme.layout.veryNarrowWidth))
  parent.add(card)
}

function renderHelp(parent: BoxRenderable, data: RenderData, width: number): void {
  const { renderer, state, actions, mode } = data
  const card = pageCard(renderer, "help-screen", "Keyboard & mouse help", theme.color.focus, state.revealFrame)
  const rows = [
    ["↑ / ↓", "Move through files; directories use Enter"],
    ["Tab / 1 / 2", "Switch panes; narrow terminals show one pane at a time"],
    ["Space", "Stage / unstage the focused file"],
    ["a / A", "Stage all / clear staging in the active folder"],
    ["Enter / Backspace", "Open directory / go to its parent"],
    ["s", mode === "real" ? "Review staged files and send to the selected peer" : "Review staged files and simulate a send"],
    ["i", mode === "real" ? "Incoming transfers arrive from the network" : "Create a mock incoming request"],
    ["q / v / p", mode === "real" ? "Peer list is in the Receiver pane" : "Peer preview / manual fingerprint comparison / Favorites"],
    ["d / t / ?", "Diff / transfer queue / help"],
    ["Mouse", "Click rows and actions; scroll panes to browse"],
    ["Narrow screens", "Use Local / Remote tabs and the Stage, Send, and Receive toolbar actions"],
    ["Esc / Ctrl+C", "Back or cancel / quit"],
  ]
  rows.forEach(([key, description], index) => {
    const prefix = `${key?.padEnd(20)} `
    card.add(label(renderer, `help-row-${index}`, `${prefix}${truncate(description ?? "", Math.max(10, width - prefix.length - 6))}`, index % 2 ? theme.color.text : theme.color.focus))
  })
  card.add(label(renderer, "help-note", data.mode === "real"
    ? "Real mode: live files, Noise-encrypted transfers, UDP-multicast discovery."
    : "Phase 1 is a deterministic simulation: no real files, networking, synchronization, pairing, or disk persistence.", theme.color.warning))
  card.add(actionButton(renderer, "help-back", "Back · Esc", "workspace", actions.command, { fg: theme.color.muted }))
  parent.add(card)
}

function renderQueue(parent: BoxRenderable, data: RenderData, width: number): void {
  const { renderer, state, queue, actions, mode } = data
  const card = pageCard(renderer, "transfer-queue", "Transfer queue · this session", theme.color.remote, state.revealFrame)
  card.add(label(renderer, "queue-disclaimer", mode === "real"
    ? "In-memory history only · cleared when this process exits."
    : "In-memory mock history only · cleared when this process exits.", theme.color.warning))
  if (!queue.length) card.add(label(renderer, "queue-empty", mode === "real"
    ? "No transfer requests yet. Stage files and press S to send; incoming transfers appear here for review."
    : "No transfer requests yet. Send staged files or press I to simulate an incoming request.", theme.color.muted))
  queue.slice(0, 12).forEach((record, index) => {
    const direction = record.direction === "incoming" ? "IN" : "OUT"
    const line = `${String(index + 1).padStart(2, "0")} ${direction}  ${statusLabel(record.status).padEnd(12)} ${record.peerName}  ${record.acceptedFiles.length}/${record.files.length} files`
    card.add(label(renderer, `queue-record-${record.id}`, truncate(line, Math.max(24, width - 8)), record.status === "failed" ? theme.color.danger : record.status === "complete" ? theme.color.success : theme.color.text))
    if (record.error) card.add(label(renderer, `queue-error-${record.id}`, `   ${record.error}`, theme.color.danger))
  })
  const canRetry = queue.some((record) => record.status === "failed" || record.status === "cancelled")
  card.add(actionRow(renderer, "queue-actions", [
    actionButton(renderer, "queue-retry", "Retry latest failed/cancelled · R", "queue-retry", actions.command, { fg: theme.color.focus, disabled: !canRetry }),
    actionButton(renderer, "queue-back", "Back · Esc", "workspace", actions.command, { fg: theme.color.muted }),
  ], width < theme.layout.veryNarrowWidth))
  parent.add(card)
}

function renderFooter(data: RenderData, width: number, compact: boolean): BoxRenderable {
  const { renderer, state, actions } = data
  const footer = panel(renderer, "footer", {
    height: compact ? 1 : 2,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    marginTop: compact ? 0 : 1,
  })
  let hint: string
  const realMode = data.mode === "real"
  if (compact) {
    hint = state.screen === "workspace"
      ? realMode
        ? "↑↓ move · Tab pane · Space stage · s send · ? help"
        : "↑↓ move · Tab pane · Space stage · s send · i receive · ? help"
      : "Enter select · Esc back · Ctrl+C quit"
  } else {
    const hints: Record<Screen, string> = {
      workspace: realMode
        ? "↑↓ Navigate  ·  Tab Pane  ·  Space Stage  ·  s Send  ·  d Diff  ·  ? Help"
        : "↑↓ Navigate  ·  Tab Pane  ·  Space Stage  ·  s Send  ·  i Receive  ·  d Diff  ·  q Peers  ·  ? Help",
      "send-review": realMode
        ? "Enter Send to peer  ·  Esc Back"
        : "Enter Continue to consent  ·  q Choose peer  ·  Esc Back",
      consent: "↑↓ Focus  ·  Space Include/skip  ·  r Rename  ·  d Destination  ·  a Accept all  ·  Enter Accept selected  ·  x Decline",
      transfer: realMode
        ? "Esc Back"
        : "Esc Cancel  ·  e Simulate failure  ·  r Retry  ·  Enter Return",
      peer: "←→ Browse  ·  v Compare  ·  e Simulate timeout  ·  r Retry preview  ·  f Favorite  ·  p List Favorites  ·  Esc Back",
      favorites: "↑↓ Select  ·  Enter View  ·  f Remove Favorite  ·  Esc Back",
      diff: "Tab Next hunk  ·  Enter Stage file  ·  Esc Back",
      help: "Esc Back  ·  Ctrl+C Quit",
      queue: "r Retry latest failure  ·  Esc Back",
    }
    hint = hints[state.screen]
  }
  footer.add(label(renderer, "footer-hint", truncate(hint, width - 4), theme.color.muted))
  return footer
}

function pageCard(renderer: CliRenderer, id: string, title: string, accent: string, revealFrame: number): BoxRenderable {
  const reveal = motion.revealFrames[Math.min(revealFrame, motion.revealFrames.length - 1)]
  const card = panel(renderer, `${id}-card`, {
    flexGrow: 1,
    minHeight: 1,
    flexDirection: "column",
    border: true,
    borderColor: accent,
    backgroundColor: theme.color.surface,
    paddingLeft: 2,
    paddingRight: 2,
    paddingTop: 1,
    paddingBottom: 1,
    title: ` ${reveal} ${title} `,
    titleColor: accent,
  })
  return card
}

function decorativePattern(seed: number): string[] {
  const lines: string[] = []
  for (let y = 0; y < 5; y += 1) {
    let line = ""
    for (let x = 0; x < 13; x += 1) {
      const corner = ((x < 4 && y < 4) || (x > 8 && y < 4) || (x < 4 && y > 5))
      line += corner || ((x * 17 + y * 31 + seed * 7) % 5 < 2) ? "██" : "  "
    }
    lines.push(line)
  }
  return lines
}

function renamePreview(name: string): string {
  const dot = name.lastIndexOf(".")
  const suffix = " (from peer)"
  return dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`
}
