import './style.css'
import { loadDataBundle } from './data/loader.ts'
import { mountStarfield } from './starfield/Starfield.ts'
import { mountStarfield3D } from './starfield/3d/Starfield3D.ts'

const app = document.getElementById('app')
if (!app) throw new Error('No #app mount point')

let teardown: (() => void) | null = null

const renderLoading = () => {
  app.innerHTML = `<div class="loading">loading the names…</div>`
}

const renderError = ({ err }: { err: unknown }) => {
  const msg = err instanceof Error ? err.message : 'Unknown error'
  app.innerHTML = `
    <div class="loading">The memorial data could not be loaded.<br/><span class="mono" style="font-size: 0.75rem;">${msg}</span></div>
  `
}

const supportsWebGL2 = (): boolean => {
  try {
    const canvas = document.createElement('canvas')
    return !!canvas.getContext('webgl2')
  } catch {
    return false
  }
}

const boot = async () => {
  renderLoading()
  try {
    const { dataset, snapshot } = await loadDataBundle()
    if (teardown) teardown()
    app.innerHTML = ''

    if (supportsWebGL2()) {
      const sf = mountStarfield3D({ container: app, dataset, snapshot })
      teardown = sf.destroy
    } else {
      const sf = mountStarfield({ container: app, dataset, snapshot })
      teardown = sf.destroy
    }
  } catch (err) {
    renderError({ err })
  }
}

void boot()
