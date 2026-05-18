import * as THREE from 'three'

interface SceneSetup {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  canvas: HTMLCanvasElement
  setSize: (w: number, h: number) => void
  setPixelRatio: (dpr: number) => void
  dispose: () => void
}

const cappedDPR = (): number => Math.min(2, window.devicePixelRatio || 1)

const FOV = 50
const INITIAL_DISTANCE = 2.0 // tighter framing — cluster fills more of the view

export const createScene = ({ container }: { container: HTMLElement }): SceneSetup => {
  const canvas = document.createElement('canvas')
  canvas.className = 'starfield__canvas'
  canvas.setAttribute('role', 'img')
  container.appendChild(canvas)

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    // Lets the preview tool / debugger read the framebuffer
    preserveDrawingBuffer: true
  })
  renderer.setPixelRatio(cappedDPR())
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(0x050408, 1)

  const scene = new THREE.Scene()

  const camera = new THREE.PerspectiveCamera(
    FOV,
    container.clientWidth / Math.max(1, container.clientHeight),
    0.01,
    50
  )
  // Camera sits directly on +Z axis, looking at the cluster centre.
  // This is the "one vantage point" that shows the whole universe.
  camera.position.set(0, 0, INITIAL_DISTANCE)
  camera.lookAt(0, 0, 0)

  const setSize = (w: number, h: number) => {
    // updateStyle=true (default) so Three.js sets canvas.style.width/height
    // to match the CSS viewport size. Without this, the canvas falls back to
    // its intrinsic framebuffer pixel size — which is DPR-multiplied and far
    // larger than the viewport, causing the whole render to be offset.
    renderer.setSize(w, h, true)
    camera.aspect = w / Math.max(1, h)
    camera.updateProjectionMatrix()
  }

  const setPixelRatio = (dpr: number) => {
    renderer.setPixelRatio(dpr)
  }

  return {
    renderer,
    scene,
    camera,
    canvas,
    setSize,
    setPixelRatio,
    dispose: () => {
      renderer.dispose()
      canvas.remove()
    }
  }
}

export { cappedDPR, INITIAL_DISTANCE }
