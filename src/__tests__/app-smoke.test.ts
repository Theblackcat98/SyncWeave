import { afterEach, expect, test } from "bun:test"
import { BoxRenderable, type KeyEvent } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createSyncWeaveApp, type AppDependencies, type SyncWeaveApp } from "../app.js"
import { MockFileSystemService } from "../services/mock-filesystem.js"

process.env.SYNCWEAVE_REDUCED_MOTION = "1"

const open: Array<{ setup: TestRendererSetup; app: SyncWeaveApp }> = []

async function mount(width = 120, height = 36, dependencies: AppDependencies = {}) {
  const setup = await createTestRenderer({ width, height })
  const app = createSyncWeaveApp(setup.renderer, dependencies)
  open.push({ setup, app })
  await setup.flush()
  return { setup, app }
}

async function pressEscape(setup: TestRendererSetup): Promise<void> {
  await setup.mockInput.pressKeys(["ESCAPE"], 50)
  await setup.flush()
}

afterEach(async () => {
  for (const { app, setup } of open.splice(0)) {
    app.dispose()
    await setup.renderer.destroy()
  }
})

test("starts in a polished dual-pane workspace and collapses cleanly on narrow terminals", async () => {
  const { setup, app } = await mount()
  const desktop = setup.captureCharFrame()
  expect(desktop).toContain("SyncWeave")
  expect(desktop).toContain("LOCAL SOURCE")
  expect(desktop).toContain("REMOTE DESTINATION")
  expect(desktop).toContain("SIMULATION")
  expect(desktop).toContain("architecture-diagram.md")

  setup.resize(72, 24)
  app.render()
  await setup.flush()
  const narrow = setup.captureCharFrame()
  expect(narrow).toContain("1 Local")
  expect(narrow).toContain("2 Remote")
  expect(narrow).toContain("LOCAL SOURCE")
  expect(narrow).not.toContain("REMOTE DESTINATION")
  expect(app.state.activePane).toBe("local")
})

test("very narrow portrait layout keeps the activity status and legend on separate readable rows", async () => {
  const { setup } = await mount(44, 32)
  const frame = setup.captureCharFrame()
  expect(frame).toContain("WORKSPACE")
  expect(frame).toContain("Send")
  expect(frame).toContain("Ready")
  expect(frame).toContain("sync  ✦ add  ✳ edit")
  expect(frame).not.toContain("addedin✳")
})

test("staging and review never stream before a per-transfer consent decision", async () => {
  const { setup, app } = await mount()
  setup.mockInput.pressKey(" ")
  await setup.flush()
  expect(app.state.staged.local.has("architecture")).toBe(true)

  setup.mockInput.pressKey("s")
  await setup.flush()
  expect(app.state.screen).toBe("send-review")
  setup.mockInput.pressEnter()
  await setup.flush()
  expect(app.state.screen).toBe("consent")
  expect(app.state.transferQueue).toHaveLength(0)
  expect(app.state.request?.mode).toBe("outgoing")
  expect(app.state.request?.files).toHaveLength(1)

  setup.mockInput.pressKey(" ")
  await setup.flush()
  setup.mockInput.pressEnter()
  await setup.flush()
  expect(app.state.screen).toBe("consent")
  expect(app.state.transferQueue).toHaveLength(0)
  expect(app.state.status).toContain("Choose one or more files")

  setup.mockInput.pressKey("x")
  await setup.flush()
  expect(app.state.screen).toBe("workspace")
  expect(app.state.transferQueue[0]?.status).toBe("declined")
})

test("accepts an incoming subset, records simulated failure, and retries without network access", async () => {
  const { setup, app } = await mount()
  setup.mockInput.pressKey("i")
  await setup.flush()
  expect(app.state.request?.mode).toBe("incoming")
  expect(app.state.request?.files).toHaveLength(3)

  setup.mockInput.pressKey(" ")
  await setup.flush()
  setup.mockInput.pressEnter()
  await setup.flush()
  expect(app.state.screen).toBe("transfer")
  expect(app.state.transferQueue[0]?.acceptedFiles).toHaveLength(2)
  expect(app.state.transferQueue[0]?.status).toBe("queued")
  expect(app.state.transferQueue[0]?.progress).toBe(0)
  await Bun.sleep(360)
  expect(app.state.transferQueue[0]?.progress).toBeGreaterThan(0)

  setup.mockInput.pressKey("e")
  await setup.flush()
  expect(app.state.transferQueue[0]?.status).toBe("failed")
  expect(app.state.transferQueue[0]?.error).toContain("no network was contacted")

  setup.mockInput.pressKey("r")
  await setup.flush()
  expect(app.state.screen).toBe("transfer")
  expect(app.state.transferQueue[0]?.status).toBe("queued")
  expect(app.state.transferQueue[0]?.id).not.toBe(app.state.transferQueue[1]?.id)

  await pressEscape(setup)
  expect(app.state.transferQueue[0]?.status).toBe("cancelled")
})

test("mouse action buttons work and manual identity language does not claim trust", async () => {
  const { setup, app } = await mount()
  const stage = setup.renderer.root.findDescendantById("toolbar-stage") as BoxRenderable | undefined
  expect(stage).toBeDefined()
  await setup.mockMouse.click(stage!.x + 1, stage!.y)
  await setup.flush()
  expect(app.state.staged.local.has("architecture")).toBe(true)

  const todo = setup.renderer.root.findDescendantById("local-entry-todo") as BoxRenderable | undefined
  expect(todo).toBeDefined()
  await setup.mockMouse.click(todo!.x + 1, todo!.y)
  await setup.flush()
  expect(app.state.cursors.local).toBe(1)
  const receive = setup.renderer.root.findDescendantById("toolbar-receive") as BoxRenderable | undefined
  expect(receive).toBeDefined()
  await setup.mockMouse.click(receive!.x + 1, receive!.y)
  await setup.flush()
  expect(app.state.screen).toBe("consent")
  const acceptAll = setup.renderer.root.findDescendantById("accept-all") as BoxRenderable | undefined
  expect(acceptAll).toBeDefined()
  await setup.mockMouse.click(acceptAll!.x + 1, acceptAll!.y)
  await setup.flush()
  expect(app.state.screen).toBe("transfer")

  await pressEscape(setup)
  setup.mockInput.pressKey("q")
  await setup.flush()
  expect(app.state.screen).toBe("peer")
  setup.mockInput.pressKey("e")
  await setup.flush()
  expect(app.state.identityStep).toBe(3)
  expect(setup.captureCharFrame()).toContain("no connection was created")
  setup.mockInput.pressKey("r")
  await setup.flush()
  expect(app.state.identityStep).toBe(0)
  setup.mockInput.pressKey("v")
  await setup.flush()
  expect(app.state.status).toContain("no verified state was saved")
  expect(setup.captureCharFrame()).toContain("no verified state was saved")

  setup.mockInput.pressKey("f")
  await setup.flush()
  setup.mockInput.pressKey("p")
  await setup.flush()
  expect(app.state.screen).toBe("favorites")
  expect(setup.captureCharFrame()).toContain("not a pairing, verification, or auto-accept rule")
})

test("narrow mouse tabs switch active panes without losing selection", async () => {
  const { setup, app } = await mount(72, 24)
  setup.mockInput.pressKey(" ")
  await setup.flush()
  expect(app.state.staged.local.has("architecture")).toBe(true)

  const remoteTab = setup.renderer.root.findDescendantById("tab-remote") as BoxRenderable | undefined
  expect(remoteTab).toBeDefined()
  await setup.mockMouse.click(remoteTab!.x + 1, remoteTab!.y)
  await setup.flush()
  expect(app.state.activePane).toBe("remote")
  const localTab = setup.renderer.root.findDescendantById("tab-local") as BoxRenderable | undefined
  expect(localTab).toBeDefined()
  await setup.mockMouse.click(localTab!.x + 1, localTab!.y)
  await setup.flush()
  expect(app.state.activePane).toBe("local")
  expect(app.state.staged.local.has("architecture")).toBe(true)
})

test("keyboard navigation browses mock directories and preserves cursor/scroll position", async () => {
  const { setup, app } = await mount(72, 24)
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressArrow("down")
  await setup.flush()
  setup.mockInput.pressEnter()
  await setup.flush()
  expect(app.state.paths.local).toBe("~/projects/notes/configs")
  expect(setup.captureCharFrame()).toContain("settings.json")

  setup.mockInput.pressBackspace()
  await setup.flush()
  expect(app.state.paths.local).toBe("~/projects/notes")
  setup.mockInput.pressBackspace()
  await setup.flush()
  expect(app.state.paths.local).toBe("~/projects/notes")

  for (let index = 0; index < 10; index += 1) setup.mockInput.pressArrow("down")
  await setup.flush()
  expect(app.state.scrollOffsets.local).toBeGreaterThan(0)
  expect(app.state.cursors.local).toBeGreaterThan(0)
})

test("an explicitly accepted outgoing transfer completes and updates the mock source state", async () => {
  const filesystem = new MockFileSystemService()
  const { setup, app } = await mount(120, 36, { filesystem, reducedMotion: false })
  setup.mockInput.pressKey(" ")
  setup.mockInput.pressKey("s")
  await setup.flush()
  setup.mockInput.pressEnter()
  await setup.flush()
  expect(app.state.screen).toBe("consent")
  expect(app.state.transferQueue).toHaveLength(0)

  setup.mockInput.pressKey("a")
  await setup.flush()
  expect(app.state.transferQueue[0]?.status).toBe("queued")
  expect(app.state.transferQueue[0]?.progress).toBe(0)
  await Bun.sleep(2_650)
  await setup.flush()

  expect(app.state.transferQueue[0]?.status).toBe("complete")
  expect(app.state.transferQueue[0]?.progress).toBe(100)
  expect(filesystem.list("local", filesystem.paths.local)[0]?.state).toBe("synced")
  expect(app.state.staged.local.has("architecture")).toBe(false)
  expect(setup.captureCharFrame()).toContain("Complete")
})

test("Ctrl+C disposes the app and destroys the renderer", async () => {
  const { setup, app } = await mount()
  app.handleKey({ name: "c", ctrl: true } as KeyEvent)
  expect(setup.renderer.isDestroyed).toBe(true)
})
