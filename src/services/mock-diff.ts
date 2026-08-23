import type { DiffRow } from "../types"

export const DIFF_FILE_NAME = "architecture-diagram.md"

export function mockDiffRows(): DiffRow[] {
  return [
    { label: "  01", left: "# SyncWeave Architecture", right: "# SyncWeave Architecture" },
    { label: "  02", left: "", right: "" },
    { label: "  03", left: "## Transport", right: "## Transport" },
    { label: "- 04", left: "- WebSocket fallback", right: "" },
    { label: "+ 04", left: "", right: "+ QUIC primary transport" },
    { label: "  05", left: "- Chunked streams", right: "- Chunked streams" },
    { label: "- 06", left: "- Retry: 3", right: "" },
    { label: "+ 06", left: "", right: "+ Retry: adaptive" },
    { label: "  07", left: "", right: "" },
    { label: "  08", left: "## State", right: "## State" },
    { label: "  09", left: "Preview before sync", right: "Preview before sync" },
  ]
}
