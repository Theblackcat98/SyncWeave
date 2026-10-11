import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"
import {
  ReceiveCancelledError,
  ReceiveIntegrityError,
  ReceiveLimitError,
  receiveToFile,
  sanitizePeerBasename,
  type SafeReceiveOptions,
} from "../services/safe-receive-sink.js"

const temporaryDirectories: string[] = []

async function makeDestination(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "syncweave-safe-receive-test-"))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function optionsFor(directory: string, peerFileName: string, bytes: Uint8Array, overrides: Partial<SafeReceiveOptions> = {}): SafeReceiveOptions {
  return {
    destinationDirectory: directory,
    peerFileName,
    maxBytes: Math.max(bytes.byteLength, 1),
    maxNameBytes: 255,
    expectedBytes: bytes.byteLength,
    expectedSha256: digest(bytes),
    ...overrides,
  }
}

async function* chunks(bytes: Uint8Array, chunkSize: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength))
  }
}

async function expectNoTemporaryPartials(directory: string): Promise<void> {
  const entries = await readdir(directory)
  expect(entries.filter((entry) => entry.startsWith(".syncweave-") && entry.endsWith(".partial"))).toEqual([])
}

test("sanitizes traversal, both separator styles, hidden names, reserved names, and filename length", () => {
  expect(sanitizePeerBasename("../../etc/passwd", 255)).toBe("passwd")
  expect(sanitizePeerBasename("..\\..\\Users\\hostile.txt", 255)).toBe("hostile.txt")
  expect(sanitizePeerBasename(".env", 255)).toBe("env")
  expect(sanitizePeerBasename("CON.txt", 255)).toBe("_CON.txt")
  expect(new TextEncoder().encode(sanitizePeerBasename("very-long-☃-name.txt", 12)).byteLength).toBeLessThanOrEqual(12)
  expect(() => sanitizePeerBasename("../..", 255)).toThrow(TypeError)
})

test("streams bytes with backpressure, verifies size and SHA-256, and writes only the sanitized basename", async () => {
  const directory = await makeDestination()
  const bytes = new TextEncoder().encode("streamed payload with several chunks")
  const result = await receiveToFile(chunks(bytes, 4), optionsFor(directory, "../../outside/received.txt", bytes))

  expect(result.name).toBe("received.txt")
  expect(result.path).toBe(join(directory, "received.txt"))
  expect(result.bytes).toBe(bytes.byteLength)
  expect(result.sha256).toBe(digest(bytes))
  expect(Array.from(await readFile(result.path))).toEqual(Array.from(bytes))
  await expectNoTemporaryPartials(directory)
})

test("accepts an empty stream and a large chunked stream under caller-provided limits", async () => {
  const directory = await makeDestination()
  const empty = new Uint8Array()
  async function* noChunks(): AsyncGenerator<Uint8Array> {}
  const emptyResult = await receiveToFile(noChunks(), optionsFor(directory, "empty.bin", empty))
  expect(emptyResult.bytes).toBe(0)
  expect(Array.from(await readFile(emptyResult.path))).toEqual(Array.from(empty))

  const large = new Uint8Array(2 * 1024 * 1024)
  for (let index = 0; index < large.length; index += 1) large[index] = index % 251
  const largeResult = await receiveToFile(
    chunks(large, 16 * 1024),
    optionsFor(directory, "large.bin", large, { maxBytes: 2 * 1024 * 1024 }),
  )
  expect(largeResult.bytes).toBe(large.byteLength)
  expect(largeResult.sha256).toBe(digest(large))
  expect(Array.from(await readFile(largeResult.path))).toEqual(Array.from(large))
  await expectNoTemporaryPartials(directory)
})

test("rejects an over-limit stream and removes its temporary file", async () => {
  const directory = await makeDestination()
  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  const options = optionsFor(directory, "too-large.bin", bytes, { maxBytes: 4, expectedBytes: 4 })

  await expect(receiveToFile(chunks(bytes, 2), options)).rejects.toBeInstanceOf(ReceiveLimitError)
  expect(await readdir(directory)).toEqual([])
  await expectNoTemporaryPartials(directory)
})

test("cancels while waiting for input and cleans up the incomplete temporary file", async () => {
  const directory = await makeDestination()
  const controller = new AbortController()
  let notifyWaiting!: () => void
  const waiting = new Promise<void>((resolveWaiting) => { notifyWaiting = resolveWaiting })
  let nextCount = 0
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          nextCount += 1
          if (nextCount === 1) return Promise.resolve({ done: false as const, value: new Uint8Array([7, 8, 9]) })
          notifyWaiting()
          return new Promise<IteratorResult<Uint8Array>>(() => undefined)
        },
        return() {
          return Promise.resolve({ done: true as const, value: undefined })
        },
      }
    },
  }
  const operation = receiveToFile(source, optionsFor(directory, "cancelled.bin", new Uint8Array([7, 8, 9]), { signal: controller.signal }))
  await waiting
  controller.abort("test cancellation")

  await expect(operation).rejects.toBeInstanceOf(ReceiveCancelledError)
  expect(await readdir(directory)).toEqual([])
  await expectNoTemporaryPartials(directory)
})

test("uses distinct exclusive temporary files for concurrent receives and never overwrites a destination", async () => {
  const directory = await makeDestination()
  const firstBytes = new Uint8Array([1, 1, 1])
  const secondBytes = new Uint8Array([2, 2, 2])
  let readyCount = 0
  let notifyBothReady!: () => void
  const bothReady = new Promise<void>((resolveReady) => { notifyBothReady = resolveReady })
  let release!: () => void
  const gate = new Promise<void>((resolveGate) => { release = resolveGate })
  const gated = (payload: Uint8Array): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
      readyCount += 1
      if (readyCount === 2) notifyBothReady()
      await gate
      yield payload
    },
  })

  const first = receiveToFile(gated(firstBytes), optionsFor(directory, "same-name.bin", firstBytes))
  const second = receiveToFile(gated(secondBytes), optionsFor(directory, "same-name.bin", secondBytes))
  await bothReady
  const beforePublish = await readdir(directory)
  const partials = beforePublish.filter((entry) => entry.startsWith(".syncweave-") && entry.endsWith(".partial"))
  expect(beforePublish).not.toContain("same-name.bin")
  expect(partials).toHaveLength(2)
  expect(new Set(partials).size).toBe(2)
  release()

  const outcomes = await Promise.allSettled([first, second])
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1)
  const saved = await readFile(join(directory, "same-name.bin"))
  const savedBytes = Array.from(saved)
  expect([firstBytes, secondBytes].some((candidate) => candidate.length === savedBytes.length && candidate.every((byte, index) => byte === savedBytes[index]))).toBe(true)
  await expectNoTemporaryPartials(directory)
})

test("fails closed on an existing destination and leaves its bytes unchanged", async () => {
  const directory = await makeDestination()
  const target = join(directory, "existing.bin")
  const original = new Uint8Array([9, 8, 7])
  const incoming = new Uint8Array([1, 2, 3])
  await writeFile(target, original)

  await expect(receiveToFile(chunks(incoming, 1), optionsFor(directory, "existing.bin", incoming))).rejects.toMatchObject({ code: "EEXIST" })
  expect(Array.from(await readFile(target))).toEqual(Array.from(original))
  await expectNoTemporaryPartials(directory)
})

test("does not follow an existing destination symlink or overwrite its target", async () => {
  const directory = await makeDestination()
  const outside = join(directory, "outside-target.bin")
  const destination = join(directory, "linked.bin")
  const original = new Uint8Array([4, 4, 4])
  const incoming = new Uint8Array([5, 5, 5])
  await writeFile(outside, original)
  await symlink(outside, destination)

  await expect(receiveToFile(chunks(incoming, 2), optionsFor(directory, "linked.bin", incoming))).rejects.toMatchObject({ code: "EEXIST" })
  expect(Array.from(await readFile(outside))).toEqual(Array.from(original))
  expect((await readdir(directory)).filter((entry) => entry.startsWith(".syncweave-") && entry.endsWith(".partial"))).toEqual([])
})

test("rejects size and digest mismatches without publishing a final file or leaking partials", async () => {
  const directory = await makeDestination()
  const actual = new Uint8Array([1, 2, 3])
  const wrongSize = optionsFor(directory, "wrong-size.bin", actual, { maxBytes: 4, expectedBytes: 4 })
  await expect(receiveToFile(chunks(actual, 1), wrongSize)).rejects.toBeInstanceOf(ReceiveIntegrityError)

  const wrongDigest = optionsFor(directory, "wrong-hash.bin", actual, { expectedSha256: "0".repeat(64) })
  await expect(receiveToFile(chunks(actual, 1), wrongDigest)).rejects.toBeInstanceOf(ReceiveIntegrityError)

  expect(await readdir(directory)).toEqual([])
  await expectNoTemporaryPartials(directory)
})
