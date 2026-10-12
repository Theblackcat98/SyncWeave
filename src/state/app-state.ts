import type { AppState, Pane } from "../domain.js"

export function createInitialAppState(paths: Record<Pane, string>, reducedMotion = process.env.SYNCWEAVE_REDUCED_MOTION === "1"): AppState {
  return {
    screen: "workspace",
    activePane: "local",
    cursors: { local: 0, remote: 0 },
    paths: { local: paths.local, remote: paths.remote },
    scrollOffsets: { local: 0, remote: 0 },
    staged: { local: new Set(), remote: new Set() },
    status: "Ready · all peers, files and transfers are simulated",
    identityStep: 0,
    discoveryFrame: 0,
    focusFrame: 2,
    revealFrame: 2,
    peerIndex: 0,
    favoriteCursor: 0,
    diffHunk: 0,
    request: null,
    selectedConsentFile: 0,
    consentScrollOffset: 0,
    receiveDestinationIndex: 0,
    destinationInput: null,
    transferQueue: [],
    activeTransferId: null,
    reducedMotion,
    sendSasConfirm: null,
    sending: false,
  }
}

export function visibleRowCount(terminalHeight: number): number {
  if (terminalHeight <= 14) return 2
  return Math.max(2, Math.min(14, terminalHeight - 18))
}
