import type {
  ConsentFile,
  ConsentMode,
  ConsentRequest,
  FavoriteDestination,
  MockEntry,
  MockPeer,
  Pane,
  TransferRecord,
} from "../domain.js"

export interface FileSystemService {
  readonly paths: Record<Pane, string>
  list(pane: Pane, path: string): MockEntry[]
  parentPath(path: string): string
  markSynced(pane: Pane, ids: string[]): void
  getDiff(id: string): string[]
  /** Total entries before truncation (real fs only); undefined if unknown. */
  listTotal?(pane: Pane, path: string): number | undefined
  /** Last list() error for this path (real fs only); null if none. */
  listError?(pane: Pane, path: string): string | null
}

export interface PeerService {
  discover(): MockPeer[]
  pulse(): MockPeer[]
  favorites(): FavoriteDestination[]
  toggleFavorite(peer: MockPeer): boolean
}

export interface TransferService {
  createRequest(
    mode: ConsentMode,
    peer: MockPeer,
    files: Array<Pick<ConsentFile, "id" | "name" | "bytes">>,
    sourcePane?: Pane,
  ): ConsentRequest
  acceptRequest(request: ConsentRequest, destination: string, accepted: ConsentFile[]): TransferRecord
  declineRequest(request: ConsentRequest): TransferRecord
  queue(): TransferRecord[]
  progress(id: string, step: number): TransferRecord | undefined
  finish(id: string): TransferRecord | undefined
  cancel(id: string): TransferRecord | undefined
  fail(id: string, message: string): TransferRecord | undefined
  retry(id: string): TransferRecord | undefined
}
