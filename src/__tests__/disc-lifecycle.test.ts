import { describe, expect, test } from "bun:test"
import {
  buildAnnouncement,
  type DiscoveredPeer,
  type DiscoveryChange,
  type DiscoveryStartOptions,
  DiscoveryService,
  PEER_EXPIRY_MS,
} from "../services/discovery.js"
import { generateEphemeralIdentity } from "../services/peer-id.js"

// P1-31 (start/stop, clock, manual prefix), P1-30 and P2-22 (error events and
// change reasons). Sockets are injected so the failure paths are deterministic.

const SELF = generateEphemeralIdentity().peerId
const OTHER = generateEphemeralIdentity().peerId

type Handlers = { data?: unknown; error?: (sock: unknown, e: unknown) => void }

function fakeSocket(opts: { joinFails?: boolean; sendFails?: () => boolean } = {}) {
  const state = { closed: 0, sends: 0, joins: 0 }
  const socket = {
    send(_bytes: Uint8Array, _port: number, _host: string) {
      state.sends++
      if (opts.sendFails?.()) throw new Error("EPERM: send blocked")
    },
    close() {
      state.closed++
    },
    setMulticastTTL() {},
    setMulticastLoopback() {},
    addMembership(_group: string) {
      state.joins++
      if (opts.joinFails) throw new Error("ENODEV: no multicast route")
    },
  }
  return { socket, state }
}

/** Build a DiscoveryService whose bind is a controllable fake. */
function fakeService(bind: (options: { socket: Handlers }) => Promise<unknown>): DiscoveryService {
  return new DiscoveryService(bind as unknown as typeof Bun.udpSocket)
}

function startOpts(extra: Partial<DiscoveryStartOptions> = {}): DiscoveryStartOptions {
  return { alias: "t", peerId: SELF, tcpPort: 24816, discoveryPort: 24990, ...extra }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("P1-31: stop() during a pending start()", () => {
  test("stop before the bind resolves leaves the service stopped and closes the bound socket", async () => {
    const bind = deferred<unknown>()
    const { socket, state } = fakeSocket()
    const svc = fakeService(() => bind.promise)
    const starting = svc.start(startOpts())
    svc.stop()
    bind.resolve(socket)
    await expect(starting).rejects.toThrow("cancelled by stop()")
    expect(svc.isStarted).toBe(false)
    expect(state.closed).toBe(1)
    expect(state.sends).toBe(0)
  })

  test("a start() that was cancelled can be followed by a fresh start()", async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const binds = [first, second]
    const svc = fakeService(() => binds.shift()!.promise)
    const a = svc.start(startOpts())
    svc.stop()
    const b = svc.start(startOpts())
    // The first bind completes after the second start() began: it must not
    // clear the second start's pending state or leak its socket.
    const one = fakeSocket()
    first.resolve(one.socket)
    await expect(a).rejects.toThrow("cancelled by stop()")
    expect(one.state.closed).toBe(1)
    expect(svc.isStarted).toBe(false)
    const two = fakeSocket()
    second.resolve(two.socket)
    await b
    expect(svc.isStarted).toBe(true)
    expect(two.state.closed).toBe(0)
    svc.stop()
    expect(two.state.closed).toBe(1)
  })

  test("while a start() is pending a second start() is refused", async () => {
    const bind = deferred<unknown>()
    const svc = fakeService(() => bind.promise)
    const a = svc.start(startOpts())
    await expect(svc.start(startOpts())).rejects.toThrow("already started")
    bind.resolve(fakeSocket().socket)
    await a
    svc.stop()
  })

  test("a bind failure clears the pending state so start() can be retried", async () => {
    let attempt = 0
    const svc = fakeService(async () => {
      attempt++
      if (attempt === 1) throw new Error("EADDRINUSE")
      return fakeSocket().socket
    })
    await expect(svc.start(startOpts())).rejects.toThrow("EADDRINUSE")
    expect(svc.isStarted).toBe(false)
    await svc.start(startOpts())
    expect(svc.isStarted).toBe(true)
    svc.stop()
  })

  test("with a real socket, stop() during a pending start() releases the port", async () => {
    const port = 24983
    const svc = new DiscoveryService()
    const starting = svc.start({ alias: "t", peerId: SELF, tcpPort: 24816, discoveryPort: port })
    svc.stop()
    await starting.catch(() => {})
    expect(svc.isStarted).toBe(false)
    // The port is free again: another instance can bind it.
    const other = new DiscoveryService()
    await other.start({ alias: "u", peerId: OTHER, tcpPort: 24816, discoveryPort: port })
    expect(other.isStarted).toBe(true)
    other.stop()
  })

  test("start, stop, start again on a real socket: no leaked bind, second start accepted", async () => {
    const port = 24984
    const svc = new DiscoveryService()
    await svc.start({ alias: "t", peerId: SELF, tcpPort: 24816, discoveryPort: port })
    svc.stop()
    expect(svc.isStarted).toBe(false)
    await svc.start({ alias: "t", peerId: SELF, tcpPort: 24816, discoveryPort: port })
    expect(svc.isStarted).toBe(true)
    svc.stop()
  })
})

describe("P1-31: monotonic clock", () => {
  test("lastSeen is on the performance.now() clock, not wall time", () => {
    const svc = new DiscoveryService()
    ;(svc as unknown as { ownPeerId: string }).ownPeerId = SELF
    svc.handleDatagram(buildAnnouncement("bob", OTHER, 24816), "192.168.1.20")
    const seen = svc.listPeers()[0]!.lastSeen
    expect(seen).toBeLessThanOrEqual(performance.now())
    expect(seen).toBeLessThan(Date.now() / 2)
  })

  test("expiry is unaffected by a wall-clock jump", () => {
    const svc = new DiscoveryService()
    ;(svc as unknown as { ownPeerId: string }).ownPeerId = SELF
    svc.handleDatagram(buildAnnouncement("bob", OTHER, 24816), "192.168.1.20")
    const realNow = Date.now
    try {
      // The wall clock jumps forward an hour: a monotonic clock does not expire the peer.
      Date.now = () => realNow() + 3_600_000
      svc.sweepExpired()
      expect(svc.listPeers()).toHaveLength(1)
    } finally {
      Date.now = realNow
    }
  })

  test("sweepExpired still drops a silent peer on the monotonic clock", () => {
    const svc = new DiscoveryService()
    ;(svc as unknown as { ownPeerId: string }).ownPeerId = SELF
    svc.handleDatagram(buildAnnouncement("bob", OTHER, 24816), "192.168.1.20")
    svc.sweepExpired(performance.now() + PEER_EXPIRY_MS + 1)
    expect(svc.listPeers()).toEqual([])
  })
})

describe("P1-31: addManualPeer prefix validation", () => {
  const manual = (peerId: string): DiscoveredPeer => ({
    peerId,
    alias: "rogue",
    address: "10.0.0.9",
    tcpPort: 24816,
    lastSeen: 0,
  })

  test("a peerId without the manual: prefix is rejected", () => {
    const svc = new DiscoveryService()
    expect(() => svc.addManualPeer(manual(OTHER))).toThrow('must start with "manual:"')
    expect(svc.listPeers()).toEqual([])
  })

  test("a manual peer survives expiry and gets a monotonic lastSeen", () => {
    const svc = new DiscoveryService()
    svc.addManualPeer(manual("manual:10.0.0.9:24816"))
    const peer = svc.listPeers()[0]!
    expect(peer.lastSeen).toBeLessThanOrEqual(performance.now())
    svc.sweepExpired(performance.now() + 3_600_000)
    expect(svc.listPeers()).toHaveLength(1)
  })
})

describe("P1-30 / P2-22: discovery error events", () => {
  test("multicast join failure reports onError and keeps the service running (announce-only)", async () => {
    const errors: string[] = []
    const { socket, state } = fakeSocket({ joinFails: true })
    const svc = fakeService(async () => socket)
    await svc.start(startOpts({ events: { onError: (e: Error) => errors.push(e.message) } }))
    expect(svc.isStarted).toBe(true)
    expect(state.joins).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("multicast join failed (discovery receive disabled)")
    expect(errors[0]).toContain("ENODEV")
    svc.stop()
  })

  test("multicast join failure without an onError handler does not throw", async () => {
    const { socket } = fakeSocket({ joinFails: true })
    const svc = fakeService(async () => socket)
    await svc.start(startOpts())
    expect(svc.isStarted).toBe(true)
    svc.stop()
  })

  test("a socket error event is forwarded to onError, wrapping non-Error values", async () => {
    const errors: string[] = []
    let handlers: Handlers | undefined
    const svc = fakeService(async (options) => {
      handlers = (options as unknown as { socket: Handlers }).socket
      return fakeSocket().socket
    })
    await svc.start(startOpts({ events: { onError: (e: Error) => errors.push(e.message) } }))
    handlers!.error!(null, new Error("socket boom"))
    handlers!.error!(null, "plain string failure")
    expect(errors).toEqual(["socket boom", "plain string failure"])
    svc.stop()
  })

  test("announce failure is reported once, not on every tick, and re-arms after a successful send", async () => {
    const errors: string[] = []
    let failing = true
    const { socket } = fakeSocket({ sendFails: () => failing })
    const svc = fakeService(async () => socket)
    // start() announces immediately: that first send fails.
    await svc.start(startOpts({ events: { onError: (e: Error) => errors.push(e.message) } }))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("discovery announce failed: EPERM")
    // Further failing announces stay silent (reported once until a send succeeds).
    const announce = (svc as unknown as { announce: () => void }).announce.bind(svc)
    announce()
    announce()
    expect(errors).toHaveLength(1)
    // A successful send re-arms the report; the next failure is reported again.
    failing = false
    announce()
    failing = true
    announce()
    expect(errors).toHaveLength(2)
    svc.stop()
  })

  test("no onError fires when discovery starts and announces cleanly", async () => {
    const errors: string[] = []
    const { socket } = fakeSocket()
    const svc = fakeService(async () => socket)
    await svc.start(startOpts({ events: { onError: (e: Error) => errors.push(e.message) } }))
    expect(errors).toEqual([])
    svc.stop()
  })
})

describe("P1-30: onPeersChanged reports why the list changed", () => {
  function recordingService(): { svc: DiscoveryService; changes: DiscoveryChange[] } {
    const svc = new DiscoveryService()
    ;(svc as unknown as { ownPeerId: string }).ownPeerId = SELF
    const changes: DiscoveryChange[] = []
    ;(svc as unknown as { events: unknown }).events = {
      onPeersChanged: (_p: DiscoveredPeer[], change: DiscoveryChange) => changes.push(change),
    }
    return { svc, changes }
  }

  test("a new peer is reported as added", () => {
    const { svc, changes } = recordingService()
    svc.handleDatagram(buildAnnouncement("bob", OTHER, 24816), "192.168.1.20")
    expect(changes).toEqual([{ reason: "added", peerIds: [OTHER] }])
  })

  test("an address change for a known ID is reported as updated, with the field and previous entry", () => {
    const { svc, changes } = recordingService()
    svc.handleDatagram(buildAnnouncement("bob", OTHER, 24816), "192.168.1.20")
    const before = svc.listPeers()[0]!
    svc.handleDatagram(buildAnnouncement("bob", OTHER, 24816), "192.168.1.99")
    const change = changes.at(-1)!
    expect(change.reason).toBe("updated")
    expect(change.peerIds).toEqual([OTHER])
    expect(change.fields).toEqual(["address"])
    expect(change.previous).toMatchObject({ peerId: OTHER, address: "192.168.1.20" })
    expect(change.previous).toBe(before)
    const after = svc.listPeers()[0]!
    expect(after.address).toBe("192.168.1.99")
    expect(after.changedAt).toBeGreaterThan(0)
  })

  test("alias and port changes are reported with their own field names", () => {
    const { svc, changes } = recordingService()
    svc.handleDatagram(buildAnnouncement("bob", OTHER, 24816), "192.168.1.20")
    svc.handleDatagram(buildAnnouncement("bobby", OTHER, 24816), "192.168.1.20")
    expect(changes.at(-1)).toMatchObject({ reason: "updated", fields: ["alias"] })
    svc.handleDatagram(buildAnnouncement("bobby", OTHER, 24999), "192.168.1.20")
    expect(changes.at(-1)).toMatchObject({ reason: "updated", fields: ["tcpPort"] })
  })

  test("an identical re-announce is not reported and does not touch changedAt", () => {
    const { svc, changes } = recordingService()
    svc.handleDatagram(buildAnnouncement("bob", OTHER, 24816), "192.168.1.20")
    svc.handleDatagram(buildAnnouncement("bob", OTHER, 24816), "192.168.1.20")
    expect(changes).toHaveLength(1)
    expect(svc.listPeers()[0]!.changedAt).toBeUndefined()
  })

  test("expiry is reported as expired with the affected IDs", () => {
    const { svc, changes } = recordingService()
    svc.handleDatagram(buildAnnouncement("bob", OTHER, 24816), "192.168.1.20")
    svc.sweepExpired(performance.now() + PEER_EXPIRY_MS + 1)
    expect(changes.at(-1)).toEqual({ reason: "expired", peerIds: [OTHER] })
  })

  test("stop() reports cleared with the IDs it dropped", () => {
    const { svc, changes } = recordingService()
    svc.handleDatagram(buildAnnouncement("bob", OTHER, 24816), "192.168.1.20")
    svc.stop()
    expect(changes.at(-1)).toEqual({ reason: "cleared", peerIds: [OTHER] })
    expect(svc.listPeers()).toEqual([])
  })
})
