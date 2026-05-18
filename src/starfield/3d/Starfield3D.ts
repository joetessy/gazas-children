import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TOUCH } from 'three'
import type { Dataset, Snapshot } from '../../types.ts'
import { buildPour, advancePour, skipPour } from '../pour.ts'
import { buildGeometry3D } from './geometry3d.ts'
import { buildStarsMesh } from './stars.ts'
import { createScene, cappedDPR, INITIAL_DISTANCE } from './scene.ts'
import { createHover } from './hover.ts'

interface MountArgs {
  container: HTMLElement
  dataset: Dataset
  snapshot: Snapshot
}

interface MountHandle {
  destroy: () => void
}

const POUR_DURATION_MS = 90_000
const PRE_PHASE_MS = 3200
const HOVER_TOLERANCE_PX = 4
const TAP_TOLERANCE_PX = 12
// Must match the shader's gl_PointSize formula in stars.ts
const POINT_SCALE = 6.5
const POINT_SIZE_CAP_PX = 20

const FORMATTER = new Intl.NumberFormat('en-US')

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const formatDate = ({ iso }: { iso: string }): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })
}

export const mountStarfield3D = ({ container, dataset, snapshot }: MountArgs): MountHandle => {
  // ── DOM scaffold ─────────────────────────────────────────────────────────
  const scene = document.createElement('div')
  scene.className = 'starfield'
  container.appendChild(scene)

  // ── Three.js setup ───────────────────────────────────────────────────────
  const sceneSetup = createScene({ container: scene })
  const { renderer, scene: threeScene, camera, canvas } = sceneSetup
  canvas.setAttribute(
    'aria-label',
    `A field of ${dataset.count.toLocaleString()} stars, one for each child killed in Gaza.`
  )

  // ── Pour & geometry ──────────────────────────────────────────────────────
  const reduced = prefersReducedMotion()
  const effectivePour = reduced ? 800 : POUR_DURATION_MS
  const captionLingerMs = reduced ? 0 : 1600
  const pour = buildPour({ count: dataset.count, durationMs: effectivePour })

  const geometry3d = buildGeometry3D({
    count: dataset.count,
    appearOrder: pour.appearOrder,
    pourDurationMs: effectivePour,
    introOffsetMs: reduced ? 0 : PRE_PHASE_MS
  })

  const stars = buildStarsMesh({
    geometry: geometry3d,
    pixelRatio: cappedDPR(),
    reducedMotion: reduced
  })
  threeScene.add(stars.mesh)

  // ── Orbit controls ──────────────────────────────────────────────────────
  // Drag to rotate, scroll to zoom. Target is *forced* to (0, 0, 0) every
  // frame so the cluster always sits at the centre of the screen, no matter
  // what input might try to pan it.
  const controls = new OrbitControls(camera, canvas)
  controls.target.set(0, 0, 0)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.enablePan = false           // no panning at all
  controls.screenSpacePanning = false  // belt and braces
  controls.rotateSpeed = 0.85
  controls.zoomSpeed = 0.9
  controls.minDistance = 1.5
  controls.maxDistance = 7
  // Keep the camera within a comfortable range — no upside-down views
  controls.minPolarAngle = 0.2 * Math.PI
  controls.maxPolarAngle = 0.8 * Math.PI
  // Disable mouse-right pan; keep two-finger touch as DOLLY_PAN — pan is
  // already disabled, so the gesture cleanly becomes pinch-to-zoom only.
  controls.mouseButtons.RIGHT = null
  controls.touches.TWO = TOUCH.DOLLY_PAN
  controls.autoRotate = false
  controls.autoRotateSpeed = 0.35
  controls.update()

  // ── Keyboard navigation ─────────────────────────────────────────────────
  // Arrow keys rotate, + / - / = zoom, R recenters. Always available.
  const ROTATE_STEP = 0.06       // radians per keypress (rapid keys feel smooth)
  const ZOOM_STEP   = 0.92       // multiplier per keypress (<1 = closer)
  const onKeyDown = (e: KeyboardEvent) => {
    // Ignore if user is typing into something
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

    let handled = true
    const cam = camera.position.clone().sub(controls.target)
    const spherical = new THREE.Spherical().setFromVector3(cam)

    switch (e.key) {
      case 'ArrowLeft':  spherical.theta -= ROTATE_STEP; break
      case 'ArrowRight': spherical.theta += ROTATE_STEP; break
      case 'ArrowUp':    spherical.phi   -= ROTATE_STEP; break
      case 'ArrowDown':  spherical.phi   += ROTATE_STEP; break
      case '+':
      case '=':
        spherical.radius *= ZOOM_STEP; break
      case '-':
      case '_':
        spherical.radius /= ZOOM_STEP; break
      case 'r':
      case 'R':
        spherical.set(INITIAL_DISTANCE, Math.PI * 0.5, 0)
        break
      default:
        handled = false
    }

    if (!handled) return
    e.preventDefault()
    // clamp to the same limits OrbitControls uses
    spherical.phi = Math.max(controls.minPolarAngle, Math.min(controls.maxPolarAngle, spherical.phi))
    spherical.radius = Math.max(controls.minDistance, Math.min(controls.maxDistance, spherical.radius))
    cam.setFromSpherical(spherical)
    camera.position.copy(controls.target).add(cam)
    // Any explicit camera move pauses auto-rotate so we don't fight the user
    controls.autoRotate = false
  }
  window.addEventListener('keydown', onKeyDown)

  // Any pointer/wheel interaction also stops the idle auto-rotate
  const stopAutoRotate = () => { controls.autoRotate = false }
  canvas.addEventListener('pointerdown', stopAutoRotate, { passive: true })
  canvas.addEventListener('wheel', stopAutoRotate, { passive: true })

  // ── Overlay UI ───────────────────────────────────────────────────────────
  const overlay = document.createElement('div')
  overlay.className = 'starfield__overlay'
  overlay.innerHTML = `
    <div class="sf-intro" data-phase="pre">
      <h1 class="sf-intro__number">${FORMATTER.format(dataset.count)}<span class="sf-intro__children"> children</span></h1>
      <p class="sf-intro__line">Killed in the Israeli Genocide on Gaza</p>
    </div>
    <div class="sf-tally" data-visible="false">
      <span class="sf-tally__current mono">0</span><span class="sf-tally__sep"> / </span><span class="sf-tally__total mono">${FORMATTER.format(dataset.count)}</span>
    </div>
    <div class="sf-caption" data-visible="false">
      Drag or <span class="mono">←↑↓→</span> to rotate · scroll or <span class="mono">+ −</span> to zoom · <span class="mono">R</span> to recenter · hover a star for their name.
    </div>
    <div class="sf-meta">
      <span class="sf-meta__snap">Snapshot ${formatDate({ iso: snapshot.date })}</span>
      <span class="sf-meta__sep">·</span>
      <a class="sf-meta__link" href="${snapshot.sourceUrl}" target="_blank" rel="noopener noreferrer">Gaza MoH via Tech for Palestine</a>
    </div>
    <button class="sf-skip" type="button" aria-label="Reveal all stars now">reveal all now</button>
    <svg class="sf-hover-line" aria-hidden="true">
      <line x1="0" y1="0" x2="0" y2="0" />
    </svg>
    <div class="sf-hover" role="tooltip" aria-hidden="true">
      <p class="sf-hover__arabic"></p>
      <p class="sf-hover__english"></p>
      <div class="sf-hover__meta">
        <span class="sf-hover__age"></span>
      </div>
    </div>
  `
  scene.appendChild(overlay)

  const introEl = overlay.querySelector<HTMLElement>('.sf-intro')!
  const tallyEl = overlay.querySelector<HTMLElement>('.sf-tally')!
  const tallyNumEl = overlay.querySelector<HTMLElement>('.sf-tally__current')!
  const captionEl = overlay.querySelector<HTMLElement>('.sf-caption')!
  const skipBtn = overlay.querySelector<HTMLButtonElement>('.sf-skip')!
  const hoverEl = overlay.querySelector<HTMLElement>('.sf-hover')!
  const hoverArEl = overlay.querySelector<HTMLElement>('.sf-hover__arabic')!
  const hoverEnEl = overlay.querySelector<HTMLElement>('.sf-hover__english')!
  const hoverAgeEl = overlay.querySelector<HTMLElement>('.sf-hover__age')!
  const hoverLineEl = overlay.querySelector<SVGSVGElement>('.sf-hover-line')!
  const hoverLineSeg = hoverLineEl.querySelector<SVGLineElement>('line')!

  captionEl.setAttribute('data-visible', 'true')

  // ── Hover detection ──────────────────────────────────────────────────────
  const hover = createHover({ camera, geometry: geometry3d })

  let hoverIdx: number | null = null
  let pointerScreenX = -999
  let pointerScreenY = -999
  let pointerCanvasX = 0
  let pointerCanvasY = 0
  let pointerValid = false
  let touchTapPending = false

  const setHoverCard = (idx: number | null) => {
    if (idx === null) {
      hoverEl.removeAttribute('data-visible')
      hoverLineEl.removeAttribute('data-visible')
      stars.setHoverIndex(null)
      return
    }
    const ar = dataset.arabicAt(idx) || '—'
    const en = dataset.englishAt(idx) || '(name not transliterated)'
    const age = dataset.ages[idx]
    hoverArEl.textContent = ar
    hoverEnEl.textContent = en
    hoverAgeEl.innerHTML =
      age === 255
        ? ''
        : age === 0
          ? 'under <strong>1</strong> year old'
          : `<strong>${age}</strong> year${age === 1 ? '' : 's'} old`
    hoverEl.setAttribute('data-visible', 'true')
    hoverLineEl.setAttribute('data-visible', 'true')
    stars.setHoverIndex(idx)
    placeHover(pointerScreenX, pointerScreenY)
    updateHoverLine(idx)
  }

  const placeHover = (x: number, y: number) => {
    const rect = hoverEl.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const off = 20
    let left = x + off
    let top = y + off
    if (left + rect.width + 16 > vw) left = x - rect.width - off
    if (top + rect.height + 16 > vh) top = y - rect.height - off
    if (left < 12) left = 12
    if (top < 12) top = 12
    hoverEl.style.left = `${left}px`
    hoverEl.style.top = `${top}px`
  }

  // Draws a leader line from the projected star position to the closest
  // edge of the hover card. Called on hover change and on every frame
  // while a star is hovered (so it tracks camera rotation).
  const updateHoverLine = (idx: number) => {
    const canvasRect = canvas.getBoundingClientRect()
    const star = hover.projectToScreen(idx, canvasRect)
    if (star.behind) {
      hoverLineEl.removeAttribute('data-visible')
      return
    }
    const cardRect = hoverEl.getBoundingClientRect()
    // Closest point on card rectangle to the star
    const cx = Math.max(cardRect.left, Math.min(cardRect.right, star.x))
    const cy = Math.max(cardRect.top, Math.min(cardRect.bottom, star.y))
    // If the star lies inside the card, hide the line
    if (cx === star.x && cy === star.y) {
      hoverLineEl.removeAttribute('data-visible')
      return
    }
    hoverLineEl.setAttribute('data-visible', 'true')
    // SVG is positioned over viewport; coordinates are in CSS pixels
    hoverLineSeg.setAttribute('x1', star.x.toFixed(1))
    hoverLineSeg.setAttribute('y1', star.y.toFixed(1))
    hoverLineSeg.setAttribute('x2', cx.toFixed(1))
    hoverLineSeg.setAttribute('y2', cy.toFixed(1))
  }

  // ── Phase state machine ──────────────────────────────────────────────────
  type Phase = 'pre' | 'pour' | 'full'
  let phase: Phase = 'pre'
  const mountTime = performance.now()
  let phaseStart = mountTime
  let captionFadeTimer: number | null = null

  const setPhase = (next: Phase) => {
    if (phase === next) return
    phase = next
    phaseStart = performance.now()
    introEl.setAttribute('data-phase', next === 'pre' ? 'pre' : 'gone')
    if (next === 'pour' || next === 'full') {
      tallyEl.setAttribute('data-visible', 'true')
    }
    if (next === 'pour') {
      captionFadeTimer = window.setTimeout(() => {
        captionEl.setAttribute('data-visible', 'false')
        captionFadeTimer = null
      }, captionLingerMs)
    }
    if (next === 'full') {
      if (captionFadeTimer !== null) {
        window.clearTimeout(captionFadeTimer)
        captionFadeTimer = null
      }
      captionEl.setAttribute('data-visible', 'false')
      skipBtn.setAttribute('data-hidden', 'true')
    }
  }

  // ── Pointer events ───────────────────────────────────────────────────────
  const updatePointer = (clientX: number, clientY: number, valid: boolean) => {
    pointerScreenX = clientX
    pointerScreenY = clientY
    const rect = canvas.getBoundingClientRect()
    pointerCanvasX = clientX - rect.left
    pointerCanvasY = clientY - rect.top
    pointerValid = valid
    hover.setPointer(pointerCanvasX, pointerCanvasY, valid)
  }

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return
    updatePointer(e.clientX, e.clientY, true)
  }
  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return
    pointerValid = false
    hover.setPointer(0, 0, false)
    hoverIdx = null
    setHoverCard(null)
  }
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    updatePointer(e.clientX, e.clientY, true)
    touchTapPending = true
  }

  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerleave', onPointerLeave)
  canvas.addEventListener('pointerdown', onPointerDown)

  // ── Skip button ──────────────────────────────────────────────────────────
  const onSkip = () => {
    skipPour({ pour, total: dataset.count })
    tallyNumEl.textContent = FORMATTER.format(dataset.count)
    setPhase('full')
    // Set every star's appearTime to past so the shader shows it instantly
    for (let i = 0; i < dataset.count; i += 1) {
      geometry3d.appearTime[i] = 0
    }
    const attr = stars.mesh.geometry.getAttribute('aAppearTime') as THREE.BufferAttribute
    attr.needsUpdate = true
  }
  skipBtn.addEventListener('click', onSkip)

  // ── Resize ───────────────────────────────────────────────────────────────
  let lastW = 0
  let lastH = 0
  const resize = () => {
    const w = Math.max(1, scene.clientWidth || window.innerWidth)
    const h = Math.max(1, scene.clientHeight || window.innerHeight)
    if (w === lastW && h === lastH) return
    lastW = w
    lastH = h
    sceneSetup.setSize(w, h)
    const dpr = cappedDPR()
    sceneSetup.setPixelRatio(dpr)
    stars.setPixelRatio(dpr)
  }
  window.addEventListener('resize', resize)
  const resizeObs = new ResizeObserver(() => resize())
  resizeObs.observe(scene)
  resize()


  // ── Render loop ──────────────────────────────────────────────────────────
  let raf = 0
  const tick = () => {
    const now = performance.now()
    const elapsedMs = now - mountTime

    // Phase progression
    if (phase === 'pre') {
      const preFor = now - phaseStart
      if (reduced || preFor > PRE_PHASE_MS) {
        setPhase('pour')
        pour.startedAt = now
      }
    } else if (phase === 'pour') {
      advancePour({ pour, now, total: dataset.count })
      tallyNumEl.textContent = FORMATTER.format(pour.appeared)
      if (pour.done) setPhase('full')
    } else {
      tallyNumEl.textContent = FORMATTER.format(dataset.count)
    }

    // Shader time uniform — measures elapsed time since mount, matches appearTime base
    stars.updateTime(elapsedMs)

    // Lock target to origin every frame in case any input nudged it,
    // then let OrbitControls apply user rotation/zoom around that target.
    if (controls.target.lengthSq() > 1e-8) controls.target.set(0, 0, 0)
    controls.update()

    // Hover resolution — runs once per frame, after controls and before render
    if ((pointerValid || touchTapPending) && phase !== 'pre') {
      const tolerance = touchTapPending ? TAP_TOLERANCE_PX : HOVER_TOLERANCE_PX
      const dpr = cappedDPR()
      const found = hover.resolve(elapsedMs, lastW, lastH, dpr, tolerance, POINT_SCALE, POINT_SIZE_CAP_PX)
      if (found !== hoverIdx) {
        hoverIdx = found
        setHoverCard(found)
      } else if (found !== null) {
        placeHover(pointerScreenX, pointerScreenY)
        // Keep the leader line tracking the star as the camera moves
        updateHoverLine(found)
      }
      touchTapPending = false
    }

    renderer.render(threeScene, camera)
    raf = requestAnimationFrame(tick)
  }

  raf = requestAnimationFrame(tick)

  // ── Teardown ─────────────────────────────────────────────────────────────
  return {
    destroy: () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', onKeyDown)
      resizeObs.disconnect()
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerdown', stopAutoRotate)
      canvas.removeEventListener('wheel', stopAutoRotate)
      skipBtn.removeEventListener('click', onSkip)
      controls.dispose()
      stars.dispose()
      sceneSetup.dispose()
      scene.remove()
    }
  }
}

// INITIAL_DISTANCE exported for tests/dev tools; not used here directly.
export { INITIAL_DISTANCE }
