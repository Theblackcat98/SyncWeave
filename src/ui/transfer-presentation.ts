import type { ConsentFile, TransferStatus } from "../domain.js"
import { formatBytes } from "../domain.js"

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
