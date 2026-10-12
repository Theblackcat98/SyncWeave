import { expect, test } from "bun:test"
import { join } from "node:path"

const MAIN = join(import.meta.dir, "..", "main.ts")

async function run(args: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return { code, stderr }
}

test("a usage error exits with code 2 and names the bad value", async () => {
  const result = await run(["--port", "24816abc"])
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('invalid --port value "24816abc"')
}, 20_000)

test("a hostname in --peer is a usage error, not a silent skip", async () => {
  const result = await run(["--real", "--peer", "localhost:24816"])
  expect(result.code).toBe(2)
  expect(result.stderr).toContain("IP address")
}, 20_000)

test("--real=maybe is rejected instead of starting mock mode", async () => {
  const result = await run(["--real=maybe"])
  expect(result.code).toBe(2)
  expect(result.stderr).toContain("--real")
}, 20_000)

test("--help exits 0", async () => {
  const result = await run(["--help"])
  expect(result.code).toBe(0)
}, 20_000)
