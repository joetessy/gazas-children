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

uniform float uTime;
uniform float uPixelRatio;
uniform float uHoverIndex;
uniform float uReducedMotion;
uniform float uIntroProgress;

varying float vAlpha;
varying float vHover;
varying float vAppearReveal;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);

  // Per-star reveal: fade in over ~600ms from appearTime
  float dt = (uTime - aAppearTime) / 600.0;
  float reveal = clamp(dt, 0.0, 1.0);
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

  vAlpha = clamp(aBrightness + tw, 0.12, 1.0) * reveal;

  float hover = (abs(aIndex - uHoverIndex) < 0.5) ? 1.0 : 0.0;
  vHover = hover;

  // Perspective-correct point size with iOS-safe cap.
  // Hovered stars get a much larger sprite so the glow ring (in the frag)
  // has room to render outside the pinpoint core — and a bigger size cap.
  float sizeMul = 1.0 + hover * 4.0;
  float ps = aSize * uPixelRatio * sizeMul * (6.5 / max(0.6, -mv.z));
  if (hover > 0.5) ps = max(ps, 22.0 * uPixelRatio);
  float capPx = (hover > 0.5) ? 64.0 : 20.0;
  gl_PointSize = clamp(ps, 1.0, capPx);

  gl_Position = projectionMatrix * mv;
}
`

const FRAG = /* glsl */ `
precision mediump float;

uniform vec3 uStarColor;
uniform vec3 uHoverColor;

varying float vAlpha;
varying float vHover;
varying float vAppearReveal;

void main() {
  if (vAppearReveal <= 0.0) discard;

  vec2 uv = gl_PointCoord - 0.5;
  float dist = length(uv);
  if (dist > 0.5) discard;

  // Regular stars: crisp pinpoint, no halo
  float core = smoothstep(0.5, 0.18, dist);

  if (vHover > 0.5) {
    // Hovered star: bright pinpoint with a soft continuous glow around it.
    // No hollow ring — the brightness falls off smoothly from the centre.
    float pinpoint = smoothstep(0.22, 0.0, dist);                  // bright core
    float glow     = smoothstep(0.5, 0.0, dist);                   // soft Gaussian-ish falloff
    float intensity = clamp(pinpoint + glow * 0.55, 0.0, 1.0);
    float alpha = intensity * vAlpha;
    gl_FragColor = vec4(uHoverColor * alpha, alpha);
    return;
  }

  vec3 color = uStarColor;
  float alpha = core * vAlpha;
  gl_FragColor = vec4(color * alpha, alpha);
}
`

interface StarsMesh {
  mesh: THREE.Points
  material: THREE.ShaderMaterial
  setHoverIndex: (index: number | null) => void
  updateTime: (timeMs: number) => void
  setReducedMotion: (reduced: boolean) => void
  setIntroProgress: (progress: number) => void
  setPixelRatio: (dpr: number) => void
  dispose: () => void
}

export const buildStarsMesh = ({
  geometry,
  pixelRatio,
  reducedMotion
}: {
  geometry: StarGeometry3D
  pixelRatio: number
  reducedMotion: boolean
}): StarsMesh => {
  const bufferGeom = new THREE.BufferGeometry()
  bufferGeom.setAttribute('position', new THREE.BufferAttribute(geometry.positions, 3))
  bufferGeom.setAttribute('aSize', new THREE.BufferAttribute(geometry.sizes, 1))
  bufferGeom.setAttribute('aBrightness', new THREE.BufferAttribute(geometry.brightness, 1))
  bufferGeom.setAttribute('aPhase', new THREE.BufferAttribute(geometry.phases, 1))
  bufferGeom.setAttribute('aSpeed', new THREE.BufferAttribute(geometry.speeds, 1))
  bufferGeom.setAttribute('aAmplitude', new THREE.BufferAttribute(geometry.amplitudes, 1))

  const styleFloats = new Float32Array(geometry.count)
  for (let i = 0; i < geometry.count; i += 1) styleFloats[i] = geometry.styles[i]
  bufferGeom.setAttribute('aStyle', new THREE.BufferAttribute(styleFloats, 1))

  bufferGeom.setAttribute('aAppearTime', new THREE.BufferAttribute(geometry.appearTime, 1))

  const indices = new Float32Array(geometry.count)
  for (let i = 0; i < geometry.count; i += 1) indices[i] = i
  bufferGeom.setAttribute('aIndex', new THREE.BufferAttribute(indices, 1))

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
      uReducedMotion: { value: reducedMotion ? 1 : 0 },
      uIntroProgress: { value: 0 },
      uStarColor: { value: new THREE.Color(0xfaf6ec) },
      uHoverColor: { value: new THREE.Color(0xffffff) }
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
    updateTime: (timeMs) => {
      material.uniforms.uTime.value = timeMs
    },
    setReducedMotion: (reduced) => {
      material.uniforms.uReducedMotion.value = reduced ? 1 : 0
    },
    setIntroProgress: (progress) => {
      material.uniforms.uIntroProgress.value = progress
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
