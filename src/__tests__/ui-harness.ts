// Shared mount helpers for the ui-* frame tests. Not a test file itself.
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createSyncWeaveApp, type AppDependencies, type RealTransport, type SyncWeaveApp } from "../app.js"
import type { ConsentRequest, MockPeer } from "../domain.js"
import { MockFileSystemService } from "../services/mock-filesystem.js"
import { MockPeerService } from "../services/mock-peer-service.js"
import { mockDestinations, MockTransferService } from "../services/mock-transfer-service.js"
import { generateEphemeralIdentity } from "../services/peer-id.js"

process.env.SYNCWEAVE_REDUCED_MOTION = "1"

export interface Mounted {
  setup: TestRendererSetup
  app: SyncWeaveApp
}

const mounted: Mounted[] = []

/** A real-mode transport with no sockets: discovery returns the given peers and accept never yields. */
export function fakeRealTransport(peers: Array<{ peerId: string; alias: string; address: string; tcpPort: number }> = []): RealTransport {
  const never = new Promise<never>(() => {})
  return {
    identity: generateEphemeralIdentity(),
    listener: { accept: async function* () { await never }, close: async () => {} },
    discovery: { listPeers: () => peers.map((peer) => ({ ...peer, lastSeen: Date.now() })), stop: () => {} },
    alias: "ui-test",
    tcpPort: 24816,
    receiveDirectory: "/tmp",
    aborter: new AbortController(),
    startupWarning: null,
    bindAddr: "::",
  } as unknown as RealTransport
}

export async function mountUi(options: {
  width: number
  height: number
  mode?: "mock" | "real"
  destinations?: readonly string[]
  peers?: Array<{ peerId: string; alias: string; address: string; tcpPort: number }>
}): Promise<Mounted> {
  const setup = await createTestRenderer({ width: options.width, height: options.height })
  const mode = options.mode ?? "mock"
  const dependencies: AppDependencies = {
    filesystem: new MockFileSystemService(),
    peerService: new MockPeerService(),
    transferService: new MockTransferService(),
    receiveDestinations: options.destinations ?? mockDestinations,
    mode,
    ...(mode === "real" ? { real: fakeRealTransport(options.peers) } : {}),
  }
  const app = createSyncWeaveApp(setup.renderer, dependencies)
  const entry = { setup, app }
  mounted.push(entry)
  await setup.flush()
  return entry
}

export function frameRows(setup: TestRendererSetup): string[] {
  return setup.captureCharFrame().split("\n")
}

export function frameText(setup: TestRendererSetup): string {
  return setup.captureCharFrame()
}

export async function unmountAll(): Promise<void> {
  for (const { app, setup } of mounted.splice(0)) {
    app.dispose()
    await setup.renderer.destroy()
  }
}

export function consentRequest(overrides: Partial<ConsentRequest> = {}, fileCount = 3): ConsentRequest {
  const peer: MockPeer = { id: "zAAA", name: "Lab laptop", host: "192.168.1.20", port: 24816, fingerprint: "zAAA", online: true }
  return {
    id: "ui-test",
    mode: "incoming",
    peer,
    files: Array.from({ length: fileCount }, (_, i) => ({ id: `f${i}`, name: `report-${i}.pdf`, bytes: 2048 * (i + 1), accepted: true, renamed: false })),
    createdAt: 0,
    sas: "ABCD-1234",
    ...overrides,
  }
}
