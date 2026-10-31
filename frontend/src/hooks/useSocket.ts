/**
 * useSocket – central React hook that manages the Socket.IO connection
 * and dispatches all incoming events into component state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { connectSocket, disconnectSocket, reconnectSocket } from '../services/socket'
import { getAccountToken } from '../services/accounts'
import type {
  AllOutInfo,
  ChatMessage,
  CrossTeamVoiceRequest,
  DeliveryAck,
  DeliveryReveal,
  InningsBreakInfo,
  PausedInfo,
  RoomSnapshot,
  SuperOverInfo,
  VideoCallInvite,
  VideoCallSession,
} from '../services/types'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

/** Payload sent to a player who was removed from a lobby by a captain/host. */
export interface LobbyRemovedNotice {
  room_id: string
  reason: string
  message: string
}

/** Account identity travels with every identity-bearing payload so the server
 * can link the guest player to the signed-in account (stats, badges). */
function accountField(): { account_token?: string } {
  const token = getAccountToken()
  return token ? { account_token: token } : {}
}

export interface LobbyAck {
  success: boolean
  error?: string
}

/** Pick rejections caused by a race with the ball moving on, not by bad input. */
const PICK_RESYNC_ONLY_ERRORS = new Set([
  'ball_changed',
  'already_submitted',
  'delivery_already_resolved',
  'deadline_expired',
])

interface UseSocketReturn {
  status: ConnectionStatus
  snapshot: RoomSnapshot | null
  chatMessages: ChatMessage[]
  lastReveal: DeliveryReveal | null
  inningsBreak: InningsBreakInfo | null
  matchFinished: { winner: string; result_summary: string } | null
  allOutInfo: AllOutInfo | null
  superOverInfo: SuperOverInfo | null
  clearSuperOverInfo: () => void
  lastError: string | null
  pingLatency: number | null
  voiceStates: Record<string, { is_speaking: boolean; is_muted: boolean; player_name: string }>
  pausedInfo: PausedInfo | null
  voiceSignals: Array<{ id: number; from_player_id: string; signal: unknown; timestamp: number }>
  crossTeamRequests: CrossTeamVoiceRequest[]
  incomingVideoCall: VideoCallInvite | null
  videoCallPeer: VideoCallSession | null
  videoCallError: string | null
  clearVideoCallError: () => void
  deliveryAck: DeliveryAck | null
  firstBallAck: { success: boolean; error?: string; activated?: boolean } | null
  lobbyLeft: LobbyAck | null
  lobbyRemoved: LobbyRemovedNotice | null
  lobbyRemoveAck: LobbyAck | null
  clearLobbyLeft: () => void
  clearLobbyRemoved: () => void
  clearLobbyRemoveAck: () => void
  leaveLobby: (roomId: string) => void
  removePlayerFromLobby: (roomId: string, playerId: string) => void
  /** Current server time in ms (accounts for device clock skew). */
  serverNow: () => number

  register: (displayName: string, sessionToken?: string) => void
  createRoom: (mode: string, overs: number) => void
  joinRoom: (joinCode: string, asSpectator?: boolean) => void
  syncRoom: (roomId: string) => void
  reconnect: () => void
  startMatch: (roomId: string) => void
  callToss: (roomId: string, choice: 'HEADS' | 'TAILS') => void
  decideToss: (roomId: string, decision: 'BAT' | 'BOWL') => void
  firstBallReady: (roomId: string) => void
  selectBowler: (roomId: string, bowlerId: string) => void
  selectBatter: (roomId: string, batterId: string) => void
  submitPick: (roomId: string, pick: number, over?: number, ball?: number, phase?: string) => void
  pauseMatch: (roomId: string) => void
  resumeMatch: (roomId: string) => void
  sendChat: (roomId: string, text: string) => void
  setReady: (roomId: string, ready: boolean) => void
  ackRules: (roomId: string) => void
  rematchRoom: (roomId: string) => void
  assignTeam: (roomId: string, playerId: string, team: string) => void
  updateSettings: (roomId: string, overs: number, wickets?: number) => void
  updateTeams: (roomId: string, teamAName: string, teamBName: string) => void
  updateVoiceState: (roomId: string, isSpeaking: boolean, isMuted: boolean) => void
  setVoiceMode: (roomId: string, mode: string, allowedRecipients: string[]) => void
  sendVoiceSignal: (roomId: string, targetId: string, signal: unknown) => void
  requestCrossTeamVoice: (roomId: string, targetId: string) => void
  respondCrossTeamVoice: (roomId: string, senderId: string, accept: boolean) => void
  revokeCrossTeamVoice: (roomId: string, targetId: string) => void
  requestVideoCall: (roomId: string, targetId: string, targetName?: string) => void
  respondVideoCall: (roomId: string, callerId: string, accept: boolean) => void
  endVideoCall: (roomId: string, peerId: string) => void
}

export function useSocket(sessionToken?: string): UseSocketReturn {
  const socketRef = useRef(connectSocket(sessionToken))
  const [status, setStatus] = useState<ConnectionStatus>(() =>
    socketRef.current.connected ? 'connected' : 'connecting'
  )
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [lastReveal, setLastReveal] = useState<DeliveryReveal | null>(null)
  const [inningsBreak, setInningsBreak] = useState<InningsBreakInfo | null>(null)
  const [matchFinished, setMatchFinished] = useState<{ winner: string; result_summary: string } | null>(null)
  const [allOutInfo, setAllOutInfo] = useState<AllOutInfo | null>(null)
  const [superOverInfo, setSuperOverInfo] = useState<SuperOverInfo | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [pingLatency, setPingLatency] = useState<number | null>(null)
  const [voiceStates, setVoiceStates] = useState<Record<string, { is_speaking: boolean; is_muted: boolean; player_name: string }>>({})
  const [pausedInfo, setPausedInfo] = useState<PausedInfo | null>(null)
  const [voiceSignals, setVoiceSignals] = useState<
    Array<{ id: number; from_player_id: string; signal: unknown; timestamp: number }>
  >([])
  const [crossTeamRequests, setCrossTeamRequests] = useState<CrossTeamVoiceRequest[]>([])
  const [incomingVideoCall, setIncomingVideoCall] = useState<VideoCallInvite | null>(null)
  const [videoCallPeer, setVideoCallPeer] = useState<VideoCallSession | null>(null)
  const [videoCallError, setVideoCallError] = useState<string | null>(null)
  const [deliveryAck, setDeliveryAck] = useState<DeliveryAck | null>(null)
  const [firstBallAck, setFirstBallAck] = useState<{ success: boolean; error?: string; activated?: boolean } | null>(null)
  const [lobbyLeft, setLobbyLeft] = useState<LobbyAck | null>(null)
  const [lobbyRemoved, setLobbyRemoved] = useState<LobbyRemovedNotice | null>(null)
  const [lobbyRemoveAck, setLobbyRemoveAck] = useState<LobbyAck | null>(null)
  const lastSnapshotVersionRef = useRef<number>(-1)
  const lastSnapshotMatchIdRef = useRef<string | null>(null)
  // The room this page is actually rendering. Snapshots for any other room the
  // player was a member of earlier (restore/reconnect echoes) must be ignored.
  const activeRoomIdRef = useRef<string | null>(null)
  const serverOffsetRef = useRef<number>(0)
  const voiceSignalSeqRef = useRef(0)
  // Video call bookkeeping: who we are calling and the ring timeout handle.
  const outgoingVideoCallRef = useRef<string | null>(null)
  const videoRingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const s = socketRef.current
    // Timestamp of the last packet actually received from the server. Used to
    // detect half-open sockets (tab sleep, network switch) that still report
    // `connected` but can no longer receive anything.
    let lastServerPacketAt = Date.now()
    // When the socket first went down, so a stalled retry loop can be restarted.
    let downSince: number | null = null
    // `id` is set as soon as the namespace connects, so this also covers a
    // handshake that finished before these listeners were attached.
    let everConnected = s.connected || Boolean(s.id)

    // Synchronize immediate status
    if (s.connected) {
      setStatus('connected')
    }

    const sessionTokenNow = () =>
      (typeof window !== 'undefined' ? localStorage.getItem('hcl_session') || '' : '') ||
      sessionToken ||
      ''

    const onConnect = () => {
      everConnected = true
      downSince = null
      setStatus('connected')
      lastServerPacketAt = Date.now()
      const token = sessionTokenNow()
      if (token) {
        s.emit('player:restore', { session_token: token, ...accountField() })
      }
      // The server only rejoins rooms on restore; ask for the authoritative
      // snapshot so a reconnect does not leave the page on stale state.
      if (activeRoomIdRef.current) {
        s.emit('room:sync', {
          room_id: activeRoomIdRef.current,
          session_token: token,
          ...accountField(),
        })
      }
      s.emit('ping_check', Date.now())
    }
    const onDisconnect = () => {
      downSince = downSince ?? Date.now()
      setStatus('disconnected')
      setPingLatency(null)
    }
    const onConnectError = () => {
      downSince = downSince ?? Date.now()
      setStatus('error')
      setPingLatency(null)
    }

    const onOffline = () => {
      // navigator.onLine === false: socket.io will retry on its own.
      downSince = downSince ?? Date.now()
      setStatus('disconnected')
      setPingLatency(null)
    }
    const onOnline = () => {
      if (!s.connected) reconnectSocket()
      else s.emit('ping_check', Date.now())
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (navigator.onLine === false) return
      if (!s.connected) {
        reconnectSocket()
        return
      }
      s.emit('ping_check', Date.now())
      if (activeRoomIdRef.current) {
        s.emit('room:sync', {
          room_id: activeRoomIdRef.current,
          session_token: sessionTokenNow(),
          ...accountField(),
        })
      }
    }

    const onSnapshot = (data: RoomSnapshot) => {
      lastServerPacketAt = Date.now()
      if (activeRoomIdRef.current && data?.room?.id && data.room.id !== activeRoomIdRef.current) {
        return // snapshot for a room this page is not displaying
      }

      // Clock sync: derive offset from the server timestamp shipped with every snapshot
      if (data?.server_time) {
        const parsed = Date.parse(data.server_time)
        if (!Number.isNaN(parsed)) {
          serverOffsetRef.current = parsed - Date.now()
        }
      }

      // The server tells us which player this snapshot describes. If it
      // recovered an identity we had lost, adopt it so page reloads and later
      // reconnects use the same player.
      if (data?.self_player_id) {
        try {
          if (localStorage.getItem('hcl_player_id') !== data.self_player_id) {
            localStorage.setItem('hcl_player_id', data.self_player_id)
          }
        } catch {
          // Storage unavailable: the snapshot still drives this render.
        }
      }

      // Prevent stale snapshots from overwriting newer committed state.
      // The version counter resets for a new match, so track match id as well.
      const matchId = data?.match?.id ?? null
      if (matchId !== lastSnapshotMatchIdRef.current) {
        lastSnapshotMatchIdRef.current = matchId
        lastSnapshotVersionRef.current = -1
        // Event-derived state belongs to the match that just ended. Carrying it
        // into the next game (or back into the lobby) replays old reveals,
        // all-out banners and finish transitions.
        setLastReveal(null)
        setInningsBreak(null)
        setMatchFinished(null)
        setAllOutInfo(null)
        setSuperOverInfo(null)
        setDeliveryAck(null)
        setFirstBallAck(null)
      }
      if (data?.match?.version !== undefined) {
        if (data.match.version < lastSnapshotVersionRef.current) {
          return // stale snapshot ignored
        }
        lastSnapshotVersionRef.current = data.match.version
      }

      setSnapshot(data)
      if (data?.room?.status === 'PAUSED' || data?.room?.is_paused) {
        setPausedInfo(prev => prev || { paused: true, reason: 'Game Paused' })
      } else if (data?.room?.status === 'INNINGS_ACTIVE' || data?.room?.status === 'AWAITING_FIRST_BALL') {
        setPausedInfo(null)
      }
    }
    const onChatMessage = (msg: ChatMessage) =>
      setChatMessages((prev) => [...prev.slice(-199), msg])
    const onDeliveryReveal = (reveal: DeliveryReveal) => setLastReveal(reveal)
    const onInningsBreak = (info: InningsBreakInfo) => setInningsBreak(info)
    const onMatchFinished = (data: { winner: string; result_summary: string }) =>
      setMatchFinished(data)
    const onAllOut = (data: AllOutInfo) => setAllOutInfo(data)
    const onSuperOver = (data: SuperOverInfo) => setSuperOverInfo(data)
    const onRoomCreated = (data: { success: boolean; error?: string }) => {
      if (!data.success) setLastError(data.error || 'unknown_error')
    }
    const onRoomJoined = (data: { success: boolean; error?: string }) => {
      if (!data.success) setLastError(data.error || 'unknown_error')
    }
    const onPongAck = (sentTime: number) => {
      lastServerPacketAt = Date.now()
      // A short blip (tab sleep, Wi-Fi switch) can raise `offline`/`error`
      // without ever tearing the transport down. Traffic resuming proves the
      // socket is healthy again, so clear the stuck "Reconnecting" state.
      if (downSince !== null) {
        downSince = null
        setStatus('connected')
      }
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
      // Queue every signal: React batches state updates, so a single state slot
      // silently drops signals when offer/answer/candidate arrive together.
      voiceSignalSeqRef.current += 1
      const entry = {
        id: voiceSignalSeqRef.current,
        from_player_id: data.from_player_id,
        signal: data.signal,
        timestamp: Date.now(),
      }
      setVoiceSignals((prev) => [...prev.slice(-99), entry])
    }

    const onDeliveryAck = (data: DeliveryAck) => {
      setDeliveryAck(data)
      // These only mean the packet lost a race with the next ball; surfacing
      // them as a global error would be a false alarm.
      if (
        !data?.success &&
        data?.error &&
        !PICK_RESYNC_ONLY_ERRORS.has(data.error)
      ) {
        setLastError(data.error)
      }
    }

    const onFirstBallAck = (data: { success: boolean; error?: string; activated?: boolean }) => {
      setFirstBallAck(data)
      if (!data?.success && data?.error) setLastError(data.error)
    }

    const onLobbyLeft = (data: LobbyAck) => setLobbyLeft(data)
    const onLobbyRemoved = (data: LobbyRemovedNotice) => setLobbyRemoved(data)
    const onLobbyRemoveAck = (data: LobbyAck) => setLobbyRemoveAck(data)

    const onCrossTeamRequested = (req: CrossTeamVoiceRequest) => {
      setCrossTeamRequests((prev) => {
        if (prev.some((r) => r.from_player_id === req.from_player_id)) return prev
        return [...prev, req]
      })
    }

    const onCrossTeamApproved = (data: { room_id: string; peer_id: string; peer_name: string }) => {
      setCrossTeamRequests((prev) => prev.filter((r) => r.from_player_id !== data.peer_id))
    }

    const onCrossTeamDeclined = (data: { room_id: string; peer_id: string; peer_name: string }) => {
      setCrossTeamRequests((prev) => prev.filter((r) => r.from_player_id !== data.peer_id))
    }

    const onCrossTeamRevoked = (data: { room_id: string; peer_id: string }) => {
      setCrossTeamRequests((prev) => prev.filter((r) => r.from_player_id !== data.peer_id))
    }

    // ---------- 1:1 video call (beta) ----------
    const clearRingTimer = () => {
      if (videoRingTimerRef.current) {
        clearTimeout(videoRingTimerRef.current)
        videoRingTimerRef.current = null
      }
    }

    const onVideoCallIncoming = (invite: VideoCallInvite) => {
      setIncomingVideoCall(invite)
      setVideoCallError(null)
    }

    const onVideoCallAck = (data: { success: boolean; error?: string; target_id?: string }) => {
      if (data?.success) {
        // Stop ringing after the server-side pending-call TTL (45s).
        clearRingTimer()
        videoRingTimerRef.current = setTimeout(() => {
          videoRingTimerRef.current = null
          const target = outgoingVideoCallRef.current
          outgoingVideoCallRef.current = null
          if (target) {
            setVideoCallPeer((prev) =>
              prev && prev.peerId === target && prev.state === 'ringing' ? null : prev
            )
            setVideoCallError('no_answer')
          }
        }, 45000)
        return
      }
      outgoingVideoCallRef.current = null
      clearRingTimer()
      setVideoCallPeer(null)
      setVideoCallError(data?.error || 'call_failed')
    }

    const onVideoCallAccepted = (data: { room_id: string; peer_id: string; peer_name: string }) => {
      const direction = outgoingVideoCallRef.current === data.peer_id ? 'outgoing' : 'incoming'
      outgoingVideoCallRef.current = null
      clearRingTimer()
      setIncomingVideoCall(null)
      setVideoCallError(null)
      setVideoCallPeer({
        peerId: data.peer_id,
        peerName: data.peer_name,
        state: 'active',
        direction,
      })
    }

    const onVideoCallDeclined = (data: { room_id: string; peer_id: string; peer_name: string }) => {
      const wasCaller = outgoingVideoCallRef.current === data.peer_id
      outgoingVideoCallRef.current = null
      clearRingTimer()
      setVideoCallPeer((prev) => (prev && prev.peerId === data.peer_id ? null : prev))
      setIncomingVideoCall((prev) =>
        prev && prev.from_player_id === data.peer_id ? null : prev
      )
      if (wasCaller) setVideoCallError('declined')
    }

    const onVideoCallEnded = (data: { room_id: string; peer_id: string }) => {
      if (outgoingVideoCallRef.current === data.peer_id) {
        outgoingVideoCallRef.current = null
        clearRingTimer()
      }
      setVideoCallPeer((prev) => (prev && prev.peerId === data.peer_id ? null : prev))
      setIncomingVideoCall((prev) =>
        prev && prev.from_player_id === data.peer_id ? null : prev
      )
    }

    const onVideoCallResponseAck = (data: { success: boolean; error?: string }) => {
      if (!data?.success) setVideoCallError(data?.error || 'call_failed')
    }

    s.on('connect', onConnect)
    s.on('disconnect', onDisconnect)
    s.on('connect_error', onConnectError)
    s.on('room:snapshot', onSnapshot)
    s.on('chat:message', onChatMessage)
    s.on('delivery:reveal', onDeliveryReveal)
    s.on('innings:break', onInningsBreak)
    s.on('match:finished', onMatchFinished)
    s.on('match:all_out', onAllOut)
    s.on('match:super_over', onSuperOver)
    s.on('room:created', onRoomCreated)
    s.on('room:joined', onRoomJoined)
    s.on('pong_ack', onPongAck)
    s.on('voice:state_changed', onVoiceStateChanged)
    s.on('voice:signal', onVoiceSignal)
    s.on('voice:cross_team_requested', onCrossTeamRequested)
    s.on('voice:cross_team_approved', onCrossTeamApproved)
    s.on('voice:cross_team_declined', onCrossTeamDeclined)
    s.on('voice:cross_team_revoked', onCrossTeamRevoked)
    s.on('video:call_incoming', onVideoCallIncoming)
    s.on('video:call_ack', onVideoCallAck)
    s.on('video:call_accepted', onVideoCallAccepted)
    s.on('video:call_declined', onVideoCallDeclined)
    s.on('video:call_ended', onVideoCallEnded)
    s.on('video:call_response_ack', onVideoCallResponseAck)
    s.on('match:paused', onMatchPaused)
    s.on('match:resumed', onMatchResumed)
    s.on('delivery:ack', onDeliveryAck)
    s.on('first_ball:ack', onFirstBallAck)
    s.on('lobby:left', onLobbyLeft)
    s.on('lobby:removed', onLobbyRemoved)
    s.on('lobby:remove_ack', onLobbyRemoveAck)

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    window.addEventListener('pageshow', onVisible)
    document.addEventListener('visibilitychange', onVisible)

    // Ask for latency right away instead of waiting one heartbeat, so the
    // indicator does not sit on "Connecting" for the first few seconds.
    if (s.connected) {
      s.emit('ping_check', Date.now())
    }

    // Regular ping heartbeats every 3.5s
    const pingInterval = setInterval(() => {
      if (s.connected) {
        s.emit('ping_check', Date.now())
      }
    }, 3500)

    // Connection watchdog. Two failure modes need an explicit restart:
    //  - half-open socket: still reports `connected` but the server has been
    //    silent for 12s, so nothing will ever arrive or be delivered;
    //  - stalled retry loop: socket.io's manager can stop scheduling attempts
    //    (e.g. a reconnect error that never lands), leaving the app stuck on
    //    "Reconnecting" even after the network is back.
    // Both restart the manager, which forces a fresh handshake and room sync.
    const watchdog = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      if (navigator.onLine === false) return
      if (!s.connected) {
        // Before the first successful handshake, socket.io handles retries.
        if (!everConnected) return
        if (downSince === null) {
          downSince = Date.now()
          return
        }
        if (Date.now() - downSince < 10000) return
        downSince = Date.now()
        reconnectSocket()
        return
      }
      if (Date.now() - lastServerPacketAt < 12000) return
      lastServerPacketAt = Date.now()
      reconnectSocket()
    }, 4000)

    return () => {
      clearInterval(pingInterval)
      clearInterval(watchdog)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('pageshow', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
      s.off('connect', onConnect)
      s.off('disconnect', onDisconnect)
      s.off('connect_error', onConnectError)
      s.off('room:snapshot', onSnapshot)
      s.off('chat:message', onChatMessage)
      s.off('delivery:reveal', onDeliveryReveal)
      s.off('match:finished', onMatchFinished)
      s.off('match:all_out', onAllOut)
      s.off('match:super_over', onSuperOver)
      s.off('room:created', onRoomCreated)
      s.off('room:joined', onRoomJoined)
      s.off('pong_ack', onPongAck)
      s.off('voice:state_changed', onVoiceStateChanged)
      s.off('voice:signal', onVoiceSignal)
      s.off('voice:cross_team_requested', onCrossTeamRequested)
      s.off('voice:cross_team_approved', onCrossTeamApproved)
      s.off('voice:cross_team_declined', onCrossTeamDeclined)
      s.off('voice:cross_team_revoked', onCrossTeamRevoked)
      s.off('video:call_incoming', onVideoCallIncoming)
      s.off('video:call_ack', onVideoCallAck)
      s.off('video:call_accepted', onVideoCallAccepted)
      s.off('video:call_declined', onVideoCallDeclined)
      s.off('video:call_ended', onVideoCallEnded)
      s.off('video:call_response_ack', onVideoCallResponseAck)
      clearRingTimer()
      s.off('match:paused', onMatchPaused)
      s.off('match:resumed', onMatchResumed)
      s.off('delivery:ack', onDeliveryAck)
      s.off('first_ball:ack', onFirstBallAck)
      s.off('lobby:left', onLobbyLeft)
      s.off('lobby:removed', onLobbyRemoved)
      s.off('lobby:remove_ack', onLobbyRemoveAck)
    }
  }, [])

  // ---------- emitters ----------
  const register = useCallback((displayName: string, token?: string) => {
    socketRef.current.emit('player:register', {
      display_name: displayName,
      session_token: token,
      ...accountField(),
    })
  }, [])

  const createRoom = useCallback((mode: string, overs: number) => {
    const token = localStorage.getItem('hcl_session') || sessionToken || ''
    socketRef.current.emit('room:create', { mode, overs, session_token: token, ...accountField() })
  }, [sessionToken])

  const joinRoom = useCallback((joinCode: string, asSpectator = false) => {
    const token = localStorage.getItem('hcl_session') || sessionToken || ''
    socketRef.current.emit('room:join', {
      join_code: joinCode,
      session_token: token,
      as_spectator: asSpectator,
      ...accountField(),
    })
  }, [sessionToken])

  const syncRoom = useCallback((roomId: string) => {
    activeRoomIdRef.current = roomId
    const token = localStorage.getItem('hcl_session') || sessionToken || ''
    socketRef.current.emit('room:sync', {
      room_id: roomId,
      session_token: token,
      ...accountField(),
    })
  }, [sessionToken])

  // Force a fresh transport handshake (manual "Refresh Connection", or healing
  // a socket that reports connected but receives nothing).
  const reconnect = useCallback(() => {
    reconnectSocket()
  }, [])

  const startMatch = useCallback((roomId: string) => {
    socketRef.current.emit('match:start', { room_id: roomId })
  }, [])

  const callToss = useCallback((roomId: string, choice: 'HEADS' | 'TAILS') => {
    socketRef.current.emit('toss:call', { room_id: roomId, choice })
  }, [])

  const decideToss = useCallback((roomId: string, decision: 'BAT' | 'BOWL') => {
    socketRef.current.emit('toss:decide', { room_id: roomId, decision })
  }, [])

  const firstBallReady = useCallback((roomId: string) => {
    socketRef.current.emit('first_ball:ready', { room_id: roomId })
  }, [])

  const serverNow = useCallback(() => Date.now() + serverOffsetRef.current, [])

  const selectBowler = useCallback((roomId: string, bowlerId: string) => {
    socketRef.current.emit('over:bowler-select', { room_id: roomId, bowler_id: bowlerId })
  }, [])

  const selectBatter = useCallback((roomId: string, batterId: string) => {
    socketRef.current.emit('match:select_batter', { room_id: roomId, batter_id: batterId })
  }, [])

  const submitPick = useCallback(
    (roomId: string, pick: number, over?: number, ball?: number, phase?: string) => {
      socketRef.current.emit('delivery:submit', { room_id: roomId, pick, over, ball, phase })
    },
    [],
  )

  const sendChat = useCallback((roomId: string, text: string) => {
    socketRef.current.emit('chat:send', { room_id: roomId, text })
  }, [])

  const setReady = useCallback((roomId: string, ready: boolean) => {
    socketRef.current.emit('match:ready', { room_id: roomId, ready })
  }, [])

  const ackRules = useCallback((roomId: string) => {
    socketRef.current.emit('rules:ack', { room_id: roomId })
  }, [])

  const rematchRoom = useCallback((roomId: string) => {
    socketRef.current.emit('room:rematch', { room_id: roomId })
  }, [])

  const leaveLobby = useCallback((roomId: string) => {
    setLobbyLeft(null)
    socketRef.current.emit('lobby:leave', { room_id: roomId })
  }, [])

  const removePlayerFromLobby = useCallback((roomId: string, playerId: string) => {
    setLobbyRemoveAck(null)
    socketRef.current.emit('lobby:remove_player', { room_id: roomId, player_id: playerId })
  }, [])

  const clearLobbyLeft = useCallback(() => setLobbyLeft(null), [])
  const clearLobbyRemoved = useCallback(() => setLobbyRemoved(null), [])
  const clearLobbyRemoveAck = useCallback(() => setLobbyRemoveAck(null), [])

  const assignTeam = useCallback((roomId: string, playerId: string, team: string) => {
    socketRef.current.emit('team:assign', { room_id: roomId, player_id: playerId, team })
  }, [])

  const updateSettings = useCallback((roomId: string, overs: number, wickets?: number) => {
    socketRef.current.emit('match:settings', { room_id: roomId, overs, wickets })
  }, [])

  const updateTeams = useCallback((roomId: string, teamAName: string, teamBName: string) => {
    socketRef.current.emit('room:update_teams', { room_id: roomId, team_a_name: teamAName, team_b_name: teamBName })
  }, [])

  const updateVoiceState = useCallback((roomId: string, isSpeaking: boolean, isMuted: boolean) => {
    socketRef.current.emit('voice:state', { room_id: roomId, is_speaking: isSpeaking, is_muted: isMuted })
  }, [])

  const setVoiceMode = useCallback((roomId: string, mode: string, allowedRecipients: string[]) => {
    socketRef.current.emit('voice:mode', { room_id: roomId, mode, allowed_recipients: allowedRecipients })
  }, [])

  const sendVoiceSignal = useCallback((roomId: string, targetId: string, signal: unknown) => {
    socketRef.current.emit('voice:signal', { room_id: roomId, target_player_id: targetId, signal })
  }, [])

  const requestCrossTeamVoice = useCallback((roomId: string, targetId: string) => {
    socketRef.current.emit('voice:cross_team_request', { room_id: roomId, target_id: targetId })
  }, [])

  const respondCrossTeamVoice = useCallback((roomId: string, senderId: string, accept: boolean) => {
    socketRef.current.emit('voice:cross_team_response', { room_id: roomId, sender_id: senderId, accept })
  }, [])

  const revokeCrossTeamVoice = useCallback((roomId: string, targetId: string) => {
    socketRef.current.emit('voice:cross_team_revoke', { room_id: roomId, target_id: targetId })
  }, [])

  const requestVideoCall = useCallback((roomId: string, targetId: string, targetName?: string) => {
    outgoingVideoCallRef.current = targetId
    setVideoCallError(null)
    setVideoCallPeer({
      peerId: targetId,
      peerName: targetName || 'Player',
      state: 'ringing',
      direction: 'outgoing',
    })
    socketRef.current.emit('video:call_request', { room_id: roomId, target_id: targetId })
  }, [])

  const respondVideoCall = useCallback((roomId: string, callerId: string, accept: boolean) => {
    if (!accept) {
      setIncomingVideoCall((prev) =>
        prev && prev.from_player_id === callerId ? null : prev
      )
    }
    socketRef.current.emit('video:call_response', {
      room_id: roomId,
      caller_id: callerId,
      accept,
    })
  }, [])

  const endVideoCall = useCallback((roomId: string, peerId: string) => {
    outgoingVideoCallRef.current = null
    setVideoCallPeer((prev) => (prev && prev.peerId === peerId ? null : prev))
    socketRef.current.emit('video:call_end', { room_id: roomId, peer_id: peerId })
  }, [])

  const clearVideoCallError = useCallback(() => setVideoCallError(null), [])

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
    inningsBreak,
    matchFinished,
    allOutInfo,
    superOverInfo,
    clearSuperOverInfo: useCallback(() => setSuperOverInfo(null), []),
    lastError,
    pingLatency,
    voiceStates,
    pausedInfo,
    voiceSignals,
    crossTeamRequests,
    incomingVideoCall,
    videoCallPeer,
    videoCallError,
    clearVideoCallError,
    deliveryAck,
    firstBallAck,
    lobbyLeft,
    lobbyRemoved,
    lobbyRemoveAck,
    clearLobbyLeft,
    clearLobbyRemoved,
    clearLobbyRemoveAck,
    leaveLobby,
    removePlayerFromLobby,
    serverNow,
    register,
    createRoom,
    joinRoom,
    syncRoom,
    reconnect,
    startMatch,
    callToss,
    decideToss,
    firstBallReady,
    selectBowler,
    selectBatter,
    submitPick,
    pauseMatch,
    resumeMatch,
    sendChat,
    setReady,
    ackRules,
    rematchRoom,
    assignTeam,
    updateSettings,
    updateTeams,
    updateVoiceState,
    setVoiceMode,
    sendVoiceSignal,
    requestCrossTeamVoice,
    respondCrossTeamVoice,
    revokeCrossTeamVoice,
    requestVideoCall,
    respondVideoCall,
    endVideoCall,
  }
}
