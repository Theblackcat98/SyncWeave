import { createHash, randomUUID } from "node:crypto"
import { link, lstat, open, readdir, realpath, stat, unlink } from "node:fs/promises"
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
  /**
   * Optional collision resolver. Called with the peer-provided name when
   * publishing fails because the chosen name was taken after it was resolved
   * (by another receive or process); it must return a currently-free leaf
   * name in the same destination. The verified temporary file is then
   * published under that name instead of failing the receive. Without a
   * resolver, a taken name fails the receive with EEXIST.
   */
  resolveName?: (peerFileName: string) => Promise<string>
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
// Current staging names are `.syncweave-<owner pid>-<uuid>.partial`. Names
// without a parseable owner pid (legacy) are only swept once they are stale.
const temporaryNamePattern = /^\.syncweave-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.partial$/i
const legacyPartialMaxAgeMs = 60 * 60 * 1000

/** True for any staging file name this sink may leave in a destination. */
export function isTemporaryPartialName(name: string): boolean {
  return /^\.syncweave-.*\.partial$/.test(name)
}

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
  candidate = candidate.replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*]/g, "_")
  // Strip the whole Unicode "Format" category (bidi overrides, isolates,
  // zero-width joiners and spaces, soft hyphen, BOM, ...) plus line and
  // paragraph separators. Without this, "invoice\u202Efdp.exe" displays as
  // "invoiceexe.pdf" but saves with the override intact.
  candidate = candidate.replace(/\p{Cf}|[\u2028\u2029]/gu, "").trim()
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

/**
 * The basename `receiveToFile` would save for `peerName` before any collision
 * suffix is added, for consent screens. Returns null when the sink would
 * reject the name outright (no usable basename, or a reserved device name
 * after truncation).
 */
export function previewSavedName(peerName: string, maxNameBytes = 255): string | null {
  try {
    return sanitizePeerBasename(peerName, maxNameBytes)
  } catch (error) {
    if (error instanceof TypeError) return null
    throw error
  }
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
    const path = join(directory, `${temporaryNamePrefix}${process.pid}-${randomUUID()}${temporaryNameSuffix}`)
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

/** Total publish attempts (first try plus re-resolved names) per receive. */
const maxPublishAttempts = 10

/**
 * True when `link()` failed because the filesystem does not support hard
 * links (cross-device, or filesystems such as exFAT/SMB/FUSE that refuse
 * them), as opposed to a name collision or a real I/O error.
 */
function isLinkUnsupported(error: unknown): boolean {
  const code = errorCode(error)
  return code === "EXDEV" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM"
}

const linkSupportByDirectory = new Map<string, Promise<boolean>>()

/**
 * Probe hard-link support in `directory` once: link a throwaway file to a
 * second throwaway name and remove both. The probe files live only for the
 * duration of two syscalls and are removed best-effort; their names are
 * deliberately not staging-partial names, so a leftover can never be
 * mistaken for an in-progress receive.
 */
async function probeLinkSupport(directory: string): Promise<boolean> {
  const probeSource = join(directory, `.syncweave-linkprobe-${process.pid}-${randomUUID()}`)
  const probeTarget = join(directory, `.syncweave-linkprobe-${process.pid}-${randomUUID()}`)
  try {
    const handle = await open(probeSource, "wx", 0o600)
    await handle.close()
    await link(probeSource, probeTarget)
    return true
  } catch (error) {
    if (isLinkUnsupported(error)) return false
    throw error
  } finally {
    await unlink(probeSource).catch(() => undefined)
    await unlink(probeTarget).catch(() => undefined)
  }
}

/** Whether hard links work in `directory`, probed at most once per process. */
function linkSupported(directory: string): Promise<boolean> {
  let probe = linkSupportByDirectory.get(directory)
  if (!probe) {
    probe = probeLinkSupport(directory)
    linkSupportByDirectory.set(directory, probe)
    // A probe that failed for an unexpected reason (not "unsupported") must
    // not poison the destination for the rest of the process.
    probe.catch(() => {
      if (linkSupportByDirectory.get(directory) === probe) linkSupportByDirectory.delete(directory)
    })
  }
  return probe
}

/**
 * Publish on a filesystem without hard links: create the final name
 * exclusively and copy the verified temporary bytes into it. `wx`
 * (O_CREAT|O_EXCL) refuses an existing name and, on POSIX, a symlink at
 * that path, so the copy can never overwrite or write through a link. If
 * the copy fails, the exclusively-created incomplete file is removed
 * again — it never held anyone else's data.
 */
async function publishExclusiveCopy(temporaryPath: string, finalPath: string, expectedBytes: number): Promise<void> {
  const finalHandle = await open(finalPath, "wx", 0o600)
  let completed = false
  try {
    const temporaryHandle = await open(temporaryPath, "r")
    try {
      const buffer = Buffer.alloc(128 * 1024)
      let offset = 0
      while (offset < expectedBytes) {
        const { bytesRead } = await temporaryHandle.read(
          buffer,
          0,
          Math.min(buffer.length, expectedBytes - offset),
          offset,
        )
        if (bytesRead <= 0) {
          throw new ReceiveIntegrityError("Temporary file ended before the verified byte count during publish")
        }
        let written = 0
        while (written < bytesRead) {
          const result = await finalHandle.write(buffer, written, bytesRead - written, offset + written)
          if (result.bytesWritten <= 0) throw new Error("Published file stopped accepting bytes")
          written += result.bytesWritten
        }
        offset += bytesRead
      }
    } finally {
      await temporaryHandle.close()
    }
    await finalHandle.sync()
    completed = true
  } finally {
    await finalHandle.close().catch(() => undefined)
    if (!completed) await unlink(finalPath).catch(() => undefined)
  }
}

/**
 * Publish the verified temporary file under `finalPath`: an atomic hard
 * link where the destination supports links, the exclusive-create copy
 * where it does not. A hard link that unexpectedly reports "unsupported"
 * (the probe raced a filesystem change) downgrades the destination to the
 * copy path for the rest of the process.
 */
async function publishVerifiedFile(
  directory: string,
  temporaryPath: string,
  finalPath: string,
  expectedBytes: number,
): Promise<void> {
  if (await linkSupported(directory)) {
    try {
      await link(temporaryPath, finalPath)
      return
    } catch (error) {
      if (!isLinkUnsupported(error)) throw error
      linkSupportByDirectory.set(directory, Promise.resolve(false))
    }
  }
  await publishExclusiveCopy(temporaryPath, finalPath, expectedBytes)
}

/**
 * Stream into an exclusive same-directory temporary file, verify the caller's
 * expected size and SHA-256, then publish without ever replacing an existing
 * destination: an atomic hard link where the filesystem supports links
 * (probed once per destination), otherwise an exclusive-create copy of the
 * verified bytes. When the caller supplies `resolveName`, a destination name
 * taken between resolution and publication is retried under the resolver's
 * next free name instead of failing the receive.
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
  let name = sanitizePeerBasename(options.peerFileName, options.maxNameBytes)
  const directory = await realpath(resolve(options.destinationDirectory))
  if (!(await stat(directory)).isDirectory()) {
    throw new TypeError("destinationDirectory must name an existing directory")
  }
  let finalPath = join(directory, name)
  if (dirname(finalPath) !== directory) {
    throw new Error("Sanitized filename escaped the chosen destination directory")
  }

  const { path: temporaryPath, handle: openedHandle } = await createExclusiveTemporaryFile(directory)
  let handle: FileHandle | undefined = openedHandle
  let iterator: AsyncIterator<Uint8Array> | undefined
  let sourceDone = false
  let operationError: unknown
  let bytesReceived = 0
  let published = false
  let temporaryRemoved = false
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

    // An abort observed before finalization must not publish even verified
    // bytes, so re-check immediately before the publish attempts.
    throwIfCancelled(options.signal)
    // Publish the verified temporary file. If the chosen name was taken
    // while streaming, ask the caller's resolver for the next free name and
    // publish under it instead of failing the file (P1-20).
    for (let attempt = 1; ; attempt += 1) {
      try {
        await publishVerifiedFile(directory, temporaryPath, finalPath, bytesReceived)
        break
      } catch (error) {
        if (errorCode(error) !== "EEXIST" || !options.resolveName || attempt >= maxPublishAttempts) {
          throw error
        }
        name = sanitizePeerBasename(await options.resolveName(options.peerFileName), options.maxNameBytes)
        finalPath = join(directory, name)
        if (dirname(finalPath) !== directory) {
          throw new Error("Resolved filename escaped the chosen destination directory")
        }
      }
    }
    // From here on the verified file is at its final name. Nothing below may
    // turn this into a reported failure, and no cleanup may remove the final name.
    published = true
    try {
      await unlink(temporaryPath)
      temporaryRemoved = true
    } catch {
      // Best effort: the `finally` block retries once. A leftover temp file is
      // swept at the next startup.
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
    if (!temporaryRemoved) {
      try {
        await unlink(temporaryPath)
      } catch (error) {
        // After publication the verified file is the result; a leftover temp
        // name is not a receive failure.
        if (!published && errorCode(error) !== "ENOENT") cleanupErrors.push(error)
      }
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

/** True when `pid` names a live process (EPERM still means it exists). */
function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === "EPERM"
  }
}

/**
 * A staging file is an orphan when its owner pid is gone. Names without a
 * parseable owner (legacy) are orphans only once they are stale.
 */
async function isOrphanPartial(name: string, path: string): Promise<boolean> {
  const owner = temporaryNamePattern.exec(name)
  if (owner) return !processIsAlive(Number(owner[1]))
  try {
    const info = await lstat(path)
    return Date.now() - info.mtimeMs > legacyPartialMaxAgeMs
  } catch {
    return false
  }
}

/**
 * Remove orphaned `.syncweave-*.partial` staging files left in `directory` by
 * killed sessions. A partial whose owner pid is still alive (this process or
 * another running instance) is never removed; legacy names without an owner
 * pid are removed only after an hour without modification. Returns the number
 * removed.
 */
export async function sweepOrphanPartials(directory: string): Promise<number> {
  let swept = 0
  try {
    for (const name of await readdir(directory)) {
      if (!isTemporaryPartialName(name)) continue
      const path = join(directory, name)
      try {
        if (!(await isOrphanPartial(name, path))) continue
        await unlink(path)
        swept++
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
  return swept
}
