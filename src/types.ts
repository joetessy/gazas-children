export interface Snapshot {
  date: string
  count: number
  sourceUrl: string
}

export interface Dataset {
  count: number
  ages: Uint8Array
  arabicAt: (index: number) => string
  englishAt: (index: number) => string
}

export interface ChildRecord {
  index: number
  arabic: string
  english: string
  age: number
}

export interface StarGeometry {
  positions: Float32Array
  sizes: Float32Array
  phases: Float32Array
  brightness: Float32Array
  speeds: Float32Array
  amplitudes: Float32Array
  styles: Uint8Array
  cellSize: number
  gridCols: number
  gridRows: number
  grid: Int32Array
  gridStarts: Int32Array
  width: number
  height: number
}

export interface PourState {
  appearOrder: Int32Array
  appeared: number
  startedAt: number
  durationMs: number
  done: boolean
}

export interface StarGeometry3D {
  count: number
  positions: Float32Array
  sizes: Float32Array
  phases: Float32Array
  brightness: Float32Array
  speeds: Float32Array
  amplitudes: Float32Array
  styles: Uint8Array
  appearTime: Float32Array
  bounds: { min: [number, number, number]; max: [number, number, number] }
  cellSize: number
  gridDims: [number, number, number]
  grid: Int32Array
  gridStarts: Int32Array
}
