/**
 * Socket.IO client service.
 * All game events are routed through this singleton.
 */

import { io, Socket } from 'socket.io-client'
import { getAccountToken } from './accounts'

const rawBackend = import.meta.env.VITE_BACKEND_URL || ''
const BACKEND_URL = rawBackend.trim().replace(/\/+$/, '')

let socket: Socket | null = null
let lifecycleWake: (() => void) | null = null

function getStoredToken(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('hcl_session') || sessionStorage.getItem('hcl_session_token') || ''
}

/**
 * The handshake carries both identities: the guest player token (what the game
 * uses) and the account bearer token (what stats/achievements use). Either can
 * be present on its own.
 */
function buildHandshake(token?: string): { token?: string; account_token?: string } | undefined {
  const guest = (token || getStoredToken()).trim()
  const account = getAccountToken()
  if (!guest && !account) return undefined
  return {
    ...(guest ? { token: guest } : {}),
    ...(account ? { account_token: account } : {}),
  }
}

/**
 * Tear the manager down and open a brand-new engine. Closing only the engine
 * leaves the manager in its reconnecting state, so a half-open socket can stay
 * "connected" indefinitely without ever receiving a packet. disconnect() also
 * cancels any pending backoff timer, so the new handshake starts immediately.
 */
function hardRestart(s: Socket): void {
  // Rebuild the handshake first: a recovered or refreshed identity must travel
  // on the next connect, otherwise the server keeps seeing the stale token.
  const handshake = buildHandshake()
  s.auth = handshake ?? {}
  s.io.opts.query = handshake ?? {}
  s.disconnect()
  s.connect()
}

/**
 * Identity responses are the single source of truth for the guest token and
 * player id. Persisting them here (once per socket) keeps every consumer in
 * sync, including a player identity the server recovered after the token was
 * lost.
 */
function persistIdentity(data: {
  success?: boolean
  player_id?: string
  session_token?: string
  display_name?: string
}): void {
  if (!data?.success || !data.player_id) return
  try {
    if (data.session_token) {
      localStorage.setItem('hcl_session', data.session_token)
      sessionStorage.setItem('hcl_session_token', data.session_token)
    }
    localStorage.setItem('hcl_player_id', data.player_id)
    if (data.display_name) localStorage.setItem('hcl_display_name', data.display_name)
  } catch {
    // Storage unavailable (private mode): the in-memory socket still works.
  }
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
  const handshake = buildHandshake(sessionToken)
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
      auth: handshake,
      query: handshake,
    })
    socket.on('player:registered', persistIdentity)
    socket.on('player:restored', persistIdentity)
    bindLifecycleWake(socket)
  } else {
    socket.auth = handshake ?? {}
    socket.io.opts.query = handshake ?? {}
  }
  return socket
}

export function connectSocket(sessionToken?: string): Socket {
  const s = getSocket(sessionToken)
  const handshake = buildHandshake(sessionToken)
  if (handshake) {
    s.auth = handshake
    s.io.opts.query = handshake
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
