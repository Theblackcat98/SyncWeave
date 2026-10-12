import { CliRenderEvents, type CliRenderer, type KeyEvent } from "@opentui/core"
import type { AppMode, AppState, ConsentRequest, MockPeer, Pane, Screen, TransferRecord } from "./domain.js"
import { OTHER_PANE } from "./domain.js"
import type { FileSystemService, PeerService, TransferService } from "./services/ports.js"
import { RealFileSystemService } from "./services/real-filesystem.js"
import type { EphemeralIdentity } from "./services/peer-id.js"
import { listenNoise } from "./services/transport.js"
import { receiveFiles, sendFiles, TransferDeclinedError, PeerCancelledError, SendAbortedError } from "./services/transfer-protocol.js"
import { friendlyErrorMessage } from "./services/friendly-errors.js"
import type { DiscoveryService, DiscoveredPeer } from "./services/discovery.js"
import { logEvent } from "./services/diagnostic-log.js"
import {
  addDestination,
  cycleDestinationIndex,
  removeDestination,
  saveDestinations,
  validateDestinationPath,
} from "./services/destinations.js"
type NoiseListener = Awaited<ReturnType<typeof listenNoise>>
import { createInitialAppState, visibleRowCount } from "./state/app-state.js"
import { clamp, stepCursor } from "./cursor.js"
import { syncDiscoveredPeers } from "./peer-sync.js"
import { motion } from "./theme.js"
import { AnimationClock } from "./ui/animation-clock.js"
import { renderApp } from "./ui/render.js"

/**
 * Real-mode transport bundle. In real mode the app owns one ephemeral
 * identity for the whole run (announced via discovery so peers can verify
 * it), one TCP listener, and one discovery service.
 */
export interface RealTransport {
  identity: EphemeralIdentity
  listener: NoiseListener
  discovery: DiscoveryService
  alias: string
  tcpPort: number
  /** Directory where received files are written. */
  receiveDirectory: string
  /** Aborts the listener accept loop; aborted on app dispose. */
  aborter: AbortController
  /** Non-fatal startup issue to surface in the TUI (e.g. discovery failed). */
  startupWarning: string | null
  /** Local bind address, for the listening indicator. */
  bindAddr: string
}

export interface AppDependencies {
  filesystem: FileSystemService
  peerService: PeerService
  transferService: TransferService
  receiveDestinations: readonly string[]
  reducedMotion?: boolean
  /**
   * "mock" (default) renders the deterministic simulation. "real" swaps the
   * local pane to the real filesystem and replaces the remote file list with
   * a receiver status panel — the receiver's files are never shown.
   */
  mode?: AppMode
  /** Required in real mode: the live transport bundle. */
  real?: RealTransport
}

export interface SyncWeaveApp {
  readonly state: AppState
  render(): void
  handleKey(key: KeyEvent): void
  dispose(): void
}

export function createSyncWeaveApp(renderer: CliRenderer, dependencies: AppDependencies): SyncWeaveApp {
  const mode: AppMode = dependencies.mode ?? "mock"
  // In real mode the local pane is always the real filesystem; the remote
  // pane has no filesystem (the receiver's files are out of scope).
  const filesystem: FileSystemService =
    mode === "real" ? new RealFileSystemService() : dependencies.filesystem
  const { peerService, transferService } = dependencies
  // Mutable working copy: add/remove destinations (issue #27) mutate this;
  // the persisted file is the source of truth across restarts.
  let receiveDestinations: string[] = [...dependencies.receiveDestinations]
  // In real mode the peer list is populated from UDP-multicast discovery
  // (plus manual entries); in mock mode it comes from the mock service.
  let peers: MockPeer[] = mode === "real" ? [] : peerService.discover()
  // Real-mode consent bridge resolver (set by setupRealMode, consumed by command()).
  let realConsentResolver: ((files: Array<{ name: string; bytes: number; sha256: string }>) => void) | null = null
  // sha256 lookup for the pending real consent (consent screen has no sha256 field).
  let pendingSha256: Map<string, string> = new Map()
  const state = createInitialAppState(filesystem.paths, dependencies.reducedMotion)
  if (mode === "real") {
    state.status = "Ready · listening for peers on the LAN"
  }
  if (mode === "real" && dependencies.real?.startupWarning) {
    // Surface non-fatal startup issues (e.g. discovery bind failure) where
    // the user can actually see them — stderr is captured once the TUI runs.
    state.status = dependencies.real.startupWarning
  }
  const clock = new AnimationClock()
  let paused = false
  let disposed = false

  const syncQueue = () => { state.transferQueue = transferService.queue() }
  const peer = (): MockPeer | undefined => peers[state.peerIndex % Math.max(1, peers.length)]
  const currentEntries = (pane = state.activePane) => filesystem.list(pane, state.paths[pane])
  const stagedEntries = (pane = state.activePane) => currentEntries(pane).filter((entry) => state.staged[pane].has(entry.id))
  const visibleRows = () => visibleRowCount(renderer.terminalHeight || 24)

  function render(): void {
    if (disposed) return
    syncQueue()
    renderApp({
      renderer,
      state,
      mode,
      filesystem,
      peerService,
      receiveDestinations,
      peers,
      favorites: peerService.favorites(),
      queue: state.transferQueue,
      real: mode === "real" && dependencies.real ? { bindAddr: dependencies.real.bindAddr, tcpPort: dependencies.real.tcpPort } : null,
      actions: {
        command,
        selectEntry(pane, index) {
          state.activePane = pane
          state.cursors[pane] = index
          keepCursorVisible(pane)
          animateFocus()
          render()
        },
        scrollPane(pane, direction) {
          state.activePane = pane
          const max = currentEntries(pane).length - 1
          state.cursors[pane] = stepCursor(state.cursors[pane], direction === "down" ? 1 : -1, currentEntries(pane).length)
          keepCursorVisible(pane)
          animateFocus()
          render()
        },
        selectConsentFile(index) {
          state.selectedConsentFile = clamp(index, 0, Math.max(0, (state.request?.files.length ?? 1) - 1))
          render()
        },
        toggleConsentFile(index) {
          const file = state.request?.files[index]
          if (!file) return
          state.selectedConsentFile = index
          file.accepted = !file.accepted
          render()
        },
        selectFavorite(index) {
          state.favoriteCursor = clamp(index, 0, Math.max(0, peerService.favorites().length - 1))
          render()
        },
      },
    })
    reconcileTimers()
  }

  function setScreen(screen: Screen): void {
    state.screen = screen
    clock.stop("reveal")
    state.revealFrame = state.reducedMotion || screen === "workspace" ? motion.revealFrames.length - 1 : 0
    if (!state.reducedMotion && screen !== "workspace") clock.start("reveal")
    render()
  }

  function animateFocus(): void {
    if (state.reducedMotion) {
      state.focusFrame = motion.focusGlow.length - 1
      return
    }
    state.focusFrame = 0
    clock.start("focus")
  }

  function keepCursorVisible(pane: Pane): void {
    const rows = visibleRows()
    const entries = currentEntries(pane)
    const maxOffset = Math.max(0, entries.length - rows)
    let offset = clamp(state.scrollOffsets[pane], 0, maxOffset)
    if (state.cursors[pane] < offset) offset = state.cursors[pane]
    if (state.cursors[pane] >= offset + rows) offset = state.cursors[pane] - rows + 1
    state.scrollOffsets[pane] = clamp(offset, 0, maxOffset)
  }

  function openSendReview(): void {
    // Real mode sends from the Local pane's staged set regardless of focus;
    // the Receiver pane lists peers, not sendable files.
    const pane = mode === "real" ? "local" : state.activePane
    if (stagedEntries(pane).length === 0) {
      state.status = "Nothing staged in this folder · Space selects a file"
      render()
      return
    }
    setScreen("send-review")
  }

  function beginOutgoingConsent(): void {
    const files = stagedEntries()
    const destination = peer()
    if (!files.length || !destination) {
      state.status = "Stage at least one file and choose a mock destination first"
      setScreen("workspace")
      return
    }
    state.request = transferService.createRequest(
      "outgoing",
      destination,
      files.map(({ id, name, bytes }) => ({ id, name, bytes })),
      state.activePane,
    )
    state.selectedConsentFile = 0
    state.receiveDestinationIndex = 0
    state.status = "Review request · accepted files alone enter simulated progress"
    setScreen("consent")
  }

  function createIncomingRequest(): void {
    const sender = peers.length > 1 ? peers[(state.peerIndex + 1) % peers.length] : peer()
    if (!sender) return
    state.request = transferService.createRequest("incoming", sender, [
      { id: "incoming-roadmap", name: "phase-notes.md", bytes: 7_168 },
      { id: "incoming-photo", name: "terminal-preview.png", bytes: 184_320 },
      { id: "incoming-config", name: "syncweave-demo.json", bytes: 2_048 },
    ])
    state.selectedConsentFile = 0
    state.receiveDestinationIndex = 0
    state.status = "Incoming request simulated · review the sender, files and destination"
    setScreen("consent")
  }

  function acceptConsent(all = false): void {
    const request = state.request
    if (!request) return
    if (all) request.files.forEach((file) => { file.accepted = true })
    const accepted = request.files.filter((file) => file.accepted)
    if (accepted.length === 0) {
      state.status = "Choose one or more files, accept all, or decline the request"
      render()
      return
    }
    const transfer = transferService.acceptRequest(request, receiveDestinations[state.receiveDestinationIndex % receiveDestinations.length]!, accepted)
    state.activeTransferId = transfer.id
    state.request = request
    state.identityStep = 0
    state.status = "Consent recorded for this transfer only · mock progress starting"
    setScreen("transfer")
  }

  function declineConsent(): void {
    const request = state.request
    if (request) {
      transferService.declineRequest(request)
      state.request = null
      state.status = `Declined ${request.peer.name}'s request · no bytes were streamed`
    }
    state.activeTransferId = null
    setScreen("workspace")
  }

  function startProgress(): void {
    if (paused || state.screen !== "transfer") return
    clock.start("transfer")
  }

  function tickTransfer(): void {
    const activeId = state.activeTransferId
    const before = state.transferQueue.find((record) => record.id === activeId)
    if (!activeId || !before || (before.status !== "queued" && before.status !== "transferring")) {
      stopProgress()
      return
    }
    const stepped = transferService.progress(activeId, motion.transferStep)
    state.identityStep += 1
    if (stepped && stepped.progress >= 100) {
      const completed = transferService.finish(activeId)
      if (completed?.direction === "outgoing" && completed.sourcePane) {
        filesystem.markSynced(completed.sourcePane, completed.fileIds)
        completed.fileIds.forEach((id) => state.staged[completed.sourcePane!].delete(id))
      }
      state.status = "Mock transfer complete · accepted files updated in the mock workspace"
      stopProgress()
    }
    render()
  }

  function tickDiscovery(): void {
    // In real mode the peer list comes from UDP-multicast discovery (synced
    // on its own timer in setupRealMode); never overwrite it with mock peers.
    if (mode !== "real") {
      peers.splice(0, peers.length, ...peerService.pulse())
    }
    state.discoveryFrame = (state.discoveryFrame + 1) % motion.discovery.length
    render()
  }

  function tickFocus(): void {
    state.focusFrame = Math.min(motion.focusGlow.length - 1, state.focusFrame + 1)
    render()
    if (state.focusFrame >= motion.focusGlow.length - 1) clock.stop("focus")
  }

  function tickReveal(): void {
    state.revealFrame = Math.min(motion.revealFrames.length - 1, state.revealFrame + 1)
    render()
    if (state.revealFrame >= motion.revealFrames.length - 1) clock.stop("reveal")
  }

  function stopProgress(): void {
    clock.stop("transfer")
  }

  function reconcileTimers(): void {
    if (disposed) return
    const discoveryShouldRun = state.screen === "workspace" && !paused && !state.reducedMotion
    if (discoveryShouldRun) clock.start("discovery")
    else clock.stop("discovery")
    const transfer = state.transferQueue.find((record) => record.id === state.activeTransferId)
    const transferShouldRun = state.screen === "transfer" && !paused && !!transfer && (transfer.status === "queued" || transfer.status === "transferring")
    if (transferShouldRun) startProgress()
    else stopProgress()
  }

  clock.register("discovery", motion.discoveryTickMs, tickDiscovery)
  clock.register("transfer", state.reducedMotion ? 320 : motion.transferTickMs, tickTransfer)
  clock.register("focus", motion.focusTickMs, tickFocus)
  clock.register("reveal", motion.revealTickMs, tickReveal)

  function changePane(pane: Pane): void {
    state.activePane = pane
    animateFocus()
    state.status = `Focused ${pane} ${pane === "local" ? "source" : "destination"}`
    render()
  }

  function moveCursor(delta: number): void {
    // In real mode the Receiver pane is a peer list, not files: ↑/↓ picks
    // the target peer there.
    if (mode === "real" && state.activePane === "remote") {
      if (peers.length > 0) {
        state.peerIndex = (state.peerIndex + delta + peers.length) % peers.length
        const p = peers[state.peerIndex]
        state.status = `Target peer: ${p.name} (${p.host}:${p.port})`
      } else {
        state.status = "No peers discovered yet · waiting for announcements or use --peer"
      }
      animateFocus()
      render()
      return
    }
    const entries = currentEntries()
    state.cursors[state.activePane] = stepCursor(state.cursors[state.activePane], delta, entries.length)
    keepCursorVisible(state.activePane)
    animateFocus()
    render()
  }

  function toggleCurrentEntry(): void {
    const entry = currentEntries()[state.cursors[state.activePane]]
    if (!entry) return
    if (entry.kind === "directory") {
      state.status = `${entry.name} is a folder · press Enter to browse`
      render()
      return
    }
    const set = state.staged[state.activePane]
    if (set.has(entry.id)) set.delete(entry.id)
    else set.add(entry.id)
    state.status = `${set.has(entry.id) ? "Staged" : "Unstaged"} ${entry.name}`
    render()
  }

  function stageAll(unstage = false): void {
    const entries = currentEntries().filter((entry) => entry.kind === "file")
    if (unstage) entries.forEach((entry) => state.staged[state.activePane].delete(entry.id))
    else entries.forEach((entry) => state.staged[state.activePane].add(entry.id))
    state.status = unstage ? `Cleared ${entries.length} staged files in this folder` : `Staged ${entries.length} files in this folder`
    render()
  }

  function openCurrentDirectory(): void {
    const entry = currentEntries()[state.cursors[state.activePane]]
    if (!entry || entry.kind !== "directory") {
      state.status = entry ? `${entry.name} is a file · press d to inspect its ${mode === "real" ? "diff" : "mock diff"}` : "No item to open"
      render()
      return
    }
    state.paths[state.activePane] = `${state.paths[state.activePane].replace(/\/$/, "")}/${entry.name.replace(/\/$/, "")}`
    state.cursors[state.activePane] = 0
    state.scrollOffsets[state.activePane] = 0
    state.status = `Opened ${mode === "real" ? "folder" : "mock folder"} ${entry.name}`
    render()
  }

  function goParentDirectory(): void {
    if (state.paths[state.activePane] === filesystem.paths[state.activePane]) {
      state.status = mode === "real" ? "Already at the top of this folder" : "Already at the top of this mock workspace"
      render()
      return
    }
    state.paths[state.activePane] = filesystem.parentPath(state.paths[state.activePane])
    state.cursors[state.activePane] = 0
    state.scrollOffsets[state.activePane] = 0
    state.status = mode === "real" ? "Moved to parent folder" : "Moved to parent mock folder"
    render()
  }

  function openDiff(): void {
    const entry = currentEntries()[state.cursors[state.activePane]]
    if (!entry || entry.kind !== "file" || entry.state === "synced") {
      state.status = entry ? `No divergence to inspect: ${entry.name}` : "No file selected"
      render()
      return
    }
    state.diffHunk = 0
    setScreen("diff")
  }

  function toggleFavorite(): void {
    const selected = peer()
    if (!selected) return
    const saved = peerService.toggleFavorite(selected)
    state.status = saved ? `${selected.name} saved as a local Favorite · not verified or paired` : `${selected.name} removed from local Favorites`
    render()
  }

  function openFavorites(): void {
    state.favoriteCursor = clamp(state.favoriteCursor, 0, Math.max(0, peerService.favorites().length - 1))
    setScreen("favorites")
  }

  function openFavorite(): void {
    const favorite = peerService.favorites()[state.favoriteCursor]
    if (!favorite) return
    const index = peers.findIndex((item) => item.id === favorite.peerId)
    if (index >= 0) state.peerIndex = index
    state.status = `${favorite.alias} selected as a local destination shortcut`
    setScreen("peer")
  }

  function removeSelectedFavorite(): void {
    const favorite = peerService.favorites()[state.favoriteCursor]
    if (!favorite) return
    const selected = peers.find((item) => item.id === favorite.peerId)
    if (selected) peerService.toggleFavorite(selected)
    state.favoriteCursor = clamp(state.favoriteCursor, 0, Math.max(0, peerService.favorites().length - 1))
    state.status = `${favorite.alias} removed from local Favorites`
    render()
  }

  function simulateManualComparison(): void {
    state.status = "Fingerprint shown for manual comparison · no verified state was saved"
    render()
  }

  function simulatePeerTimeout(): void {
    state.identityStep = 3
    state.status = "Mock discovery timed out · no connection or verification was created"
    render()
  }

  function retryPeerPreview(): void {
    state.identityStep = 0
    state.status = "Mock discovery restarted · waiting for a simulated result"
    render()
  }

  function beginTransferRetry(id: string): void {
    stopProgress()
    // Real mode: re-stage the failed transfer's files and re-open review.
    // Fresh session, fresh consent, restart from zero (per decisions.md).
    if (mode === "real") {
      const record = state.transferQueue.find((r) => r.id === id)
      if (!record || (record.status !== "failed" && record.status !== "cancelled")) {
        state.status = "No failed or cancelled transfer is available to retry"
        setScreen("queue")
        return
      }
      for (const fileId of record.fileIds) state.staged.local.add(fileId)
      state.status = `Re-staged ${record.fileIds.length} file(s) for retry · review and send`
      setScreen("send-review")
      return
    }
    const retry = transferService.retry(id)
    if (!retry) {
      state.status = "No failed or cancelled transfer is available to retry"
      setScreen("queue")
      return
    }
    state.activeTransferId = retry.id
    state.identityStep = 0
    state.status = "Retry simulated · consent choices and file names retained"
    setScreen("transfer")
  }

  function cancelTransfer(): void {
    const id = state.activeTransferId
    stopProgress()
    if (id) transferService.cancel(id)
    state.activeTransferId = null
    state.status = "Mock transfer cancelled · staged source files remain unchanged"
    setScreen("workspace")
  }

  function failTransfer(): void {
    const id = state.activeTransferId
    stopProgress()
    if (id) transferService.fail(id, "Simulated receiver timeout — no network was contacted")
    state.status = "Mock failure recorded · retry is available"
    render()
  }

  function returnFromTransfer(): void {
    state.activeTransferId = null
    state.request = null
    state.status = "Returned to mock workspace"
    setScreen("workspace")
  }

  function command(name: string): void {
    // Real-mode consent bridge: if a real incoming transfer is awaiting the
    // user's accept/decline, those commands resolve the parked promise.
    if (mode === "real" && realConsentResolver) {
      if (name === "consent-accept" || name === "consent-all") {
        const req = state.request
        // "Accept all" truly selects everything first.
        if (name === "consent-all" && req) {
          req.files.forEach((f) => { f.accepted = true })
        }
        const accepted = (req?.files ?? [])
          .filter((f) => f.accepted)
          .map((f) => ({ name: f.name, bytes: f.bytes, sha256: pendingSha256.get(f.id) ?? "" }))
          .filter((f) => f.sha256.length === 64)
        // Enter with nothing selected is a no-op (not a silent decline).
        if (accepted.length === 0) {
          state.status = "Choose one or more files, accept all (a), or decline (x)"
          render()
          return
        }
        const resolve = realConsentResolver
        realConsentResolver = null
        state.request = null
        setScreen("workspace")
        state.status = `Accepted ${accepted.length} file(s) · receiving…`
        logEvent("consent-accept", `${accepted.length} file(s)`)
        render()
        resolve(accepted)
        return
      }
      if (name === "consent-decline") {
        const resolve = realConsentResolver
        realConsentResolver = null
        state.request = null
        setScreen("workspace")
        state.status = "Declined incoming transfer"
        logEvent("consent-decline")
        render()
        resolve([])
        return
      }
    }
    switch (name) {
      case "workspace": state.request = state.screen === "transfer" ? state.request : null; setScreen("workspace"); return
      case "send-review": openSendReview(); return
      case "send-to-consent":
        if (mode === "real" && dependencies.real) {
          void beginRealSend(dependencies.real)
          return
        }
        beginOutgoingConsent()
        return
      case "incoming":
        // Mock-only: real incoming transfers arrive from the network.
        if (mode === "real") {
          state.status = "Incoming transfers arrive from the network · listening…"
          render()
          return
        }
        createIncomingRequest(); return
      case "peer":
        // Mock-only screen; real peers live in the Receiver pane.
        if (mode === "real") {
          state.status = "Peer list is in the Receiver pane · Tab to switch, ↑/↓ to choose"
          render()
          return
        }
        state.identityStep = 0; setScreen("peer"); return
      case "favorites":
        // Mock-only feature.
        if (mode === "real") {
          state.status = "Favorites are not available in real mode"
          render()
          return
        }
        openFavorites(); return
      case "queue": setScreen("queue"); return
      case "help": setScreen("help"); return
      case "toggle-current": toggleCurrentEntry(); return
      case "pane-local": changePane("local"); return
      case "pane-remote": changePane("remote"); return
      case "toggle-consent": {
        const file = state.request?.files[state.selectedConsentFile]
        if (file) file.accepted = !file.accepted
        render(); return
      }
      case "rename-consent": {
        const file = state.request?.files[state.selectedConsentFile]
        if (file) file.renamed = !file.renamed
        render(); return
      }
      case "cycle-destination": {
        state.receiveDestinationIndex = cycleDestinationIndex(state.receiveDestinationIndex, receiveDestinations.length)
        const active = receiveDestinations[state.receiveDestinationIndex]!
        state.status = `Destination: ${active} (${state.receiveDestinationIndex + 1}/${receiveDestinations.length})`
        render(); return
      }
      case "destination-add": {
        state.destinationInput = ""
        state.status = "Add destination — type a path (created if missing), Enter to save, Esc to cancel"
        render(); return
      }
      case "destination-remove": {
        const index = state.receiveDestinationIndex % Math.max(1, receiveDestinations.length)
        const { dests, removed, reason } = removeDestination(receiveDestinations, index)
        if (!removed) {
          state.status = reason ?? "Cannot remove destination"
          render(); return
        }
        receiveDestinations = dests
        state.receiveDestinationIndex = Math.min(index, receiveDestinations.length - 1)
        if (mode === "real") saveDestinations(receiveDestinations)
        logEvent("destination-remove", removed)
        state.status = `Removed destination: ${removed}`
        render(); return
      }
      case "consent-all": acceptConsent(true); return
      case "consent-accept": acceptConsent(false); return
      case "consent-decline": declineConsent(); return
      case "manual-compare": simulateManualComparison(); return
      case "peer-timeout": simulatePeerTimeout(); return
      case "peer-retry": retryPeerPreview(); return
      case "toggle-favorite": toggleFavorite(); return
      case "favorite-open": openFavorite(); return
      case "favorite-remove": removeSelectedFavorite(); return
      case "diff-next": {
        const entry = currentEntries()[state.cursors[state.activePane]]
        const length = filesystem.getDiff(entry?.id ?? "").length
        state.diffHunk = (state.diffHunk + 1) % Math.max(1, length)
        render(); return
      }
      case "diff-stage": {
        const entry = currentEntries()[state.cursors[state.activePane]]
        if (entry?.kind === "file") state.staged[state.activePane].add(entry.id)
        state.status = entry ? `Staged ${entry.name} from the ${mode === "real" ? "diff" : "mock diff"}` : "No file to stage"
        setScreen("workspace"); return
      }
      case "transfer-cancel": cancelTransfer(); return
      case "transfer-fail": failTransfer(); return
      case "transfer-retry": {
        const active = state.transferQueue.find((record) => record.id === state.activeTransferId)
        if (active) beginTransferRetry(active.id)
        return
      }
      case "transfer-return": returnFromTransfer(); return
      case "queue-retry": {
        // Mock-only retry flow; the real queue is always empty, but gate it
        // so a stray record can never open the mock transfer screen.
        if (mode === "real") return
        const failed = state.transferQueue.find((record) => record.status === "failed" || record.status === "cancelled")
        if (failed) beginTransferRetry(failed.id)
        return
      }
      default:
        if (name.startsWith("favorite-open:")) {
          // Mock-only screen; unreachable in real mode (favorites are empty
          // there), but gate defensively like the other mock commands.
          if (mode === "real") return
          const peerId = name.slice("favorite-open:".length)
          const index = peers.findIndex((item) => item.id === peerId)
          if (index >= 0) state.peerIndex = index
          setScreen("peer")
        }
    }
  }

  function handleWorkspaceKey(key: KeyEvent): void {
    const name = key.name.toLowerCase()
    if (name === "tab") { changePane(OTHER_PANE[state.activePane]); return }
    if (name === "left") { changePane("local"); return }
    if (name === "right") { changePane("remote"); return }
    if (name === "1") { changePane("local"); return }
    if (name === "2") { changePane("remote"); return }
    if (name === "up") { moveCursor(-1); return }
    if (name === "down") { moveCursor(1); return }
    if (name === "space") { toggleCurrentEntry(); return }
    if (name === "a") { stageAll(key.shift || key.name === "A"); return }
    if (name === "return" || name === "enter") { openCurrentDirectory(); return }
    if (name === "backspace") { goParentDirectory(); return }
    switch (name) {
      case "s": openSendReview(); return
      case "i":
        if (mode === "real") {
          state.status = "Incoming transfers arrive from the network · listening…"
          render()
          return
        }
        createIncomingRequest()
        return
      case "d":
        if (mode === "real") {
          state.status = "Diff is not available in real mode"
          render()
          return
        }
        openDiff(); return
      case "q":
        if (mode === "real") {
          state.status = "Peer list is in the Receiver pane · Tab to switch, ↑/↓ to choose"
          render()
          return
        }
        state.identityStep = 0; setScreen("peer"); return
      case "p":
        if (mode === "real") {
          state.status = "Favorites are not available in real mode"
          render()
          return
        }
        openFavorites(); return
      case "t": setScreen("queue"); return
      case "?": setScreen("help"); return
      default: return
    }
  }

  function handleConsentKey(key: KeyEvent): void {
    if (!state.request) { setScreen("workspace"); return }
    const name = key.name.toLowerCase()
    if (name === "up" || name === "down") {
      const count = state.request.files.length
      state.selectedConsentFile = clamp(state.selectedConsentFile + (name === "down" ? 1 : -1), 0, Math.max(0, count - 1))
      // Keep the cursor visible: 10-row window.
      const windowSize = 10
      if (state.selectedConsentFile < state.consentScrollOffset) {
        state.consentScrollOffset = state.selectedConsentFile
      } else if (state.selectedConsentFile >= state.consentScrollOffset + windowSize) {
        state.consentScrollOffset = state.selectedConsentFile - windowSize + 1
      }
      render(); return
    }
    if (name === "space") { command("toggle-consent"); return }
    if (name === "r") { command("rename-consent"); return }
    if (name === "d") { command("cycle-destination"); return }
    if (name === "+" || name === "=") { command("destination-add"); return }
    if (name === "-" || name === "_") { command("destination-remove"); return }
    // In real mode a parked onTransferRequest promise is waiting on the
    // consent bridge — route through command() so it resolves. Calling the
    // mock accept/decline directly would orphan the promise and wedge the
    // receive loop forever.
    if (mode === "real" && realConsentResolver) {
      if (name === "a") { command("consent-all"); return }
      if (name === "return" || name === "enter") { command("consent-accept"); return }
      if (name === "x" || name === "escape") { command("consent-decline"); return }
    }
    if (name === "a") { acceptConsent(true); return }
    if (name === "return" || name === "enter") { acceptConsent(false); return }
    if (name === "x") { declineConsent(); return }
    if (name === "escape") { declineConsent(); return }
  }

  function handleTransferKey(key: KeyEvent): void {
    const active = state.transferQueue.find((record) => record.id === state.activeTransferId)
    const name = key.name.toLowerCase()
    if (name === "escape" && active && (active.status === "queued" || active.status === "transferring")) { cancelTransfer(); return }
    if (name === "e" && active && (active.status === "queued" || active.status === "transferring")) { failTransfer(); return }
    if (name === "r" && active?.status === "failed") { beginTransferRetry(active.id); return }
    if ((name === "return" || name === "enter" || name === "escape") && active && active.status !== "queued" && active.status !== "transferring") { returnFromTransfer(); return }
  }

  /** Inline path input for destination-add (issue #27). No modal widget exists
   *  in this TUI, so typed characters accumulate in state.destinationInput and
   *  the hint bar shows the buffer. Enter validates and saves; Esc cancels. */
  function handleDestinationInputKey(key: KeyEvent): void {
    const name = key.name.toLowerCase()
    if (name === "return" || name === "enter") {
      const raw = state.destinationInput ?? ""
      const validated = validateDestinationPath(raw)
      if (!validated.ok) {
        state.status = `Invalid destination: ${validated.reason} — fix it or press Esc`
        render(); return
      }
      const already = receiveDestinations.includes(validated.dir)
      receiveDestinations = addDestination(receiveDestinations, validated.dir)
      state.receiveDestinationIndex = receiveDestinations.indexOf(validated.dir)
      state.destinationInput = null
      if (mode === "real") saveDestinations(receiveDestinations)
      logEvent("destination-add", validated.dir)
      state.status = already
        ? `Destination already listed: ${validated.dir}`
        : `Added destination: ${validated.dir} (${state.receiveDestinationIndex + 1}/${receiveDestinations.length})`
      render(); return
    }
    if (name === "escape") {
      state.destinationInput = null
      state.status = "Add destination cancelled"
      render(); return
    }
    if (name === "backspace") {
      state.destinationInput = (state.destinationInput ?? "").slice(0, -1)
      state.status = `New destination: ${state.destinationInput}▌`
      render(); return
    }
    // Printable character: OpenTUI puts the typed char in key.sequence.
    const seq = key.sequence
    if (typeof seq === "string" && seq.length === 1 && seq >= " " && seq !== "\x7f") {
      state.destinationInput = (state.destinationInput ?? "") + seq
      state.status = `New destination: ${state.destinationInput}▌`
      render(); return
    }
  }

  function handleKey(key: KeyEvent): void {
    if (key.ctrl && key.name.toLowerCase() === "c") {
      dispose()
      renderer.destroy()
      return
    }
    if (key.ctrl || key.meta || key.option) return
    // Destination-add input mode captures all keys until Enter/Esc.
    if (state.destinationInput !== null) { handleDestinationInputKey(key); return }
    const name = key.name.toLowerCase()
    switch (state.screen) {
      case "workspace": handleWorkspaceKey(key); return
      case "send-review":
        // Route through command() so real mode reaches beginRealSend().
        // Calling beginOutgoingConsent() directly would run the mock flow.
        if (name === "return" || name === "enter") { command("send-to-consent"); return }
        else if (name === "q") {
          if (mode === "real") {
            state.status = "Peer list is in the Receiver pane · Tab to switch, ↑/↓ to choose"
            render()
            return
          }
          state.identityStep = 0; setScreen("peer")
        }
        else if (name === "escape") {
          // Esc cancels an in-flight real send first; otherwise back to workspace.
          if (mode === "real" && cancelRealSend()) return
          setScreen("workspace")
        }
        return
      case "consent": handleConsentKey(key); return
      case "transfer": handleTransferKey(key); return
      case "peer":
        if (name === "left" || name === "up") { state.peerIndex = (state.peerIndex + peers.length - 1) % Math.max(1, peers.length); state.identityStep = 1; render() }
        else if (name === "right" || name === "down") { state.peerIndex = (state.peerIndex + 1) % Math.max(1, peers.length); state.identityStep = 1; render() }
        else if (name === "v") simulateManualComparison()
        else if (name === "f") toggleFavorite()
        else if (name === "p") openFavorites()
        else if (name === "e") simulatePeerTimeout()
        else if (name === "r") retryPeerPreview()
        else if (name === "escape" || name === "return" || name === "enter") setScreen("workspace")
        return
      case "favorites":
        if (name === "up" || name === "down") { state.favoriteCursor = clamp(state.favoriteCursor + (name === "down" ? 1 : -1), 0, Math.max(0, peerService.favorites().length - 1)); render() }
        else if (name === "return" || name === "enter") openFavorite()
        else if (name === "f") removeSelectedFavorite()
        else if (name === "escape") setScreen("workspace")
        return
      case "diff":
        if (name === "escape") setScreen("workspace")
        else if (name === "tab") command("diff-next")
        else if (name === "return" || name === "enter") command("diff-stage")
        return
      case "help": if (name === "escape" || name === "?") setScreen("workspace"); return
      case "queue":
        if (name === "escape") setScreen("workspace")
        else if (name === "r") command("queue-retry")
        return
    }
  }

  /**
   * Real-mode wiring: live discovery peers, real send/receive. The mock
   * simulation paths above are untouched; this only activates in real mode.
   */
  let realPeerSyncTimer: ReturnType<typeof setInterval> | null = null
  function setupRealMode(real: RealTransport): void {
    // Map discovered peers onto the peer-list shape the UI already renders.
    const syncPeers = () => {
      // Pure map+dedupe (P2-8): never re-append the previous array or
      // entries duplicate every tick.
      peers = syncDiscoveredPeers(real.discovery.listPeers())
      if (state.peerIndex >= peers.length) state.peerIndex = Math.max(0, peers.length - 1)
    }
    const peerTimer = setInterval(() => {
      if (disposed) {
        clearInterval(peerTimer)
        return
      }
      const before = peers.length
      syncPeers()
      if (peers.length !== before) render()
    }, 2000)
    syncPeers()

    // Consent bridge: receiveFiles' onTransferRequest needs user input from
    // the TUI. We park the resolver (consumed by command() above), show the
    // consent screen, and resolve it when the user accepts/declines there.
    const pendingConsent = (request: { peerId: string; files: Array<{ name: string; bytes: number; sha256: string }>; sas: string }) => {
      return new Promise<Array<{ name: string; bytes: number; sha256: string }>>((resolve) => {
        // If a previous consent is still parked, auto-decline it instead of
        // orphaning its promise (and its channel) forever.
        if (realConsentResolver) {
          const stale = realConsentResolver
          realConsentResolver = null
          stale([])
        }
        realConsentResolver = resolve
        // Keep sha256 by file id: the consent screen shape has no sha256 field.
        pendingSha256 = new Map(request.files.map((f) => [f.sha256, f.sha256]))
        // Show the ACTUAL sender, not the currently selected peer — the user
        // must know who they are consenting to.
        const sender = peers.find((p) => p.id === request.peerId || p.fingerprint === request.peerId)
        // Reuse the consent screen shape: files with accepted flags.
        state.request = {
          id: `incoming-${Date.now()}`,
          mode: "incoming",
          peer: sender ?? { id: request.peerId, name: request.peerId.slice(0, 12), host: "", port: 0, fingerprint: request.peerId, online: true },
          files: request.files.map((f) => ({ id: f.sha256, name: f.name, bytes: f.bytes, accepted: true, renamed: false })),
          createdAt: Date.now(),
          // The SAS must be confirmed out of band (in person, over a call)
          // before accepting: discovery announcements are unauthenticated.
          sas: request.sas,
        }
        state.selectedConsentFile = 0
        state.consentScrollOffset = 0
        state.status = `Incoming transfer from ${request.peerId.slice(0, 12)}… · confirm SAS ${request.sas}, then review and accept/decline`
        setScreen("consent")
      })
    }

    // Background receive loop: one session at a time (per the budget).
    // A top-level catch keeps one bad iteration from silently ending all
    // listening; the loop itself only exits when the app is disposed.
    const receiveLoop = async () => {
      try {
        for await (const hs of real.listener.accept()) {
          if (disposed) break
          try {
            state.status = "Incoming connection · verifying identity…"
            render()
            const received = await receiveFiles({
              channel: hs.channel,
              handshakeHash: hs.handshakeHash,
              // No out-of-band expected ID: the consent screen shows the
              // verified Peer ID and SAS, and the user's accept is the
              // confirmation. Identity is fresh per session (P1-13).
              // Resolved per file: the user picks the destination on the
              // consent screen ([D]/[+]/[-]) before accepting (issue #27).
              destinationDirectory: () => receiveDestinations[state.receiveDestinationIndex % Math.max(1, receiveDestinations.length)]!,
              onTransferRequest: pendingConsent,
              onProgress: (fileIndex: number, fileName: string, bytesReceived: number, fileBytes: number) => {
                state.status = `Receiving ${fileName} · ${Math.round((bytesReceived / Math.max(1, fileBytes)) * 100)}%`
                render()
              },
            })
            const landedDir = received.files[0]?.path ? received.files[0].path.slice(0, received.files[0].path.lastIndexOf("/")) : real.receiveDirectory
            state.status = `Received ${received.files.length} file(s) → ${landedDir}`
            logEvent("transfer-complete", `received ${received.files.length} file(s) from ${received.verifiedPeerId.slice(0, 12)}`)
            // Record the real incoming transfer in the queue.
            state.transferQueue = [{
              id: `real-recv-${Date.now()}`,
              direction: "incoming" as const,
              peerName: received.verifiedPeerId.slice(0, 12),
              files: received.files.map((f) => f.name),
              acceptedFiles: received.files.map((f) => f.name),
              acceptedBytes: received.files.reduce((n, f) => n + f.bytes, 0),
              destination: real.receiveDirectory,
              fileIds: received.files.map((f) => f.path),
              status: "complete" as const,
              progress: 100,
              createdAt: Date.now(),
            }, ...state.transferQueue].slice(0, 50)
          } catch (error) {
            state.status = `Receive failed: ${friendlyErrorMessage(error)}`
            logEvent("transfer-fail", `receive: ${error instanceof Error ? error.message : String(error)}`)
          }
          render()
        }
      } catch (error) {
        // Listener-level failure: surface it instead of going silently deaf.
        state.status = `Receive loop failed: ${error instanceof Error ? error.message : String(error)}`
        render()
      }
    }
    void receiveLoop().catch((error) => {
      state.status = `Receive loop crashed: ${error instanceof Error ? error.message : String(error)}`
      render()
    })
    // The peer-sync interval must be cleared on dispose, or it keeps the
    // process alive after the TUI closes.
    realPeerSyncTimer = peerTimer
  }

  /**
   * Real-mode send: staged real files → selected discovered/manual peer →
   * sendFiles with progress. Called from the send-review confirm action.
   */
  let realSendInFlight = false
  let realSendAborter: AbortController | null = null
  /** Cancel key (Esc/x) for an in-flight real send. */
  function cancelRealSend(): boolean {
    if (realSendInFlight && realSendAborter) {
      realSendAborter.abort(new Error("cancelled by user"))
      state.status = "Cancelling send…"
      render()
      return true
    }
    return false
  }
  async function beginRealSend(real: RealTransport): Promise<void> {
    // A double Enter must not send twice.
    if (realSendInFlight) {
      state.status = "Send already in progress…"
      render()
      return
    }
    const staged = stagedEntries("local")
    // Special files (symlinks, FIFOs, sockets, devices) are listed but never
    // sent: a symlink to /dev/zero would hash forever, a FIFO would hang.
    const skipped = staged.filter((e) => e.kind === "file" && e.unsupported)
    const files = staged.filter((e) => e.kind === "file" && !e.unsupported)
    const destination = peer()
    if (files.length === 0) {
      state.status = skipped.length > 0
        ? `Only special files staged (${skipped.map((s) => `${s.name}: ${s.unsupported}`).join(", ")}) — not sendable`
        : "Stage at least one file first · Space selects"
      render()
      return
    }
    if (!destination) {
      state.status = "Select a peer first · Tab to the receiver pane, ↑/↓ to choose"
      render()
      return
    }
    const fileList = files.map((f) => ({ path: f.id, name: f.name }))
    // Capture exactly what is being sent; only these IDs leave the staged set.
    const sentIds = new Set(files.map((f) => f.id))
    state.status = `Connecting to ${destination.name} (${destination.host}:${destination.port})…`
    // Stay on the workspace screen: progress flows through the status line.
    // (The transfer screen is mock-driven and would show "No transfer is active.")
    render()
    realSendInFlight = true
    realSendAborter = new AbortController()
    logEvent("transfer-start", `send ${fileList.length} file(s) to ${destination.name} (${destination.host}:${destination.port})`)
    // Real transfer-status model: the queue shows actual transfers, not mock
    // simulations. Fed by send/receive; the mock service is a null in real mode.
    const recordId = `real-send-${Date.now()}`
    const record: TransferRecord = {
      id: recordId,
      direction: "outgoing" as const,
      peerName: destination.name,
      files: fileList.map((f) => f.name),
      acceptedFiles: [],
      acceptedBytes: 0,
      destination: `${destination.host}:${destination.port}`,
      fileIds: fileList.map((f) => f.path),
      status: "transferring" as const,
      progress: 0,
      createdAt: Date.now(),
    }
    state.transferQueue = [record, ...state.transferQueue].slice(0, 50)
    try {
      const result = await sendFiles({
        host: destination.host,
        port: destination.port,
        files: fileList,
        // Discovered peers carry their verified Peer ID; manual peers use
        // TOFU (their ID is unknown until the handshake verifies it).
        // Identity is fresh per session (P1-13); never reuse one.
        expectedPeerId: destination.fingerprint.startsWith("manual:") ? undefined : destination.fingerprint,
        signal: realSendAborter.signal,
        onProgress: (fileIndex, fileName, bytesSent, fileBytes) => {
          const pct = Math.round((bytesSent / Math.max(1, fileBytes)) * 100)
          state.status = `Sending ${fileName} (${fileIndex + 1}/${fileList.length}) · ${pct}%`
          record.progress = Math.round(((fileIndex + pct / 100) / fileList.length) * 100)
          render()
        },
      })
      // Per-file outcomes: "Sent" is only true when the receiver acked each
      // file (P0-2). The SAS lets the receiver confirm our identity.
      const okCount = result.outcomes.filter((o) => o.ok).length
      const failed = result.outcomes.filter((o) => !o.ok)
      if (failed.length === 0) {
        state.status = `Sent ${okCount} file(s) to ${destination.name} · receiver confirmed · code ${result.sas}`
        record.status = "complete"
        record.progress = 100
        record.acceptedFiles = result.outcomes.map((o) => o.finalName ?? o.name)
      } else {
        state.status = `Partial: ${okCount}/${result.outcomes.length} confirmed by receiver (${failed.map((f) => `${f.name}: ${f.errorCode ?? "failed"}`).join(", ")})`
        record.status = "failed"
        record.acceptedFiles = result.outcomes.filter((o) => o.ok).map((o) => o.finalName ?? o.name)
      }
      logEvent("transfer-complete", `sent ${okCount}/${result.outcomes.length} to ${destination.name}, sas=${result.sas}`)
      // Remove only the files the receiver confirmed; anything else stays
      // staged for retry.
      for (const o of result.outcomes) {
        if (o.ok) {
          const id = fileList.find((f) => f.name === o.name)?.path
          if (id) state.staged.local.delete(id)
        }
      }
      // Back-compat: clear the captured set on full success.
      if (failed.length === 0) {
        for (const id of sentIds) state.staged.local.delete(id)
      }
    } catch (error) {
      // Specific protocol errors get specific messages; partial outcomes
      // (some files confirmed before the failure) keep those files unstaged.
      if (error instanceof TransferDeclinedError) {
        state.status = "Receiver declined the transfer"
        record.status = "declined"
      } else if (error instanceof PeerCancelledError) {
        state.status = "Receiver cancelled the transfer"
        record.status = "cancelled"
      } else if (error instanceof SendAbortedError && error.outcomes.length > 0) {
        const ok = error.outcomes.filter((o) => o.ok).length
        state.status = `Send interrupted: ${ok}/${error.outcomes.length} file(s) confirmed by receiver`
        record.status = "failed"
      } else {
        state.status = `Send failed: ${friendlyErrorMessage(error)}`
        record.status = "failed"
      }
      logEvent("transfer-fail", `send to ${destination.name}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      realSendInFlight = false
      realSendAborter = null
    }
    render()
  }

  function onBlur(): void {
    paused = true
    clock.pause()
    reconcileTimers()
  }
  function onFocus(): void {
    paused = false
    clock.resume()
    reconcileTimers()
  }

  renderer.useMouse = true
  renderer.keyInput.on("keypress", handleKey)
  renderer.on(CliRenderEvents.RESIZE, render)
  renderer.on(CliRenderEvents.BLUR, onBlur)
  renderer.on(CliRenderEvents.FOCUS, onFocus)

  // Real mode: wire live discovery, send, and receive. Mock mode keeps the
  // deterministic simulation untouched.
  if (mode === "real" && dependencies.real) {
    setupRealMode(dependencies.real)
  }
  render()

  function dispose(): void {
    if (disposed) return
    disposed = true
    // Break the real-mode receive loop: aborting the signal unparks the
    // accept() generator so the for-await loop can exit.
    if (mode === "real" && dependencies.real) {
      try {
        dependencies.real.aborter.abort()
      } catch {
        // Best effort; the process is exiting anyway.
      }
      if (realPeerSyncTimer) {
        clearInterval(realPeerSyncTimer)
        realPeerSyncTimer = null
      }
    }
    clock.dispose()
    renderer.keyInput.off("keypress", handleKey)
    renderer.off(CliRenderEvents.RESIZE, render)
    renderer.off(CliRenderEvents.BLUR, onBlur)
    renderer.off(CliRenderEvents.FOCUS, onFocus)
  }

  return { state, render, handleKey, dispose }
}