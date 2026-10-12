import { expect, test } from "bun:test"
import { formatBytes } from "../domain.js"
import { cardInnerWidth, buttonRows, chromeRows, contentWidth, paneBodyRows, viewportOf, visiblePaneRows, windowStart } from "../ui/layout.js"
import { truncate } from "../ui/primitives.js"
import { theme } from "../theme.js"

test("truncate counts display cells, not UTF-16 units (P2-9)", () => {
  const cjk = truncate("测试设备名称很长很长很长", 10)
  expect(Bun.stringWidth(cjk)).toBeLessThanOrEqual(10)
  expect(cjk.endsWith("…")).toBe(true)

  const emoji = truncate("a🎉bc", 3)
  expect(Bun.stringWidth(emoji)).toBeLessThanOrEqual(3)
  // No lone surrogate: every code point is complete.
  expect(emoji).toBe("a…")
  expect([...emoji].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff)).toBe(true)
})

test("truncate cuts at grapheme boundaries and leaves short text alone", () => {
  // A family emoji is one grapheme of width 2; it is kept whole or dropped.
  const family = "x👨‍👩‍👧‍👦y"
  const cut = truncate(family, 3)
  expect(Bun.stringWidth(cut)).toBeLessThanOrEqual(3)
  expect(cut.endsWith("…")).toBe(true)
  expect(truncate("short", 10)).toBe("short")
  expect(truncate("anything", 0)).toBe("")
  expect(Bun.stringWidth(truncate("abcdef", 1))).toBeLessThanOrEqual(1)
})

test("formatBytes picks the unit after rounding and covers TB and non-finite input (P2-11)", () => {
  expect(formatBytes(0)).toBe("0 B")
  expect(formatBytes(1023)).toBe("1023 B")
  expect(formatBytes(1024)).toBe("1 KB")
  expect(formatBytes(1536)).toBe("2 KB")
  expect(formatBytes(1048575)).toBe("1.0 MB")
  expect(formatBytes(1073741823)).toBe("1.0 GB")
  expect(formatBytes(1024 ** 4)).toBe("1.0 TB")
  expect(formatBytes(5 * 1024 ** 4)).toBe("5.0 TB")
  expect(formatBytes(NaN)).toBe("unknown")
  expect(formatBytes(Infinity)).toBe("unknown")
  expect(formatBytes(-5)).toBe("0 B")
})

test("text colors meet WCAG AA (4.5:1) on every surface they are drawn on (P2-15)", () => {
  const luminance = (hex: string): number => {
    const channel = (offset: number) => {
      const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  }
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi! + 0.05) / (lo! + 0.05)
  }
  const surfaces = [theme.color.background, theme.color.surface, theme.color.surfaceRaised]
  const textColors = {
    dim: theme.color.dim,
    muted: theme.color.muted,
    remote: theme.color.remote,
    focus: theme.color.focus,
    success: theme.color.success,
    warning: theme.color.warning,
    danger: theme.color.danger,
    disabled: theme.component.disabled,
    text: theme.color.text,
  }
  for (const [name, color] of Object.entries(textColors)) {
    for (const surface of surfaces) {
      expect(ratio(color, surface), `${name} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  }
  // Selected rows only carry the file text and the state colors (see renderPane and renderConsentFile).
  for (const color of [theme.color.white, theme.color.text, theme.color.muted, theme.color.success, theme.color.warning, theme.color.danger]) {
    expect(ratio(color, theme.color.selected), `${color} on selected row`).toBeGreaterThanOrEqual(4.5)
  }
})

test("one breakpoint helper decides the layout at each size (P2-17)", () => {
  expect(viewportOf(120, 36)).toMatchObject({ dual: true, compact: false, veryNarrow: false, tooSmall: false })
  expect(viewportOf(89, 36).dual).toBe(false)
  expect(viewportOf(57, 20).veryNarrow).toBe(true)
  expect(viewportOf(19, 20).tooSmall).toBe(true)
  expect(viewportOf(120, 14).compact).toBe(true)
  // Pane rows are bounded and reserve space for the path line and both hints.
  expect(visiblePaneRows(viewportOf(120, 30))).toBe(12)
  expect(visiblePaneRows(viewportOf(120, 14))).toBe(2)
  expect(visiblePaneRows(viewportOf(120, 200))).toBe(14)
  expect(paneBodyRows(viewportOf(120, 30))).toBeGreaterThan(visiblePaneRows(viewportOf(120, 30)))
  expect(chromeRows(viewportOf(72, 24)).note).toBe(1)
  expect(contentWidth(viewportOf(120, 24))).toBe(118)
  expect(cardInnerWidth(viewportOf(120, 24))).toBe(112)
})

test("button rows wrap by width and stack in very narrow layouts", () => {
  expect(buttonRows(["Accept all · A", "Decline · X"], 80, false)).toBe(1)
  expect(buttonRows(["Accept all · A", "Accept selected · Enter", "Decline · X"], 30, false)).toBeGreaterThan(1)
  expect(buttonRows(["a", "b", "c"], 80, true)).toBe(3)
})

test("windowStart keeps the selected index inside the window", () => {
  expect(windowStart(0, 9, 4, 10)).toBe(6)
  expect(windowStart(8, 2, 4, 10)).toBe(2)
  expect(windowStart(5, 5, 4, 10)).toBe(5)
  expect(windowStart(0, 0, 0, 0)).toBe(0)
})
