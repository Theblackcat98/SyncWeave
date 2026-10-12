import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { connect, type Socket } from "node:net"
import { dialNoise, listenNoise, type HandshakeResult, type NoiseChannel } from "../services/transport.js"

const KiB = 1024
const MiB = 1024 * KiB
/** Largest Noise plaintext per transport message (65535 minus the 16-byte tag). */
const CHUNK = 65535 - 16
/** Largest 'data' event the runtime delivers in one read (Bun: 512 KiB). pause() overshoots by at most this. */
const SOCKET_READ = 512 * KiB
/** Established channel: high-water mark is 2 max-size messages (~32 MiB), plus one socket read of overshoot. */
const ESTABLISHED_BOUND = 2 * (16 * MiB + KiB) + SOCKET_READ
/** Channel nobody has accepted yet: high-water mark is 256 KiB, plus one socket read of overshoot. */
const PRE_ACCEPT_BOUND = 256 * KiB + SOCKET_READ

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Reject if `promise` has not settled after `ms`, so a regression fails instead of hanging. */
function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/** Send 64 KiB payloads as fast as the transport allows until the deadline (or the channel dies). */
async function floodUntil(channel: NoiseChannel, ms: number): Promise<void> {
  const payload = new Uint8Array(CHUNK).fill(0x5a)
  const deadline = Date.now() + ms
  while (Date.now() < deadline && !channel.isClosed) {
    try {
      await channel.send(payload)
    } catch {
      return
    }
  }
}

async function acceptOne(
  accepted: AsyncGenerator<HandshakeResult>,
): Promise<HandshakeResult> {
  const { value } = await accepted.next()
  return value
}

test("P0-4: a consumer that never reads keeps the receive buffer at the high-water mark", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  try {
    const accepted = listener.accept()
    const sender = await dialNoise("127.0.0.1", listener.port)
    const hs = await acceptOne(accepted)
    const flood = floodUntil(sender.channel, 1500)
    await sleep(1600)
    // The sender has pushed far more than the bound, so the bound is what is being tested.
    expect(hs.channel.bufferedBytes).toBeGreaterThan(MiB)
    expect(hs.channel.bufferedBytes).toBeLessThanOrEqual(ESTABLISHED_BOUND)
    sender.channel.abort()
    hs.channel.abort()
    await flood
  } finally {
    await listener.close()
  }
}, 20_000)

test("N6: channels completed but not yet accepted each stay within the pre-accept cap", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  const senders: HandshakeResult[] = []
  try {
    for (let i = 0; i < 4; i++) senders.push(await dialNoise("127.0.0.1", listener.port))
    // Nobody is accepting yet: the four channels sit in the completed queue.
    const floods = senders.map((s) => floodUntil(s.channel, 1200))
    await sleep(1300)
    const accepted = listener.accept()
    const buffered: number[] = []
    for (let i = 0; i < senders.length; i++) {
      const hs = await acceptOne(accepted)
      buffered.push(hs.channel.bufferedBytes)
      hs.channel.abort()
    }
    for (const bytes of buffered) {
      expect(bytes).toBeLessThanOrEqual(PRE_ACCEPT_BOUND)
    }
    // Before the fix each channel held ~32 MiB, so four held ~128 MiB.
    expect(buffered.reduce((sum, b) => sum + b, 0)).toBeLessThanOrEqual(senders.length * PRE_ACCEPT_BOUND)
    for (const s of senders) s.channel.abort()
    await Promise.all(floods)
  } finally {
    for (const s of senders) s.channel.abort()
    await listener.close()
  }
}, 20_000)

test("P0-4: a completed channel nobody accepts is destroyed when it exceeds the pre-accept hard cap", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  const senderSocket = new Promise<Socket>((resolve) => listener.server.once("connection", resolve))
  try {
    const sender = await dialNoise("127.0.0.1", listener.port)
    const socket = await senderSocket
    // Completed, but no one calls accept(): the channel is still under the pre-accept cap.
    await sleep(100)
    expect(socket.destroyed).toBe(false)
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()))
    // A peer that ignores backpressure: 3 MiB arrives in one read, above the 2 MiB cap.
    socket.emit("data", Buffer.alloc(3 * MiB))
    await within(closed, 2000, "oversized pre-accept channel")
    expect(socket.destroyed).toBe(true)
    sender.channel.abort()
  } finally {
    await listener.close()
  }
})

test("P0-4: an accepted channel still delivers a read larger than the pre-accept cap", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  try {
    const accepted = listener.accept()
    const sender = await dialNoise("127.0.0.1", listener.port)
    const hs = await acceptOne(accepted)
    // 1 MiB of frames, four times the pre-accept high-water mark: the accepted channel must still serve it.
    const messages = 17
    const wanted = MiB
    const writer = (async () => {
      for (let i = 0; i < messages; i++) {
        await sender.channel.send(new Uint8Array(CHUNK).fill(i + 1))
      }
    })()
    const bs = hs.channel.asByteSource()
    const got = await within(bs.read(wanted), 5000, "1 MiB read")
    expect(got?.length).toBe(wanted)
    expect(got?.[0]).toBe(1)
    expect(got?.[CHUNK]).toBe(2)
    await writer
    sender.channel.abort()
    hs.channel.abort()
  } finally {
    await listener.close()
  }
}, 20_000)

test("N4: a read that times out does not swallow the next frame", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  try {
    const accepted = listener.accept()
    const sender = await dialNoise("127.0.0.1", listener.port)
    const hs = await acceptOne(accepted)
    const bs = hs.channel.asByteSource()
    let timedOut: unknown = null
    try {
      await bs.read(4, AbortSignal.timeout(200))
    } catch (error) {
      timedOut = error
    }
    expect(timedOut).not.toBeNull()
    await sender.channel.send(new Uint8Array([1, 2, 3, 4]))
    await sender.channel.send(new Uint8Array([5, 6, 7, 8]))
    expect(Array.from((await bs.read(4, AbortSignal.timeout(2000))) ?? [])).toEqual([1, 2, 3, 4])
    expect(Array.from((await bs.read(4, AbortSignal.timeout(2000))) ?? [])).toEqual([5, 6, 7, 8])
    sender.channel.abort()
    hs.channel.abort()
  } finally {
    await listener.close()
  }
})

test("N3: a read's abort listener is removed as soon as the read settles", async () => {
  const listener = await listenNoise({ host: "127.0.0.1", port: 0 })
  try {
    const accepted = listener.accept()
    const sender = await dialNoise("127.0.0.1", listener.port)
    const hs = await acceptOne(accepted)
    const bs = hs.channel.asByteSource()
    const ac = new AbortController()
    const parked = bs.read(4, ac.signal)
    await sleep(20)
    await sender.channel.send(new Uint8Array([9, 9, 9, 9]))
    expect(Array.from((await parked) ?? [])).toEqual([9, 9, 9, 9])
    // A settled read must not keep a listener (and the chunks it closes over) alive on a long-lived signal.
    expect(getEventListeners(ac.signal, "abort").length).toBe(0)
    sender.channel.abort()
    hs.channel.abort()
  } finally {
    await listener.close()
  }
})
