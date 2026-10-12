import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetLogPathForTests, resolveStateDir } from "../services/diagnostic-log.js"

let stateHome: string

beforeEach(async () => {
  stateHome = await mkdtemp(join(tmpdir(), "sw-logmode-"))
  process.env.XDG_STATE_HOME = stateHome
  resetLogPathForTests()
})

afterEach(async () => {
  delete process.env.XDG_STATE_HOME
  resetLogPathForTests()
  await rm(stateHome, { recursive: true, force: true })
})

test("resolveStateDir creates the state dir with mode 0700", async () => {
  const dir = resolveStateDir()
  expect(dir).toBe(join(stateHome, "syncweave"))
  const st = await stat(dir!)
  expect(st.isDirectory()).toBe(true)
  expect(st.mode & 0o777).toBe(0o700)
})
