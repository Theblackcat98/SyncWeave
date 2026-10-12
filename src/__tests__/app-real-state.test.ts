/**
 * Real-mode app state without the network: discovery events, peer selection by
 * ID, directory keys, and the env flag and fingerprint helpers.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createSyncWeaveApp, formatPeerFingerprint, type RealTransport, type SyncWeaveApp } from "../app.js"
import type { DiscoveredPeer, DiscoveryService, DiscoveryStartOptions } from "../services/discovery.js"
import { NullPeerService, NullTransferService } from "../services/null-services.js"
import { RealFileSystemService } from "../services/real-filesystem.js"
import { listenNoise } from "../services/transport.js"
import { isTruthyFlag, noColorRequested } from "../state/app-state.js"

process.env.SYNCWEAVE_REDUCED_MOTION = "1"

interface Fixture {
  setup: TestRendererSetup
  app: SyncWeaveApp
  peers: DiscoveredPeer[]
  events: () => DiscoveryStartOptions["events"]
  root: string
  cleanup: () => Promise<void>
}

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.app.dispose()
    await fixture.setup.renderer.destroy()
    await fixture.cleanup()
  }
})

async function makeFixture(peers: DiscoveredPeer[] = []): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "app-real-state-"))
  const root = join(base, "local")
  const receiveDir = join(base, "Downloads")
  await mkdir(join(root, "folder"), { recursive: true })
  await mkdir(receiveDir, { mode: 0o700 })
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  let captured: DiscoveryStartOptions | null = null
  const discovery = {
    listPeers: () => peers,
    start: async (options: DiscoveryStartOptions) => {
      captured = options
    },
    stop: () => {},
  } as unknown as DiscoveryService
  const real: RealTransport = {
    announcedPeerId: "z4XTTMfixture",
    listener,
    discovery,
    alias: "fixture",
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
  await setup.flush()
  const fixture: Fixture = {
    setup,
    app,
    peers,
    events: () => captured?.events,
    root,
    cleanup: async () => {
      await listener.close().catch(() => undefined)
      await rm(base, { recursive: true, force: true })
    },
  }
  fixtures.push(fixture)
  return fixture
}

function discovered(peerId: string, alias: string, address: string, tcpPort: number): DiscoveredPeer {
  return { peerId, alias, address, tcpPort, lastSeen: Date.now() }
}

describe("discovery events (P1-30)", () => {
  test("a discovery error is shown on the status line", async () => {
    const fixture = await makeFixture()
    await new Promise((r) => setTimeout(r, 20))
    fixture.events()?.onError?.(new Error("multicast join failed (discovery receive disabled)"))
    expect(fixture.app.state.status).toBe("Discovery: multicast join failed (discovery receive disabled)")
  })

  test("a known peer that changes address is reported on the status line", async () => {
    const peers = [discovered("z4XTTMaaaa1111", "laptop", "10.0.0.2", 24816)]
    const fixture = await makeFixture(peers)
    await new Promise((r) => setTimeout(r, 20))
    expect(fixture.app.state.peerIndex).toBe(0)
    peers[0] = discovered("z4XTTMaaaa1111", "laptop", "10.0.0.9", 24816)
    fixture.events()?.onPeersChanged?.([...peers], { reason: "updated", peerIds: [peers[0]!.peerId] })
    expect(fixture.app.state.status).toContain("Known peer changed address")
    expect(fixture.app.state.status).toContain("10.0.0.2:24816 → 10.0.0.9:24816")
  })
})

describe("peer selection is tracked by ID (P1-39)", () => {
  test("a reordered list keeps the selected peer, not the peer at the same index", async () => {
    const a = discovered("z4XTTMpeerA", "alpha", "10.0.0.1", 24816)
    const b = discovered("z4XTTMpeerB", "bravo", "10.0.0.2", 24816)
    const c = discovered("z4XTTMpeerC", "charlie", "10.0.0.3", 24816)
    const peers = [a, b]
    const fixture = await makeFixture(peers)
    await new Promise((r) => setTimeout(r, 20))
    // Select B (the second peer) through the Receiver pane.
    fixture.app.state.activePane = "remote"
    await fixture.setup.mockInput.pressKeys(["ARROW_DOWN"], 10)
    await fixture.setup.flush()
    expect(fixture.app.state.status).toContain("bravo")
    // A leaves and C joins: B is now at index 0 and C at index 1.
    peers.splice(0, peers.length, b, c)
    fixture.events()?.onPeersChanged?.([...peers], { reason: "added", peerIds: [c.peerId] })
    expect(fixture.app.state.peerIndex).toBe(0)
    expect(fixture.app.state.status).not.toContain("charlie")
  })
})

describe("directory keys (P1-26)", () => {
  test("Backspace climbs to the filesystem root, then says so", async () => {
    const fixture = await makeFixture()
    await new Promise((r) => setTimeout(r, 20))
    fixture.app.state.paths.local = join(fixture.root, "folder")
    for (let depth = 0; depth < 40; depth++) {
      if (fixture.app.state.paths.local === "/") break
      await fixture.setup.mockInput.pressKeys(["BACKSPACE"], 5)
      await fixture.setup.flush()
    }
    expect(fixture.app.state.paths.local).toBe("/")
    await fixture.setup.mockInput.pressKeys(["BACKSPACE"], 5)
    await fixture.setup.flush()
    expect(fixture.app.state.status).toContain("Already at the top")
  })

  test("~ jumps to the home folder", async () => {
    const fixture = await makeFixture()
    await new Promise((r) => setTimeout(r, 20))
    fixture.app.state.paths.local = fixture.root
    await fixture.setup.mockInput.pressKeys(["~"], 5)
    await fixture.setup.flush()
    expect(fixture.app.state.paths.local).toBe(homedir())
  })
})

describe("fingerprints and env flags (P2-2)", () => {
  test("a fingerprint skips the fixed prefix and groups the random part in fours", () => {
    const peerId = "z4XTTM" + "ABCD1234efgh5678IJKL9012"
    expect(formatPeerFingerprint(peerId)).toBe("ABCD 1234 efgh 5678 IJKL 9012")
  })

  test("env flags accept 1, true, yes and on", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) expect(isTruthyFlag(value)).toBe(true)
    for (const value of ["0", "false", "no", "off", "", undefined]) expect(isTruthyFlag(value)).toBe(false)
  })

  test("NO_COLOR counts when non-empty, per no-color.org", () => {
    expect(noColorRequested({ NO_COLOR: "1" })).toBe(true)
    expect(noColorRequested({ NO_COLOR: "" })).toBe(false)
    expect(noColorRequested({})).toBe(false)
  })
})
