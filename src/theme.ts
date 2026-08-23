import type { SyncState } from "./types"

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
} as const

export const SPACING = {
  rootPadding: 1,
  modalPadding: 2,
  sectionGap: 1,
} as const

export const SIZING = {
  headerHeight: 3,
  footerHeight: 2,
  activityHeight: 3,
  activityGaugeWidth: 28,
  transferGaugeWidth: 34,
  fileNameColumnWidth: 28,
  fileSizeColumnWidth: 7,
} as const

const STATE_GLYPHS: Record<SyncState, string> = {
  synced: "•",
  added: "+",
  modified: "~",
  deleted: "-",
}

const STATE_COLORS: Record<SyncState, string> = {
  synced: COLORS.muted,
  added: COLORS.success,
  modified: COLORS.warning,
  deleted: COLORS.danger,
}

export function stateGlyph(state: SyncState): string {
  return STATE_GLYPHS[state]
}

export function stateColor(state: SyncState): string {
  return STATE_COLORS[state]
}
