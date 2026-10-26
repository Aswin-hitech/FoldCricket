/**
 * useSocket – central React hook that manages the Socket.IO connection
 * and dispatches all incoming events into component state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { connectSocket, disconnectSocket } from '../services/socket'
import type {
  ChatMessage,
  DeliveryReveal,
  RoomSnapshot,
} from '../services/types'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

interface UseSocketReturn {
  status: ConnectionStatus
  snapshot: RoomSnapshot | null
  chatMessages: ChatMessage[]
  lastReveal: DeliveryReveal | null
  matchFinished: { winner: string; result_summary: string } | null
  lastError: string | null

  register: (displayName: string, sessionToken?: string) => void
  createRoom: (mode: string, overs: number) => void
  joinRoom: (joinCode: string) => void
  startMatch: (roomId: string) => void
  selectBowler: (roomId: string, bowlerId: string) => void
  submitPick: (roomId: string, pick: number) => void
  sendChat: (roomId: string, text: string) => void
  setReady: (roomId: string, ready: boolean) => void
  ackRules: (roomId: string) => void
  assignTeam: (roomId: string, playerId: string, team: string) => void
  updateSettings: (roomId: string, overs: number) => void
  sendVoiceSignal: (roomId: string, targetId: string, signal: unknown) => void
}

export function useSocket(sessionToken?: string): UseSocketReturn {
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [lastReveal, setLastReveal] = useState<DeliveryReveal | null>(null)
  const [matchFinished, setMatchFinished] = useState<{ winner: string; result_summary: string } | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  const socketRef = useRef(connectSocket(sessionToken))

  useEffect(() => {
    const s = socketRef.current

    s.on('connect', () => setStatus('connected'))
    s.on('disconnect', () => setStatus('disconnected'))
    s.on('connect_error', () => setStatus('error'))

    s.on('room:snapshot', (data: RoomSnapshot) => setSnapshot(data))
    s.on('chat:message', (msg: ChatMessage) =>
      setChatMessages(prev => [...prev.slice(-199), msg])
    )
    s.on('delivery:reveal', (reveal: DeliveryReveal) => setLastReveal(reveal))
    s.on('match:finished', (data: { winner: string; result_summary: string }) =>
      setMatchFinished(data)
    )
    s.on('room:created', (data: { success: boolean; error?: string }) => {
      if (!data.success) setLastError(data.error || 'unknown_error')
    })
    s.on('room:joined', (data: { success: boolean; error?: string }) => {
      if (!data.success) setLastError(data.error || 'unknown_error')
    })

    return () => {
      s.off('connect')
      s.off('disconnect')
      s.off('connect_error')
      s.off('room:snapshot')
      s.off('chat:message')
      s.off('delivery:reveal')
      s.off('match:finished')
      s.off('room:created')
      s.off('room:joined')
    }
  }, [])

  // ---------- emitters ----------
  const register = useCallback((displayName: string, token?: string) => {
    socketRef.current.emit('player:register', { display_name: displayName, session_token: token })
  }, [])

  const createRoom = useCallback((mode: string, overs: number) => {
    const token = sessionToken || localStorage.getItem('hcl_session') || ''
    socketRef.current.emit('room:create', { mode, overs, session_token: token })
  }, [sessionToken])

  const joinRoom = useCallback((joinCode: string) => {
    const token = sessionToken || localStorage.getItem('hcl_session') || ''
    socketRef.current.emit('room:join', { join_code: joinCode, session_token: token })
  }, [sessionToken])

  const startMatch = useCallback((roomId: string) => {
    socketRef.current.emit('match:start', { room_id: roomId })
  }, [])

  const selectBowler = useCallback((roomId: string, bowlerId: string) => {
    socketRef.current.emit('over:bowler-select', { room_id: roomId, bowler_id: bowlerId })
  }, [])

  const submitPick = useCallback((roomId: string, pick: number) => {
    socketRef.current.emit('delivery:submit', { room_id: roomId, pick })
  }, [])

  const sendChat = useCallback((roomId: string, text: string) => {
    socketRef.current.emit('chat:send', { room_id: roomId, text })
  }, [])

  const setReady = useCallback((roomId: string, ready: boolean) => {
    socketRef.current.emit('match:ready', { room_id: roomId, ready })
  }, [])

  const ackRules = useCallback((roomId: string) => {
    socketRef.current.emit('rules:ack', { room_id: roomId })
  }, [])

  const assignTeam = useCallback((roomId: string, playerId: string, team: string) => {
    socketRef.current.emit('team:assign', { room_id: roomId, player_id: playerId, team })
  }, [])

  const updateSettings = useCallback((roomId: string, overs: number) => {
    socketRef.current.emit('match:settings', { room_id: roomId, overs })
  }, [])

  const sendVoiceSignal = useCallback((roomId: string, targetId: string, signal: unknown) => {
    socketRef.current.emit('voice:signal', { room_id: roomId, target_player_id: targetId, signal })
  }, [])

  return {
    status,
    snapshot,
    chatMessages,
    lastReveal,
    matchFinished,
    lastError,
    register,
    createRoom,
    joinRoom,
    startMatch,
    selectBowler,
    submitPick,
    sendChat,
    setReady,
    ackRules,
    assignTeam,
    updateSettings,
    sendVoiceSignal,
  }
}
