/** Capture TUI screens as styled spans for true-color README screenshots. */
import { writeFileSync, mkdirSync } from "node:fs"
import { createTestRenderer } from "@opentui/core/testing"
import { createSyncWeaveApp, type AppDependencies } from "../src/app.js"
import { MockFileSystemService } from "../src/services/mock-filesystem.js"
import { MockPeerService } from "../src/services/mock-peer-service.js"
import { mockDestinations, MockTransferService } from "../src/services/mock-transfer-service.js"

process.env.SYNCWEAVE_REDUCED_MOTION = "1"
// NOTE: NOT setting SYNCWEAVE_ASCII — capture what a real user sees.

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

type Span = { text: string; fg: [number, number, number]; bg: [number, number, number] }

async function capture(name: string, actions: (ctx: { setup: any; app: any }) => Promise<void>, width = 120, height = 36) {
  const setup = await createTestRenderer({ width, height })
  const app = createSyncWeaveApp(setup.renderer, mockDependencies())
  await setup.flush()
  await actions({ setup, app })
  await setup.flush()
  await new Promise((r) => setTimeout(r, 150))
  await setup.flush()
  const captured = setup.captureSpans() as { cols: number; rows: number; lines: Array<{ spans: any[] }> }
  const lines: Span[][] = captured.lines.map((line) =>
    line.spans.map((s) => ({
      text: s.text as string,
      fg: [s.fg.buffer[0], s.fg.buffer[1], s.fg.buffer[2]] as [number, number, number],
      bg: [s.bg.buffer[0], s.bg.buffer[1], s.bg.buffer[2]] as [number, number, number],
    })),
  )
  writeFileSync(`${OUT}/${name}.spans.json`, JSON.stringify({ cols: captured.cols, rows: captured.rows, lines }))
  console.log(`captured ${name}: ${lines.length} rows`)
  app.dispose()
  try { await setup.renderer.destroy() } catch {}
}

await capture("01-workspace", async () => {})

await capture("02-workspace-staged", async ({ setup }) => {
  setup.mockInput.pressKey(" ")
  await setup.flush()
  setup.mockInput.pressKey("ARROW_DOWN")
  await setup.flush()
  setup.mockInput.pressKey(" ")
  await setup.flush()
})

await capture("03-send-review", async ({ setup }) => {
  setup.mockInput.pressKey(" ")
  await setup.flush()
  setup.mockInput.pressKey("ARROW_DOWN")
  await setup.flush()
  setup.mockInput.pressKey(" ")
  await setup.flush()
  setup.mockInput.pressKey("s")
  await setup.flush()
})

await capture("04-consent-incoming", async ({ setup }) => {
  setup.mockInput.pressKey("i")
  await setup.flush()
})

await capture("05-help", async ({ setup }) => {
  setup.mockInput.pressKey("?")
  await setup.flush()
})

await capture("06-peers", async ({ setup }) => {
  setup.mockInput.pressKey("q")
  await setup.flush()
})

await capture("07-transfer", async ({ setup }) => {
  setup.mockInput.pressKey("i")
  await setup.flush()
  setup.mockInput.pressEnter()
  await setup.flush()
})

console.log("done")
