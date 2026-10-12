/**
 * CLI argument parsing for SyncWeave. Extracted from main.ts so it can be
 * unit-tested (P1-46). Every usage problem throws a UsageError (exit code 2)
 * with a message suitable for stderr; main.ts catches and exits.
 */
import { randomBytes } from "node:crypto"
import { isIP } from "node:net"
import { isTruthyFlag } from "./state/app-state.js"

export class CliError extends Error {}

/** A bad command line: main.ts prints the message and exits with `exitCode`. */
export class UsageError extends CliError {
  readonly exitCode = 2
}

export interface ManualPeer {
  host: string
  port: number
}

export interface CliOptions {
  realMode: boolean
  alias: string
  tcpPort: number
  bindAddr: string
  /** True when --bind was given. An explicit bind never falls back (D4). */
  bindExplicit: boolean
  /** Start directory for the Local pane (--root); null means the home folder. */
  rootDir: string | null
  manualPeers: ManualPeer[]
  showHelp: boolean
  showVersion: boolean
}

const DEFAULT_PORT = 24816
const MAX_ALIAS_CHARS = 64
const VALUE_FLAGS = new Set(["--alias", "--port", "--peer", "--bind", "--root"])

/** Random per-run suffix for the default alias ("syncweave-XXXX"). Never $USER. */
function randomAliasSuffix(): string {
  return randomBytes(2).toString("hex")
}

function parsePort(raw: string, context: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`invalid ${context} "${raw}": expected an integer 1-65535.`)
  }
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`invalid ${context} "${raw}": expected an integer 1-65535.`)
  }
  return port
}

/** `--peer` accepts IP literals only: `1.2.3.4`, `1.2.3.4:24816`, `[::1]:24816`. */
function parsePeerSpec(spec: string): ManualPeer {
  let host: string
  let portRaw: string | undefined
  const bracketed = spec.match(/^\[([^\]]+)\](?::(.*))?$/)
  if (bracketed) {
    host = bracketed[1]!
    portRaw = bracketed[2]
  } else {
    const colons = spec.split(":").length - 1
    if (colons > 1) {
      throw new UsageError(`invalid --peer "${spec}": wrap IPv6 addresses in brackets, e.g. --peer [::1]:24816.`)
    }
    const idx = spec.indexOf(":")
    if (idx >= 0) {
      host = spec.slice(0, idx)
      portRaw = spec.slice(idx + 1)
    } else {
      host = spec
    }
  }
  if (!isIP(host)) {
    throw new UsageError(`invalid --peer "${spec}": the host must be an IP address (e.g. 192.168.1.5 or [::1]:24816), not a name.`)
  }
  const port = portRaw === undefined ? DEFAULT_PORT : parsePort(portRaw, `port in --peer "${spec}"`)
  return { host, port }
}

export function parseArgs(
  args: string[],
  env: Record<string, string | undefined> = {},
  makeAliasSuffix: () => string = randomAliasSuffix,
): CliOptions {
  const values = new Map<string, string>()
  const peerSpecs: string[] = []
  let realFlag: boolean | undefined
  let showHelp = false
  let showVersion = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "-h") {
      showHelp = true
      continue
    }
    if (!arg.startsWith("--")) {
      throw new UsageError(`unexpected argument "${arg}". Run with --help for usage.`)
    }
    const eq = arg.indexOf("=")
    const name = eq >= 0 ? arg.slice(0, eq) : arg
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined

    if (name === "--help") {
      showHelp = true
      continue
    }
    if (name === "--version") {
      showVersion = true
      continue
    }
    if (name === "--real") {
      if (inline === undefined) {
        realFlag = true
      } else if (isTruthyFlag(inline)) {
        realFlag = true
      } else if (["0", "false", "no", "off"].includes(inline.trim().toLowerCase())) {
        realFlag = false
      } else {
        throw new UsageError(`invalid --real value "${inline}": use --real, or --real=0 / --real=1.`)
      }
      continue
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new UsageError(`unknown flag "${name}". Run with --help for usage.`)
    }
    let value = inline
    if (value === undefined) {
      const next = args[i + 1]
      if (next === undefined || next.startsWith("--") || next === "-h") {
        throw new UsageError(`flag "${name}" requires a value. Run with --help for usage.`)
      }
      value = next
      i++
    }
    if (value === "") {
      throw new UsageError(`flag "${name}" requires a value. Run with --help for usage.`)
    }
    if (name === "--peer") peerSpecs.push(value)
    else values.set(name, value)
  }

  const realMode = realFlag ?? (env.SYNCWEAVE_MODE !== undefined
    && (env.SYNCWEAVE_MODE.trim().toLowerCase() === "real" || isTruthyFlag(env.SYNCWEAVE_MODE)))

  if (showHelp || showVersion) {
    return {
      realMode,
      alias: "syncweave",
      tcpPort: DEFAULT_PORT,
      bindAddr: "::",
      bindExplicit: false,
      rootDir: null,
      manualPeers: [],
      showHelp,
      showVersion,
    }
  }

  const aliasRaw = values.get("--alias")
  let alias: string
  if (aliasRaw !== undefined) {
    alias = aliasRaw.trim()
    if (alias.length === 0 || alias.length > MAX_ALIAS_CHARS || /[\u0000-\u001f\u007f]/.test(alias)) {
      throw new UsageError(`invalid --alias "${aliasRaw}": use 1-${MAX_ALIAS_CHARS} printable characters.`)
    }
  } else {
    alias = `syncweave-${makeAliasSuffix()}`
  }

  const tcpPort = parsePort(values.get("--port") ?? String(DEFAULT_PORT), "--port value")

  const bindRaw = values.get("--bind")
  const bindAddr = bindRaw ?? "::"

  const rootDir = values.get("--root") ?? null
  if (rootDir !== null && /[\u0000-\u001f\u007f]/.test(rootDir)) {
    throw new UsageError(`invalid --root "${rootDir}": control characters are not allowed.`)
  }

  const manualPeers = peerSpecs.map(parsePeerSpec)

  return {
    realMode,
    alias,
    tcpPort,
    bindAddr,
    bindExplicit: bindRaw !== undefined,
    rootDir,
    manualPeers,
    showHelp: false,
    showVersion: false,
  }
}
