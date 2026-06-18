import * as THREE from 'three'
import type { StarGeometry3D } from '../../types.ts'

const VERT = /* glsl */ `
attribute float aSize;
attribute float aBrightness;
attribute float aPhase;
attribute float aSpeed;
attribute float aAmplitude;
attribute float aStyle;
attribute float aAppearTime;
attribute float aIndex;
attribute float aOrder;
attribute float aAge;
attribute float aBirthday;
attribute float aCandle;

uniform float uTime;
uniform float uPixelRatio;
uniform float uHoverIndex;
uniform float uFocusIndex;
uniform float uReducedMotion;
uniform float uRevealCount;      // < 0 disables manual reveal (normal pour)
uniform float uAgeFilterActive;  // 0 / 1
uniform float uAgeMin;
uniform float uAgeMax;
uniform float uIsolateBirthday;  // 0 / 1 — when on, only today's birthdays show
uniform float uIsolateCandle;    // 0 / 1 — when on, only lit candles show

varying float vAlpha;
varying float vHover;
varying float vFocus;
varying float vAppearReveal;
varying float vCandle;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);

  // Reveal: either driven by the timeline (manual count over appearOrder rank)
  // or by the pour's per-star appear time.
  float reveal;
  if (uRevealCount >= 0.0) {
    reveal = clamp(uRevealCount - aOrder, 0.0, 1.0);
  } else {
    float dt = (uTime - aAppearTime) / 600.0;
    reveal = clamp(dt, 0.0, 1.0);
  }
  vAppearReveal = reveal;

  // Twinkle (skip when reduced-motion)
  float tw = 0.0;
  if (uReducedMotion < 0.5) {
    float t = uTime * 0.001;
    if (aStyle > 1.5) {
      tw = (sin(t * aSpeed + aPhase) * 0.6 + sin(t * aSpeed * 2.3 + aPhase + 1.1) * 0.4) * aAmplitude;
    } else if (aStyle > 0.5) {
      float s = sin(t * aSpeed + aPhase);
      tw = (s * s * sign(s)) * aAmplitude;
    } else {
      tw = sin(t * aSpeed + aPhase) * aAmplitude;
    }
  }

  float base = clamp(aBrightness + tw, 0.12, 1.0);

  // Age filter — fade stars outside the selected range far back without hiding.
  if (uAgeFilterActive > 0.5) {
    float inRange = (aAge >= uAgeMin && aAge <= uAgeMax) ? 1.0 : 0.0;
    base *= mix(0.05, 1.0, inRange);
  }

  vAlpha = base * reveal;

  // Isolation — hide every star outside the active set (birthdays / candles).
  if (uIsolateBirthday > 0.5 && aBirthday < 0.5) {
    vAppearReveal = 0.0;
  }
  if (uIsolateCandle > 0.5 && aCandle < 0.5) {
    vAppearReveal = 0.0;
  }

  float hover = (abs(aIndex - uHoverIndex) < 0.5) ? 1.0 : 0.0;
  float focus = (abs(aIndex - uFocusIndex) < 0.5) ? 1.0 : 0.0;
  vHover = hover;
  vFocus = focus;
  // A lit candle: per-star flicker (0 = no candle) computed here so the
  // fragment shader needs no time uniform.
  float candle = 0.0;
  if (aCandle > 0.5) {
    candle = (uReducedMotion < 0.5) ? (0.9 + 0.1 * sin(uTime * 0.006 + aPhase * 6.0)) : 1.0;
  }
  vCandle = candle;

  float highlight = max(hover, focus);
  float sizeMul = 1.0 + highlight * 4.0 + aCandle * 2.0;
  float ps = aSize * uPixelRatio * sizeMul * (6.5 / max(0.6, -mv.z));
  if (highlight > 0.5) ps = max(ps, 22.0 * uPixelRatio);
  // A lit candle keeps a minimum presence so it stays visible at any zoom.
  else if (aCandle > 0.5) ps = max(ps, 7.0 * uPixelRatio);
  float capPx = (highlight > 0.5) ? 64.0 : (aCandle > 0.5 ? 34.0 : 20.0);
  gl_PointSize = clamp(ps, 1.0, capPx);

  gl_Position = projectionMatrix * mv;
}
`

const FRAG = /* glsl */ `
precision mediump float;

uniform vec3 uStarColor;
uniform vec3 uHoverColor;
uniform vec3 uFocusColor;
uniform vec3 uCandleColor;

varying float vAlpha;
varying float vHover;
varying float vFocus;
varying float vAppearReveal;
varying float vCandle;
void main() {
  if (vAppearReveal <= 0.0) discard;

  vec2 uv = gl_PointCoord - 0.5;
  float dist = length(uv);
  if (dist > 0.5) discard;

  // Regular stars: crisp pinpoint, no halo
  float core = smoothstep(0.5, 0.18, dist);

  // Hovered or focused: bright pinpoint with a soft continuous glow around it.
  if (vHover > 0.5 || vFocus > 0.5) {
    float pinpoint = smoothstep(0.22, 0.0, dist);
    float glow     = smoothstep(0.5, 0.0, dist);
    float intensity = clamp(pinpoint + glow * 0.55, 0.0, 1.0);
    float alpha = intensity * max(vAlpha, 0.6);
    vec3 color = (vHover > 0.5) ? uHoverColor : uFocusColor;
    gl_FragColor = vec4(color * alpha, alpha);
    return;
  }

  // A candle lit in remembrance — a warm, brighter glow so the star stands out.
  if (vCandle > 0.0) {
    float pinpoint = smoothstep(0.3, 0.0, dist);
    float glow     = smoothstep(0.5, 0.0, dist);
    float intensity = clamp(pinpoint + glow * 0.6, 0.0, 1.0);
    float alpha = intensity * max(vAlpha, 0.85) * vCandle;
    gl_FragColor = vec4(uCandleColor * alpha, alpha);
    return;
  }

  float alpha = core * vAlpha;
  gl_FragColor = vec4(uStarColor * alpha, alpha);
}
`

interface StarsMesh {
  mesh: THREE.Points
  material: THREE.ShaderMaterial
  setHoverIndex: (index: number | null) => void
  setFocusIndex: (index: number | null) => void
  setRevealCount: (count: number) => void
  setAgeFilter: (range: { min: number; max: number } | null) => void
  setIsolateBirthday: (on: boolean) => void
  setIsolateCandle: (on: boolean) => void
  setCandle: (index: number, on: boolean) => void
  updateTime: (timeMs: number) => void
  setReducedMotion: (reduced: boolean) => void
  setPixelRatio: (dpr: number) => void
  dispose: () => void
}

export const buildStarsMesh = ({
  geometry,
  pixelRatio,
  reducedMotion,
  ages,
  appearOrder,
  birthdayFlags,
  candleFlags
}: {
  geometry: StarGeometry3D
  pixelRatio: number
  reducedMotion: boolean
  ages: Uint8Array
  appearOrder: Int32Array
  birthdayFlags: Float32Array
  candleFlags: Float32Array
}): StarsMesh => {
  const count = geometry.count
  const bufferGeom = new THREE.BufferGeometry()
  bufferGeom.setAttribute('position', new THREE.BufferAttribute(geometry.positions, 3))
  bufferGeom.setAttribute('aSize', new THREE.BufferAttribute(geometry.sizes, 1))
  bufferGeom.setAttribute('aBrightness', new THREE.BufferAttribute(geometry.brightness, 1))
  bufferGeom.setAttribute('aPhase', new THREE.BufferAttribute(geometry.phases, 1))
  bufferGeom.setAttribute('aSpeed', new THREE.BufferAttribute(geometry.speeds, 1))
  bufferGeom.setAttribute('aAmplitude', new THREE.BufferAttribute(geometry.amplitudes, 1))

  const styleFloats = new Float32Array(count)
  for (let i = 0; i < count; i += 1) styleFloats[i] = geometry.styles[i]
  bufferGeom.setAttribute('aStyle', new THREE.BufferAttribute(styleFloats, 1))

  bufferGeom.setAttribute('aAppearTime', new THREE.BufferAttribute(geometry.appearTime, 1))

  const indices = new Float32Array(count)
  for (let i = 0; i < count; i += 1) indices[i] = i
  bufferGeom.setAttribute('aIndex', new THREE.BufferAttribute(indices, 1))

  // Reveal rank — order[star] = position in the pour sequence. Lets the
  // timeline reveal the first N stars without touching the time uniform.
  const order = new Float32Array(count)
  for (let k = 0; k < count; k += 1) order[appearOrder[k]] = k
  bufferGeom.setAttribute('aOrder', new THREE.BufferAttribute(order, 1))

  const ageFloats = new Float32Array(count)
  for (let i = 0; i < count; i += 1) ageFloats[i] = ages[i]
  bufferGeom.setAttribute('aAge', new THREE.BufferAttribute(ageFloats, 1))

  bufferGeom.setAttribute('aBirthday', new THREE.BufferAttribute(birthdayFlags, 1))

  const candleAttr = new THREE.BufferAttribute(candleFlags, 1)
  candleAttr.setUsage(THREE.DynamicDrawUsage)
  bufferGeom.setAttribute('aCandle', candleAttr)

  bufferGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), Math.sqrt(3))

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    premultipliedAlpha: true,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: pixelRatio },
      uHoverIndex: { value: -1 },
      uFocusIndex: { value: -1 },
      uReducedMotion: { value: reducedMotion ? 1 : 0 },
      uRevealCount: { value: -1 },
      uAgeFilterActive: { value: 0 },
      uAgeMin: { value: 0 },
      uAgeMax: { value: 255 },
      uIsolateBirthday: { value: 0 },
      uIsolateCandle: { value: 0 },
      uStarColor: { value: new THREE.Color(0xfaf6ec) },
      uHoverColor: { value: new THREE.Color(0xffffff) },
      uFocusColor: { value: new THREE.Color(0xf7e4bf) },
      uCandleColor: { value: new THREE.Color(0xffcf8f) }
    }
  })

  const mesh = new THREE.Points(bufferGeom, material)
  mesh.frustumCulled = false

  return {
    mesh,
    material,
    setHoverIndex: (index) => {
      material.uniforms.uHoverIndex.value = index === null ? -1 : index
    },
    setFocusIndex: (index) => {
      material.uniforms.uFocusIndex.value = index === null ? -1 : index
    },
    setRevealCount: (countValue) => {
      material.uniforms.uRevealCount.value = countValue
    },
    setAgeFilter: (range) => {
      if (range === null) {
        material.uniforms.uAgeFilterActive.value = 0
        return
      }
      material.uniforms.uAgeFilterActive.value = 1
      material.uniforms.uAgeMin.value = range.min
      material.uniforms.uAgeMax.value = range.max
    },
    setIsolateBirthday: (on) => {
      material.uniforms.uIsolateBirthday.value = on ? 1 : 0
    },
    setIsolateCandle: (on) => {
      material.uniforms.uIsolateCandle.value = on ? 1 : 0
    },
    setCandle: (index, on) => {
      if (index < 0 || index >= count) return
      candleFlags[index] = on ? 1 : 0
      candleAttr.needsUpdate = true
    },
    updateTime: (timeMs) => {
      material.uniforms.uTime.value = timeMs
    },
    setReducedMotion: (reduced) => {
      material.uniforms.uReducedMotion.value = reduced ? 1 : 0
    },
    setPixelRatio: (dpr) => {
      material.uniforms.uPixelRatio.value = dpr
    },
    dispose: () => {
      bufferGeom.dispose()
      material.dispose()
    }
  }
}
