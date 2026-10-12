#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { mkdirSync, readdirSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createSyncWeaveApp, type RealTransport } from "./app.js"
import { parseArgs } from "./cli-args.js"
import { logEvent } from "./services/diagnostic-log.js"
import { MockFileSystemService } from "./services/mock-filesystem.js"
import { MockPeerService } from "./services/mock-peer-service.js"
import { mockDestinations, MockTransferService } from "./services/mock-transfer-service.js"
import { NullPeerService, NullTransferService } from "./services/null-services.js"
import { generateEphemeralIdentity } from "./services/peer-id.js"
import { listenNoise } from "./services/transport.js"
import { DiscoveryService } from "./services/discovery.js"
import pkg from "../package.json" with { type: "json" }

const args = process.argv.slice(2)

/** Startup errors must bypass OpenTUI's console capture: write to stderr directly. */
function fatal(message: string): never {
  process.stderr.write(`syncweave: ${message}\n`)
  process.exit(1)
}

let cli: ReturnType<typeof parseArgs>
try {
  cli = parseArgs(args, process.env)
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error))
}
for (const warning of cli.warnings) {
  process.stderr.write(`syncweave: ${warning}\n`)
}

if (cli.showHelp) {
  process.stdout.write(`SyncWeave ${pkg.version} — TUI file transfer for the local network.

Usage:
  bun src/main.ts [--real] [--alias NAME] [--port N] [--peer HOST:PORT]...

Modes:
  (default)   Mock demo: simulated files, peers, and transfers. No network.
  --real      Real mode: live Noise-encrypted transfers over TCP, UDP-multicast
              peer discovery, real local files. Received files land in ~/Downloads.

Flags:
  --alias NAME        Display name announced to peers (default: $USER).
  --port N            TCP port for the Noise listener (default: 24816).
  --bind ADDR         Local address to bind (default: :: dual-stack IPv4/IPv6).
  --peer HOST:PORT    Manual peer, repeatable. Fallback when multicast
                      discovery is unavailable. IPv6 as --peer [::1]:24816.
  --help, -h          Show this help and exit.
  --version           Show the version and exit.

Two instances on one machine need distinct ports:
  bun src/main.ts --real --alias a --port 24816 --peer 127.0.0.1:24818
  bun src/main.ts --real --alias b --port 24818 --peer 127.0.0.1:24816
`)
  process.exit(0)
}

if (cli.showVersion) {
  process.stdout.write(`SyncWeave ${pkg.version}\n`)
  process.exit(0)
}

const { realMode, alias, tcpPort, bindAddr, manualPeers } = cli

if (!realMode) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  const app = createSyncWeaveApp(renderer, {
    filesystem: new MockFileSystemService(),
    peerService: new MockPeerService(),
    transferService: new MockTransferService(),
    receiveDestinations: mockDestinations,
  })
  renderer.on("destroy", app.dispose)
  renderer.start()
} else {
  // Real mode: set up networking BEFORE the renderer starts, so startup
  // errors are visible (OpenTUI captures console output once running).
  const identity = generateEphemeralIdentity()
  const aborter = new AbortController()
  let listener: Awaited<ReturnType<typeof listenNoise>>
  try {
    listener = await listenNoise({ host: bindAddr, port: tcpPort, signal: aborter.signal })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("EADDRINUSE")) {
      fatal(
        `port ${tcpPort} is already in use — another SyncWeave instance is probably running.\n` +
        `Start this instance on a different port, e.g. --port ${tcpPort + 1}, ` +
        `and point the two at each other with --peer 127.0.0.1:<port>.`,
      )
    }
    fatal(`could not start the TCP listener: ${message}`)
  }
  const discovery = new DiscoveryService()
  let discoveryError: string | null = null
  try {
    await discovery.start({ alias, peerId: identity.peerId, tcpPort })
  } catch (error) {
    // Non-fatal: manual --peer entries still work. Surfaced in-TUI below.
    discoveryError = error instanceof Error ? error.message : String(error)
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
  // The receive sink requires an existing directory; create it now and fail
  // fast with a clear message instead of a cryptic ENOENT mid-transfer.
  const receiveDirectory = join(homedir(), "Downloads")
  try {
    mkdirSync(receiveDirectory, { recursive: true, mode: 0o700 })
  } catch (error) {
    fatal(`could not create receive directory ${receiveDirectory}: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Sweep orphaned staging temp files from killed sessions (kill -9,
  // SIGTERM before handlers ran, crashes). They are never user data.
  try {
    let swept = 0
    for (const name of readdirSync(receiveDirectory)) {
      if (name.startsWith(".syncweave-") && name.endsWith(".partial")) {
        try {
          unlinkSync(join(receiveDirectory, name))
          swept++
        } catch { /* best effort */ }
      }
    }
    if (swept > 0) logEvent("startup-sweep", `removed ${swept} orphaned partial file(s)`)
  } catch { /* best effort */ }

  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  logEvent("session-start", `real mode alias=${alias} port=${tcpPort} bind=${bindAddr}`)
  const real: RealTransport = {
    identity,
    listener,
    discovery,
    alias,
    tcpPort,
    receiveDirectory,
    aborter,
    startupWarning: discoveryError ? `Discovery failed to start (${discoveryError}); manual --peer entries still work.` : null,
    bindAddr,
  }
  const app = createSyncWeaveApp(renderer, {
    // Real mode gets null services: the mock peer/transfer services simulate
    // network behavior and must not exist in real mode. Real transfers feed
    // state.transferQueue directly.
    filesystem: new MockFileSystemService(), // replaced by RealFileSystemService in real mode
    peerService: new NullPeerService(),
    transferService: new NullTransferService(),
    receiveDestinations: [receiveDirectory] as unknown as readonly [string, ...string[]],
    mode: "real",
    real,
  })
  const dispose = () => {
    logEvent("session-stop")
    try {
      discovery.stop()
    } catch { /* best effort */ }
    aborter.abort()
    void listener.close().catch(() => { /* best effort */ })
    app.dispose()
  }
  // SIGTERM/SIGHUP (kill, terminal close, SSH drop) must clean up like
  // Ctrl+C does, otherwise the terminal is left in raw mode.
  const onSignal = () => {
    dispose()
    renderer.destroy()
  }
  process.on("SIGTERM", onSignal)
  process.on("SIGHUP", onSignal)
  process.on("SIGINT", onSignal)
  renderer.on("destroy", () => {
    process.off("SIGTERM", onSignal)
    process.off("SIGHUP", onSignal)
    process.off("SIGINT", onSignal)
    dispose()
  })
  renderer.start()
}
