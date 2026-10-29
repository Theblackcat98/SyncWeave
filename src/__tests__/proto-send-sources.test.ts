import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, truncate } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BUDGET_MAX_FILE_BYTES,
  generateEphemeralIdentity,
  SendAbortedError,
  sendFiles,
} from "../services/transfer-protocol.js"
import { writeProtoFile } from "./helpers/proto-harness.js"

// P0-11 (send side): sources are checked by type and size before any byte is
// hashed, nothing blocks on a FIFO, and hashing honours the abort signal.

/** A port nothing listens on: any test that reaches the dial fails differently. */
const UNUSED_PORT = 1

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "proto-src-"))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("P0-11: a FIFO source is refused with a clear per-file message and never blocks", async () => {
  await withDir(async (dir) => {
    const fifo = join(dir, "pipe")
    execFileSync("mkfifo", [fifo])
    const started = Date.now()
    const error = await Promise.race([
      sendFiles({
        host: "127.0.0.1",
        port: UNUSED_PORT,
        files: [{ path: fifo, name: "pipe" }],
        identity: generateEphemeralIdentity(),
      }).then(
        () => null,
        (e: unknown) => e,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("send blocked on a FIFO")), 5_000),
      ),
    ])
    expect(Date.now() - started).toBeLessThan(5_000)
    expect((error as Error).message).toMatch(/cannot send pipe: it is a named pipe/)
  })
}, 15_000)

test("P0-11: a symlink source is refused with a clear per-file message", async () => {
  await withDir(async (dir) => {
    const file = await writeProtoFile(dir, "target.bin", 10)
    const link = join(dir, "link.bin")
    await symlink(file, link)
    const error = await sendFiles({
      host: "127.0.0.1",
      port: UNUSED_PORT,
      files: [{ path: link, name: "link.bin" }],
      identity: generateEphemeralIdentity(),
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect((error as Error).message).toMatch(/cannot send link\.bin: it is a symlink/)
  })
}, 15_000)

test("P0-11: a directory source is refused with a clear per-file message", async () => {
  await withDir(async (dir) => {
    const sub = join(dir, "folder")
    await mkdir(sub)
    const error = await sendFiles({
      host: "127.0.0.1",
      port: UNUSED_PORT,
      files: [{ path: sub, name: "folder" }],
      identity: generateEphemeralIdentity(),
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect((error as Error).message).toMatch(/cannot send folder: it is a directory/)
  })
}, 15_000)

test("P0-11: an oversize file is rejected on its stat, before any byte is hashed", async () => {
  await withDir(async (dir) => {
    // A sparse file: its size is over the per-file budget, but no data is written.
    const big = join(dir, "huge.bin")
    await writeProtoFile(dir, "huge.bin", 1)
    await truncate(big, BUDGET_MAX_FILE_BYTES + 1)
    const hashed: string[] = []
    const error = await sendFiles({
      host: "127.0.0.1",
      port: UNUSED_PORT,
      files: [{ path: big, name: "huge.bin" }],
      identity: generateEphemeralIdentity(),
      onHashProgress: (_index, _count, name) => hashed.push(name),
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect((error as Error).message).toMatch(/file too large: huge\.bin/)
    expect(hashed).toEqual([])
  })
}, 30_000)

test("P2-1: onHashProgress reports each file before dialing", async () => {
  await withDir(async (dir) => {
    const a = await writeProtoFile(dir, "a.bin", 300)
    const b = await writeProtoFile(dir, "b.bin", 300)
    const calls: Array<[number, number, string]> = []
    const error = await sendFiles({
      host: "127.0.0.1",
      port: UNUSED_PORT,
      files: [
        { path: a, name: "a.bin" },
        { path: b, name: "b.bin" },
      ],
      identity: generateEphemeralIdentity(),
      onHashProgress: (index, count, name) => calls.push([index, count, name]),
    }).then(
      () => null,
      (e: unknown) => e,
    )
    // The send then fails only because nothing listens on the port.
    expect(error).not.toBeNull()
    expect(calls).toEqual([
      [0, 2, "a.bin"],
      [1, 2, "b.bin"],
    ])
  })
}, 30_000)

test("R7: an abort during pre-dial hashing stops within one read and never dials", async () => {
  await withDir(async (dir) => {
    // 64 MiB: hashing it in full takes far longer than the abort window.
    const big = await writeProtoFile(dir, "big.bin", 64 * 1024 * 1024)
    const aborter = new AbortController()
    const started = Date.now()
    const error = await sendFiles({
      host: "127.0.0.1",
      port: UNUSED_PORT,
      files: [{ path: big, name: "big.bin" }],
      identity: generateEphemeralIdentity(),
      signal: aborter.signal,
      onHashProgress: () => aborter.abort(new Error("cancelled before dial")),
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(SendAbortedError)
    expect((error as Error).message).toMatch(/cancelled before connecting/)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
}, 30_000)
