import { afterEach, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { createSyncWeaveApp, type AppDependencies, type SyncWeaveApp } from "../app.js"
import type { MockEntry, Pane } from "../domain.js"
import { LIST_PAGE_SIZE, type FileSystemService } from "../services/ports.js"
import { MockPeerService } from "../services/mock-peer-service.js"
import { mockDestinations, MockTransferService } from "../services/mock-transfer-service.js"

process.env.SYNCWEAVE_REDUCED_MOTION = "1"

/** A folder bigger than the listing cap: entries past page 1 must stay
 *  reachable by cursor (P1-23). */
const TOTAL = LIST_PAGE_SIZE * 2 + 5

class BigFolderService implements FileSystemService {
  readonly paths = { local: "/big", remote: "/big-remote" }
  private readonly entries: MockEntry[] = Array.from({ length: TOTAL }, (_, i) => ({
    id: `f-${i}`,
    name: `f-${String(i).padStart(6, "0")}.txt`,
    kind: "file" as const,
    bytes: 1,
    state: "modified" as const,
  }))

  list(_pane: Pane, _path: string, options?: { offset?: number; limit?: number }): MockEntry[] {
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? this.entries.length
    return this.entries.slice(offset, offset + limit)
  }

  listTotal(): number {
    return this.entries.length
  }

  parentPath(path: string): string {
    return path
  }

  markSynced(): void {}

  getDiff(): string[] {
    return []
  }
}

const open: Array<{ setup: TestRendererSetup; app: SyncWeaveApp }> = []

afterEach(async () => {
  for (const { app, setup } of open.splice(0)) {
    app.dispose()
    await setup.renderer.destroy()
  }
})

test("the cursor turns listing pages so entries past the 10,000 cap are reachable (P1-23)", async () => {
  const setup = await createTestRenderer({ width: 120, height: 36 })
  const dependencies: AppDependencies = {
    filesystem: new BigFolderService(),
    peerService: new MockPeerService(),
    transferService: new MockTransferService(),
    receiveDestinations: mockDestinations,
  }
  const app = createSyncWeaveApp(setup.renderer, dependencies)
  open.push({ setup, app })
  await setup.flush()

  expect(app.state.listOffsets.local).toBe(0)
  expect(setup.captureCharFrame()).toContain("f-000000.txt")
  expect(setup.captureCharFrame()).toContain(`of ${TOTAL} entries`)

  // Step past the last row of page 1: page 2 loads, cursor at its first row.
  app.state.cursors.local = LIST_PAGE_SIZE - 1
  await setup.mockInput.pressKeys(["ARROW_DOWN"], 5)
  await setup.flush()
  expect(app.state.listOffsets.local).toBe(LIST_PAGE_SIZE)
  expect(app.state.cursors.local).toBe(0)
  expect(setup.captureCharFrame()).toContain("f-010000.txt")

  // Step back above the first row of page 2: page 1 reloads at its last row.
  await setup.mockInput.pressKeys(["ARROW_UP"], 5)
  await setup.flush()
  expect(app.state.listOffsets.local).toBe(0)
  expect(app.state.cursors.local).toBe(LIST_PAGE_SIZE - 1)
})
