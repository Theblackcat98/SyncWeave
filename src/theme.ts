export const theme = {
  color: {
    background: "#12131C",
    surface: "#1E1E2E",
    surfaceRaised: "#25263A",
    selected: "#263244",
    focus: "#38BDF8",
    remote: "#B98BFF",
    success: "#4ADE80",
    warning: "#FBBF24",
    danger: "#F87171",
    muted: "#94A3B8",
    // Was #64748B (3.45:1 on surface). #8A97AD is 5.55:1 on surface (WCAG AA).
    dim: "#8A97AD",
    text: "#E2E8F0",
    white: "#F8FAFC",
  },
  typography: {
    brand: "#38BDF8",
    heading: "#F8FAFC",
  },
  border: {
    subtle: "#64748B",
    localFocus: "#38BDF8",
    remoteFocus: "#B98BFF",
  },
  component: {
    // Shares dim's hex: both are secondary text on the same surfaces.
    disabled: "#8A97AD",
    active: "#38BDF8",
  },
  layout: {
    minWidth: 20,
    veryNarrowWidth: 58,
    dualPaneMinWidth: 90,
    compactHeight: 14,
  },
} as const

export const motion = {
  transferTickMs: 120,
  discoveryTickMs: 850,
  focusTickMs: 48,
  revealTickMs: 32,
  transferStep: 5,
  discovery: ["◦", "◔", "◑", "◕"] as const,
  focusGlow: ["#64748B", "#0EA5E9", "#38BDF8"] as const,
  revealFrames: ["·", "∙", "●"] as const,
}

export interface IconSet {
  file: string
  directory: string
  archive: string
  check: string
  added: string
  modified: string
  deleted: string
  synced: string
  /** Right arrow. */
  arrow: string
  up: string
  down: string
  left: string
  mark: string
  dot: string
  ellipsis: string
  dash: string
  pointer: string
  angleLeft: string
  angleRight: string
  online: string
  offline: string
  cursor: string
  block: string
  spinner: readonly string[]
  discoveryFrames: readonly string[]
  revealFrames: readonly string[]
  gaugeFull: string
  gaugeEmpty: string
  /** Partial cells, indexed by eighths (0 to 7). */
  gaugeEighths: readonly string[]
}

export function createIcons(asciiMode: boolean): IconSet {
  return {
    file: asciiMode ? "[F]" : "󰈙",
    directory: asciiMode ? "[D]" : "󰉋",
    archive: asciiMode ? "[A]" : "󰡨",
    check: asciiMode ? "[x]" : "✓",
    added: asciiMode ? "+" : "✦",
    modified: asciiMode ? "~" : "✳",
    deleted: asciiMode ? "-" : "−",
    synced: asciiMode ? "=" : "•",
    arrow: asciiMode ? "->" : "→",
    up: asciiMode ? "^" : "↑",
    down: asciiMode ? "v" : "↓",
    left: asciiMode ? "<-" : "←",
    mark: asciiMode ? "*" : "◆",
    dot: asciiMode ? "|" : "·",
    ellipsis: asciiMode ? "..." : "…",
    dash: asciiMode ? "-" : "—",
    pointer: asciiMode ? ">" : "▸",
    angleLeft: asciiMode ? "<" : "‹",
    angleRight: asciiMode ? ">" : "›",
    online: asciiMode ? "*" : "●",
    offline: asciiMode ? "o" : "○",
    cursor: asciiMode ? "_" : "▌",
    block: asciiMode ? "##" : "██",
    spinner: asciiMode ? ["|", "/", "-", "\\"] : ["◐", "◓", "◑", "◒"],
    discoveryFrames: asciiMode ? [".", "o", "O", "o"] : motion.discovery,
    revealFrames: asciiMode ? [".", "o", "O"] : motion.revealFrames,
    gaugeFull: asciiMode ? "#" : "⣿",
    gaugeEmpty: asciiMode ? "-" : "⣀",
    gaugeEighths: asciiMode ? ["", "=", "=", "=", "=", "=", "=", "="] : ["", "⡀", "⡄", "⡆", "⡇", "⣇", "⣧", "⣷"],
  }
}

const asciiMode = process.env.SYNCWEAVE_ASCII === "1" || process.env.TERM === "dumb"
export const icons: IconSet = createIcons(asciiMode)

/** Swaps every glyph in place (tests and runtime switches). Module consumers keep their reference. */
export function setAsciiIcons(enabled: boolean): void {
  Object.assign(icons, createIcons(enabled))
}
