import type { Dataset, Snapshot, StarGeometry } from '../types.ts'
import { buildGeometry, findNearestStar } from './geometry.ts'
import { buildPour, advancePour, skipPour, syncAppearMask } from './pour.ts'

interface StarfieldMount {
  container: HTMLElement
  dataset: Dataset
  snapshot: Snapshot
}

interface StarfieldHandle {
  destroy: () => void
}

const POUR_DURATION_MS = 90_000
const HOVER_RADIUS = 18
const TAP_RADIUS = 28
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

export const mountStarfield = ({
  container,
  dataset,
  snapshot
}: StarfieldMount): StarfieldHandle => {
  const scene = document.createElement('div')
  scene.className = 'starfield'
  container.appendChild(scene)

  const canvas = document.createElement('canvas')
  canvas.className = 'starfield__canvas'
  canvas.setAttribute('role', 'img')
  canvas.setAttribute(
    'aria-label',
    `A field of ${dataset.count.toLocaleString()} stars, one for each child killed in Gaza.`
  )
  scene.appendChild(canvas)

  const overlay = document.createElement('div')
  overlay.className = 'starfield__overlay'
  overlay.innerHTML = `
    <div class="sf-intro" data-phase="pre">
      <h1 class="sf-intro__number">${FORMATTER.format(dataset.count)}<span class="sf-intro__children"> children</span></h1>
      <p class="sf-intro__line">killed in the Israeli Genocide on Gaza</p>
    </div>
    <div class="sf-tally" data-visible="false">
      <span class="sf-tally__current mono">0</span><span class="sf-tally__sep"> / </span><span class="sf-tally__total mono">${FORMATTER.format(dataset.count)}</span>
    </div>
    <div class="sf-caption" data-visible="false">
      Hover a star to read their name.
    </div>
    <div class="sf-meta">
      <span class="sf-meta__snap">Snapshot ${formatDate({ iso: snapshot.date })}</span>
      <span class="sf-meta__sep">·</span>
      <a class="sf-meta__link" href="${snapshot.sourceUrl}" target="_blank" rel="noopener noreferrer">Gaza MoH via Tech for Palestine</a>
    </div>
    <button class="sf-skip" type="button" aria-label="Skip the pour and show all stars">skip</button>
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

  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Canvas 2D context unavailable')

  const reduced = prefersReducedMotion()
  const pour = buildPour({
    count: dataset.count,
    durationMs: reduced ? 800 : POUR_DURATION_MS
  })
  const appearMask = new Uint8Array(dataset.count)
  let lastAppeared = 0

  let geometry: StarGeometry | null = null
  let dpr = Math.max(1, window.devicePixelRatio || 1)
  let width = 0
  let height = 0
  let hoverIdx: number | null = null
  let pointerX = -999
  let pointerY = -999
  let hasPointer = false
  let phase: 'pre' | 'pour' | 'full' = 'pre'
  let phaseStart = performance.now()

  const resize = () => {
    width = scene.clientWidth
    height = scene.clientHeight
    dpr = Math.max(1, window.devicePixelRatio || 1)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    geometry = buildGeometry({ count: dataset.count, width, height })
    appearMask.fill(0)
    for (let k = 0; k < pour.appeared; k += 1) appearMask[pour.appearOrder[k]] = 1
    lastAppeared = pour.appeared
    hoverIdx = null
  }

  const setPhase = ({ next }: { next: 'pre' | 'pour' | 'full' }) => {
    if (phase === next) return
    phase = next
    phaseStart = performance.now()
    introEl.setAttribute('data-phase', next === 'pre' ? 'pre' : 'gone')
    if (next === 'pour' || next === 'full') {
      tallyEl.setAttribute('data-visible', 'true')
    }
    if (next === 'full') {
      captionEl.setAttribute('data-visible', 'true')
      skipBtn.setAttribute('data-hidden', 'true')
    }
  }

  const setHoverCard = ({ idx }: { idx: number | null }) => {
    if (idx === null) {
      hoverEl.removeAttribute('data-visible')
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
    placeHover({ x: pointerX, y: pointerY })
  }

  const placeHover = ({ x, y }: { x: number; y: number }) => {
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

  const resolveHover = ({ radius }: { radius: number }) => {
    if (!geometry || !hasPointer || phase === 'pre') return
    const found = findNearestStar({
      geometry,
      appearedMask: appearMask,
      x: pointerX,
      y: pointerY,
      maxDistance: radius
    })
    if (found !== hoverIdx) {
      hoverIdx = found
      setHoverCard({ idx: found })
    } else if (found !== null) {
      placeHover({ x: pointerX, y: pointerY })
    }
  }

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return
    pointerX = e.clientX
    pointerY = e.clientY
    hasPointer = true
    resolveHover({ radius: HOVER_RADIUS })
  }
  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return
    hasPointer = false
    hoverIdx = null
    setHoverCard({ idx: null })
  }
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    pointerX = e.clientX
    pointerY = e.clientY
    hasPointer = true
    resolveHover({ radius: TAP_RADIUS })
  }

  scene.addEventListener('pointermove', onPointerMove)
  scene.addEventListener('pointerleave', onPointerLeave)
  scene.addEventListener('pointerdown', onPointerDown)

  const onSkip = () => {
    skipPour({ pour, total: dataset.count })
    for (let i = 0; i < dataset.count; i += 1) appearMask[i] = 1
    lastAppeared = dataset.count
    tallyNumEl.textContent = FORMATTER.format(dataset.count)
    setPhase({ next: 'full' })
  }
  skipBtn.addEventListener('click', onSkip)

  const onResize = () => resize()
  window.addEventListener('resize', onResize)

  let raf = 0
  const draw = () => {
    if (!geometry) {
      raf = requestAnimationFrame(draw)
      return
    }

    const now = performance.now()

    if (phase === 'pre') {
      const preFor = now - phaseStart
      if (preFor > 3200) setPhase({ next: 'pour' })
    }

    if (phase === 'pour') {
      pour.startedAt = pour.startedAt || now
      advancePour({ pour, now, total: dataset.count })
      syncAppearMask({
        appearOrder: pour.appearOrder,
        appeared: pour.appeared,
        mask: appearMask,
        lastAppeared
      })
      lastAppeared = pour.appeared
      tallyNumEl.textContent = FORMATTER.format(pour.appeared)
      if (pour.done) setPhase({ next: 'full' })
    } else if (phase === 'full') {
      tallyNumEl.textContent = FORMATTER.format(dataset.count)
    }

    // slight deep-space gradient background each frame
    ctx.fillStyle = '#050408'
    ctx.fillRect(0, 0, width, height)

    const { positions, sizes, phases, brightness, speeds, amplitudes, styles } = geometry
    const t = now * 0.001
    const twinkleEnabled = !reduced

    // hover detection lives on pointermove; only re-resolve here during the pour
    // (so newly appeared stars under the cursor get hover)
    if (phase === 'pour') resolveHover({ radius: HOVER_RADIUS })

    for (let i = 0; i < dataset.count; i += 1) {
      if (!appearMask[i]) continue
      if (i === hoverIdx) continue

      const x = positions[i * 2]
      const y = positions[i * 2 + 1]
      const size = sizes[i]
      const base = brightness[i]

      let tw = 0
      if (twinkleEnabled) {
        const spd = speeds[i]
        const amp = amplitudes[i]
        const ph = phases[i]
        const style = styles[i]
        if (style === 2) {
          // shimmer: layered frequencies give an organic, unpredictable glitter
          tw = (Math.sin(t * spd + ph) * 0.6 + Math.sin(t * spd * 2.3 + ph + 1.1) * 0.4) * amp
        } else if (style === 1) {
          // fast twinkle: sharper peaks via squared sine
          const s = Math.sin(t * spd + ph)
          tw = (s * s * Math.sign(s)) * amp
        } else {
          // slow, gentle breathe
          tw = Math.sin(t * spd + ph) * amp
        }
      }

      const alpha = Math.max(0.12, Math.min(1, base + tw))
      ctx.globalAlpha = alpha
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(x, y, size, 0, Math.PI * 2)
      ctx.fill()

      // only the rare bright stars get a soft halo
      if (size > 1.8 && twinkleEnabled) {
        ctx.globalAlpha = alpha * 0.12
        ctx.beginPath()
        ctx.arc(x, y, size * 2.4, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    if (hoverIdx !== null) {
      const x = positions[hoverIdx * 2]
      const y = positions[hoverIdx * 2 + 1]
      // outer warm glow
      ctx.globalAlpha = 0.15
      const grad = ctx.createRadialGradient(x, y, 0, x, y, 28)
      grad.addColorStop(0, 'rgba(255, 238, 195, 1)')
      grad.addColorStop(1, 'rgba(255, 238, 195, 0)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(x, y, 28, 0, Math.PI * 2)
      ctx.fill()

      // bright centre
      ctx.globalAlpha = 1
      ctx.fillStyle = '#fff8e8'
      ctx.beginPath()
      ctx.arc(x, y, Math.max(2.6, sizes[hoverIdx] + 1.6), 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.globalAlpha = 1
    raf = requestAnimationFrame(draw)
  }

  resize()
  raf = requestAnimationFrame(draw)

  return {
    destroy: () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      scene.removeEventListener('pointermove', onPointerMove)
      scene.removeEventListener('pointerleave', onPointerLeave)
      scene.removeEventListener('pointerdown', onPointerDown)
      skipBtn.removeEventListener('click', onSkip)
      scene.remove()
    }
  }
}
