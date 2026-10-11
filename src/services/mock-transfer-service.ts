import type { ConsentFile, ConsentMode, ConsentRequest, MockPeer, Pane, TransferRecord, TransferStatus } from "../domain.js"
import { formatBytes } from "../domain.js"

export interface TransferService {
  createRequest(mode: ConsentMode, peer: MockPeer, files: Array<Pick<ConsentFile, "id" | "name" | "bytes">>, sourcePane?: Pane): ConsentRequest
  acceptRequest(request: ConsentRequest, destination: string, accepted: ConsentFile[]): TransferRecord
  declineRequest(request: ConsentRequest): TransferRecord
  queue(): TransferRecord[]
  progress(id: string, step: number): TransferRecord | undefined
  finish(id: string): TransferRecord | undefined
  cancel(id: string): TransferRecord | undefined
  fail(id: string, message: string): TransferRecord | undefined
  retry(id: string): TransferRecord | undefined
}

export const destinations = ["~/Downloads/SyncWeave", "~/Documents/Shared", "~/Desktop/Inbox"] as const

export class MockTransferService implements TransferService {
  private readonly records: TransferRecord[] = []
  private sequence = 0

  createRequest(mode: ConsentMode, peer: MockPeer, files: Array<Pick<ConsentFile, "id" | "name" | "bytes">>, sourcePane?: Pane): ConsentRequest {
    return {
      id: `request-${++this.sequence}`,
      mode,
      peer: { ...peer },
      files: files.map((file) => ({ ...file, accepted: true, renamed: false })),
      createdAt: Date.now(),
      sourcePane,
    }
  }

  acceptRequest(request: ConsentRequest, destination: string, accepted: ConsentFile[]): TransferRecord {
    const record: TransferRecord = {
      id: `transfer-${++this.sequence}`,
      direction: request.mode,
      peerName: request.peer.name,
      files: request.files.map((file) => file.name),
      acceptedFiles: accepted.map((file) => file.renamed ? renamed(file.name) : file.name),
      acceptedBytes: accepted.reduce((sum, file) => sum + file.bytes, 0),
      destination,
      fileIds: accepted.map((file) => file.id),
      sourcePane: request.sourcePane,
      status: "queued",
      progress: 0,
      createdAt: Date.now(),
    }
    this.records.unshift(record)
    return copy(record)
  }

  declineRequest(request: ConsentRequest): TransferRecord {
    const record: TransferRecord = {
      id: `transfer-${++this.sequence}`,
      direction: request.mode,
      peerName: request.peer.name,
      files: request.files.map((file) => file.name),
      acceptedFiles: [],
      acceptedBytes: 0,
      destination: "—",
      fileIds: [],
      sourcePane: request.sourcePane,
      status: "declined",
      progress: 0,
      createdAt: Date.now(),
    }
    this.records.unshift(record)
    return copy(record)
  }

  queue(): TransferRecord[] {
    return this.records.map(copy)
  }

  progress(id: string, step: number): TransferRecord | undefined {
    return this.update(id, (record) => {
      record.status = "transferring"
      record.progress = Math.min(100, Math.max(0, record.progress + step))
    })
  }

  finish(id: string): TransferRecord | undefined {
    return this.update(id, (record) => { record.status = "complete"; record.progress = 100 })
  }

  cancel(id: string): TransferRecord | undefined {
    return this.update(id, (record) => { record.status = "cancelled" })
  }

  fail(id: string, message: string): TransferRecord | undefined {
    return this.update(id, (record) => { record.status = "failed"; record.error = message })
  }

  retry(id: string): TransferRecord | undefined {
    const source = this.records.find((record) => record.id === id)
    if (!source) return undefined
    const retry: TransferRecord = {
      ...copy(source),
      id: `transfer-${++this.sequence}`,
      status: "queued",
      progress: 0,
      error: undefined,
      createdAt: Date.now(),
    }
    this.records.unshift(retry)
    return copy(retry)
  }

  private update(id: string, mutate: (record: TransferRecord) => void): TransferRecord | undefined {
    const record = this.records.find((item) => item.id === id)
    if (!record) return undefined
    mutate(record)
    return copy(record)
  }
}

export function renamed(name: string): string {
  const dot = name.lastIndexOf(".")
  const suffix = " (from peer)"
  return dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`
}

export function transferSummary(record: TransferRecord): string {
  const count = record.acceptedFiles.length
  if (!count) return "No files selected"
  const label = `${count} file${count === 1 ? "" : "s"}`
  return `${label} · ${record.peerName} · ${record.destination}`
}

export function statusLabel(status: TransferStatus): string {
  return {
    queued: "Queued",
    transferring: "Transferring",
    complete: "Complete",
    declined: "Declined",
    cancelled: "Cancelled",
    failed: "Failed",
  }[status]
}

export function totalBytes(files: ConsentFile[]): string {
  return formatBytes(files.reduce((sum, file) => sum + file.bytes, 0))
}

function copy(record: TransferRecord): TransferRecord {
  return { ...record, files: [...record.files], acceptedFiles: [...record.acceptedFiles], fileIds: [...record.fileIds] }
}
