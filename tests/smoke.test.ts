import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createApp, disposeApp, type UiContext } from "../src/app"

// @opentui/core ships no android-arm64 native asset, so renderer-backed
// smoke tests can only execute where the native library loads (CI/linux).
const NATIVE_RENDERER_SUPPORTED = process.platform !== "android"

const rendererTest = NATIVE_RENDERER_SUPPORTED ? test : test.skip

let setup: TestRendererSetup
let ctx: UiContext

async function waitForText(expected: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let frame = setup.captureCharFrame()

  while (!frame.includes(expected) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    await setup.renderOnce()
    frame = setup.captureCharFrame()
  }

  if (!frame.includes(expected)) {
    throw new Error(`Timed out waiting for ${JSON.stringify(expected)}.\n${frame}`)
  }
  return frame
}

beforeEach(async () => {
  if (!NATIVE_RENDERER_SUPPORTED) return
  setup = await createTestRenderer({ width: 100, height: 30 })
  ctx = createApp(setup.renderer)
  await setup.renderOnce()
})

afterEach(() => {
  if (!NATIVE_RENDERER_SUPPORTED) return
  disposeApp(ctx)
  setup.renderer.destroy()
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
    setup.mockInput.pressTab()
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Focused remote workspace")
  })

  rendererTest("space stages the focused file", async () => {
    setup.mockInput.pressKey(" ")
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Staged architecture-diagram.md")
    expect(frame).toContain("1 staged • 12 KB")
  })
})

describe("mock transfer workflow", () => {
  rendererTest("sync without staging shows a hint", async () => {
    setup.mockInput.pressKey("s")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Nothing staged — press Space on a file first")
  })

  rendererTest("staged files transfer and become synced", async () => {
    setup.mockInput.pressKey(" ")
    setup.mockInput.pressKey("s")
    let frame = await waitForText("Transfer complete")
    expect(frame).toContain("Transfer complete")
    expect(frame).toContain("[Enter] Return to Workspace")

    setup.mockInput.pressEnter()
    await setup.renderOnce()
    frame = setup.captureCharFrame()
    expect(frame).toContain("Sync complete — all staged changes are synchronized")
    expect(frame).toContain("• 󰈙 architecture-diagram.md")
  })

  rendererTest("escape cancels an in-flight transfer", async () => {
    setup.mockInput.pressKey(" ")
    setup.mockInput.pressKey("s")
    await setup.renderOnce()
    setup.mockInput.pressEscape()
    const frame = await waitForText("Mock transfer cancelled")
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
    await waitForText("pairing complete")
    expect(setup.captureCharFrame()).toContain("Connected — pairing complete!")
  })

  rendererTest("escape cancels pairing", async () => {
    setup.mockInput.pressKey("q")
    await setup.renderOnce()
    setup.mockInput.pressEscape()
    const frame = await waitForText("Pairing cancelled")
    expect(frame).toContain("Pairing cancelled")
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
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressKey("d")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("No divergence to inspect: daily-todo.txt")
  })
})
