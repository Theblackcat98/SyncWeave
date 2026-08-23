import { BoxRenderable } from "@opentui/core"
import { COLORS } from "../../theme"
import { addFooter } from "../components"
import type { UiContext } from "../context"
import { addModal } from "../modal"
import { qrBlock } from "../qr"

const STEP_ORDER = ["waiting", "authenticating", "connected"] as const

const STEP_LABELS: Record<(typeof STEP_ORDER)[number], string> = {
  waiting: "Waiting for peer…",
  authenticating: "Peer discovered — authenticating…",
  connected: "Connected — pairing complete!",
}

export function renderPairing(ctx: UiContext, root: BoxRenderable): void {
  const qr = qrBlock(42).map((line) => `    ${line}`)
  const step = ctx.pairing.step()
  const connected = step === "connected"
  addModal(ctx, root, "Peer Pairing · Scan with Camera or Termux", [
    "",
    ...qr,
    "",
    "    Code: 8492-AXQ1     Relay: Direct P2P",
    "    Auth: Ed25519 Ephemeral",
    `    ${STEP_LABELS[step]}`,
    "",
    "    [Esc] Cancel",
  ], connected ? COLORS.success : COLORS.remote)
  addFooter(ctx, root, "[Enter] Simulate Scan  [Esc] Cancel  [Ctrl+C] Exit")
}
