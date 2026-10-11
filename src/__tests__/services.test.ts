import { expect, test } from "bun:test"
import { MockFileSystemService } from "../services/mock-filesystem.js"
import { MockPeerService } from "../services/mock-peer-service.js"
import { MockTransferService } from "../services/mock-transfer-service.js"
import type { FileSystemService, PeerService, TransferService } from "../services/ports.js"

test("mock filesystem instances isolate state and stage only explicitly synced file ids", () => {
  const first: FileSystemService = new MockFileSystemService()
  const second = new MockFileSystemService()
  first.markSynced("local", ["architecture"])
  expect(first.list("local", first.paths.local)[0]?.state).toBe("synced")
  expect(second.list("local", second.paths.local)[0]?.state).toBe("modified")
  expect(first.list("local", first.paths.local).find((file) => file.id === "configs")?.kind).toBe("directory")
})

test("transfer request stays out of the queue until a receiver explicitly accepts", () => {
  const peerService: PeerService = new MockPeerService()
  const peers = peerService.discover()
  const service: TransferService = new MockTransferService()
  const request = service.createRequest("incoming", peers[0]!, [
    { id: "one", name: "one.txt", bytes: 1_024 },
    { id: "two", name: "two.png", bytes: 2_048 },
  ])

  expect(service.queue()).toHaveLength(0)
  request.files[0]!.accepted = false
  const accepted = request.files.filter((file) => file.accepted)
  const transfer = service.acceptRequest(request, "~/Downloads/SyncWeave", accepted)
  expect(transfer.status).toBe("queued")
  expect(transfer.progress).toBe(0)
  expect(transfer.acceptedFiles).toEqual(["two.png"])
  expect(transfer.fileIds).toEqual(["two"])
  expect(transfer.acceptedBytes).toBe(2_048)
  expect(service.queue()).toHaveLength(1)
})

test("decline, fail, cancel, and retry remain distinct local queue states", () => {
  const peer = new MockPeerService().discover()[0]!
  const service = new MockTransferService()
  const declinedRequest = service.createRequest("incoming", peer, [{ id: "declined", name: "skip.md", bytes: 10 }])
  expect(service.declineRequest(declinedRequest).status).toBe("declined")

  const request = service.createRequest("outgoing", peer, [{ id: "file", name: "notes.md", bytes: 100 }], "local")
  const queued = service.acceptRequest(request, "~/Documents/Shared", request.files)
  service.progress(queued.id, 30)
  expect(service.fail(queued.id, "mock timeout")?.status).toBe("failed")
  const retry = service.retry(queued.id)!
  expect(retry.id).not.toBe(queued.id)
  expect(retry.status).toBe("queued")
  expect(retry.progress).toBe(0)
  expect(retry.sourcePane).toBe("local")
  expect(service.cancel(retry.id)?.status).toBe("cancelled")
})

test("Favorites are local shortcuts and contain no paired or verified trust flag", () => {
  const service = new MockPeerService()
  const peer = service.discover()[0]!
  expect(service.toggleFavorite(peer)).toBe(true)
  const favorite = service.favorites()[0]!
  expect(favorite.alias).toBe(peer.name)
  expect(favorite.fingerprint).toBe(peer.fingerprint)
  expect(favorite).not.toHaveProperty("verified")
  expect(favorite).not.toHaveProperty("paired")
  expect(service.toggleFavorite(peer)).toBe(false)
  expect(service.favorites()).toHaveLength(0)
})

test("mock discovery deterministically simulates a peer appearing and disappearing", () => {
  const service = new MockPeerService()
  expect(service.discover().find((peer) => peer.id === "pixel")?.online).toBe(true)
  for (let pulse = 0; pulse < 3; pulse += 1) service.pulse()
  expect(service.pulse().find((peer) => peer.id === "pixel")?.online).toBe(false)
  for (let pulse = 0; pulse < 4; pulse += 1) service.pulse()
  expect(service.discover().find((peer) => peer.id === "pixel")?.online).toBe(true)
})
