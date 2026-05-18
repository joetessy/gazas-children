import type { StarGeometry3D } from '../../types.ts'

interface BuildArgs {
  count: number
  appearOrder: Int32Array
  pourDurationMs: number
  introOffsetMs: number
}

const mulberry32 = ({ seed }: { seed: number }): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hash = (n: number): number => {
  let x = n | 0
  x = (x ^ 61) ^ (x >>> 16)
  x = x + (x << 3)
  x = x ^ (x >>> 4)
  x = Math.imul(x, 0x27d4eb2d)
  x = x ^ (x >>> 15)
  return x >>> 0
}

// ── 3D density ────────────────────────────────────────────────────────────────
// Symmetric galaxy-like cloud, centred exactly on the origin:
//   - Dense core, smooth radial Gaussian falloff
//   - Disk flattening — thinner along the Y axis
//   - Mild radial-wavelength modulation for organic spiral-arm texture
//     (still symmetric about origin, just not a pure blob)
//   - Soft baseline so the outer halo isn't empty

const density3d = (x: number, y: number, z: number): number => {
  const r2 = x * x + y * y + z * z
  const r = Math.sqrt(r2)

  // Dense core, smooth radial falloff
  const core = Math.exp(-r2 * 1.6) * 0.92

  // Disk flattening — thinner in Y
  const diskFactor = Math.exp(-(y * y) * 4.0)

  // Mild concentric "ripple" — gives organic texture without breaking symmetry.
  // (cos(2πr·k) oscillates; we only keep the positive lobes via max with 0)
  const ripple = Math.max(0, Math.cos(r * 7.5) * 0.18) * Math.exp(-r2 * 0.8)

  const baseline = 0.06

  return Math.min(1, baseline + core * diskFactor + ripple * diskFactor)
}

const placeStars3d = ({
  count,
  rng
}: {
  count: number
  rng: () => number
}): Float32Array => {
  const out = new Float32Array(count * 3)
  let placed = 0
  let attempts = 0
  // Bigger box so the sphere-shaped density has room — most rejections
  // happen for points outside the soft sphere, which is fine.
  const BOX = 1.3
  const maxAttempts = count * 60

  while (placed < count && attempts < maxAttempts) {
    attempts += 1
    const rx = (rng() * 2 - 1) * BOX
    const ry = (rng() * 2 - 1) * BOX
    const rz = (rng() * 2 - 1) * BOX
    const r2 = rx * rx + ry * ry + rz * rz
    // Hard sphere boundary at r=1.25 keeps the shape obvious
    if (r2 > 1.25 * 1.25) continue
    const d = density3d(rx, ry, rz)
    if (rng() > d) continue
    out[placed * 3] = rx
    out[placed * 3 + 1] = ry
    out[placed * 3 + 2] = rz
    placed += 1
  }

  // Fallback fill — keep within sphere
  while (placed < count) {
    let rx = 0, ry = 0, rz = 0, r2 = 2
    while (r2 > 1) {
      rx = rng() * 2 - 1
      ry = rng() * 2 - 1
      rz = rng() * 2 - 1
      r2 = rx * rx + ry * ry + rz * rz
    }
    out[placed * 3] = rx
    out[placed * 3 + 1] = ry
    out[placed * 3 + 2] = rz
    placed += 1
  }

  return out
}

export const buildGeometry3D = ({
  count,
  appearOrder,
  pourDurationMs,
  introOffsetMs
}: BuildArgs): StarGeometry3D => {
  const rng = mulberry32({ seed: 0xcafef00d })
  const positions = placeStars3d({ count, rng })

  const sizes = new Float32Array(count)
  const phases = new Float32Array(count)
  const brightness = new Float32Array(count)
  const speeds = new Float32Array(count)
  const amplitudes = new Float32Array(count)
  const styles = new Uint8Array(count)
  const appearTime = new Float32Array(count)

  for (let i = 0; i < count; i += 1) {
    const h1 = hash(i + 0x9e3779b9) / 0xffffffff
    const h2 = hash(i + 0x85ebca77) / 0xffffffff
    const h3 = hash(i + 0xc2b2ae3d) / 0xffffffff
    const h4 = hash(i + 0x6c62272e) / 0xffffffff
    const h5 = hash(i + 0x517cc1b7) / 0xffffffff

    const sizeCurve = h1 * h1
    if (sizeCurve > 0.99) {
      sizes[i] = 1.6 + h2 * 0.5
    } else if (sizeCurve > 0.93) {
      sizes[i] = 1.0 + h2 * 0.35
    } else {
      sizes[i] = 0.4 + h2 * 0.4
    }

    phases[i] = h3 * Math.PI * 2
    brightness[i] = 0.38 + h4 * 0.48

    if (h5 < 0.02) {
      styles[i] = 2
      speeds[i] = 2.2 + h1 * 2.0
      amplitudes[i] = 0.13 + h2 * 0.09
    } else if (h5 < 0.1) {
      styles[i] = 1
      speeds[i] = 1.2 + h1 * 1.4
      amplitudes[i] = 0.09 + h2 * 0.08
    } else {
      styles[i] = 0
      speeds[i] = 0.18 + h1 * 0.55
      amplitudes[i] = 0.04 + h2 * 0.06
    }
  }

  // Per-star appear time using eased pour curve (matches advancePour ease)
  for (let k = 0; k < count; k += 1) {
    const idx = appearOrder[k]
    const ratio = (k + 1) / count
    // invert ease-out: ratio = 1 - (1 - r)^1.1 → r = 1 - (1 - ratio)^(1/1.1)
    const r = 1 - Math.pow(1 - ratio, 1 / 1.1)
    appearTime[idx] = introOffsetMs + r * pourDurationMs
  }

  // Spatial grid — 16 cells per axis across [-1.3, 1.3]
  const gridResolution = 16
  const GRID_HALF = 1.3
  const cellSize = (GRID_HALF * 2) / gridResolution
  const gridDims: [number, number, number] = [gridResolution, gridResolution, gridResolution]

  const cellCount = gridResolution * gridResolution * gridResolution
  const buckets: number[][] = []
  for (let i = 0; i < cellCount; i += 1) buckets.push([])

  const cellOf = (v: number): number => {
    const c = Math.floor((v + GRID_HALF) / cellSize)
    return Math.max(0, Math.min(gridResolution - 1, c))
  }

  for (let i = 0; i < count; i += 1) {
    const gx = cellOf(positions[i * 3])
    const gy = cellOf(positions[i * 3 + 1])
    const gz = cellOf(positions[i * 3 + 2])
    buckets[gz * gridResolution * gridResolution + gy * gridResolution + gx].push(i)
  }

  const gridStarts = new Int32Array(cellCount + 1)
  let total = 0
  for (let b = 0; b < cellCount; b += 1) {
    gridStarts[b] = total
    total += buckets[b].length
  }
  gridStarts[cellCount] = total

  const grid = new Int32Array(total)
  let cursor = 0
  for (const bucket of buckets) {
    for (const idx of bucket) {
      grid[cursor] = idx
      cursor += 1
    }
  }

  return {
    count,
    positions,
    sizes,
    phases,
    brightness,
    speeds,
    amplitudes,
    styles,
    appearTime,
    bounds: { min: [-GRID_HALF, -GRID_HALF, -GRID_HALF], max: [GRID_HALF, GRID_HALF, GRID_HALF] },
    cellSize,
    gridDims,
    grid,
    gridStarts
  }
}

// Note: the hover picker lives in hover.ts now.
