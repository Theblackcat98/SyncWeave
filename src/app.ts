import { CliRenderEvents, type CliRenderer, type KeyEvent } from "@opentui/core"
import type { AppState, ConsentRequest, MockPeer, Pane, Screen, TransferRecord } from "./domain.js"
import { OTHER_PANE } from "./domain.js"
import { MockFileSystemService } from "./services/mock-filesystem.js"
import { MockPeerService } from "./services/mock-peer-service.js"
import { destinations, MockTransferService } from "./services/mock-transfer-service.js"
import { createInitialAppState, visibleRowCount } from "./state/app-state.js"
import { motion } from "./theme.js"
import { AnimationClock } from "./ui/animation-clock.js"
import { renderApp } from "./ui/render.js"

export interface AppDependencies {
  filesystem?: MockFileSystemService
  peerService?: MockPeerService
  transferService?: MockTransferService
  reducedMotion?: boolean
}

export interface SyncWeaveApp {
  readonly state: AppState
  render(): void
  handleKey(key: KeyEvent): void
  dispose(): void
}

export function createSyncWeaveApp(renderer: CliRenderer, dependencies: AppDependencies = {}): SyncWeaveApp {
  const filesystem = dependencies.filesystem ?? new MockFileSystemService()
  const peerService = dependencies.peerService ?? new MockPeerService()
  const transferService = dependencies.transferService ?? new MockTransferService()
  const peers = peerService.discover()
  const state = createInitialAppState(filesystem.paths, dependencies.reducedMotion)
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
      filesystem,
      peerService,
      peers,
      favorites: peerService.favorites(),
      queue: state.transferQueue,
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
          state.cursors[pane] = clamp(state.cursors[pane] + (direction === "down" ? 1 : -1), 0, Math.max(0, max))
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
    if (stagedEntries().length === 0) {
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
    const transfer = transferService.acceptRequest(request, destinations[state.receiveDestinationIndex % destinations.length], accepted)
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
    peers.splice(0, peers.length, ...peerService.pulse())
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
    const entries = currentEntries()
    state.cursors[state.activePane] = clamp(state.cursors[state.activePane] + delta, 0, Math.max(0, entries.length - 1))
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
      state.status = entry ? `${entry.name} is a file · press d to inspect its mock diff` : "No item to open"
      render()
      return
    }
    state.paths[state.activePane] = `${state.paths[state.activePane].replace(/\/$/, "")}/${entry.name.replace(/\/$/, "")}`
    state.cursors[state.activePane] = 0
    state.scrollOffsets[state.activePane] = 0
    state.status = `Opened mock folder ${entry.name}`
    render()
  }

  function goParentDirectory(): void {
    if (state.paths[state.activePane] === filesystem.paths[state.activePane]) {
      state.status = "Already at the top of this mock workspace"
      render()
      return
    }
    state.paths[state.activePane] = filesystem.parentPath(state.paths[state.activePane])
    state.cursors[state.activePane] = 0
    state.scrollOffsets[state.activePane] = 0
    state.status = "Moved to parent mock folder"
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
    switch (name) {
      case "workspace": state.request = state.screen === "transfer" ? state.request : null; setScreen("workspace"); return
      case "send-review": openSendReview(); return
      case "send-to-consent": beginOutgoingConsent(); return
      case "incoming": createIncomingRequest(); return
      case "peer": state.identityStep = 0; setScreen("peer"); return
      case "favorites": openFavorites(); return
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
      case "cycle-destination": state.receiveDestinationIndex = (state.receiveDestinationIndex + 1) % destinations.length; render(); return
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
        state.status = entry ? `Staged ${entry.name} from the mock diff` : "No file to stage"
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
        const failed = state.transferQueue.find((record) => record.status === "failed" || record.status === "cancelled")
        if (failed) beginTransferRetry(failed.id)
        return
      }
      default:
        if (name.startsWith("favorite-open:")) {
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
      case "i": createIncomingRequest(); return
      case "d": openDiff(); return
      case "q": state.identityStep = 0; setScreen("peer"); return
      case "p": openFavorites(); return
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
      render(); return
    }
    if (name === "space") { command("toggle-consent"); return }
    if (name === "r") { command("rename-consent"); return }
    if (name === "d") { command("cycle-destination"); return }
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

  function handleKey(key: KeyEvent): void {
    if (key.ctrl && key.name.toLowerCase() === "c") {
      dispose()
      renderer.destroy()
      return
    }
    if (key.ctrl || key.meta || key.option) return
    const name = key.name.toLowerCase()
    switch (state.screen) {
      case "workspace": handleWorkspaceKey(key); return
      case "send-review":
        if (name === "return" || name === "enter") beginOutgoingConsent()
        else if (name === "q") { state.identityStep = 0; setScreen("peer") }
        else if (name === "escape") setScreen("workspace")
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
  render()

  function dispose(): void {
    if (disposed) return
    disposed = true
    clock.dispose()
    renderer.keyInput.off("keypress", handleKey)
    renderer.off(CliRenderEvents.RESIZE, render)
    renderer.off(CliRenderEvents.BLUR, onBlur)
    renderer.off(CliRenderEvents.FOCUS, onFocus)
  }

  return { state, render, handleKey, dispose }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
