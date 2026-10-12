#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core"
import { accessSync, constants, mkdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { createSyncWeaveApp, type RealTransport } from "./app.js"
import { parseArgs, UsageError } from "./cli-args.js"
import { logEvent } from "./services/diagnostic-log.js"
import { MockFileSystemService } from "./services/mock-filesystem.js"
import { MockPeerService } from "./services/mock-peer-service.js"
import { mockDestinations, MockTransferService } from "./services/mock-transfer-service.js"
import { NullPeerService, NullTransferService } from "./services/null-services.js"
import { RealFileSystemService, expandHome } from "./services/real-filesystem.js"
import { loadDestinations } from "./services/destinations.js"
import { sweepOrphanPartials } from "./services/safe-receive-sink.js"
import { generateEphemeralIdentity } from "./services/peer-id.js"
import { listenNoise } from "./services/transport.js"
import { DiscoveryService } from "./services/discovery.js"
import pkg from "../package.json" with { type: "json" }

const args = process.argv.slice(2)

/** Startup errors must bypass OpenTUI's console capture: write to stderr directly. */
function fatal(message: string, exitCode = 1): never {
  process.stderr.write(`syncweave: ${message}\n`)
  process.exit(exitCode)
}

// Last-resort handlers: restore the terminal and exit nonzero instead of
// dying mid-alternate-screen with a broken terminal.
process.on("uncaughtException", (error) => {
  process.stderr.write(`syncweave: uncaught exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`syncweave: unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`)
  process.exit(1)
})

let cli: ReturnType<typeof parseArgs>
try {
  cli = parseArgs(args, process.env)
} catch (error) {
  if (error instanceof UsageError) fatal(`${error.message}`, error.exitCode)
  fatal(error instanceof Error ? error.message : String(error), 2)
}

if (cli.showHelp) {
  process.stdout.write(`SyncWeave ${pkg.version} — TUI file transfer for the local network.

Usage:
  bun src/main.ts [--real] [--alias NAME] [--port N] [--peer HOST:PORT]...

Modes:
  (default)   Mock demo: simulated files, peers, and transfers. No network.
  --real      Real mode: live Noise-encrypted transfers over TCP, UDP-multicast
              peer discovery, real local files. Received files land in ~/Downloads.

Flags (each takes --flag VALUE or --flag=VALUE):
  --alias NAME        Display name announced to peers (default: syncweave-XXXX,
                      random per run).
  --port N            TCP port for the Noise listener (default: 24816).
  --bind ADDR         Local address to bind. Default: :: (IPv6, falling back to
                      0.0.0.0 when IPv6 is unavailable). An explicit --bind never falls back.
  --peer HOST:PORT    Manual peer, repeatable, IP address only. Fallback when
                      multicast discovery is unavailable. IPv6: --peer [::1]:24816.
  --root DIR          Start the Local pane in DIR (real mode; default: your home folder).
  --real=0|1          Force real mode off or on.
  --help, -h          Show this help and exit.
  --version           Show the version and exit.

Exit codes: 0 success, 1 startup failure, 2 usage error.

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

const { realMode, alias, tcpPort, manualPeers } = cli

if (!realMode) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  const app = createSyncWeaveApp(renderer, {
    filesystem: new MockFileSystemService(),
    peerService: new MockPeerService(),
    transferService: new MockTransferService(),
    receiveDestinations: mockDestinations,
  })
  renderer.on("destroy", () => {
    void app.dispose()
  })
  renderer.start()
} else {
  // The receive sink requires an existing, writable directory. Create it and
  // fail fast with a clear message instead of a cryptic ENOENT mid-transfer.
  const receiveDirectory = join(homedir(), "Downloads")
  try {
    mkdirSync(receiveDirectory, { recursive: true, mode: 0o700 })
    accessSync(receiveDirectory, constants.W_OK)
  } catch (error) {
    fatal(
      `receive directory ${receiveDirectory} is not usable (${error instanceof Error ? error.message : String(error)}). ` +
      "Fix its ownership or permissions, then start again.",
    )
  }
  let rootDirectory = homedir()
  if (cli.rootDir !== null) {
    rootDirectory = resolve(expandHome(cli.rootDir))
    try {
      if (!statSync(rootDirectory).isDirectory()) throw new Error("not a directory")
    } catch (error) {
      fatal(`--root ${cli.rootDir} is not a readable directory (${error instanceof Error ? error.message : String(error)}).`)
    }
  }
  // Sweep orphaned staging temp files from killed sessions (kill -9,
  // SIGTERM before handlers ran, crashes). They are never user data.
  {
    const swept = await sweepOrphanPartials(receiveDirectory)
    if (swept > 0) logEvent("startup-sweep", `removed ${swept} orphaned partial file(s)`)
  }

  // Real mode: the listener is bound BEFORE the renderer starts, so startup
  // errors are visible (OpenTUI captures console output once running).
  const aborter = new AbortController()
  let bindAddr = cli.bindAddr
  let startupNotice: string | null = null
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
    // D4: the default bind tries IPv6 first. Hosts without IPv6 fall back to
    // IPv4 with a visible notice. An explicit --bind never falls back.
    if (cli.bindExplicit || bindAddr !== "::" || message.includes("EACCES")) {
      fatal(`could not start the TCP listener on ${bindAddr}:${tcpPort}: ${message}`)
    }
    try {
      listener = await listenNoise({ host: "0.0.0.0", port: tcpPort, signal: aborter.signal })
    } catch (fallbackError) {
      fatal(`could not start the TCP listener on :: or 0.0.0.0, port ${tcpPort}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`)
    }
    bindAddr = "0.0.0.0"
    startupNotice = "IPv6 is not available here: listening on 0.0.0.0 (IPv4 only)."
    logEvent("bind-fallback", `:: failed (${message}); using 0.0.0.0`)
  }

  const discovery = new DiscoveryService()
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

  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  logEvent("session-start", `real mode alias=${alias} port=${tcpPort} bind=${bindAddr}`)
  const real: RealTransport = {
    // Discovery display/dedup hint only. Keys are discarded: no identity is
    // kept across the run, and verification happens per session (D1).
    announcedPeerId: generateEphemeralIdentity().peerId,
    listener,
    discovery,
    alias,
    tcpPort,
    receiveDirectory,
    aborter,
    startupWarning: startupNotice,
    bindAddr,
  }
  const app = createSyncWeaveApp(renderer, {
    filesystem: new RealFileSystemService(rootDirectory),
    // Real mode gets null services: the mock peer/transfer services simulate
    // network behavior and must not exist in real mode. Real transfers feed
    // the app's transfer queue directly.
    peerService: new NullPeerService(),
    transferService: new NullTransferService(),
    // Persisted across restarts via destinations.json; ~/Downloads is
    // always the default (first) entry.
    receiveDestinations: loadDestinations(receiveDirectory),
    mode: "real",
    real,
  })
  // One shutdown path for Ctrl+C, SIGINT/SIGTERM/SIGHUP and renderer teardown:
  // stop listening, let in-flight sends and receives settle (bounded by the
  // app), then exit explicitly.
  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) return
    shuttingDown = true
    logEvent("session-stop")
    try {
      discovery.stop()
    } catch { /* best effort */ }
    aborter.abort()
    void listener.close().catch(() => { /* best effort */ })
    void app.dispose().finally(() => {
      try {
        renderer.destroy()
      } catch { /* already torn down */ }
      process.exit(0)
    })
  }
  // SIGTERM/SIGHUP (kill, terminal close, SSH drop) must clean up like
  // Ctrl+C does, otherwise the terminal is left in raw mode.
  process.on("SIGTERM", shutdown)
  process.on("SIGHUP", shutdown)
  process.on("SIGINT", shutdown)
  renderer.on("destroy", shutdown)
  renderer.start()
}
