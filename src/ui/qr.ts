export function qrBlock(seed: number): string[] {
  const size = 13
  const lines: string[] = []
  for (let y = 0; y < size; y += 1) {
    let line = ""
    for (let x = 0; x < size; x += 1) {
      const finder = (x < 5 && y < 5) || (x >= 8 && y < 5) || (x < 5 && y >= 8)
      const border = finder && (x === 0 || x === 4 || y === 0 || y === 4 || (x >= 8 && x === 8) || (y >= 8 && y === 8))
      const center = finder && ((x >= 1 && x <= 3 && y >= 1 && y <= 3) || (x >= 9 && x <= 11 && y >= 1 && y <= 3) || (x >= 1 && x <= 3 && y >= 9 && y <= 11))
      const data = ((x * 17 + y * 31 + seed * 7) % 5) < 2
      line += border || center || data ? "██" : "  "
    }
    lines.push(line)
  }
  return lines
}
