interface Tick {
  intervalMs: number
  callback: () => void
  running: boolean
  timer?: ReturnType<typeof setInterval>
}

/** A small scheduler for visible UI animation only; stopped ticks consume no idle CPU. */
export class AnimationClock {
  private readonly ticks = new Map<string, Tick>()
  private paused = false
  private disposed = false

  register(name: string, intervalMs: number, callback: () => void): void {
    if (this.disposed) throw new Error("AnimationClock is disposed")
    if (this.ticks.has(name)) throw new Error(`Animation tick already registered: ${name}`)
    this.ticks.set(name, { intervalMs: Math.max(16, intervalMs), callback, running: false })
  }

  start(name: string): void {
    const tick = this.ticks.get(name)
    if (!tick || this.disposed) return
    tick.running = true
    this.schedule(tick)
  }

  stop(name: string): void {
    const tick = this.ticks.get(name)
    if (!tick) return
    tick.running = false
    if (tick.timer) clearInterval(tick.timer)
    tick.timer = undefined
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    for (const tick of this.ticks.values()) {
      if (tick.timer) clearInterval(tick.timer)
      tick.timer = undefined
    }
  }

  resume(): void {
    if (!this.paused || this.disposed) return
    this.paused = false
    for (const tick of this.ticks.values()) this.schedule(tick)
  }

  get activeCount(): number {
    let count = 0
    for (const tick of this.ticks.values()) if (tick.running && !this.paused) count += 1
    return count
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const tick of this.ticks.values()) {
      tick.running = false
      if (tick.timer) clearInterval(tick.timer)
      tick.timer = undefined
    }
    this.ticks.clear()
  }

  private schedule(tick: Tick): void {
    if (this.disposed || this.paused || !tick.running || tick.timer) return
    tick.timer = setInterval(() => {
      if (!this.disposed && !this.paused && tick.running) tick.callback()
    }, tick.intervalMs)
  }
}
