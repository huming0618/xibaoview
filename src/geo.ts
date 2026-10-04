/** Geometry: project GPS onto the 西宝客专 polyline. Chainage km from 宝鸡南 = 0. */

export interface LatLng {
  lat: number
  lon: number
}

export interface Station extends LatLng {
  name: string
  order: number
  formerName?: string
}

export interface CorridorStation extends Station {
  /** Cumulative km along the railway polyline (宝鸡南 = 0). */
  km: number
}

export interface SpinePoint extends LatLng {
  km: number
}

export interface LineProjection {
  lat: number
  lon: number
  distM: number
  kmAlong: number
  prev: CorridorStation
  next: CorridorStation
  t: number
  atStation: CorridorStation | null
}

const EARTH_R = 6371000

export function haversineM(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)))
}

function toXY(p: LatLng, lat0: number): { x: number; y: number } {
  const toRad = (d: number) => (d * Math.PI) / 180
  const cos = Math.cos(toRad(lat0))
  return {
    x: toRad(p.lon) * EARTH_R * cos,
    y: toRad(p.lat) * EARTH_R,
  }
}

function fromXY(xy: { x: number; y: number }, lat0: number): LatLng {
  const toDeg = (r: number) => (r * 180) / Math.PI
  const cos = Math.cos((lat0 * Math.PI) / 180)
  return {
    lat: toDeg(xy.y / EARTH_R),
    lon: toDeg(xy.x / (EARTH_R * cos)),
  }
}

export interface SegHit {
  lat: number
  lon: number
  distM: number
  t: number
  segIndex: number
}

export function nearestOnSegment(p: LatLng, a: LatLng, b: LatLng): Omit<SegHit, 'segIndex'> {
  const lat0 = (a.lat + b.lat + p.lat) / 3
  const P = toXY(p, lat0)
  const A = toXY(a, lat0)
  const B = toXY(b, lat0)
  const dx = B.x - A.x
  const dy = B.y - A.y
  const len2 = dx * dx + dy * dy
  let t = 0
  if (len2 > 1e-6) {
    t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2
    t = Math.max(0, Math.min(1, t))
  }
  const Q = { x: A.x + t * dx, y: A.y + t * dy }
  const q = fromXY(Q, lat0)
  const distM = Math.hypot(P.x - Q.x, P.y - Q.y)
  return { lat: q.lat, lon: q.lon, distM, t }
}

export function flattenLineCoords(multi: [number, number][][]): { a: LatLng; b: LatLng }[] {
  const segs: { a: LatLng; b: LatLng }[] = []
  for (const part of multi) {
    for (let i = 0; i < part.length - 1; i++) {
      const [lon1, lat1] = part[i]
      const [lon2, lat2] = part[i + 1]
      segs.push({
        a: { lat: lat1, lon: lon1 },
        b: { lat: lat2, lon: lon2 },
      })
    }
  }
  return segs
}

export function buildSpine(coords: [number, number][]): SpinePoint[] {
  const out: SpinePoint[] = []
  let km = 0
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i]
    if (i > 0) {
      km += haversineM({ lat: coords[i - 1][1], lon: coords[i - 1][0] }, { lat, lon }) / 1000
    }
    out.push({ lat, lon, km })
  }
  return out
}

export function nearestOnSpine(p: LatLng, spine: SpinePoint[]): SegHit {
  let best: SegHit | null = null
  for (let i = 0; i < spine.length - 1; i++) {
    const hit = nearestOnSegment(p, spine[i], spine[i + 1])
    if (!best || hit.distM < best.distM) {
      best = { ...hit, segIndex: i }
    }
  }
  return best ?? { lat: p.lat, lon: p.lon, distM: Infinity, t: 0, segIndex: 0 }
}

export function kmAlongSpine(p: LatLng, spine: SpinePoint[]): { km: number; hit: SegHit } {
  const hit = nearestOnSpine(p, spine)
  const a = spine[hit.segIndex]
  const b = spine[Math.min(hit.segIndex + 1, spine.length - 1)]
  const km = a.km + hit.t * (b.km - a.km)
  return { km, hit }
}

/** Project each station onto the railway polyline to get chainage. */
export function buildCorridor(stations: Station[], spine: SpinePoint[]): CorridorStation[] {
  const sorted = [...stations].sort((a, b) => a.order - b.order)
  return sorted.map((s) => {
    const { km } = kmAlongSpine(s, spine)
    return { ...s, km }
  })
}

export const AT_STATION_M = 400

/**
 * Project GPS onto the railway polyline. kmAlong is polyline chainage
 * (same numbers as the station scale). Stations are chosen by that km.
 */
export function projectOntoCorridor(
  gps: LatLng,
  corridor: CorridorStation[],
  spine: SpinePoint[]
): LineProjection | null {
  if (corridor.length < 2 || spine.length < 2) return null

  const { km, hit } = kmAlongSpine(gps, spine)

  let nearestSt = corridor[0]
  let nearestD = haversineM(gps, nearestSt)
  for (const s of corridor) {
    const d = haversineM(gps, s)
    if (d < nearestD) {
      nearestD = d
      nearestSt = s
    }
  }

  let bestIdx = 0
  for (let i = 0; i < corridor.length - 1; i++) {
    if (km >= corridor[i].km) bestIdx = i
  }
  const prev = corridor[bestIdx]
  const next = corridor[Math.min(bestIdx + 1, corridor.length - 1)]
  const segKm = Math.max(next.km - prev.km, 1e-6)
  const t = Math.max(0, Math.min(1, (km - prev.km) / segKm))

  return {
    lat: hit.lat,
    lon: hit.lon,
    distM: hit.distM,
    kmAlong: km,
    prev,
    next,
    t,
    atStation: nearestD <= AT_STATION_M ? nearestSt : null,
  }
}
