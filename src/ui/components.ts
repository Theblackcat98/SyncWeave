import { BoxRenderable, TextRenderable, type BoxOptions, type CliRenderer } from "@opentui/core"
import { COLORS, SIZING } from "../theme"
import type { UiContext } from "./context"

export function text(renderer: CliRenderer, content: string, fg: string, id: string): TextRenderable {
  return new TextRenderable(renderer, { id, content, fg })
}

export function box(renderer: CliRenderer, props: BoxOptions & { id: string }): BoxRenderable {
  return new BoxRenderable(renderer, props)
}

export function addHeader(ctx: UiContext, root: BoxRenderable): void {
  const header = box(ctx.renderer, {
    id: "header",
    height: SIZING.headerHeight,
    flexDirection: "row",
    border: true,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    paddingLeft: 1,
    paddingRight: 1,
  })
  header.add(text(ctx.renderer, "SyncWeave", COLORS.focus, "brand"))
  header.add(text(ctx.renderer, "  v0.1.0", COLORS.muted, "version"))
  header.add(text(ctx.renderer, "                         ", COLORS.text, "header-space"))
  header.add(text(ctx.renderer, "● mDNS: Active", COLORS.success, "mdns"))
  header.add(text(ctx.renderer, `  • Peers: ${ctx.peers.onlineCount()} Online`, COLORS.remote, "peers"))
  root.add(header)
}

export function addFooter(ctx: UiContext, root: BoxRenderable, content: string): void {
  const footer = box(ctx.renderer, {
    id: "footer",
    height: SIZING.footerHeight,
    flexDirection: "row",
    marginTop: 1,
  })
  footer.add(text(ctx.renderer, content, COLORS.text, "footer-actions"))
  root.add(footer)
}
