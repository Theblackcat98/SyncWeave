/**
 * Null service implementations for real mode. The mock services
 * (MockPeerService, MockTransferService) simulate network behavior; in real
 * mode they must not be constructed at all — their simulated peers, queue
 * entries, and favorites would be lies. These nulls implement the same
 * interfaces with truthful empty behavior; real transfers feed
 * state.transferQueue directly (see app.ts).
 */
import type { ConsentFile, ConsentMode, ConsentRequest, FavoriteDestination, MockPeer, Pane, TransferRecord } from "../domain.js"
import type { PeerService, TransferService } from "./ports.js"

export class NullPeerService implements PeerService {
  discover(): MockPeer[] {
    return []
  }
  pulse(): MockPeer[] {
    return []
  }
  favorites(): FavoriteDestination[] {
    return []
  }
  toggleFavorite(_peer: MockPeer): boolean {
    return false
  }
}

export class NullTransferService implements TransferService {
  createRequest(
    _mode: ConsentMode,
    _peer: MockPeer,
    _files: Array<Pick<ConsentFile, "id" | "name" | "bytes">>,
    _sourcePane?: Pane,
  ): ConsentRequest {
    throw new Error("NullTransferService: mock transfer requests are not available in real mode")
  }
  acceptRequest(_request: ConsentRequest, _destination: string, _accepted: ConsentFile[]): TransferRecord {
    throw new Error("NullTransferService: mock transfer acceptance is not available in real mode")
  }
  declineRequest(_request: ConsentRequest): TransferRecord {
    throw new Error("NullTransferService: mock transfer decline is not available in real mode")
  }
  queue(): TransferRecord[] {
    return []
  }
  progress(_id: string, _step: number): TransferRecord | undefined {
    return undefined
  }
  finish(_id: string): TransferRecord | undefined {
    return undefined
  }
  cancel(_id: string): TransferRecord | undefined {
    return undefined
  }
  retry(_id: string): TransferRecord | undefined {
    return undefined
  }
  fail(_id: string, _reason: string): TransferRecord | undefined {
    return undefined
  }
}
