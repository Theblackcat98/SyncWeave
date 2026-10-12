import { createCliRenderer } from "@opentui/core"
import { homedir } from "node:os"
import { join } from "node:path"
import { createSyncWeaveApp, type RealTransport } from "./app.js"
import { MockFileSystemService } from "./services/mock-filesystem.js"
import { MockPeerService } from "./services/mock-peer-service.js"
import { mockDestinations, MockTransferService } from "./services/mock-transfer-service.js"
import { generateEphemeralIdentity } from "./services/peer-id.js"
import { listenNoise } from "./services/transport.js"
import { DiscoveryService } from "./services/discovery.js"

const args = process.argv.slice(2)
const realMode = args.includes("--real") || process.env.SYNCWEAVE_MODE === "real"
const aliasArg = args.indexOf("--alias")
const alias =
  aliasArg >= 0 && args[aliasArg + 1] ? args[aliasArg + 1] : (process.env.USER ?? "syncweave")
const portArg = args.indexOf("--port")
const tcpPort = portArg >= 0 && args[portArg + 1] ? parseInt(args[portArg + 1], 10) : 24816
// Manual peers: --peer 192.168.1.5:24816 (repeatable). Fallback when multicast
// discovery is unavailable; also useful for loopback testing.
const manualPeers: Array<{ host: string; port: number }> = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--peer" && args[i + 1]) {
    const [host, portStr] = args[i + 1].split(":")
    manualPeers.push({ host, port: portStr ? parseInt(portStr, 10) : 24816 })
  }
}

const renderer = await createCliRenderer({ exitOnCtrlC: false })

if (!realMode) {
  const app = createSyncWeaveApp(renderer, {
    filesystem: new MockFileSystemService(),
    peerService: new MockPeerService(),
    transferService: new MockTransferService(),
    receiveDestinations: mockDestinations,
  })
  renderer.on("destroy", app.dispose)
  renderer.start()
} else {
  // Real mode: live identity, TCP listener, UDP-multicast discovery.
  const identity = generateEphemeralIdentity()
  const listener = await listenNoise({ host: "0.0.0.0", port: tcpPort })
  const discovery = new DiscoveryService()
  try {
    await discovery.start({ alias, peerId: identity.peerId, tcpPort })
  } catch (error) {
    console.error(`Discovery failed to start (manual IP entry still works): ${error instanceof Error ? error.message : String(error)}`)
  }
  // Seed manual peers into the discovery list so they appear immediately.
  for (const mp of manualPeers) {
    discovery.addManualPeer({
      peerId: `manual:${mp.host}:${mp.port}`,
      alias: `${mp.host}:${mp.port}`,
      address: mp.host,
      tcpPort: mp.port,
      lastSeen: Date.now(),
    })
  }
  const receiveDirectory = join(homedir(), "Downloads")
  const real: RealTransport = {
    identity,
    listener,
    discovery,
    alias,
    tcpPort,
    receiveDirectory,
  }
  const app = createSyncWeaveApp(renderer, {
    filesystem: new MockFileSystemService(), // replaced by RealFileSystemService in real mode
    peerService: new MockPeerService(),
    transferService: new MockTransferService(),
    receiveDestinations: [receiveDirectory] as unknown as readonly [string, ...string[]],
    mode: "real",
    real,
  })
  const dispose = () => {
    discovery.stop()
    void listener.close()
    app.dispose()
  }
  renderer.on("destroy", dispose)
  renderer.start()
}
