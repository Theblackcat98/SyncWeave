export const COLORS = {
  background: "#12131C",
  surface: "#1E1E2E",
  selected: "#263244",
  border: "#64748B",
  focus: "#38BDF8",
  remote: "#A855F7",
  success: "#4ADE80",
  warning: "#FBBF24",
  danger: "#F87171",
  muted: "#94A3B8",
  text: "#E2E8F0",
  disabled: "#475569",
  overlay: "#0F1118",
} as const

export const SPACING = {
  none: 0,
  xs: 1,
  sm: 1,
  md: 2,
  lg: 3,
} as const

export const BORDERS = {
  panel: true,
  modal: true,
  focus: COLORS.focus,
  neutral: COLORS.border,
} as const

export const DIMENSIONS = {
  headerHeight: 3,
  footerHeight: 2,
  activityHeight: 3,
  wideBreakpoint: 90,
} as const

export const ICONS = {
  file: "󰈙",
  directory: "󰒓",
  archive: "󰡨",
  fallback: "[F]",
  directoryFallback: "[D]",
  archiveFallback: "[A]",
} as const

export const STATE_GLYPHS = {
  synced: "•",
  added: "+",
  modified: "~",
  deleted: "-",
  conflict: "!",
} as const

export function iconFor(kind: "file" | "directory", name: string): string {
  const lower = name.toLowerCase()
  if (kind === "directory") return ICONS.directory
  if (lower.endsWith(".tar.gz") || lower.endsWith(".zip") || lower.endsWith(".tgz")) return ICONS.archive
  return ICONS.file
}

export function fallbackIconFor(kind: "file" | "directory"): string {
  return kind === "directory" ? ICONS.directoryFallback : ICONS.fallback
}

export function stateColor(state: keyof typeof STATE_GLYPHS): string {
  return {
    synced: COLORS.muted,
    added: COLORS.success,
    modified: COLORS.warning,
    deleted: COLORS.danger,
    conflict: COLORS.danger,
  }[state]
}

export function stateGlyph(state: keyof typeof STATE_GLYPHS): string {
  return STATE_GLYPHS[state]
}
