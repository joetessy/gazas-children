import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

// Generates public/og.png — the social share card — with the current toll baked
// in, so every link that gets shared carries the number. Run at build time after
// build-dataset has written snapshot.json.

const PUBLIC_DIR = join(process.cwd(), 'public')
const DATA_DIR = join(PUBLIC_DIR, 'data')

const FORMATTER = new Intl.NumberFormat('en-US')

const formatDate = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  })
}

const mulberry32 = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const starScatter = (): string => {
  const rng = mulberry32(0xca11ab1e)
  let out = ''
  for (let i = 0; i < 320; i += 1) {
    const x = (rng() * 1200).toFixed(1)
    const y = (rng() * 630).toFixed(1)
    const r = (rng() * 1.5 + 0.3).toFixed(2)
    const o = (rng() * 0.5 + 0.12).toFixed(2)
    out += `<circle cx="${x}" cy="${y}" r="${r}" fill="#faf6ec" opacity="${o}"/>`
  }
  return out
}

const renderSvg = ({ count, date }: { count: number; date: string }): string => {
  const num = FORMATTER.format(count)
  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="glow" cx="30%" cy="14%" r="85%">
        <stop offset="0%" stop-color="#463c5a" stop-opacity="0.5"/>
        <stop offset="45%" stop-color="#141020" stop-opacity="0.08"/>
        <stop offset="100%" stop-color="#050408" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="1200" height="630" fill="#050408"/>
    <rect width="1200" height="630" fill="url(#glow)"/>
    ${starScatter()}
    <text x="600" y="312" text-anchor="middle" font-family="Georgia, 'Cormorant Garamond', 'Times New Roman', serif" font-weight="300" font-size="200" letter-spacing="-6" fill="#f2eee4">${num}</text>
    <text x="600" y="392" text-anchor="middle" font-family="Georgia, 'Cormorant Garamond', serif" font-style="italic" font-weight="300" font-size="54" fill="#d6d0c3">children killed in Gaza</text>
    <text x="600" y="556" text-anchor="middle" font-family="'Helvetica Neue', Arial, sans-serif" font-size="21" letter-spacing="7" fill="#8a8377">A MEMORIAL · GAZASCHILDREN.COM</text>
    <text x="600" y="592" text-anchor="middle" font-family="'Helvetica Neue', Arial, sans-serif" font-size="17" letter-spacing="2" fill="#6b6559">Snapshot ${formatDate(date)} · one star for every name · data via Tech for Palestine</text>
  </svg>`
}

const main = async () => {
  const snapshot = JSON.parse(await readFile(join(DATA_DIR, 'snapshot.json'), 'utf8')) as {
    count: number
    date: string
  }
  const svg = renderSvg({ count: snapshot.count, date: snapshot.date })
  const resvg = new Resvg(svg, {
    background: '#050408',
    fitTo: { mode: 'width', value: 1200 },
    font: { loadSystemFonts: true }
  })
  const png = resvg.render().asPng()
  await writeFile(join(PUBLIC_DIR, 'og.png'), png)
  console.log(`-> wrote public/og.png (${png.length.toLocaleString()} bytes) — ${FORMATTER.format(snapshot.count)} children`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
