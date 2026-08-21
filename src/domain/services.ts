import type { AppState, DiffLine, MockPeer, MockFile, TransferJob } from "./types"

export interface PeerService {
  listPeers(): MockPeer[]
  beginPairing(peerId: string): Promise<void>
  cancelPairing(): void
}

export interface FilesystemService {
  list(path: string): MockFile[]
  getDiff(fileId: string): DiffLine[]
}

export interface TransferService {
  createJob(fileIds: string[], files: MockFile[]): TransferJob
  tick(job: TransferJob): TransferJob
  cancel(job: TransferJob): TransferJob
}

export interface AppStore {
  getState(): AppState
  dispatch(action: AppAction): void
  subscribe(listener: (state: AppState) => void): () => void
}

export type AppAction =
  | { type: "focus-pane"; pane: AppState["activePane"] }
  | { type: "move-cursor"; delta: -1 | 1 }
  | { type: "toggle-selection" }
  | { type: "open-pairing" }
  | { type: "pairing-step" }
  | { type: "cancel-pairing" }
  | { type: "open-diff" }
  | { type: "next-hunk" }
  | { type: "stage-hunk" }
  | { type: "close-overlay" }
  | { type: "start-transfer" }
  | { type: "tick-transfer" }
  | { type: "cancel-transfer" }
  | { type: "complete-transfer" }
  | { type: "set-status"; status: string }

export type StateListener = (state: AppState) => void
