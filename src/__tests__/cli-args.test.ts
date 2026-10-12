import { describe, expect, test } from "bun:test"
import { CliError, parseArgs, UsageError } from "../cli-args.js"

const fixedSuffix = () => "beef"

describe("parseArgs", () => {
  test("defaults: mock mode, port 24816, IPv6 bind, random per-run alias (never $USER)", () => {
    const opts = parseArgs([], { USER: "nick" }, fixedSuffix)
    expect(opts.realMode).toBe(false)
    expect(opts.alias).toBe("syncweave-beef")
    expect(opts.tcpPort).toBe(24816)
    expect(opts.bindAddr).toBe("::")
    expect(opts.bindExplicit).toBe(false)
    expect(opts.rootDir).toBeNull()
    expect(opts.manualPeers).toEqual([])
  })

  test("default alias is a random syncweave-XXXX label per run", () => {
    const a = parseArgs([], {}).alias
    expect(a).toMatch(/^syncweave-[0-9a-f]{4}$/)
  })

  test("--real and --alias and --port (space form)", () => {
    const opts = parseArgs(["--real", "--alias", "laptop1", "--port", "24818"], {})
    expect(opts.realMode).toBe(true)
    expect(opts.alias).toBe("laptop1")
    expect(opts.tcpPort).toBe(24818)
  })

  test("--flag=value form works for every value flag", () => {
    const opts = parseArgs(["--real", "--alias=bob", "--port=24818", "--peer=10.0.0.5:24816", "--bind=127.0.0.1", "--root=/tmp"], {})
    expect(opts.alias).toBe("bob")
    expect(opts.tcpPort).toBe(24818)
    expect(opts.manualPeers).toEqual([{ host: "10.0.0.5", port: 24816 }])
    expect(opts.bindAddr).toBe("127.0.0.1")
    expect(opts.bindExplicit).toBe(true)
    expect(opts.rootDir).toBe("/tmp")
  })

  test("--real accepts =1/=true/=0/=false (no silent mock fallback)", () => {
    expect(parseArgs(["--real=1"], {}).realMode).toBe(true)
    expect(parseArgs(["--real=true"], {}).realMode).toBe(true)
    expect(parseArgs(["--real=yes"], {}).realMode).toBe(true)
    expect(parseArgs(["--real=0"], {}).realMode).toBe(false)
    expect(parseArgs(["--real=false"], {}).realMode).toBe(false)
    expect(() => parseArgs(["--real=maybe"], {})).toThrow(UsageError)
  })

  test("--real=0 overrides SYNCWEAVE_MODE=real", () => {
    expect(parseArgs(["--real=0"], { SYNCWEAVE_MODE: "real" }).realMode).toBe(false)
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

  test("bare IPv6 --peer is a usage error (exit 2)", () => {
    let caught: unknown
    try {
      parseArgs(["--peer", "::1"], {})
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UsageError)
    expect((caught as UsageError).exitCode).toBe(2)
    expect((caught as Error).message).toContain("brackets")
  })

  test("--peer host must be an IP literal, not a name", () => {
    expect(() => parseArgs(["--peer", "localhost:24816"], {})).toThrow(UsageError)
    expect(() => parseArgs(["--peer", "not-a-host"], {})).toThrow(/IP address/)
  })

  test("--peer port must be digits in range", () => {
    expect(() => parseArgs(["--peer", "10.0.0.2:24816abc"], {})).toThrow(UsageError)
    expect(() => parseArgs(["--peer", "10.0.0.2:0"], {})).toThrow(UsageError)
    expect(() => parseArgs(["--peer", "10.0.0.2:70000"], {})).toThrow(UsageError)
    expect(() => parseArgs(["--peer", "10.0.0.2:"], {})).toThrow(UsageError)
  })

  test("unknown flag throws", () => {
    expect(() => parseArgs(["--bogus"], {})).toThrow(CliError)
    expect(() => parseArgs(["--reall"], {})).toThrow(UsageError)
  })

  test("unexpected positional argument is a usage error", () => {
    expect(() => parseArgs(["stray"], {})).toThrow(UsageError)
  })

  test("flag without value throws", () => {
    expect(() => parseArgs(["--alias"], {})).toThrow(UsageError)
    expect(() => parseArgs(["--alias", "--port"], {})).toThrow(UsageError)
    expect(() => parseArgs(["--alias="], {})).toThrow(UsageError)
  })

  test("ports must be digits only and in 1..65535", () => {
    expect(() => parseArgs(["--port", "abc"], {})).toThrow(UsageError)
    expect(() => parseArgs(["--port", "24816abc"], {})).toThrow(UsageError)
    expect(() => parseArgs(["--port", "1e3"], {})).toThrow(UsageError)
    expect(() => parseArgs(["--port", "24816.9"], {})).toThrow(UsageError)
    expect(() => parseArgs(["--port", "0"], {})).toThrow(UsageError)
    expect(() => parseArgs(["--port", "99999"], {})).toThrow(UsageError)
    expect(parseArgs(["--port", "65535"], {}).tcpPort).toBe(65535)
  })

  test("usage errors carry exit code 2", () => {
    try {
      parseArgs(["--port", "abc"], {})
      throw new Error("expected a throw")
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError)
      expect((error as UsageError).exitCode).toBe(2)
    }
  })

  test("empty or control-character alias is rejected", () => {
    expect(() => parseArgs(["--alias", "   "], {})).toThrow(UsageError)
    expect(() => parseArgs(["--alias", "a\u001bb"], {})).toThrow(UsageError)
  })

  test("empty USER does not produce an empty alias", () => {
    expect(parseArgs([], { USER: "" }, fixedSuffix).alias).toBe("syncweave-beef")
  })

  test("--help and --version short-circuit", () => {
    expect(parseArgs(["--help"], {}).showHelp).toBe(true)
    expect(parseArgs(["-h"], {}).showHelp).toBe(true)
    expect(parseArgs(["--version"], {}).showVersion).toBe(true)
  })

  test("--bind", () => {
    const opts = parseArgs(["--bind", "127.0.0.1"], {})
    expect(opts.bindAddr).toBe("127.0.0.1")
    expect(opts.bindExplicit).toBe(true)
  })

  test("--root sets the Local pane start directory", () => {
    expect(parseArgs(["--root", "/srv/share"], {}).rootDir).toBe("/srv/share")
    expect(parseArgs([], {}).rootDir).toBeNull()
  })
})
