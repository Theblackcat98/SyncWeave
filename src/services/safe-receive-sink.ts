import { createHash, randomUUID } from "node:crypto"
import { link, open, realpath, stat, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

/**
 * Filesystem-only receive primitive. This module does not implement transport,
 * peer identity, authentication, discovery, consent, or UI integration.
 * The caller supplies a trusted, stable destination tree; this utility does not
 * pin a directory handle or defend against hostile concurrent path replacement.
 */
export interface SafeReceiveOptions {
  /** Caller-selected, existing destination directory in a caller-trusted tree. */
  destinationDirectory: string
  /** Untrusted peer-provided name; only a bounded, safe leaf name is retained. */
  peerFileName: string
  /** Required caller-selected byte cap; no product default is implied. */
  maxBytes: number
  /** Required caller-selected UTF-8 filename bound. */
  maxNameBytes: number
  /** Expected content length supplied by the caller. */
  expectedBytes: number
  /** Expected SHA-256 hex digest supplied by the caller. */
  expectedSha256: string
  /** Cancellation signal for this individual receive. */
  signal?: AbortSignal
}

export interface SafeReceiveResult {
  path: string
  name: string
  bytes: number
  sha256: string
}

export class ReceiveCancelledError extends Error {
  constructor(reason?: unknown) {
    super("Receive was cancelled", reason === undefined ? undefined : { cause: reason })
    this.name = "AbortError"
  }
}

export class ReceiveLimitError extends Error {
  constructor() {
    super("Received bytes exceed the caller-provided maximum")
    this.name = "ReceiveLimitError"
  }
}

export class ReceiveIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReceiveIntegrityError"
  }
}

const encoder = new TextEncoder()
const reservedWindowsNames = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i
const temporaryNamePrefix = ".syncweave-"
const temporaryNameSuffix = ".partial"

function isReservedWindowsBasename(candidate: string): boolean {
  const deviceName = candidate.split(".", 1)[0]!.replace(/[. ]+$/, "")
  return reservedWindowsNames.test(deviceName)
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  let usedBytes = 0
  let output = ""
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength
    if (usedBytes + characterBytes > maxBytes) break
    output += character
    usedBytes += characterBytes
  }
  return output
}

/**
 * Convert an untrusted path-like name into a portable basename. Both slash
 * conventions are treated as separators on every platform. Leading dots are
 * removed so a peer cannot choose a hidden output name; incompatible/control
 * characters are replaced, Windows device names are prefixed, and the result
 * is truncated on a Unicode code-point boundary to the caller's byte bound.
 */
export function sanitizePeerBasename(peerFileName: string, maxNameBytes: number): string {
  if (typeof peerFileName !== "string") throw new TypeError("peerFileName must be a string")
  assertPositiveSafeInteger("maxNameBytes", maxNameBytes)

  const components = peerFileName.replaceAll("\\", "/").split("/").filter((part) => part.length > 0)
  let candidate = components.at(-1) ?? ""
  candidate = candidate.normalize("NFC")
  candidate = Array.from(candidate, (character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint >= 0xd800 && codePoint <= 0xdfff ? "_" : character
  }).join("")
  candidate = candidate.replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*]/g, "_").trim()
  // Strip Unicode format characters that misrender filenames: bidi overrides
  // (U+202A–U+202E, U+2066–U+2069), zero-width joiners/spaces (U+200B–U+200F,
  // U+FEFF), and line/paragraph separators (U+2028/U+2029). Without this,
  // "invoice‮fdp.exe" displays as "invoiceexe.pdf" but saves with the
  // override intact.
  candidate = candidate.replace(/[\u200b-\u200f\u2028-\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
  candidate = candidate.replace(/^\.+/, "").replace(/[. ]+$/, "")

  if (candidate.length === 0) {
    throw new TypeError("peerFileName does not contain a usable basename")
  }

  if (isReservedWindowsBasename(candidate)) candidate = `_${candidate}`

  candidate = truncateUtf8(candidate, maxNameBytes).replace(/[. ]+$/, "")
  if (candidate.length === 0) {
    throw new TypeError("peerFileName is empty after applying the filename bound")
  }
  if (isReservedWindowsBasename(candidate)) {
    throw new TypeError("peerFileName becomes a reserved Windows device name after applying the filename bound")
  }
  return candidate
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ReceiveCancelledError(signal.reason)
}

async function nextOrCancelled(
  iterator: AsyncIterator<Uint8Array>,
  signal?: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  throwIfCancelled(signal)
  if (!signal) return iterator.next()

  return new Promise((resolveNext, rejectNext) => {
    let settled = false
    const cleanup = () => signal.removeEventListener("abort", onAbort)
    const settleReject = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      rejectNext(error)
    }
    const onAbort = () => settleReject(new ReceiveCancelledError(signal.reason))

    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }

    let nextResult: Promise<IteratorResult<Uint8Array>>
    try {
      nextResult = Promise.resolve(iterator.next())
    } catch (error) {
      settleReject(error)
      return
    }
    nextResult.then(
      (result) => {
        if (settled) return
        settled = true
        cleanup()
        resolveNext(result)
      },
      settleReject,
    )
  })
}

function closeSourceBestEffort(source: AsyncIterable<Uint8Array>, iterator: AsyncIterator<Uint8Array>): void {
  const maybeDestroy = source as AsyncIterable<Uint8Array> & { destroy?: () => unknown }
  try {
    maybeDestroy.destroy?.()
  } catch {
    // Source cleanup must not prevent temporary-file cleanup.
  }
  try {
    const returned = iterator.return?.()
    if (returned) void Promise.resolve(returned).catch(() => undefined)
  } catch {
    // Source cleanup is best-effort; the receive operation remains failed.
  }
}

async function createExclusiveTemporaryFile(directory: string): Promise<{ path: string; handle: FileHandle }> {
  // randomUUID plus wx means an existing path is never opened or truncated.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const path = join(directory, `${temporaryNamePrefix}${randomUUID()}${temporaryNameSuffix}`)
    try {
      return { path, handle: await open(path, "wx", 0o600) }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
  }
  throw new Error("Unable to allocate an exclusive temporary receive file")
}

async function writeChunk(handle: FileHandle, chunk: Uint8Array, fileOffset: number): Promise<void> {
  let written = 0
  while (written < chunk.byteLength) {
    const result = await handle.write(chunk, written, chunk.byteLength - written, fileOffset + written)
    if (result.bytesWritten <= 0) throw new Error("Temporary receive file stopped accepting bytes")
    written += result.bytesWritten
  }
}

/**
 * Stream into an exclusive same-directory temporary file, verify the caller's
 * expected size and SHA-256, then publish via an atomic hard link. Hard-link
 * creation does not replace an existing destination; unsupported filesystems
 * fail closed (there is deliberately no rename/overwrite fallback).
 */
export async function receiveToFile(
  source: AsyncIterable<Uint8Array>,
  options: SafeReceiveOptions,
): Promise<SafeReceiveResult> {
  assertNonNegativeSafeInteger("maxBytes", options.maxBytes)
  assertPositiveSafeInteger("maxNameBytes", options.maxNameBytes)
  assertNonNegativeSafeInteger("expectedBytes", options.expectedBytes)
  if (options.expectedBytes > options.maxBytes) {
    throw new ReceiveLimitError()
  }
  if (!/^[a-f\d]{64}$/i.test(options.expectedSha256)) {
    throw new TypeError("expectedSha256 must be a 64-character SHA-256 hex digest")
  }
  if (typeof options.destinationDirectory !== "string" || options.destinationDirectory.length === 0) {
    throw new TypeError("destinationDirectory must be a non-empty path")
  }
  if (source === null || typeof source?.[Symbol.asyncIterator] !== "function") {
    throw new TypeError("source must be an AsyncIterable<Uint8Array>")
  }

  throwIfCancelled(options.signal)
  const name = sanitizePeerBasename(options.peerFileName, options.maxNameBytes)
  const directory = await realpath(resolve(options.destinationDirectory))
  if (!(await stat(directory)).isDirectory()) {
    throw new TypeError("destinationDirectory must name an existing directory")
  }
  const finalPath = join(directory, name)
  if (dirname(finalPath) !== directory) {
    throw new Error("Sanitized filename escaped the chosen destination directory")
  }

  const { path: temporaryPath, handle: openedHandle } = await createExclusiveTemporaryFile(directory)
  let handle: FileHandle | undefined = openedHandle
  let iterator: AsyncIterator<Uint8Array> | undefined
  let sourceDone = false
  let operationError: unknown
  let bytesReceived = 0
  const hasher = createHash("sha256")
  const expectedSha256 = options.expectedSha256.toLowerCase()

  try {
    iterator = source[Symbol.asyncIterator]()
    while (true) {
      throwIfCancelled(options.signal)
      const next = await nextOrCancelled(iterator, options.signal)
      if (next.done) {
        sourceDone = true
        break
      }
      throwIfCancelled(options.signal)
      const chunk = next.value
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("source chunks must be Uint8Array values")
      }
      if (chunk.byteLength > options.maxBytes - bytesReceived) {
        throw new ReceiveLimitError()
      }
      if (chunk.byteLength > options.expectedBytes - bytesReceived) {
        throw new ReceiveIntegrityError("Received size is greater than the expected size")
      }
      await writeChunk(handle, chunk, bytesReceived)
      hasher.update(chunk)
      bytesReceived += chunk.byteLength
    }

    throwIfCancelled(options.signal)
    if (bytesReceived !== options.expectedBytes) {
      throw new ReceiveIntegrityError("Received size does not match the expected size")
    }
    const sha256 = hasher.digest("hex")
    if (sha256 !== expectedSha256) {
      throw new ReceiveIntegrityError("Received SHA-256 does not match the expected digest")
    }

    const temporaryStats = await handle.stat()
    if (temporaryStats.size !== bytesReceived) {
      throw new ReceiveIntegrityError("Temporary file size does not match the verified byte count")
    }
    await handle.sync()
    await handle.close()
    handle = undefined

    // No await separates this check from the publication syscall, so an abort
    // observed before finalization cannot publish even verified bytes.
    await link(temporaryPath, finalPath)
    try {
      await unlink(temporaryPath)
    } catch {
      // The file is published and verified; a failed temp cleanup must not
      // delete it. The orphaned temp file is swept at the next startup.
    }
    // Fsync the directory so a crash can't lose a file we reported as
    // received. Best effort: not all filesystems support it.
    try {
      const dirHandle = await open(directory, "r")
      try {
        await dirHandle.sync()
      } finally {
        await dirHandle.close()
      }
    } catch {
      // Best effort.
    }

    return { path: finalPath, name, bytes: bytesReceived, sha256 }
  } catch (error) {
    operationError = error
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    if (!sourceDone && iterator) closeSourceBestEffort(source, iterator)
    if (handle) {
      try {
        await handle.close()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await unlink(temporaryPath)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
        operationError === undefined
          ? "Receive cleanup failed"
          : "Receive failed and temporary cleanup also failed",
        operationError === undefined ? undefined : { cause: operationError },
      )
    }
  }
}
