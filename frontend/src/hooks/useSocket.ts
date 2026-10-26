/**
 * useSocket – central React hook that manages the Socket.IO connection
 * and dispatches all incoming events into component state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { connectSocket, disconnectSocket } from '../services/socket'
import type {
  ChatMessage,
  DeliveryReveal,
  PausedInfo,
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
  pingLatency: number | null
  voiceStates: Record<string, { is_speaking: boolean; is_muted: boolean; player_name: string }>
  pausedInfo: PausedInfo | null
  incomingVoiceSignal: { from_player_id: string; signal: unknown; timestamp: number } | null

  register: (displayName: string, sessionToken?: string) => void
  createRoom: (mode: string, overs: number) => void
  joinRoom: (joinCode: string) => void
  syncRoom: (roomId: string) => void
  startMatch: (roomId: string) => void
  callToss: (roomId: string, choice: 'HEADS' | 'TAILS') => void
  decideToss: (roomId: string, decision: 'BAT' | 'BOWL') => void
  selectBowler: (roomId: string, bowlerId: string) => void
  submitPick: (roomId: string, pick: number) => void
  pauseMatch: (roomId: string) => void
  resumeMatch: (roomId: string) => void
  sendChat: (roomId: string, text: string) => void
  setReady: (roomId: string, ready: boolean) => void
  ackRules: (roomId: string) => void
  assignTeam: (roomId: string, playerId: string, team: string) => void
  updateSettings: (roomId: string, overs: number) => void
  updateTeams: (roomId: string, teamAName: string, teamBName: string) => void
  updateVoiceState: (roomId: string, isSpeaking: boolean, isMuted: boolean) => void
  sendVoiceSignal: (roomId: string, targetId: string, signal: unknown) => void
}

export function useSocket(sessionToken?: string): UseSocketReturn {
  const socketRef = useRef(connectSocket(sessionToken))
  const [status, setStatus] = useState<ConnectionStatus>(() =>
    socketRef.current.connected ? 'connected' : 'connecting'
  )
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [lastReveal, setLastReveal] = useState<DeliveryReveal | null>(null)
  const [matchFinished, setMatchFinished] = useState<{ winner: string; result_summary: string } | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [pingLatency, setPingLatency] = useState<number | null>(null)
  const [voiceStates, setVoiceStates] = useState<Record<string, { is_speaking: boolean; is_muted: boolean; player_name: string }>>({})
  const [pausedInfo, setPausedInfo] = useState<PausedInfo | null>(null)
  const [incomingVoiceSignal, setIncomingVoiceSignal] = useState<{
    from_player_id: string
    signal: unknown
    timestamp: number
  } | null>(null)

  useEffect(() => {
    const s = socketRef.current

    // Synchronize immediate status
    if (s.connected) {
      setStatus('connected')
    }

    const onConnect = () => {
      setStatus('connected')
      s.emit('ping_check', Date.now())
    }
    const onDisconnect = () => {
      setStatus('disconnected')
      setPingLatency(null)
    }
    const onConnectError = () => {
      setStatus('error')
      setPingLatency(null)
    }
    const onSnapshot = (data: RoomSnapshot) => {
      setSnapshot(data)
      if (data?.room?.status === 'PAUSED' || data?.room?.is_paused) {
        setPausedInfo(prev => prev || { paused: true, reason: 'Game Paused' })
      } else if (data?.room?.status === 'INNINGS_ACTIVE') {
        setPausedInfo(null)
      }
    }
    const onChatMessage = (msg: ChatMessage) =>
      setChatMessages((prev) => [...prev.slice(-199), msg])
    const onDeliveryReveal = (reveal: DeliveryReveal) => setLastReveal(reveal)
    const onMatchFinished = (data: { winner: string; result_summary: string }) =>
      setMatchFinished(data)
    const onRoomCreated = (data: { success: boolean; error?: string }) => {
      if (!data.success) setLastError(data.error || 'unknown_error')
    }
    const onRoomJoined = (data: { success: boolean; error?: string }) => {
      if (!data.success) setLastError(data.error || 'unknown_error')
    }
    const onPongAck = (sentTime: number) => {
      if (typeof sentTime === 'number') {
        const rtt = Math.max(1, Date.now() - sentTime)
        setPingLatency(rtt)
      }
    }
    const onVoiceStateChanged = (data: { player_id: string; player_name: string; is_speaking: boolean; is_muted: boolean }) => {
      setVoiceStates((prev) => ({
        ...prev,
        [data.player_id]: {
          is_speaking: data.is_speaking,
          is_muted: data.is_muted,
          player_name: data.player_name,
        },
      }))
    }
    const onMatchPaused = (info: PausedInfo) => {
      setPausedInfo(info)
    }
    const onMatchResumed = () => {
      setPausedInfo(null)
    }

    const onVoiceSignal = (data: { from_player_id: string; signal: unknown }) => {
      setIncomingVoiceSignal({ ...data, timestamp: Date.now() })
    }

    s.on('connect', onConnect)
    s.on('disconnect', onDisconnect)
    s.on('connect_error', onConnectError)
    s.on('room:snapshot', onSnapshot)
    s.on('chat:message', onChatMessage)
    s.on('delivery:reveal', onDeliveryReveal)
    s.on('match:finished', onMatchFinished)
    s.on('room:created', onRoomCreated)
    s.on('room:joined', onRoomJoined)
    s.on('pong_ack', onPongAck)
    s.on('voice:state_changed', onVoiceStateChanged)
    s.on('voice:signal', onVoiceSignal)
    s.on('match:paused', onMatchPaused)
    s.on('match:resumed', onMatchResumed)

    // Regular ping heartbeats every 3.5s
    const pingInterval = setInterval(() => {
      if (s.connected) {
        s.emit('ping_check', Date.now())
      }
    }, 3500)

    return () => {
      clearInterval(pingInterval)
      s.off('connect', onConnect)
      s.off('disconnect', onDisconnect)
      s.off('connect_error', onConnectError)
      s.off('room:snapshot', onSnapshot)
      s.off('chat:message', onChatMessage)
      s.off('delivery:reveal', onDeliveryReveal)
      s.off('match:finished', onMatchFinished)
      s.off('room:created', onRoomCreated)
      s.off('room:joined', onRoomJoined)
      s.off('pong_ack', onPongAck)
      s.off('voice:state_changed', onVoiceStateChanged)
      s.off('voice:signal', onVoiceSignal)
      s.off('match:paused', onMatchPaused)
      s.off('match:resumed', onMatchResumed)
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

  const syncRoom = useCallback((roomId: string) => {
    const token = sessionToken || localStorage.getItem('hcl_session') || ''
    socketRef.current.emit('room:sync', { room_id: roomId, session_token: token })
  }, [sessionToken])

  const startMatch = useCallback((roomId: string) => {
    socketRef.current.emit('match:start', { room_id: roomId })
  }, [])

  const callToss = useCallback((roomId: string, choice: 'HEADS' | 'TAILS') => {
    socketRef.current.emit('toss:call', { room_id: roomId, choice })
  }, [])

  const decideToss = useCallback((roomId: string, decision: 'BAT' | 'BOWL') => {
    socketRef.current.emit('toss:decide', { room_id: roomId, decision })
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

  const updateTeams = useCallback((roomId: string, teamAName: string, teamBName: string) => {
    socketRef.current.emit('room:update_teams', { room_id: roomId, team_a_name: teamAName, team_b_name: teamBName })
  }, [])

  const updateVoiceState = useCallback((roomId: string, isSpeaking: boolean, isMuted: boolean) => {
    socketRef.current.emit('voice:state', { room_id: roomId, is_speaking: isSpeaking, is_muted: isMuted })
  }, [])

  const sendVoiceSignal = useCallback((roomId: string, targetId: string, signal: unknown) => {
    socketRef.current.emit('voice:signal', { room_id: roomId, target_player_id: targetId, signal })
  }, [])

  const pauseMatch = useCallback((roomId: string) => {
    socketRef.current.emit('match:pause', { room_id: roomId })
  }, [])

  const resumeMatch = useCallback((roomId: string) => {
    socketRef.current.emit('match:resume', { room_id: roomId })
  }, [])

  return {
    status,
    snapshot,
    chatMessages,
    lastReveal,
    matchFinished,
    lastError,
    pingLatency,
    voiceStates,
    pausedInfo,
    incomingVoiceSignal,
    register,
    createRoom,
    joinRoom,
    syncRoom,
    startMatch,
    callToss,
    decideToss,
    selectBowler,
    submitPick,
    pauseMatch,
    resumeMatch,
    sendChat,
    setReady,
    ackRules,
    assignTeam,
    updateSettings,
    updateTeams,
    updateVoiceState,
    sendVoiceSignal,
  }
}
