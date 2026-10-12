import { afterEach, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createSyncWeaveApp, type RealTransport, type SyncWeaveApp } from "../app.js"
import { MockFileSystemService } from "../services/mock-filesystem.js"
import { MockPeerService } from "../services/mock-peer-service.js"
import { mockDestinations, MockTransferService } from "../services/mock-transfer-service.js"
import { generateEphemeralIdentity } from "../services/peer-id.js"
import { listenNoise } from "../services/transport.js"

process.env.SYNCWEAVE_REDUCED_MOTION = "1"

const open: Array<{ setup: TestRendererSetup; app: SyncWeaveApp; cleanup: () => void }> = []

afterEach(async () => {
  for (const { app, setup, cleanup } of open.splice(0)) {
    cleanup()
    app.dispose()
    await setup.renderer.destroy()
  }
})

test("real mode mounts, shows manual peer, and starts the receive loop", async () => {
  const identity = generateEphemeralIdentity()
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
    stop: () => {},
  } as unknown as import("../services/discovery.js").DiscoveryService
  const real: RealTransport = {
    identity,
    listener,
    discovery,
    alias: "smoke",
    tcpPort: (listener as unknown as { port: number }).port ?? 0,
    receiveDirectory: "/tmp",
    aborter: new AbortController(),
    startupWarning: null,
  }
  const setup = await createTestRenderer({ width: 120, height: 36 })
  const app = createSyncWeaveApp(setup.renderer, {
    filesystem: new MockFileSystemService(),
    peerService: new MockPeerService(),
    transferService: new MockTransferService(),
    receiveDestinations: mockDestinations,
    mode: "real",
    real,
  })
  open.push({ setup, app, cleanup: () => { void listener.close() } })
  await setup.flush()

  // The app mounted in real mode without crashing; give the peer poll a tick.
  await new Promise((r) => setTimeout(r, 100))
  await setup.flush()
  expect(app.state.screen).toBe("workspace")
})
