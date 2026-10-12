import { CliRenderEvents, type CliRenderer, type KeyEvent } from "@opentui/core"
import { homedir } from "node:os"
import { dirname } from "node:path"
import type { AppMode, AppState, MockPeer, Pane, Screen, TransferRecord } from "./domain.js"
import { OTHER_PANE } from "./domain.js"
import type { FileSystemService, PeerService, TransferService } from "./services/ports.js"
import { listenNoise, type HandshakeResult } from "./services/transport.js"
import {
  receiveFiles,
  sendFiles,
  TransferDeclinedError,
  PeerCancelledError,
  ReceiveAbortedError,
  SendAbortedError,
  type ProtocolFile,
  type SendFileOutcome,
} from "./services/transfer-protocol.js"
import { friendlyErrorMessage } from "./services/friendly-errors.js"
import type { DiscoveryService } from "./services/discovery.js"
import { logEvent } from "./services/diagnostic-log.js"
import { addDestination, cycleDestinationIndex, removeDestination, saveDestinations, validateDestinationPath } from "./services/destinations.js"
import { createInitialAppState, visibleRowCount } from "./state/app-state.js"
import { clamp, stepCursor } from "./cursor.js"
import { syncDiscoveredPeers } from "./peer-sync.js"
import { motion } from "./theme.js"
import { AnimationClock } from "./ui/animation-clock.js"
import { renderApp } from "./ui/render.js"

type NoiseListener = Awaited<ReturnType<typeof listenNoise>>

/** Upper bound on how long dispose() waits for in-flight sends and receives. */
const DISPOSE_SETTLE_MS = 3000
/** Delay before the SAS prompt accepts Enter/y: the keypress that started the send must not confirm it. */
export const SAS_CONFIRM_ARM_MS = 400
/** Peer IDs start with a fixed 6-character multibase/protobuf prefix that carries no entropy. */
const PEER_ID_FIXED_PREFIX = 6
/** Random characters shown for an unverified sender's fingerprint (4-character groups). */
const FINGERPRINT_CHARS = 24

/**
 * Display form of a session Peer ID for out-of-band comparison: the random
 * part only (the fixed prefix is skipped), grouped in fours.
 */
export function formatPeerFingerprint(peerId: string): string {
  const random = peerId.slice(PEER_ID_FIXED_PREFIX, PEER_ID_FIXED_PREFIX + FINGERPRINT_CHARS)
  return random.match(/.{1,4}/g)?.join(" ") ?? ""
}

/** Resolve after `tasks` settle, or after `ms`, whichever comes first. */
async function settleWithin(tasks: Iterable<Promise<unknown>>, ms: number): Promise<void> {
  const all = [...tasks]
  if (all.length === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  await Promise.race([Promise.allSettled(all).then(() => undefined), timeout])
  clearTimeout(timer)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Connected peer's address, when the transport reports it; null when unknown. */
function remoteAddressOf(hs: HandshakeResult): string | null {
  const address: unknown = (hs as { remoteAddress?: unknown }).remoteAddress
  return typeof address === "string" && address.length > 0 ? address : null
}

/** Change detector for the peer list (identity, name and address). */
function peerSignature(list: readonly MockPeer[]): string {
  return list.map((p) => `${p.id}\u0000${p.name}\u0000${p.host}\u0000${p.port}`).join("\n")
}

/**
 * Real-mode transport bundle. The app owns one TCP listener and one discovery
 * service; the filesystem it lists is passed in as `filesystem`.
 */
export interface RealTransport {
  /**
   * Discovery display/dedup hint, announced over UDP. It is NOT an identity:
   * verification happens per session through the SAS (D1), and a discovered
   * peer's ID is never used as an expected Peer ID.
   */
  announcedPeerId: string
  listener: NoiseListener
  discovery: DiscoveryService
  alias: string
  tcpPort: number
  /** Directory where received files are written. */
  receiveDirectory: string
  /** Aborts the listener accept loop; aborted on app dispose. */
  aborter: AbortController
  /** Non-fatal startup notice to show in the status line (e.g. IPv4 fallback). */
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
   * "mock" (default) renders the deterministic simulation. "real" uses the
   * filesystem passed in (the real one) and a receiver status panel instead
   * of the receiver's files; mock services are never used.
   */
  mode?: AppMode
  /** Required in real mode: the live transport bundle. */
  real?: RealTransport
}

export interface SyncWeaveApp {
  readonly state: AppState
  render(): void
  handleKey(key: KeyEvent): void
  /**
   * Stops real-mode work. Aborts in-flight sends and receives, waits for them
   * to settle (bounded), and resolves. Idempotent.
   */
  dispose(): Promise<void>
}

/** A consent prompt parked while a real incoming session waits for the user. */
interface ParkedConsent {
  files: ProtocolFile[]
  session: ReceiveSession
  resolve: (accepted: ProtocolFile[]) => void
}

/** Per-session state for one real incoming transfer. */
interface ReceiveSession {
  aborter: AbortController
  record: TransferRecord
  remoteAddress: string | null
  /** Alias of a discovery entry at the same address: shown only as "claimed". */
  claimedAlias: string | null
  /** Destination chosen on the consent screen; set before acceptance resolves. */
  destination: string | null
  /** Why the consent prompt closed without an answer, when it did. */
  consentEnd: "timeout" | "disconnect" | "local" | null
}

/** The SAS gate for one real outgoing send (P0-1). */
interface SasPrompt {
  /** Enter/y is ignored until this time, so the Enter that started a send cannot confirm its code. */
  armedAt: number
  settle: (confirmed: boolean) => void
}

export function createSyncWeaveApp(renderer: CliRenderer, dependencies: AppDependencies): SyncWeaveApp {
  const mode: AppMode = dependencies.mode ?? "mock"
  if (mode === "real" && !dependencies.real) {
    throw new Error("createSyncWeaveApp: real mode requires dependencies.real (the transport bundle)")
  }
  const filesystem: FileSystemService = dependencies.filesystem
  const { peerService, transferService } = dependencies
  // Mutable working copy: add/remove destinations (issue #27) mutate this;
  // the persisted file is the source of truth across restarts.
  let receiveDestinations: string[] = [...dependencies.receiveDestinations]
  // In real mode the peer list is populated from UDP-multicast discovery
  // (plus manual entries); in mock mode it comes from the mock service.
  let peers: MockPeer[] = mode === "real" ? [] : peerService.discover()
  // Real mode: the selected peer is tracked by ID, so a reordered or
  // re-announced list never silently retargets a send (P1-39).
  let selectedPeerId: string | null = null
  // Real-mode bridges. At most one incoming consent and one SAS prompt are parked.
  let realConsent: ParkedConsent | null = null
  let sasPrompt: SasPrompt | null = null
  let sendAborter: AbortController | null = null
  let receiveAborter: AbortController | null = null
  /** Every real send/receive task; dispose() waits for these to settle. */
  const inFlight = new Set<Promise<unknown>>()
  let disposing: Promise<void> | null = null
  const state = createInitialAppState(filesystem.paths, dependencies.reducedMotion)
  if (mode === "real") {
    state.status = "Ready · listening for peers on the LAN"
  }
  if (mode === "real" && dependencies.real?.startupWarning) {
    // Surface non-fatal startup notices where the user can see them.
    state.status = dependencies.real.startupWarning
  }
  const clock = new AnimationClock()
  let paused = false
  let disposed = false

  // Real mode: the queue is the app's own record of real transfers. The mock
  // service is never consulted, so real history survives every render (P1-1).
  const syncQueue = () => {
    if (mode !== "real") state.transferQueue = transferService.queue()
  }
  const peer = (): MockPeer | undefined =>
    mode === "real"
      ? peers.find((item) => item.id === selectedPeerId)
      : peers[state.peerIndex % Math.max(1, peers.length)]
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
        const p = peers[state.peerIndex]!
        selectedPeerId = p.id
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
      state.status = entry
        ? (mode === "real" ? `${entry.name} is a file · Space stages it, s reviews the send` : `${entry.name} is a file · press d to inspect its mock diff`)
        : "No item to open"
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
    if (mode === "real" && state.activePane === "remote") {
      state.status = "The Receiver pane lists peers, not folders"
      render()
      return
    }
    const current = state.paths[state.activePane]
    // Real mode may climb to the filesystem root (parentPath(p) === p there).
    const atTop = mode === "real"
      ? filesystem.parentPath(current) === current
      : current === filesystem.paths[state.activePane]
    if (atTop) {
      state.status = mode === "real" ? "Already at the top of the filesystem" : "Already at the top of this mock workspace"
      render()
      return
    }
    state.paths[state.activePane] = filesystem.parentPath(current)
    state.cursors[state.activePane] = 0
    state.scrollOffsets[state.activePane] = 0
    state.status = mode === "real" ? "Moved to parent folder" : "Moved to parent mock folder"
    render()
  }

  function goHomeDirectory(): void {
    state.paths.local = homedir()
    state.activePane = "local"
    state.cursors.local = 0
    state.scrollOffsets.local = 0
    state.status = "Moved to your home folder"
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
    // Real-mode consent answers resolve the parked incoming session. They never
    // reach the mock accept/decline path, which would call NullTransferService.
    if (mode === "real" && (name === "consent-accept" || name === "consent-all" || name === "consent-decline")) {
      answerRealConsent(name === "consent-decline" ? "decline" : name === "consent-all" ? "all" : "accept")
      return
    }
    switch (name) {
      case "workspace":
        if (mode === "real" && realConsent) {
          answerRealConsent("decline")
          return
        }
        state.request = state.screen === "transfer" ? state.request : null; setScreen("workspace"); return
      case "send-review": openSendReview(); return
      case "send-to-consent":
        if (mode === "real" && dependencies.real) {
          startRealSend(dependencies.real)
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
        // Real mode saves incoming files under their sanitised sender names;
        // there is no rename, so the key does nothing.
        if (mode === "real") {
          state.status = "Incoming files keep the sender's name (unsafe characters are removed on save)"
          render(); return
        }
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
        if (mode === "real") {
          // Real retry re-stages the failed send's files for a fresh review.
          const failedSend = state.transferQueue.find((record) => record.direction === "outgoing" && (record.status === "failed" || record.status === "cancelled"))
          if (failedSend) beginTransferRetry(failedSend.id)
          else { state.status = "No failed or cancelled send to retry"; render() }
          return
        }
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
    if (mode === "real" && key.sequence === "~") { goHomeDirectory(); return }
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
    if (!state.request || (mode === "real" && !realConsent)) { setScreen("workspace"); return }
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
    // In real mode a parked receive session waits on this screen: answers go
    // through command(), never the mock accept/decline (which would orphan it).
    if (mode === "real") {
      if (name === "a") { command("consent-all"); return }
      if (name === "return" || name === "enter") { command("consent-accept"); return }
      if (name === "x" || name === "escape") { command("consent-decline"); return }
      return
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
      void dispose()
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
        // While the sender's SAS is parked, Enter/y confirms and Esc/n rejects.
        if (mode === "real" && sasPrompt) {
          if ((name === "return" || name === "enter" || name === "y") && sasPrompt.armedAt <= Date.now()) sasPrompt.settle(true)
          else if (name === "escape" || name === "n" || name === "x") sasPrompt.settle(false)
          return
        }
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
        else if (name === "x" && mode === "real") { cancelRealSend(); return }
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

  /** Track a real send/receive task so dispose() can wait for it to settle. */
  function track<T>(task: Promise<T>): Promise<T> {
    inFlight.add(task)
    void task.finally(() => inFlight.delete(task)).catch(() => undefined)
    return task
  }

  /** Render from background work: a failed frame must not end the session. */
  function renderSafely(): void {
    try {
      render()
    } catch (error) {
      logEvent("render-failed", errorText(error))
    }
  }

  /** Remove the parked consent prompt and unpark its session with a decline. */
  function dropParkedConsent(): void {
    const parked = realConsent
    if (!parked) return
    realConsent = null
    state.request = null
    if (state.screen === "consent") setScreen("workspace")
    else renderSafely()
    parked.resolve([])
  }

  /** Close the parked consent prompt without an answer (sender left, timeout, local abort). */
  function closeConsentPrompt(status: string): void {
    if (!realConsent) return
    state.status = status
    logEvent("consent-closed", status)
    dropParkedConsent()
  }

  /** The user's answer on the consent screen for the parked incoming session. */
  function answerRealConsent(choice: "accept" | "all" | "decline"): void {
    const parked = realConsent
    const request = state.request
    if (!parked || !request) return
    if (choice === "decline") {
      realConsent = null
      state.request = null
      setScreen("workspace")
      state.status = "Declined incoming transfer · nothing was saved"
      logEvent("consent-decline")
      render()
      parked.resolve([])
      return
    }
    // "Accept all" truly selects everything first.
    if (choice === "all") request.files.forEach((file) => { file.accepted = true })
    // Rows and files are index-aligned, so the accepted subset keeps the SAME
    // object references the protocol handed over (D2).
    const accepted = parked.files.filter((_, index) => request.files[index]?.accepted)
    // Enter with nothing selected is a no-op (not a silent decline).
    if (accepted.length === 0) {
      state.status = "Choose one or more files, accept all (a), or decline (x)"
      render()
      return
    }
    const destination = receiveDestinations[state.receiveDestinationIndex % receiveDestinations.length]!
    // Re-check the destination now: it may have been removed or made read-only
    // since it was listed. Refuse with a clear status; the prompt stays open.
    const check = validateDestinationPath(destination)
    if (!check.ok) {
      state.status = `Cannot accept: destination ${destination} is unusable (${check.reason}) · choose another with d, or remove it with -`
      render()
      return
    }
    parked.session.destination = check.dir
    realConsent = null
    state.request = null
    setScreen("workspace")
    state.status = `Accepted ${accepted.length} file(s) · receiving…`
    logEvent("consent-accept", `${accepted.length} file(s)`)
    render()
    parked.resolve(accepted)
  }

  /** Park a verified incoming request until the user answers on the consent screen. */
  function askConsent(
    request: { peerId: string; files: ProtocolFile[]; sas: string; signal: AbortSignal },
    session: ReceiveSession,
  ): Promise<ProtocolFile[]> {
    return new Promise<ProtocolFile[]>((resolve) => {
      if (realConsent) {
        // One session at a time; a stale prompt must never leave its promise parked.
        const stale = realConsent
        realConsent = null
        stale.resolve([])
      }
      const parked: ParkedConsent = { files: request.files, session, resolve }
      realConsent = parked
      const fingerprint = formatPeerFingerprint(request.peerId)
      // The sender is identified by its verified session Peer ID only. A
      // discovery alias is shown as "claimed", and only when the address matches.
      const name = session.claimedAlias ? `unverified sender · claims "${session.claimedAlias}"` : "unverified sender"
      state.request = {
        id: `incoming-${Date.now()}`,
        mode: "incoming",
        peer: { id: request.peerId, name, host: session.remoteAddress ?? "", port: 0, fingerprint, online: true },
        files: request.files.map((file, index) => ({ id: String(index), name: file.name, bytes: file.bytes, accepted: true, renamed: false })),
        createdAt: Date.now(),
        // The SAS must be compared with the sender before accepting: discovery
        // announcements are unauthenticated.
        sas: request.sas,
      }
      state.selectedConsentFile = 0
      state.consentScrollOffset = 0
      state.status = `Incoming transfer from unverified sender ${fingerprint} · compare code ${request.sas} with the sender, then accept or decline`
      if (state.screen === "consent") render()
      else setScreen("consent")
      request.signal.addEventListener("abort", () => {
        if (realConsent !== parked) return
        const reason = request.signal.reason
        if (reason instanceof Error && reason.message.startsWith("consent timed out")) {
          session.consentEnd = "timeout"
          closeConsentPrompt("Consent timed out · transfer declined")
        } else if (session.aborter.signal.aborted) {
          session.consentEnd = "local"
          closeConsentPrompt("Receive cancelled · nothing was saved")
        } else {
          session.consentEnd = "disconnect"
          closeConsentPrompt("Sender disconnected · prompt closed, nothing was saved")
        }
      }, { once: true })
    })
  }

  /** One real incoming session, from verified request to saved files. Never throws. */
  async function receiveSession(hs: HandshakeResult, real: RealTransport, claimedAlias: (address: string | null) => string | null): Promise<void> {
    const remoteAddress = remoteAddressOf(hs)
    const session: ReceiveSession = {
      aborter: new AbortController(),
      record: {
        id: `real-recv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        direction: "incoming",
        peerName: "unverified sender",
        files: [],
        acceptedFiles: [],
        acceptedBytes: 0,
        destination: real.receiveDirectory,
        fileIds: [],
        status: "transferring",
        progress: 0,
        createdAt: Date.now(),
      },
      remoteAddress,
      claimedAlias: claimedAlias(remoteAddress),
      destination: null,
      consentEnd: null,
    }
    receiveAborter = session.aborter
    state.transferQueue = [session.record, ...state.transferQueue].slice(0, 50)
    state.activeTransferId = session.record.id
    state.status = "Incoming connection · verifying identity…"
    renderSafely()
    try {
      const received = await receiveFiles({
        channel: hs.channel,
        handshakeHash: hs.handshakeHash,
        // No expected Peer ID: the SAS compared on the consent screen is the check (D1).
        // The destination is chosen on the consent screen and fixed at accept time.
        destinationDirectory: () => session.destination ?? real.receiveDirectory,
        onTransferRequest: (request) => askConsent(request, session),
        signal: session.aborter.signal,
        onProgress: (_index, fileName, bytesReceived, fileBytes) => {
          state.status = `Receiving ${fileName} · ${Math.round((bytesReceived / Math.max(1, fileBytes)) * 100)}%`
          renderSafely()
        },
      })
      const landed = received.files[0] ? dirname(received.files[0].path) : session.destination ?? real.receiveDirectory
      const record = session.record
      record.status = "complete"
      record.progress = 100
      record.peerName = formatPeerFingerprint(received.verifiedPeerId)
      record.files = received.files.map((file) => file.name)
      record.acceptedFiles = record.files
      record.acceptedBytes = received.files.reduce((total, file) => total + file.bytes, 0)
      record.destination = landed
      record.fileIds = received.files.map((file) => file.path)
      state.status = `Received ${received.files.length} file(s) → ${landed}`
      logEvent("transfer-complete", `received ${received.files.length} file(s) from ${received.verifiedPeerId.slice(0, 12)}`)
    } catch (error) {
      const record = session.record
      const savedFiles = error instanceof ReceiveAbortedError ? error.receivedFiles : []
      record.acceptedFiles = savedFiles.map((file) => file.name)
      record.fileIds = savedFiles.map((file) => file.path)
      record.acceptedBytes = savedFiles.reduce((total, file) => total + file.bytes, 0)
      if (session.consentEnd === "timeout") {
        record.status = "failed"
        record.error = "consent timed out"
        state.status = "Consent timed out · transfer declined"
      } else if (session.consentEnd === "disconnect") {
        record.status = "cancelled"
        state.status = "Sender disconnected · nothing was saved"
      } else if (session.consentEnd === "local") {
        record.status = "cancelled"
        state.status = "Receive cancelled · nothing was saved"
      } else if (error instanceof TransferDeclinedError) {
        record.status = "declined"
        state.status = "Declined · the sender was told and nothing was saved"
      } else if (error instanceof ReceiveAbortedError) {
        record.status = "failed"
        record.error = friendlyErrorMessage(error)
        state.status = savedFiles.length > 0
          ? `Receive interrupted: ${savedFiles.length} file(s) saved → ${dirname(savedFiles[0]!.path)}`
          : "Receive interrupted · nothing was saved"
      } else {
        record.status = "failed"
        record.error = friendlyErrorMessage(error)
        state.status = `Receive failed: ${friendlyErrorMessage(error)}`
      }
      logEvent("transfer-fail", `receive: ${errorText(error)}`)
    } finally {
      if (receiveAborter === session.aborter) receiveAborter = null
      // Whatever ended the session, its consent prompt must not outlive it.
      if (realConsent?.session === session) dropParkedConsent()
      if (state.activeTransferId === session.record.id) state.activeTransferId = null
      renderSafely()
    }
  }

  /** Real-mode wiring: live discovery peers and the receive loop. */
  let realPeerSyncTimer: ReturnType<typeof setInterval> | null = null
  function setupRealMode(real: RealTransport): void {
    // The selected peer is tracked by ID (P1-39); the list is rebuilt from discovery.
    const syncPeers = (): boolean => {
      const before = peerSignature(peers)
      peers = syncDiscoveredPeers(real.discovery.listPeers())
      const index = peers.findIndex((item) => item.id === selectedPeerId)
      if (index >= 0) {
        state.peerIndex = index
      } else {
        state.peerIndex = clamp(state.peerIndex, 0, Math.max(0, peers.length - 1))
        selectedPeerId = peers[state.peerIndex]?.id ?? null
      }
      return peerSignature(peers) !== before
    }
    const refreshPeers = (): void => {
      if (disposed) return
      const previous = peers
      if (!syncPeers()) return
      // A known peer that moved address is worth a warning: a spoofed
      // re-announcement could redirect a send.
      const moved = previous.flatMap((old) => {
        const now = peers.find((item) => item.id === old.id)
        return now && (now.host !== old.host || now.port !== old.port)
          ? [`${old.name} ${old.host}:${old.port} → ${now.host}:${now.port}`]
          : []
      })
      if (moved.length > 0) state.status = `Known peer changed address: ${moved.join(", ")} · check it before sending`
      renderSafely()
    }
    syncPeers()
    realPeerSyncTimer = setInterval(refreshPeers, 2000)

    real.discovery
      .start({
        alias: real.alias,
        peerId: real.announcedPeerId,
        tcpPort: real.tcpPort,
        events: {
          onError: (error: Error) => {
            state.status = `Discovery: ${error.message}`
            renderSafely()
          },
          onPeersChanged: () => refreshPeers(),
        },
      })
      .catch((error: unknown) => {
        // Non-fatal: manual --peer entries still work.
        state.status = `Discovery failed to start (${errorText(error)}); manual --peer entries still work.`
        logEvent("discovery-start-failed", errorText(error))
        renderSafely()
      })

    const claimedAlias = (address: string | null): string | null =>
      address === null ? null : real.discovery.listPeers().find((item) => item.address === address)?.alias ?? null

    // One session at a time (per the budget). A failure in one session never
    // ends the loop; only a listener-level failure does.
    const receiveLoop = async (): Promise<void> => {
      for await (const hs of real.listener.accept()) {
        if (disposed) break
        try {
          await track(receiveSession(hs, real, claimedAlias))
        } catch (error) {
          state.status = `Receive failed: ${errorText(error)}`
          renderSafely()
        }
      }
    }
    void receiveLoop().catch((error: unknown) => {
      // Listener-level failure: surface it instead of going silently deaf.
      if (realConsent) dropParkedConsent()
      state.status = `Receive loop failed: ${errorText(error)}`
      renderSafely()
    })
  }

  /** Park the SAS gate for one send: resolves true only when the user confirms the code (P0-1). */
  function askSendSas(
    info: { sas: string; peerId: string; signal: AbortSignal },
    peerName: string,
    outcome: { rejected: boolean },
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (info.signal.aborted) {
        outcome.rejected = true
        resolve(false)
        return
      }
      const prompt: SasPrompt = {
        armedAt: Date.now() + SAS_CONFIRM_ARM_MS,
        settle: (confirmed) => {
          if (sasPrompt !== prompt) return
          sasPrompt = null
          state.sendSasConfirm = null
          if (!confirmed) outcome.rejected = true
          state.status = confirmed ? "Code confirmed · sending the file list…" : "Code not confirmed · send cancelled"
          logEvent("sas-confirm", confirmed ? "confirmed" : "rejected")
          renderSafely()
          resolve(confirmed)
        },
      }
      sasPrompt = prompt
      state.sendSasConfirm = { sas: info.sas, peerFingerprint: formatPeerFingerprint(info.peerId), peerName }
      state.status = `Compare code ${info.sas} with the receiver's screen · Enter confirms, Esc rejects`
      info.signal.addEventListener("abort", () => prompt.settle(false), { once: true })
      renderSafely()
    })
  }

  /** Remove the files the receiver confirmed; anything else stays staged for retry. */
  function unstageConfirmed(outcomes: SendFileOutcome[], fileList: Array<{ path: string; name: string }>): void {
    for (const outcome of outcomes) {
      if (!outcome.ok) continue
      const id = fileList.find((file) => file.name === outcome.name)?.path
      if (id) state.staged.local.delete(id)
    }
  }

  /** Cancel key (Esc/x) for a real send: rejects a parked SAS, or aborts the transfer. */
  function cancelRealSend(): boolean {
    if (sasPrompt) {
      sasPrompt.settle(false)
      return true
    }
    if (sendAborter) {
      sendAborter.abort(new Error("cancelled by user"))
      state.status = "Cancelling send…"
      render()
      return true
    }
    return false
  }

  /** Start a real send without leaving an unhandled rejection behind. */
  function startRealSend(real: RealTransport): void {
    void track(beginRealSend(real).catch((error: unknown) => {
      state.sending = false
      sendAborter = null
      state.status = `Send failed: ${errorText(error)}`
      logEvent("transfer-fail", `send: ${errorText(error)}`)
      if (state.screen === "send-review") setScreen("workspace")
      else renderSafely()
    }))
  }

  /**
   * Real-mode send: staged real files -> selected discovered/manual peer,
   * behind the SAS gate, with per-file outcomes from the receiver.
   */
  async function beginRealSend(real: RealTransport): Promise<void> {
    // A double Enter must not send twice: while a send is in flight, Enter only reports it.
    if (state.sending) {
      state.status = "Send already in progress · Esc or x cancels"
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
    const sendAbort = new AbortController()
    const sasOutcome = { rejected: false }
    sendAborter = sendAbort
    state.sending = true
    const record: TransferRecord = {
      id: `real-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    state.activeTransferId = record.id
    state.status = `Connecting to ${destination.name} (${destination.host}:${destination.port})…`
    logEvent("transfer-start", `send ${fileList.length} file(s) to ${destination.name} (${destination.host}:${destination.port})`)
    if (state.screen !== "send-review") setScreen("send-review")
    else render()
    try {
      const result = await sendFiles({
        host: destination.host,
        port: destination.port,
        files: fileList,
        // No expected Peer ID: a discovered ID is a display hint. The SAS gate
        // below runs before any file metadata is sent (D1, P0-1).
        signal: sendAbort.signal,
        confirmSas: (info) => askSendSas(info, destination.name, sasOutcome),
        onHashProgress: (fileIndex, fileCount, fileName) => {
          state.status = `Hashing ${fileIndex + 1}/${fileCount} · ${fileName}`
          renderSafely()
        },
        onProgress: (fileIndex, fileName, bytesSent, fileBytes) => {
          const pct = Math.round((bytesSent / Math.max(1, fileBytes)) * 100)
          state.status = `Sending ${fileName} (${fileIndex + 1}/${fileList.length}) · ${pct}%`
          record.progress = Math.round(((fileIndex + pct / 100) / fileList.length) * 100)
          renderSafely()
        },
      })
      // Per-file outcomes: "Sent" is only true when the receiver acked each file (P0-2).
      unstageConfirmed(result.outcomes, fileList)
      const okCount = result.outcomes.filter((o) => o.ok).length
      const failed = result.outcomes.filter((o) => !o.ok)
      record.acceptedFiles = result.outcomes.filter((o) => o.ok).map((o) => o.finalName ?? o.name)
      record.acceptedBytes = result.outcomes.filter((o) => o.ok).reduce((total, o) => total + o.bytes, 0)
      if (failed.length === 0) {
        state.status = `Sent ${okCount} file(s) to ${destination.name} · receiver confirmed · code ${result.sas}`
        record.status = "complete"
        record.progress = 100
      } else {
        state.status = `Partial: ${okCount}/${result.outcomes.length} confirmed by receiver (${failed.map((f) => `${f.name}: ${f.errorCode ?? "failed"}`).join(", ")})`
        record.status = "failed"
      }
      logEvent("transfer-complete", `sent ${okCount}/${result.outcomes.length} to ${destination.name}, sas=${result.sas}`)
    } catch (error) {
      // Partial outcomes (files the receiver confirmed before the failure) are
      // unstaged too, so a retry never re-sends them (P1-37).
      const outcomes = error instanceof SendAbortedError ? error.outcomes : []
      unstageConfirmed(outcomes, fileList)
      const okNames = outcomes.filter((o) => o.ok).map((o) => o.finalName ?? o.name)
      record.acceptedFiles = okNames
      if (sendAbort.signal.aborted) {
        state.status = `Send cancelled · ${okNames.length}/${fileList.length} confirmed by receiver`
        record.status = "cancelled"
      } else if (sasOutcome.rejected) {
        state.status = "Send cancelled · security code not confirmed"
        record.status = "cancelled"
      } else if (error instanceof TransferDeclinedError) {
        state.status = "Receiver declined the transfer"
        record.status = "declined"
      } else if (error instanceof PeerCancelledError) {
        state.status = "Receiver cancelled the transfer"
        record.status = "cancelled"
      } else if (error instanceof SendAbortedError && outcomes.length > 0) {
        state.status = `Send interrupted: ${okNames.length}/${outcomes.length} file(s) confirmed by receiver · the rest stay staged`
        record.status = "failed"
      } else {
        state.status = `Send failed: ${friendlyErrorMessage(error)}`
        record.status = "failed"
        record.error = friendlyErrorMessage(error)
      }
      logEvent("transfer-fail", `send to ${destination.name}: ${errorText(error)}`)
    } finally {
      sendAborter = null
      state.sending = false
      if (state.activeTransferId === record.id) state.activeTransferId = null
      // Back to the workspace, where the final status line is shown.
      if (state.screen === "send-review") setScreen("workspace")
      else renderSafely()
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

  // Real mode: wire live discovery, send, and receive. Mock mode keeps the
  // deterministic simulation untouched.
  if (mode === "real" && dependencies.real) {
    setupRealMode(dependencies.real)
  }
  render()

  /**
   * Abort in-flight real work and wait (bounded) for it to settle. Idempotent:
   * repeat calls get the same promise, so main can await it before exiting.
   */
  function dispose(): Promise<void> {
    if (disposing) return disposing
    disposed = true
    if (mode === "real" && dependencies.real) {
      // Aborting the listener signal unparks the accept() generator so the
      // receive loop can exit.
      try {
        dependencies.real.aborter.abort()
      } catch {
        // Best effort; the process is exiting anyway.
      }
      if (realPeerSyncTimer) {
        clearInterval(realPeerSyncTimer)
        realPeerSyncTimer = null
      }
      sendAborter?.abort(new Error("SyncWeave is closing"))
      receiveAborter?.abort(new Error("SyncWeave is closing"))
      sasPrompt?.settle(false)
      const parked = realConsent
      realConsent = null
      if (parked) {
        state.request = null
        parked.resolve([])
      }
    }
    clock.dispose()
    renderer.keyInput.off("keypress", handleKey)
    renderer.off(CliRenderEvents.RESIZE, render)
    renderer.off(CliRenderEvents.BLUR, onBlur)
    renderer.off(CliRenderEvents.FOCUS, onFocus)
    disposing = settleWithin(inFlight, DISPOSE_SETTLE_MS)
    return disposing
  }

  return { state, render, handleKey, dispose }
}