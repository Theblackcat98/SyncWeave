import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createApp, disposeApp, type UiContext } from "../src/app"

// @opentui/core ships no android-arm64 native asset, so renderer-backed
// smoke tests can only execute where the native library loads (CI/linux).
const NATIVE_RENDERER_SUPPORTED = process.platform !== "android"

const rendererTest = NATIVE_RENDERER_SUPPORTED ? test : test.skip

let setup: TestRendererSetup
let ctx: UiContext

beforeEach(async () => {
  if (!NATIVE_RENDERER_SUPPORTED) return
  setup = await createTestRenderer({ width: 100, height: 30 })
  ctx = createApp(setup.renderer)
  await setup.renderOnce()
})

afterEach(() => {
  if (!NATIVE_RENDERER_SUPPORTED) return
  disposeApp(ctx)
})

describe("workspace shell", () => {
  rendererTest("renders header and both panes", () => {
    const frame = setup.captureCharFrame()
    expect(frame).toContain("SyncWeave")
    expect(frame).toContain("LOCAL WORKSPACE")
    expect(frame).toContain("REMOTE STAGING")
    expect(frame).toContain("architecture-diagram.md")
    expect(frame).toContain("Peers: 2 Online")
  })

  rendererTest("tab switches focused pane", async () => {
    setup.mockInput.pressKey("tab")
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Focused remote workspace")
  })

  rendererTest("space stages the focused file", async () => {
    setup.mockInput.pressKey("space")
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Staged architecture-diagram.md")
    expect(frame).toContain("1 staged • 12.0 KB")
  })
})

describe("mock transfer workflow", () => {
  rendererTest("sync without staging shows a hint", async () => {
    setup.mockInput.pressKey("s")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Nothing staged — press Space on a file first")
  })

  rendererTest("staged files transfer and become synced", async () => {
    setup.mockInput.pressKey("space")
    setup.mockInput.pressKey("s")
    await setup.waitFor(() => setup.captureCharFrame().includes("Transfer complete"), { maxPasses: 200 })
    let frame = setup.captureCharFrame()
    expect(frame).toContain("Transfer complete")
    expect(frame).toContain("[Enter] Return to Workspace")

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).toContain("Sync complete — all staged changes are synchronized")
    expect(frame).toContain("• 󰈙 architecture-diagram.md")
  })

  rendererTest("escape cancels an in-flight transfer", async () => {
    setup.mockInput.pressKey("space")
    setup.mockInput.pressKey("s")
    await setup.renderOnce()
    setup.mockInput.pressEscape()
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Mock transfer cancelled")
    expect(frame).toContain("LOCAL WORKSPACE")
  })
})

describe("pairing screen", () => {
  rendererTest("q opens pairing modal with QR mock", async () => {
    setup.mockInput.pressKey("q")
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Peer Pairing")
    expect(frame).toContain("8492-AXQ1")
    expect(frame).toContain("Waiting for peer…")
  })

  rendererTest("pairing progresses to connected", async () => {
    setup.mockInput.pressKey("q")
    await setup.waitFor(() => setup.captureCharFrame().includes("pairing complete"), { maxPasses: 100 })
    expect(setup.captureCharFrame()).toContain("Connected — pairing complete!")
  })

  rendererTest("escape cancels pairing", async () => {
    setup.mockInput.pressKey("q")
    await setup.renderOnce()
    setup.mockInput.pressEscape()
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Pairing cancelled")
  })
})

describe("diff inspector", () => {
  rendererTest("d opens diff for modified file", async () => {
    setup.mockInput.pressKey("d")
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Diff Inspector · architecture-diagram.md")
    expect(frame).toContain("- WebSocket fallback")
    expect(frame).toContain("+ QUIC primary transport")
  })

  rendererTest("d is rejected for synced files", async () => {
    setup.mockInput.pressKey("down")
    setup.mockInput.pressKey("d")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("No divergence to inspect: daily-todo.txt")
  })
})
