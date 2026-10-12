/** Capture TUI screens as text frames for README screenshots. */
import { writeFileSync, mkdirSync } from "node:fs"
import { createTestRenderer } from "@opentui/core/testing"
import { createSyncWeaveApp, type AppDependencies } from "../src/app.js"
import { MockFileSystemService } from "../src/services/mock-filesystem.js"
import { MockPeerService } from "../src/services/mock-peer-service.js"
import { mockDestinations, MockTransferService } from "../src/services/mock-transfer-service.js"

process.env.SYNCWEAVE_REDUCED_MOTION = "1"

const OUT = "docs/screenshots"
mkdirSync(OUT, { recursive: true })

function mockDependencies(): AppDependencies {
  return {
    filesystem: new MockFileSystemService(),
    peerService: new MockPeerService(),
    transferService: new MockTransferService(),
    receiveDestinations: mockDestinations,
  }
}

async function capture(name: string, setup: () => Promise<void>, width = 120, height = 36) {
  const renderer = await createTestRenderer({ width, height })
  const app = createSyncWeaveApp(renderer.renderer, mockDependencies())
  await renderer.flush()
  await setup()
  await renderer.flush()
  // Let any animation settle
  await new Promise((r) => setTimeout(r, 100))
  await renderer.flush()
  const frame = renderer.captureCharFrame()
  writeFileSync(`${OUT}/${name}.txt`, frame)
  console.log(`captured ${name}: ${frame.split("\n").length} lines`)
  app.dispose()
  await renderer.renderer.destroy()
}

// 1. Workspace (default)
await capture("01-workspace", async () => {})

// 2. Workspace with staged files
await capture("02-workspace-staged", async () => {
  // stage handled inside via direct access below
})

// We'll do interactive ones with direct app access
import { createTestRenderer as ctr } from "@opentui/core/testing"

async function interactive(name: string, actions: (ctx: { setup: any; app: any }) => Promise<void>, width = 120, height = 36) {
  const setup = await ctr({ width, height })
  const app = createSyncWeaveApp(setup.renderer, mockDependencies())
  await setup.flush()
  await actions({ setup, app })
  await setup.flush()
  await new Promise((r) => setTimeout(r, 100))
  await setup.flush()
  const frame = setup.captureCharFrame()
  writeFileSync(`${OUT}/${name}.txt`, frame)
  console.log(`captured ${name}`)
  app.dispose()
  await setup.renderer.destroy()
}

// Workspace with staged files: press space on a few entries
await interactive("02-workspace-staged", async ({ setup }) => {
  setup.mockInput.pressKey(" ")
  await setup.flush()
  setup.mockInput.pressKey("ARROW_DOWN")
  await setup.flush()
  setup.mockInput.pressKey(" ")
  await setup.flush()
})

// Send review screen
await interactive("03-send-review", async ({ setup }) => {
  setup.mockInput.pressKey(" ")
  await setup.flush()
  setup.mockInput.pressKey("ARROW_DOWN")
  await setup.flush()
  setup.mockInput.pressKey(" ")
  await setup.flush()
  setup.mockInput.pressKey("s")
  await setup.flush()
})

// Incoming consent screen
await interactive("04-consent-incoming", async ({ setup }) => {
  setup.mockInput.pressKey("i")
  await setup.flush()
})

// Help screen
await interactive("05-help", async ({ setup }) => {
  setup.mockInput.pressKey("?")
  await setup.flush()
})

// Peers screen
await interactive("06-peers", async ({ setup }) => {
  setup.mockInput.pressKey("q")
  await setup.flush()
})

// Transfer progress: accept incoming and catch it mid-flight
await interactive("07-transfer", async ({ setup, app }) => {
  setup.mockInput.pressKey("i")
  await setup.flush()
  setup.mockInput.pressEnter() // accept all
  await setup.flush()
  // transfer screen should be showing or progress running
})

console.log("done")
