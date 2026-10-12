import { createServer, connect, isIP, type Server, type Socket } from "node:net"
import { NoiseHandshake, x25519Generate, type CipherState } from "./noise.js"

/** Handshake budget (recorded decision): a stalled peer gets 60s, then the socket is destroyed. */
const HANDSHAKE_TIMEOUT_MS = 60_000

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

function writeU32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

/**
 * Buffered exact-size reader for a socket. A single persistent 'data'
 * listener feeds a buffer; readExact pulls from it. This avoids
 * socket.unshift(), whose re-emission semantics differ across runtimes.
 */
class SocketReader {
  private buffered = new Uint8Array(0)
  private waiters: Array<() => void> = []
  private ended = false
  private error: Error | null = null
  private readonly onData: (chunk: Buffer) => void

  constructor(private readonly socket: Socket) {
    this.onData = (chunk: Buffer) => {
      const grown = new Uint8Array(this.buffered.length + chunk.length)
      grown.set(this.buffered)
      grown.set(chunk, this.buffered.length)
      this.buffered = grown
      const waiters = this.waiters
      this.waiters = []
      for (const w of waiters) w()
    }
    socket.on("data", this.onData)
    socket.on("end", () => {
      this.ended = true
      const waiters = this.waiters
      this.waiters = []
      for (const w of waiters) w()
    })
    socket.on("error", (e) => {
      this.error = e
      const waiters = this.waiters
      this.waiters = []
      for (const w of waiters) w()
    })
  }

  async readExact(n: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    while (this.buffered.length < n) {
      if (this.error) throw this.error
      if (this.ended) {
        // FIN was received, but 'data' events already queued in the event
        // loop may not have fired yet. Yield once to let them arrive before
        // declaring EOF; without this, a fast sender can trigger a
        // premature EOF on a slow receiver.
        await new Promise((r) => setImmediate(r))
        // After the yield, whatever is buffered is all there is.
        break
      }
      if (signal?.aborted) throw new DOMException("aborted", "AbortError")
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== done)
          reject(new DOMException("aborted", "AbortError"))
        }
        const done = () => {
          signal?.removeEventListener("abort", onAbort)
          resolve()
        }
        this.waiters.push(done)
        signal?.addEventListener("abort", onAbort, { once: true })
      })
    }
    if (this.buffered.length === 0) {
      return null
    }
    // After end, a short final read is possible; callers treat a short
    // read as a truncated stream.
    const take = Math.min(n, this.buffered.length)
    const out = this.buffered.subarray(0, take)
    this.buffered = this.buffered.subarray(take)
    return Uint8Array.from(out)
  }

  destroy(): void {
    this.socket.removeListener("data", this.onData)
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
    while (!this.isClosed) {
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
    read(n: number): Promise<Uint8Array | null>
  } {
    const iterator = this.receive(signal)[Symbol.asyncIterator]()
    let buffered = new Uint8Array(0)
    let done = false
    return {
      read: async (n: number): Promise<Uint8Array | null> => {
        while (buffered.length < n && !done) {
          const next = await iterator.next()
          if (next.done) {
            done = true
            break
          }
          const grown = new Uint8Array(buffered.length + next.value.length)
          grown.set(buffered)
          grown.set(next.value, buffered.length)
          buffered = grown
        }
        if (buffered.length === 0) {
          return null
        }
        const out = buffered.subarray(0, Math.min(n, buffered.length))
        buffered = buffered.subarray(out.length)
        return out.length === 0 ? null : Uint8Array.from(out)
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
  const budget = AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS)
  const hsSignal = signal ? AbortSignal.any([signal, budget]) : budget
  // The reader is created once per socket and handed to the channel: bytes
  // that arrive pipelined after the handshake must not be discarded.
  const reader = new SocketReader(socket)
  const handshake = new NoiseHandshake({
    initiator,
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
    const socket = connect({ host, port })
    const onError = (error: Error) => {
      socket.destroy()
      reject(error)
    }
    socket.once("error", onError)
    socket.once("connect", () => {
      socket.removeListener("error", onError)
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
}

/**
 * Start an explicit, user-controlled listener. The receiver starts this
 * deliberately and stops it deliberately; nothing listens implicitly.
 * Resolves with the server and an async iterator of accepted Noise channels.
 */
export function listenNoise(options: ListenerOptions): Promise<{
  server: Server
  port: number
  accept(): AsyncGenerator<HandshakeResult>
  close(): Promise<void>
}> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    const pending: Socket[] = []
    let acceptResolve: ((value: IteratorResult<Socket>) => void) | null = null

    server.on("connection", (socket: Socket) => {
      if (acceptResolve) {
        const r = acceptResolve
        acceptResolve = null
        r({ value: socket, done: false })
      } else {
        pending.push(socket)
      }
    })
    server.on("error", reject)
    server.listen(options.port ?? DEFAULT_PORT, options.host, () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : (options.port ?? DEFAULT_PORT)
      async function* accept(): AsyncGenerator<HandshakeResult> {
        while (true) {
          let socket: Socket
          if (pending.length > 0) {
            socket = pending.shift()!
          } else {
            const next = await new Promise<IteratorResult<Socket>>((res) => {
              acceptResolve = res
              options.signal?.addEventListener("abort", () => res({ value: undefined as never, done: true }), { once: true })
            })
            if (next.done) return
            socket = next.value
          }
          try {
            yield await runHandshake(socket, false, options.signal)
          } catch {
            socket.destroy()
            // A failed handshake must not kill the listener; the next
            // connection is still accepted.
          }
        }
      }
      resolve({
        server,
        port,
        accept,
        close: () =>
          new Promise<void>((res) => {
            for (const s of pending) s.destroy()
            server.close(() => res())
          }),
      })
    })
  })
}
