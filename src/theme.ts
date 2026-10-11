export const theme = {
  color: {
    background: "#12131C",
    surface: "#1E1E2E",
    surfaceRaised: "#25263A",
    selected: "#263244",
    focus: "#38BDF8",
    remote: "#A855F7",
    success: "#4ADE80",
    warning: "#FBBF24",
    danger: "#F87171",
    muted: "#94A3B8",
    dim: "#64748B",
    text: "#E2E8F0",
    white: "#F8FAFC",
  },
  typography: {
    brand: "#38BDF8",
    heading: "#F8FAFC",
    body: "#E2E8F0",
    supporting: "#94A3B8",
    caption: "#64748B",
  },
  border: {
    subtle: "#64748B",
    localFocus: "#38BDF8",
    remoteFocus: "#A855F7",
    selection: "#263244",
  },
  component: {
    disabled: "#64748B",
    inactive: "#94A3B8",
    active: "#38BDF8",
  },
  spacing: { compact: 1, panel: 1, modal: 2, section: 1 },
  layout: { dualPaneMinWidth: 90, veryNarrowWidth: 58, compactHeight: 14 },
} as const

export const motion = {
  transferTickMs: 120,
  discoveryTickMs: 850,
  focusTickMs: 48,
  revealTickMs: 32,
  transferStep: 5,
  spinner: ["◐", "◓", "◑", "◒"] as const,
  discovery: ["◦", "◔", "◑", "◕"] as const,
  focusGlow: ["#64748B", "#0EA5E9", "#38BDF8"] as const,
  revealFrames: ["·", "∙", "●"] as const,
}

export function createIcons(asciiMode: boolean) {
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
    divider: asciiMode ? "-" : "─",
    pulse: asciiMode ? "*" : "◌",
  } as const
}

const asciiMode = process.env.SYNCWEAVE_ASCII === "1" || process.env.TERM === "dumb"
export const icons = createIcons(asciiMode)
