import * as THREE from 'three'
import type { StarGeometry3D } from '../../types.ts'

interface HoverArgs {
  camera: THREE.PerspectiveCamera
  geometry: StarGeometry3D
}

interface HoverHandle {
  setPointer: (canvasX: number, canvasY: number, valid: boolean) => void
  resolve: (
    currentTimeMs: number,
    viewportW: number,
    viewportH: number,
    pixelRatio: number,
    tolerancePx: number,
    pointScale: number,
    pointSizeCapPx: number
  ) => number | null
  projectToScreen: (index: number, canvasRect: DOMRect) => { x: number; y: number; behind: boolean }
}

const projViewMat = new THREE.Matrix4()
const tmpVec = new THREE.Vector3()

export const createHover = ({ camera, geometry }: HoverArgs): HoverHandle => {
  let px = 0
  let py = 0
  let valid = false

  return {
    setPointer: (canvasX, canvasY, isValid) => {
      px = canvasX
      py = canvasY
      valid = isValid
    },

    resolve: (currentTimeMs, viewportW, viewportH, pixelRatio, tolerancePx, pointScale, pointSizeCapPx) => {
      if (!valid) return null

      // Refresh inverse view matrix — we run before renderer.render()
      camera.updateMatrixWorld()
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
      projViewMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)

      const m = projViewMat.elements
      const vm = camera.matrixWorldInverse.elements

      const { positions, sizes, appearTime, count } = geometry
      const halfW = viewportW * 0.5
      const halfH = viewportH * 0.5

      let best = -1
      let bestScore = Infinity

      for (let i = 0; i < count; i += 1) {
        if (appearTime[i] > currentTimeMs) continue

        const x = positions[i * 3]
        const y = positions[i * 3 + 1]
        const z = positions[i * 3 + 2]

        // View-space z (negative = in front of camera)
        const vz = vm[2] * x + vm[6] * y + vm[10] * z + vm[14]
        if (vz >= 0) continue

        // Projection
        const cx = m[0] * x + m[4] * y + m[8] * z + m[12]
        const cy = m[1] * x + m[5] * y + m[9] * z + m[13]
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15]
        if (cw <= 0) continue

        const ndcX = cx / cw
        const ndcY = cy / cw
        if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue

        const sx = halfW + ndcX * halfW
        const sy = halfH - ndcY * halfH

        // Rendered radius in CSS pixels (matches shader gl_PointSize formula)
        const physicalSize = Math.min(
          pointSizeCapPx,
          sizes[i] * pixelRatio * (pointScale / Math.max(0.6, -vz))
        )
        const visualRadius = (physicalSize / pixelRatio) * 0.5
        const hitRadius = Math.max(visualRadius, 2) + tolerancePx

        const dx = sx - px
        const dy = sy - py
        const d2 = dx * dx + dy * dy
        if (d2 > hitRadius * hitRadius) continue

        // Score: pixel-closest wins, depth as tiebreaker for overlap
        const score = d2 - vz * 0.2
        if (score < bestScore) {
          bestScore = score
          best = i
        }
      }

      return best < 0 ? null : best
    },

    projectToScreen: (index, canvasRect) => {
      tmpVec.set(
        geometry.positions[index * 3],
        geometry.positions[index * 3 + 1],
        geometry.positions[index * 3 + 2]
      )
      tmpVec.project(camera)
      const behind = tmpVec.z > 1 || tmpVec.z < -1
      const x = canvasRect.left + ((tmpVec.x + 1) / 2) * canvasRect.width
      const y = canvasRect.top + ((1 - tmpVec.y) / 2) * canvasRect.height
      return { x, y, behind }
    }
  }
}
