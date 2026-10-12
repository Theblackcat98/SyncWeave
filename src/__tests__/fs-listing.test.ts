import { afterEach, beforeEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RealFileSystemService } from "../services/real-filesystem.js"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "syncweave-fs-listing-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("P1-24: an unreadable or missing folder records the error text", () => {
  const fs = new RealFileSystemService(dir)
  const missing = join(dir, "no-such-folder")
  expect(fs.list("local", missing)).toEqual([])
  expect(fs.listError()).not.toBeNull()
  expect(fs.listError()).toMatch(/ENOENT/)
  expect(fs.lastListError).toMatch(/ENOENT/)
  expect(fs.listTotal()).toBe(0)

  // A file used as a folder is also an error, not an empty folder.
  const file = join(dir, "plain.txt")
  writeFileSync(file, "x")
  expect(fs.list("local", file)).toEqual([])
  expect(fs.listError()).toMatch(/ENOTDIR/)

  // A readable folder clears the error.
  expect(fs.list("local", dir)).toHaveLength(1)
  expect(fs.listError()).toBeNull()
})

test("symlink entries expose their readlink target and stay unsupported", () => {
  writeFileSync(join(dir, "target.txt"), "data")
  symlinkSync(join(dir, "target.txt"), join(dir, "to-file"))
  symlinkSync("/dev/zero", join(dir, "to-device"))
  const byName = new Map(new RealFileSystemService(dir).list("local", dir).map((entry) => [entry.name, entry]))
  expect(byName.get("to-file")?.unsupported).toBe("symlink")
  expect(byName.get("to-file")?.symlinkTarget).toBe(join(dir, "target.txt"))
  expect(byName.get("to-device")?.symlinkTarget).toBe("/dev/zero")
  expect(byName.get("target.txt")?.unsupported).toBeUndefined()
})

test("special files (FIFO) stay unsupported and carry no symlink target", () => {
  const fifo = join(dir, "pipe")
  const made = spawnSync("mkfifo", [fifo])
  if (made.status !== 0) return // mkfifo unavailable on this host
  const entry = new RealFileSystemService(dir).list("local", dir).find((candidate) => candidate.name === "pipe")
  expect(entry?.unsupported).toBe("FIFO")
  expect(entry?.symlinkTarget).toBeUndefined()
})

test("dotfiles are listed by default and hidden by the show-hidden toggle", () => {
  writeFileSync(join(dir, ".dotrc"), "x")
  writeFileSync(join(dir, "visible.txt"), "x")
  const fs = new RealFileSystemService(dir)
  expect(fs.showHidden).toBe(true)
  expect(fs.list("local", dir).map((entry) => entry.name)).toEqual([".dotrc", "visible.txt"])

  fs.setShowHidden(false)
  expect(fs.showHidden).toBe(false)
  expect(fs.list("local", dir).map((entry) => entry.name)).toEqual(["visible.txt"])
  expect(fs.listTotal()).toBe(1)

  const hiddenByOption = new RealFileSystemService(dir, { showHidden: false })
  expect(hiddenByOption.list("local", dir).map((entry) => entry.name)).toEqual(["visible.txt"])
})

test("only staging partials are hidden, even when dotfiles are shown; other .syncweave- names stay visible", () => {
  writeFileSync(join(dir, ".syncweave-0b7ac3a1-2f4e-4d8b-9c1a-7e6f5d4c3b2a.partial"), "x")
  writeFileSync(join(dir, ".syncweave-notes.txt"), "user file")
  writeFileSync(join(dir, ".syncweave-draft.partial.txt"), "user file")
  const names = new RealFileSystemService(dir).list("local", dir).map((entry) => entry.name).sort()
  expect(names).toEqual([".syncweave-draft.partial.txt", ".syncweave-notes.txt"])
})

test("repeated listings reuse cached entries until the directory changes", async () => {
  writeFileSync(join(dir, "a.txt"), "x")
  const fs = new RealFileSystemService(dir)
  const first = fs.list("local", dir)
  const second = fs.list("local", dir)
  expect(second[0]).toBe(first[0])

  // Coarse kernel timestamps need a real gap before a new entry changes the key.
  await Bun.sleep(20)
  writeFileSync(join(dir, "b.txt"), "x")
  const third = fs.list("local", dir)
  expect(third.map((entry) => entry.name)).toEqual(["a.txt", "b.txt"])
  expect(third[0]).not.toBe(first[0])
})

test("paging returns the requested window and the true total", () => {
  for (let i = 0; i < 600; i++) writeFileSync(join(dir, `p-${String(i).padStart(3, "0")}`), "")
  const fs = new RealFileSystemService(dir)
  const page = fs.list("local", dir, { offset: 590, limit: 50 })
  expect(page.map((entry) => entry.name)).toEqual(Array.from({ length: 10 }, (_, i) => `p-${String(590 + i).padStart(3, "0")}`))
  expect(fs.listTotal()).toBe(600)
  expect(fs.list("local", dir, { offset: 9_999 })).toEqual([])
})

test("directories are listed with a trailing slash and symlinked directories stay unsupported", () => {
  mkdirSync(join(dir, "sub"))
  symlinkSync(join(dir, "sub"), join(dir, "link-to-sub"))
  const byName = new Map(new RealFileSystemService(dir).list("local", dir).map((entry) => [entry.name, entry]))
  expect(byName.get("sub/")?.kind).toBe("directory")
  expect(byName.get("link-to-sub")?.unsupported).toBe("symlink")
})
