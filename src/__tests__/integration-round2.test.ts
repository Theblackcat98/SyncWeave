import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { resetLogPathForTests } from "../services/diagnostic-log.js"
import { consentRequest, frameText, mountUi, unmountAll } from "./ui-harness.js"

afterEach(unmountAll)

test("real consent shows the name the sink will save, and flags rejected names (P0-12)", async () => {
  const { setup, app } = await mountUi({ width: 120, height: 36, mode: "real" })
  const base = consentRequest({}, 2)
  app.state.request = {
    ...base,
    files: [
      { ...base.files[0]!, name: ".env" },
      { ...base.files[1]!, name: "plain.txt" },
    ],
  }
  app.state.screen = "consent"
  app.render()
  await setup.flush()
  const frame = frameText(setup)
  expect(frame).toContain(".env → saved as env")
  expect(frame).toContain("plain.txt")
  expect(frame).not.toContain("plain.txt → saved as")
})

test("adding a missing destination needs a second Enter before it is created", async () => {
  const home = homedir()
  const parent = mkdtempSync(join(home, "sw-round2-"))
  const target = join(parent, "new-dest")
  // saveDestinations persists the list; keep it out of the real state dir.
  const previousState = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = join(parent, "state")
  resetLogPathForTests()
  try {
    const { setup, app } = await mountUi({ width: 120, height: 36, mode: "real", destinations: [home] })
    app.state.request = consentRequest({}, 1)
    app.state.screen = "consent"
    app.render()
    await setup.flush()
    // Destination input mode with the path typed (the "+" key opens it).
    app.state.destinationInput = target
    await setup.mockInput.pressEnter()
    await setup.flush()
    expect(app.state.status).toContain("press Enter again to create it")
    expect(Bun.file(target).size).toBe(0)
    await setup.mockInput.pressEnter()
    await setup.flush()
    expect(app.state.status).toContain("Added destination")
    expect(app.state.destinationInput).toBeNull()
  } finally {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = previousState
    resetLogPathForTests()
    rmSync(parent, { recursive: true, force: true })
  }
})
