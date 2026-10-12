import { expect, test } from "bun:test"
import { connect } from "node:net"
import { dialNoise, listenNoise } from "../services/transport.js"

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
