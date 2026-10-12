/** Capture TUI screens in REAL mode — what a user actually sees. */
import { writeFileSync, mkdirSync } from "node:fs"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer } from "@opentui/core/testing"
import { createSyncWeaveApp } from "../src/app.js"
import { RealFileSystemService } from "../src/services/real-filesystem.js"
import { NullPeerService } from "../src/services/null-services.js"
import { MockTransferService } from "../src/services/mock-transfer-service.js"
import { NullTransferService } from "../src/services/null-services.js"
import { listenNoise } from "../src/services/transport.js"

process.env.SYNCWEAVE_REDUCED_MOTION = "1"

const OUT = "docs/screenshots"
mkdirSync(OUT, { recursive: true })

type Span = { text: string; fg: [number, number, number]; bg: [number, number, number] }

async function withRealApp(fn: (ctx: { setup: any; app: any; root: string }) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), "sw-shot-"))
  const root = join(base, "local")
  const receiveDir = join(base, "Downloads")
  await mkdir(join(root, "photos"), { recursive: true })
  await mkdir(join(root, "docs"), { recursive: true })
  await mkdir(receiveDir, { mode: 0o700, recursive: true })
  await writeFile(join(root, "report.pdf"), new Uint8Array(245000))
  await writeFile(join(root, "notes.txt"), "hello")
  await writeFile(join(root, "photos", "sunset.jpg"), new Uint8Array(1800000))
  await writeFile(join(root, "docs", "plan.md"), "# plan")

  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  const peers = [
    { id: "peer1", name: "laptop2", host: "192.168.1.42", port: 24816, online: true, lastSeen: Date.now(), source: "lan" as const },
  ]
  const discovery = { listPeers: () => peers, start: async () => {}, stop: () => {} }
  const real = {
    announcedPeerId: "shot-fixture-id",
    listener,
    discovery,
    alias: "mylaptop",
    tcpPort: listener.port,
    receiveDirectory: receiveDir,
    aborter: new AbortController(),
    startupWarning: null,
    bindAddr: "127.0.0.1",
  }
  const setup = await createTestRenderer({ width: 120, height: 36 })
  const app = createSyncWeaveApp(setup.renderer, {
    filesystem: new RealFileSystemService(root),
    peerService: new NullPeerService(),
    transferService: new NullTransferService(),
    receiveDestinations: [receiveDir],
    mode: "real",
    real,
  })
  // Inject the fake peer into app state for the shot
  await setup.flush()
  try {
    await fn({ setup, app, root })
  } finally {
    ;(real.aborter as AbortController).abort()
    app.dispose()
    try { await setup.renderer.destroy() } catch {}
    await listener.close().catch(() => {})
    const { rm } = await import("node:fs/promises")
    await rm(base, { recursive: true, force: true })
  }
}

async function capture(name: string, actions: (ctx: { setup: any; app: any; root: string }) => Promise<void>) {
  await withRealApp(async (ctx) => {
    await actions(ctx)
    await ctx.setup.flush()
    await new Promise((r) => setTimeout(r, 150))
    await ctx.setup.flush()
    const captured = ctx.setup.captureSpans() as { cols: number; rows: number; lines: Array<{ spans: any[] }> }
    const lines: Span[][] = captured.lines.map((line) =>
      line.spans.map((s) => ({
        text: s.text as string,
        fg: [s.fg.buffer[0], s.fg.buffer[1], s.fg.buffer[2]] as [number, number, number],
        bg: [s.bg.buffer[0], s.bg.buffer[1], s.bg.buffer[2]] as [number, number, number],
      })),
    )
    writeFileSync(`${OUT}/${name}.spans.json`, JSON.stringify({ cols: captured.cols, rows: captured.rows, lines }))
    console.log(`captured ${name}`)
  })
}

// 1. Real-mode workspace: local files left, peer status right (no receiver files)
await capture("01-workspace", async () => {})

// 2. Workspace with staged files
await capture("02-workspace-staged", async ({ setup }) => {
  setup.mockInput.pressKey(" ")
  await setup.flush()
  setup.mockInput.pressKey("ARROW_DOWN")
  await setup.flush()
  setup.mockInput.pressKey(" ")
  await setup.flush()
})

// 3. Send review (real mode)
await capture("03-send-review", async ({ setup }) => {
  setup.mockInput.pressKey(" ")
  await setup.flush()
  setup.mockInput.pressKey("s")
  await setup.flush()
})

// 4. Help
await capture("05-help", async ({ setup }) => {
  setup.mockInput.pressKey("?")
  await setup.flush()
})

console.log("done")
process.exit(0)
