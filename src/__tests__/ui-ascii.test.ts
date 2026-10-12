import { afterEach, beforeEach, expect, test } from "bun:test"
import { setAsciiIcons } from "../theme.js"
import { consentRequest, frameText, mountUi, unmountAll } from "./ui-harness.js"

const BOX_DRAWING = new Set([..."┌┐└┘│─├┤┬┴┼"])

beforeEach(() => setAsciiIcons(true))
afterEach(async () => {
  await unmountAll()
  setAsciiIcons(false)
})

function nonAsciiGlyphs(text: string): string[] {
  const found = new Set<string>()
  for (const ch of text) {
    if (ch === "\n" || ch === " ") continue
    if (ch.charCodeAt(0) < 128 || BOX_DRAWING.has(ch)) continue
    found.add(ch)
  }
  return [...found]
}

test("ASCII mode draws no decorative glyphs on the workspace, consent, send review, queue or help screens (P2-16)", async () => {
  const screens = ["workspace", "consent", "send-review", "queue", "help"] as const
  for (const screen of screens) {
    const { setup, app } = await mountUi({ width: 120, height: 36, mode: "real", peers: [{ peerId: "z1", alias: "lab", address: "10.0.0.2", tcpPort: 24816 }] })
    if (screen === "consent") app.state.request = consentRequest()
    if (screen === "send-review") app.state.sendSasConfirm = { sas: "ABCD-1234", peerFingerprint: "zAAA", peerName: "lab" }
    app.state.status = "Connecting to lab… (10.0.0.2:24816)"
    app.state.screen = screen
    app.render()
    await setup.flush()
    expect(nonAsciiGlyphs(frameText(setup)), screen).toEqual([])
    await unmountAll()
    setAsciiIcons(true)
  }
})

test("ASCII mode uses ASCII markers for selection, state and separators", async () => {
  const { setup, app } = await mountUi({ width: 120, height: 36, mode: "mock" })
  app.render()
  await setup.flush()
  const text = frameText(setup)
  expect(text).toContain("[F]")
  expect(text).toContain("[D]")
  expect(text).toContain(" | ")
  expect(text).not.toContain("·")
})

test("ASCII mode truncates with three dots, not a unicode ellipsis", async () => {
  const { setup, app } = await mountUi({ width: 58, height: 24, mode: "real" })
  app.state.request = consentRequest({
    peer: { id: "zAAA", name: "a-very-long-alias-that-cannot-fit-on-one-consent-line", host: "10.0.0.2", port: 24816, fingerprint: "zAAA", online: true },
  })
  app.state.screen = "consent"
  app.render()
  await setup.flush()
  const text = frameText(setup)
  expect(text).toContain("...")
  expect(text).not.toContain("…")
})
