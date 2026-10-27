/**
 * Socket.IO client service.
 * All game events are routed through this singleton.
 */

import { io, Socket } from 'socket.io-client'

const rawBackend = import.meta.env.VITE_BACKEND_URL || ''
const BACKEND_URL = rawBackend.trim().replace(/\/+$/, '')

let socket: Socket | null = null

function getStoredToken(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('hcl_session') || sessionStorage.getItem('hcl_session_token') || ''
}

export function getSocket(sessionToken?: string): Socket {
  const token = sessionToken || getStoredToken()
  if (!socket) {
    socket = io(BACKEND_URL, {
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 100,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 6000,
      randomizationFactor: 0.4,
      auth: token ? { token } : undefined,
      query: token ? { token } : undefined,
    })
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

export function disconnectSocket() {
  socket?.disconnect()
  socket = null
}
