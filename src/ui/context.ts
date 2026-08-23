import type { CliRenderer } from "@opentui/core"
import type { AppState } from "../app-state"
import type { FilesystemService, PairingService, PeerService, TransferService } from "../types"

export interface UiContext {
  renderer: CliRenderer
  state: AppState
  filesystem: FilesystemService
  peers: PeerService
  pairing: PairingService
  transfers: TransferService
}
