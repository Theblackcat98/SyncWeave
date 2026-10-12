import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createSyncWeaveApp, type SyncWeaveApp } from "../app.js"
import { expandHome, MAX_DIRECTORY_ENTRIES, RealFileSystemService } from "../services/real-filesystem.js"
import { MockPeerService } from "../services/mock-peer-service.js"
import { mockDestinations, MockTransferService } from "../services/mock-transfer-service.js"

process.env.SYNCWEAVE_REDUCED_MOTION = "1"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "syncweave-realfs-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function service(): RealFileSystemService {
  return new RealFileSystemService(dir)
}

test("paths expose the configured local root and no remote filesystem", () => {
  const fs = service()
  expect(fs.paths.local).toBe(dir)
  expect(fs.paths.remote).toBe("")
})

test("lists files and directories with real sizes and absolute-path ids", () => {
  writeFileSync(join(dir, "a.txt"), "hello")
  mkdirSync(join(dir, "sub"))
  writeFileSync(join(dir, "sub", "b.txt"), "0123456789")
  const entries = service().list("local", dir)
  expect(entries.map((entry) => entry.name).sort()).toEqual(["a.txt", "sub/"])
  const file = entries.find((entry) => entry.name === "a.txt")!
  expect(file.kind).toBe("file")
  expect(file.bytes).toBe(5)
  expect(file.id).toBe(join(dir, "a.txt"))
  expect(file.state).toBe("synced")
  const sub = entries.find((entry) => entry.name === "sub/")!
  expect(sub.kind).toBe("directory")
  expect(sub.bytes).toBe(0)
})

test("symlinks are listed as files and never followed", () => {
  mkdirSync(join(dir, "realdir"))
  writeFileSync(join(dir, "realdir", "inner.txt"), "data")
  symlinkSync(join(dir, "realdir"), join(dir, "linkdir"))
  symlinkSync(join(dir, "target.txt"), join(dir, "linkfile"))
  symlinkSync(join(dir, "does-not-exist"), join(dir, "dangling"))
  const entries = service().list("local", dir)
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  // A symlink to a directory is still reported as a file: no cycle traversal.
  expect(byName.get("linkdir")?.kind).toBe("file")
  expect(byName.get("linkdir")?.bytes).toBe(0)
  expect(byName.get("linkfile")?.kind).toBe("file")
  // A dangling symlink lists without throwing.
  expect(byName.get("dangling")?.kind).toBe("file")
  expect(byName.get("dangling")?.bytes).toBe(0)
})

test("parentPath resolves real parents and never escapes the filesystem root", () => {
  const fs = service()
  expect(fs.parentPath(join(dir, "sub"))).toBe(dir)
  expect(fs.parentPath(dir)).toBe(dirnameOf(dir))
  expect(fs.parentPath("/")).toBe("/")
})

function dirnameOf(path: string): string {
  const index = path.lastIndexOf("/")
  return index <= 0 ? "/" : path.slice(0, index)
}

test("unreadable or missing directories list gracefully instead of throwing", () => {
  // A missing directory yields an empty listing, not an exception. (Per-entry
  // lstat failures — vanished files, permission errors — are skipped the
  // same way inside list().)
  expect(service().list("local", join(dir, "no-such-dir"))).toEqual([])
})

test("directory listings are capped instead of failing on huge folders", () => {
  for (let i = 0; i < MAX_DIRECTORY_ENTRIES + 100; i++) {
    writeFileSync(join(dir, `file-${String(i).padStart(4, "0")}.txt`), "x")
  }
  const entries = service().list("local", dir)
  expect(entries).toHaveLength(MAX_DIRECTORY_ENTRIES)
})

test("the remote pane has no filesystem in real mode", () => {
  writeFileSync(join(dir, "a.txt"), "hello")
  expect(service().list("remote", "anything")).toEqual([])
})

test("markSynced is a no-op and getDiff is empty (both out of scope)", () => {
  const fs = service()
  expect(() => fs.markSynced("local", ["whatever"])).not.toThrow()
  expect(fs.getDiff(join(dir, "a.txt"))).toEqual([])
})

test("expandHome resolves leading ~ to the home directory", () => {
  expect(expandHome("~")).toBe(homedir())
  expect(expandHome("~/projects")).toBe(join(homedir(), "projects"))
  expect(expandHome("/absolute/path")).toBe("/absolute/path")
  expect(expandHome("relative/path")).toBe("relative/path")
})

test("constructor expands ~ in the configured root", () => {
  const fs = new RealFileSystemService("~/somewhere")
  expect(fs.paths.local).toBe(join(homedir(), "somewhere"))
})

const open: Array<{ setup: TestRendererSetup; app: SyncWeaveApp }> = []

afterEach(async () => {
  for (const { app, setup } of open.splice(0)) {
    app.dispose()
    await setup.renderer.destroy()
  }
})

test("real mode shows real local files and a receiver status panel instead of remote files", async () => {
  const setup = await createTestRenderer({ width: 120, height: 36 })
  // The filesystem dependency is replaced internally when mode is "real".
  const app = createSyncWeaveApp(setup.renderer, {
    filesystem: service(),
    peerService: new MockPeerService(),
    transferService: new MockTransferService(),
    receiveDestinations: mockDestinations,
    mode: "real",
  })
  open.push({ setup, app })
  await setup.flush()
  const frame = setup.captureCharFrame()
  // Remote pane is a status panel, not a file list.
  expect(frame).toContain("REMOTE RECEIVER")
  expect(frame).not.toContain("REMOTE DESTINATION")
  expect(frame).toContain("not shown")
  // Local pane lists the real home directory (the default root in real mode).
  // We can't assert on specific home contents, so just verify it's not the
  // mock filesystem and not the repo working directory listing.
  expect(frame).not.toContain("architecture-diagram.md")
  expect(frame).toContain("REAL FILES")
  expect(frame).not.toContain("SIMULATION")
})

test("mock mode is unchanged: both panes list mock files", async () => {
  const setup = await createTestRenderer({ width: 120, height: 36 })
  const app = createSyncWeaveApp(setup.renderer, {
    filesystem: service(),
    peerService: new MockPeerService(),
    transferService: new MockTransferService(),
    receiveDestinations: mockDestinations,
  })
  open.push({ setup, app })
  await setup.flush()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("REMOTE DESTINATION")
  expect(frame).not.toContain("REMOTE RECEIVER")
  expect(frame).toContain("SIMULATION")
})
