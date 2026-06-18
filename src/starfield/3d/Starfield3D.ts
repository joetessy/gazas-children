import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TOUCH } from 'three'
import type { Dataset, Snapshot, DailyTimeline } from '../../types.ts'
import { buildPour, advancePour, skipPour } from '../pour.ts'
import { buildGeometry3D } from './geometry3d.ts'
import { buildStarsMesh } from './stars.ts'
import { createScene, cappedDPR, INITIAL_DISTANCE } from './scene.ts'
import { createHover } from './hover.ts'
import { buildSearchIndex, type SearchIndex } from '../search.ts'

interface MountArgs {
  container: HTMLElement
  dataset: Dataset
  snapshot: Snapshot
  daily?: DailyTimeline | null
}

interface MountHandle {
  destroy: () => void
}

const POUR_DURATION_MS = 90_000
const MEMORIAL_DISPLAY_MS = 4800       // memorial text fades out at this time (gives "n children" a beat alone before the line joins)
const PRE_PHASE_MS = 8800              // total intro duration (memorial + instructions) before stars start
const HOVER_TOLERANCE_PX = 4
const TAP_TOLERANCE_PX = 12
// Must match the shader's gl_PointSize formula in stars.ts
const POINT_SCALE = 6.5
const POINT_SIZE_CAP_PX = 20

// Must match the sphere boundary used in geometry3d.ts
const CLUSTER_RADIUS = 1.25
const MIN_ZOOM_DISTANCE = 0.4
// Multiplier on the just-fits distance — >1 leaves a small margin so stars at the cluster edge don't kiss the viewport edge
const MAX_ZOOM_MARGIN = 1.05

const computeMaxDistance = (aspect: number, fovDeg: number): number => {
  const halfTan = Math.tan((fovDeg * Math.PI) / 360)
  return (CLUSTER_RADIUS / (halfTan * Math.min(aspect, 1))) * MAX_ZOOM_MARGIN
}

const FORMATTER = new Intl.NumberFormat('en-US')
const fmt = (n: number): string => FORMATTER.format(n)

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

// Packed dob (yyyymmdd) helpers
const dobYear = (v: number): number => Math.floor(v / 10000)
const dobMonth = (v: number): number => Math.floor(v / 100) % 100
const dobDay = (v: number): number => v % 100

const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => {
    switch (c) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      default: return '&quot;'
    }
  })

const CANDLE_KEY = 'gaza-candles'

export const mountStarfield3D = ({ container, dataset, snapshot, daily = null }: MountArgs): MountHandle => {
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
  const pour = buildPour({ count: dataset.count, durationMs: effectivePour })

  const geometry3d = buildGeometry3D({
    count: dataset.count,
    appearOrder: pour.appearOrder,
    pourDurationMs: effectivePour,
    introOffsetMs: reduced ? 0 : PRE_PHASE_MS
  })

  // Reveal rank per star (order[star] = pour position) — shared by the timeline
  // reveal and the hover picker.
  const order = new Float32Array(dataset.count)
  for (let k = 0; k < dataset.count; k += 1) order[pour.appearOrder[k]] = k

  // ── Birthdays ────────────────────────────────────────────────────────────
  // Children whose date of birth falls on today (viewer-local). They glow, and
  // a control offers a gentle tour of them.
  const nowDate = new Date()
  const todayMonth = nowDate.getMonth() + 1
  const todayDay = nowDate.getDate()
  const todayYear = nowDate.getFullYear()
  const birthdayFlags = new Float32Array(dataset.count)
  const birthdayIndices: number[] = []
  for (let i = 0; i < dataset.count; i += 1) {
    const v = dataset.dob[i]
    if (v > 0 && dobMonth(v) === todayMonth && dobDay(v) === todayDay) {
      birthdayFlags[i] = 1
      birthdayIndices.push(i)
    }
  }

  // ── Candles (localStorage) ───────────────────────────────────────────────
  // A child you choose to remember: their star is lit with a warm, brighter
  // glow that persists across visits.
  const loadCandles = (): Set<number> => {
    try {
      const raw = localStorage.getItem(CANDLE_KEY)
      if (!raw) return new Set()
      const arr = JSON.parse(raw)
      return new Set(
        Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n) && n >= 0 && n < dataset.count) : []
      )
    } catch {
      return new Set()
    }
  }
  const candles = loadCandles()
  const candleFlags = new Float32Array(dataset.count)
  candles.forEach((i) => {
    candleFlags[i] = 1
  })
  const persistCandles = () => {
    try {
      localStorage.setItem(CANDLE_KEY, JSON.stringify([...candles]))
    } catch {
      /* storage unavailable — candles simply won't persist */
    }
  }

  const stars = buildStarsMesh({
    geometry: geometry3d,
    pixelRatio: cappedDPR(),
    reducedMotion: reduced,
    ages: dataset.ages,
    appearOrder: pour.appearOrder,
    birthdayFlags,
    candleFlags
  })
  threeScene.add(stars.mesh)

  // Lazily-built name search index (skips ~18k normalisations until first use).
  let searchIndex: SearchIndex | null = null
  const getSearchIndex = (): SearchIndex => {
    if (!searchIndex) searchIndex = buildSearchIndex(dataset)
    return searchIndex
  }

  // ── Orbit controls ──────────────────────────────────────────────────────
  const controls = new OrbitControls(camera, canvas)
  controls.target.set(0, 0, 0)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.enablePan = false
  controls.screenSpacePanning = false
  controls.rotateSpeed = 0.85
  controls.zoomSpeed = 0.9
  controls.minDistance = MIN_ZOOM_DISTANCE
  controls.maxDistance = computeMaxDistance(camera.aspect, camera.fov)
  controls.minPolarAngle = 0.2 * Math.PI
  controls.maxPolarAngle = 0.8 * Math.PI
  controls.mouseButtons.RIGHT = null
  controls.touches.TWO = TOUCH.DOLLY_PAN
  controls.autoRotate = false
  controls.autoRotateSpeed = 0.05
  controls.update()

  // ── Camera fly-to ─────────────────────────────────────────────────────────
  // Smoothly swings the camera (orbiting the locked origin) so a chosen star
  // sits front-and-centre, then zooms in a little. Used by search, taps,
  // permalinks, the birthday tour, and vigil mode.
  const flyTo = {
    active: false,
    start: 0,
    dur: 0,
    from: { theta: 0, phi: 0, radius: 0 },
    to: { theta: 0, phi: 0, radius: 0 }
  }
  const currentSpherical = () => {
    const off = camera.position.clone().sub(controls.target)
    const s = new THREE.Spherical().setFromVector3(off)
    return { theta: s.theta, phi: s.phi, radius: s.radius }
  }
  const startFlyTo = (index: number) => {
    const px = geometry3d.positions[index * 3]
    const py = geometry3d.positions[index * 3 + 1]
    const pz = geometry3d.positions[index * 3 + 2]
    const p = new THREE.Vector3(px, py, pz)
    const s = new THREE.Spherical().setFromVector3(p)
    const phi = Math.max(controls.minPolarAngle, Math.min(controls.maxPolarAngle, s.phi))
    const radius = Math.max(
      controls.minDistance + 0.05,
      Math.min(controls.maxDistance, p.length() + 0.55)
    )
    const from = currentSpherical()
    // Rotate the short way around in theta.
    let dTheta = s.theta - from.theta
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI
    flyTo.from = from
    flyTo.to = { theta: from.theta + dTheta, phi, radius }
    flyTo.start = performance.now()
    flyTo.dur = reduced ? 320 : 1100
    flyTo.active = true
    controls.autoRotate = false
  }
  const cancelFlyTo = () => {
    flyTo.active = false
  }

  // ── Keyboard navigation ─────────────────────────────────────────────────
  const ROTATE_STEP = 0.06
  const ZOOM_STEP = 0.92
  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.key === 'Escape') {
      if (isoMode !== 'none') {
        exitIso()
        e.preventDefault()
      } else if (clearFocus()) {
        e.preventDefault()
      }
      return
    }

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
    cancelFlyTo()
    stopVigil()
    spherical.phi = Math.max(controls.minPolarAngle, Math.min(controls.maxPolarAngle, spherical.phi))
    spherical.radius = Math.max(controls.minDistance, Math.min(controls.maxDistance, spherical.radius))
    cam.setFromSpherical(spherical)
    camera.position.copy(controls.target).add(cam)
    controls.autoRotate = false
  }
  window.addEventListener('keydown', onKeyDown)

  // Any pointer/wheel interaction stops idle auto-rotate, cancels a fly, and
  // ends a running vigil — we never fight the user.
  const stopAutoRotate = () => {
    controls.autoRotate = false
    cancelFlyTo()
    stopVigil()
  }
  canvas.addEventListener('pointerdown', stopAutoRotate, { passive: true })
  canvas.addEventListener('wheel', stopAutoRotate, { passive: true })

  // ── Overlay UI ───────────────────────────────────────────────────────────
  const overlay = document.createElement('div')
  overlay.className = 'starfield__overlay'
  overlay.innerHTML = `
    <div class="sf-intro" data-phase="pre">
      <h1 class="sf-intro__number">${fmt(dataset.count)}<span class="sf-intro__children"> children</span></h1>
      <p class="sf-intro__line">killed by Israel in the Genocide on Gaza</p>
    </div>
    <div class="sf-tally" data-visible="false">
      <span class="sf-tally__current mono">0</span><span class="sf-tally__sep"> / </span><span class="sf-tally__total mono">${fmt(dataset.count)}</span>
    </div>
    <div class="sf-caption" data-visible="false">
      This is an interactive memorial.<br/>Use the mouse or drag to rotate the cluster. Scroll or pinch to zoom in.
    </div>
    <div class="sf-meta">
      <span class="sf-meta__snap">Snapshot ${formatDate({ iso: snapshot.date })}</span>
      <span class="sf-meta__sep">·</span>
      <a class="sf-meta__link" href="${snapshot.sourceUrl}" target="_blank" rel="noopener noreferrer">Gaza MoH via Tech for Palestine</a>
    </div>
    <button class="sf-skip" type="button" aria-label="Reveal all stars now">reveal all now</button>

    <div class="sf-focus" data-visible="false" role="dialog" aria-live="polite">
      <button class="sf-focus__close" type="button" aria-label="Close">×</button>
      <div class="sf-focus__nav" data-show="false">
        <button class="sf-focus__prev" type="button" aria-label="Previous birthday">‹</button>
        <span class="sf-focus__pos mono"></span>
        <button class="sf-focus__next" type="button" aria-label="Next birthday">›</button>
      </div>
      <p class="sf-focus__arabic"></p>
      <p class="sf-focus__english"></p>
      <p class="sf-focus__age"></p>
      <p class="sf-focus__bday" data-show="false"></p>
      <div class="sf-focus__actions">
        <button class="sf-focus__candle" type="button"></button>
        <button class="sf-focus__share" type="button">copy link</button>
      </div>
    </div>

    <div class="sf-panel sf-panel--search" data-open="false">
      <input class="sf-search__input" type="search" autocomplete="off" spellcheck="false"
        placeholder="Search a name — Arabic or English" aria-label="Search names" />
      <div class="sf-search__results" role="listbox"></div>
    </div>

    <div class="sf-panel sf-panel--ages" data-open="false">
      <div class="sf-panel__head">
        <span class="sf-panel__title">Filter by age</span>
        <button class="sf-ages__all" type="button">all ages</button>
      </div>
      <div class="sf-ages__bars"></div>
    </div>

    <div class="sf-panel sf-panel--timeline" data-open="false">
      <div class="sf-panel__head">
        <span class="sf-timeline__date mono"></span>
        <button class="sf-timeline__play" type="button" aria-label="Play through the timeline">▶ play</button>
      </div>
      <input class="sf-timeline__range" type="range" min="0" max="100" value="100" step="1" aria-label="Timeline date" />
      <p class="sf-timeline__note"></p>
    </div>

    <div class="sf-controls" data-visible="false">
      <button class="sf-ctrl" type="button" data-act="search">find a name</button>
      <button class="sf-ctrl" type="button" data-act="ages">ages</button>
      <button class="sf-ctrl" type="button" data-act="timeline" data-show="${daily ? 'true' : 'false'}">timeline</button>
      <button class="sf-ctrl" type="button" data-act="vigil">vigil</button>
      <button class="sf-ctrl sf-ctrl--bday" type="button" data-act="birthday" data-show="false"></button>
      <button class="sf-ctrl sf-ctrl--candle" type="button" data-act="candles" data-show="false"></button>
    </div>

    <svg class="sf-hover-line" aria-hidden="true">
      <line x1="0" y1="0" x2="0" y2="0" />
    </svg>
    <div class="sf-hover" role="tooltip" aria-hidden="true">
      <p class="sf-hover__arabic"></p>
      <p class="sf-hover__english"></p>
      <div class="sf-hover__meta">
        <span class="sf-hover__age"></span>
        <span class="sf-hover__bday" data-show="false"></span>
      </div>
    </div>
  `
  scene.appendChild(overlay)

  const $ = <T extends Element>(sel: string) => overlay.querySelector<T>(sel)!
  const introEl = $('.sf-intro') as HTMLElement
  const tallyEl = $('.sf-tally') as HTMLElement
  const tallyNumEl = $('.sf-tally__current') as HTMLElement
  const captionEl = $('.sf-caption') as HTMLElement
  const skipBtn = $('.sf-skip') as HTMLButtonElement
  const hoverEl = $('.sf-hover') as HTMLElement
  const hoverArEl = $('.sf-hover__arabic') as HTMLElement
  const hoverEnEl = $('.sf-hover__english') as HTMLElement
  const hoverAgeEl = $('.sf-hover__age') as HTMLElement
  const hoverBdayEl = $('.sf-hover__bday') as HTMLElement
  const hoverLineEl = $('.sf-hover-line') as unknown as SVGSVGElement
  const hoverLineSeg = hoverLineEl.querySelector('line') as SVGLineElement

  const focusEl = $('.sf-focus') as HTMLElement
  const focusArEl = $('.sf-focus__arabic') as HTMLElement
  const focusEnEl = $('.sf-focus__english') as HTMLElement
  const focusAgeEl = $('.sf-focus__age') as HTMLElement
  const focusBdayEl = $('.sf-focus__bday') as HTMLElement
  const focusCandleBtn = $('.sf-focus__candle') as HTMLButtonElement
  const focusShareBtn = $('.sf-focus__share') as HTMLButtonElement
  const focusCloseBtn = $('.sf-focus__close') as HTMLButtonElement
  const focusNavEl = $('.sf-focus__nav') as HTMLElement
  const focusPrevBtn = $('.sf-focus__prev') as HTMLButtonElement
  const focusNextBtn = $('.sf-focus__next') as HTMLButtonElement
  const focusPosEl = $('.sf-focus__pos') as HTMLElement

  const controlsEl = $('.sf-controls') as HTMLElement
  const searchPanel = $('.sf-panel--search') as HTMLElement
  const searchInput = $('.sf-search__input') as HTMLInputElement
  const searchResults = $('.sf-search__results') as HTMLElement
  const agesPanel = $('.sf-panel--ages') as HTMLElement
  const agesBars = $('.sf-ages__bars') as HTMLElement
  const agesAllBtn = $('.sf-ages__all') as HTMLButtonElement
  const timelinePanel = $('.sf-panel--timeline') as HTMLElement
  const timelineDateEl = $('.sf-timeline__date') as HTMLElement
  const timelineRange = $('.sf-timeline__range') as HTMLInputElement
  const timelineNote = $('.sf-timeline__note') as HTMLElement
  const timelinePlayBtn = $('.sf-timeline__play') as HTMLButtonElement
  const bdayBtn = $('.sf-ctrl--bday') as HTMLButtonElement
  const candleCtrlBtn = $('.sf-ctrl--candle') as HTMLButtonElement

  // ── Hover detection ──────────────────────────────────────────────────────
  const hover = createHover({ camera, geometry: geometry3d })

  let hoverIdx: number | null = null
  let pointerScreenX = -999
  let pointerScreenY = -999
  let pointerCanvasX = 0
  let pointerCanvasY = 0
  let pointerValid = false
  let touchTapPending = false

  const TAP_MAX_MOVE_PX = 8
  const TAP_MAX_DURATION_MS = 600
  let tapPointerId: number | null = null
  let tapStartX = 0
  let tapStartY = 0
  let tapStartTime = 0
  // Mouse press tracking, so a click that ends a drag doesn't focus a star.
  let mouseDownX = 0
  let mouseDownY = 0

  const ageLine = (age: number): string =>
    age === 255
      ? ''
      : age === 0
        ? 'under <strong>1</strong> year old'
        : `<strong>${age}</strong> year${age === 1 ? '' : 's'} old`

  // "Today, they would have turned N" when the birthday is today.
  const birthdayNote = (idx: number): string | null => {
    const v = dataset.dob[idx]
    if (!v || dobMonth(v) !== todayMonth || dobDay(v) !== todayDay) return null
    const turned = todayYear - dobYear(v)
    if (turned > 0 && turned < 40) return `Today, they would have turned ${turned}.`
    return 'Today is their birthday.'
  }

  const setHoverCard = (idx: number | null) => {
    if (idx === null) {
      hoverEl.removeAttribute('data-visible')
      hoverLineEl.removeAttribute('data-visible')
      stars.setHoverIndex(null)
      return
    }
    hoverArEl.textContent = dataset.arabicAt(idx) || '—'
    hoverEnEl.textContent = dataset.englishAt(idx) || '(name not transliterated)'
    hoverAgeEl.innerHTML = ageLine(dataset.ages[idx])
    const note = birthdayNote(idx)
    if (note) {
      hoverBdayEl.textContent = note
      hoverBdayEl.setAttribute('data-show', 'true')
    } else {
      hoverBdayEl.setAttribute('data-show', 'false')
    }
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
    const off = 36
    let left = x + off
    let top = y + off
    if (left + rect.width + 16 > vw) left = x - rect.width - off
    if (top + rect.height + 16 > vh) top = y - rect.height - off
    if (left < 12) left = 12
    if (top < 12) top = 12
    hoverEl.style.left = `${left}px`
    hoverEl.style.top = `${top}px`
  }

  const updateHoverLine = (idx: number) => {
    const canvasRect = canvas.getBoundingClientRect()
    const star = hover.projectToScreen(idx, canvasRect)
    if (star.behind) {
      hoverLineEl.removeAttribute('data-visible')
      return
    }
    const cardRect = hoverEl.getBoundingClientRect()
    const cx = Math.max(cardRect.left, Math.min(cardRect.right, star.x))
    const cy = Math.max(cardRect.top, Math.min(cardRect.bottom, star.y))
    if (cx === star.x && cy === star.y) {
      hoverLineEl.removeAttribute('data-visible')
      return
    }
    hoverLineEl.setAttribute('data-visible', 'true')
    hoverLineSeg.setAttribute('x1', star.x.toFixed(1))
    hoverLineSeg.setAttribute('y1', star.y.toFixed(1))
    hoverLineSeg.setAttribute('x2', cx.toFixed(1))
    hoverLineSeg.setAttribute('y2', cy.toFixed(1))
  }

  // ── Phase state machine ──────────────────────────────────────────────────
  type Phase = 'pre' | 'instructions' | 'pour' | 'full'
  let phase: Phase = 'pre'
  const mountTime = performance.now()

  const setPhase = (next: Phase) => {
    if (phase === next) return
    phase = next
    introEl.setAttribute('data-phase', next === 'pre' ? 'pre' : 'gone')
    if (next === 'pour' || next === 'full') {
      tallyEl.setAttribute('data-visible', 'true')
      controlsEl.setAttribute('data-visible', 'true')
      if (birthdayIndices.length > 0) {
        bdayBtn.setAttribute('data-show', 'true')
        bdayBtn.textContent = `today's birthdays · ${birthdayIndices.length}`
      }
      updateCandleControl()
    }
    captionEl.setAttribute('data-visible', next === 'instructions' ? 'true' : 'false')
    if (next === 'pour' && !reduced) controls.autoRotate = true
    if (next === 'full') skipBtn.setAttribute('data-hidden', 'true')
  }

  // ── Reveal-all (skip / deep link / timeline / vigil all lean on this) ─────
  const revealAllNow = () => {
    skipPour({ pour, total: dataset.count })
    for (let i = 0; i < dataset.count; i += 1) geometry3d.appearTime[i] = 0
    ;(stars.mesh.geometry.getAttribute('aAppearTime') as THREE.BufferAttribute).needsUpdate = true
    if (interactionMode !== 'timeline') tallyNumEl.textContent = fmt(dataset.count)
    setPhase('full')
  }
  const onSkip = () => revealAllNow()
  skipBtn.addEventListener('click', onSkip)

  // ── Focus a single child ──────────────────────────────────────────────────
  let focusedIndex: number | null = null
  // Isolation mode (birthdays / candles): hides every star outside the set and
  // lets the focus card's ‹ › arrows step through it.
  let isoMode: 'none' | 'birthday' | 'candle' = 'none'
  let isoSet: number[] = []
  let isoPtr = 0

  const setHash = (index: number) => {
    try {
      history.replaceState(null, '', `#child=${index}`)
    } catch {
      /* ignore */
    }
  }
  const clearHash = () => {
    try {
      history.replaceState(null, '', location.pathname + location.search)
    } catch {
      /* ignore */
    }
  }

  const ensureRevealed = (index: number) => {
    if (interactionMode === 'timeline') {
      const need = order[index] + 1
      if (need > timelineRevealCount) setTimelineReveal(need, true)
    } else if (geometry3d.appearTime[index] > 0) {
      geometry3d.appearTime[index] = 0
      ;(stars.mesh.geometry.getAttribute('aAppearTime') as THREE.BufferAttribute).needsUpdate = true
    }
  }

  const updateCandleButton = (index: number) => {
    // Label stays constant; the filled (data-on) state shows whether it's lit.
    // Click toggles it back off.
    focusCandleBtn.textContent = 'light a candle'
    focusCandleBtn.setAttribute('data-on', candles.has(index) ? 'true' : 'false')
  }

  const populateFocusCard = (index: number) => {
    focusArEl.textContent = dataset.arabicAt(index) || '—'
    focusEnEl.textContent = dataset.englishAt(index) || '(name not transliterated)'
    focusAgeEl.innerHTML = ageLine(dataset.ages[index])
    const note = birthdayNote(index)
    if (note) {
      focusBdayEl.textContent = note
      focusBdayEl.setAttribute('data-show', 'true')
    } else {
      focusBdayEl.setAttribute('data-show', 'false')
    }
    updateCandleButton(index)
    focusShareBtn.textContent = 'copy link'
  }

  const focus = (index: number, opts: { fly?: boolean } = {}) => {
    if (index < 0 || index >= dataset.count) return
    ensureRevealed(index)
    focusedIndex = index
    stars.setFocusIndex(index)
    populateFocusCard(index)
    // In an isolation mode the card carries a ‹ n / total › stepper.
    if (isoMode !== 'none') {
      const pos = isoSet.indexOf(index)
      if (pos >= 0) isoPtr = pos
      focusPosEl.textContent = `${isoPtr + 1} / ${isoSet.length}`
      focusNavEl.setAttribute('data-show', 'true')
    } else {
      focusNavEl.setAttribute('data-show', 'false')
    }
    focusEl.setAttribute('data-visible', 'true')
    setHash(index)
    if (opts.fly !== false) startFlyTo(index)
  }

  const clearFocus = (): boolean => {
    if (focusedIndex === null) return false
    focusedIndex = null
    stars.setFocusIndex(null)
    focusEl.setAttribute('data-visible', 'false')
    clearHash()
    return true
  }

  const onFocusClose = () => {
    if (isoMode !== 'none') {
      exitIso()
      return
    }
    stopVigil()
    clearFocus()
  }
  focusCloseBtn.addEventListener('click', onFocusClose)

  // Shows/labels the bottom-bar "candles · N" control based on how many are lit.
  const updateCandleControl = () => {
    if (candles.size > 0) {
      candleCtrlBtn.setAttribute('data-show', 'true')
      candleCtrlBtn.textContent = `candles · ${candles.size}`
    } else {
      candleCtrlBtn.setAttribute('data-show', 'false')
    }
  }

  const onToggleCandle = () => {
    if (focusedIndex === null) return
    const idx = focusedIndex
    const on = !candles.has(idx)
    if (on) candles.add(idx)
    else candles.delete(idx)
    candleFlags[idx] = on ? 1 : 0
    stars.setCandle(idx, on)
    persistCandles()
    updateCandleButton(idx)
    updateCandleControl()
    // Keep the candle isolation set in sync when lighting/extinguishing in-mode.
    if (isoMode === 'candle') {
      isoSet = [...candles]
      if (isoSet.length === 0) {
        exitIso()
      } else {
        if (isoPtr >= isoSet.length) isoPtr = isoSet.length - 1
        if (focusedIndex === null || !candles.has(focusedIndex)) {
          focus(isoSet[isoPtr], { fly: true })
        }
      }
    }
  }
  focusCandleBtn.addEventListener('click', onToggleCandle)

  let shareTimer = 0
  const onShare = async () => {
    if (focusedIndex !== null) setHash(focusedIndex)
    try {
      await navigator.clipboard.writeText(location.href)
      focusShareBtn.textContent = 'link copied'
    } catch {
      focusShareBtn.textContent = location.href
    }
    window.clearTimeout(shareTimer)
    shareTimer = window.setTimeout(() => {
      focusShareBtn.textContent = 'copy link'
    }, 1800)
  }
  focusShareBtn.addEventListener('click', onShare)

  // ── Control bar & panels ───────────────────────────────────────────────────
  type PanelName = 'search' | 'ages' | 'timeline' | null
  let openPanel: PanelName = null
  let interactionMode: 'none' | 'timeline' = 'none'

  const panelEls: Record<Exclude<PanelName, null>, HTMLElement> = {
    search: searchPanel,
    ages: agesPanel,
    timeline: timelinePanel
  }

  const updateCtrlActive = () => {
    overlay.querySelectorAll<HTMLButtonElement>('.sf-ctrl').forEach((btn) => {
      const act = btn.dataset.act
      const active =
        act === openPanel ||
        (act === 'vigil' && vigilActive) ||
        (act === 'birthday' && isoMode === 'birthday') ||
        (act === 'candles' && isoMode === 'candle')
      btn.setAttribute('data-active', active ? 'true' : 'false')
    })
  }

  const setPanel = (next: PanelName) => {
    if (openPanel === next) next = null
    if (openPanel === 'timeline' && next !== 'timeline') exitTimeline()
    // The age filter is only controllable from its panel, so clear it on close.
    if (openPanel === 'ages' && next !== 'ages' && selectedAge !== null) {
      selectedAge = null
      applyAgeFilter()
    }
    openPanel = next
    ;(['search', 'ages', 'timeline'] as const).forEach((key) => {
      panelEls[key].setAttribute('data-open', key === next ? 'true' : 'false')
    })
    if (next) {
      stopVigil()
      exitIso()
    }
    if (next === 'timeline') enterTimeline()
    if (next === 'search') window.setTimeout(() => searchInput.focus(), 0)
    updateCtrlActive()
  }

  // ── Search ──────────────────────────────────────────────────────────────
  const renderSearchResults = (q: string) => {
    const results = q.trim().length < 2 ? [] : getSearchIndex().query(q, 40)
    if (results.length === 0) {
      searchResults.innerHTML =
        q.trim().length < 2
          ? ''
          : `<p class="sf-search__empty">No name matches “${escapeHtml(q.trim())}”.</p>`
      return
    }
    searchResults.innerHTML = results
      .map(
        (r) => `<button class="sf-result" type="button" role="option" data-idx="${r.index}">
          <span class="sf-result__ar">${escapeHtml(r.arabic || '—')}</span>
          <span class="sf-result__en">${escapeHtml(r.english || '(name not transliterated)')}<span class="sf-result__age">${
            dataset.ages[r.index] === 255 ? '' : ` · age ${dataset.ages[r.index]}`
          }</span></span>
        </button>`
      )
      .join('')
  }
  let searchDebounce = 0
  const onSearchInput = () => {
    window.clearTimeout(searchDebounce)
    const q = searchInput.value
    searchDebounce = window.setTimeout(() => renderSearchResults(q), 110)
  }
  searchInput.addEventListener('input', onSearchInput)
  const onResultsClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('.sf-result') as HTMLElement | null
    if (!btn) return
    const idx = Number(btn.dataset.idx)
    if (Number.isInteger(idx)) {
      setPanel(null)
      focus(idx, { fly: true })
    }
  }
  searchResults.addEventListener('click', onResultsClick)

  // ── Age histogram / filter ─────────────────────────────────────────────────
  const ageCounts = new Array(18).fill(0)
  for (let i = 0; i < dataset.count; i += 1) {
    const a = dataset.ages[i]
    if (a >= 0 && a < 18) ageCounts[a] += 1
  }
  const maxAgeCount = Math.max(1, ...ageCounts)
  let selectedAge: number | null = null
  agesBars.innerHTML = ageCounts
    .map(
      (c, age) => `<button class="sf-agebar" type="button" data-age="${age}" title="age ${age}: ${fmt(c)}" style="--h:${(
        (c / maxAgeCount) * 100
      ).toFixed(1)}%"><span class="sf-agebar__fill"></span><span class="sf-agebar__n">${age}</span></button>`
    )
    .join('')
  const applyAgeFilter = () => {
    if (selectedAge === null) {
      stars.setAgeFilter(null)
    } else {
      stars.setAgeFilter({ min: selectedAge, max: selectedAge })
    }
    agesBars.querySelectorAll<HTMLButtonElement>('.sf-agebar').forEach((b) => {
      b.setAttribute('data-active', Number(b.dataset.age) === selectedAge ? 'true' : 'false')
    })
    agesAllBtn.setAttribute('data-active', selectedAge === null ? 'true' : 'false')
  }
  const onAgesClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('.sf-agebar') as HTMLElement | null
    if (!btn) return
    const age = Number(btn.dataset.age)
    selectedAge = selectedAge === age ? null : age
    applyAgeFilter()
  }
  agesBars.addEventListener('click', onAgesClick)
  const onAgesAll = () => {
    selectedAge = null
    applyAgeFilter()
  }
  agesAllBtn.addEventListener('click', onAgesAll)
  applyAgeFilter()

  // ── Timeline ────────────────────────────────────────────────────────────────
  const dailyPoints = daily?.points ?? []
  const dailyFinal = daily?.final ?? 0
  let timelineRevealCount = dataset.count
  let timelinePlaying = false
  let timelineIdx = dailyPoints.length - 1 // float index for smooth play

  const revealForPoint = (idx: number): number => {
    if (!daily || dailyFinal <= 0 || dailyPoints.length === 0) return dataset.count
    const p = dailyPoints[Math.max(0, Math.min(dailyPoints.length - 1, idx))]
    return Math.round((p.c / dailyFinal) * dataset.count)
  }

  const setTimelineReveal = (count: number, syncSlider: boolean) => {
    timelineRevealCount = Math.max(0, Math.min(dataset.count, count))
    stars.setRevealCount(timelineRevealCount)
    hover.setReveal(timelineRevealCount, order)
    tallyNumEl.textContent = fmt(timelineRevealCount)
    if (syncSlider && dailyPoints.length > 0) {
      // Find the date index whose proportion is closest to the forced count.
      const targetFrac = timelineRevealCount / dataset.count
      let lo = 0
      for (let i = 0; i < dailyPoints.length; i += 1) {
        if (dailyPoints[i].c / dailyFinal <= targetFrac) lo = i
      }
      timelineIdx = lo
      timelineRange.value = String(lo)
      paintTimelineLabel(lo)
    }
  }

  const paintTimelineLabel = (idx: number) => {
    if (dailyPoints.length === 0) return
    const p = dailyPoints[Math.max(0, Math.min(dailyPoints.length - 1, Math.round(idx)))]
    timelineDateEl.textContent = formatDate({ iso: p.d })
    // The lead number is the count of lit stars (identical to the tally); the
    // reported toll is shown only as the proportion it tracks, never as a rival
    // figure — the named list (stars) is a subset of the reported total.
    timelineNote.textContent =
      `${fmt(timelineRevealCount)} of ${fmt(dataset.count)} names · in proportion to the reported toll (${fmt(p.c)} by this date)`
  }

  const applyTimelineIdx = (idx: number) => {
    timelineIdx = Math.max(0, Math.min(dailyPoints.length - 1, idx))
    const count = revealForPoint(Math.round(timelineIdx))
    timelineRevealCount = count
    stars.setRevealCount(count)
    hover.setReveal(count, order)
    tallyNumEl.textContent = fmt(count)
    paintTimelineLabel(timelineIdx)
  }

  const enterTimeline = () => {
    if (!daily || dailyPoints.length === 0) return
    interactionMode = 'timeline'
    revealAllNow() // make sure the pour is complete so reveal is purely manual
    timelineRange.max = String(dailyPoints.length - 1)
    timelineRange.value = String(dailyPoints.length - 1)
    applyTimelineIdx(dailyPoints.length - 1)
  }
  const exitTimeline = () => {
    interactionMode = 'none'
    timelinePlaying = false
    timelinePlayBtn.textContent = '▶ play'
    stars.setRevealCount(-1)
    hover.setReveal(-1, null)
    revealAllNow()
  }
  const onTimelineInput = () => {
    timelinePlaying = false
    timelinePlayBtn.textContent = '▶ play'
    applyTimelineIdx(Number(timelineRange.value))
  }
  timelineRange.addEventListener('input', onTimelineInput)
  const onTimelinePlay = () => {
    if (dailyPoints.length === 0) return
    timelinePlaying = !timelinePlaying
    timelinePlayBtn.textContent = timelinePlaying ? '❚❚ pause' : '▶ play'
    if (timelinePlaying && Math.round(timelineIdx) >= dailyPoints.length - 1) {
      applyTimelineIdx(0)
    }
  }
  timelinePlayBtn.addEventListener('click', onTimelinePlay)

  // ── Vigil ──────────────────────────────────────────────────────────────────
  let vigilActive = false
  let vigilPtr = 0
  let vigilLast = 0
  const VIGIL_INTERVAL = reduced ? 4200 : 6000
  function stopVigil() {
    if (!vigilActive) return
    vigilActive = false
    updateCtrlActive()
  }
  const startVigil = () => {
    setPanel(null)
    exitIso()
    revealAllNow()
    vigilActive = true
    vigilPtr = Math.floor(Math.random() * dataset.count)
    vigilLast = performance.now() - VIGIL_INTERVAL // advance on the next tick
    updateCtrlActive()
  }
  const vigilAdvance = (now: number) => {
    vigilPtr = (vigilPtr + 1) % dataset.count
    focus(pour.appearOrder[vigilPtr], { fly: true })
    vigilLast = now
  }

  // ── Isolation (birthdays / candles) ─────────────────────────────────────────
  // A toggle: hide every star outside the set, focus the first, and let the
  // card's ‹ › arrows step through just that set.
  const isoSetFor = (mode: 'birthday' | 'candle'): number[] =>
    mode === 'birthday' ? birthdayIndices : [...candles]

  const enterIso = (mode: 'birthday' | 'candle') => {
    const set = isoSetFor(mode)
    if (set.length === 0) return
    setPanel(null)
    stopVigil()
    revealAllNow()
    isoMode = mode
    isoSet = set
    isoPtr = 0
    stars.setIsolateBirthday(mode === 'birthday')
    stars.setIsolateCandle(mode === 'candle')
    hover.setIsolation(true, mode === 'birthday' ? birthdayFlags : candleFlags)
    focus(isoSet[0], { fly: true })
    updateCtrlActive()
  }
  const exitIso = () => {
    if (isoMode === 'none') return
    isoMode = 'none'
    isoSet = []
    stars.setIsolateBirthday(false)
    stars.setIsolateCandle(false)
    hover.setIsolation(false, null)
    focusNavEl.setAttribute('data-show', 'false')
    clearFocus()
    updateCtrlActive()
  }
  const stepIso = (dir: number) => {
    if (isoMode === 'none' || isoSet.length === 0) return
    isoPtr = (isoPtr + dir + isoSet.length) % isoSet.length
    focus(isoSet[isoPtr], { fly: true })
  }
  const onIsoPrev = () => stepIso(-1)
  const onIsoNext = () => stepIso(1)
  focusPrevBtn.addEventListener('click', onIsoPrev)
  focusNextBtn.addEventListener('click', onIsoNext)

  // ── Control bar clicks ─────────────────────────────────────────────────────
  const onControlsClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('.sf-ctrl') as HTMLElement | null
    if (!btn) return
    switch (btn.dataset.act) {
      case 'search': setPanel('search'); break
      case 'ages': setPanel('ages'); break
      case 'timeline': setPanel('timeline'); break
      case 'vigil': vigilActive ? stopVigil() : startVigil(); break
      case 'birthday': isoMode === 'birthday' ? exitIso() : enterIso('birthday'); break
      case 'candles': isoMode === 'candle' ? exitIso() : enterIso('candle'); break
    }
  }
  controlsEl.addEventListener('click', onControlsClick)

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
    if (e.pointerType === 'touch') {
      if (tapPointerId !== null && e.pointerId === tapPointerId) {
        const dx = e.clientX - tapStartX
        const dy = e.clientY - tapStartY
        if (dx * dx + dy * dy > TAP_MAX_MOVE_PX * TAP_MAX_MOVE_PX) tapPointerId = null
      }
      return
    }
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
    if (e.pointerType !== 'touch') {
      mouseDownX = e.clientX
      mouseDownY = e.clientY
      return
    }
    if (tapPointerId !== null) {
      tapPointerId = null
      return
    }
    tapPointerId = e.pointerId
    tapStartX = e.clientX
    tapStartY = e.clientY
    tapStartTime = performance.now()
  }
  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    if (e.pointerId !== tapPointerId) return
    const heldFor = performance.now() - tapStartTime
    tapPointerId = null
    if (heldFor > TAP_MAX_DURATION_MS) return
    updatePointer(e.clientX, e.clientY, true)
    touchTapPending = true
  }
  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    if (e.pointerId === tapPointerId) tapPointerId = null
  }
  // Mouse click: focus the hovered star (unless the gesture was a drag).
  const onClick = (e: MouseEvent) => {
    const dx = e.clientX - mouseDownX
    const dy = e.clientY - mouseDownY
    if (dx * dx + dy * dy > 25) return
    if (hoverIdx !== null) {
      stopVigil()
      const idx = hoverIdx
      hoverIdx = null
      setHoverCard(null)
      focus(idx, { fly: false })
    } else if (focusedIndex !== null) {
      clearFocus()
    }
  }

  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerleave', onPointerLeave)
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerCancel)
  canvas.addEventListener('click', onClick)

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
    controls.maxDistance = computeMaxDistance(camera.aspect, camera.fov)
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

    if (interactionMode !== 'timeline') {
      if (phase === 'pre') {
        if (reduced) {
          setPhase('pour')
          pour.startedAt = now
        } else if (elapsedMs > MEMORIAL_DISPLAY_MS) {
          setPhase('instructions')
        }
      } else if (phase === 'instructions') {
        if (elapsedMs > PRE_PHASE_MS) {
          setPhase('pour')
          pour.startedAt = now
        }
      } else if (phase === 'pour') {
        advancePour({ pour, now, total: dataset.count })
        tallyNumEl.textContent = fmt(pour.appeared)
        if (pour.done) setPhase('full')
      } else {
        tallyNumEl.textContent = fmt(dataset.count)
      }
    } else if (timelinePlaying) {
      // Advance ~the full range over 28s, then stop at the end.
      const perMs = dailyPoints.length / 28000
      let nextIdx = timelineIdx + perMs * 16.7
      if (nextIdx >= dailyPoints.length - 1) {
        nextIdx = dailyPoints.length - 1
        timelinePlaying = false
        timelinePlayBtn.textContent = '▶ play'
      }
      timelineRange.value = String(Math.round(nextIdx))
      applyTimelineIdx(nextIdx)
    }

    stars.updateTime(elapsedMs)

    if (vigilActive && !flyTo.active && now - vigilLast > VIGIL_INTERVAL) {
      vigilAdvance(now)
    }

    if (flyTo.active) {
      const t = Math.min(1, (now - flyTo.start) / flyTo.dur)
      const e = easeInOut(t)
      const theta = flyTo.from.theta + (flyTo.to.theta - flyTo.from.theta) * e
      const phi = flyTo.from.phi + (flyTo.to.phi - flyTo.from.phi) * e
      const radius = flyTo.from.radius + (flyTo.to.radius - flyTo.from.radius) * e
      const off = new THREE.Vector3().setFromSpherical(new THREE.Spherical(radius, phi, theta))
      camera.position.copy(controls.target).add(off)
      camera.lookAt(controls.target)
      if (t >= 1) flyTo.active = false
    } else {
      if (controls.target.lengthSq() > 1e-8) controls.target.set(0, 0, 0)
      controls.update()
    }

    if ((pointerValid || touchTapPending) && phase !== 'pre') {
      const isTouchTap = touchTapPending
      const tolerance = isTouchTap ? TAP_TOLERANCE_PX : HOVER_TOLERANCE_PX
      const dpr = cappedDPR()
      const found = hover.resolve(elapsedMs, lastW, lastH, dpr, tolerance, POINT_SCALE, POINT_SIZE_CAP_PX)
      if (isTouchTap) {
        // A tap focuses (sticky card + actions) rather than a transient hover.
        stopVigil()
        if (found !== null) focus(found, { fly: false })
        else clearFocus()
        hoverIdx = null
        setHoverCard(null)
        pointerValid = false
        hover.setPointer(0, 0, false)
      } else {
        if (found !== hoverIdx) {
          hoverIdx = found
          setHoverCard(found)
        } else if (found !== null) {
          placeHover(pointerScreenX, pointerScreenY)
        }
      }
      touchTapPending = false
    }
    if (hoverIdx !== null) updateHoverLine(hoverIdx)

    renderer.render(threeScene, camera)
    raf = requestAnimationFrame(tick)
  }

  // ── Deep link (#child=N) ───────────────────────────────────────────────────
  const parseChildHash = (): number | null => {
    const m = /^#child=(\d+)$/.exec(location.hash || '')
    if (!m) return null
    const n = Number(m[1])
    return Number.isInteger(n) && n >= 0 && n < dataset.count ? n : null
  }
  const deepLink = parseChildHash()
  if (deepLink !== null) {
    revealAllNow()
    focus(deepLink, { fly: true })
  }

  raf = requestAnimationFrame(tick)

  // ── Teardown ─────────────────────────────────────────────────────────────
  return {
    destroy: () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(shareTimer)
      window.clearTimeout(searchDebounce)
      window.removeEventListener('resize', resize)
      window.removeEventListener('keydown', onKeyDown)
      resizeObs.disconnect()
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('pointerdown', stopAutoRotate)
      canvas.removeEventListener('wheel', stopAutoRotate)
      skipBtn.removeEventListener('click', onSkip)
      focusCloseBtn.removeEventListener('click', onFocusClose)
      focusCandleBtn.removeEventListener('click', onToggleCandle)
      focusShareBtn.removeEventListener('click', onShare)
      focusPrevBtn.removeEventListener('click', onIsoPrev)
      focusNextBtn.removeEventListener('click', onIsoNext)
      searchInput.removeEventListener('input', onSearchInput)
      searchResults.removeEventListener('click', onResultsClick)
      agesBars.removeEventListener('click', onAgesClick)
      agesAllBtn.removeEventListener('click', onAgesAll)
      timelineRange.removeEventListener('input', onTimelineInput)
      timelinePlayBtn.removeEventListener('click', onTimelinePlay)
      controlsEl.removeEventListener('click', onControlsClick)
      controls.dispose()
      stars.dispose()
      sceneSetup.dispose()
      scene.remove()
    }
  }
}

// INITIAL_DISTANCE exported for tests/dev tools; not used here directly.
export { INITIAL_DISTANCE }
