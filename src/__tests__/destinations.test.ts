import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { resetLogPathForTests } from "../services/diagnostic-log.js"
import {
  addDestination,
  cycleDestinationIndex,
  loadDestinations,
  loadDestinationsDetailed,
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
  const other = await mkdtemp(join(tmpdir(), "sw-dest-other-"))
  const third = await mkdtemp(join(tmpdir(), "sw-dest-third-"))
  await writeFile(
    join(stateHome, "syncweave", "destinations.json"),
    JSON.stringify([other, DEFAULT, other, 42, null, "", third]),
  )
  expect(loadDestinations(DEFAULT)).toEqual([DEFAULT, other, third])
  await rm(other, { recursive: true, force: true })
  await rm(third, { recursive: true, force: true })
})

test("saveDestinations round-trips through loadDestinations", async () => {
  const a = await mkdtemp(join(tmpdir(), "sw-dest-a-"))
  const b = await mkdtemp(join(tmpdir(), "sw-dest-b-"))
  saveDestinations([DEFAULT, a, b])
  expect(loadDestinations(DEFAULT)).toEqual([DEFAULT, a, b])
  await rm(a, { recursive: true, force: true })
  await rm(b, { recursive: true, force: true })
})

test("validateDestinationPath: empty and control chars rejected", () => {
  expect(validateDestinationPath("   ").ok).toBe(false)
  expect(validateDestinationPath("/tmp/a\u0000b").ok).toBe(false)
  expect(validateDestinationPath("/tmp/a\u001bb").ok).toBe(false)
})

test("validateDestinationPath: existing dir accepted; missing dir is not created without the create flag", async () => {
  const existing = await mkdtemp(join(tmpdir(), "sw-dest-"))
  const ok = validateDestinationPath(existing)
  expect(ok.ok).toBe(true)
  if (ok.ok) expect(ok.dir).toBe(existing)

  const missing = join(stateHome, "new", "nested", "dir")
  const refused = validateDestinationPath(missing)
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.reason).toMatch(/does not exist/)
  await expect(stat(missing)).rejects.toThrow()
  await rm(existing, { recursive: true, force: true })
})

test("validateDestinationPath: create flag only creates directories under $HOME", async () => {
  const missing = join(stateHome, "new")
  const refused = validateDestinationPath(missing, { create: true })
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.reason).toMatch(/under your home directory/)
  await expect(stat(missing)).rejects.toThrow()

  const underHome = join(homedir(), `syncweave-dest-test-${process.pid}-${Date.now()}`)
  try {
    const created = validateDestinationPath(underHome, { create: true })
    expect(created.ok).toBe(true)
    if (created.ok) {
      expect(created.dir).toBe(underHome)
      expect((await stat(underHome)).isDirectory()).toBe(true)
    }
  } finally {
    await rm(underHome, { recursive: true, force: true })
  }
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
  const keep = await mkdtemp(join(tmpdir(), "sw-dest-keep-"))
  await writeFile(join(stateHome, "syncweave", "destinations.json"), "garbage")
  expect(loadDestinations(DEFAULT)).toEqual([DEFAULT])
  saveDestinations([DEFAULT, keep])
  expect(loadDestinations(DEFAULT)).toEqual([DEFAULT, keep])
  const raw = await readFile(join(stateHome, "syncweave", "destinations.json"), "utf8")
  expect(JSON.parse(raw)).toEqual([DEFAULT, keep])
  await rm(keep, { recursive: true, force: true })
})

test("loadDestinations drops persisted entries that no longer validate, with a reason", async () => {
  const valid = await mkdtemp(join(tmpdir(), "sw-dest-valid-"))
  const gone = join(tmpdir(), `sw-dest-gone-${process.pid}-${Date.now()}`)
  await writeFile(
    join(stateHome, "syncweave", "destinations.json"),
    JSON.stringify([gone, "/etc", "relative/dir", valid]),
  )
  const loaded = loadDestinationsDetailed(DEFAULT)
  expect(loaded.dests).toEqual([DEFAULT, valid])
  expect(loaded.dropped.map((entry) => entry.path)).toEqual([gone, "/etc", "relative/dir"])
  expect(loaded.dropped[0]!.reason).toMatch(/does not exist/)
  expect(loaded.dropped[1]!.reason).toMatch(/system directory/)
  expect(loaded.dropped[2]!.reason).toMatch(/absolute/)
  await rm(valid, { recursive: true, force: true })
})
