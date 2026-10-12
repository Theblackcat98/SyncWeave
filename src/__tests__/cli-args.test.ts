import { describe, expect, test } from "bun:test"
import { CliError, parseArgs } from "../cli-args.js"

describe("parseArgs", () => {
  test("defaults", () => {
    const opts = parseArgs([], { USER: "nick" })
    expect(opts.realMode).toBe(false)
    expect(opts.alias).toBe("nick")
    expect(opts.tcpPort).toBe(24816)
    expect(opts.bindAddr).toBe("::")
    expect(opts.manualPeers).toEqual([])
  })

  test("--real and --alias and --port", () => {
    const opts = parseArgs(["--real", "--alias", "laptop1", "--port", "24818"], {})
    expect(opts.realMode).toBe(true)
    expect(opts.alias).toBe("laptop1")
    expect(opts.tcpPort).toBe(24818)
  })

  test("SYNCWEAVE_MODE=real enables real mode", () => {
    expect(parseArgs([], { SYNCWEAVE_MODE: "real" }).realMode).toBe(true)
  })

  test("--peer parsing", () => {
    const opts = parseArgs(["--peer", "192.168.1.5:24816", "--peer", "10.0.0.2"], {})
    expect(opts.manualPeers).toEqual([
      { host: "192.168.1.5", port: 24816 },
      { host: "10.0.0.2", port: 24816 },
    ])
  })

  test("--peer bracketed IPv6", () => {
    const opts = parseArgs(["--peer", "[::1]:24816"], {})
    expect(opts.manualPeers).toEqual([{ host: "::1", port: 24816 }])
  })

  test("bare IPv6 --peer warns and skips", () => {
    const opts = parseArgs(["--peer", "::1"], {})
    expect(opts.manualPeers).toEqual([])
    expect(opts.warnings.length).toBe(1)
    expect(opts.warnings[0]).toContain("brackets")
  })

  test("unknown flag throws", () => {
    expect(() => parseArgs(["--bogus"], {})).toThrow(CliError)
  })

  test("flag without value throws", () => {
    expect(() => parseArgs(["--alias"], {})).toThrow(CliError)
    expect(() => parseArgs(["--alias", "--port"], {})).toThrow(CliError)
  })

  test("invalid port throws", () => {
    expect(() => parseArgs(["--port", "abc"], {})).toThrow(CliError)
    expect(() => parseArgs(["--port", "0"], {})).toThrow(CliError)
    expect(() => parseArgs(["--port", "99999"], {})).toThrow(CliError)
  })

  test("--help and --version short-circuit", () => {
    expect(parseArgs(["--help"], {}).showHelp).toBe(true)
    expect(parseArgs(["-h"], {}).showHelp).toBe(true)
    expect(parseArgs(["--version"], {}).showVersion).toBe(true)
  })

  test("--bind", () => {
    expect(parseArgs(["--bind", "127.0.0.1"], {}).bindAddr).toBe("127.0.0.1")
  })
})
