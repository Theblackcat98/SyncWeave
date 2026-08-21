import { MOCK_DIFF } from "../domain/mock-data"
import type { DiffLine, MockFile, MockPeer, TransferJob } from "../domain/types"
import type { FilesystemService, PeerService, TransferService } from "../domain/services"

export class MockFilesystemService implements FilesystemService {
  constructor(
    private readonly local: MockFile[],
    private readonly remote: MockFile[],
  ) {}

  list(path: string): MockFile[] {
    return path.includes("MacBook") ? this.remote.map((file) => ({ ...file })) : this.local.map((file) => ({ ...file }))
  }

  getDiff(_fileId: string): DiffLine[] {
    return MOCK_DIFF.map((line) => ({ ...line }))
  }
}

export class MockPeerService implements PeerService {
  private pairing = false

  constructor(private readonly peers: MockPeer[]) {}

  listPeers(): MockPeer[] {
    return this.peers.map((peer) => ({ ...peer }))
  }

  async beginPairing(peerId: string): Promise<void> {
    if (!this.peers.some((peer) => peer.id === peerId)) throw new Error(`Unknown mock peer: ${peerId}`)
    this.pairing = true
  }

  cancelPairing(): void {
    this.pairing = false
  }

  isPairing(): boolean {
    return this.pairing
  }
}

export class MockTransferService implements TransferService {
  createJob(fileIds: string[], files: MockFile[]): TransferJob {
    const selected = files.filter((file) => fileIds.includes(file.id))
    const bytesTotal = selected.reduce((sum, file) => sum + file.bytes, 0)
    return {
      id: `transfer:mock:${fileIds.join(",")}`,
      fileIds,
      state: "transferring",
      progress: 0,
      bytesTotal,
      bytesTransferred: 0,
      speedMbps: 14.2,
      etaSeconds: Math.max(1, Math.ceil(bytesTotal / (14.2 * 1024 * 1024))),
    }
  }

  tick(job: TransferJob): TransferJob {
    const progress = Math.min(100, job.progress + 8)
    return {
      ...job,
      progress,
      bytesTransferred: Math.floor(job.bytesTotal * (progress / 100)),
      etaSeconds: Math.max(0, Math.ceil((100 - progress) / 18)),
      state: progress >= 100 ? "complete" : "transferring",
    }
  }

  cancel(job: TransferJob): TransferJob {
    return { ...job, state: "cancelled" }
  }
}
