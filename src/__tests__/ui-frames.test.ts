import { afterEach, expect, test } from "bun:test"
import type { TransferRecord } from "../domain.js"
import { renderApp } from "../ui/render.js"
import { MockFileSystemService } from "../services/mock-filesystem.js"
import { MockPeerService } from "../services/mock-peer-service.js"
import { consentRequest, frameRows, frameText, mountUi, unmountAll } from "./ui-harness.js"

afterEach(unmountAll)

const PEERS = Array.from({ length: 10 }, (_, i) => ({ peerId: `z${i}`, alias: `device-${i}`, address: `10.0.0.${i + 1}`, tcpPort: 24816 }))

test("header keeps its border and fits the terminal at every width from 88 to 112, in both modes (P2-5, R13)", async () => {
  for (const mode of ["mock", "real"] as const) {
    for (let width = 88; width <= 112; width += 1) {
      const { setup } = await mountUi({ width, height: 36, mode, peers: PEERS.slice(0, 2) })
      const rows = frameRows(setup)
      const label = `${mode} ${width}`
      expect(rows[0]!.trimStart().startsWith("┌"), label).toBe(true)
      expect(rows[1]!.trimStart().startsWith("│"), label).toBe(true)
      expect(rows[2]!.trimStart().startsWith("└"), label).toBe(true)
      expect(rows[0]!.trimEnd().endsWith("┐"), label).toBe(true)
      expect(rows[1]!.trimEnd().endsWith("│"), label).toBe(true)
      expect(rows[2]!.trimEnd().endsWith("┘"), label).toBe(true)
      for (const row of rows.slice(0, 3)) expect(Bun.stringWidth(row.trimEnd()), label).toBeLessThanOrEqual(width)
      await unmountAll()
    }
  }
})

test("real-mode header shows the listening address and keeps the peer count when there is room", async () => {
  const { setup } = await mountUi({ width: 112, height: 36, mode: "real", peers: PEERS.slice(0, 2) })
  const header = frameRows(setup)[1]!
  expect(header).toContain("LISTENING [::]:24816")
  expect(header).toContain("2 peers")
  expect(header).toContain("REAL FILES")
})

test("consent fits a 120x24 terminal without overdrawing its border or buttons (P0-12)", async () => {
  const { setup, app } = await mountUi({ width: 120, height: 24, mode: "real" })
  app.state.request = consentRequest({}, 25)
  app.state.screen = "consent"
  app.render()
  await setup.flush()
  const rows = frameRows(setup)
  const decline = rows.findIndex((row) => row.includes("Decline · X"))
  const cardBottom = rows.findIndex((row, index) => index > decline && row.trimStart().startsWith("└"))
  const footer = rows.findIndex((row) => row.includes("Accept selected · Enter"))
  // The buttons sit inside the card, and the card's bottom border closes it above the footer hint.
  expect(decline).toBeGreaterThan(0)
  expect(cardBottom).toBeGreaterThan(decline)
  expect(footer).toBeGreaterThan(0)
  expect(footer).toBeLessThan(cardBottom)
  expect(rows.some((row) => row.includes("Security code: ABCD-1234"))).toBe(true)
  expect(rows.some((row) => row.includes("Sender (claimed)"))).toBe(true)
  // Only one file row fits next to the header, so the scroll hint is shown.
  expect(rows.some((row) => row.includes("↓ 24 more"))).toBe(true)
  expect(rows.some((row) => row.includes("quarterly") || row.includes("report-0.pdf"))).toBe(true)
})

test("consent sender line marks the alias as claimed and truncates it to the card", async () => {
  const { setup, app } = await mountUi({ width: 58, height: 24, mode: "real" })
  app.state.request = consentRequest({
    peer: { id: "zAAA", name: "测试设备-Laptop-very-long-name-for-truncation", host: "192.168.100.123", port: 24816, fingerprint: "zAAA", online: true },
  })
  app.state.screen = "consent"
  app.render()
  await setup.flush()
  const sender = frameRows(setup).find((row) => row.includes("Sender")) ?? ""
  expect(sender).toContain("(claimed)")
  expect(Bun.stringWidth(sender.trimEnd())).toBeLessThanOrEqual(58)
  expect(sender.trimEnd().endsWith("│")).toBe(true)
})

test("consent shows the status line and the destination input with its validation message (P0-9, picker feedback)", async () => {
  const { setup, app } = await mountUi({ width: 120, height: 36, mode: "real", destinations: ["/tmp/a", "/tmp/b"] })
  app.state.request = consentRequest()
  app.state.screen = "consent"
  app.state.status = "Invalid destination: /etc is a system directory · fix it or press Esc"
  app.state.destinationInput = "/etc"
  app.render()
  await setup.flush()
  const text = frameText(setup)
  expect(text).toContain("Invalid destination")
  expect(text).toContain("Add destination: /etc")
})

test("send review shows the security code box, marks the receiver claimed and disables send while confirming (P0-1)", async () => {
  const { setup, app } = await mountUi({ width: 120, height: 24, mode: "real" })
  app.state.staged.local.add("nonexistent")
  app.state.sendSasConfirm = { sas: "ABCD-1234", peerFingerprint: "zAAA-FINGERPRINT", peerName: "Lab laptop" }
  app.state.screen = "send-review"
  app.render()
  await setup.flush()
  const text = frameText(setup)
  expect(text).toContain("Security code: ABCD-1234")
  expect(text).toContain("does it match the receiver's screen?")
  expect(text).toContain("Enter/y confirm")
  expect(text).toContain("Esc/n cancel")
  expect(text).toContain("Lab laptop (claimed)")
  expect(text).toContain("zAAA-FINGERPRINT")
  // Send stays disabled while the code is pending: the button shows, the app ignores it.
  expect(text).toContain("Ask receiver · Enter")
  expect(text).not.toContain("Sending…")
})

test("send review shows Sending and the status line while a real send is in flight", async () => {
  const { setup, app } = await mountUi({ width: 120, height: 36, mode: "real" })
  app.state.sending = true
  app.state.status = "Sending report.pdf (1/2) · 40%"
  app.state.screen = "send-review"
  app.render()
  await setup.flush()
  const text = frameText(setup)
  expect(text).toContain("Sending…")
  expect(text).toContain("Sending report.pdf (1/2) · 40%")
  expect(text).toContain("Cancel send · Esc")
})

test("receiver panel reports the real transfer in flight, not a mock session (P1-1)", async () => {
  const { setup, app } = await mountUi({ width: 120, height: 36, mode: "real" })
  const queue: TransferRecord[] = [{
    id: "real-send-1",
    direction: "outgoing",
    peerName: "device-0",
    files: ["a.txt", "b.txt"],
    acceptedFiles: ["a.txt"],
    acceptedBytes: 10,
    destination: "10.0.0.1:24816",
    fileIds: ["/x/a.txt", "/x/b.txt"],
    status: "transferring",
    progress: 50,
    createdAt: 0,
  }]
  // Rendered directly: the app's own render replaces the queue from its transfer service.
  renderApp({
    renderer: setup.renderer,
    state: app.state,
    mode: "real",
    filesystem: new MockFileSystemService(),
    peerService: new MockPeerService(),
    receiveDestinations: ["/tmp"],
    peers: [{ id: "z0", name: "device-0", host: "10.0.0.1", port: 24816, fingerprint: "z0", online: true }],
    favorites: [],
    queue,
    actions: { command() {}, selectEntry() {}, scrollPane() {}, selectConsentFile() {}, toggleConsentFile() {}, selectFavorite() {} },
    real: { bindAddr: "::", tcpPort: 24816 },
  })
  await setup.flush()
  const text = frameText(setup)
  expect(text).toContain("Session: Transferring with device-0")
  expect(text).toContain("Transfer: 1/2 files · 50%")
  expect(text).not.toContain("no active session")
})

test("receiver list stays windowed around the selected peer when the terminal is short (P2-10)", async () => {
  const { setup, app } = await mountUi({ width: 120, height: 24, mode: "real", peers: PEERS })
  app.state.peerIndex = 9
  app.render()
  await setup.flush()
  const rows = frameRows(setup)
  const selected = rows.find((row) => row.includes("▸"))
  expect(selected).toContain("device-9")
  expect(rows.some((row) => row.includes("device-0 "))).toBe(false)
})

test("the cursor row is drawn at every height from 14 to 40 (P2-7)", async () => {
  const { setup, app } = await mountUi({ width: 120, height: 14, mode: "mock" })
  const entries = new MockFileSystemService().list("local", app.state.paths.local)
  const last = entries[entries.length - 1]!
  for (let height = 14; height <= 40; height += 1) {
    setup.resize(120, height)
    app.state.cursors.local = entries.length - 1
    app.render()
    await setup.flush()
    expect(frameText(setup), `height ${height}`).toContain(last.name)
  }
})

test("a terminal under 20 columns shows a too-small message instead of a garbled layout (P2-18)", async () => {
  const { setup, app } = await mountUi({ width: 19, height: 6, mode: "real" })
  app.render()
  await setup.flush()
  expect(frameText(setup)).toContain("Terminal too small")
})

test("real-mode screens carry no mock-only controls or copy", async () => {
  const workspace = await mountUi({ width: 120, height: 36, mode: "real", peers: PEERS.slice(0, 1) })
  const workspaceText = frameText(workspace.setup)
  for (const phrase of ["Peers", "Favorites", "Receive", "Diff", "Mock", "simulat", "Destination · D", "Rename", "q Peers", "d Diff"]) {
    expect(workspaceText, `workspace: ${phrase}`).not.toContain(phrase)
  }
  expect(workspaceText).toContain("t Queue")
  await unmountAll()

  const help = await mountUi({ width: 120, height: 36, mode: "real" })
  help.app.state.screen = "help"
  help.app.render()
  await help.setup.flush()
  const helpText = frameText(help.setup)
  expect(helpText).not.toContain("q / v / p")
  expect(helpText).not.toContain("d / t / ?")
  expect(helpText).toContain("t / ?")
  expect(helpText).not.toContain("Mock")
  await unmountAll()

  const queue = await mountUi({ width: 120, height: 36, mode: "real" })
  queue.app.state.screen = "queue"
  queue.app.render()
  await queue.setup.flush()
  const queueText = frameText(queue.setup)
  expect(queueText).not.toContain("Retry")
  expect(queueText).not.toContain("press S")
  expect(queueText).not.toContain("appear here")
  expect(queueText).toContain("press s to send")
  await unmountAll()

  const consent = await mountUi({ width: 120, height: 36, mode: "real", destinations: ["/tmp/only"] })
  consent.app.state.request = consentRequest()
  consent.app.state.screen = "consent"
  consent.app.render()
  await consent.setup.flush()
  const consentText = frameText(consent.setup)
  expect(consentText).not.toContain("Destination · D")
  expect(consentText).not.toContain("r Rename")
  expect(consentText).not.toContain("Favorites and manual")
  expect(consentText).not.toContain("Rename")
  expect(consentText).toContain("Accepting applies to this transfer only")
})
