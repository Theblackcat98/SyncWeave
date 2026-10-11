import { expect, test } from "bun:test"
import { AnimationClock } from "../ui/animation-clock.js"
import { createIcons } from "../theme.js"

test("animation clock schedules only requested work and pauses/resumes without duplicate timers", async () => {
  const clock = new AnimationClock()
  let frames = 0
  clock.register("test", 24, () => { frames += 1 })
  expect(clock.activeCount).toBe(0)

  clock.start("test")
  await Bun.sleep(85)
  expect(frames).toBeGreaterThan(0)
  expect(clock.activeCount).toBe(1)

  clock.pause()
  const pausedAt = frames
  await Bun.sleep(70)
  expect(frames).toBe(pausedAt)
  expect(clock.activeCount).toBe(0)

  clock.resume()
  await Bun.sleep(65)
  expect(frames).toBeGreaterThan(pausedAt)
  clock.stop("test")
  expect(clock.activeCount).toBe(0)
  clock.dispose()
  expect(() => clock.register("late", 20, () => {})).toThrow("disposed")
})

test("ASCII icon theme replaces font-dependent glyphs with readable ASCII", () => {
  const ascii = createIcons(true)
  expect(ascii.file).toBe("[F]")
  expect(ascii.directory).toBe("[D]")
  expect(ascii.added).toBe("+")
  expect(ascii.arrow).toBe("->")
  expect(ascii.check).toBe("[x]")
})
