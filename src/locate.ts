import L from 'leaflet'
import { Capacitor } from '@capacitor/core'
import { Geolocation, type PermissionStatus } from '@capacitor/geolocation'

export type LocateState = 'idle' | 'locating' | 'following' | 'located'

export interface LocatePosition {
  lat: number
  lng: number
  accuracy: number
  /** GPS coords.speed in m/s, or null if the fix has no speed yet. */
  speedMps: number | null
}

export interface LocateController {
  getState: () => LocateState
  getLastPosition: () => LocatePosition | null
  toggle: () => Promise<void>
  stop: () => void
  destroy: () => void
}

export const LOCATE_TIMEOUT_MS = 12000

class LocateTimeoutError extends Error {
  constructor() {
    super('locate-timeout')
    this.name = 'LocateTimeoutError'
  }
}

function sleepReject(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new LocateTimeoutError()), ms)
  })
}

function isPermissionGranted(status: PermissionStatus): boolean {
  return status.location === 'granted' || status.coarseLocation === 'granted'
}

async function ensurePermission(): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      let status = await Geolocation.checkPermissions()
      if (!isPermissionGranted(status)) {
        status = await Geolocation.requestPermissions()
      }
      return isPermissionGranted(status)
    }
    if (!('geolocation' in navigator)) return false
    return true
  } catch (e) {
    console.error('[Locate] Permission check/request failed:', e)
    throw e
  }
}

function permissionDeniedMessage(err?: GeolocationPositionError | Error | null): string {
  if (err && 'code' in err && err.code === 1) return '请允许位置权限后重试'
  if (err && err.message && /denied|permission/i.test(err.message)) return '请允许位置权限后重试'
  if (err && 'code' in err && err.code === 2) return '定位服务不可用'
  if (err && 'code' in err && err.code === 3) return '定位超时'
  return '无法获取位置'
}

export function createLocateControl(
  map: L.Map,
  opts: {
    button: HTMLButtonElement
    label: HTMLElement
    toast: (msg: string) => void
    onPosition?: (pos: LocatePosition | null) => void
    onState?: (state: LocateState) => void
  }
): LocateController {
  let state: LocateState = 'idle'
  let watchId: string | number | null = null
  let marker: L.Marker | null = null
  let accuracyCircle: L.Circle | null = null
  let follow = false
  let programmaticMove = false
  let lastLatLng: L.LatLng | null = null
  let lastAccuracy = 0
  let lastSpeedMps: number | null = null
  let locateTimeoutId: ReturnType<typeof setTimeout> | null = null
  let abortLocating = false
  let pollIntervalId: ReturnType<typeof setInterval> | null = null
  const POLL_INTERVAL_MS = 2500

  const userIcon = L.divIcon({
    className: 'user-location-marker',
    html: '<div class="user-location-dot"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })

  function emitPosition() {
    if (!opts.onPosition) return
    if (!lastLatLng) {
      opts.onPosition(null)
      return
    }
    opts.onPosition({
      lat: lastLatLng.lat,
      lng: lastLatLng.lng,
      accuracy: lastAccuracy,
      speedMps: lastSpeedMps,
    })
  }

  function setState(next: LocateState) {
    state = next
    opts.button.classList.toggle('active', next === 'following')
    opts.button.classList.toggle('located', next === 'located' || next === 'following')
    opts.button.setAttribute('aria-pressed', next === 'following' ? 'true' : 'false')
    if (next === 'idle') {
      opts.label.textContent = '定位'
      opts.button.title = '定位 / 跟随我'
    } else if (next === 'locating') {
      opts.label.textContent = '定位中'
      opts.button.title = '点击取消定位'
    } else if (next === 'following') {
      opts.label.textContent = '跟随中'
      opts.button.title = '点击停止跟随'
    } else {
      opts.label.textContent = '跟随我'
      opts.button.title = '点击跟随我的位置'
    }
    opts.onState?.(next)
  }

  function clearLocateTimeout() {
    if (locateTimeoutId !== null) {
      clearTimeout(locateTimeoutId)
      locateTimeoutId = null
    }
  }

  function parseSpeedMps(speed: number | null | undefined): number | null {
    if (speed == null || !Number.isFinite(speed) || speed < 0) return null
    return speed
  }

  function updateMarker(lat: number, lng: number, accuracy: number, speed?: number | null) {
    const latlng = L.latLng(lat, lng)
    lastLatLng = latlng
    lastAccuracy = accuracy
    lastSpeedMps = parseSpeedMps(speed)
    if (!marker) {
      marker = L.marker(latlng, { icon: userIcon, zIndexOffset: 1000, interactive: false }).addTo(map)
    } else {
      marker.setLatLng(latlng)
    }
    if (!accuracyCircle) {
      accuracyCircle = L.circle(latlng, {
        radius: Math.max(accuracy || 0, 8),
        color: '#2A93EE',
        weight: 1,
        opacity: 0.6,
        fillColor: '#2A93EE',
        fillOpacity: 0.15,
        interactive: false,
      }).addTo(map)
    } else {
      accuracyCircle.setLatLng(latlng)
      accuracyCircle.setRadius(Math.max(accuracy || 0, 8))
    }
    emitPosition()
  }

  function centerOnUser(zoom?: number) {
    if (!lastLatLng) return
    programmaticMove = true
    const z = zoom ?? Math.max(map.getZoom(), Math.min(14, map.getMaxZoom()))
    map.setView(lastLatLng, z, { animate: true })
    map.once('moveend', () => {
      programmaticMove = false
    })
  }

  function onInitialPosition(lat: number, lng: number, accuracy: number, speed?: number | null) {
    clearLocateTimeout()
    if (abortLocating || state !== 'locating') {
      console.log('[Locate] Position received but locate was cancelled')
      return
    }
    updateMarker(lat, lng, accuracy, speed)
    follow = true
    setState('following')
    centerOnUser()
    startWatchForFollow()
    startPolling()
  }

  function onWatchPosition(lat: number, lng: number, accuracy: number, speed?: number | null) {
    updateMarker(lat, lng, accuracy, speed)
    
    if (follow && state === 'following') {
      programmaticMove = true
      map.panTo(lastLatLng!, { animate: true })
      map.once('moveend', () => {
        programmaticMove = false
      })
    }
  }

  function onError(err: GeolocationPositionError | Error | null, isTimeout = false) {
    const timedOut = isTimeout || (err instanceof LocateTimeoutError)
    clearLocateTimeout()
    const msg = timedOut ? '定位超时，请检查系统定位是否开启' : permissionDeniedMessage(err)
    opts.toast(msg)
    if (state === 'locating') {
      stopWatch()
      setState('idle')
    }
  }

  function readCoords(pos: { coords: GeolocationCoordinates } | { coords: { latitude: number; longitude: number; accuracy?: number | null; speed?: number | null } }) {
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy ?? 0,
      speedMps: parseSpeedMps(pos.coords.speed),
    }
  }

  /**
   * One getCurrentPosition, raced against a client timer.
   * Capacitor Android often ignores the plugin `timeout` and never calls back
   * from watchPosition; do not chain a second getCurrentPosition that can hang.
   */
  async function getInitialPosition(timeoutMs: number): Promise<{
    lat: number
    lng: number
    accuracy: number
    speedMps: number | null
  } | null> {
    const budget = Math.max(400, timeoutMs)
    if (Capacitor.isNativePlatform()) {
      const pos = await Promise.race([
        Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: budget,
          maximumAge: 0,
        }),
        sleepReject(budget),
      ])
      return readCoords(pos)
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new LocateTimeoutError()), budget)
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(t)
          resolve(readCoords(pos))
        },
        (err) => {
          clearTimeout(t)
          reject(err)
        },
        { enableHighAccuracy: true, timeout: budget, maximumAge: 0 }
      )
    })
  }

  function startWatchForFollow() {
    if (watchId !== null) return
    
    console.log('[Locate] Starting watch for continuous updates')
    try {
      if (Capacitor.isNativePlatform()) {
        Geolocation.watchPosition(
          { enableHighAccuracy: true, timeout: 30000, maximumAge: 0, minimumUpdateInterval: 1000 },
          (position, err) => {
            if (err || !position) {
              console.warn('[Locate] Watch error:', err)
              return
            }
            console.log('[Locate] Watch update:', position.coords.latitude, position.coords.longitude)
            onWatchPosition(
              position.coords.latitude,
              position.coords.longitude,
              position.coords.accuracy ?? 0,
              position.coords.speed
            )
          }
        ).then((id) => {
          watchId = id
          console.log('[Locate] Watch started with id:', id)
        }).catch((e) => {
          console.warn('[Locate] Failed to start watch:', e)
        })
      } else {
        watchId = navigator.geolocation.watchPosition(
          (position) => {
            console.log('[Locate] Watch update:', position.coords.latitude, position.coords.longitude)
            onWatchPosition(
              position.coords.latitude,
              position.coords.longitude,
              position.coords.accuracy ?? 0,
              position.coords.speed
            )
          },
          (err) => console.warn('[Locate] Watch error:', err),
          { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
        )
        console.log('[Locate] Browser watch started with id:', watchId)
      }
    } catch (e) {
      console.warn('[Locate] startWatchForFollow failed:', e)
    }
  }

  function stopPolling() {
    if (pollIntervalId !== null) {
      clearInterval(pollIntervalId)
      pollIntervalId = null
      console.log('[Locate] Polling stopped')
    }
  }

  function doPollTick() {
    console.log('[Locate] Poll tick, state:', state)
    
    if (lastLatLng) {
      emitPosition()
    }
    
    if (state !== 'following' && state !== 'located') {
      console.log('[Locate] Poll: not in active state, skipping GPS fetch')
      return
    }
    
    if (Capacitor.isNativePlatform()) {
      Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 2000,
        maximumAge: 0,
      }).then((pos) => {
        console.log('[Locate] Poll GPS:', pos.coords.latitude.toFixed(5), pos.coords.longitude.toFixed(5))
        onWatchPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? 0, pos.coords.speed)
      }).catch((e) => {
        console.warn('[Locate] Poll GPS error:', e)
        if (lastLatLng) emitPosition()
      })
    } else {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          console.log('[Locate] Poll GPS:', pos.coords.latitude.toFixed(5), pos.coords.longitude.toFixed(5))
          onWatchPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? 0, pos.coords.speed)
        },
        (err) => {
          console.warn('[Locate] Poll GPS error:', err)
          if (lastLatLng) emitPosition()
        },
        { enableHighAccuracy: true, timeout: 2000, maximumAge: 0 }
      )
    }
  }

  function startPolling() {
    if (pollIntervalId !== null) {
      console.log('[Locate] Polling already running')
      return
    }
    console.log('[Locate] Starting position polling every', POLL_INTERVAL_MS, 'ms')
    doPollTick()
    pollIntervalId = setInterval(doPollTick, POLL_INTERVAL_MS)
  }

  async function startLocate() {
    abortLocating = false
    setState('locating')
    
    let ok = false
    try {
      ok = await ensurePermission()
    } catch (e) {
      console.error('[Locate] ensurePermission failed:', e)
      opts.toast('定位权限检查失败')
      setState('idle')
      return
    }
    
    if (!ok) {
      opts.toast('请允许位置权限后重试')
      setState('idle')
      return
    }

    if (abortLocating) {
      console.log('[Locate] Locate aborted after permission check')
      setState('idle')
      return
    }

    const startedAt = Date.now()
    locateTimeoutId = setTimeout(() => {
      if (state === 'locating') {
        console.warn('[Locate] Client-side timeout reached')
        onError(null, true)
      }
    }, LOCATE_TIMEOUT_MS)

    try {
      const remaining = Math.max(400, LOCATE_TIMEOUT_MS - (Date.now() - startedAt))
      const pos = await getInitialPosition(remaining)
      if (pos && !abortLocating && state === 'locating') {
        onInitialPosition(pos.lat, pos.lng, pos.accuracy, pos.speedMps)
      }
    } catch (e) {
      if (!abortLocating && state === 'locating') {
        console.error('[Locate] getInitialPosition failed:', e)
        onError(e instanceof Error ? e : null)
      }
    }
  }

  function stopWatch() {
    clearLocateTimeout()
    stopPolling()
    if (watchId != null) {
      if (Capacitor.isNativePlatform() && typeof watchId === 'string') {
        Geolocation.clearWatch({ id: watchId }).catch(() => {})
      } else if (typeof watchId === 'number') {
        navigator.geolocation.clearWatch(watchId)
      }
      watchId = null
    }
    follow = false
  }

  function clearMarkers() {
    if (marker) {
      map.removeLayer(marker)
      marker = null
    }
    if (accuracyCircle) {
      map.removeLayer(accuracyCircle)
      accuracyCircle = null
    }
    lastLatLng = null
    lastAccuracy = 0
    lastSpeedMps = null
    emitPosition()
  }

  function cancelLocate() {
    console.log('[Locate] User cancelled locating')
    abortLocating = true
    clearLocateTimeout()
    stopWatch()
    setState('idle')
    opts.toast('已取消定位')
  }

  function stop() {
    abortLocating = true
    stopWatch()
    clearMarkers()
    setState('idle')
  }

  async function toggle() {
    try {
      if (state === 'idle') {
        await startLocate()
        return
      }
      if (state === 'locating') {
        cancelLocate()
        return
      }
      if (state === 'following') {
        follow = false
        setState('located')
        return
      }
      follow = true
      setState('following')
      centerOnUser()
      if (watchId === null) {
        startWatchForFollow()
      }
    } catch (e) {
      console.error('[Locate] toggle error:', e)
      opts.toast('定位功能出错')
      setState('idle')
    }
  }

  const onUserMove = () => {
    if (programmaticMove) return
    if (follow && state === 'following') {
      follow = false
      setState('located')
    }
  }
  map.on('dragstart', onUserMove)

  setState('idle')

  return {
    getState: () => state,
    getLastPosition: () =>
      lastLatLng
        ? { lat: lastLatLng.lat, lng: lastLatLng.lng, accuracy: lastAccuracy, speedMps: lastSpeedMps }
        : null,
    toggle,
    stop,
    destroy: () => {
      map.off('dragstart', onUserMove)
      stop()
    },
  }
}
