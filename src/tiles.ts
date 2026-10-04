import L from 'leaflet'

const CARTO = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
const OSM = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'

export function createBaseTiles(): L.TileLayer {
  const carto = L.tileLayer(CARTO, {
    subdomains: 'abcd',
    maxZoom: 18,
    attribution: '',
  })

  carto.on('tileerror', (e) => {
    const tile = e.tile as HTMLImageElement
    if (tile.dataset.fallback) return
    tile.dataset.fallback = 'osm'
    const src = e.coords
    const s = ['a', 'b', 'c'][Math.abs(src.x + src.y) % 3]
    tile.src = OSM.replace('{s}', s).replace('{z}', String(src.z)).replace('{x}', String(src.x)).replace('{y}', String(src.y))
  })

  return carto
}

export function resolveAssetUrl(relPath: string): string {
  const cleaned = String(relPath || '').replace(/^\.\//, '').replace(/^\//, '')
  const base = import.meta.env.BASE_URL || './'
  try {
    if (base.startsWith('http://') || base.startsWith('https://') || base.startsWith('/')) {
      return new URL(cleaned, base.endsWith('/') ? base : `${base}/`).href
    }
    return new URL(`${base}${cleaned}`, window.location.href).href
  } catch {
    return `./${cleaned}`
  }
}
