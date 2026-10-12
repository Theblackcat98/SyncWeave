import { BoxRenderable, MouseButton, RGBA, type CliRenderer } from "@opentui/core"
import type { AppMode, AppState, ConsentFile, MockEntry, MockPeer, Pane, Screen, TransferRecord } from "../domain.js"
import { previewSavedName } from "../services/safe-receive-sink.js"
import { formatBytes } from "../domain.js"
import type { FileSystemService, PeerService } from "../services/ports.js"
import { icons, motion, theme } from "../theme.js"
import { actionButton, actionRow, asciiSafe, label, panel, progressGauge, stateColor, stateGlyph, truncate, type CommandHandler } from "./primitives.js"
import {
  buttonRows,
  cardContentRows,
  cardInnerWidth,
  chromeRows,
  contentWidth,
  headerInnerWidth,
  paneBodyRows,
  paneTopPadding,
  viewportOf,
  visiblePaneRows,
  windowStart,
  type Viewport,
} from "./layout.js"
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
  receiveDestinations: readonly string[]
  peers: MockPeer[]
  favorites: ReturnType<PeerService["favorites"]>
  queue: TransferRecord[]
  actions: RenderActions
  real?: { bindAddr: string; tcpPort: number } | null
}

interface RenderContext extends RenderData {
  vp: Viewport
  /** One directory listing per pane per render (P2-4). */
  list(pane: Pane): MockEntry[]
}

const SAS_BOX_ROWS = 5

export function renderApp(data: RenderData): void {
  const { renderer, state } = data
  const vp = viewportOf(Math.max(1, renderer.terminalWidth || 80), Math.max(6, renderer.terminalHeight || 24))
  for (const child of renderer.root.getChildren()) {
    renderer.root.remove(child)
    child.destroyRecursively()
  }
  renderer.setBackgroundColor(RGBA.fromHex(theme.color.background))
  if (vp.tooSmall) {
    renderer.root.add(renderTooSmall(renderer, vp))
    return
  }

  const ctx: RenderContext = { ...data, vp, list: listingCache(data.filesystem, state) }
  const root = panel(renderer, "app-root", {
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: theme.color.background,
    paddingLeft: vp.veryNarrow ? 0 : 1,
    paddingRight: vp.veryNarrow ? 0 : 1,
    paddingTop: 0,
    paddingBottom: 0,
  })
  renderer.root.add(root)
  root.add(renderHeader(ctx))

  const body = panel(renderer, "app-body", { flexGrow: 1, minHeight: 1, flexDirection: "column" })
  root.add(body)
  switch (state.screen) {
    case "workspace": renderWorkspace(body, ctx); break
    case "send-review": renderSendReview(body, ctx); break
    case "consent": renderConsent(body, ctx); break
    case "transfer": renderTransfer(body, ctx); break
    case "peer": renderPeer(body, ctx); break
    case "favorites": renderFavorites(body, ctx); break
    case "diff": renderDiff(body, ctx); break
    case "help": renderHelp(body, ctx); break
    case "queue": renderQueue(body, ctx); break
  }

  if (state.screen === "workspace" && chromeRows(vp).activity > 0) addActivity(root, ctx)
  root.add(renderFooter(ctx))
}

/** Each render reads a pane's directory once and reuses the result. */
function listingCache(filesystem: FileSystemService, state: AppState): (pane: Pane) => MockEntry[] {
  const cache = new Map<Pane, MockEntry[]>()
  return (pane) => {
    let entries = cache.get(pane)
    if (!entries) {
      entries = filesystem.list(pane, state.paths[pane])
      cache.set(pane, entries)
    }
    return entries
  }
}

function renderTooSmall(renderer: CliRenderer, vp: Viewport): BoxRenderable {
  const box = panel(renderer, "too-small", { flexGrow: 1, backgroundColor: theme.color.background })
  box.add(label(renderer, "too-small-title", truncate("Terminal too small", vp.width), theme.color.warning))
  box.add(label(renderer, "too-small-need", truncate(`Need ${theme.layout.minWidth}+ columns`, vp.width), theme.color.muted))
  return box
}

function renderHeader(ctx: RenderContext): BoxRenderable {
  const { renderer, state, mode, peers, vp } = ctx
  const { compact, veryNarrow } = vp
  const header = panel(renderer, "header", {
    height: chromeRows(vp).header,
    flexDirection: veryNarrow ? "column" : "row",
    alignItems: "center",
    border: !compact,
    // OpenTUI forces a border when borderColor is set even with border:false.
    ...(compact ? {} : { borderColor: theme.border.subtle }),
    backgroundColor: theme.color.surface,
    paddingLeft: veryNarrow ? 0 : 1,
    paddingRight: 1,
  })
  const inner = headerInnerWidth(vp)
  const realMode = mode === "real"
  const brand = truncate(`${icons.mark} SyncWeave 0.1.0`, inner)
  header.add(label(renderer, "brand", brand, theme.typography.brand))

  const frame = icons.discoveryFrames[state.discoveryFrame % icons.discoveryFrames.length]
  const onlineCount = peers.filter((peer) => peer.online).length
  const wide = vp.dual && !compact
  const peerNoun = `${onlineCount} ${realMode ? "peer" : "mock peer"}${onlineCount === 1 ? "" : "s"}`
  const peerFull = wide
    ? `  ${frame} ${realMode ? "DISCOVERY" : "MOCK DISCOVERY"} ${icons.dot} ${peerNoun}`
    : `  ${frame} ${peerNoun}`

  if (!wide || veryNarrow) {
    // Narrow headers carry only the brand and the peer count.
    header.add(label(renderer, "discovery-status", truncate(peerFull, inner), theme.color.success))
    return header
  }

  // Wide header. Segments are dropped in priority order (listen, mode,
  // active peer, tagline) until the rest fits; nothing wraps (R13).
  const bind = ctx.real?.bindAddr ?? "::"
  const port = ctx.real?.tcpPort ?? 0
  const activePeer = peers[state.peerIndex % Math.max(1, peers.length)]
  const segments = new Map<string, { text: string; fg: string }>([
    ["header-tagline", { text: "  TUI FILE TRANSFER", fg: theme.color.muted }],
    ["listen-indicator", { text: `  ${icons.dot} LISTENING [${bind}]:${port}`, fg: theme.color.muted }],
    ["active-peer", { text: `  ${icons.arrow} ${truncate(activePeer?.name ?? "No peer", 18)}`, fg: theme.color.remote }],
    ["mode-label", { text: `  ${icons.dot} ${realMode ? "REAL FILES" : "SIMULATION"}`, fg: theme.color.warning }],
  ])
  if (!realMode) segments.delete("listen-indicator")
  let room = inner - Bun.stringWidth(brand) - Bun.stringWidth(peerFull)
  const kept = new Set<string>()
  for (const id of ["listen-indicator", "mode-label", "active-peer", "header-tagline"]) {
    const segment = segments.get(id)
    if (!segment) continue
    const segmentWidth = Bun.stringWidth(segment.text)
    if (segmentWidth <= room) {
      kept.add(id)
      room -= segmentWidth
    }
  }
  const keptWidth = [...kept].reduce((sum, id) => sum + Bun.stringWidth(segments.get(id)!.text), 0)
  for (const id of ["header-tagline", "discovery-status", "listen-indicator", "active-peer", "mode-label"]) {
    if (id === "discovery-status") {
      header.add(label(renderer, id, truncate(peerFull, inner - Bun.stringWidth(brand) - keptWidth), theme.color.success))
    } else if (kept.has(id)) {
      const segment = segments.get(id)!
      header.add(label(renderer, id, segment.text, segment.fg))
    }
  }
  return header
}

function renderWorkspace(parent: BoxRenderable, ctx: RenderContext): void {
  const { renderer, state, mode, actions, peers, vp } = ctx
  const { width, dual, compact } = vp
  const realMode = mode === "real"
  const bodyHeader = panel(renderer, "workspace-toolbar", {
    height: chromeRows(vp).toolbar,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 1,
  })
  bodyHeader.add(label(renderer, "workspace-title", compact || !dual ? "WORKSPACE" : `  WORKSPACE  ${icons.dot}  Local changes, clearly staged`, theme.typography.heading))
  if (!dual) {
    bodyHeader.add(actionButton(renderer, "tab-local", "1 Local", "pane-local", actions.command, { fg: state.activePane === "local" ? theme.color.focus : theme.color.muted }))
    bodyHeader.add(actionButton(renderer, "tab-remote", realMode ? "2 Receiver" : "2 Remote", "pane-remote", actions.command, { fg: state.activePane === "remote" ? theme.color.remote : theme.color.muted }))
    bodyHeader.add(actionButton(renderer, "toolbar-stage", `Stage ${icons.dot} Space`, "toggle-current", actions.command))
    bodyHeader.add(actionButton(renderer, "toolbar-send", "Send", "send-review", actions.command))
    // Receive, Peers and Favorites only exist in the mock simulation.
    if (!realMode) bodyHeader.add(actionButton(renderer, "toolbar-receive", "Receive", "incoming", actions.command, { fg: theme.color.success }))
  }
  if (dual && !compact) {
    bodyHeader.add(actionButton(renderer, "toolbar-stage", "Stage", "toggle-current", actions.command))
    bodyHeader.add(actionButton(renderer, "toolbar-send", "Send", "send-review", actions.command))
    if (!realMode) {
      bodyHeader.add(actionButton(renderer, "toolbar-receive", "Receive", "incoming", actions.command, { fg: theme.color.success }))
      bodyHeader.add(actionButton(renderer, "toolbar-peers", "Peers", "peer", actions.command, { fg: theme.color.remote }))
      bodyHeader.add(actionButton(renderer, "toolbar-favorites", "Favorites", "favorites", actions.command, { fg: theme.color.warning }))
    }
    bodyHeader.add(actionButton(renderer, "toolbar-queue", "Queue", "queue", actions.command, { fg: theme.color.muted }))
  }
  parent.add(bodyHeader)

  const workspace = panel(renderer, "workspace-panes", {
    flexGrow: 1,
    minHeight: 1,
    flexDirection: dual ? "row" : "column",
    gap: 1,
  })
  parent.add(workspace)
  if (dual) {
    workspace.add(renderPane(ctx, "local", Math.floor((width - 8) / 2)))
    // In real mode the receiver's files are never shown: the remote pane is
    // a status panel, not a file list (out of scope).
    workspace.add(
      realMode
        ? renderRemoteStatus(ctx, Math.floor((width - 8) / 2))
        : renderPane(ctx, "remote", Math.floor((width - 8) / 2)),
    )
  } else {
    const showRemoteStatus = realMode && state.activePane === "remote"
    workspace.add(showRemoteStatus ? renderRemoteStatus(ctx, width - 2) : renderPane(ctx, state.activePane, width - 2))
    if (!compact) {
      const note = peers[state.peerIndex % Math.max(1, peers.length)]
      const noteText =
        realMode
          ? `Target: ${note?.name ?? "No peer"}  ${icons.dot}  local files are real  ${icons.dot}  receiver files are not shown`
          : `Target: ${note?.name ?? "No mock peer"}  ${icons.dot}  ${state.activePane === "local" ? `Local ${icons.arrow} Remote` : `Remote ${icons.arrow} Local`}  ${icons.dot}  all data is simulated`
      workspace.add(label(renderer, "narrow-peer-note", truncate(noteText, width - 4), theme.color.muted))
    }
  }
}

function renderPane(ctx: RenderContext, pane: Pane, paneWidth: number): BoxRenderable {
  const { renderer, state, actions, mode, vp } = ctx
  const path = state.paths[pane]
  const entries = ctx.list(pane)
  const rows = visiblePaneRows(vp)
  const cursor = Math.min(state.cursors[pane], Math.max(entries.length - 1, 0))
  const offset = windowStart(state.scrollOffsets[pane], cursor, rows, entries.length)
  const inner = paneWidth - 4
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
    title: asciiSafe(` ${pane === "local" ? "LOCAL SOURCE" : "REMOTE DESTINATION"} `),
    titleColor: borderColor,
    backgroundColor: theme.color.surface,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: paneTopPadding(vp),
    onMouseScroll: (event) => {
      if (event.scroll) actions.scrollPane(pane, event.scroll.direction === "down" ? "down" : "up")
    },
  })
  paneBox.add(label(renderer, `${pane}-path`, truncate(path, inner), theme.color.muted))
  if (offset > 0) paneBox.add(label(renderer, `${pane}-scroll-top`, truncate(`${icons.up} ${offset} more above`, inner), theme.color.dim))

  const realMode = mode === "real"
  entries.slice(offset, offset + rows).forEach((entry, visibleIndex) => {
    const index = offset + visibleIndex
    const focused = state.activePane === pane && index === cursor
    const selected = state.staged[pane].has(entry.id)
    const icon = entry.kind === "directory" ? icons.directory : entry.name.endsWith(".gz") ? icons.archive : icons.file
    // Real mode has no sync-state model; the mock SYNC badge would lie.
    const stateLabel = entry.kind === "directory" ? "" : ({ synced: "SYNC", added: "NEW", modified: "EDIT", deleted: "DEL" } as const)[entry.state]
    const left = `${selected ? icons.check : " "} ${realMode ? "" : `${stateGlyph(entry.state)} `}${icon} `
    const size = formatBytes(entry.bytes).padStart(7)
    const meta = truncate(` ${entry.kind === "directory" ? "DIR" : realMode ? size : `${size} ${stateLabel}`}`, 16)
    const nameBudget = Math.max(4, inner - Bun.stringWidth(left) - Bun.stringWidth(meta))
    const row = panel(renderer, `${pane}-entry-${entry.id}`, {
      height: 1,
      flexDirection: "row",
      flexShrink: 0,
      backgroundColor: focused ? theme.color.selected : theme.color.surface,
      onMouseDown: (event) => {
        if (event.button === MouseButton.LEFT) actions.selectEntry(pane, index)
      },
    })
    row.add(label(renderer, `${pane}-entry-state-${entry.id}`, left, focused ? theme.color.white : stateColor(entry.state)))
    // Unsupported entries (symlink, FIFO…) show their reason instead of a size.
    const displayName = entry.unsupported ? `${entry.name} [${entry.unsupported}]` : entry.name
    row.add(label(renderer, `${pane}-entry-name-${entry.id}`, truncate(displayName, nameBudget), focused ? theme.color.white : entry.unsupported ? theme.color.muted : theme.color.text))
    row.add(label(renderer, `${pane}-entry-meta-${entry.id}`, meta, stateColor(entry.state)))
    paneBox.add(row)
  })

  if (offset + rows < entries.length) paneBox.add(label(renderer, `${pane}-scroll-bottom`, truncate(`${icons.down} ${entries.length - offset - rows} more ${icons.dot} mouse wheel to scroll`, inner), theme.color.dim))
  if (entries.length === 0) {
    const listErr = ctx.filesystem.listError?.(pane, state.paths[pane])
    const emptyText = listErr
      ? `Cannot read folder: ${listErr}`
      : realMode ? "This folder is empty." : "This mock folder is empty."
    paneBox.add(label(renderer, `${pane}-empty`, truncate(emptyText, inner), listErr ? theme.color.danger : theme.color.muted))
  } else {
    const total = ctx.filesystem.listTotal?.(pane, state.paths[pane])
    if (total !== undefined && total > entries.length) {
      paneBox.add(label(renderer, `${pane}-truncated`, truncate(`Showing first ${entries.length} of ${total} entries`, inner), theme.color.muted))
    }
  }
  return paneBox
}

/**
 * Real-mode replacement for the remote file list. The receiver's files are
 * never shown (out of scope): this panel reports peer/session state and
 * transfer status only, with no file rows and no staging controls.
 */
function renderRemoteStatus(ctx: RenderContext, paneWidth: number): BoxRenderable {
  const { renderer, state, peers, queue, vp } = ctx
  const inner = paneWidth - 4
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
    paddingTop: paneTopPadding(vp),
  })
  const peer = peers[state.peerIndex % Math.max(1, peers.length)]
  // Real records: the transfer the app is driving, else the newest in flight, else none.
  const active = queue.find((record) => record.id === state.activeTransferId)
    ?? queue.find((record) => record.status === "queued" || record.status === "transferring")
  const latest = queue[0]
  const peerLine = peer
    ? `Peer: ${peer.name} (claimed, ${peer.host}:${peer.port})`
    : "Peer: none selected"
  const sessionLine = active ? `Session: ${statusLabel(active.status)} with ${active.peerName}` : "Session: no active session"
  const transferLine = active
    ? `Transfer: ${active.acceptedFiles.length}/${active.files.length} files ${icons.dot} ${active.progress}%`
    : latest
      ? `Transfer: last ${statusLabel(latest.status)} ${icons.dot} ${latest.acceptedFiles.length}/${latest.files.length} files`
      : "Transfer: idle"

  // Build the panel in priority order, then keep only the rows that fit.
  const rows: Array<{ id: string; text: string; fg: string }> = [
    { id: "status-peer", text: peerLine, fg: theme.color.text },
    { id: "status-session", text: sessionLine, fg: theme.color.text },
    { id: "status-transfer", text: transferLine, fg: theme.color.text },
  ]
  const bodyRows = paneBodyRows(vp)
  if (peers.length === 0) {
    rows.push({ id: "status-no-peers", text: `No peers yet ${icons.dot} discovering${icons.ellipsis} (or add --peer host:port)`, fg: theme.color.muted })
  } else {
    rows.push({ id: "status-peer-hint", text: `${icons.up}/${icons.down} select target ${icons.dot} ${peers.length} peer${peers.length === 1 ? "" : "s"}`, fg: theme.color.muted })
    // Three scope lines follow the list; the rest is the peer window.
    const roomForPeers = Math.max(1, bodyRows - rows.length - 3)
    const selectedIndex = state.peerIndex % Math.max(1, peers.length)
    const windowSize = peers.length <= roomForPeers ? peers.length : Math.max(1, roomForPeers - 1)
    const start = windowStart(0, selectedIndex, windowSize, peers.length)
    const end = Math.min(peers.length, start + windowSize)
    peers.slice(start, end).forEach((p, offset) => {
      const index = start + offset
      const selected = index === selectedIndex
      // Manual peers were never probed; discovered peers were seen via multicast.
      const stateTag = p.online ? "" : " [not probed]"
      rows.push({
        id: `status-peer-${index}`,
        text: `${selected ? icons.pointer : " "} ${p.name}  ${p.host}:${p.port}${stateTag}`,
        fg: selected ? theme.color.focus : theme.color.text,
      })
    })
    if (end < peers.length || start > 0) {
      const above = start > 0 ? `${icons.up} ${start} ` : ""
      const below = end < peers.length ? `${icons.down} ${peers.length - end} more` : ""
      rows.push({ id: "status-peer-overflow", text: `  ${above}${below}`.trimEnd(), fg: theme.color.muted })
    }
  }
  rows.push({ id: "status-scope-1", text: "The receiver's files are not shown here.", fg: theme.color.muted })
  rows.push({ id: "status-scope-2", text: "Browsing a peer's filesystem is out of scope.", fg: theme.color.muted })
  rows.push({ id: "status-scope-3", text: "Each transfer needs the receiver's consent.", fg: theme.color.muted })
  for (const row of rows.slice(0, Math.max(1, bodyRows))) {
    box.add(label(renderer, row.id, truncate(row.text, inner), row.fg))
  }
  return box
}

function addActivity(parent: BoxRenderable, ctx: RenderContext): void {
  const { renderer, state, vp } = ctx
  const { width, compact } = vp
  const stagedCount = state.staged.local.size + state.staged.remote.size
  const selectedPaneFiles = ctx.list(state.activePane).filter((entry) => state.staged[state.activePane].has(entry.id))
  const stagedBytes = selectedPaneFiles.reduce((sum, entry) => sum + entry.bytes, 0)
  const narrow = !vp.dual
  const activity = panel(renderer, "activity", {
    height: chromeRows(vp).activity,
    flexDirection: "column",
    border: !compact,
    // OpenTUI forces a border when borderColor is set even with border:false.
    ...(compact ? {} : { borderColor: theme.border.subtle }),
    backgroundColor: compact ? theme.color.background : theme.color.surface,
    paddingLeft: compact ? 0 : 1,
  })
  const status = narrow && state.status.startsWith("Ready") ? "Ready" : state.status
  const d = icons.dot
  const firstLine = narrow
    ? `  ${stagedCount} staged ${d} ${formatBytes(stagedBytes)} ${state.activePane} ${d} ${status}`
    : `  ${stagedCount} staged  ${d}  ${formatBytes(stagedBytes)} in ${state.activePane}  ${d}  ${state.status}`
  activity.add(label(renderer, "activity-summary", truncate(firstLine, Math.max(12, width - 6)), stagedCount ? theme.color.focus : theme.color.muted))
  if (!compact && ctx.mode !== "real") {
    const legend = narrow
      ? `  ${icons.synced} sync  ${icons.added} add  ${icons.modified} edit  ${icons.deleted} del`
      : `  ${icons.synced} synced  ${icons.added} added  ${icons.modified} modified  ${icons.deleted} deleted  ${d}  0 network connections`
    activity.add(label(renderer, "activity-legend", truncate(legend, Math.max(12, width - 6)), theme.color.dim))
  }
  parent.add(activity)
}

function renderSendReview(parent: BoxRenderable, ctx: RenderContext): void {
  const { renderer, state, actions, peers, mode, vp } = ctx
  const realMode = mode === "real"
  // Real mode always sends from the Local staged set, regardless of focus.
  const sendPane = realMode ? "local" : state.activePane
  const files = ctx.list(sendPane).filter((entry) => state.staged[sendPane].has(entry.id))
  const peer = peers[state.peerIndex % Math.max(1, peers.length)]
  const inner = cardInnerWidth(vp)
  const sas = state.sendSasConfirm
  const card = pageCard(ctx, "send-review", "Review outgoing files", theme.color.focus)
  const peerName = peer ? (realMode ? `${peer.name} (claimed)` : peer.name) : "no peer selected"
  card.add(label(renderer, "send-direction", truncate(`${sendPane === "local" ? "Local" : "Remote"} ${icons.arrow} ${peerName}`, inner), theme.color.remote))
  if (!realMode) {
    card.add(label(renderer, "send-mock-note", truncate("Mock preview only · no files or network requests are sent.", inner), theme.color.warning))
  }
  if (sas) {
    // The sender confirms the receiver's security code before any file metadata goes out (P0-1).
    const box = panel(renderer, "send-sas-confirm", {
      border: true,
      borderColor: theme.color.warning,
      title: " CONFIRM SECURITY CODE ",
      titleColor: theme.color.warning,
      backgroundColor: theme.color.surfaceRaised,
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "column",
    })
    const boxInner = inner - 4
    box.add(label(renderer, "send-sas-code", truncate(`Security code: ${sas.sas} ${icons.dash} does it match the receiver's screen?`, boxInner), theme.color.warning))
    box.add(label(renderer, "send-sas-keys", truncate(`Enter/y confirm ${icons.dot} Esc/n cancel`, boxInner), theme.color.text))
    box.add(label(renderer, "send-sas-peer", truncate(`Receiver: ${sas.peerName} (claimed) ${icons.dot} ${sas.peerFingerprint}`, boxInner), theme.color.remote))
    card.add(box)
  }
  card.add(label(renderer, "send-count", truncate(`${files.length} staged  ${icons.dot}  ${formatBytes(files.reduce((sum, file) => sum + file.bytes, 0))}`, inner), theme.color.white))
  card.add(label(renderer, "send-status", truncate(state.status, inner), theme.color.muted))
  if (state.sending) card.add(label(renderer, "send-sending", `Sending${icons.ellipsis}`, theme.color.focus))

  const sendCaptions = [
    state.sending ? `Sending${icons.ellipsis}` : "Ask receiver · Enter",
    state.sending ? "Cancel send · Esc" : "Back · Esc",
    ...(realMode ? [] : ["Choose peer · Q"]),
  ]
  // Rows the fixed parts take. The file list gets whatever is left.
  const fixed = 1 + (realMode ? 0 : 1) + (sas ? SAS_BOX_ROWS : 0) + 1 + 1 + (state.sending ? 1 : 0) + 1 + (1 + buttonRows(sendCaptions, inner, vp.veryNarrow))
  const budget = Math.max(0, cardContentRows(vp) - fixed)
  const showCount = files.length <= budget ? files.length : Math.max(0, budget - 1)
  files.slice(0, showCount).forEach((file, index) => {
    card.add(label(renderer, `send-file-${index}`, truncate(`  ${icons.check} ${file.name}  ${formatBytes(file.bytes)}`, inner), theme.color.text))
  })
  if (files.length > showCount) card.add(label(renderer, "send-overflow", `  + ${files.length - showCount} more`, theme.color.muted))
  card.add(label(renderer, "send-consent-explainer", truncate(realMode
    ? "Next: the receiver reviews and accepts. Files stream only after their consent."
    : "Next: preview a receiver-hosted request. Accepted files alone advance to mock progress.", inner), theme.color.muted))
  const buttons = [
    actionButton(renderer, "send-submit", sendCaptions[0]!, "send-to-consent", actions.command, { disabled: files.length === 0 || state.sending || !!sas }),
    actionButton(renderer, "send-back", sendCaptions[1]!, "workspace", actions.command, { fg: theme.color.muted }),
  ]
  if (!realMode) buttons.push(actionButton(renderer, "send-peers", "Choose peer · Q", "peer", actions.command, { fg: theme.color.remote }))
  card.add(actionRow(renderer, "send-actions", buttons, vp.veryNarrow))
  parent.add(card)
}

function renderConsent(parent: BoxRenderable, ctx: RenderContext): void {
  const { renderer, state, actions, mode, vp, receiveDestinations } = ctx
  const realMode = mode === "real"
  const request = state.request
  const card = pageCard(ctx, "consent-review", request?.mode === "incoming" ? "Incoming transfer request" : "Mock receiver consent", theme.color.success)
  if (!request) {
    card.add(label(renderer, "consent-empty", "There is no active request.", theme.color.muted))
    parent.add(card)
    return
  }
  const inner = cardInnerWidth(vp)
  const incoming = request.mode === "incoming"
  const senderName = incoming ? (realMode ? "Sender (claimed)" : "Sender") : "Mock receiver"
  const endpoint = request.peer.host ? `  ${icons.dot}  ${request.peer.host}:${request.peer.port}` : ""
  card.add(label(renderer, "consent-sender", truncate(`${senderName}: ${request.peer.name}${endpoint}`, inner), theme.color.remote))
  // The SAS is the human-confirmable identity: the sender's screen shows the
  // same code. Confirm it out of band before accepting — the alias above is
  // attacker-chosen.
  if (request.sas) {
    card.add(label(renderer, "consent-sas", truncate(`Security code: ${request.sas} ${icons.dash} confirm with the sender before accepting`, inner), theme.color.warning))
  }
  card.add(label(renderer, "consent-count", truncate(`${request.files.length} proposed  ${icons.dot}  ${request.files.filter((file) => file.accepted).length} selected  ${icons.dot}  ${totalBytes(request.files.filter((file) => file.accepted))}`, inner), theme.color.white))

  const destCount = Math.max(1, receiveDestinations.length)
  const multiDestination = receiveDestinations.length > 1
  const destIndex = state.receiveDestinationIndex % destCount
  const destActive = receiveDestinations[destIndex] ?? ""
  // Real mode with one destination: the cycle control is a no-op, so it is not offered.
  const destHint = realMode && !multiDestination ? `[+] add ${icons.dot} [-] remove` : `[D] cycle ${icons.dot} [+] add ${icons.dot} [-] remove`
  const destPrefix = "Destination: "
  const destSuffix = `  (${destIndex + 1}/${receiveDestinations.length})  ${destHint}`
  const destPathBudget = Math.max(8, inner - Bun.stringWidth(destPrefix) - Bun.stringWidth(destSuffix))
  card.add(label(renderer, "consent-destination", truncate(`${destPrefix}${truncate(destActive, destPathBudget)}${destSuffix}`, inner), theme.color.muted))
  if (state.destinationInput !== null) {
    card.add(label(renderer, "consent-destination-input", truncate(`Add destination: ${state.destinationInput}${icons.cursor}  (Enter save ${icons.dot} Esc cancel)`, inner), theme.color.focus))
  }
  card.add(label(renderer, "consent-scope", truncate("Review every item. Nothing streams until you accept this transfer.", inner), theme.color.warning))
  card.add(label(renderer, "consent-status", truncate(state.status, inner), theme.color.text))

  // Rows the fixed parts take. The file window gets the rest.
  const focused = request.files[state.selectedConsentFile]
  const optionCaptions = [
    `${focused?.accepted ? "Skip" : "Include"} file · Space`,
    ...(incoming ? [] : [`${focused?.renamed ? "Undo rename" : "Rename"} · R`]),
    ...(!realMode || multiDestination ? ["Destination · D"] : []),
  ]
  const actionCaptions = ["Accept all · A", "Accept selected · Enter", "Decline · X"]
  const fixed = 1 + (request.sas ? 1 : 0) + 1 + 1 + (state.destinationInput !== null ? 1 : 0) + 1 + 1 + 1
    + (1 + buttonRows(optionCaptions, inner, vp.veryNarrow))
    + 1
    + (1 + buttonRows(actionCaptions, inner, vp.veryNarrow))
  // Rows left for the file window. With room for only one row, the scroll hint is dropped.
  const available = Math.max(1, cardContentRows(vp) - fixed)
  const needsHint = request.files.length > available && available >= 2
  const windowSize = request.files.length <= available ? request.files.length : needsHint ? available - 1 : 1
  const offset = windowStart(state.consentScrollOffset, state.selectedConsentFile, windowSize, request.files.length)
  if (needsHint) {
    const acceptedCount = request.files.filter((f) => f.accepted).length
    const moreAbove = offset > 0 ? `${icons.up} ${offset} more` : ""
    const moreBelow = offset + windowSize < request.files.length ? `${icons.down} ${request.files.length - offset - windowSize} more` : ""
    const hint = [moreAbove, moreBelow].filter(Boolean).join(` ${icons.dot} `)
    card.add(label(renderer, "consent-scroll-hint", truncate(`${hint} ${icons.dot} ${acceptedCount}/${request.files.length} accepted`, inner), theme.color.muted))
  }
  const list = panel(renderer, "consent-file-list", { flexDirection: "column", flexGrow: 1, minHeight: 1, marginTop: 1 })
  request.files.slice(offset, offset + windowSize).forEach((file, i) => list.add(renderConsentFile(ctx, file, offset + i, inner)))
  card.add(list)
  const optionButtons = [
    actionButton(renderer, "toggle-selected", optionCaptions[0]!, "toggle-consent", actions.command, { fg: theme.color.warning }),
    // Rename is a mock-era control with no real effect; hide it in real mode.
    ...(incoming ? [] : [actionButton(renderer, "rename-selected", optionCaptions[1]!, "rename-consent", actions.command, { fg: theme.color.remote })]),
    // A destination control only when there is something to cycle through.
    ...(!realMode || multiDestination ? [actionButton(renderer, "destination-select", "Destination · D", "cycle-destination", actions.command, { fg: theme.color.muted })] : []),
  ]
  card.add(actionRow(renderer, "consent-file-options", optionButtons, vp.veryNarrow))
  card.add(label(renderer, "consent-separation", truncate(realMode
    ? "Accepting applies to this transfer only. Nothing is remembered or trusted."
    : `Per-transfer choice only ${icons.dot} Favorites and manual fingerprint comparison do not grant consent.`, inner), theme.color.dim))
  card.add(actionRow(renderer, "consent-actions", [
    actionButton(renderer, "accept-all", actionCaptions[0]!, "consent-all", actions.command, { fg: theme.color.success }),
    actionButton(renderer, "accept-subset", actionCaptions[1]!, "consent-accept", actions.command, { fg: theme.color.focus, disabled: !request.files.some((file) => file.accepted) }),
    actionButton(renderer, "decline-request", actionCaptions[2]!, "consent-decline", actions.command, { fg: theme.color.danger }),
  ], vp.veryNarrow))
  parent.add(card)
}

function renderConsentFile(ctx: RenderContext, file: ConsentFile, index: number, inner: number): BoxRenderable {
  const { renderer, state, actions, mode } = ctx
  const selected = state.selectedConsentFile === index
  const row = panel(renderer, `consent-file-${index}`, {
    height: 1,
    flexShrink: 0,
    flexDirection: "row",
    backgroundColor: selected ? theme.color.selected : theme.color.surface,
    onMouseDown: (event) => {
      if (event.button === MouseButton.LEFT) actions.toggleConsentFile(index)
    },
  })
  const checkbox = file.accepted ? icons.check : "[ ]"
  // A rename preview is a mock-only affordance; real transfers keep the sender's name.
  let name = file.renamed && mode !== "real" ? renamePreview(file.name) : file.name
  if (mode === "real") {
    // Show what the sink will actually write (P0-12): sanitizing can change
    // the name, and a rejected name must be visible before accepting.
    const saved = previewSavedName(file.name)
    if (saved === null) name = `${file.name} (name will be rejected)`
    else if (saved !== file.name) name = `${file.name} → saved as ${saved}`
  }
  const size = `  ${formatBytes(file.bytes)}`
  const nameBudget = Math.max(4, inner - Bun.stringWidth(` ${checkbox} `) - Bun.stringWidth(size))
  row.add(label(renderer, `consent-check-${index}`, ` ${checkbox} `, file.accepted ? theme.color.success : theme.color.muted))
  row.add(label(renderer, `consent-name-${index}`, truncate(name, nameBudget), selected ? theme.color.white : theme.color.text))
  row.add(label(renderer, `consent-size-${index}`, size, theme.color.muted))
  return row
}

function renderTransfer(parent: BoxRenderable, ctx: RenderContext): void {
  const { renderer, state, actions, queue, mode, vp } = ctx
  const inner = cardInnerWidth(vp)
  const transfer = queue.find((item) => item.id === state.activeTransferId)
  const card = pageCard(ctx, "transfer-status", mode === "real" ? "Transfer" : "Mock transfer", transfer?.status === "complete" ? theme.color.success : transfer?.status === "failed" ? theme.color.danger : theme.color.focus)
  if (!transfer) {
    card.add(label(renderer, "transfer-missing", "No transfer is active.", theme.color.muted))
    parent.add(card)
    return
  }
  const isActive = transfer.status === "queued" || transfer.status === "transferring"
  const spinner = state.reducedMotion ? icons.dot : icons.spinner[state.identityStep % icons.spinner.length]
  card.add(label(renderer, "transfer-state", truncate(`${spinner}  ${statusLabel(transfer.status)}  ${icons.dot}  simulation only, no file bytes are sent`, inner), transfer.status === "failed" ? theme.color.danger : theme.color.focus))
  card.add(label(renderer, "transfer-peer", truncate(`${transfer.direction === "incoming" ? "From" : "To"} ${transfer.peerName}  ${icons.dot}  ${transfer.acceptedFiles.length} accepted`, inner), theme.color.remote))
  card.add(label(renderer, "transfer-gauge", truncate(`[${progressGauge(transfer.progress, Math.max(12, Math.min(36, inner - 8)))}] ${transfer.progress}%`, inner), theme.color.success))
  const tickMs = state.reducedMotion ? 320 : motion.transferTickMs
  const secondsToComplete = (100 / motion.transferStep) * tickMs / 1000
  const simulatedSpeed = secondsToComplete > 0 ? transfer.acceptedBytes / secondsToComplete : 0
  const eta = transfer.status === "complete" ? "done" : `${((100 - transfer.progress) / motion.transferStep * tickMs / 1000).toFixed(1)}s`
  card.add(label(renderer, "transfer-metrics", truncate(`  ${transfer.acceptedFiles.length} file${transfer.acceptedFiles.length === 1 ? "" : "s"}  ${icons.dot}  ${formatBytes(transfer.acceptedBytes)}  ${icons.dot}  simulated ${formatBytes(Math.round(simulatedSpeed))}/s  ${icons.dot}  ETA ${eta}`, inner), theme.color.muted))
  card.add(label(renderer, "transfer-destination", truncate(`Destination: ${transfer.destination}`, inner), theme.color.text))
  if (transfer.error) card.add(label(renderer, "transfer-error", truncate(`Error: ${transfer.error}`, inner), theme.color.danger))
  card.add(label(renderer, "transfer-staged-files", truncate(`  ${transfer.acceptedFiles.join(` ${icons.dot} `)}`, inner), theme.color.muted))
  const buttons = isActive
    ? [actionButton(renderer, "cancel-transfer", "Cancel · Esc", "transfer-cancel", actions.command, { fg: theme.color.danger }), actionButton(renderer, "simulate-failure", "Simulate error · E", "transfer-fail", actions.command, { fg: theme.color.warning })]
    : transfer.status === "failed"
      ? [actionButton(renderer, "retry-transfer", "Retry · R", "transfer-retry", actions.command, { fg: theme.color.focus }), actionButton(renderer, "return-transfer", "Return · Enter", "transfer-return", actions.command, { fg: theme.color.muted })]
      : [actionButton(renderer, "return-transfer", "Return · Enter", "transfer-return", actions.command, { fg: theme.color.success })]
  card.add(actionRow(renderer, "transfer-actions", buttons, vp.veryNarrow))
  parent.add(card)
}

function renderPeer(parent: BoxRenderable, ctx: RenderContext): void {
  const { renderer, state, peers, favorites, actions, vp } = ctx
  const inner = cardInnerWidth(vp)
  const d = icons.dot
  const peer = peers[state.peerIndex % Math.max(1, peers.length)]
  const card = pageCard(ctx, "peer-identity", "Peer setup · mock identity preview", theme.color.remote)
  if (!peer) {
    card.add(label(renderer, "peer-empty", "No mock peers are available.", theme.color.muted))
    parent.add(card)
    return
  }
  card.add(label(renderer, "peer-discovery", truncate(`${icons.angleLeft} ${peer.name} ${icons.angleRight}   ${peer.online ? `${icons.online} online (mock)` : `${icons.offline} offline (mock)`}   ${state.peerIndex + 1}/${peers.length} peers`, inner), theme.color.success))
  card.add(label(renderer, "peer-navigation", truncate(`Use ${icons.left} / ${icons.arrow} to browse discovered mock destinations.`, inner), theme.color.muted))
  const pattern = decorativePattern(state.peerIndex)
  pattern.forEach((line, index) => card.add(label(renderer, `identity-pattern-${index}`, truncate(`    ${line}`, inner), theme.color.remote)))
  card.add(label(renderer, "pattern-warning", truncate(`Decorative pattern only ${d} not a scannable invitation or identity proof.`, inner), theme.color.warning))
  card.add(label(renderer, "peer-endpoint", truncate(`Destination record: ${peer.host}:${peer.port}`, inner), theme.color.text))
  card.add(label(renderer, "peer-fingerprint", truncate(`Fingerprint for manual comparison: ${peer.fingerprint}`, inner), theme.color.focus))
  card.add(label(renderer, "manual-verify-note", truncate("Compare this value out-of-band yourself. This app saves no \"verified\" state.", inner), theme.color.muted))
  if (state.status.startsWith("Fingerprint shown for manual comparison")) card.add(label(renderer, "manual-compare-feedback", truncate(`Fingerprint displayed for comparison ${d} no verified state was saved.`, inner), theme.color.focus))
  const isFavorite = favorites.some((item) => item.peerId === peer.id)
  card.add(label(renderer, "favorite-status", truncate(isFavorite ? `Local Favorite saved ${d} shortcut only, not trusted or paired` : `Not a Favorite ${d} saved destinations do not become trusted peers`, inner), theme.color.warning))
  const discoveryStatus = state.identityStep === 3
    ? `Mock discovery timed out ${d} no connection was created`
    : ["Looking for a peer", "A mock destination appeared", "Ready to request a transfer after consent"][Math.min(state.identityStep, 2)]
  card.add(label(renderer, "identity-flow", truncate(`Mock discovery preview: ${discoveryStatus}`, inner), state.identityStep === 3 ? theme.color.warning : theme.color.text))
  card.add(actionRow(renderer, "peer-actions", [
    actionButton(renderer, "compare-fingerprint", "Compare manually · V", "manual-compare", actions.command, { fg: theme.color.focus }),
    actionButton(renderer, "peer-timeout", "Simulate timeout · E", "peer-timeout", actions.command, { fg: theme.color.warning }),
    actionButton(renderer, "peer-retry", "Retry preview · R", "peer-retry", actions.command, { fg: theme.color.success }),
    actionButton(renderer, "toggle-favorite", `${isFavorite ? "Remove Favorite" : "Save Favorite locally"} · F`, "toggle-favorite", actions.command, { fg: theme.color.warning }),
    actionButton(renderer, "open-favorites", "Favorites · P", "favorites", actions.command, { fg: theme.color.remote }),
    actionButton(renderer, "peer-close", "Back · Esc", "workspace", actions.command, { fg: theme.color.muted }),
  ], vp.veryNarrow))
  card.add(label(renderer, "peer-consent-separation", truncate("Identity comparison, local Favorites, and per-transfer consent are separate actions.", inner), theme.color.dim))
  parent.add(card)
}

function renderFavorites(parent: BoxRenderable, ctx: RenderContext): void {
  const { renderer, state, favorites, actions, vp } = ctx
  const inner = cardInnerWidth(vp)
  const card = pageCard(ctx, "favorites-screen", "Local Favorites", theme.color.warning)
  card.add(label(renderer, "favorites-disclaimer", truncate(`Saved destination shortcuts only ${icons.dot} not a pairing, verification, or auto-accept rule.`, inner), theme.color.warning))
  if (favorites.length === 0) card.add(label(renderer, "favorites-empty", "No Favorites yet. Open Peers and save a destination locally.", theme.color.muted))
  favorites.forEach((favorite, index) => {
    const selected = index === state.favoriteCursor
    const row = panel(renderer, `favorite-${favorite.peerId}`, {
      height: 2,
      flexDirection: "column",
      flexShrink: 0,
      backgroundColor: selected ? theme.color.selected : theme.color.surface,
      onMouseDown: (event) => { if (event.button === MouseButton.LEFT) actions.selectFavorite(index) },
    })
    row.add(label(renderer, `favorite-name-${favorite.peerId}`, truncate(`  ${selected ? icons.arrow : icons.dot} ${favorite.alias}`, inner), theme.color.text))
    row.add(label(renderer, `favorite-host-${favorite.peerId}`, truncate(`    ${favorite.host}:${favorite.port}  ${icons.dot}  fingerprint ${favorite.fingerprint}`, inner), theme.color.muted))
    card.add(row)
  })
  card.add(actionRow(renderer, "favorites-actions", [
    actionButton(renderer, "favorite-open-peer", "View selected · Enter", "favorite-open", actions.command, { fg: theme.color.focus, disabled: favorites.length === 0 }),
    actionButton(renderer, "favorite-remove", "Remove selected · F", "favorite-remove", actions.command, { fg: theme.color.danger, disabled: favorites.length === 0 }),
    actionButton(renderer, "favorites-back", "Back · Esc", "workspace", actions.command, { fg: theme.color.muted }),
  ], vp.veryNarrow))
  parent.add(card)
}

function renderDiff(parent: BoxRenderable, ctx: RenderContext): void {
  const { renderer, state, actions, vp } = ctx
  const entries = ctx.list(state.activePane)
  const entry = entries[state.cursors[state.activePane]]
  const card = pageCard(ctx, "diff-inspector", `Diff inspector ${icons.dot} ${entry?.name ?? "file"}`, theme.color.warning)
  card.add(label(renderer, "diff-caption", "Mock content · no local files are read.", theme.color.muted))
  const lines = ctx.filesystem.getDiff(entry?.id ?? "")
  const hunk = Math.max(0, Math.min(state.diffHunk, Math.max(0, lines.length - 1)))
  lines.forEach((line, index) => {
    const accent = line.startsWith("+") ? theme.color.success : line.startsWith("-") ? theme.color.danger : theme.color.text
    const cursor = index === hunk ? `  ${icons.angleLeft}` : ""
    const lineBudget = Math.max(6, cardInnerWidth(vp) - 4 - Bun.stringWidth(cursor))
    card.add(label(renderer, `diff-line-${index}`, `  ${String(index + 1).padStart(2, "0")}  ${truncate(line, lineBudget)}${cursor}`, accent))
  })
  card.add(label(renderer, "diff-hunk-status", truncate(`Hunk cursor ${hunk + 1}/${lines.length}  ${icons.dot}  Tab next  ${icons.dot}  Enter stage current file`, cardInnerWidth(vp)), theme.color.muted))
  card.add(actionRow(renderer, "diff-actions", [
    actionButton(renderer, "diff-next", "Next hunk · Tab", "diff-next", actions.command, { fg: theme.color.warning }),
    actionButton(renderer, "diff-stage", "Stage file · Enter", "diff-stage", actions.command, { fg: theme.color.focus }),
    actionButton(renderer, "diff-close", "Close · Esc", "workspace", actions.command, { fg: theme.color.muted }),
  ], vp.veryNarrow))
  parent.add(card)
}

function renderHelp(parent: BoxRenderable, ctx: RenderContext): void {
  const { renderer, actions, mode, vp } = ctx
  const realMode = mode === "real"
  const inner = cardInnerWidth(vp)
  const card = pageCard(ctx, "help-screen", "Keyboard & mouse help", theme.color.focus)
  const rows: Array<[string, string]> = [
    [`${icons.up} / ${icons.down}`, "Move through files; directories use Enter"],
    ["Tab / 1 / 2", "Switch panes; narrow terminals show one pane at a time"],
    ["Space", "Stage / unstage the focused file"],
    ["a / A", "Stage all / clear staging in the active folder"],
    ["Enter / Backspace", "Open directory / go to its parent"],
    ["s", realMode ? "Review staged files and send to the selected peer" : "Review staged files and simulate a send"],
    ["i", realMode ? "Incoming transfers arrive from the network" : "Create a mock incoming request"],
    realMode
      ? [`${icons.up} / ${icons.down} (Receiver)`, "Choose the peer to send to"]
      : ["q / v / p", "Peer preview / manual fingerprint comparison / Favorites"],
    realMode ? ["t / ?", "Transfer queue / help"] : ["d / t / ?", "Diff / transfer queue / help"],
    ["D / + / - (consent)", "Cycle / add / remove the receive destination"],
    ["Mouse", "Click rows and actions; scroll panes to browse"],
    ["Narrow screens", realMode
      ? `Use Local / Receiver tabs and the Stage and Send toolbar actions`
      : `Use Local / Remote tabs and the Stage, Send, and Receive toolbar actions`],
    ["Esc / Ctrl+C", "Back or cancel / quit"],
  ]
  rows.forEach(([key, description], index) => {
    const prefix = `${key.padEnd(20)} `
    card.add(label(renderer, `help-row-${index}`, truncate(`${prefix}${description}`, inner), index % 2 ? theme.color.text : theme.color.focus))
  })
  card.add(label(renderer, "help-note", truncate(realMode
    ? "Real mode: live files, Noise-encrypted transfers, UDP-multicast discovery."
    : "Phase 1 is a deterministic simulation: no real files, networking, synchronization, pairing, or disk persistence.", inner), theme.color.warning))
  card.add(actionButton(renderer, "help-back", "Back · Esc", "workspace", actions.command, { fg: theme.color.muted }))
  parent.add(card)
}

function renderQueue(parent: BoxRenderable, ctx: RenderContext): void {
  const { renderer, queue, actions, mode, vp } = ctx
  const realMode = mode === "real"
  const inner = cardInnerWidth(vp)
  const card = pageCard(ctx, "transfer-queue", "Transfer queue · this session", theme.color.remote)
  card.add(label(renderer, "queue-disclaimer", truncate(realMode
    ? `In-memory history only ${icons.dot} cleared when this process exits.`
    : `In-memory mock history only ${icons.dot} cleared when this process exits.`, inner), theme.color.warning))
  if (!queue.length) {
    if (realMode) {
      card.add(label(renderer, "queue-empty", truncate("No transfers yet. Stage files and press s to send.", inner), theme.color.muted))
      card.add(label(renderer, "queue-empty-2", truncate("Incoming requests open a consent screen before any bytes are saved.", inner), theme.color.muted))
    } else {
      card.add(label(renderer, "queue-empty", truncate("No transfer requests yet. Send staged files or press I to simulate an incoming request.", inner), theme.color.muted))
    }
  }
  queue.slice(0, 12).forEach((record, index) => {
    const direction = record.direction === "incoming" ? "IN" : "OUT"
    const line = `${String(index + 1).padStart(2, "0")} ${direction}  ${statusLabel(record.status).padEnd(12)} ${record.peerName}  ${record.acceptedFiles.length}/${record.files.length} files`
    card.add(label(renderer, `queue-record-${record.id}`, truncate(line, inner), record.status === "failed" ? theme.color.danger : record.status === "complete" ? theme.color.success : theme.color.text))
    if (record.error) card.add(label(renderer, `queue-error-${record.id}`, truncate(`   ${record.error}`, inner), theme.color.danger))
  })
  const canRetry = queue.some((record) => record.status === "failed" || record.status === "cancelled")
  // Retry is a mock-only flow; the real queue has no retry path yet.
  const buttons = [actionButton(renderer, "queue-back", "Back · Esc", "workspace", actions.command, { fg: theme.color.muted })]
  if (!realMode) buttons.unshift(actionButton(renderer, "queue-retry", "Retry latest failed/cancelled · R", "queue-retry", actions.command, { fg: theme.color.focus, disabled: !canRetry }))
  card.add(actionRow(renderer, "queue-actions", buttons, vp.veryNarrow))
  parent.add(card)
}

function renderFooter(ctx: RenderContext): BoxRenderable {
  const { renderer, vp } = ctx
  const footer = panel(renderer, "footer", {
    height: vp.compact ? 1 : 2,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    marginTop: vp.compact ? 0 : 1,
  })
  footer.add(label(renderer, "footer-hint", truncate(footerHint(ctx), contentWidth(vp) - 2), theme.color.muted))
  return footer
}

function footerHint(ctx: RenderContext): string {
  const { state, mode, vp, receiveDestinations } = ctx
  const realMode = mode === "real"
  if (vp.compact) {
    return state.screen === "workspace"
      ? realMode
        ? `${icons.up}${icons.down} move ${icons.dot} Tab pane ${icons.dot} Space stage ${icons.dot} s send ${icons.dot} ? help`
        : `${icons.up}${icons.down} move ${icons.dot} Tab pane ${icons.dot} Space stage ${icons.dot} s send ${icons.dot} i receive ${icons.dot} ? help`
      : `Enter select ${icons.dot} Esc back ${icons.dot} Ctrl+C quit`
  }
  const join = (parts: string[]) => parts.join(`  ${icons.dot}  `)
  const multiDestination = receiveDestinations.length > 1
  const sending = state.sending
  const sasPending = !!state.sendSasConfirm
  const hints: Record<Screen, string> = {
    workspace: realMode
      ? join([`${icons.up}${icons.down} Navigate`, "Tab Pane", "Space Stage", "s Send", "t Queue", "? Help"])
      : join([`${icons.up}${icons.down} Navigate`, "Tab Pane", "Space Stage", "s Send", "i Receive", "d Diff", "q Peers", "? Help"]),
    "send-review": realMode
      ? sasPending
        ? join(["Enter/y Confirm code", "Esc/n Cancel"])
        : sending
          ? join(["Esc Cancel send"])
          : join(["Enter Send to peer", "Esc Back"])
      : join(["Enter Continue to consent", "q Choose peer", "Esc Back"]),
    consent: realMode
      ? join([
        `${icons.up}${icons.down} Focus`,
        "Space Include/skip",
        ...(multiDestination ? ["D Destination"] : []),
        "a Accept all",
        "Enter Accept selected",
        "x Decline",
      ])
      : join([`${icons.up}${icons.down} Focus`, "Space Include/skip", "r Rename", "d Destination", "a Accept all", "Enter Accept selected", "x Decline"]),
    transfer: realMode
      ? "Esc Back"
      : join(["Esc Cancel", "e Simulate failure", "r Retry", "Enter Return"]),
    peer: join([`${icons.left}${icons.arrow} Browse`, "v Compare", "e Simulate timeout", "r Retry preview", "f Favorite", "p List Favorites", "Esc Back"]),
    favorites: join([`${icons.up}${icons.down} Select`, "Enter View", "f Remove Favorite", "Esc Back"]),
    diff: join(["Tab Next hunk", "Enter Stage file", "Esc Back"]),
    help: join(["Esc Back", "Ctrl+C Quit"]),
    queue: realMode ? "Esc Back" : join(["r Retry latest failure", "Esc Back"]),
  }
  return hints[state.screen]
}

/** Page card: border 2, padding 4 (inner width from cardInnerWidth). */
function pageCard(ctx: RenderContext, id: string, title: string, accent: string): BoxRenderable {
  const { renderer, state, vp } = ctx
  const reveal = icons.revealFrames[Math.min(state.revealFrame, icons.revealFrames.length - 1)]
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
    title: asciiSafe(` ${reveal} ${truncate(title, Math.max(4, contentWidth(vp) - 6))} `),
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
      line += corner || ((x * 17 + y * 31 + seed * 7) % 5 < 2) ? icons.block : "  "
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
