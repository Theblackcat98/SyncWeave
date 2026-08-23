import type { PairingService, PairingStepName } from "../types"

const STEP_INTERVAL_MS = 900
const FINAL_STEP: PairingStepName = "connected"

export function createMockPairing(): PairingService {
  let step = 0
  let timer: ReturnType<typeof setInterval> | undefined

  return {
    start(onUpdate: () => void): void {
      this.cancel()
      step = 0
      timer = setInterval(() => {
        step += 1
        if (this.step() === FINAL_STEP) {
          if (timer) clearInterval(timer)
          timer = undefined
        }
        onUpdate()
      }, STEP_INTERVAL_MS)
    },
    cancel(): void {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    step(): PairingStepName {
      return (["waiting", "authenticating", "connected"] as const)[Math.min(step, 2)]
    },
  }
}
