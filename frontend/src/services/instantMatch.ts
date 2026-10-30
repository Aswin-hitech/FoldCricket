/**
 * One-tap match: registers the player and opens a room with saved settings.
 * Used by the landing page and the profile, so both entry points behave the
 * same way as the regular create-room flow.
 */

import { connectSocket } from './socket'
import { getAccountToken } from './accounts'

export interface InstantMatchInput {
  displayName: string
  mode: 'SOLO' | 'TEAM'
  overs: number
  wickets: number
}

interface RegisteredPayload {
  success: boolean
  player_id?: string
  session_token?: string
  error?: string
}

interface RoomCreatedPayload {
  success: boolean
  room_id?: string
  error?: string
}

export function startInstantMatch(input: InstantMatchInput): Promise<{ roomId: string }> {
  return new Promise((resolve, reject) => {
    const sessionToken = localStorage.getItem('hcl_session') || undefined
    const accountToken = getAccountToken() || undefined
    const socket = connectSocket(sessionToken)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (error: string | null, roomId?: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      socket.off('player:registered', onRegistered)
      socket.off('room:created', onCreated)
      if (error) reject(new Error(error))
      else resolve({ roomId: roomId as string })
    }

    timer = setTimeout(() => finish('Could not start the match. Please try again.'), 15000)

    const onRegistered = (data: RegisteredPayload) => {
      if (!data?.success || !data.session_token) {
        finish(data?.error || 'Could not register your player.')
        return
      }
      localStorage.setItem('hcl_session', data.session_token)
      sessionStorage.setItem('hcl_session_token', data.session_token)
      if (data.player_id) localStorage.setItem('hcl_player_id', data.player_id)
      localStorage.setItem('hcl_display_name', input.displayName)

      socket.emit('room:create', {
        mode: input.mode,
        overs: input.overs,
        wickets: input.wickets,
        session_token: data.session_token,
        ...(accountToken ? { account_token: accountToken } : {}),
      })
    }

    const onCreated = (data: RoomCreatedPayload) => {
      if (!data?.success || !data.room_id) {
        finish(data?.error || 'Could not create the match.')
        return
      }
      finish(null, data.room_id)
    }

    socket.on('player:registered', onRegistered)
    socket.on('room:created', onCreated)
    socket.emit('player:register', {
      display_name: input.displayName,
      session_token: sessionToken,
      ...(accountToken ? { account_token: accountToken } : {}),
    })
  })
}
