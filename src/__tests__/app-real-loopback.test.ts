/**
 * Keypress-driven real-mode tests over real loopback. Each test runs two app
 * instances (sender and receiver) on 127.0.0.1 with real Noise sessions, real
 * files, and the real send/consent paths. Keys go through the test renderer's
 * keypress input, as in the TUI. Discovery is a stub that exposes the other
 * instance the way multicast would (peerId, address, port).
 */
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createSyncWeaveApp, SAS_CONFIRM_ARM_MS, type RealTransport, type SyncWeaveApp } from "../app.js"
import type { DiscoveredPeer, DiscoveryService } from "../services/discovery.js"
import { NullPeerService, NullTransferService } from "../services/null-services.js"
import { generateEphemeralIdentity } from "../services/peer-id.js"
import { RealFileSystemService } from "../services/real-filesystem.js"
import { listenNoise } from "../services/transport.js"

process.env.SYNCWEAVE_REDUCED_MOTION = "1"

const ENTER = "RETURN"
const ESC = "ESCAPE"
const DOWN = "ARROW_DOWN"
const SPACE = " "
const TEST_TIMEOUT_MS = 30_000

interface Instance {
  label: string
  base: string
  root: string
  receiveDir: string
  port: number
  announcedPeerId: string
  discoveryPeers: DiscoveredPeer[]
  listener: Awaited<ReturnType<typeof listenNoise>>
  setup: TestRendererSetup
  app: SyncWeaveApp
}

const instances: Instance[] = []

afterEach(async () => {
  for (const instance of instances.splice(0)) {
    await instance.app.dispose()
    await instance.setup.renderer.destroy()
    await instance.listener.close().catch(() => undefined)
    await rm(instance.base, { recursive: true, force: true })
  }
})

async function makeInstance(label: string, files: Record<string, string>, discoveryPeers: DiscoveredPeer[] = []): Promise<Instance> {
  const base = await mkdtemp(join(tmpdir(), `app-real-${label}-`))
  const root = join(base, "local")
  const receiveDir = join(base, "Downloads")
  await mkdir(root)
  await mkdir(receiveDir, { mode: 0o700 })
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body)
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  const announcedPeerId = generateEphemeralIdentity().peerId
  const discovery = {
    listPeers: () => discoveryPeers,
    start: async () => {},
    stop: () => {},
  } as unknown as DiscoveryService
  const real: RealTransport = {
    announcedPeerId,
    listener,
    discovery,
    alias: label,
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
  const instance: Instance = { label, base, root, receiveDir, port: listener.port, announcedPeerId, discoveryPeers, listener, setup, app }
  instances.push(instance)
  return instance
}

/** A receiver, and a sender whose discovery list holds the receiver the way multicast would. */
async function makePair(senderFiles: Record<string, string>): Promise<{ sender: Instance; receiver: Instance }> {
  const receiver = await makeInstance("receiver", {})
  const sender = await makeInstance("sender", senderFiles, [{
    peerId: receiver.announcedPeerId,
    alias: "receiver",
    address: "127.0.0.1",
    tcpPort: receiver.port,
    lastSeen: Date.now(),
  }])
  return { sender, receiver }
}

async function press(instance: Instance, ...keys: string[]): Promise<void> {
  await instance.setup.mockInput.pressKeys(keys, 20)
  await instance.setup.flush()
}

/** Wait out the SAS arm delay, then confirm the code on the sender (Enter). */
async function confirmSas(sender: Instance): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SAS_CONFIRM_ARM_MS + 50))
  await press(sender, ENTER)
}

async function waitFor<T>(description: string, read: () => T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Stage the first file in the Local pane and open the send review. */
async function stageFirstAndReview(sender: Instance): Promise<void> {
  await press(sender, SPACE)
  await press(sender, "s")
  expect(sender.app.state.screen).toBe("send-review")
}

test("sends to a discovered peer after the SAS is confirmed on both screens (R1)", async () => {
  const { sender, receiver } = await makePair({ "a.txt": "hello from the sender\n" })
  await stageFirstAndReview(sender)
  await press(sender, ENTER)

  // Sender: the SAS is parked until the user compares it with the receiver's screen.
  const senderSas = await waitFor("sender SAS prompt", () => sender.app.state.sendSasConfirm)
  // The discovered Peer ID is only a display hint: the peer is not verified by it.
  expect(senderSas.peerFingerprint).not.toContain(receiver.announcedPeerId)
  expect(senderSas.peerName).toBe("receiver")

  await confirmSas(sender)
  // Receiver: consent shows the SAS and an unverified sender, with no discovery alias trusted.
  const consent = await waitFor("receiver consent", () => receiver.app.state.request)
  expect(consent.sas).toBe(senderSas.sas)
  expect(consent.peer.name).toBe("unverified sender")
  await press(receiver, ENTER)

  await waitFor("sender finished", () => !sender.app.state.sending && sender.app.state.screen === "workspace")
  for (let i = 0; i < 3; i++) sender.app.render()
  expect(sender.app.state.status).toContain("receiver confirmed")
  expect(await readFile(join(receiver.receiveDir, "a.txt"), "utf8")).toBe("hello from the sender\n")
  // Confirmed files leave the staged set; the transfer history survives renders (P1-1).
  expect(sender.app.state.staged.local.size).toBe(0)
  expect(sender.app.state.transferQueue.filter((r) => r.direction === "outgoing" && r.status === "complete")).toHaveLength(1)
  expect(receiver.app.state.transferQueue.filter((r) => r.direction === "incoming" && r.status === "complete")).toHaveLength(1)
}, TEST_TIMEOUT_MS)

test("a double Enter sends once", async () => {
  const { sender, receiver } = await makePair({ "once.txt": "only once\n" })
  await stageFirstAndReview(sender)
  await press(sender, ENTER, ENTER)
  // The second Enter must not confirm the code: the prompt is not armed yet.
  expect(sender.app.state.status).not.toContain("Code confirmed")

  const senderSas = await waitFor("sender SAS prompt", () => sender.app.state.sendSasConfirm)
  await confirmSas(sender)
  await waitFor("receiver consent", () => receiver.app.state.request)
  await press(receiver, ENTER)
  await waitFor("sender finished", () => !sender.app.state.sending && sender.app.state.screen === "workspace")

  expect(senderSas.sas.length).toBeGreaterThan(0)
  expect(sender.app.state.transferQueue.filter((r) => r.direction === "outgoing")).toHaveLength(1)
  expect(receiver.app.state.transferQueue.filter((r) => r.direction === "incoming")).toHaveLength(1)
}, TEST_TIMEOUT_MS)

test("declining shows Declined on the receiver, not Receive failed", async () => {
  const { sender, receiver } = await makePair({ "no.txt": "declined\n" })
  await stageFirstAndReview(sender)
  await press(sender, ENTER)
  await waitFor("sender SAS prompt", () => sender.app.state.sendSasConfirm)
  await confirmSas(sender)
  await waitFor("receiver consent", () => receiver.app.state.request)
  await press(receiver, "x")

  await waitFor("receiver status", () => receiver.app.state.status.startsWith("Declined"))
  expect(receiver.app.state.status).not.toContain("Receive failed")
  await waitFor("sender outcome", () => sender.app.state.status.includes("declined"))
  expect(await stat(join(receiver.receiveDir, "no.txt")).catch(() => null)).toBeNull()
  expect(receiver.app.state.transferQueue[0]?.status).toBe("declined")
}, TEST_TIMEOUT_MS)

test("the receiver can save only the files it kept checked", async () => {
  const { sender, receiver } = await makePair({ "keep.txt": "kept\n", "skip.txt": "skipped\n" })
  // Stage both files in the Local pane.
  await press(sender, SPACE)
  await press(sender, DOWN)
  await press(sender, SPACE)
  await press(sender, "s")
  await press(sender, ENTER)
  await waitFor("sender SAS prompt", () => sender.app.state.sendSasConfirm)
  await confirmSas(sender)
  const consent = await waitFor("receiver consent", () => receiver.app.state.request)
  expect(consent.files.map((f) => f.name)).toEqual(["keep.txt", "skip.txt"])
  // Uncheck skip.txt (second row), then accept the rest.
  await press(receiver, DOWN)
  await press(receiver, SPACE)
  await press(receiver, ENTER)
  await waitFor("receiver done", () => receiver.app.state.status.startsWith("Received"))
  expect(await readFile(join(receiver.receiveDir, "keep.txt"), "utf8")).toBe("kept\n")
  expect(await stat(join(receiver.receiveDir, "skip.txt")).catch(() => null)).toBeNull()
}, TEST_TIMEOUT_MS)

test("Esc at the SAS prompt cancels the send before any file metadata is sent", async () => {
  const { sender, receiver } = await makePair({ "cancel.txt": "cancelled\n" })
  await stageFirstAndReview(sender)
  await press(sender, ENTER)
  await waitFor("sender SAS prompt", () => sender.app.state.sendSasConfirm)
  await press(sender, ESC)

  await waitFor("sender cancelled", () => !sender.app.state.sending && sender.app.state.screen === "workspace")
  expect(sender.app.state.status).toContain("not confirmed")
  expect(sender.app.state.staged.local.size).toBe(1)
  expect(sender.app.state.transferQueue[0]?.status).toBe("cancelled")
  expect(receiver.app.state.request).toBeNull()
  expect(await stat(join(receiver.receiveDir, "cancel.txt")).catch(() => null)).toBeNull()
}, TEST_TIMEOUT_MS)

test("the sender cancelling during consent clears the receiver's prompt", async () => {
  const { sender, receiver } = await makePair({ "gone.txt": "never saved\n" })
  await stageFirstAndReview(sender)
  await press(sender, ENTER)
  await waitFor("sender SAS prompt", () => sender.app.state.sendSasConfirm)
  await confirmSas(sender)
  await waitFor("receiver consent", () => receiver.app.state.request)

  await press(sender, ESC)
  await waitFor("receiver prompt cleared", () => receiver.app.state.request === null, 10_000)
  expect(receiver.app.state.screen).toBe("workspace")
  expect(receiver.app.state.status).toMatch(/Sender disconnected|cancel/i)
  expect(await stat(join(receiver.receiveDir, "gone.txt")).catch(() => null)).toBeNull()
}, TEST_TIMEOUT_MS)

test("the receiver's consent names an unverified sender and shows its Peer ID fingerprint", async () => {
  const receiver = await makeInstance("receiver", {})
  // The sender's address matches a discovery entry, so its alias is shown only as claimed.
  const sender = await makeInstance("sender", { "id.txt": "id\n" }, [{
    peerId: receiver.announcedPeerId,
    alias: "receiver",
    address: "127.0.0.1",
    tcpPort: receiver.port,
    lastSeen: Date.now(),
  }])
  receiver.discoveryPeers.push({ peerId: "z4XTTMclaimed", alias: "laptop-sender", address: "127.0.0.1", tcpPort: sender.port, lastSeen: Date.now() })
  await stageFirstAndReview(sender)
  await press(sender, ENTER)
  await waitFor("sender SAS prompt", () => sender.app.state.sendSasConfirm)
  await confirmSas(sender)
  const consent = await waitFor("receiver consent", () => receiver.app.state.request)
  expect(consent.peer.name).toBe('unverified sender · claims "laptop-sender"')
  expect(consent.peer.fingerprint).toMatch(/^[A-Za-z0-9]{4}( [A-Za-z0-9]{4}){5}$/)
  expect(consent.peer.fingerprint).not.toContain("z4XTTM")
  await press(receiver, "x")
  await waitFor("receiver declined", () => receiver.app.state.status.startsWith("Declined"))
}, TEST_TIMEOUT_MS)

test("a receive prompt whose destination is no longer a directory is refused, and the prompt stays open", async () => {
  const { sender, receiver } = await makePair({ "dest.txt": "dest\n" })
  await stageFirstAndReview(sender)
  await press(sender, ENTER)
  await waitFor("sender SAS prompt", () => sender.app.state.sendSasConfirm)
  await confirmSas(sender)
  await waitFor("receiver consent", () => receiver.app.state.request)

  // Replace the destination directory with a plain file.
  await rm(receiver.receiveDir, { recursive: true, force: true })
  await writeFile(receiver.receiveDir, "not a directory")
  await press(receiver, ENTER)
  expect(receiver.app.state.request).not.toBeNull()
  expect(receiver.app.state.status).toContain("Cannot accept")

  // Put the directory back and accept.
  await rm(receiver.receiveDir, { force: true })
  await mkdir(receiver.receiveDir, { mode: 0o700 })
  await press(receiver, ENTER)
  await waitFor("receiver saved", () => receiver.app.state.status.startsWith("Received"))
  expect(await readFile(join(receiver.receiveDir, "dest.txt"), "utf8")).toBe("dest\n")
}, TEST_TIMEOUT_MS)

test("dispose resolves promptly while a consent prompt is parked", async () => {
  const { sender, receiver } = await makePair({ "park.txt": "park\n" })
  await stageFirstAndReview(sender)
  await press(sender, ENTER)
  await waitFor("sender SAS prompt", () => sender.app.state.sendSasConfirm)
  await confirmSas(sender)
  await waitFor("receiver consent", () => receiver.app.state.request)

  const started = Date.now()
  await receiver.app.dispose()
  expect(Date.now() - started).toBeLessThan(3_500)
  expect(receiver.app.state.request).toBeNull()
}, TEST_TIMEOUT_MS)
