/**
 * VoiceChat – Production-Ready Selective WebRTC Voice Communication.
 * Features:
 * - Dynamic STUN/TURN configuration via environment variables
 * - Master microphone mute and animated speech level visualizer
 * - Private team audio by default
 * - Cross-team mutual consent workflow (Request -> Accept / Decline -> Revoke)
 * - Independent outgoing voice permissions vs incoming listening preferences
 * - Real-time transport controls: RTCRtpSender.replaceTrack(null / track)
 * - Stale connection cleanup on team changes or permission revocation
 */

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type {
  CrossTeamVoiceRequest,
  VideoCallInvite,
  VideoCallSession,
  VoicePermissionEntry,
} from '../../services/types'
import { VideoCallPanel } from './VideoCallPanel'
import { stopVoiceSession, voiceSession } from '../../services/voiceSession'
import { useLaptopDevice } from '../../hooks/useLaptopDevice'
import styles from './VoiceChat.module.css'

// Master switch for the video surface (camera broadcast, private calls, video
// panel). It is additionally gated to laptops/desktops so phones and tablets
// never see a video affordance.
const VIDEO_CALLS_ENABLED = true

// The trigger lives inside the room header, which uses backdrop-filter. That
// makes the header a containing block for position:fixed descendants, so a
// modal rendered in place would be sized to the header instead of the screen.
const ModalPortal: React.FC<{ children: React.ReactNode }> = ({ children }) =>
  createPortal(children, document.body)

interface VoiceChatProps {
  roomId: string
  myPlayerId: string
  myDisplayName: string
  voiceStates: Record<string, { is_speaking: boolean; is_muted: boolean; player_name: string }>
  onVoiceStateChange: (roomId: string, isSpeaking: boolean, isMuted: boolean) => void
  members?: Array<{
    player: { id: string; display_name: string }
    team?: 'A' | 'B' | string | null
    is_captain?: boolean
  }>
  incomingVoiceSignals?: Array<{ id: number; from_player_id: string; signal: unknown; timestamp: number }>
  onSendSignal?: (roomId: string, targetId: string, signal: unknown) => void
  onSetVoiceMode?: (roomId: string, mode: string, allowedRecipients: string[]) => void
  isTeamMatch?: boolean
  isOpenVoiceList?: boolean
  onCloseVoiceList?: () => void
  crossTeamRequests?: CrossTeamVoiceRequest[]
  onRequestCrossTeam?: (roomId: string, targetId: string) => void
  onRespondCrossTeam?: (roomId: string, senderId: string, accept: boolean) => void
  onRevokeCrossTeam?: (roomId: string, targetId: string) => void
  voicePermissions?: VoicePermissionEntry[]
  isSoundMuted?: boolean
  /** Beta video call: network suitability, call session state and controls. */
  videoNetwork?: { allowed: boolean; reason: string; latency: number | null }
  videoCallPeer?: VideoCallSession | null
  incomingVideoCall?: VideoCallInvite | null
  onRequestVideoCall?: (roomId: string, targetId: string, targetName?: string) => void
  onRespondVideoCall?: (roomId: string, callerId: string, accept: boolean) => void
  onEndVideoCall?: (roomId: string, peerId: string) => void
  videoCallError?: string | null
  onClearVideoCallError?: () => void
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
]

function getRtcConfiguration(): RTCConfiguration {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env || {}
  if (env.VITE_ICE_SERVERS) {
    try {
      return { iceServers: JSON.parse(env.VITE_ICE_SERVERS) }
    } catch {
      // fallback
    }
  }
  const servers: RTCIceServer[] = [...DEFAULT_ICE_SERVERS]
  if (env.VITE_STUN_SERVER) {
    servers.unshift({ urls: env.VITE_STUN_SERVER })
  }
  if (env.VITE_TURN_SERVER) {
    servers.unshift({
      urls: env.VITE_TURN_SERVER,
      username: env.VITE_TURN_USERNAME,
      credential: env.VITE_TURN_PASSWORD,
    })
  }
  return { iceServers: servers }
}

function getSenderForKind(
  pc: RTCPeerConnection,
  kind: 'audio' | 'video'
): RTCRtpSender | undefined {
  return pc.getTransceivers().find((t) => t.receiver.track?.kind === kind)?.sender
}

// Only the offerer creates transceivers. Pre-creating them on the answering
// side makes Chrome answer with freshly created transceivers and strand ours
// (sender.track is set but never wired to an m-line), which produces a silent
// one-way call.
function ensureMediaTransceivers(pc: RTCPeerConnection, withVideo: boolean): void {
  if (!getSenderForKind(pc, 'audio')) pc.addTransceiver('audio', { direction: 'sendrecv' })
  if (withVideo && !getSenderForKind(pc, 'video')) {
    pc.addTransceiver('video', { direction: 'sendrecv' })
  }
}

// Transceivers created by a remote offer default to "recvonly". Unless we
// upgrade them before answering, the answer negotiates a receive-only m-line
// and the local track never leaves the machine — silent, one-way audio.
function ensureTransceiversSendRecv(pc: RTCPeerConnection): void {
  pc.getTransceivers().forEach((t) => {
    const kind = t.receiver.track?.kind
    if ((kind === 'audio' || kind === 'video') && t.direction !== 'sendrecv') {
      try {
        t.direction = 'sendrecv'
      } catch {
        // Transceiver already stopped/negotiating elsewhere — leave it.
      }
    }
  })
}

export const VoiceChat: React.FC<VoiceChatProps> = ({
  roomId,
  myPlayerId,
  myDisplayName,
  voiceStates,
  onVoiceStateChange,
  members = [],
  incomingVoiceSignals,
  onSendSignal,
  onSetVoiceMode,
  isTeamMatch = false,
  isOpenVoiceList,
  onCloseVoiceList,
  crossTeamRequests = [],
  onRequestCrossTeam,
  onRespondCrossTeam,
  onRevokeCrossTeam,
  voicePermissions = [],
  isSoundMuted = false,
  videoNetwork,
  videoCallPeer = null,
  incomingVideoCall = null,
  onRequestVideoCall,
  onRespondVideoCall,
  onEndVideoCall,
  videoCallError,
  onClearVideoCallError,
}) => {
  // The voice session outlives this component: the lobby and the arena are
  // separate routes, so it remounts when the match starts. Hydrate the UI from
  // the session instead of asking the player to connect the mic twice.
  const sessionOwnsRoom = voiceSession.roomId === roomId
  const [micEnabled, setMicEnabled] = useState(
    sessionOwnsRoom && Boolean(voiceSession.stream) && voiceSession.micEnabled
  )
  const [isMuted, setIsMuted] = useState(sessionOwnsRoom ? voiceSession.isMuted : true)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [isSpeakingLocal, setIsSpeakingLocal] = useState(false)

  // Video is a laptop/desktop-only feature.
  const isLaptop = useLaptopDevice()
  const videoEnabled = VIDEO_CALLS_ENABLED && isLaptop

  // Beta video call state: 'off' | broadcast to authorized peers | private 1:1
  const [videoMode, setVideoMode] = useState<'off' | 'broadcast' | 'call'>('off')
  const [cameraOn, setCameraOn] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [remoteVideoStreams, setRemoteVideoStreams] = useState<Record<string, MediaStream>>({})
  const videoStreamRef = useRef<MediaStream | null>(null)

  // Team Match Voice Control: tracks which teammates have outgoing voice blocked
  const [showVoiceListModal, setShowVoiceListModal] = useState(false)
  const [blockedRecipients, setBlockedRecipients] = useState<Record<string, boolean>>(
    sessionOwnsRoom ? voiceSession.blockedRecipients : {}
  )

  // Separate incoming listening preference: mute incoming audio locally per player
  const [incomingMutes, setIncomingMutes] = useState<Record<string, boolean>>(
    sessionOwnsRoom ? voiceSession.incomingMutes : {}
  )

  const mediaStreamRef = useRef<MediaStream | null>(voiceSession.stream)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number | null>(null)
  const speakingTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // WebRTC Peer Connections and Audio Output Elements. These maps are the
  // session's own maps, so transports and playback keep running while this
  // component is unmounted between routes.
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(voiceSession.peerConnections)
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(voiceSession.audioElements)
  const iceQueuesRef = useRef<Map<string, RTCIceCandidateInit[]>>(voiceSession.iceQueues)
  const processedSignalIdRef = useRef<number>(0)
  const offeredPeersRef = useRef<Set<string>>(voiceSession.offeredPeers)
  const readySentRef = useRef<Set<string>>(voiceSession.readySent)
  // Timestamp of the last refresh-driven renegotiation per peer, used as a
  // short glare cooldown when both sides turn their cameras on together.
  const videoRenegotiatedRef = useRef<Map<string, number>>(new Map())

  // Transport health bookkeeping for self-healing connections.
  const disconnectedSinceRef = useRef<Map<string, number>>(new Map())
  const lastRecoveryRef = useRef<Map<string, number>>(new Map())
  const recoverRef = useRef<(peerId: string) => void>(() => {})
  const reacquireRef = useRef<() => void>(() => {})
  const onVoiceStateChangeRef = useRef(onVoiceStateChange)

  useEffect(() => {
    onVoiceStateChangeRef.current = onVoiceStateChange
  }, [onVoiceStateChange])

  // Claim the session for this room on first mount (but never steal it from a
  // different room — that one is torn down by the adoption effect below).
  useEffect(() => {
    if (voiceSession.roomId === null || voiceSession.roomId === roomId) {
      voiceSession.roomId = roomId
    }
  }, [roomId])

  // Mirror the page state into the session so the next route and the recovery
  // handlers see the same preferences.
  useEffect(() => {
    if (voiceSession.roomId !== roomId) return
    voiceSession.micEnabled = micEnabled
    voiceSession.isMuted = isMuted
    voiceSession.blockedRecipients = blockedRecipients
    voiceSession.incomingMutes = incomingMutes
  }, [roomId, micEnabled, isMuted, blockedRecipients, incomingMutes])

  // Identify current player's team
  const myMem = members.find((m) => m.player.id === myPlayerId)
  const myTeam = myMem?.team

  // Synchronize external modal trigger if provided
  useEffect(() => {
    if (isOpenVoiceList !== undefined) {
      setShowVoiceListModal(isOpenVoiceList)
    }
  }, [isOpenVoiceList])

  // Helper to check if cross-team mutual consent exists between myself and an opponent
  const isMutualConsentActive = useCallback(
    (peerId: string): boolean => {
      if (!isTeamMatch) return true
      const mem = members.find((m) => m.player.id === peerId)
      if (mem?.team === myTeam) return true // teammates do not need cross-team mutual consent
      return voicePermissions.some(
        (vp) =>
          vp.status === 'MUTUAL_ACCEPTED' &&
          ((vp.sender_id === myPlayerId && vp.receiver_id === peerId) ||
            (vp.sender_id === peerId && vp.receiver_id === myPlayerId))
      )
    },
    [isTeamMatch, members, myTeam, myPlayerId, voicePermissions]
  )

  // Helper to check if I have sent a pending request to an opponent
  const isRequestPending = useCallback(
    (peerId: string): boolean => {
      return voicePermissions.some(
        (vp) =>
          vp.status === 'PENDING_REQUEST' && vp.sender_id === myPlayerId && vp.receiver_id === peerId
      )
    },
    [voicePermissions, myPlayerId]
  )

  // Can this peer be reached at all (teammate, SOLO opponent, or consented
  // opponent in a team match)? The server rejects signalling otherwise.
  const isMediaAuthorized = useCallback(
    (peerId: string): boolean => {
      if (!isTeamMatch) return true
      const mem = members.find((m) => m.player.id === peerId)
      return mem?.team === myTeam || isMutualConsentActive(peerId)
    },
    [isTeamMatch, members, myTeam, isMutualConsentActive]
  )

  // Whether my outgoing voice is blocked for this peer. Teammates (and the
  // SOLO opponent) use the local block list; opponents additionally need
  // mutual cross-team consent.
  const isVoiceBlockedFor = useCallback(
    (peerId: string, blockedMap: Record<string, boolean>): boolean => {
      const mem = members.find((m) => m.player.id === peerId)
      const isOpponent = isTeamMatch && mem?.team !== myTeam
      if (isOpponent) return !isMutualConsentActive(peerId)
      return Boolean(blockedMap[peerId])
    },
    [isTeamMatch, members, myTeam, isMutualConsentActive]
  )

  // Apply real-time transport permissions to WebRTC senders
  const applyVoicePermissions = useCallback(
    (blockedMap: Record<string, boolean>) => {
      const localTrack = mediaStreamRef.current?.getAudioTracks()[0]
      peerConnectionsRef.current.forEach((pc, peerId) => {
        const shouldBlock = isVoiceBlockedFor(peerId, blockedMap)
        const sender = getSenderForKind(pc, 'audio')
        if (!sender) return
        if (!shouldBlock && localTrack && localTrack.enabled && !isMuted) {
          sender.replaceTrack(localTrack).catch(() => {})
        } else {
          sender.replaceTrack(null).catch(() => {})
        }
      })
    },
    [isMuted, isVoiceBlockedFor]
  )

  // Keep audio routing in sync with mute/block state. Enabling the mic runs
  // once with the pre-unmute state, so without this every sender would stay
  // trackless (silent call) until the user toggled mute a second time.
  useEffect(() => {
    applyVoicePermissions(blockedRecipients)
  }, [applyVoicePermissions, blockedRecipients])

  // Bind the local camera to a transport's video m-line, honouring call vs
  // broadcast targeting. Must run after the transceiver exists (offerer) or
  // after the remote offer created it (answerer).
  const bindVideoTrack = useCallback(
    (pc: RTCPeerConnection, peerId: string) => {
      if (!videoEnabled || videoMode === 'off') return
      const sender = getSenderForKind(pc, 'video')
      if (!sender) return
      const track = videoStreamRef.current?.getVideoTracks()[0] ?? null
      const shouldSend =
        Boolean(track) &&
        (videoMode === 'call'
          ? videoCallPeer?.state === 'active' && videoCallPeer.peerId === peerId
          : isMediaAuthorized(peerId) && !isVoiceBlockedFor(peerId, blockedRecipients))
      sender.replaceTrack(shouldSend ? track : null).catch(() => {})
    },
    [videoEnabled, videoMode, videoCallPeer, isMediaAuthorized, isVoiceBlockedFor, blockedRecipients]
  )

  // Wire a transport to this page's callbacks. Rebinding on remount keeps the
  // handlers pointed at the live page's socket helpers instead of the closures
  // of the page that has already unmounted.
  const bindPeerHandlers = useCallback(
    (pc: RTCPeerConnection, peerId: string) => {
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          disconnectedSinceRef.current.delete(peerId)
          return
        }
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          recoverRef.current(peerId)
        }
      }

      // Send local ICE candidates to the remote peer
      pc.onicecandidate = (event) => {
        if (event.candidate && onSendSignal) {
          onSendSignal(roomId, peerId, {
            type: 'candidate',
            candidate: event.candidate.toJSON(),
          })
        }
      }

      // Incoming video: publish the remote stream while the sender is actually
      // transmitting (track unmuted) and drop the tile when they stop.
      pc.ontrack = (event) => {
        if (event.track.kind === 'video') {
          const publish = () =>
            setRemoteVideoStreams((prev) => ({ ...prev, [peerId]: new MediaStream([event.track]) }))
          const retract = () =>
            setRemoteVideoStreams((prev) => {
              if (!(peerId in prev)) return prev
              const next = { ...prev }
              delete next[peerId]
              return next
            })
          event.track.onunmute = publish
          event.track.onmute = retract
          if (!event.track.muted) publish()
          return
        }

        let audio = audioElementsRef.current.get(peerId)
        if (!audio) {
          audio = document.createElement('audio')
          audio.autoplay = true
          audio.setAttribute('playsinline', 'true')
          audio.setAttribute('webkit-playsinline', 'true')
          audio.setAttribute('data-peer-id', peerId)
          // Kept in the layout (not display:none) — some mobile browsers refuse
          // to start playback for fully hidden elements.
          audio.style.cssText =
            'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;'
          document.body.appendChild(audio)
          audioElementsRef.current.set(peerId, audio)
        }
        const stream = event.streams[0] || new MediaStream([event.track])
        audio.srcObject = stream
        // Apply master sound mute and per-player incoming mute preference
        const isLocallyMuted = Boolean(incomingMutes[peerId]) || Boolean(isSoundMuted)
        audio.muted = isLocallyMuted
        audio.volume = isLocallyMuted ? 0 : 1.0
        const playPromise = audio.play()
        if (playPromise !== undefined) {
          playPromise.catch((err) => {
            console.warn('Audio auto-play prevented by browser policy (will resume on click):', err)
          })
        }
      }
    },
    [roomId, onSendSignal, incomingMutes, isSoundMuted]
  )
  const bindPeerHandlersRef = useRef(bindPeerHandlers)
  useEffect(() => {
    bindPeerHandlersRef.current = bindPeerHandlers
  }, [bindPeerHandlers])

  // Helper to create or get an RTCPeerConnection for a given peer ID
  const getOrCreatePeerConnection = useCallback(
    (peerId: string): RTCPeerConnection => {
      const existing = peerConnectionsRef.current.get(peerId)
      if (existing && existing.connectionState !== 'closed') {
        return existing
      }

      const pc = new RTCPeerConnection(getRtcConfiguration())
      peerConnectionsRef.current.set(peerId, pc)
      bindPeerHandlersRef.current(pc, peerId)

      // Re-attach an in-progress camera to a freshly created transport
      // (e.g. after a cross-team pair becomes authorized).
      const videoTrack = videoStreamRef.current?.getVideoTracks()[0]
      if (videoTrack && videoMode !== 'off') {
        const shouldSend =
          videoMode === 'call'
            ? videoCallPeer?.state === 'active' && videoCallPeer.peerId === peerId
            : !isVoiceBlockedFor(peerId, blockedRecipients)
        getSenderForKind(pc, 'video')
          ?.replaceTrack(shouldSend ? videoTrack : null)
          .catch(() => {})
      }

      return pc
    },
    [blockedRecipients, isVoiceBlockedFor, videoMode, videoCallPeer]
  )

  // Attach local tracks to all existing peer connections respecting blocked state
  const addLocalTracksToAllPeers = useCallback(
    (stream: MediaStream, forceUnmuted = false) => {
      const muted = forceUnmuted ? false : isMuted
      peerConnectionsRef.current.forEach((pc, peerId) => {
        const isBlocked = isVoiceBlockedFor(peerId, blockedRecipients)
        const track = stream.getAudioTracks()[0]
        const sender = getSenderForKind(pc, 'audio')
        if (track && sender) {
          sender.replaceTrack(isBlocked || muted ? null : track).catch(() => {})
        }
      })
    },
    [blockedRecipients, isMuted, isVoiceBlockedFor]
  )

  // Speech metering is page-local (it only drives the speaking indicator), so
  // it is rebuilt on every mount around the session's stream.
  const startMetering = useCallback(
    (stream: MediaStream) => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current)
        animFrameRef.current = null
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {})
      }

      const AudioCtx =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new AudioCtx()
      audioContextRef.current = ctx
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})

      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.4
      source.connect(analyser)
      analyserRef.current = analyser

      // Speech detection loop
      const pcmData = new Uint8Array(analyser.frequencyBinCount)
      let wasSpeaking = false

      const checkVolume = () => {
        const current = analyserRef.current
        if (!current) return
        current.getByteFrequencyData(pcmData)

        let sum = 0
        for (let i = 0; i < pcmData.length; i++) {
          sum += pcmData[i]
        }
        const avg = sum / pcmData.length
        const isSpeakingNow = avg > 18 // Sensitivity threshold

        if (isSpeakingNow !== wasSpeaking) {
          wasSpeaking = isSpeakingNow
          setIsSpeakingLocal(isSpeakingNow)

          if (isSpeakingNow) {
            if (speakingTimeoutRef.current) clearTimeout(speakingTimeoutRef.current)
            onVoiceStateChange(roomId, true, false)
          } else {
            speakingTimeoutRef.current = setTimeout(() => {
              onVoiceStateChange(roomId, false, false)
            }, 600)
          }
        }

        animFrameRef.current = requestAnimationFrame(checkVolume)
      }

      animFrameRef.current = requestAnimationFrame(checkVolume)

      // A device that disappears (headset unplugged, OS mic switch) ends the
      // track; re-open the device instead of going silent for the rest of the
      // match.
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => reacquireRef.current()
      })
    },
    [roomId, onVoiceStateChange]
  )

  // Initialize Microphone Media Stream and start signaling
  const initMicrophone = useCallback(async () => {
    try {
      setPermissionError(null)
      if (!navigator.mediaDevices?.getUserMedia) {
        setPermissionError(
          window.isSecureContext
            ? 'This browser does not expose microphone access.'
            : 'Microphone needs a secure connection. Open the app over HTTPS (or localhost) to talk.'
        )
        return
      }

      // Reuse the session stream when the previous route already opened the
      // mic: the player must never have to grant it twice in one match.
      const existing = voiceSession.stream
      const stream =
        existing && existing.getAudioTracks().some((track) => track.readyState === 'live')
          ? existing
          : await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            })
      mediaStreamRef.current = stream
      voiceSession.stream = stream
      voiceSession.roomId = roomId

      startMetering(stream)

      // Unmute stream
      stream.getAudioTracks().forEach((t) => {
        t.enabled = true
      })
      setIsMuted(false)
      setMicEnabled(true)
      voiceSession.micEnabled = true
      voiceSession.isMuted = false
      onVoiceStateChange(roomId, false, false)

      // Attach tracks to all existing peer connections. The mic is live from
      // this point, so ignore the stale (pre-unmute) isMuted value.
      addLocalTracksToAllPeers(stream, true)
    } catch (err) {
      console.error('Microphone access denied:', err)
      setPermissionError('Microphone permission denied. Allow mic access in your browser to talk.')
      setMicEnabled(false)
      setIsMuted(true)
      voiceSession.micEnabled = false
      voiceSession.isMuted = true
    }
  }, [roomId, onVoiceStateChange, addLocalTracksToAllPeers, startMetering])

  // Re-open a microphone whose track died mid-match and route it into every
  // live transport. Rate-limited so a revoked permission cannot spin.
  const reacquireMicrophone = useCallback(async () => {
    if (!voiceSession.stream && !voiceSession.micEnabled) return
    const now = Date.now()
    if (now - (lastRecoveryRef.current.get('__mic__') ?? 0) < 4000) return
    lastRecoveryRef.current.set('__mic__', now)

    const stream = voiceSession.stream
    if (stream?.getAudioTracks().some((track) => track.readyState === 'live')) return
    if (!navigator.mediaDevices?.getUserMedia) return

    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      stream?.getTracks().forEach((track) => {
        try {
          track.stop()
        } catch {
          // already stopped
        }
      })
      fresh.getAudioTracks().forEach((track) => {
        track.enabled = !voiceSession.isMuted
      })
      voiceSession.stream = fresh
      mediaStreamRef.current = fresh
      startMetering(fresh)
      addLocalTracksToAllPeers(fresh, !voiceSession.isMuted)
    } catch (err) {
      console.warn('Microphone re-acquisition failed:', err)
    }
  }, [startMetering, addLocalTracksToAllPeers])
  useEffect(() => {
    reacquireRef.current = () => {
      void reacquireMicrophone()
    }
  }, [reacquireMicrophone])

  // Adopt the session the previous route left behind. The lobby and the arena
  // are distinct routes, so this component remounts when the match starts and
  // again when it returns to the lobby; the microphone, transports and audio
  // outputs must keep running through that transition.
  const hasAdoptedRef = useRef(false)
  useEffect(() => {
    if (hasAdoptedRef.current) return
    hasAdoptedRef.current = true

    // A session belonging to another room is stale — do not carry it over.
    if (voiceSession.roomId && voiceSession.roomId !== roomId) {
      stopVoiceSession()
      mediaStreamRef.current = null
      setMicEnabled(false)
      setIsMuted(true)
      return
    }

    const stream = voiceSession.stream
    if (!stream) return

    mediaStreamRef.current = stream

    // Point every surviving transport at this page's callbacks; the old
    // closures reference an unmounted page's socket helpers.
    peerConnectionsRef.current.forEach((pc, peerId) => {
      bindPeerHandlersRef.current(pc, peerId)
    })

    // Outputs created on the previous route live in document.body and must
    // keep playing, but the browser may have paused them on navigation.
    audioElementsRef.current.forEach((audio) => {
      if (audio.paused && audio.srcObject && !audio.muted) audio.play().catch(() => {})
    })

    // Mobile browsers end tracks after long backgrounding; re-open instead of
    // leaving a dead publish behind.
    if (stream.getAudioTracks().some((track) => track.readyState === 'live')) {
      startMetering(stream)
    } else {
      reacquireRef.current()
    }
  }, [roomId, startMetering])

  const destroyPeer = useCallback((peerId: string) => {
    const pc = peerConnectionsRef.current.get(peerId)
    peerConnectionsRef.current.delete(peerId)
    offeredPeersRef.current.delete(peerId)
    readySentRef.current.delete(peerId)
    iceQueuesRef.current.delete(peerId)
    disconnectedSinceRef.current.delete(peerId)
    if (pc) {
      // Detach first: a close we initiated must not look like a transport
      // failure to the recovery path.
      pc.onconnectionstatechange = null
      pc.onicecandidate = null
      pc.ontrack = null
      try {
        pc.close()
      } catch {
        // already closed
      }
    }
    const audio = audioElementsRef.current.get(peerId)
    if (audio) {
      audio.pause()
      audio.srcObject = null
      audio.remove()
      audioElementsRef.current.delete(peerId)
    }
    setRemoteVideoStreams((prev) => {
      if (!(peerId in prev)) return prev
      const next = { ...prev }
      delete next[peerId]
      return next
    })
  }, [])

  // Start a negotiation on a transport we own (we are the offerer).
  const sendOffer = useCallback(
    async (pc: RTCPeerConnection, peerId: string) => {
      if (pc.signalingState !== 'stable') return
      try {
        ensureMediaTransceivers(pc, videoEnabled && videoMode !== 'off')
        bindVideoTrack(pc, peerId)
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        // A live mic must be bound to the m-line we just created; the
        // transceiver does not exist before this point.
        applyVoicePermissions(blockedRecipients)
        onSendSignal?.(roomId, peerId, { type: 'offer', sdp: offer })
      } catch (err) {
        offeredPeersRef.current.delete(peerId)
        console.warn('Error creating offer:', err)
      }
    },
    [roomId, onSendSignal, applyVoicePermissions, blockedRecipients, videoMode, videoEnabled, bindVideoTrack]
  )

  // Rebuild a transport that reported failure and renegotiate, so a network
  // swap heals mid-match instead of leaving the pair silent. Rate-limited per
  // peer: an unreachable network must not spin.
  const recoverPeer = useCallback(
    (peerId: string) => {
      if (!roomId || !onSendSignal) return
      const now = Date.now()
      if (now - (lastRecoveryRef.current.get(peerId) ?? 0) < 3000) return
      lastRecoveryRef.current.set(peerId, now)
      disconnectedSinceRef.current.delete(peerId)

      destroyPeer(peerId)
      onSendSignal(roomId, peerId, { type: 'restart' })

      const pc = getOrCreatePeerConnection(peerId)
      if (myPlayerId > peerId) {
        offeredPeersRef.current.add(peerId)
        void sendOffer(pc, peerId)
      } else {
        readySentRef.current.add(peerId)
        onSendSignal(roomId, peerId, { type: 'ready' })
      }
    },
    [roomId, onSendSignal, myPlayerId, destroyPeer, getOrCreatePeerConnection, sendOffer]
  )
  useEffect(() => {
    recoverRef.current = recoverPeer
  }, [recoverPeer])

  // Renegotiate on the live transport so a camera change adds a video m-line
  // without dropping healthy audio. Only the deterministic offerer (higher id)
  // creates the offer; if a negotiation is already in flight, wait for it to
  // settle instead of losing the change.
  const renegotiatePeer = useCallback(
    (peerId: string, attempt = 0) => {
      if (!onSendSignal) return
      const pc = getOrCreatePeerConnection(peerId)
      if (pc.signalingState !== 'stable') {
        if (attempt < 5) {
          window.setTimeout(() => renegotiatePeer(peerId, attempt + 1), 800)
        }
        return
      }
      ensureMediaTransceivers(pc, true)
      offeredPeersRef.current.add(peerId)
      void sendOffer(pc, peerId)
    },
    [getOrCreatePeerConnection, sendOffer, onSendSignal]
  )

  // Handle incoming WebRTC signaling from peers. Signals are processed as an
  // ordered queue because React batches state updates: a single-value slot
  // silently loses offer/answer/candidate messages that arrive together.
  useEffect(() => {
    const pending = (incomingVoiceSignals || []).filter((s) => s.id > processedSignalIdRef.current)
    if (!pending.length) return
    processedSignalIdRef.current = pending[pending.length - 1].id

    const flushCandidates = async (pc: RTCPeerConnection, peerId: string) => {
      const queue = iceQueuesRef.current.get(peerId) || []
      for (const cand of queue) {
        await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {})
      }
      iceQueuesRef.current.set(peerId, [])
    }

    const run = async () => {
      for (const entry of pending) {
        const fromPlayerId = entry.from_player_id
        const data = entry.signal as {
          type: string
          sdp?: RTCSessionDescriptionInit
          candidate?: RTCIceCandidateInit
        }
        if (!data || !data.type) continue


        let pc = getOrCreatePeerConnection(fromPlayerId)
        if (data.type === 'ready') {
          if (
            myPlayerId > fromPlayerId &&
            !offeredPeersRef.current.has(fromPlayerId) &&
            pc.signalingState === 'stable' &&
            pc.connectionState !== 'connected' &&
            pc.connectionState !== 'connecting'
          ) {
            offeredPeersRef.current.add(fromPlayerId)
            await sendOffer(pc, fromPlayerId)
          }
        } else if (data.type === 'offer' && data.sdp) {
          try {
            // A transport that already reported failure cannot be revived by a
            // renegotiation, and the offer carries the peer's fresh ICE
            // credentials — start from a clean transport so they apply.
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
              destroyPeer(fromPlayerId)
              pc = getOrCreatePeerConnection(fromPlayerId)
            }
            // Deterministic roles prevent most glare; if it still happens the
            // lower id is the polite peer and rolls its own offer back.
            if (pc.signalingState === 'have-local-offer' && myPlayerId < fromPlayerId) {
              await pc.setLocalDescription({ type: 'rollback' })
            }
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
            await flushCandidates(pc, fromPlayerId)

            ensureTransceiversSendRecv(pc)
            // Bind our camera to the video m-line the remote offer created.
            bindVideoTrack(pc, fromPlayerId)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            // Bind our mic to the m-line the remote offer created.
            applyVoicePermissions(blockedRecipients)
            onSendSignal?.(roomId, fromPlayerId, { type: 'answer', sdp: answer })
          } catch (err) {
            console.warn('Error handling offer:', err)
          }
        } else if (data.type === 'answer' && data.sdp) {
          try {
            if (pc.signalingState === 'have-local-offer') {
              await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
              await flushCandidates(pc, fromPlayerId)
              applyVoicePermissions(blockedRecipients)
            }
          } catch (err) {
            console.warn('Error handling answer:', err)
          }
        } else if (data.type === 'restart') {
          // The peer rebuilt its transport, so ours is now part of a dead
          // session. Rebuild ours too and renegotiate symmetrically from a
          // clean state, whichever side detected the failure.
          destroyPeer(fromPlayerId)
          const fresh = getOrCreatePeerConnection(fromPlayerId)
          if (myPlayerId > fromPlayerId) {
            offeredPeersRef.current.add(fromPlayerId)
            await sendOffer(fresh, fromPlayerId)
          } else {
            readySentRef.current.add(fromPlayerId)
            onSendSignal?.(roomId, fromPlayerId, { type: 'ready' })
          }
        } else if (data.type === 'refresh') {
          // The peer's media set changed (e.g. camera turned on). Renegotiate
          // on the existing transport; tearing it down would cut live audio.
          // The short cooldown absorbs the simultaneous camera-on case (both
          // sides refresh at once) without blocking a later camera restart.
          if (myPlayerId > fromPlayerId) {
            const last = videoRenegotiatedRef.current.get(fromPlayerId) ?? 0
            if (Date.now() - last > 1500) {
              videoRenegotiatedRef.current.set(fromPlayerId, Date.now())
              renegotiatePeer(fromPlayerId)
            }
          }
        } else if (data.type === 'candidate' && data.candidate) {
          try {
            if (pc.remoteDescription && pc.remoteDescription.type) {
              await pc.addIceCandidate(new RTCIceCandidate(data.candidate))
            } else {
              const queue = iceQueuesRef.current.get(fromPlayerId) || []
              queue.push(data.candidate)
              iceQueuesRef.current.set(fromPlayerId, queue)
            }
          } catch (err) {
            console.warn('Error adding ICE candidate:', err)
          }
        }
      }
    }

    void run()
  }, [incomingVoiceSignals, getOrCreatePeerConnection, onSendSignal, roomId, myPlayerId, applyVoicePermissions, blockedRecipients, sendOffer, destroyPeer, bindVideoTrack, renegotiatePeer])

  // Watchdog: browsers report ICE failure lazily and can leave a transport
  // "disconnected" indefinitely after a network swap. Rebuild anything that
  // stays down so the call heals without asking the player to reconnect.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      peerConnectionsRef.current.forEach((pc, peerId) => {
        if (pc.connectionState === 'connected') {
          disconnectedSinceRef.current.delete(peerId)
          return
        }
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          recoverRef.current(peerId)
          return
        }
        if (pc.connectionState === 'disconnected') {
          const since = disconnectedSinceRef.current.get(peerId) ?? now
          disconnectedSinceRef.current.set(peerId, since)
          if (now - since >= 6000) recoverRef.current(peerId)
          return
        }
        // A dropped ready/offer signal leaves a pair stuck in `new` (no offer
        // ever applied) or `connecting` (ICE never completes). Both sides run
        // this watchdog, so re-running the handshake heals a lost signal
        // without making the player reload.
        const since = disconnectedSinceRef.current.get(peerId) ?? now
        disconnectedSinceRef.current.set(peerId, since)
        if (now - since >= 10000) recoverRef.current(peerId)
      })
    }, 2000)
    return () => clearInterval(timer)
  }, [])

  // Establish WebRTC connections once per authorized peer (not once per
  // snapshot). Cross-team pairs are skipped until mutual consent is granted:
  // the server rejects their signalling, so negotiating earlier would leave a
  // dead transport behind and silence the pair after approval.
  useEffect(() => {
    if (!roomId) return
    const others = members.filter((m) => m.player.id !== myPlayerId)
    const peerIds = new Set(others.map((m) => m.player.id))
    Array.from(offeredPeersRef.current).forEach((id) => {
      if (!peerIds.has(id)) offeredPeersRef.current.delete(id)
    })
    Array.from(readySentRef.current).forEach((id) => {
      if (!peerIds.has(id)) readySentRef.current.delete(id)
    })
    // Release transports for players who left, so the recovery watchdog does
    // not keep trying to heal a pair that no longer exists.
    Array.from(peerConnectionsRef.current.keys()).forEach((id) => {
      if (!peerIds.has(id)) destroyPeer(id)
    })

    others.forEach((m) => {
      if (!isMediaAuthorized(m.player.id)) {
        // Consent revoked (or not granted yet): tear the transport down so no
        // media keeps flowing and a later grant starts from a clean state.
        destroyPeer(m.player.id)
        return
      }

      const pc = getOrCreatePeerConnection(m.player.id)

      if (!readySentRef.current.has(m.player.id)) {
        readySentRef.current.add(m.player.id)
        onSendSignal?.(roomId, m.player.id, { type: 'ready' })
      }

      // Higher player id is the sole offerer for this pair.
      if (myPlayerId <= m.player.id) return
      if (offeredPeersRef.current.has(m.player.id)) return
      if (pc.signalingState !== 'stable') return
      // A transport that survived the last route change is already negotiated;
      // re-offering would only churn the live call.
      if (pc.connectionState === 'connected' || pc.connectionState === 'connecting') {
        offeredPeersRef.current.add(m.player.id)
        return
      }

      offeredPeersRef.current.add(m.player.id)
      void sendOffer(pc, m.player.id)
    })
  }, [members, myPlayerId, roomId, onSendSignal, getOrCreatePeerConnection, isMediaAuthorized, destroyPeer, sendOffer])

  // Synchronize master Sound On / Off setting to physical audio playback elements
  useEffect(() => {
    audioElementsRef.current.forEach((audio, peerId) => {
      const isMuted = Boolean(incomingMutes[peerId]) || Boolean(isSoundMuted)
      audio.muted = isMuted
      audio.volume = isMuted ? 0 : 1.0
      if (!isMuted && audio.paused && audio.srcObject) {
        audio.play().catch((err) => {
          console.warn('Audio auto-play prevented (will resume on click):', err)
        })
      }
    })
  }, [isSoundMuted, incomingMutes])

  // Toggle Mute / Unmute
  const toggleMute = () => {
    // Resume any blocked audio on user click
    audioElementsRef.current.forEach((audio) => {
      if (audio.paused && audio.srcObject) {
        audio.play().catch(() => {})
      }
    })
    if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().catch(() => {})
    }

    if (!micEnabled) {
      initMicrophone()
      return
    }

    const nextMuted = !isMuted
    setIsMuted(nextMuted)
    voiceSession.isMuted = nextMuted
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = !nextMuted
      })
    }
    if (nextMuted) {
      setIsSpeakingLocal(false)
    }
    onVoiceStateChange(roomId, false, nextMuted)

    // Update WebRTC audio senders immediately
    peerConnectionsRef.current.forEach((pc, peerId) => {
      const sender = getSenderForKind(pc, 'audio')
      if (!sender) return
      const localTrack = mediaStreamRef.current?.getAudioTracks()[0]
      const isBlocked = isVoiceBlockedFor(peerId, blockedRecipients)
      if (!nextMuted && !isBlocked && localTrack) {
        sender.replaceTrack(localTrack).catch(() => {})
      } else {
        sender.replaceTrack(null).catch(() => {})
      }
    })
  }

  // ---------------------------------------------------------------------
  // Beta video call: camera capture, broadcast mode and private 1:1 calls
  // ---------------------------------------------------------------------

  const stopCameraStream = useCallback(() => {
    videoStreamRef.current?.getTracks().forEach((track) => track.stop())
    videoStreamRef.current = null
    setCameraOn(false)
  }, [])

  const ensureCamera = useCallback(async (): Promise<boolean> => {
    if (!videoEnabled) return false
    if (videoStreamRef.current) return true
    if (!videoNetwork?.allowed) {
      setCameraError(videoNetwork?.reason || 'Network is not good enough for video right now.')
      return false
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 15, max: 24 },
          facingMode: 'user',
        },
        audio: false,
      })
      videoStreamRef.current = stream
      setCameraError(null)
      setCameraOn(true)
      return true
    } catch (err) {
      console.warn('Camera access denied or unavailable:', err)
      setCameraError('Camera permission denied or the camera is in use by another app.')
      return false
    }
  }, [videoEnabled, videoNetwork?.allowed, videoNetwork?.reason])

  // Keep every authorized peer's video sender in sync with the current mode:
  // broadcast = everyone who may hear me, call = only the call partner.
  useEffect(() => {
    const track = videoStreamRef.current?.getVideoTracks()[0] ?? null
    const callPeerId = videoCallPeer?.state === 'active' ? videoCallPeer.peerId : null
    peerConnectionsRef.current.forEach((pc, peerId) => {
      const shouldSend =
        Boolean(track) &&
        (videoMode === 'call'
          ? callPeerId === peerId
          : videoMode === 'broadcast'
            ? isMediaAuthorized(peerId) && !isVoiceBlockedFor(peerId, blockedRecipients)
            : false)
      getSenderForKind(pc, 'video')
        ?.replaceTrack(shouldSend ? track : null)
        .catch(() => {})
    })
  }, [videoMode, cameraOn, videoCallPeer, isMediaAuthorized, isVoiceBlockedFor, blockedRecipients, members])

  // Turning the camera on after an audio-only handshake needs a video m-line.
  // Rebuild the pair once per camera-on transition so both sides renegotiate
  // with video; stopping the camera only needs replaceTrack(null).
  const videoNegotiatedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const activePeerId = videoCallPeer?.state === 'active' ? videoCallPeer.peerId : null
    const active =
      videoEnabled && cameraOn && videoMode !== 'off' && (videoMode === 'broadcast' || activePeerId)
    if (!active) {
      videoNegotiatedKeyRef.current = null
      return
    }
    const key = videoMode === 'call' ? `call:${activePeerId}` : 'broadcast'
    if (videoNegotiatedKeyRef.current === key) return
    videoNegotiatedKeyRef.current = key
    videoRenegotiatedRef.current.clear()

    const targets =
      videoMode === 'call' && activePeerId
        ? [activePeerId]
        : Array.from(peerConnectionsRef.current.keys()).filter((id) => isMediaAuthorized(id))

    targets.forEach((peerId) => {
      // Audio is already flowing on this transport; adding the video m-line is
      // a renegotiation, not a rebuild.
      onSendSignal?.(roomId, peerId, { type: 'refresh' })
      if (myPlayerId > peerId) {
        videoRenegotiatedRef.current.set(peerId, Date.now())
        renegotiatePeer(peerId)
      }
    })
  }, [
    videoEnabled,
    cameraOn,
    videoMode,
    videoCallPeer,
    isMediaAuthorized,
    getOrCreatePeerConnection,
    sendOffer,
    onSendSignal,
    roomId,
    myPlayerId,
    renegotiatePeer,
  ])

  // A private call that ends (or is declined) always releases the camera.
  // `incomingVideoCall` stays set between accepting locally and the server's
  // accepted event arriving; without that guard the callee tears down its
  // camera in that gap and never transmits video.
  useEffect(() => {
    if (videoMode === 'call' && !videoCallPeer && !incomingVideoCall) {
      stopCameraStream()
      setVideoMode('off')
    }
  }, [videoMode, videoCallPeer, incomingVideoCall, stopCameraStream])

  // The network gate only decides whether a call may *start* (button disabled,
  // ensureCamera refuses). Once media is live, a momentary latency spike must
  // not tear the call down: WebRTC already adapts its bitrate, and killing the
  // camera mid-call left the peer with a one-way (recvonly) video stream.
  const networkAllowed = videoNetwork?.allowed ?? false

  // Release the camera if the device stops qualifying as a laptop (e.g. the
  // window is emulated as a phone) and stop any video surface from lingering.
  useEffect(() => {
    if (!videoEnabled && videoMode !== 'off') {
      stopCameraStream()
      setVideoMode('off')
    }
  }, [videoEnabled, videoMode, stopCameraStream])

  // Phones/tablets never expose the video UI, so decline an invitation instead
  // of leaving a laptop caller ringing until the 45s timeout.
  useEffect(() => {
    if (videoEnabled || !incomingVideoCall || !onRespondVideoCall) return
    onRespondVideoCall(roomId, incomingVideoCall.from_player_id, false)
  }, [videoEnabled, incomingVideoCall, onRespondVideoCall, roomId])

  const toggleBroadcastCamera = async () => {
    if (videoMode === 'broadcast') {
      stopCameraStream()
      setVideoMode('off')
      return
    }
    if (videoMode === 'call') {
      // Inside a private call this only stops sending video, audio stays live.
      if (cameraOn) stopCameraStream()
      else await ensureCamera()
      return
    }
    const started = await ensureCamera()
    if (started) setVideoMode('broadcast')
  }

  const startPrivateVideoCall = async (peerId: string) => {
    if (!onRequestVideoCall) return
    if (videoCallPeer) return
    const started = await ensureCamera()
    if (!started) return
    setVideoMode('call')
    const targetName = members.find((m) => m.player.id === peerId)?.player.display_name
    onRequestVideoCall(roomId, peerId, targetName)
    setShowVoiceListModal(false)
    onCloseVoiceList?.()
  }

  const acceptIncomingVideoCall = async () => {
    if (!incomingVideoCall || !onRespondVideoCall) return
    const callerId = incomingVideoCall.from_player_id
    const started = await ensureCamera()
    if (!started) {
      // Without a working camera the caller would get a silent one-way video;
      // decline instead and let the cameraError banner explain why.
      onRespondVideoCall(roomId, callerId, false)
      return
    }
    setVideoMode('call')
    onRespondVideoCall(roomId, callerId, true)
  }

  const declineIncomingVideoCall = () => {
    if (!incomingVideoCall || !onRespondVideoCall) return
    onRespondVideoCall(roomId, incomingVideoCall.from_player_id, false)
  }

  const endPrivateVideoCall = () => {
    if (videoCallPeer) onEndVideoCall?.(roomId, videoCallPeer.peerId)
    stopCameraStream()
    setVideoMode('off')
  }

  // Toggle outgoing voice for teammates: talk (blocked=false) or block your voice (blocked=true)
  const setPlayerVoice = (peerId: string, blocked: boolean) => {
    setBlockedRecipients((prev) => {
      const updated = { ...prev, [peerId]: blocked }
      applyVoicePermissions(updated)
      if (onSetVoiceMode && roomId) {
        const allowed = members
          .filter((m) => m.player.id !== myPlayerId && !updated[m.player.id])
          .map((m) => m.player.id)
        onSetVoiceMode(roomId, 'CUSTOM', allowed)
      }
      return updated
    })
  }

  // Toggle incoming listening preference for any player
  const toggleIncomingMute = (peerId: string) => {
    setIncomingMutes((prev) => {
      const nextMuted = !prev[peerId]
      const audio = audioElementsRef.current.get(peerId)
      if (audio) {
        audio.muted = nextMuted
        audio.volume = nextMuted ? 0 : 1.0
        if (!nextMuted && audio.paused && audio.srcObject) {
          audio.play().catch(() => {})
        }
      }
      return { ...prev, [peerId]: nextMuted }
    })
  }

  // Document interaction audio unlocker (resumes any browser-blocked audio outputs)
  useEffect(() => {
    const resumeAllAudio = () => {
      audioElementsRef.current.forEach((audio) => {
        if (audio.paused && audio.srcObject && !audio.muted) {
          audio.play().catch(() => {})
        }
      })
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().catch(() => {})
      }
    }

    window.addEventListener('click', resumeAllAudio, { passive: true })
    window.addEventListener('touchstart', resumeAllAudio, { passive: true })
    window.addEventListener('keydown', resumeAllAudio, { passive: true })

    return () => {
      window.removeEventListener('click', resumeAllAudio)
      window.removeEventListener('touchstart', resumeAllAudio)
      window.removeEventListener('keydown', resumeAllAudio)
    }
  }, [])

  // Mobile browsers suspend media while the page is backgrounded. When the
  // player comes back, resume playback, re-open a dead mic and rebuild any
  // transport that died in the meantime — without a manual reconnect.
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState !== 'visible') return
      audioElementsRef.current.forEach((audio) => {
        if (audio.paused && audio.srcObject && !audio.muted) audio.play().catch(() => {})
      })
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().catch(() => {})
      }
      peerConnectionsRef.current.forEach((pc, peerId) => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          recoverRef.current(peerId)
        }
      })
      const stream = voiceSession.stream
      if (stream && !stream.getAudioTracks().some((t) => t.readyState === 'live')) {
        reacquireRef.current()
      }
    }
    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('pageshow', onResume)
    return () => {
      document.removeEventListener('visibilitychange', onResume)
      window.removeEventListener('pageshow', onResume)
    }
  }, [])

  // Quick preset: Talk to Everyone (unblock all teammates)
  const setTalkToEveryone = () => {
    setBlockedRecipients((prev) => {
      const updated = { ...prev }
      members.forEach((m) => {
        if (m.player.id !== myPlayerId) {
          updated[m.player.id] = false
        }
      })
      applyVoicePermissions(updated)
      if (onSetVoiceMode && roomId) {
        const allowed = members.filter((m) => m.player.id !== myPlayerId).map((m) => m.player.id)
        onSetVoiceMode(roomId, 'EVERYONE', allowed)
      }
      return updated
    })
  }

  // Quick preset: Team Only (block all opponents and unblock teammates)
  const setTeamOnly = () => {
    setBlockedRecipients((prev) => {
      const updated = { ...prev }
      members.forEach((m) => {
        if (m.player.id !== myPlayerId) {
          updated[m.player.id] = Boolean(myTeam && m.team && m.team !== myTeam)
        }
      })
      applyVoicePermissions(updated)
      if (onSetVoiceMode && roomId) {
        const allowed = members
          .filter((m) => m.player.id !== myPlayerId && (!m.team || m.team === myTeam))
          .map((m) => m.player.id)
        onSetVoiceMode(roomId, 'TEAM_ONLY', allowed)
      }
      return updated
    })
  }

  // Cleanup on unmount. The voice session deliberately outlives this
  // component — the lobby and the arena are separate routes and the match runs
  // across both — so only page-local resources are released here. The session
  // is stopped explicitly when the match ends (Result page) or the player
  // leaves the room routes.
  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      if (speakingTimeoutRef.current) clearTimeout(speakingTimeoutRef.current)
      if (videoStreamRef.current) {
        videoStreamRef.current.getTracks().forEach((t) => t.stop())
        videoStreamRef.current = null
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {})
      }
      // The next route re-asserts the live state; make sure the server is not
      // left believing we are still talking.
      onVoiceStateChangeRef.current?.(roomId, false, voiceSession.isMuted)
    }
  }, [roomId])

  // Find other players currently speaking in the room
  const activeSpeakers = Object.entries(voiceStates)
    .filter(([id, state]) => state.is_speaking && id !== myPlayerId)
    .map(([, state]) => state.player_name)

  const otherMembers = members.filter((m) => m.player.id !== myPlayerId)
  const teammates = otherMembers.filter((m) => m.team === myTeam)
  const opponents = otherMembers.filter((m) => m.team !== myTeam)

  const blockedCount = otherMembers.filter((m) => {
    const isOpponent = isTeamMatch && m.team !== myTeam
    if (isOpponent) return !isMutualConsentActive(m.player.id)
    return Boolean(blockedRecipients[m.player.id])
  }).length

  // A private call can be requested from any authorized peer; broadcast mode
  // and private calls share one camera.
  const videoBusy = Boolean(videoCallPeer)
  const canStartVideo = Boolean(videoNetwork?.allowed) && !videoBusy
  const videoUnavailableReason =
    videoNetwork?.reason || 'Checking whether this connection can handle video…'
  const videoErrorMessages: Record<string, string> = {
    rate_limited: 'Too many video call attempts. Please wait a moment.',
    no_pending_call: 'That call is no longer available.',
    player_not_in_room: 'That player is no longer in the room.',
    invalid_target: 'You cannot call that player.',
    not_authenticated: 'Your session expired. Please reconnect.',
    declined: 'The video call was declined.',
    no_answer: 'No answer. The video call timed out.',
    call_failed: 'The video call could not be started.',
    target_offline: 'That player is not online right now.',
  }
  const videoErrorText = videoCallError
    ? videoErrorMessages[videoCallError] || 'The video call could not be completed.'
    : null

  const closeVideoPanel = () => {
    if (videoMode === 'call' || videoCallPeer) {
      endPrivateVideoCall()
      return
    }
    stopCameraStream()
    setVideoMode('off')
  }

  return (
    <div className={styles.voiceContainer}>
      {/* Microphone Main Toggle */}
      <button
        type="button"
        className={`${styles.micBtn} ${!isMuted && micEnabled ? styles.micActive : styles.micMuted} ${isSpeakingLocal ? styles.micSpeaking : ''}`}
        onClick={toggleMute}
        title={!micEnabled ? 'Connect Microphone to Speak' : isMuted ? 'Microphone is Muted. Click to Speak' : 'Microphone is Live. Click to Mute'}
        aria-label="Toggle Microphone"
      >
        <span className={styles.micIcon}>
          {!micEnabled ? '🎙️' : isMuted ? '🔇' : '🎙️'}
        </span>
        <span className={styles.micLabel}>
          {!micEnabled ? 'Connect Mic' : isMuted ? 'Mic Muted' : 'Mic On'}
        </span>

        {/* Animated wave bars when mic is live */}
        {micEnabled && !isMuted && (
          <div className={styles.waveBars}>
            <span className={`${styles.wave} ${isSpeakingLocal ? styles.waveActive : ''}`} />
            <span className={`${styles.wave} ${isSpeakingLocal ? styles.waveActive : ''}`} />
            <span className={`${styles.wave} ${isSpeakingLocal ? styles.waveActive : ''}`} />
          </div>
        )}
      </button>

      {/* Beta camera / video call toggle (hidden while VIDEO_CALLS_ENABLED is false) */}
      {videoEnabled && (
      <button
        type="button"
        className={`${styles.micBtn} ${videoMode !== 'off' ? styles.videoBtnActive : ''}`}
        onClick={toggleBroadcastCamera}
        disabled={videoMode === 'off' && !videoNetwork?.allowed}
        title={
          videoMode === 'call'
            ? cameraOn
              ? 'Stop sending video (audio stays live)'
              : 'Resume sending video'
            : videoNetwork?.allowed
              ? videoMode === 'broadcast'
                ? 'Stop camera broadcast'
                : `Start camera (broadcast to everyone who can hear you) — ${videoNetwork.reason}`
              : `Video unavailable: ${videoUnavailableReason}`
        }
        aria-label="Toggle Camera"
      >
        <span className={styles.micIcon}>
          {cameraOn ? '🎥' : videoMode === 'call' ? '🟢' : '📷'}
        </span>
        <span className={styles.micLabel}>
          {videoMode === 'call' ? (cameraOn ? 'In Video Call' : 'Camera Off') : videoMode === 'broadcast' ? 'Camera On' : 'Video'}
          <span className={styles.betaTag}>BETA</span>
        </span>
      </button>
      )}

      {/* Voice control list (available in SOLO and TEAM matches) */}
      <button
        type="button"
        className={`${styles.voiceListBtn} ${blockedCount > 0 ? styles.voiceListBtnBlocked : ''}`}
        onClick={() => setShowVoiceListModal(true)}
        title="Voice Control (who hears you, who you hear)"
        aria-label="Open Voice Control"
      >
        <span className={styles.voiceListIcon}>👥</span>
        <span className={styles.voiceListLabel}>
          {blockedCount > 0 ? `Voice (${blockedCount} Blocked)` : 'Voice List'}
        </span>
        {crossTeamRequests.length > 0 && (
          <span className={styles.incomingBadge}>{crossTeamRequests.length}</span>
        )}
      </button>

      {/* Incoming private video call (hidden while VIDEO_CALLS_ENABLED is false) */}
      {videoEnabled && incomingVideoCall && !videoCallPeer && (
        <div className={styles.videoCallBanner} role="dialog" aria-label="Incoming video call">
          <span className={styles.videoCallText}>
            📹 <strong>{incomingVideoCall.from_player_name}</strong> invites you to a video call
          </span>
          <div className={styles.videoCallActions}>
            <button type="button" className={styles.videoCallAccept} onClick={acceptIncomingVideoCall}>
              ✅ Accept
            </button>
            <button type="button" className={styles.videoCallDecline} onClick={declineIncomingVideoCall}>
              ❌ Decline
            </button>
          </div>
        </div>
      )}

      {/* Outgoing private video call ringing */}
      {videoEnabled && videoCallPeer?.state === 'ringing' && videoCallPeer.direction === 'outgoing' && (
        <div className={styles.videoCallBanner} role="status">
          <span className={styles.videoCallText}>
            📹 Calling <strong>{videoCallPeer.peerName}</strong>…
          </span>
          <button type="button" className={styles.videoCallDecline} onClick={endPrivateVideoCall}>
            Cancel
          </button>
        </div>
      )}

      {videoEnabled && videoErrorText && (
        <div className={styles.permError} onClick={() => onClearVideoCallError?.()}>
          ⚠️ {videoErrorText}
        </div>
      )}

      {/* Camera failure outside the video panel (e.g. permission denied when calling) */}
      {videoEnabled && cameraError && videoMode === 'off' && !videoCallPeer && (
        <div className={styles.permError} onClick={() => setCameraError(null)}>
          ⚠️ {cameraError}
        </div>
      )}

      {/* Active speaker pill */}
      {activeSpeakers.length > 0 && (
        <div className={styles.speakerPill}>
          <span className={styles.speakerPulse} />
          {isSoundMuted ? (
            <span style={{ color: '#f59e0b', fontWeight: 700 }}>
              🔇 Sound Off — Turn Sound On to hear {activeSpeakers.join(', ')}
            </span>
          ) : (
            <span>🗣️ {activeSpeakers.join(', ')} speaking...</span>
          )}
        </div>
      )}

      {permissionError && (
        <div className={styles.permError} onClick={() => setPermissionError(null)}>
          ⚠️ {permissionError}
        </div>
      )}

      {/* Player List Voice Permissions Modal (SOLO + TEAM) */}
      {showVoiceListModal && (
        <ModalPortal>
        <div
          className={styles.modalOverlay}
          onClick={() => {
            setShowVoiceListModal(false)
            onCloseVoiceList?.()
          }}
        >
          <div className={styles.permissionsModal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className={styles.modalHeader}>
              <div className={styles.modalTitleGroup}>
                <span style={{ fontSize: '1.4rem' }}>🎙️</span>
                <div>
                  <h3 className={styles.modalTitle}>
                    {videoEnabled ? 'Voice & Video Control' : 'Voice Control'}
                  </h3>
                  <span className={styles.modalSub}>
                    {videoEnabled
                      ? 'Manage who can hear you, who you hear, and start private video calls'
                      : 'Manage who can hear you and who you hear'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className={styles.closeBtn}
                onClick={() => {
                  setShowVoiceListModal(false)
                  onCloseVoiceList?.()
                }}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {/* Camera failure is surfaced here because the panel may be closed */}
            {videoEnabled && cameraError && (
              <div className={styles.permError} onClick={() => setCameraError(null)}>
                ⚠️ {cameraError}
              </div>
            )}

            {/* Quick Presets */}
            <div className={styles.presetSection}>
              <span className={styles.sectionTitle}>Quick Presets</span>
              <div className={styles.presetRow}>
                <button
                  type="button"
                  className={styles.presetBtn}
                  onClick={setTalkToEveryone}
                >
                  {isTeamMatch ? '🗣️ Talk to All Teammates' : '🗣️ Let Opponent Hear Me'}
                </button>
                <button
                  type="button"
                  className={styles.presetBtn}
                  onClick={setTeamOnly}
                >
                  {isTeamMatch ? '🛡️ Team Only (Block Opponents)' : '🚫 Block My Voice'}
                </button>
              </div>
            </div>

            {/* Incoming Requests Banner if any */}
            {crossTeamRequests.length > 0 && (
              <div className={styles.incomingSection}>
                <div className={styles.sectionTitle}>🔔 Incoming Talk Requests:</div>
                {crossTeamRequests.map((req) => (
                  <div key={req.from_player_id} className={styles.requestCard}>
                    <span>
                      <strong>{req.from_player_name}</strong> (Team {req.from_team || 'B'}) wants to open private audio.
                    </span>
                    <div className={styles.requestActions}>
                      <button
                        type="button"
                        className={`${styles.voiceBtn} ${styles.voiceBtnActive}`}
                        onClick={() => onRespondCrossTeam?.(roomId, req.from_player_id, true)}
                      >
                        ✅ Accept
                      </button>
                      <button
                        type="button"
                        className={`${styles.voiceBtn} ${styles.voiceBtnBlock}`}
                        onClick={() => onRespondCrossTeam?.(roomId, req.from_player_id, false)}
                      >
                        ❌ Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Player List */}
            <div className={styles.playerListSection}>
              {/* 1. Teammates Section */}
              <div className={styles.sectionTitleRow}>
                <span className={styles.sectionTitle}>🛡️ TEAMMATES ({teammates.length}):</span>
              </div>
              <div className={styles.playerListContainer}>
                {teammates.length === 0 ? (
                  <div className={styles.emptyList}>No other teammates joined yet.</div>
                ) : (
                  teammates.map((m) => {
                    const peerId = m.player.id
                    const isBlocked = Boolean(blockedRecipients[peerId])
                    const isListeningMuted = Boolean(incomingMutes[peerId])
                    const isSpeaking = voiceStates[peerId]?.is_speaking || false

                    return (
                      <div
                        key={peerId}
                        className={`${styles.playerVoiceRow} ${isBlocked ? styles.playerVoiceRowBlocked : ''}`}
                      >
                        <div className={styles.playerVoiceLeft}>
                          <div className={styles.playerNameRow}>
                            <span className={styles.playerVoiceName}>{m.player.display_name}</span>
                            {isSpeaking && <span className={styles.speakingTag}>🟢 Speaking</span>}
                          </div>
                          <div className={styles.playerRoleRow}>
                            <span className={styles.teammateTag}>🛡️ Teammate</span>
                            {m.is_captain && <span className={styles.captainTag}>⭐ Captain</span>}
                          </div>
                        </div>

                        {/* player - talk / block your voice + listen toggle */}
                        <div className={styles.playerVoiceActions}>
                          <button
                            type="button"
                            className={`${styles.voiceBtn} ${styles.voiceBtnTalk} ${!isBlocked ? styles.voiceBtnActive : ''}`}
                            onClick={() => setPlayerVoice(peerId, false)}
                            title={`Allow ${m.player.display_name} to hear you`}
                          >
                            🗣️ Talk
                          </button>
                          <button
                            type="button"
                            className={`${styles.voiceBtn} ${styles.voiceBtnBlock} ${isBlocked ? styles.voiceBtnActiveBlock : ''}`}
                            onClick={() => setPlayerVoice(peerId, true)}
                            title={`Block your voice from ${m.player.display_name}`}
                          >
                            🚫 Block your voice
                          </button>
                          <button
                            type="button"
                            className={`${styles.listenBtn} ${isListeningMuted ? styles.listenBtnMuted : ''}`}
                            onClick={() => toggleIncomingMute(peerId)}
                            title={isListeningMuted ? `Unmute incoming sound from ${m.player.display_name}` : `Mute incoming sound from ${m.player.display_name}`}
                          >
                            {isListeningMuted ? '🔇' : '🔊'}
                          </button>
                          {videoEnabled && (
                            <button
                              type="button"
                              className={styles.videoCallBtn}
                              disabled={!canStartVideo}
                              onClick={() => startPrivateVideoCall(peerId)}
                              title={
                                videoNetwork?.allowed
                                  ? videoBusy
                                    ? 'Finish the current video call first'
                                    : `Start a private video call with ${m.player.display_name}`
                                  : `Video unavailable: ${videoUnavailableReason}`
                              }
                            >
                              📹 Video
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              {/* 2. Opponents Section (Mutual Consent Cross-Team Audio) */}
              <div className={styles.sectionTitleRow} style={{ marginTop: '12px' }}>
                <span className={styles.sectionTitle}>⚔️ OPPONENTS ({opponents.length}):</span>
              </div>
              <div className={styles.playerListContainer}>
                {opponents.length === 0 ? (
                  <div className={styles.emptyList}>No opponents joined yet.</div>
                ) : (
                  opponents.map((m) => {
                    const peerId = m.player.id
                    const isMutual = isMutualConsentActive(peerId)
                    const isPending = isRequestPending(peerId)
                    const isBlocked = Boolean(blockedRecipients[peerId])
                    const isListeningMuted = Boolean(incomingMutes[peerId])
                    const isSpeaking = voiceStates[peerId]?.is_speaking || false

                    return (
                      <div
                        key={peerId}
                        className={`${styles.playerVoiceRow} ${!isMutual ? styles.playerVoiceRowBlocked : ''}`}
                      >
                        <div className={styles.playerVoiceLeft}>
                          <div className={styles.playerNameRow}>
                            <span className={styles.playerVoiceName}>{m.player.display_name}</span>
                            {isSpeaking && <span className={styles.speakingTag}>🟢 Speaking</span>}
                          </div>
                          <div className={styles.playerRoleRow}>
                            <span className={styles.opponentTag}>⚔️ Opponent</span>
                            {m.is_captain && <span className={styles.captainTag}>⭐ Opponent Captain</span>}
                          </div>
                        </div>

                        {/* SOLO: direct talk/block. TEAM: cross-team mutual consent. */}
                        <div className={styles.playerVoiceActions}>
                          {!isTeamMatch ? (
                            <>
                              <button
                                type="button"
                                className={`${styles.voiceBtn} ${styles.voiceBtnTalk} ${!isBlocked ? styles.voiceBtnActive : ''}`}
                                onClick={() => setPlayerVoice(peerId, false)}
                                title={`Allow ${m.player.display_name} to hear you`}
                              >
                                🗣️ Talk
                              </button>
                              <button
                                type="button"
                                className={`${styles.voiceBtn} ${styles.voiceBtnBlock} ${isBlocked ? styles.voiceBtnActiveBlock : ''}`}
                                onClick={() => setPlayerVoice(peerId, true)}
                                title={`Block your voice from ${m.player.display_name}`}
                              >
                                🚫 Block your voice
                              </button>
                            </>
                          ) : isMutual ? (
                            <>
                              <button
                                type="button"
                                className={`${styles.voiceBtn} ${styles.voiceBtnActive}`}
                                title="Mutual private talk active"
                              >
                                🗣️ Talk Active
                              </button>
                              <button
                                type="button"
                                className={`${styles.voiceBtn} ${styles.voiceBtnBlock}`}
                                onClick={() => onRevokeCrossTeam?.(roomId, peerId)}
                                title="Revoke cross-team voice communication"
                              >
                                🚫 Revoke Talk
                              </button>
                            </>
                          ) : isPending ? (
                            <button
                              type="button"
                              className={styles.voiceBtn}
                              style={{ opacity: 0.8, cursor: 'default' }}
                              title="Waiting for opponent approval"
                            >
                              ⏳ Request Pending...
                            </button>
                          ) : (
                            <button
                              type="button"
                              className={`${styles.voiceBtn} ${styles.voiceBtnTalk}`}
                              onClick={() => onRequestCrossTeam?.(roomId, peerId)}
                              title={`Request private cross-team voice talk with ${m.player.display_name}`}
                            >
                              💬 Request Talk
                            </button>
                          )}
                          <button
                            type="button"
                            className={`${styles.listenBtn} ${isListeningMuted ? styles.listenBtnMuted : ''}`}
                            onClick={() => toggleIncomingMute(peerId)}
                            title={isListeningMuted ? `Unmute incoming sound from ${m.player.display_name}` : `Mute incoming sound from ${m.player.display_name}`}
                          >
                            {isListeningMuted ? '🔇' : '🔊'}
                          </button>
                          {videoEnabled && (
                            <button
                              type="button"
                              className={styles.videoCallBtn}
                              disabled={!canStartVideo}
                              onClick={() => startPrivateVideoCall(peerId)}
                              title={
                                videoNetwork?.allowed
                                  ? videoBusy
                                    ? 'Finish the current video call first'
                                    : `Start a private video call with ${m.player.display_name} (accepting also opens voice)`
                                  : `Video unavailable: ${videoUnavailableReason}`
                              }
                            >
                              📹 Video
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            <div className={styles.modalFooter}>
              <div className={styles.modalFooterHint}>
                {isTeamMatch ? (
                  <>
                    💡 <strong>Mutual Privacy Policy:</strong> Teammate talk is private by default. Cross-team voice requires mutual consent (Request & Accept) and can be revoked at any time.
                  </>
                ) : (
                  <>
                    💡 <strong>Privacy:</strong> Teammates and your opponent can only hear you while you allow it.
                    {videoEnabled ? ' Video requires a good connection and mutual consent.' : ''}
                  </>
                )}
              </div>
              <button
                type="button"
                className="btn btn-primary"
                style={{ width: '100%', padding: '10px' }}
                onClick={() => {
                  setShowVoiceListModal(false)
                  onCloseVoiceList?.()
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
        </ModalPortal>
      )}

      {/* Beta video surface (broadcast or private 1:1), hidden while VIDEO_CALLS_ENABLED is false */}
      {videoEnabled && (
        <ModalPortal>
        <VideoCallPanel
          isOpen={videoMode !== 'off' || Boolean(videoCallPeer)}
          onClose={closeVideoPanel}
          members={members}
          myPlayerId={myPlayerId}
          myDisplayName={myDisplayName}
          isMuted={isMuted || !micEnabled}
          onToggleMute={toggleMute}
          localStream={videoStreamRef.current}
          remoteStreams={remoteVideoStreams}
          cameraOn={cameraOn}
          cameraError={cameraError}
          network={{
            allowed: Boolean(videoNetwork?.allowed),
            reason: videoNetwork?.reason || 'Checking whether this connection can handle video…',
            latency: videoNetwork?.latency ?? null,
          }}
          callPeer={videoCallPeer}
          onToggleCamera={toggleBroadcastCamera}
          canToggleCamera={Boolean(videoNetwork?.allowed)}
        />
        </ModalPortal>
      )}
    </div>
  )
}
