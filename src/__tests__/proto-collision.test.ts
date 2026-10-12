import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveDestination } from "../services/transfer-protocol.js"

// P1-20: collision names keep the " (n).ext" suffix whole, stay within 255
// bytes, and treat any existing entry (including a dangling symlink) as taken.

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "proto-coll-"))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("P1-20: a free name is used as-is, a taken one gets the next index", async () => {
  await withDir(async (dir) => {
    expect(await resolveDestination(dir, "report.pdf")).toBe("report.pdf")
    await writeFile(join(dir, "report.pdf"), "x")
    expect(await resolveDestination(dir, "report.pdf")).toBe("report (1).pdf")
    await writeFile(join(dir, "report (1).pdf"), "x")
    expect(await resolveDestination(dir, "report.pdf")).toBe("report (2).pdf")
  })
})

test("P1-20: 255-byte names, three in a row, stay distinct, within the limit, with the suffix intact", async () => {
  await withDir(async (dir) => {
    const name = `${"a".repeat(250)}.txt` // exactly 255 bytes
    const names: string[] = []
    for (let i = 0; i < 3; i++) {
      const next = await resolveDestination(dir, name)
      names.push(next)
      await writeFile(join(dir, next), "x")
    }
    expect(new Set(names).size).toBe(3)
    for (const candidate of names) {
      expect(Buffer.byteLength(candidate, "utf8")).toBeLessThanOrEqual(255)
      expect(candidate.endsWith(".txt")).toBe(true)
    }
    expect(names[1]).toMatch(/ \(1\)\.txt$/)
    expect(names[2]).toMatch(/ \(2\)\.txt$/)
  })
})

test("P1-20: a multi-byte stem is cut on a character boundary and the suffix is never cut", async () => {
  await withDir(async (dir) => {
    // 254 bytes: the first copy fits; " (1).bin" forces the 250-byte stem to be cut.
    const name = `${"é".repeat(125)}.bin`
    const first = await resolveDestination(dir, name)
    expect(first).toBe(name)
    await writeFile(join(dir, first), "x")
    const second = await resolveDestination(dir, name)
    expect(Buffer.byteLength(second, "utf8")).toBeLessThanOrEqual(255)
    expect(second).toMatch(/ \(1\)\.bin$/)
    // No replacement characters: every code point survived the cut.
    expect(second.includes("�")).toBe(false)
  })
})

test("P1-20: a dangling symlink occupies its name, so the next index is chosen", async () => {
  await withDir(async (dir) => {
    await symlink(join(dir, "does-not-exist"), join(dir, "ghost.txt"))
    // stat-style checks would call this name free and the final link would fail.
    expect(await resolveDestination(dir, "ghost.txt")).toBe("ghost (1).txt")
  })
})

test("P1-20: only ENOENT means free: an unreadable parent never yields a name", async () => {
  await withDir(async (dir) => {
    // A regular file used as a directory: every lstat fails with ENOTDIR.
    const notADir = join(dir, "plain-file")
    await writeFile(notADir, "x")
    await expect(resolveDestination(notADir, "a.txt")).rejects.toThrow(/too many name collisions/)
  })
}, 30_000)
