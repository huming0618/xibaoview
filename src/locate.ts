import L from 'leaflet'

export type LocateState = 'idle' | 'locating' | 'following' | 'located'

export interface LocatePosition {
  lat: number
  lng: number
  accuracy: number
}

export interface LocateController {
  getState: () => LocateState
  getLastPosition: () => LocatePosition | null
  toggle: () => Promise<void>
  stop: () => void
  destroy: () => void
}

const LOCATE_TIMEOUT_MS = 12000
const POLL_INTERVAL_MS = 2500

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
  }
): LocateController {
  let state: LocateState = 'idle'
  let watchId: number | null = null
  let marker: L.Marker | null = null
  let accuracyCircle: L.Circle | null = null
  let follow = false
  let programmaticMove = false
  let lastLatLng: L.LatLng | null = null
  let lastAccuracy = 0
  let locateTimeoutId: ReturnType<typeof setTimeout> | null = null
  let abortLocating = false
  let pollIntervalId: ReturnType<typeof setInterval> | null = null

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
  }

  function clearLocateTimeout() {
    if (locateTimeoutId !== null) {
      clearTimeout(locateTimeoutId)
      locateTimeoutId = null
    }
  }

  function updateMarker(lat: number, lng: number, accuracy: number) {
    const latlng = L.latLng(lat, lng)
    lastLatLng = latlng
    lastAccuracy = accuracy
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

  function onInitialPosition(lat: number, lng: number, accuracy: number) {
    clearLocateTimeout()
    if (abortLocating || state !== 'locating') return
    updateMarker(lat, lng, accuracy)
    follow = true
    setState('following')
    centerOnUser()
    startWatchForFollow()
    startPolling()
  }

  function onWatchPosition(lat: number, lng: number, accuracy: number) {
    updateMarker(lat, lng, accuracy)
    if (follow && state === 'following') {
      programmaticMove = true
      map.panTo(lastLatLng!, { animate: true })
      map.once('moveend', () => {
        programmaticMove = false
      })
    }
  }

  function onError(err: GeolocationPositionError | Error | null, isTimeout = false) {
    clearLocateTimeout()
    const msg = isTimeout ? '定位超时，请检查系统定位是否开启' : permissionDeniedMessage(err)
    opts.toast(msg)
    if (state === 'locating') {
      stopWatch()
      setState('idle')
    }
  }

  function getInitialPosition(): Promise<{ lat: number; lng: number; accuracy: number }> {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('geolocation unavailable'))
        return
      }
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy ?? 0,
          }),
        (err) => reject(err),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 0 }
      )
    })
  }

  function startWatchForFollow() {
    if (watchId !== null || !('geolocation' in navigator)) return
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        onWatchPosition(
          position.coords.latitude,
          position.coords.longitude,
          position.coords.accuracy ?? 0
        )
      },
      (err) => console.warn('[Locate] Watch error:', err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
    )
  }

  function stopPolling() {
    if (pollIntervalId !== null) {
      clearInterval(pollIntervalId)
      pollIntervalId = null
    }
  }

  function doPollTick() {
    if (lastLatLng) emitPosition()
    if (state !== 'following' && state !== 'located') return
    if (!('geolocation' in navigator)) return
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onWatchPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy ?? 0)
      },
      (err) => {
        console.warn('[Locate] Poll GPS error:', err)
        if (lastLatLng) emitPosition()
      },
      { enableHighAccuracy: true, timeout: 2000, maximumAge: 0 }
    )
  }

  function startPolling() {
    if (pollIntervalId !== null) return
    doPollTick()
    pollIntervalId = setInterval(doPollTick, POLL_INTERVAL_MS)
  }

  async function startLocate() {
    abortLocating = false
    setState('locating')

    if (!('geolocation' in navigator)) {
      opts.toast('定位服务不可用')
      setState('idle')
      return
    }

    if (abortLocating) {
      setState('idle')
      return
    }

    locateTimeoutId = setTimeout(() => {
      if (state === 'locating') onError(null, true)
    }, LOCATE_TIMEOUT_MS)

    try {
      const pos = await getInitialPosition()
      if (pos && !abortLocating) onInitialPosition(pos.lat, pos.lng, pos.accuracy)
    } catch (e) {
      if (!abortLocating) onError(e instanceof Error ? e : null)
    }
  }

  function stopWatch() {
    clearLocateTimeout()
    stopPolling()
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId)
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
    emitPosition()
  }

  function cancelLocate() {
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
      if (watchId === null) startWatchForFollow()
    } catch {
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
      lastLatLng ? { lat: lastLatLng.lat, lng: lastLatLng.lng, accuracy: lastAccuracy } : null,
    toggle,
    stop,
    destroy: () => {
      map.off('dragstart', onUserMove)
      stop()
    },
  }
}
