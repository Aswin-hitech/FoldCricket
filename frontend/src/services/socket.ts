/**
 * Socket.IO client service.
 * All game events are routed through this singleton.
 */

import { io, Socket } from 'socket.io-client'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || ''

let socket: Socket | null = null

export function getSocket(sessionToken?: string): Socket {
  if (!socket) {
    socket = io(BACKEND_URL, {
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 50,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
      randomizationFactor: 0.5,
      auth: sessionToken ? { token: sessionToken } : undefined,
      query: sessionToken ? { token: sessionToken } : undefined,
    })
  }
  return socket
}

export function connectSocket(sessionToken?: string): Socket {
  const s = getSocket(sessionToken)
  if (sessionToken) {
    s.auth = { token: sessionToken }
    s.io.opts.query = { token: sessionToken }
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
