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
import type { CrossTeamVoiceRequest, VoicePermissionEntry } from '../../services/types'
import styles from './VoiceChat.module.css'

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

export const VoiceChat: React.FC<VoiceChatProps> = ({
  roomId,
  myPlayerId,
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
}) => {
  const [micEnabled, setMicEnabled] = useState(false)
  const [isMuted, setIsMuted] = useState(true)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [isSpeakingLocal, setIsSpeakingLocal] = useState(false)

  // Team Match Voice Control: tracks which teammates have outgoing voice blocked
  const [showVoiceListModal, setShowVoiceListModal] = useState(false)
  const [blockedRecipients, setBlockedRecipients] = useState<Record<string, boolean>>({})

  // Separate incoming listening preference: mute incoming audio locally per player
  const [incomingMutes, setIncomingMutes] = useState<Record<string, boolean>>({})

  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number | null>(null)
  const speakingTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // WebRTC Peer Connections and Audio Output Elements
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const iceQueuesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  const processedSignalIdRef = useRef<number>(0)
  const offeredPeersRef = useRef<Set<string>>(new Set())
  const readySentRef = useRef<Set<string>>(new Set())

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

  // Apply real-time transport permissions to WebRTC senders
  const applyVoicePermissions = useCallback(
    (blockedMap: Record<string, boolean>) => {
      const localTrack = mediaStreamRef.current?.getAudioTracks()[0]
      peerConnectionsRef.current.forEach((pc, peerId) => {
        const mem = members.find((m) => m.player.id === peerId)
        const isTeammate = Boolean(myTeam && mem?.team === myTeam)
        const isMutual = isMutualConsentActive(peerId)

        // Block if explicitly blocked, or if opponent without mutual consent
        const shouldBlock = isTeamMatch
          ? (isTeammate && Boolean(blockedMap[peerId])) || (!isTeammate && !isMutual)
          : false

        const senders = pc.getSenders().filter((s) => !s.track || s.track.kind === 'audio')
        senders.forEach((s) => {
          if (!shouldBlock && localTrack && localTrack.enabled && !isMuted) {
            s.replaceTrack(localTrack).catch(() => {})
          } else {
            s.replaceTrack(null).catch(() => {})
          }
        })
      })
    },
    [isTeamMatch, isMuted, members, myTeam, isMutualConsentActive]
  )

  // Helper to create or get an RTCPeerConnection for a given peer ID
  const getOrCreatePeerConnection = useCallback(
    (peerId: string): RTCPeerConnection => {
      const existing = peerConnectionsRef.current.get(peerId)
      if (existing && existing.connectionState !== 'closed') {
        return existing
      }

      const pc = new RTCPeerConnection(getRtcConfiguration())
      peerConnectionsRef.current.set(peerId, pc)

      // Ensure audio transceiver exists so receiving audio over speaker works immediately
      if (pc.getTransceivers().length === 0) {
        pc.addTransceiver('audio', { direction: 'sendrecv' })
      }

      // Self-heal broken transports: drop the connection so a later snapshot
      // rebuilds it instead of leaving the player silently deaf.
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          offeredPeersRef.current.delete(peerId)
          readySentRef.current.delete(peerId)
          if (peerConnectionsRef.current.get(peerId) === pc) {
            peerConnectionsRef.current.delete(peerId)
          }
          try {
            pc.close()
          } catch {}
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

      // Play incoming audio track through an attached HTMLAudioElement in the DOM
      pc.ontrack = (event) => {
        let audio = audioElementsRef.current.get(peerId)
        if (!audio) {
          audio = document.createElement('audio')
          audio.autoplay = true
          audio.setAttribute('playsinline', 'true')
          audio.setAttribute('data-peer-id', peerId)
          audio.style.display = 'none'
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

      // Attach local audio track if we already have mic stream
      if (mediaStreamRef.current) {
        const mem = members.find((m) => m.player.id === peerId)
        const isTeammate = Boolean(myTeam && mem?.team === myTeam)
        const isMutual = isMutualConsentActive(peerId)
        const isBlocked = isTeamMatch
          ? (isTeammate && Boolean(blockedRecipients[peerId])) || (!isTeammate && !isMutual)
          : false

        const track = mediaStreamRef.current.getAudioTracks()[0]
        if (track) {
          const transceiver = pc.getTransceivers().find(
            (t) => t.sender.track?.kind === 'audio' || t.receiver.track?.kind === 'audio'
          )
          if (transceiver && transceiver.sender) {
            transceiver.sender.replaceTrack(isBlocked || isMuted ? null : track).catch(() => {})
            transceiver.direction = 'sendrecv'
          } else {
            try {
              const sender = pc.addTrack(track, mediaStreamRef.current)
              if (isBlocked || isMuted) {
                sender.replaceTrack(null).catch(() => {})
              }
            } catch {
              // ignore duplicate track
            }
          }
        }
      }

      return pc
    },
    [roomId, onSendSignal, isTeamMatch, blockedRecipients, isMuted, incomingMutes, isSoundMuted, members, myTeam, isMutualConsentActive]
  )

  // Attach local tracks to all existing peer connections respecting blocked state
  const addLocalTracksToAllPeers = useCallback(
    (stream: MediaStream) => {
      peerConnectionsRef.current.forEach((pc, peerId) => {
        const mem = members.find((m) => m.player.id === peerId)
        const isTeammate = Boolean(myTeam && mem?.team === myTeam)
        const isMutual = isMutualConsentActive(peerId)
        const isBlocked = isTeamMatch
          ? (isTeammate && Boolean(blockedRecipients[peerId])) || (!isTeammate && !isMutual)
          : false

        const track = stream.getAudioTracks()[0]
        if (!track) return

        const transceiver = pc.getTransceivers().find(
          (t) => t.sender.track?.kind === 'audio' || t.receiver.track?.kind === 'audio'
        )
        if (transceiver && transceiver.sender) {
          transceiver.sender.replaceTrack(isBlocked || isMuted ? null : track).catch(() => {})
          transceiver.direction = 'sendrecv'
        } else {
          try {
            const sender = pc.addTrack(track, stream)
            if (isBlocked || isMuted) {
              sender.replaceTrack(null).catch(() => {})
            }
          } catch {
            // ignore duplicate track
          }
        }
      })
    },
    [isTeamMatch, blockedRecipients, isMuted, members, myTeam, isMutualConsentActive]
  )

  // Initialize Microphone Media Stream and start signaling
  const initMicrophone = useCallback(async () => {
    try {
      setPermissionError(null)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      mediaStreamRef.current = stream

      const AudioCtx =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new AudioCtx()
      audioContextRef.current = ctx

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
        if (!analyserRef.current) return
        analyserRef.current.getByteFrequencyData(pcmData)

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

      // Unmute stream
      stream.getAudioTracks().forEach((t) => {
        t.enabled = true
      })
      setIsMuted(false)
      setMicEnabled(true)
      onVoiceStateChange(roomId, false, false)

      // Attach tracks to all existing peer connections
      addLocalTracksToAllPeers(stream)
    } catch (err) {
      console.error('Microphone access denied:', err)
      setPermissionError('Microphone permission denied. Allow mic access in your browser to talk.')
      setMicEnabled(false)
      setIsMuted(true)
    }
  }, [roomId, onVoiceStateChange, addLocalTracksToAllPeers])

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

        const pc = getOrCreatePeerConnection(fromPlayerId)

        if (data.type === 'ready') {
          if (
            myPlayerId > fromPlayerId &&
            !offeredPeersRef.current.has(fromPlayerId) &&
            pc.signalingState === 'stable'
          ) {
            offeredPeersRef.current.add(fromPlayerId)
            try {
              const offer = await pc.createOffer({ offerToReceiveAudio: true })
              await pc.setLocalDescription(offer)
              onSendSignal?.(roomId, fromPlayerId, { type: 'offer', sdp: offer })
            } catch (err) {
              console.warn('Error creating offer on ready:', err)
            }
          }
        } else if (data.type === 'offer' && data.sdp) {
          try {
            // Deterministic roles prevent most glare; if it still happens the
            // lower id is the polite peer and rolls its own offer back.
            if (pc.signalingState === 'have-local-offer' && myPlayerId < fromPlayerId) {
              await pc.setLocalDescription({ type: 'rollback' })
            }
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
            await flushCandidates(pc, fromPlayerId)

            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            onSendSignal?.(roomId, fromPlayerId, { type: 'answer', sdp: answer })
          } catch (err) {
            console.warn('Error handling offer:', err)
          }
        } else if (data.type === 'answer' && data.sdp) {
          try {
            if (pc.signalingState === 'have-local-offer') {
              await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
              await flushCandidates(pc, fromPlayerId)
            }
          } catch (err) {
            console.warn('Error handling answer:', err)
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
  }, [incomingVoiceSignals, getOrCreatePeerConnection, onSendSignal, roomId, myPlayerId])

  // Establish WebRTC connections once per peer (not once per snapshot).
  useEffect(() => {
    if (!roomId) return
    const peerIds = new Set(members.filter((m) => m.player.id !== myPlayerId).map((m) => m.player.id))
    Array.from(offeredPeersRef.current).forEach((id) => {
      if (!peerIds.has(id)) offeredPeersRef.current.delete(id)
    })
    Array.from(readySentRef.current).forEach((id) => {
      if (!peerIds.has(id)) readySentRef.current.delete(id)
    })

    members
      .filter((m) => m.player.id !== myPlayerId)
      .forEach((m) => {
        const pc = getOrCreatePeerConnection(m.player.id)

        if (!readySentRef.current.has(m.player.id)) {
          readySentRef.current.add(m.player.id)
          onSendSignal?.(roomId, m.player.id, { type: 'ready' })
        }

        // Higher player id is the sole offerer for this pair.
        if (myPlayerId <= m.player.id) return
        if (offeredPeersRef.current.has(m.player.id)) return
        if (pc.signalingState !== 'stable') return
        if (pc.connectionState === 'connected') {
          offeredPeersRef.current.add(m.player.id)
          return
        }

        offeredPeersRef.current.add(m.player.id)
        pc.createOffer({ offerToReceiveAudio: true })
          .then((offer) => pc.setLocalDescription(offer).then(() => offer))
          .then((offer) => {
            onSendSignal?.(roomId, m.player.id, { type: 'offer', sdp: offer })
          })
          .catch((err) => {
            offeredPeersRef.current.delete(m.player.id)
            console.warn('Error creating auto-receive offer:', err)
          })
      })
  }, [members, myPlayerId, roomId, onSendSignal, getOrCreatePeerConnection])

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
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = !nextMuted
      })
    }
    if (nextMuted) {
      setIsSpeakingLocal(false)
    }
    onVoiceStateChange(roomId, false, nextMuted)

    // Update WebRTC senders immediately
    peerConnectionsRef.current.forEach((pc, peerId) => {
      const mem = members.find((m) => m.player.id === peerId)
      const isTeammate = Boolean(myTeam && mem?.team === myTeam)
      const isMutual = isMutualConsentActive(peerId)
      const isBlocked = isTeamMatch ? (isTeammate && Boolean(blockedRecipients[peerId])) || (!isTeammate && !isMutual) : false
      const localTrack = mediaStreamRef.current?.getAudioTracks()[0]
      const senders = pc.getSenders().filter((s) => !s.track || s.track.kind === 'audio')
      senders.forEach((s) => {
        if (!nextMuted && !isBlocked && localTrack) {
          s.replaceTrack(localTrack).catch(() => {})
        } else {
          s.replaceTrack(null).catch(() => {})
        }
      })
    })
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      if (speakingTimeoutRef.current) clearTimeout(speakingTimeoutRef.current)
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop())
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {})
      }
      peerConnectionsRef.current.forEach((pc) => pc.close())
      peerConnectionsRef.current.clear()
      audioElementsRef.current.forEach((audio) => {
        audio.pause()
        audio.srcObject = null
        if (audio.parentNode) {
          audio.parentNode.removeChild(audio)
        }
      })
      audioElementsRef.current.clear()
    }
  }, [])

  // Find other players currently speaking in the room
  const activeSpeakers = Object.entries(voiceStates)
    .filter(([id, state]) => state.is_speaking && id !== myPlayerId)
    .map(([, state]) => state.player_name)

  const otherMembers = members.filter((m) => m.player.id !== myPlayerId)
  const teammates = otherMembers.filter((m) => m.team === myTeam)
  const opponents = otherMembers.filter((m) => m.team !== myTeam)

  const blockedCount = otherMembers.filter((m) => {
    const isTeammate = Boolean(myTeam && m.team === myTeam)
    if (isTeammate) return Boolean(blockedRecipients[m.player.id])
    return !isMutualConsentActive(m.player.id)
  }).length

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

      {/* Voice List Button (Shown only in team matches) */}
      {isTeamMatch && (
        <button
          type="button"
          className={`${styles.voiceListBtn} ${blockedCount > 0 ? styles.voiceListBtnBlocked : ''}`}
          onClick={() => setShowVoiceListModal(true)}
          title="Team Voice Control (Player List)"
          aria-label="Open Team Voice Control"
        >
          <span className={styles.voiceListIcon}>👥</span>
          <span className={styles.voiceListLabel}>
            {blockedCount > 0 ? `Voice (${blockedCount} Blocked)` : 'Voice List'}
          </span>
          {crossTeamRequests.length > 0 && (
            <span className={styles.incomingBadge}>{crossTeamRequests.length}</span>
          )}
        </button>
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

      {/* Player List Voice Permissions Modal (Only in team matches) */}
      {isTeamMatch && showVoiceListModal && (
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
                  <h3 className={styles.modalTitle}>Voice Control (Team Match)</h3>
                  <span className={styles.modalSub}>Manage who can hear your voice and who you listen to</span>
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

            {/* Quick Presets */}
            <div className={styles.presetSection}>
              <span className={styles.sectionTitle}>Quick Presets</span>
              <div className={styles.presetRow}>
                <button
                  type="button"
                  className={styles.presetBtn}
                  onClick={setTalkToEveryone}
                >
                  🗣️ Talk to All Teammates
                </button>
                <button
                  type="button"
                  className={styles.presetBtn}
                  onClick={setTeamOnly}
                >
                  🛡️ Team Only (Block Opponents)
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

                        {/* Cross-team mutual consent actions */}
                        <div className={styles.playerVoiceActions}>
                          {isMutual ? (
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
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            <div className={styles.modalFooter}>
              <div className={styles.modalFooterHint}>
                💡 <strong>Mutual Privacy Policy:</strong> Teammate talk is private by default. Cross-team voice requires mutual consent (Request & Accept) and can be revoked at any time.
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
      )}
    </div>
  )
}
