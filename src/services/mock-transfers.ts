import type { FileEntry, TransferCallbacks, TransferService, TransferSnapshot } from "../types"

const TICK_MS = 180
const PROGRESS_PER_TICK = 8
const CHUNK_TOTAL = 13

export function createMockTransfers(): TransferService {
  let snapshot: TransferSnapshot = {
    state: "idle",
    progress: 0,
    activeFileName: "",
    chunkIndex: 0,
    chunkTotal: CHUNK_TOTAL,
  }
  let timer: ReturnType<typeof setInterval> | undefined

  return {
    start(entries: readonly FileEntry[], callbacks: TransferCallbacks): void {
      this.cancel()
      const primary = entries[0]
      snapshot = {
        state: "transferring",
        progress: 0,
        activeFileName: primary ? primary.name : "",
        chunkIndex: 0,
        chunkTotal: CHUNK_TOTAL,
      }
      timer = setInterval(() => {
        const progress = Math.min(100, snapshot.progress + PROGRESS_PER_TICK)
        snapshot = {
          ...snapshot,
          progress,
          chunkIndex: Math.min(CHUNK_TOTAL, Math.max(1, Math.ceil(progress / 8))),
        }
        if (progress >= 100) {
          if (timer) clearInterval(timer)
          timer = undefined
          snapshot = { ...snapshot, state: "complete" }
          callbacks.onComplete(entries)
        }
        callbacks.onUpdate()
      }, TICK_MS)
    },
    cancel(): void {
      if (timer) clearInterval(timer)
      timer = undefined
      snapshot = { ...snapshot, state: "idle", progress: 0 }
    },
    snapshot(): TransferSnapshot {
      return snapshot
    },
  }
}
