import { createServer, connect, isIP, type Server, type Socket } from "node:net"
import { NoiseHandshake, NOISE_PROLOGUE_V2, x25519Generate, type CipherState } from "./noise.js"

/** Handshake budget (recorded decision): a stalled peer gets 60s, then the socket is destroyed. */
const HANDSHAKE_TIMEOUT_MS = 60_000

/** dialNoise gives up on an unresponsive endpoint after 10s. */
const CONNECT_TIMEOUT_MS = 10_000

/** Max concurrent Noise handshakes on the listener (P0-5). */
const MAX_CONCURRENT_HANDSHAKES = 4
/** Max sockets waiting for a handshake slot; excess are destroyed immediately. */
const MAX_PENDING_QUEUE = 64
/** Max simultaneous connections (pending + handshaking) per remote IP. */
const MAX_CONNECTIONS_PER_IP = 8

/**
 * TCP transport for the Phase 2 direct-transfer profile.
 *
 * - The receiver explicitly starts a listener on a user-chosen interface
 *   and port (default 24816); there is no hidden always-on listener.
 * - The sender dials a user-entered numeric `IP:port`; no DNS, no mDNS,
 *   no discovery fallback.
 * - Both sides run a Noise_XX handshake over the socket. Handshake messages
 *   are u32-big-endian length-prefixed. After the handshake, transport
 *   messages use the same length prefixing and are encrypted with the
 *   session's Noise transport keys.
 * - `NoiseChannel` exposes `send()` and an async `receive()` iterator of
 *   decrypted payloads, plus `asByteSource()` which reassembles the
 *   decrypted stream for the application frame parser.
 *
 * Peer identity binding (comparing the expected out-of-band Peer ID on this
 * exact connection) is the transfer protocol's job, not the transport's.
 */

export const DEFAULT_PORT = 24816
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024 + 1024

/**
 * Pause the socket when buffered inbound bytes exceed ~2 max-size frames.
 * TCP backpressure then throttles the sender instead of letting one peer
 * wedge the receiver's memory (P0-4).
 */
const HIGH_WATER_BYTES = 2 * MAX_MESSAGE_BYTES
/**
 * Hard cap on buffered inbound bytes. If the buffer passes this — i.e.
 * pause() did not stop delivery, or the reader is wedged — the socket is
 * destroyed (P0-4).
 */
const MAX_BUFFERED_BYTES = 4 * MAX_MESSAGE_BYTES

function writeU32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

function abortError(signal?: AbortSignal): DOMException {
  const reason = signal?.reason
  return reason instanceof Error
    ? new DOMException(`${reason.name}: ${reason.message}`, "AbortError")
    : new DOMException(String(reason ?? "aborted"), "AbortError")
}

/**
 * A chunk list: incoming segments are appended without copying, and `take`
 * copies each byte exactly once into the result. This replaces the old
 * grow-and-concatenate buffer whose per-segment full copy was O(n^2) and
 * let a 256 MiB transfer peak at 811 MiB RSS (P0-4).
 */
class ChunkQueue {
  private chunks: Uint8Array[] = []
  private offset = 0 // consumed bytes within chunks[0]
  private total = 0

  get length(): number {
    return this.total
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.total += chunk.length
  }

  /** Copy exactly n bytes (n must be <= length); each byte is copied once. */
  take(n: number): Uint8Array {
    if (n > this.total) throw new Error("ChunkQueue.take: not enough data")
    const out = new Uint8Array(n)
    let written = 0
    while (written < n) {
      const first = this.chunks[0]!
      const available = first.length - this.offset
      const count = Math.min(available, n - written)
      out.set(first.subarray(this.offset, this.offset + count), written)
      written += count
      this.offset += count
      this.total -= count
      if (this.offset >= first.length) {
        this.chunks.shift()
        this.offset = 0
      }
    }
    return out
  }
}

/**
 * Buffered exact-size reader for a socket. A single persistent 'data'
 * listener feeds a chunk queue; readExact pulls from it. This avoids
 * socket.unshift(), whose re-emission semantics differ across runtimes.
 *
 * Backpressure (P0-4): the socket is paused above HIGH_WATER_BYTES and
 * resumed when the reader needs more data, so a fast or hostile peer
 * cannot grow the buffer without bound. Above MAX_BUFFERED_BYTES the
 * socket is destroyed outright.
 */
class SocketReader {
  private readonly queue = new ChunkQueue()
  private waiters: Array<() => void> = []
  private ended = false
  private destroyed = false
  private error: Error | null = null
  private paused = false

  private readonly onData = (chunk: Buffer): void => {
    if (this.destroyed) return
    this.queue.push(chunk)
    if (this.queue.length > MAX_BUFFERED_BYTES) {
      // Flood guard: the peer is buffering faster than we consume (or
      // pause() is not stopping delivery). Kill the connection.
      this.error = new Error(
        `inbound buffer exceeded ${MAX_BUFFERED_BYTES} bytes; closing connection`,
      )
      this.socket.destroy()
      this.wakeWaiters()
      return
    }
    if (!this.paused && this.queue.length > HIGH_WATER_BYTES) {
      this.paused = true
      this.socket.pause()
    }
    this.wakeWaiters()
  }

  private readonly onEnd = (): void => {
    this.ended = true
    this.wakeWaiters()
  }

  private readonly onError = (e: Error): void => {
    this.error = e
    this.wakeWaiters()
  }

  private readonly onClose = (): void => {
    // destroy() without a prior FIN emits 'close' but never 'end'; treat it
    // as EOF so parked readers wake instead of hanging (P0-8).
    if (!this.ended) {
      this.ended = true
      this.wakeWaiters()
    }
  }

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData)
    socket.on("end", this.onEnd)
    socket.on("error", this.onError)
    socket.on("close", this.onClose)
  }

  private wakeWaiters(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w()
  }

  private resumeIfPaused(): void {
    if (this.paused) {
      this.paused = false
      this.socket.resume()
    }
  }

  async readExact(n: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    while (this.queue.length < n) {
      if (this.error) throw this.error
      if (this.destroyed) break
      if (this.ended) {
        // FIN was received, but 'data' events already queued in the event
        // loop may not have fired yet. Yield once to let them arrive before
        // declaring EOF; without this, a fast sender can trigger a
        // premature EOF on a slow receiver.
        await new Promise((r) => setImmediate(r))
        // After the yield, whatever is buffered is all there is.
        break
      }
      if (signal?.aborted) throw abortError(signal)
      // The reader demonstrably needs more data: make sure the socket is
      // flowing before parking (this is also what keeps a paused socket
      // from deadlocking against a pending FIN).
      this.resumeIfPaused()
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== done)
          reject(abortError(signal))
        }
        const done = () => {
          signal?.removeEventListener("abort", onAbort)
          resolve()
        }
        this.waiters.push(done)
        signal?.addEventListener("abort", onAbort, { once: true })
      })
    }
    if (this.queue.length === 0) {
      return null
    }
    // After end, a short final read is possible; callers treat a short
    // read as a truncated stream.
    return this.queue.take(Math.min(n, this.queue.length))
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.socket.removeListener("data", this.onData)
    // Resume so a pending FIN/'end' is still delivered to the other
    // listeners, then wake any parked readers (P0-8).
    this.resumeIfPaused()
    this.wakeWaiters()
  }
}

async function readMessage(reader: SocketReader, signal?: AbortSignal): Promise<Uint8Array | null> {
  const lenBytes = await reader.readExact(4, signal)
  if (lenBytes === null) {
    return null
  }
  if (lenBytes.length < 4) {
    throw new Error("truncated transport message length")
  }
  const length = new DataView(lenBytes.buffer, lenBytes.byteOffset, 4).getUint32(0)
  // A zero-length transport message is a protocol error, never end-of-stream
  // (P1-17): neither handshake messages nor encrypted frames can be empty.
  if (length === 0) {
    throw new Error("transport message with zero length")
  }
  if (length > MAX_MESSAGE_BYTES) {
    throw new Error(`transport message length ${length} exceeds maximum`)
  }
  const body = await reader.readExact(length, signal)
  if (body === null) {
    return null
  }
  if (body.length < length) {
    throw new Error("truncated transport message body")
  }
  return body
}

function writeMessage(socket: Socket, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.concat([Buffer.from(writeU32(data.length)), Buffer.from(data)])
    socket.write(payload, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export class NoiseChannel {
  private closed = false

  constructor(
    private readonly socket: Socket,
    private readonly sendCipher: CipherState,
    private readonly receiveCipher: CipherState,
    private readonly reader: SocketReader,
  ) {
    socket.on("error", () => this.close())
    socket.on("close", () => {
      this.closed = true
    })
  }

  get isClosed(): boolean {
    return this.closed || this.socket.destroyed
  }

  async send(plaintext: Uint8Array): Promise<void> {
    if (this.isClosed) {
      throw new Error("Noise channel is closed")
    }
    const ciphertext = this.sendCipher.encryptWithAd(new Uint8Array(0), plaintext)
    await writeMessage(this.socket, ciphertext)
  }

  /** Async iterator of decrypted transport payloads. */
  async *receive(signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    // Do NOT check isClosed up front: the socket 'close' event can fire
    // while frames are still buffered (e.g. a CANCEL arriving just before
    // the sender's FIN). Drain via readMessage's null-on-EOF instead, so
    // teardown frames are never dropped.
    for (;;) {
      let ciphertext: Uint8Array | null
      try {
        ciphertext = await readMessage(this.reader, signal)
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return
        }
        throw error
      }
      if (ciphertext === null) {
        return
      }
      yield this.receiveCipher.decryptWithAd(new Uint8Array(0), ciphertext)
    }
  }

  /**
   * Present the decrypted stream as a ByteSource for the application frame
   * parser: decrypted chunks are buffered and served as exact-size reads.
   */
  asByteSource(signal?: AbortSignal): {
    read(n: number, signal?: AbortSignal): Promise<Uint8Array | null>
  } {
    const iterator = this.receive(signal)[Symbol.asyncIterator]()
    const buffered = new ChunkQueue()
    let done = false
    return {
      read: async (n: number, readSignal?: AbortSignal): Promise<Uint8Array | null> => {
        // The frame parser passes a per-read timeout signal here; the
        // generator only knows the session-level signal from creation, so
        // race the iterator against the per-read signal. (Without this,
        // body/header timeouts never fire.)
        const effective = readSignal ?? signal
        while (buffered.length < n && !done) {
          if (effective?.aborted) throw abortError(effective)
          const next = await Promise.race([
            iterator.next(),
            new Promise<never>((_, reject) => {
              effective?.addEventListener("abort", () => reject(abortError(effective)), { once: true })
            }),
          ])
          if (next.done) {
            done = true
            break
          }
          buffered.push(next.value)
        }
        if (buffered.length === 0) {
          return null
        }
        const out = buffered.take(Math.min(n, buffered.length))
        return out.length === 0 ? null : out
      },
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.reader.destroy()
    // Graceful close: FIN is sent only after all pending writes flush, so
    // the peer receives every frame before EOF. (destroy() would drop
    // buffered bytes.)
    this.socket.end()
  }

  /** Immediate abortive close for error paths. */
  abort(): void {
    if (this.closed) return
    this.closed = true
    this.reader.destroy()
    this.socket.destroy()
  }

  /**
   * Wait until the peer closes their side (or the timeout elapses).
   * Used by the sender after the last file: the receiver closes first on
   * success, which guarantees it has consumed every byte before our FIN.
   */
  waitForPeerClose(timeoutMs: number): Promise<void> {
    if (this.socket.destroyed) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.socket.removeListener("close", onClose)
        this.socket.removeListener("end", onEnd)
        resolve()
      }, timeoutMs)
      const onClose = () => {
        clearTimeout(timer)
        resolve()
      }
      const onEnd = () => {
        clearTimeout(timer)
        resolve()
      }
      this.socket.once("close", onClose)
      this.socket.once("end", onEnd)
    })
  }
}

export interface HandshakeResult {
  channel: NoiseChannel
  /** The peer's Noise static public key (X25519, 32 bytes). */
  remoteStatic: Uint8Array
  /** The Noise handshake hash, bound to this exact session. */
  handshakeHash: Uint8Array
}

async function runHandshake(socket: Socket, initiator: boolean, signal?: AbortSignal): Promise<HandshakeResult> {
  // Enforce the 60s handshake budget (recorded decision): a peer that
  // connects and sends nothing must not wedge the accept loop forever.
  // The timeout carries a reason so the user sees *what* timed out.
  const budget = new AbortController()
  const budgetTimer = setTimeout(() => {
    budget.abort(new Error(`Noise handshake timed out after ${HANDSHAKE_TIMEOUT_MS / 1000}s: peer stopped responding`))
  }, HANDSHAKE_TIMEOUT_MS)
  const hsSignal = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal
  try {
  // The reader is created once per socket and handed to the channel: bytes
  // that arrive pipelined after the handshake must not be discarded.
  const reader = new SocketReader(socket)
  const handshake = new NoiseHandshake({
    initiator,
    prologue: NOISE_PROLOGUE_V2,
    staticKey: x25519Generate(),
  })
  const empty = new Uint8Array(0)
  if (initiator) {
    await writeMessage(socket, handshake.writeMessage(empty))
    const reply = await readMessage(reader, hsSignal)
    if (reply === null) throw new Error("Noise handshake: peer closed during handshake")
    handshake.readMessage(reply)
    await writeMessage(socket, handshake.writeMessage(empty))
  } else {
    const first = await readMessage(reader, hsSignal)
    if (first === null) throw new Error("Noise handshake: peer closed during handshake")
    handshake.readMessage(first)
    await writeMessage(socket, handshake.writeMessage(empty))
    const last = await readMessage(reader, hsSignal)
    if (last === null) throw new Error("Noise handshake: peer closed during handshake")
    handshake.readMessage(last)
  }
  if (!handshake.handshakeComplete) {
    reader.destroy()
    throw new Error("Noise handshake incomplete")
  }
  const { send, receive } = handshake.split()
  const remoteStatic = handshake.remoteStatic
  if (!remoteStatic) {
    reader.destroy()
    throw new Error("Noise handshake: no remote static key")
  }
  return {
    channel: new NoiseChannel(socket, send, receive, reader),
    remoteStatic,
    handshakeHash: handshake.handshakeHash,
  }
  } finally {
    clearTimeout(budgetTimer)
  }
}

/** Dial a numeric IP:port and complete the Noise_XX handshake as initiator. */
export function dialNoise(host: string, port: number, signal?: AbortSignal): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    // Numeric IPs only: no DNS resolution (avoids leaking the dial target
    // to the configured resolver). isIP() is strict; the old hex/dot/colon
    // regex accepted strings like "cafe" that node:net would then resolve.
    if (isIP(host) === 0) {
      reject(new Error("Only numeric IP endpoints are allowed (no DNS, no discovery)"))
      return
    }
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const socket = connect({ host, port })
    let settled = false
    // A blackholed address must not hang the dial forever (P0-8).
    const connectTimer = setTimeout(() => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      socket.destroy()
      reject(new Error(`connect to ${host}:${port} timed out after ${CONNECT_TIMEOUT_MS / 1000}s: peer unreachable or not listening`))
    }, CONNECT_TIMEOUT_MS)
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      socket.destroy()
      reject(abortError(signal))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    const onError = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      signal?.removeEventListener("abort", onAbort)
      socket.destroy()
      reject(error)
    }
    socket.once("error", onError)
    socket.once("connect", () => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      socket.removeListener("error", onError)
      // The handshake phase honors the caller's signal via runHandshake;
      // the pre-connect abort listener above has done its job.
      signal?.removeEventListener("abort", onAbort)
      runHandshake(socket, true, signal).then(resolve, (error: unknown) => {
        socket.destroy()
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  })
}

export interface ListenerOptions {
  host: string
  port?: number
  signal?: AbortSignal
  /**
   * Handshake deadline in ms, measured from socket accept (default
   * HANDSHAKE_TIMEOUT_MS). Injectable so tests can use a short budget
   * instead of waiting the real 60s.
   */
  handshakeTimeoutMs?: number
}

interface PendingHandshake {
  socket: Socket
  /** Fires HANDSHAKE_TIMEOUT_MS after the socket was accepted. */
  deadline: AbortController
  deadlineTimer: ReturnType<typeof setTimeout>
}

/**
 * Start an explicit, user-controlled listener. The receiver starts this
 * deliberately and stops it deliberately; nothing listens implicitly.
 * Resolves with the server and an async iterator of accepted Noise channels.
 *
 * Handshakes run concurrently (capped at MAX_CONCURRENT_HANDSHAKES) so one
 * idle peer cannot stall the rest, and the 60s handshake budget starts when
 * the socket is accepted, not when a handshake slot frees up (P0-5).
 */
export function listenNoise(options: ListenerOptions): Promise<{
  server: Server
  port: number
  accept(): AsyncGenerator<HandshakeResult>
  close(): Promise<void>
}> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    const pending: PendingHandshake[] = []
    const inFlight = new Set<Socket>()
    /** Sockets accepted but not yet released (pending or handshaking). */
    const live = new Set<Socket>()
    const ipCounts = new Map<string, number>()
    const completed: HandshakeResult[] = []
    let completedResolve: (() => void) | null = null
    let acceptStopped = false
    let closed = false

    const track = (socket: Socket): void => {
      live.add(socket)
      const ip = socket.remoteAddress ?? "unknown"
      ipCounts.set(ip, (ipCounts.get(ip) ?? 0) + 1)
    }

    const release = (socket: Socket): void => {
      if (!live.delete(socket)) return
      const ip = socket.remoteAddress ?? "unknown"
      const n = (ipCounts.get(ip) ?? 0) - 1
      if (n <= 0) ipCounts.delete(ip)
      else ipCounts.set(ip, n)
    }

    const dequeue = (socket: Socket): void => {
      const idx = pending.findIndex((p) => p.socket === socket)
      if (idx < 0) return
      const [item] = pending.splice(idx, 1)
      clearTimeout(item.deadlineTimer)
    }

    const killSocket = (socket: Socket): void => {
      dequeue(socket)
      release(socket)
      socket.destroy()
    }

    const wakeAcceptor = (): void => {
      const r = completedResolve
      completedResolve = null
      r?.()
    }

    const pump = (): void => {
      if (acceptStopped || closed) return
      while (inFlight.size < MAX_CONCURRENT_HANDSHAKES && pending.length > 0) {
        const item = pending.shift()!
        inFlight.add(item.socket)
        void (async (): Promise<{ ok: true; result: HandshakeResult } | { ok: false }> => {
          try {
            // The accept-time deadline dominates: it fires 60s after the
            // socket arrived, while runHandshake's own budget starts at
            // dequeue. Whichever fires first wins.
            const hsSignal = options.signal
              ? AbortSignal.any([options.signal, item.deadline.signal])
              : item.deadline.signal
            const result = await runHandshake(item.socket, false, hsSignal)
            return { ok: true, result }
          } catch {
            return { ok: false }
          } finally {
            // A completed handshake owns its socket now; the deadline must
            // not fire later and kill an established channel.
            clearTimeout(item.deadlineTimer)
          }
        })().then((outcome) => {
          inFlight.delete(item.socket)
          if (outcome.ok) {
            release(item.socket)
            // Bound the completed queue too: an attacker that handshakes
            // but is never consumed must not accumulate channels forever.
            if (completed.length >= MAX_PENDING_QUEUE) {
              completed.shift()!.channel.abort()
            }
            completed.push(outcome.result)
            wakeAcceptor()
          } else {
            killSocket(item.socket)
          }
          pump()
        })
      }
    }

    server.on("connection", (socket: Socket) => {
      // Error and close handlers are attached at accept (P0-5): a queued
      // socket that errors or vanishes must not crash the process or leak
      // queue slots and per-IP counts.
      socket.on("error", () => killSocket(socket))
      socket.once("close", () => killSocket(socket))

      const ip = socket.remoteAddress ?? "unknown"
      if (
        closed ||
        acceptStopped ||
        pending.length >= MAX_PENDING_QUEUE ||
        (ipCounts.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP
      ) {
        socket.destroy()
        return
      }
      track(socket)
      // The handshake budget starts at accept, not at dequeue: N idle
      // connections must not delay a legitimate peer by N x 60s (P0-5).
      const handshakeBudgetMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
      const deadline = new AbortController()
      const deadlineTimer = setTimeout(() => {
        deadline.abort(
          new Error(`Noise handshake timed out after ${handshakeBudgetMs / 1000}s: peer stopped responding`),
        )
        killSocket(socket)
      }, handshakeBudgetMs)
      pending.push({ socket, deadline, deadlineTimer })
      pump()
    })
    server.on("error", reject)
    server.listen(options.port ?? DEFAULT_PORT, options.host, () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : (options.port ?? DEFAULT_PORT)

      async function* accept(): AsyncGenerator<HandshakeResult> {
        const onAbort = (): void => {
          acceptStopped = true
          wakeAcceptor()
        }
        if (options.signal?.aborted) return
        options.signal?.addEventListener("abort", onAbort, { once: true })
        try {
          while (true) {
            pump()
            const next = completed.shift()
            if (next) {
              yield next
              continue
            }
            if (acceptStopped) return
            await new Promise<void>((res) => {
              completedResolve = res
            })
            completedResolve = null
          }
        } finally {
          options.signal?.removeEventListener("abort", onAbort)
        }
      }

      const close = (): Promise<void> =>
        new Promise<void>((res) => {
          closed = true
          acceptStopped = true
          // Destroy everything we still own: queued and in-flight
          // handshakes. Already-yielded channels belong to the caller;
          // completed-but-unyielded channels would otherwise leak.
          for (const item of pending.splice(0)) clearTimeout(item.deadlineTimer)
          for (const s of [...live]) killSocket(s)
          for (const hs of completed.splice(0)) hs.channel.abort()
          wakeAcceptor()
          server.close(() => res())
        })

      resolve({
        server,
        port,
        accept,
        close,
      })
    })
  })
}
