/**
 * Socket.IO client service.
 * All game events are routed through this singleton.
 */

import { io, Socket } from 'socket.io-client'

const rawBackend = import.meta.env.VITE_BACKEND_URL || ''
const BACKEND_URL = rawBackend.trim().replace(/\/+$/, '')

let socket: Socket | null = null
let lifecycleWake: (() => void) | null = null

function getStoredToken(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('hcl_session') || sessionStorage.getItem('hcl_session_token') || ''
}

/**
 * Tear the manager down and open a brand-new engine. Closing only the engine
 * leaves the manager in its reconnecting state, so a half-open socket can stay
 * "connected" indefinitely without ever receiving a packet. disconnect() also
 * cancels any pending backoff timer, so the new handshake starts immediately.
 */
function hardRestart(s: Socket): void {
  s.disconnect()
  s.connect()
}

/**
 * Mobile browsers freeze timers and can leave a socket "connected" long after
 * the server dropped it. When the page comes back, reopen the transport
 * immediately instead of waiting for the next throttled reconnect attempt.
 */
function bindLifecycleWake(s: Socket): void {
  if (typeof window === 'undefined') return
  unbindLifecycleWake()

  const wake = () => {
    if (document.visibilityState === 'hidden') return
    if (navigator.onLine === false) return
    if (!s.connected) hardRestart(s)
  }

  lifecycleWake = wake
  window.addEventListener('online', wake)
  window.addEventListener('pageshow', wake)
  document.addEventListener('visibilitychange', wake)
}

function unbindLifecycleWake(): void {
  if (!lifecycleWake || typeof window === 'undefined') return
  window.removeEventListener('online', lifecycleWake)
  window.removeEventListener('pageshow', lifecycleWake)
  document.removeEventListener('visibilitychange', lifecycleWake)
  lifecycleWake = null
}

export function getSocket(sessionToken?: string): Socket {
  const token = sessionToken || getStoredToken()
  if (!socket) {
    socket = io(BACKEND_URL, {
      autoConnect: false,
      reconnection: true,
      // A cold backend (e.g. a sleeping free instance) must never exhaust the
      // retry budget, otherwise the app stays offline until a manual reload.
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 8000,
      randomizationFactor: 0.5,
      timeout: 20000,
      // If long-polling is blocked by a proxy, still try WebSocket (and vice versa).
      tryAllTransports: true,
      auth: token ? { token } : undefined,
      query: token ? { token } : undefined,
    })
    bindLifecycleWake(socket)
  } else if (token) {
    socket.auth = { token }
    socket.io.opts.query = { token }
  }
  return socket
}

export function connectSocket(sessionToken?: string): Socket {
  const s = getSocket(sessionToken)
  const token = sessionToken || getStoredToken()
  if (token) {
    s.auth = { token }
    s.io.opts.query = { token }
  }
  if (!s.connected) {
    s.connect()
  }
  return s
}

/**
 * Force a fresh transport handshake. Used by the "Refresh Connection" action
 * and by the heartbeat watchdog when the socket looks connected but silent.
 * A full manager restart is required: closing only the engine can leave the
 * manager thinking it is already reconnecting, so the socket never heals.
 */
export function reconnectSocket(): Socket | null {
  if (!socket) return null
  hardRestart(socket)
  return socket
}

export function disconnectSocket() {
  unbindLifecycleWake()
  socket?.disconnect()
  socket = null
}
