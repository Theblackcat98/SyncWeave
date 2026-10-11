import { createCliRenderer } from "@opentui/core"
import { createSyncWeaveApp } from "./app.js"
import { MockFileSystemService } from "./services/mock-filesystem.js"
import { MockPeerService } from "./services/mock-peer-service.js"
import { mockDestinations, MockTransferService } from "./services/mock-transfer-service.js"

const renderer = await createCliRenderer({ exitOnCtrlC: false })
const app = createSyncWeaveApp(renderer, {
  filesystem: new MockFileSystemService(),
  peerService: new MockPeerService(),
  transferService: new MockTransferService(),
  receiveDestinations: mockDestinations,
})

renderer.on("destroy", app.dispose)
renderer.start()
