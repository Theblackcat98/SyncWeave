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
const tcpPortRaw = portArg >= 0 && args[portArg + 1] ? args[portArg + 1] : "24816"
const tcpPort = parseInt(tcpPortRaw, 10)
if (!Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
  console.error(`Invalid --port value "${tcpPortRaw}": expected an integer 1-65535.`)
  process.exit(1)
}
// Manual peers: --peer 192.168.1.5:24816 (repeatable; IPv6 as [::1]:24816).
// Fallback when multicast discovery is unavailable; also useful for loopback testing.
const manualPeers: Array<{ host: string; port: number }> = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--peer" && args[i + 1]) {
    const spec = args[i + 1]
    // Bracketed IPv6: [::1] or [::1]:24816. Otherwise split on the last colon
    // so bare IPv6 without brackets is rejected rather than misparsed.
    let host: string | undefined
    let portStr: string | undefined
    const bracketed = spec.match(/^\[([^\]]+)\](?::(\d+))?$/)
    if (bracketed) {
      host = bracketed[1]
      portStr = bracketed[2]
    } else if ((spec.match(/:/g) ?? []).length > 1) {
      console.error(`Invalid --peer value "${spec}": wrap IPv6 addresses in brackets, e.g. --peer [::1]:24816. Skipping.`)
      continue
    } else {
      const idx = spec.lastIndexOf(":")
      if (idx >= 0) {
        host = spec.slice(0, idx)
        portStr = spec.slice(idx + 1)
      } else {
        host = spec
      }
    }
    const port = portStr ? parseInt(portStr, 10) : 24816
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`Invalid --peer value "${spec}": expected host[:port] with port 1-65535. Skipping.`)
      continue
    }
    manualPeers.push({ host, port })
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
  const aborter = new AbortController()
  let listener: Awaited<ReturnType<typeof listenNoise>>
  try {
    listener = await listenNoise({ host: "0.0.0.0", port: tcpPort, signal: aborter.signal })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("EADDRINUSE")) {
      console.error(
        `\nPort ${tcpPort} is already in use — another SyncWeave instance is probably running.\n` +
        `Start this instance on a different port, e.g. --port ${tcpPort + 1}, ` +
        `and point the two at each other with --peer 127.0.0.1:<port>.\n`,
      )
    } else {
      console.error(`Failed to start the TCP listener: ${message}`)
    }
    process.exit(1)
  }
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
    aborter,
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
