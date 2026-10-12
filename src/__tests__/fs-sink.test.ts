import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, mock, test } from "bun:test"

// Fail unlink() on temporary partials after a successful publish. Passes every
// other call through to the real implementation.
let unlinkFault: "none" | "always" | "once" = "none"
let unlinkFaults = 0
mock.module("node:fs/promises", () => {
  const actual = require("node:fs/promises")
  return {
    ...actual,
    unlink: async (path: unknown, ...rest: unknown[]) => {
      if (unlinkFault !== "none" && /\/\.syncweave-[^/]*\.partial$/.test(String(path))) {
        if (unlinkFault === "always" || unlinkFaults === 0) {
          unlinkFaults += 1
          const error = new Error("EBUSY: injected unlink failure") as Error & { code: string }
          error.code = "EBUSY"
          throw error
        }
      }
      return actual.unlink(path, ...rest)
    },
  }
})

const sink = await import("../services/safe-receive-sink.js")
const { previewSavedName, receiveToFile, sanitizePeerBasename, sweepOrphanPartials } = sink

const directories: string[] = []

afterEach(async () => {
  unlinkFault = "none"
  unlinkFaults = 0
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "sw-fs-sink-"))
  directories.push(path)
  return path
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes
}

function optionsFor(directory: string, peerFileName: string, bytes: Uint8Array) {
  return {
    destinationDirectory: directory,
    peerFileName,
    maxBytes: Math.max(bytes.byteLength, 1),
    maxNameBytes: 255,
    expectedBytes: bytes.byteLength,
    expectedSha256: digest(bytes),
  }
}

function partialsIn(entries: string[]): string[] {
  return entries.filter((entry) => entry.startsWith(".syncweave-") && entry.endsWith(".partial"))
}

/** A pid that is certainly not running: a child that has already exited and been reaped. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"])
  return child.pid!
}

test("staging partials are named with the owning process id", async () => {
  const directory = await makeDirectory()
  const bytes = new Uint8Array([1, 2, 3])
  let observed: string[] = []
  async function* gated(): AsyncGenerator<Uint8Array> {
    observed = partialsIn(await readdir(directory))
    yield bytes
  }
  await receiveToFile(gated(), optionsFor(directory, "owned.bin", bytes))
  expect(observed).toHaveLength(1)
  expect(observed[0]!.startsWith(`.syncweave-${process.pid}-`)).toBe(true)
})

test("sweep keeps a partial whose owner is alive and removes one whose owner is dead", async () => {
  const directory = await makeDirectory()
  const livePath = join(directory, `.syncweave-${process.pid}-0b7ac3a1-2f4e-4d8b-9c1a-7e6f5d4c3b2a.partial`)
  const deadPath = join(directory, `.syncweave-${deadPid()}-0b7ac3a1-2f4e-4d8b-9c1a-7e6f5d4c3b2a.partial`)
  await writeFile(livePath, "live receive in progress")
  await writeFile(deadPath, "orphan from a killed session")

  expect(await sweepOrphanPartials(directory)).toBe(1)
  expect(await readFile(livePath, "utf8")).toBe("live receive in progress")
  await expect(readFile(deadPath)).rejects.toThrow()
})

test("sweep keeps a partial owned by another live instance (pid 1 is always alive)", async () => {
  const directory = await makeDirectory()
  const otherInstance = join(directory, `.syncweave-1-0b7ac3a1-2f4e-4d8b-9c1a-7e6f5d4c3b2a.partial`)
  await writeFile(otherInstance, "another instance is writing this")
  expect(await sweepOrphanPartials(directory)).toBe(0)
  expect(await readFile(otherInstance, "utf8")).toBe("another instance is writing this")
})

test("sweep removes legacy partials only once they are an hour old", async () => {
  const directory = await makeDirectory()
  const legacyStale = join(directory, ".syncweave-0b7ac3a1-2f4e-4d8b-9c1a-7e6f5d4c3b2a.partial")
  const legacyFresh = join(directory, ".syncweave-9f8e7d6c-1111-4222-8333-944455556666.partial")
  const unparseable = join(directory, ".syncweave-garbage.partial")
  await writeFile(legacyStale, "old")
  await writeFile(legacyFresh, "new")
  await writeFile(unparseable, "old")
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(legacyStale, twoHoursAgo, twoHoursAgo)
  await utimes(unparseable, twoHoursAgo, twoHoursAgo)

  expect(await sweepOrphanPartials(directory)).toBe(2)
  await expect(readFile(legacyStale)).rejects.toThrow()
  await expect(readFile(unparseable)).rejects.toThrow()
  expect(await readFile(legacyFresh, "utf8")).toBe("new")
})

test("sweep never touches files that are not staging partials", async () => {
  const directory = await makeDirectory()
  const names = ["notes.txt", ".syncweave-notes.txt", "partial.partial", ".hidden.partial"]
  for (const name of names) await writeFile(join(directory, name), "keep")
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  for (const name of names) await utimes(join(directory, name), old, old)

  expect(await sweepOrphanPartials(directory)).toBe(0)
  expect((await readdir(directory)).sort()).toEqual([...names].sort())
})

test("a successful publish is reported as success even if temp cleanup keeps failing", async () => {
  const directory = await makeDirectory()
  const bytes = new TextEncoder().encode("verified payload\n".repeat(50))
  unlinkFault = "always"

  const result = await receiveToFile(once(bytes), optionsFor(directory, "keep.txt", bytes))
  expect(result.name).toBe("keep.txt")
  expect(result.bytes).toBe(bytes.byteLength)
  expect(Array.from(await readFile(join(directory, "keep.txt")))).toEqual(Array.from(bytes))
  // The leftover temp name is a duplicate of the final bytes, not the result.
  expect(partialsIn(await readdir(directory))).toHaveLength(1)
})

test("a transient temp-cleanup failure after publish is retried and leaves no duplicate", async () => {
  const directory = await makeDirectory()
  const bytes = new TextEncoder().encode("second payload")
  unlinkFault = "once"

  const result = await receiveToFile(once(bytes), optionsFor(directory, "retried.txt", bytes))
  expect(result.name).toBe("retried.txt")
  expect(await readdir(directory)).toEqual(["retried.txt"])
})

test("a failed temp cleanup before publish is still reported as a failure", async () => {
  const directory = await makeDirectory()
  const bytes = new Uint8Array([1, 2, 3])
  // Source fails so the receive never publishes; cleanup then fails too.
  async function* failing(): AsyncGenerator<Uint8Array> {
    yield bytes
    throw new Error("synthetic source failure")
  }
  unlinkFault = "always"
  await expect(receiveToFile(failing(), optionsFor(directory, "never.bin", bytes))).rejects.toBeInstanceOf(AggregateError)
  await expect(readFile(join(directory, "never.bin"))).rejects.toThrow()
})

test("sanitizer strips the whole Unicode Format category, not only the bidi and zero-width subset", () => {
  expect(sanitizePeerBasename("invoice‮fdp.exe", 255)).toBe("invoicefdp.exe")
  expect(sanitizePeerBasename("a­b.txt", 255)).toBe("ab.txt")
  expect(sanitizePeerBasename("a⁠b.txt", 255)).toBe("ab.txt")
  expect(sanitizePeerBasename("a᠎b.txt", 255)).toBe("ab.txt")
  expect(sanitizePeerBasename("a\u{E0001}b.txt", 255)).toBe("ab.txt")
  expect(sanitizePeerBasename("a؀b.txt", 255)).toBe("ab.txt")
  expect(sanitizePeerBasename("a b.txt", 255)).toBe("ab.txt")
  // Format characters ahead of a leading dot must not hide it.
  expect(sanitizePeerBasename("​.env", 255)).toBe("env")
  expect(() => sanitizePeerBasename("​⁠", 255)).toThrow(TypeError)
})

test("previewSavedName returns exactly the basename the sink saves, before any collision suffix", async () => {
  const directory = await makeDirectory()
  const names = ["invoice‮fdp.exe", "..\\..\\hostile.txt", "CON.txt", "a­b​.pdf", "x".repeat(300) + ".txt"]
  for (const peerName of names) {
    const bytes = new TextEncoder().encode(`bytes for ${peerName.length}`)
    const preview = previewSavedName(peerName, 255)
    const saved = await receiveToFile(once(bytes), optionsFor(directory, peerName, bytes))
    expect(preview).not.toBeNull()
    expect(saved.name).toBe(preview!)
  }
})

test("previewSavedName returns null for names the sink would reject, and honours the byte bound", () => {
  expect(previewSavedName("../..")).toBeNull()
  expect(previewSavedName("​")).toBeNull()
  expect(previewSavedName("CONtents.txt", 3)).toBeNull()
  expect(previewSavedName("CON.txt")).toBe("_CON.txt")
  expect(new TextEncoder().encode(previewSavedName("y".repeat(400), 255)!).byteLength).toBeLessThanOrEqual(255)
})
