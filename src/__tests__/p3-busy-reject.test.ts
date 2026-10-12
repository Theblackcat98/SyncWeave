import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createSyncWeaveApp, type RealTransport, type SyncWeaveApp } from "../app.js"
import { NullPeerService, NullTransferService } from "../services/null-services.js"
import { RealFileSystemService } from "../services/real-filesystem.js"
import { mockDestinations } from "../services/mock-transfer-service.js"
import { dialNoise, listenNoise } from "../services/transport.js"
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

async function mountReal() {
  const root = await mkdtemp(join(tmpdir(), "p3-busy-"))
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  const port = (listener as unknown as { port: number }).port
  const discovery = {
    listPeers: () => [],
    start: async () => {},
    stop: () => {},
  } as unknown as DiscoveryService
  const aborter = new AbortController()
  const real: RealTransport = {
    announcedPeerId: "p3busyfixture",
    listener,
    discovery,
    alias: "p3",
    tcpPort: port,
    receiveDirectory: root,
    aborter,
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
  open.push({
    setup,
    app,
    cleanup: async () => {
      aborter.abort()
      await rm(root, { recursive: true, force: true })
      await listener.close()
    },
  })
  await setup.flush()
  return { app, setup, port }
}

test("P3: second handshake while receiving is rejected fast with a busy status", async () => {
  const { app, setup, port } = await mountReal()

  // Session 1: dial in and complete the Noise handshake, then stall —
  // send nothing so receiveSession parks waiting for a transfer request.
  const client1 = await dialNoise("127.0.0.1", port)
  // Give the receive loop a moment to pick up handshake 1 and start the session.
  await new Promise((r) => setTimeout(r, 300))
  await setup.flush()
  expect(app.state.status).toContain("Incoming connection")

  // Handshake 2 arrives while session 1 is active. It must be rejected
  // fast — not parked until session 1 finishes (which never happens here).
  const client2 = await dialNoise("127.0.0.1", port)
  const deadline = Date.now() + 5000
  while (!client2.channel.isClosed && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  expect(client2.channel.isClosed).toBe(true)

  await setup.flush()
  expect(app.state.status).toContain("Busy — one transfer at a time")

  // Session 1 is still the active one: single-session intent preserved.
  expect(app.state.activeTransferId).not.toBeNull()

  client1.channel.abort()
}, 15000)

test("P3: handshakes are accepted again after the session ends", async () => {
  const { app, setup, port } = await mountReal()

  // Session 1: dial, handshake, then abort the client so the session ends.
  const client1 = await dialNoise("127.0.0.1", port)
  await new Promise((r) => setTimeout(r, 300))
  await setup.flush()
  expect(app.state.status).toContain("Incoming connection")
  client1.channel.abort()

  // Wait for session 1 to settle and the flag to clear.
  const deadline = Date.now() + 5000
  while (app.state.activeTransferId !== null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    await setup.flush()
  }
  expect(app.state.activeTransferId).toBeNull()

  // A new handshake now must NOT be busy-rejected.
  const client2 = await dialNoise("127.0.0.1", port)
  await new Promise((r) => setTimeout(r, 500))
  await setup.flush()
  expect(client2.channel.isClosed).toBe(false)
  expect(app.state.status).not.toContain("Busy — one transfer at a time")
  expect(app.state.status).toContain("Incoming connection")

  client2.channel.abort()
}, 15000)
