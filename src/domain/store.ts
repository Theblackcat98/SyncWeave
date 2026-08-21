import { createInitialState } from "./mock-data"
import type { AppAction, AppStore, StateListener } from "./services"
import type { AppState, MockFile, TransferJob } from "./types"

function filesFor(state: AppState): MockFile[] {
  return state.activePane === "local" ? state.localFiles : state.remoteFiles
}

function cursorFor(state: AppState): number {
  return state.activePane === "local" ? state.localCursor : state.remoteCursor
}

function withCursor(state: AppState, cursor: number): AppState {
  return state.activePane === "local" ? { ...state, localCursor: cursor } : { ...state, remoteCursor: cursor }
}

function selectedFiles(state: AppState): MockFile[] {
  return [...state.localFiles, ...state.remoteFiles].filter((file) => file.selected && file.kind === "file")
}

function transferJob(state: AppState): TransferJob | null {
  const files = selectedFiles(state)
  if (files.length === 0) return null
  const bytesTotal = files.reduce((sum, file) => sum + file.bytes, 0)
  return {
    id: `transfer:${Date.now()}`,
    fileIds: files.map((file) => file.id),
    state: "transferring",
    progress: 0,
    bytesTotal,
    bytesTransferred: 0,
    speedMbps: 14.2,
    etaSeconds: Math.max(1, Math.ceil(bytesTotal / (14.2 * 1024 * 1024))),
  }
}

export function reduce(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "focus-pane":
      return { ...state, activePane: action.pane, status: `Focused ${action.pane} workspace` }

    case "move-cursor": {
      const files = filesFor(state)
      const next = Math.max(0, Math.min(files.length - 1, cursorFor(state) + action.delta))
      return withCursor(state, next)
    }

    case "toggle-selection": {
      const files = filesFor(state)
      const cursor = cursorFor(state)
      const file = files[cursor]
      if (!file) return state
      if (file.kind === "directory") return { ...state, status: `${file.name} is a directory — navigation comes in the workspace layer` }
      file.selected = !file.selected
      return {
        ...state,
        status: `${file.selected ? "Staged" : "Unstaged"} ${file.name}`,
      }
    }

    case "open-pairing":
      return { ...state, screen: "pairing", pairingStep: 0, status: "Waiting for peer…" }

    case "pairing-step": {
      const pairingStep = Math.min(2, state.pairingStep + 1)
      return {
        ...state,
        pairingStep,
        connectedPeerId: pairingStep >= 2 ? "peer:macbook" : state.connectedPeerId,
        status: pairingStep === 2 ? "Pairing complete — connected to MacBook-M3" : pairingStep === 1 ? "Peer discovered — authenticating…" : "Waiting for peer…",
      }
    }

    case "cancel-pairing":
      return { ...state, screen: "workspace", pairingStep: 0, status: "Pairing cancelled" }

    case "open-diff":
      return { ...state, screen: "diff", selectedHunk: 0 }

    case "next-hunk":
      return { ...state, selectedHunk: (state.selectedHunk + 1) % 2, status: "Next diff hunk selected" }

    case "stage-hunk":
      return { ...state, status: `Mock hunk ${state.selectedHunk + 1} staged` }

    case "close-overlay":
      return { ...state, screen: "workspace" }

    case "start-transfer": {
      const job = transferJob(state)
      if (!job) return { ...state, status: "Nothing staged — press Space on a file first" }
      return { ...state, screen: "transfer", transfer: job }
    }

    case "tick-transfer": {
      if (!state.transfer || state.transfer.state !== "transferring") return state
      const progress = Math.min(100, state.transfer.progress + 8)
      const bytesTransferred = Math.floor(state.transfer.bytesTotal * (progress / 100))
      return {
        ...state,
        transfer: {
          ...state.transfer,
          progress,
          bytesTransferred,
          etaSeconds: Math.max(0, Math.ceil((100 - progress) / 18)),
          state: progress >= 100 ? "complete" : "transferring",
        },
      }
    }

    case "complete-transfer": {
      if (!state.transfer) return state
      const ids = new Set(state.transfer.fileIds)
      const sync = (file: MockFile): MockFile => ids.has(file.id) ? { ...file, selected: false, state: "synced" } : file
      return {
        ...state,
        localFiles: state.localFiles.map(sync),
        remoteFiles: state.remoteFiles.map(sync),
        status: "Sync complete — all staged changes are synchronized",
      }
    }

    case "cancel-transfer":
      return { ...state, screen: "workspace", transfer: state.transfer ? { ...state.transfer, state: "cancelled" } : null, status: "Mock transfer cancelled" }

    case "set-status":
      return { ...state, status: action.status }
  }
}

export class SyncWeaveStore implements AppStore {
  private state: AppState = createInitialState()
  private listeners = new Set<StateListener>()

  getState(): AppState {
    return this.state
  }

  dispatch(action: AppAction): void {
    this.state = reduce(this.state, action)
    for (const listener of this.listeners) listener(this.state)
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
