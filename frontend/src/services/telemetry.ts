/**
 * IP and Session Telemetry service.
 * Dispatches visit and event details to /api/log-ip, which uploads
 * the full IP & metadata payload directly to the Supabase Storage bucket.
 */

let hasLoggedVisit = false

export async function logClientSession(action: string = 'visit', details: Record<string, unknown> = {}) {
  try {
    const payload = {
      action,
      client_timestamp: new Date().toISOString(),
      referrer: typeof document !== 'undefined' ? document.referrer : '',
      screen_resolution: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : '',
      language: typeof navigator !== 'undefined' ? navigator.language : '',
      display_name: typeof localStorage !== 'undefined' ? localStorage.getItem('hcl_display_name') : null,
      player_id: typeof localStorage !== 'undefined' ? localStorage.getItem('hcl_player_id') : null,
      ...details,
    }

    // Call /api/log-ip (works on both local Flask backend & Vercel deployment)
    const backendUrl = import.meta.env.VITE_BACKEND_URL || ''
    const endpoint = backendUrl ? `${backendUrl}/api/log-ip` : '/api/log-ip'

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {
      // Non-blocking, fails gracefully if offline or not configured
    })
  } catch {
    // Fail silently so it never interrupts the gameplay experience
  }
}

export function logAppVisitOnce() {
  if (hasLoggedVisit) return
  hasLoggedVisit = true
  logClientSession('app_visit')
}
