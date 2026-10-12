import { theme } from "../theme.js"

/**
 * The one place that turns a terminal size into layout decisions (P2-17).
 * Render code and the app's cursor/scroll bookkeeping both read from here.
 */
export interface Viewport {
  width: number
  height: number
  /** Header, toolbar, activity and footer shrink to one row each. */
  compact: boolean
  /** Two panes side by side. Below this width the workspace shows one pane. */
  dual: boolean
  /** Column layouts: stacked header, stacked buttons, no root side padding. */
  veryNarrow: boolean
  /** Below the minimum width only a "terminal too small" message is drawn. */
  tooSmall: boolean
}

export function viewportOf(width: number, height: number): Viewport {
  const { minWidth, dualPaneMinWidth, veryNarrowWidth, compactHeight } = theme.layout
  return {
    width,
    height,
    compact: height <= compactHeight,
    dual: width >= dualPaneMinWidth,
    veryNarrow: width < veryNarrowWidth,
    tooSmall: width < minWidth,
  }
}

/** Rows used by each fixed chrome region of the screen. */
export function chromeRows(vp: Viewport): { header: number; toolbar: number; activity: number; footer: number; note: number } {
  return {
    header: vp.veryNarrow ? 4 : vp.compact ? 1 : 3,
    toolbar: vp.veryNarrow ? 3 : vp.compact ? 1 : 2,
    // Short terminals drop the activity panel so the pane keeps its cursor row.
    activity: vp.compact ? 1 : vp.height < 20 ? 0 : 4,
    footer: vp.compact ? 1 : 3,
    // The narrow layout prints one note line under the single pane.
    note: !vp.dual && !vp.compact ? 1 : 0,
  }
}

/** Top padding inside pane boxes (zero on short terminals). */
export function paneTopPadding(vp: Viewport): number {
  return vp.compact || vp.height <= 26 ? 0 : 1
}

/** Rows inside a workspace pane's border and padding, before the path line. */
export function paneBodyRows(vp: Viewport): number {
  const chrome = chromeRows(vp)
  const box = vp.height - chrome.header - chrome.toolbar - chrome.activity - chrome.footer - chrome.note
  return Math.max(0, box - 2 - paneTopPadding(vp))
}

/**
 * Entry rows drawn in a local pane. Reserves the path line and both scroll
 * hints, so the cursor row is always inside the pane (P2-7).
 */
export function visiblePaneRows(vp: Viewport): number {
  if (vp.compact) return 2
  return Math.max(2, Math.min(14, paneBodyRows(vp) - 1 - 2))
}

/** Usable width inside the root layout (after root side padding). */
export function contentWidth(vp: Viewport): number {
  return vp.width - (vp.veryNarrow ? 0 : 2)
}

/** Usable text width inside a page card (border 2, padding 4). */
export function cardInnerWidth(vp: Viewport): number {
  return Math.max(8, contentWidth(vp) - 6)
}

/** Rows available for a page card's content (header and footer are fixed). */
export function cardContentRows(vp: Viewport): number {
  const chrome = chromeRows(vp)
  return Math.max(1, vp.height - chrome.header - chrome.footer - 4)
}

/**
 * Usable text width inside the header (border and padding removed). One cell
 * is held back so that a full row never overruns the right border.
 */
export function headerInnerWidth(vp: Viewport): number {
  if (vp.veryNarrow) return vp.width - 4
  if (vp.compact) return vp.width - 3
  return vp.width - 5
}

/** Rows a row of buttons takes once it wraps. Stacked layouts use one row per button. */
export function buttonRows(captions: readonly string[], inner: number, stacked: boolean): number {
  if (stacked) return Math.max(1, captions.length)
  let rows = 1
  let used = 0
  for (const caption of captions) {
    // Caption, padding 1+1, margin 1 and the flex gap 1.
    const itemWidth = Bun.stringWidth(caption) + 4
    if (used > 0 && used + itemWidth - 1 > inner) {
      rows += 1
      used = 0
    }
    used += itemWidth
  }
  return rows
}

/** Clamp a window start so the selected index stays inside [start, start + size). */
export function windowStart(current: number, selected: number, size: number, total: number): number {
  let start = Math.min(current, Math.max(0, total - size))
  if (selected < start) start = selected
  if (selected >= start + size) start = selected - size + 1
  return Math.max(0, Math.min(start, Math.max(0, total - size)))
}
