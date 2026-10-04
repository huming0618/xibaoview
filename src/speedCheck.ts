/** Trip speed from the existing GPS locate stream. One sample every 3 minutes. */

export const SPEED_CHECK_INTERVAL_MS = 3 * 60 * 1000

export interface SpeedReading {
  kmh: number
  at: number
}

let active = false
let latestSpeedMps: number | null = null
let reading: SpeedReading | null = null
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

export function parseGpsSpeedMps(speed: number | null | undefined): number | null {
  if (speed == null || !Number.isFinite(speed) || speed < 0) return null
  return speed
}

export function snapshotSpeed(speedMps: number | null, at: number): SpeedReading | null {
  if (speedMps == null) return null
  return { kmh: speedMps * 3.6, at }
}

export function formatSpeedStatus(current: SpeedReading | null, locateOn: boolean): string {
  if (!locateOn) return ''
  if (!current) return '时速尚未测得'
  const kmh = current.kmh < 10 ? current.kmh.toFixed(1) : String(Math.round(current.kmh))
  const d = new Date(current.at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `时速 ${kmh} km/h · ${hh}:${mm}:${ss}`
}

export function noteLocateSpeed(speedMps: number | null | undefined) {
  latestSpeedMps = parseGpsSpeedMps(speedMps)
  if (active && reading === null && latestSpeedMps != null) {
    takeReading()
  }
}

function takeReading() {
  const next = snapshotSpeed(latestSpeedMps, Date.now())
  if (next) reading = next
  notify()
}

export function startSpeedCheck() {
  if (timer !== null) return
  active = true
  takeReading()
  timer = setInterval(takeReading, SPEED_CHECK_INTERVAL_MS)
}

export function stopSpeedCheck() {
  active = false
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  latestSpeedMps = null
  reading = null
  notify()
}

export function getSpeedReading(): SpeedReading | null {
  return reading
}

export function subscribeSpeedCheck(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
