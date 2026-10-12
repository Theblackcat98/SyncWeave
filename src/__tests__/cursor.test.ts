import { describe, expect, test } from "bun:test"
import { clamp, stepCursor } from "../cursor.js"

describe("clamp", () => {
  test("clamps below, within, and above range", () => {
    expect(clamp(-1, 0, 5)).toBe(0)
    expect(clamp(3, 0, 5)).toBe(3)
    expect(clamp(9, 0, 5)).toBe(5)
  })
})

describe("P2-7: receiver-pane peer cycling (stepCursor)", () => {
  test("moves down and up through peers", () => {
    expect(stepCursor(0, 1, 5)).toBe(1)
    expect(stepCursor(2, -1, 5)).toBe(1)
  })

  test("pins at the top: up from 0 stays 0", () => {
    expect(stepCursor(0, -1, 5)).toBe(0)
  })

  test("pins at the bottom: down from the last peer stays there", () => {
    expect(stepCursor(4, 1, 5)).toBe(4)
    expect(stepCursor(4, 10, 5)).toBe(4)
  })

  test("single peer: cursor cannot move", () => {
    expect(stepCursor(0, 1, 1)).toBe(0)
    expect(stepCursor(0, -1, 1)).toBe(0)
  })

  test("empty peer list: cursor pins at 0", () => {
    expect(stepCursor(0, 1, 0)).toBe(0)
    expect(stepCursor(3, -1, 0)).toBe(0)
  })

  test("large deltas clamp, never wrap", () => {
    expect(stepCursor(0, 100, 5)).toBe(4)
    expect(stepCursor(4, -100, 5)).toBe(0)
  })

  test("walks the full peer list end to end like repeated down-presses", () => {
    let cursor = 0
    const seen: number[] = [cursor]
    for (let i = 0; i < 7; i++) {
      cursor = stepCursor(cursor, 1, 4)
      seen.push(cursor)
    }
    expect(seen).toEqual([0, 1, 2, 3, 3, 3, 3, 3])
  })
})
