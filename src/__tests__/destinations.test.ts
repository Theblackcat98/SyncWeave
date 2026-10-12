import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { resetLogPathForTests } from "../services/diagnostic-log.js"
import {
  addDestination,
  cycleDestinationIndex,
  loadDestinations,
  removeDestination,
  saveDestinations,
  validateDestinationPath,
} from "../services/destinations.js"

let stateHome: string

beforeEach(async () => {
  stateHome = await mkdtemp(join(tmpdir(), "sw-state-"))
  await mkdir(join(stateHome, "syncweave"), { recursive: true })
  process.env.XDG_STATE_HOME = stateHome
  resetLogPathForTests()
})

afterEach(async () => {
  delete process.env.XDG_STATE_HOME
  resetLogPathForTests()
  await rm(stateHome, { recursive: true, force: true })
})

const DEFAULT = "/home/test/Downloads"

test("loadDestinations: missing file → default only", () => {
  expect(loadDestinations(DEFAULT)).toEqual([DEFAULT])
})

test("loadDestinations: corrupt JSON → default only", async () => {
  await writeFile(join(stateHome, "syncweave", "destinations.json"), "{not json")
  expect(loadDestinations(DEFAULT)).toEqual([DEFAULT])
})

test("loadDestinations: non-array JSON → default only", async () => {
  await writeFile(join(stateHome, "syncweave", "destinations.json"), JSON.stringify({ a: 1 }))
  expect(loadDestinations(DEFAULT)).toEqual([DEFAULT])
})

test("loadDestinations: default always first, duplicates dropped, junk filtered", async () => {
  await writeFile(
    join(stateHome, "syncweave", "destinations.json"),
    JSON.stringify(["/tmp/other", DEFAULT, "/tmp/other", 42, null, "", "/tmp/third"]),
  )
  expect(loadDestinations(DEFAULT)).toEqual([DEFAULT, "/tmp/other", "/tmp/third"])
})

test("saveDestinations round-trips through loadDestinations", () => {
  saveDestinations([DEFAULT, "/tmp/a", "/tmp/b"])
  expect(loadDestinations(DEFAULT)).toEqual([DEFAULT, "/tmp/a", "/tmp/b"])
})

test("validateDestinationPath: empty and control chars rejected", () => {
  expect(validateDestinationPath("   ").ok).toBe(false)
  expect(validateDestinationPath("/tmp/a\u0000b").ok).toBe(false)
  expect(validateDestinationPath("/tmp/a\u001bb").ok).toBe(false)
})

test("validateDestinationPath: existing dir accepted, missing dir created", async () => {
  const existing = await mkdtemp(join(tmpdir(), "sw-dest-"))
  const ok = validateDestinationPath(existing)
  expect(ok.ok).toBe(true)
  if (ok.ok) expect(ok.dir).toBe(existing)

  const missing = join(stateHome, "new", "nested", "dir")
  const created = validateDestinationPath(missing)
  expect(created.ok).toBe(true)
  if (created.ok) {
    expect(created.dir).toBe(missing)
    // Created with mode 0700 like ~/Downloads.
    const { stat } = await import("node:fs/promises")
    expect((await stat(missing)).isDirectory()).toBe(true)
  }
  await rm(existing, { recursive: true, force: true })
})

test("validateDestinationPath: file (not dir) rejected", async () => {
  const file = join(stateHome, "afile")
  await writeFile(file, "x")
  const r = validateDestinationPath(file)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason).toMatch(/not a directory/)
})

test("validateDestinationPath: ~/ expands to home", () => {
  const r = validateDestinationPath("~/")
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.dir).toBe(homedir())
})

test("addDestination: appends, dedupes", () => {
  expect(addDestination([DEFAULT], "/tmp/a")).toEqual([DEFAULT, "/tmp/a"])
  expect(addDestination([DEFAULT, "/tmp/a"], "/tmp/a")).toEqual([DEFAULT, "/tmp/a"])
})

test("removeDestination: default protected, last protected, middle removable", () => {
  const r0 = removeDestination([DEFAULT], 0)
  expect(r0.removed).toBeNull()
  expect(r0.reason).toMatch(/default/)

  const r1 = removeDestination([DEFAULT, "/tmp/a", "/tmp/b"], 0)
  expect(r1.removed).toBeNull()

  const r2 = removeDestination([DEFAULT], 0)
  expect(r2.removed).toBeNull()

  const r3 = removeDestination([DEFAULT, "/tmp/a", "/tmp/b"], 1)
  expect(r3.removed).toBe("/tmp/a")
  expect(r3.dests).toEqual([DEFAULT, "/tmp/b"])

  const r4 = removeDestination([DEFAULT, "/tmp/a"], 5)
  expect(r4.removed).toBeNull()
})

test("cycleDestinationIndex: wraps around, empty list safe", () => {
  expect(cycleDestinationIndex(0, 3)).toBe(1)
  expect(cycleDestinationIndex(2, 3)).toBe(0)
  expect(cycleDestinationIndex(0, 1)).toBe(0)
  expect(cycleDestinationIndex(0, 0)).toBe(0)
})

test("persistence survives a corrupt-then-save cycle", async () => {
  await writeFile(join(stateHome, "syncweave", "destinations.json"), "garbage")
  expect(loadDestinations(DEFAULT)).toEqual([DEFAULT])
  saveDestinations([DEFAULT, "/tmp/keep"])
  expect(loadDestinations(DEFAULT)).toEqual([DEFAULT, "/tmp/keep"])
  const raw = await readFile(join(stateHome, "syncweave", "destinations.json"), "utf8")
  expect(JSON.parse(raw)).toEqual([DEFAULT, "/tmp/keep"])
})
