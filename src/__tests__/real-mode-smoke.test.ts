import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createSyncWeaveApp, type RealTransport, type SyncWeaveApp } from "../app.js"
import { NullPeerService, NullTransferService } from "../services/null-services.js"
import { RealFileSystemService } from "../services/real-filesystem.js"
import { mockDestinations } from "../services/mock-transfer-service.js"
import { listenNoise } from "../services/transport.js"
import type { DiscoveryService } from "../services/discovery.js"

process.env.SYNCWEAVE_REDUCED_MOTION = "1"

const open: Array<{ setup: TestRendererSetup; app: SyncWeaveApp; cleanup: () => Promise<void> }> = []

afterEach(async () => {
  for (const { app, setup, cleanup } of open.splice(0)) {
    await app.dispose()
    await setup.renderer.destroy()
    await cleanup()
  }
})

test("real mode mounts on the workspace with the real filesystem and no mock services", async () => {
  const root = await mkdtemp(join(tmpdir(), "smoke-root-"))
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  const manualPeer = {
    peerId: "manual:127.0.0.1:24899",
    alias: "test-peer",
    address: "127.0.0.1",
    tcpPort: 24899,
    lastSeen: Date.now(),
  }
  const discovery = {
    listPeers: () => [manualPeer],
    start: async () => {},
    stop: () => {},
  } as unknown as DiscoveryService
  const real: RealTransport = {
    announcedPeerId: "z4XTTMsmokeonly",
    listener,
    discovery,
    alias: "smoke",
    tcpPort: (listener as unknown as { port: number }).port ?? 0,
    receiveDirectory: root,
    aborter: new AbortController(),
    startupWarning: null,
    bindAddr: "127.0.0.1",
  }
  const setup = await createTestRenderer({ width: 120, height: 36 })
  const app = createSyncWeaveApp(setup.renderer, {
    filesystem: new RealFileSystemService(root),
    peerService: new NullPeerService(),
    transferService: new NullTransferService(),
    receiveDestinations: mockDestinations,
    mode: "real",
    real,
  })
  open.push({ setup, app, cleanup: () => rm(root, { recursive: true, force: true }).then(() => listener.close()) })
  await setup.flush()

  // The discovered peer list is picked up on the first sync.
  await new Promise((r) => setTimeout(r, 50))
  await setup.flush()
  expect(app.state.screen).toBe("workspace")
  expect(app.state.activePane).toBe("local")
  expect(app.state.paths.local).toBe(root)
  expect(app.state.status).not.toContain("simulated")
})

test("real mode without a transport bundle is a construction error, not a mock fallback", async () => {
  const setup = await createTestRenderer({ width: 120, height: 36 })
  expect(() =>
    createSyncWeaveApp(setup.renderer, {
      filesystem: new RealFileSystemService(tmpdir()),
      peerService: new NullPeerService(),
      transferService: new NullTransferService(),
      receiveDestinations: mockDestinations,
      mode: "real",
    }),
  ).toThrow(/requires dependencies.real/)
  await setup.renderer.destroy()
})
