import type { AppState, Pane } from "../domain.js"

const TRUTHY = new Set(["1", "true", "yes", "on"])

/** Env flag / boolean-ish value: 1, true, yes or on (case-insensitive). */
export function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase())
}

/** NO_COLOR (https://no-color.org): any non-empty value disables colour. For the UI's theme. */
export function noColorRequested(env: Record<string, string | undefined> = process.env): boolean {
  return (env.NO_COLOR ?? "") !== ""
}

export function createInitialAppState(paths: Record<Pane, string>, reducedMotion = isTruthyFlag(process.env.SYNCWEAVE_REDUCED_MOTION)): AppState {
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
