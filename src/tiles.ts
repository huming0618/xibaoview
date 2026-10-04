import L from 'leaflet'
import {
  createCachedTileLayer,
  resolveAssetUrl,
} from './tileCache.ts'

export { resolveAssetUrl }
export {
  createCachedTileLayer,
  syncOfflineZoomLimits,
  warmCacheFromBundled,
  isOnline,
  SEEDED_MIN_ZOOM,
  SEEDED_MAX_ZOOM,
} from './tileCache.ts'

export function createBaseTiles(): L.TileLayer {
  return createCachedTileLayer(L, { maxZoom: 18 })
}
