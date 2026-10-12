import { expect, test } from "bun:test"
import { connect, type Socket } from "node:net"
import { dialNoise, listenNoise } from "../services/transport.js"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function closedAt(socket: Socket): Promise<void> {
  return socket.destroyed ? Promise.resolve() : new Promise((resolve) => socket.once("close", () => resolve()))
}

/** Reject if `promise` has not settled after `ms`, so a regression fails instead of hanging. */
function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

function u32(n: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(n, 0)
  return out
}

test("P2-5: peer that connects but never handshakes is closed after the injected timeout", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0, handshakeTimeoutMs: 300 })
  try {
    // Raw socket: connects, then goes silent (never sends a handshake).
    const client = connect({ host: "127.0.0.1", port: listener.port })
    const closed = new Promise<void>((resolve) => {
      client.once("close", () => resolve())
    })
    const guard = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("idle peer was not closed after the handshake timeout")), 10_000)
    })
    await Promise.race([closed, guard])
    client.destroy()
  } finally {
    await listener.close()
  }
})

test("P2-6: dialNoise rejects a hostname (not an IP literal) fast with a clear error", async () => {
  const start = Date.now()
  const err = await dialNoise("localhost", 24816).then(
    () => null,
    (e: unknown) => e,
  )
  const elapsed = Date.now() - start
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).toMatch(/numeric IP/i)
  // Fail fast: no DNS lookup, no connect attempt, no 10s connect timeout.
  expect(elapsed).toBeLessThan(2_000)
})

test("P2-6: dialNoise rejects a DNS name with the same clear error", async () => {
  const err = await dialNoise("example.com", 24816).then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).toMatch(/Only numeric IP endpoints are allowed/)
})

test("P0-5: four idle pre-handshake sockets do not delay a legitimate peer", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  const idle: Socket[] = []
  try {
    const accepted = listener.accept()
    const idleClosed: Array<Promise<void>> = []
    for (let i = 0; i < 6; i++) {
      const socket = connect({ host: "127.0.0.1", port: listener.port })
      socket.on("error", () => {})
      idle.push(socket)
      idleClosed.push(closedAt(socket))
    }
    await sleep(100)
    const started = performance.now()
    const peer = await dialNoise("127.0.0.1", listener.port)
    const { value: hs } = await within(accepted.next(), 3000, "legitimate handshake")
    expect(performance.now() - started).toBeLessThan(2000)
    // The idle sockets are not left open for the whole 60s budget: the first-byte deadline closes them.
    await within(Promise.all(idleClosed), 7000, "idle sockets")
    peer.channel.abort()
    hs.channel.abort()
  } finally {
    for (const socket of idle) socket.destroy()
    await listener.close()
  }
}, 20_000)

test("P0-5: a peer that sends one byte and stalls holds a handshake slot for one step, not the whole budget", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0, handshakeStepTimeoutMs: 300 })
  const stalled: Socket[] = []
  try {
    const accepted = listener.accept()
    const stalledClosed: Array<Promise<void>> = []
    for (let i = 0; i < 4; i++) {
      const socket = connect({ host: "127.0.0.1", port: listener.port })
      socket.on("error", () => {})
      socket.write(Buffer.from([0]))
      stalled.push(socket)
      stalledClosed.push(closedAt(socket))
    }
    await sleep(100)
    const started = performance.now()
    const peer = await within(dialNoise("127.0.0.1", listener.port), 3000, "legitimate dial")
    const { value: hs } = await within(accepted.next(), 3000, "legitimate handshake")
    expect(performance.now() - started).toBeLessThan(2000)
    await within(Promise.all(stalledClosed), 3000, "stalled sockets")
    peer.channel.abort()
    hs.channel.abort()
  } finally {
    for (const socket of stalled) socket.destroy()
    await listener.close()
  }
}, 20_000)

test("P0-6: a handshake message whose declared length exceeds the handshake maximum is rejected from its prefix", async () => {
  // 0 is a protocol error; 1025 is one byte over the 1 KiB handshake maximum; 16 MiB is the transport maximum.
  for (const declared of [0, 1025, 16 * 1024 * 1024]) {
    const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
    try {
      const socket = connect({ host: "127.0.0.1", port: listener.port })
      socket.on("error", () => {})
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
      // Send only the length prefix. The body is never sent: the listener must not wait for it.
      socket.write(u32(declared))
      const started = performance.now()
      await within(closedAt(socket), 1000, `handshake with declared length ${declared}`)
      expect(performance.now() - started).toBeLessThan(1000)
      socket.destroy()
    } finally {
      await listener.close()
    }
  }
}, 20_000)
