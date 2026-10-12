import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { validateDestinationPath } from "../services/destinations.js"

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function tempDir(prefix = "sw-fs-dest-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

function reasonOf(raw: string, options?: Parameters<typeof validateDestinationPath>[1]): string {
  const result = validateDestinationPath(raw, options)
  if (result.ok) throw new Error(`expected ${raw} to be refused`)
  return result.reason
}

test("accepts only absolute paths or ~/ for the current user", async () => {
  const dir = await tempDir()
  expect(validateDestinationPath(dir).ok).toBe(true)
  expect(reasonOf("relative/dir")).toMatch(/absolute or start with ~\//)
  expect(reasonOf("./somewhere")).toMatch(/absolute or start with ~\//)
  expect(reasonOf("~otheruser/inbox")).toMatch(/only ~\//)
  expect(reasonOf("~otheruser")).toMatch(/only ~\//)
  // "~" must lead the path; a tilde mid-path is just a relative name.
  expect(reasonOf("/tmp/~/x")).toMatch(/not a directory|does not exist/)
})

test("expands ~/ to the current user's home only", () => {
  const ok = validateDestinationPath("~/")
  expect(ok.ok).toBe(true)
  if (ok.ok) expect(ok.dir).toBe(homedir())
})

test("refuses the filesystem root", () => {
  expect(reasonOf("/")).toMatch(/filesystem root/)
  expect(reasonOf("/../../")).toMatch(/filesystem root/)
})

test("refuses system trees, including their subdirectories", () => {
  for (const path of ["/etc", "/etc/ssh", "/bin", "/sbin", "/usr", "/usr/local/share", "/boot", "/dev", "/proc/self", "/sys", "/lib", "/lib64", "/lib/modules", "/var", "/var/log"]) {
    expect(reasonOf(path)).toMatch(/system directory/)
  }
})

test("allows /var/tmp, which is writable scratch space", async () => {
  const sub = join("/var/tmp", `sw-fs-dest-${process.pid}-${Date.now()}`)
  await mkdir(sub, { mode: 0o700 })
  cleanup.push(sub)
  expect(validateDestinationPath(sub).ok).toBe(true)
})

test("refuses /root unless it is the current home directory", async () => {
  if (homedir() === "/root") {
    // Running as root: /root is $HOME and therefore allowed.
    expect(validateDestinationPath("/root").ok).toBe(true)
  } else {
    expect(reasonOf("/root")).toMatch(/\/root is only allowed/)
    expect(reasonOf("/root/inbox")).toMatch(/\/root is only allowed/)
  }
})

test("refuses dot-directories below $HOME, at any depth", () => {
  const home = homedir()
  for (const path of [join(home, ".config"), join(home, ".ssh"), join(home, ".local"), join(home, ".config", "autostart"), join(home, "work", ".hidden", "x")]) {
    expect(reasonOf(path)).toMatch(/dot-directories are not allowed/)
  }
  expect(reasonOf("~/.ssh")).toMatch(/dot-directories are not allowed/)
})

test("refuses dot-components outside $HOME too", async () => {
  const dir = await tempDir()
  const dotted = join(dir, ".hidden")
  await mkdir(dotted, { mode: 0o700 })
  expect(reasonOf(dotted)).toMatch(/dot-directories are not allowed/)
})

test("refuses symlinked destinations and never follows them", async () => {
  const real = await tempDir()
  const link = join(await tempDir(), "linked")
  await symlink(real, link)
  expect(reasonOf(link)).toMatch(/symbolic links are not allowed/)
})

test("refuses a file and a missing directory without the create flag", async () => {
  const dir = await tempDir()
  const file = join(dir, "afile")
  await writeFile(file, "x")
  expect(reasonOf(file)).toMatch(/not a directory/)
  expect(reasonOf(join(dir, "missing"))).toMatch(/does not exist/)
})

test("refuses directories that are world-writable without the sticky bit", async () => {
  const dir = await tempDir()
  const open = join(dir, "open")
  await mkdir(open, { mode: 0o700 })
  await chmod(open, 0o777)
  expect(reasonOf(open)).toMatch(/world-writable without the sticky bit/)
})

test("accepts a world-writable directory that has the sticky bit", async () => {
  const dir = await tempDir()
  const sticky = join(dir, "sticky")
  await mkdir(sticky, { mode: 0o700 })
  await chmod(sticky, 0o1777)
  expect(validateDestinationPath(sticky).ok).toBe(true)
})

test("refuses a destination under a world-writable parent without the sticky bit", async () => {
  const parent = await tempDir()
  await chmod(parent, 0o777)
  const child = join(parent, "child")
  await mkdir(child, { mode: 0o700 })
  expect(reasonOf(child)).toMatch(/world-writable without the sticky bit/)
})

test("create flag creates missing directories only under $HOME, never elsewhere", async () => {
  const outside = join(await tempDir(), "nested")
  expect(reasonOf(outside, { create: true })).toMatch(/under your home directory/)
  await expect(stat(outside)).rejects.toThrow()
})

test("create flag does not bypass the dot-directory rule", () => {
  expect(reasonOf(join(homedir(), ".sw-create-test"), { create: true })).toMatch(/dot-directories are not allowed/)
})

test("rejects control characters and empty input", () => {
  expect(reasonOf("   ")).toMatch(/empty/)
  expect(reasonOf("/tmp/a\u0000b")).toMatch(/control characters/)
  expect(reasonOf("/tmp/a\u001bb")).toMatch(/control characters/)
})
