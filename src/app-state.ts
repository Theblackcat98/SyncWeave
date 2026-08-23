import type { Pane, Screen } from "./types"

export const DEFAULT_STATUS = "Ready — select files to stage a mock transfer"

export class AppState {
  activePane: Pane = "local"
  localCursor = 0
  remoteCursor = 0
  screen: Screen = "workspace"
  status: string = DEFAULT_STATUS
}
