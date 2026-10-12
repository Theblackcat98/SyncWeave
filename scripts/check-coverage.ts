/**
 * Coverage floors for `bun run test:coverage` (P1-49).
 *
 * Reads coverage/lcov.info, which `bun test --coverage` writes because
 * bunfig.toml sets `coverageReporter` to include "lcov". Exits 1 when a floor
 * is not met, or when a file with a floor is missing from the report.
 *
 * Why this script and not bunfig's `coverageThreshold`: Bun applies that value to
 * every file separately, and src/services/friendly-errors.ts is at 0%, so any
 * non-zero floor would fail.
 *
 * Floors are set just below the values measured on 2026-10-12. Raise them as
 * coverage grows. Do not lower them to make CI pass.
 */
import { readFileSync } from "node:fs"

const LCOV_PATH = "coverage/lcov.info"

/** Whole-suite floors, in percent. Measured: lines 90.32, functions 86.10. */
const GLOBAL_FLOORS = { lines: 89, functions: 85 }

/** Per-file floors, in percent. Measured on 2026-10-12 in parentheses. */
const FILE_FLOORS: Record<string, { lines?: number; functions?: number }> = {
  "src/app.ts": { lines: 44 }, // (44.93)
  "src/services/transport.ts": { lines: 91 }, // (91.84)
  "src/services/transfer-protocol.ts": { lines: 99 }, // (100.00)
}

interface Counts {
  linesFound: number
  linesHit: number
  functionsFound: number
  functionsHit: number
}

function parseLcov(text: string): Map<string, Counts> {
  const files = new Map<string, Counts>()
  let path: string | null = null
  let counts: Counts = { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 }
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      path = line.slice(3)
      counts = { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 }
    } else if (line.startsWith("LF:")) counts.linesFound = Number(line.slice(3))
    else if (line.startsWith("LH:")) counts.linesHit = Number(line.slice(3))
    else if (line.startsWith("FNF:")) counts.functionsFound = Number(line.slice(4))
    else if (line.startsWith("FNH:")) counts.functionsHit = Number(line.slice(4))
    else if (line === "end_of_record" && path !== null) {
      files.set(path, counts)
      path = null
    }
  }
  return files
}

function percent(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100
}

function findFile(files: Map<string, Counts>, key: string): [string, Counts] | undefined {
  for (const entry of files) {
    if (entry[0] === key || entry[0].endsWith(`/${key}`)) return entry
  }
  return undefined
}

let report: string
try {
  report = readFileSync(LCOV_PATH, "utf8")
} catch {
  console.error(`coverage floors: ${LCOV_PATH} not found. Run "bun test --coverage" first.`)
  process.exit(1)
}

const files = parseLcov(report)

// "All files" is the unweighted mean of the per-file percentages, the same
// figure `bun test --coverage` prints. (A weighted total gives 84.6%, not 90.3%.)
function mean(values: number[]): number {
  return values.length === 0 ? 100 : values.reduce((sum, value) => sum + value, 0) / values.length
}
const allLines = mean([...files.values()].map((c) => percent(c.linesHit, c.linesFound)))
const allFunctions = mean([...files.values()].map((c) => percent(c.functionsHit, c.functionsFound)))

const failures: string[] = []
const checks: Array<{ name: string; actual: number; floor: number }> = []

checks.push({ name: "all files: lines", actual: allLines, floor: GLOBAL_FLOORS.lines })
checks.push({ name: "all files: functions", actual: allFunctions, floor: GLOBAL_FLOORS.functions })

for (const [key, floors] of Object.entries(FILE_FLOORS)) {
  const found = findFile(files, key)
  if (!found) {
    failures.push(`${key} is missing from the coverage report`)
    continue
  }
  const [, counts] = found
  if (floors.lines !== undefined) {
    checks.push({ name: `${key}: lines`, actual: percent(counts.linesHit, counts.linesFound), floor: floors.lines })
  }
  if (floors.functions !== undefined) {
    checks.push({ name: `${key}: functions`, actual: percent(counts.functionsHit, counts.functionsFound), floor: floors.functions })
  }
}

for (const check of checks) {
  const ok = check.actual + 1e-9 >= check.floor
  console.log(`${ok ? "ok  " : "FAIL"} ${check.name.padEnd(42)} ${check.actual.toFixed(2).padStart(6)}%  floor ${check.floor}%`)
  if (!ok) failures.push(`${check.name} is ${check.actual.toFixed(2)}%, below the floor of ${check.floor}%`)
}

if (failures.length > 0) {
  console.error(`\ncoverage floors not met:\n- ${failures.join("\n- ")}`)
  process.exit(1)
}
