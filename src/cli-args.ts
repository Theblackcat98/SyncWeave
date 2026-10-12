/**
 * CLI argument parsing for SyncWeave. Extracted from main.ts so it can be
 * unit-tested (P1-46). All validation errors throw CliError with a message
 * suitable for stderr; main.ts catches and exits.
 */
export class CliError extends Error {}

export interface ManualPeer {
  host: string
  port: number
}

export interface CliOptions {
  realMode: boolean
  alias: string
  tcpPort: number
  bindAddr: string
  manualPeers: ManualPeer[]
  /** Non-fatal warnings (e.g. skipped --peer values) for stderr. */
  warnings: string[]
  showHelp: boolean
  showVersion: boolean
}

const KNOWN_FLAGS = new Set(["--real", "--alias", "--port", "--peer", "--bind", "--help", "-h", "--version"])
const FLAGS_WITH_VALUE = new Set(["--alias", "--port", "--peer", "--bind"])

export function parseArgs(args: string[], env: Record<string, string | undefined> = {}): CliOptions {
  const showHelp = args.includes("--help") || args.includes("-h")
  const showVersion = args.includes("--version")
  if (showHelp || showVersion) {
    return {
      realMode: false,
      alias: env.USER ?? "syncweave",
      tcpPort: 24816,
      bindAddr: "::",
      manualPeers: [],
      warnings: [],
      showHelp,
      showVersion,
    }
  }

  // Strict flag parsing: reject unknown --flags and flag values that look
  // like flags (catches typos and misordered arguments).
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith("--") || arg === "--") continue
    const name = arg.split("=")[0]!
    if (!KNOWN_FLAGS.has(name)) {
      throw new CliError(`unknown flag "${arg}". Run with --help for usage.`)
    }
    if (FLAGS_WITH_VALUE.has(name)) {
      const inline = arg.includes("=")
      const next = args[i + 1]
      if (!inline && (!next || next.startsWith("--"))) {
        throw new CliError(`flag "${name}" requires a value. Run with --help for usage.`)
      }
    }
  }

  const realMode = args.includes("--real") || env.SYNCWEAVE_MODE === "real"
  const aliasArg = args.indexOf("--alias")
  const alias = aliasArg >= 0 && args[aliasArg + 1] ? args[aliasArg + 1]! : (env.USER ?? "syncweave")
  const portArg = args.indexOf("--port")
  const tcpPortRaw = portArg >= 0 && args[portArg + 1] ? args[portArg + 1]! : "24816"
  const tcpPort = parseInt(tcpPortRaw, 10)
  if (!Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
    throw new CliError(`invalid --port value "${tcpPortRaw}": expected an integer 1-65535.`)
  }
  const bindArg = args.indexOf("--bind")
  const bindAddr = bindArg >= 0 && args[bindArg + 1] ? args[bindArg + 1]! : "::"

  const manualPeers: ManualPeer[] = []
  const warnings: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--peer" && args[i + 1]) {
      const spec = args[i + 1]!
      let host: string | undefined
      let portStr: string | undefined
      const bracketed = spec.match(/^\[([^\]]+)\](?::(\d+))?$/)
      if (bracketed) {
        host = bracketed[1]
        portStr = bracketed[2]
      } else if ((spec.match(/:/g) ?? []).length > 1) {
        warnings.push(`invalid --peer value "${spec}": wrap IPv6 addresses in brackets, e.g. --peer [::1]:24816. Skipping.`)
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
        warnings.push(`invalid --peer value "${spec}": expected host[:port] with port 1-65535. Skipping.`)
        continue
      }
      manualPeers.push({ host, port })
    }
  }

  return { realMode, alias, tcpPort, bindAddr, manualPeers, warnings, showHelp: false, showVersion: false }
}
