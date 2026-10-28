/**
 * Session & Browser Cache Cleaner for HandCricket Live.
 * 
 * Enforces strict TTL (1 hour = 3600000ms):
 * - Erases residual tokens (hcl_session, hcl_player_id, hcl_display_name, hcl_room_id, etc.)
 * - Clears sessionStorage
 * - Closes stale WebSocket connections
 * - Prevents residual activity after 1 hour of inactivity
 */

import { disconnectSocket } from '../services/socket'

export const SESSION_MAX_AGE_MS = 60 * 60 * 1000 // 1 hour (3600 seconds)
export const LAST_ACTIVE_KEY = 'hcl_last_active_time'

const RESIDUAL_STORAGE_KEYS = [
  'hcl_session',
  'hcl_player_id',
  'hcl_display_name',
  'hcl_room_id',
  'hcl_room_code',
  'hcl_feedback_submitted',
]

/**
 * Updates the last recorded activity timestamp to right now.
 */
export function recordActivity(): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()))
  } catch {
    // Ignore quota or private browsing errors
  }
}

/**
 * Checks whether the stored session has been inactive for longer than 1 hour.
 */
export function isSessionExpired(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = localStorage.getItem(LAST_ACTIVE_KEY)
    if (!raw) {
      // If there's an existing session token without an activity timestamp, treat as expired
      const hasSession = Boolean(localStorage.getItem('hcl_session'))
      return hasSession
    }
    const lastActive = parseInt(raw, 10)
    if (isNaN(lastActive)) return true
    return Date.now() - lastActive > SESSION_MAX_AGE_MS
  } catch {
    return false
  }
}

/**
 * Purges all residual tokens, caches, and connections if session is expired.
 * Returns true if an expired session was cleaned up.
 */
export function cleanSessionIfExpired(): boolean {
  if (typeof window === 'undefined') return false

  if (isSessionExpired()) {
    try {
      console.info('[SessionCleaner] Inactive for > 1 hour. Purging residual activity and browser session cache.')
      disconnectSocket()

      for (const key of RESIDUAL_STORAGE_KEYS) {
        localStorage.removeItem(key)
      }
      // Also clear player-specific feedback flags
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i)
        if (key && (key.startsWith('hcl_feedback_') || key.startsWith('hcl_temp_'))) {
          localStorage.removeItem(key)
        }
      }

      sessionStorage.clear()
      localStorage.removeItem(LAST_ACTIVE_KEY)
      return true
    } catch (e) {
      console.warn('[SessionCleaner] Error clearing residual storage:', e)
      return false
    }
  }

  // Session still valid: refresh activity timestamp
  recordActivity()
  return false
}

/**
 * Initializes the global session cleaner with throttled user event listeners
 * and an interval timer to detect idle timeout while the page remains open.
 */
export function initSessionCleaner(): void {
  if (typeof window === 'undefined') return

  // 1. Check and clean immediately on initialization
  cleanSessionIfExpired()

  // 2. Throttled activity listener (records at most once every 10 seconds)
  let lastRecorded = 0
  const onUserActivity = () => {
    const now = Date.now()
    if (now - lastRecorded > 10000) {
      lastRecorded = now
      recordActivity()
    }
  }

  const events = ['mousedown', 'keydown', 'touchstart', 'scroll', 'pointerdown']
  for (const ev of events) {
    window.addEventListener(ev, onUserActivity, { passive: true })
  }

  // 3. Periodic idle check every 60 seconds
  const intervalId = window.setInterval(() => {
    if (cleanSessionIfExpired()) {
      // If expired while sitting open on an active page, reload or route to landing
      if (window.location.pathname !== '/' && !window.location.pathname.startsWith('/join/')) {
        window.location.href = '/'
      }
    }
  }, 60000)

  // 4. Tab visibility change check (in case user returns to tab after hours)
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      if (cleanSessionIfExpired()) {
        if (window.location.pathname !== '/' && !window.location.pathname.startsWith('/join/')) {
          window.location.href = '/'
        }
      }
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  // Clean up if window unloads
  window.addEventListener('beforeunload', () => {
    clearInterval(intervalId)
  })
}
