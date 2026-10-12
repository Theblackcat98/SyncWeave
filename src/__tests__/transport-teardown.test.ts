import { expect, test } from "bun:test"
import { connect, type Socket } from "node:net"
import { NoiseHandshake, NOISE_PROLOGUE_V2, x25519Generate } from "../services/noise.js"
import { dialNoise, listenNoise, type HandshakeResult } from "../services/transport.js"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Resolve when `promise` settles, or reject after `ms` (keeps a regression from hanging the suite). */
function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

function onceClosed(socket: Socket): Promise<void> {
  return socket.destroyed ? Promise.resolve() : new Promise((resolve) => socket.once("close", () => resolve()))
}

/** Accept one channel and capture the raw server-side socket that carries it. */
async function acceptPair(listener: Awaited<ReturnType<typeof listenNoise>>): Promise<{
  serverSocket: Socket
  hs: HandshakeResult
  peer: HandshakeResult
}> {
  const serverSocket = new Promise<Socket>((resolve) => listener.server.once("connection", resolve))
  const accepted = listener.accept()
  const peer = await dialNoise("127.0.0.1", listener.port)
  const { value: hs } = await accepted.next()
  return { serverSocket: await serverSocket, hs, peer }
}

/**
 * Initiator that never ends its side of the connection: allowHalfOpen is on,
 * so a FIN from the listener does not make this socket send its own FIN.
 */
async function dialHalfOpenPeer(port: number): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true })
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("error", reject)
  })
  let buf = Buffer.alloc(0)
  let wake: (() => void) | null = null
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    wake?.()
  })
  const readMessage = async (): Promise<Uint8Array> => {
    for (;;) {
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const len = buf.readUInt32BE(0)
        const message = buf.subarray(4, 4 + len)
        buf = buf.subarray(4 + len)
        return message
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
      wake = null
    }
  }
  const writeMessage = (message: Uint8Array): void => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(message.length, 0)
    socket.write(Buffer.concat([header, Buffer.from(message)]))
  }
  const hs = new NoiseHandshake({ initiator: true, prologue: NOISE_PROLOGUE_V2, staticKey: x25519Generate() })
  writeMessage(hs.writeMessage(new Uint8Array(0)))
  hs.readMessage(await readMessage())
  writeMessage(hs.writeMessage(new Uint8Array(0)))
  return socket
}

test("P0-8: close() wakes a reader that is parked waiting for the peer", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  try {
    const { hs, peer } = await acceptPair(listener)
    const bs = hs.channel.asByteSource()
    const parked = bs.read(4)
    await sleep(50)
    const started = performance.now()
    hs.channel.close()
    expect(await within(parked, 1000, "parked read")).toBeNull()
    expect(performance.now() - started).toBeLessThan(1000)
    peer.channel.abort()
  } finally {
    await listener.close()
  }
})

test("P0-8: abort() wakes a parked reader and destroys a channel that was already closed", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  try {
    const { serverSocket, hs, peer } = await acceptPair(listener)
    const bs = hs.channel.asByteSource()
    const parked = bs.read(4)
    await sleep(50)
    hs.channel.close()
    expect(serverSocket.destroyed).toBe(false)
    // close() only sends FIN; abort() after it must still tear the socket down.
    hs.channel.abort()
    expect(await within(parked, 1000, "parked read")).toBeNull()
    expect(serverSocket.destroyed).toBe(true)
    peer.channel.abort()
  } finally {
    await listener.close()
  }
})

test("P0-8: close() destroys a socket whose peer never sends its FIN", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  const serverSocket = new Promise<Socket>((resolve) => listener.server.once("connection", resolve))
  const accepted = listener.accept()
  const peer = await dialHalfOpenPeer(listener.port)
  try {
    const { value: hs } = await accepted.next()
    const socket = await serverSocket
    const started = performance.now()
    hs.channel.close()
    expect(socket.writableEnded).toBe(true)
    expect(socket.destroyed).toBe(false)
    await within(onceClosed(socket), 8000, "half-open socket close")
    const elapsed = performance.now() - started
    // The fallback waits out the grace period; it does not fire immediately.
    expect(elapsed).toBeGreaterThan(4000)
    expect(elapsed).toBeLessThan(7000)
  } finally {
    peer.destroy()
    await listener.close()
  }
}, 15_000)

test("N8: aborting a receive surfaces an AbortError instead of a clean end of stream", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  try {
    const { hs, peer } = await acceptPair(listener)
    const ac = new AbortController()
    const pending = hs.channel.receive(ac.signal).next().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    await sleep(50)
    ac.abort()
    const outcome = await within(pending, 1000, "aborted receive")
    expect("error" in outcome).toBe(true)
    expect((outcome as { error: Error }).error.name).toBe("AbortError")
    hs.channel.abort()
    peer.channel.abort()
  } finally {
    await listener.close()
  }
})

test("N9: close() resolves with an accepted channel still open, and destroys idle and in-flight sockets", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  const idle = connect({ host: "127.0.0.1", port: listener.port })
  idle.on("error", () => {})
  const inFlight = connect({ host: "127.0.0.1", port: listener.port })
  inFlight.on("error", () => {})
  try {
    const { hs, peer } = await acceptPair(listener)
    const idleClosed = onceClosed(idle)
    const inFlightClosed = onceClosed(inFlight)
    // One byte: the socket is promoted to a handshake slot and stalls there.
    inFlight.write(Buffer.from([0]))
    await sleep(100)
    const started = performance.now()
    await within(listener.close(), 1000, "listener.close()")
    expect(performance.now() - started).toBeLessThan(1000)
    await within(Promise.all([idleClosed, inFlightClosed]), 1000, "idle and in-flight sockets")
    expect(hs.channel.isClosed).toBe(false)
    hs.channel.abort()
    peer.channel.abort()
  } finally {
    idle.destroy()
    inFlight.destroy()
    await listener.close()
  }
})

test("N9: aborting the listener's signal releases the port and destroys idle sockets", async () => {
  const ac = new AbortController()
  const listener = await listenNoise({ host: "127.0.0.1", port: 0, signal: ac.signal })
  const idle = connect({ host: "127.0.0.1", port: listener.port })
  idle.on("error", () => {})
  try {
    const idleClosed = onceClosed(idle)
    ac.abort()
    await within(idleClosed, 1000, "idle socket after listener abort")
    const refused = await within(
      new Promise<NodeJS.ErrnoException | null>((resolve) => {
        const probe = connect({ host: "127.0.0.1", port: listener.port })
        probe.once("error", (error: NodeJS.ErrnoException) => resolve(error))
        probe.once("connect", () => {
          probe.destroy()
          resolve(null)
        })
      }),
      1000,
      "connect after listener abort",
    )
    expect(refused?.code).toBe("ECONNREFUSED")
  } finally {
    idle.destroy()
    await listener.close()
  }
})
