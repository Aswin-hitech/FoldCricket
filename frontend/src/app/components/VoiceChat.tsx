import React, { useEffect, useRef, useState, useCallback } from 'react'
import styles from './VoiceChat.module.css'

interface VoiceChatProps {
  roomId: string
  myPlayerId: string
  myDisplayName: string
  voiceStates: Record<string, { is_speaking: boolean; is_muted: boolean; player_name: string }>
  onVoiceStateChange: (roomId: string, isSpeaking: boolean, isMuted: boolean) => void
  members?: Array<{ player: { id: string; display_name: string } }>
  incomingVoiceSignal?: { from_player_id: string; signal: unknown; timestamp: number } | null
  onSendSignal?: (roomId: string, targetId: string, signal: unknown) => void
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ],
}

export const VoiceChat: React.FC<VoiceChatProps> = ({
  roomId,
  myPlayerId,
  voiceStates,
  onVoiceStateChange,
  members = [],
  incomingVoiceSignal,
  onSendSignal,
}) => {
  const [micEnabled, setMicEnabled] = useState(false)
  const [isMuted, setIsMuted] = useState(true)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [isSpeakingLocal, setIsSpeakingLocal] = useState(false)

  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animFrameRef = useRef<number | null>(null)
  const speakingTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // WebRTC Peer Connections and Audio Output Elements
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const iceQueuesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  const lastSignalTimeRef = useRef<number>(0)

  // Helper to create or get an RTCPeerConnection for a given peer ID
  const getOrCreatePeerConnection = useCallback((peerId: string): RTCPeerConnection => {
    const existing = peerConnectionsRef.current.get(peerId)
    if (existing && existing.connectionState !== 'closed') {
      return existing
    }

    const pc = new RTCPeerConnection(RTC_CONFIG)
    peerConnectionsRef.current.set(peerId, pc)

    // Send local ICE candidates to the remote peer
    pc.onicecandidate = (event) => {
      if (event.candidate && onSendSignal) {
        onSendSignal(roomId, peerId, {
          type: 'candidate',
          candidate: event.candidate.toJSON(),
        })
      }
    }

    // Play incoming audio track through an HTMLAudioElement
    pc.ontrack = (event) => {
      let audio = audioElementsRef.current.get(peerId)
      if (!audio) {
        audio = new Audio()
        audio.autoplay = true
        audio.setAttribute('playsinline', 'true')
        audioElementsRef.current.set(peerId, audio)
      }
      const stream = event.streams[0] || new MediaStream([event.track])
      audio.srcObject = stream
      audio.play().catch((err) => {
        console.warn('Audio auto-play prevented (will resume on user click):', err)
      })
    }

    // Attach local audio track if we already have mic stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((track) => {
        pc.addTrack(track, mediaStreamRef.current!)
      })
    }

    return pc
  }, [roomId, onSendSignal])

  // Attach local tracks to all existing peer connections
  const addLocalTracksToAllPeers = useCallback((stream: MediaStream) => {
    peerConnectionsRef.current.forEach((pc) => {
      const senders = pc.getSenders()
      stream.getAudioTracks().forEach((track) => {
        const existingSender = senders.find((s) => s.track?.kind === 'audio')
        if (existingSender) {
          existingSender.replaceTrack(track).catch(() => {})
        } else {
          try {
            pc.addTrack(track, stream)
          } catch {
            // Already added or renegotiation in progress
          }
        }
      })
    })
  }, [])

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

      // Set up Web Audio Analyser to detect speech volume
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new AudioCtx()
      audioContextRef.current = ctx

      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      analyserRef.current = analyser

      // Default to unmuted once connected
      stream.getAudioTracks().forEach((t) => { t.enabled = true })
      setMicEnabled(true)
      setIsMuted(false)
      onVoiceStateChange(roomId, false, false)

      // Add local tracks to any existing peers
      addLocalTracksToAllPeers(stream)

      // Broadcast ready signal to all other room members
      members
        .filter((m) => m.player.id !== myPlayerId)
        .forEach((m) => {
          getOrCreatePeerConnection(m.player.id)
          onSendSignal?.(roomId, m.player.id, { type: 'ready' })
        })

      // Try playing any pending audio elements on user interaction
      audioElementsRef.current.forEach((audio) => {
        if (audio.paused && audio.srcObject) {
          audio.play().catch(() => {})
        }
      })

      // Start volume detection loop
      const bufferLength = analyser.frequencyBinCount
      const dataArray = new Uint8Array(bufferLength)

      const detectSpeech = () => {
        if (!analyserRef.current || isMuted) {
          animFrameRef.current = requestAnimationFrame(detectSpeech)
          return
        }

        analyserRef.current.getByteFrequencyData(dataArray)
        let sum = 0
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i]
        }
        const average = sum / bufferLength

        const speakingNow = average > 18
        if (speakingNow) {
          setIsSpeakingLocal(true)
          onVoiceStateChange(roomId, true, false)

          if (speakingTimeoutRef.current) clearTimeout(speakingTimeoutRef.current)
          speakingTimeoutRef.current = setTimeout(() => {
            setIsSpeakingLocal(false)
            onVoiceStateChange(roomId, false, false)
          }, 600)
        }

        animFrameRef.current = requestAnimationFrame(detectSpeech)
      }

      animFrameRef.current = requestAnimationFrame(detectSpeech)
    } catch (err: unknown) {
      console.warn('Microphone access denied or unavailable:', err)
      setPermissionError('Mic permission denied. Please allow microphone access in your browser.')
      setMicEnabled(false)
      setIsMuted(true)
    }
  }, [roomId, onVoiceStateChange, isMuted, members, myPlayerId, onSendSignal, getOrCreatePeerConnection, addLocalTracksToAllPeers])

  // Handle incoming WebRTC signals
  useEffect(() => {
    if (!incomingVoiceSignal) return
    const { from_player_id, signal, timestamp } = incomingVoiceSignal
    if (timestamp === lastSignalTimeRef.current) return
    lastSignalTimeRef.current = timestamp

    const data = signal as {
      type: 'ready' | 'offer' | 'answer' | 'candidate'
      sdp?: RTCSessionDescriptionInit
      candidate?: RTCIceCandidateInit
    }
    if (!data || !data.type || !from_player_id) return

    const handleSignal = async () => {
      const pc = getOrCreatePeerConnection(from_player_id)

      if (data.type === 'ready') {
        // Peer is ready -> create offer
        try {
          const offer = await pc.createOffer({ offerToReceiveAudio: true })
          await pc.setLocalDescription(offer)
          onSendSignal?.(roomId, from_player_id, {
            type: 'offer',
            sdp: offer,
          })
        } catch (err) {
          console.warn('Error creating offer:', err)
        }
      } else if (data.type === 'offer' && data.sdp) {
        // Peer sent offer -> set remote description and create answer
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
          // Flush queued candidates
          const queue = iceQueuesRef.current.get(from_player_id) || []
          for (const cand of queue) {
            await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {})
          }
          iceQueuesRef.current.set(from_player_id, [])

          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          onSendSignal?.(roomId, from_player_id, {
            type: 'answer',
            sdp: answer,
          })
        } catch (err) {
          console.warn('Error handling offer:', err)
        }
      } else if (data.type === 'answer' && data.sdp) {
        // Peer sent answer -> set remote description
        try {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
            // Flush queued candidates
            const queue = iceQueuesRef.current.get(from_player_id) || []
            for (const cand of queue) {
              await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {})
            }
            iceQueuesRef.current.set(from_player_id, [])
          }
        } catch (err) {
          console.warn('Error handling answer:', err)
        }
      } else if (data.type === 'candidate' && data.candidate) {
        // Peer sent ICE candidate
        try {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate))
          } else {
            const queue = iceQueuesRef.current.get(from_player_id) || []
            queue.push(data.candidate)
            iceQueuesRef.current.set(from_player_id, queue)
          }
        } catch (err) {
          console.warn('Error adding ICE candidate:', err)
        }
      }
    }

    handleSignal()
  }, [incomingVoiceSignal, getOrCreatePeerConnection, onSendSignal, roomId])

  // Announce to new peers when members list updates while mic is enabled
  useEffect(() => {
    if (!micEnabled) return
    members
      .filter((m) => m.player.id !== myPlayerId)
      .forEach((m) => {
        if (!peerConnectionsRef.current.has(m.player.id)) {
          getOrCreatePeerConnection(m.player.id)
          onSendSignal?.(roomId, m.player.id, { type: 'ready' })
        }
      })
  }, [members, micEnabled, myPlayerId, roomId, onSendSignal, getOrCreatePeerConnection])

  // Toggle Mute / Unmute
  const toggleMute = () => {
    // Resume any blocked audio on user click
    audioElementsRef.current.forEach((audio) => {
      if (audio.paused && audio.srcObject) {
        audio.play().catch(() => {})
      }
    })

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
      })
      audioElementsRef.current.clear()
    }
  }, [])

  // Find other players currently speaking in the room
  const activeSpeakers = Object.entries(voiceStates)
    .filter(([id, state]) => state.is_speaking && id !== myPlayerId)
    .map(([, state]) => state.player_name)

  return (
    <div className={styles.voiceContainer}>
      <button
        type="button"
        className={`${styles.micBtn} ${!isMuted && micEnabled ? styles.micActive : styles.micMuted} ${isSpeakingLocal ? styles.micSpeaking : ''}`}
        onClick={toggleMute}
        title={!micEnabled ? 'Connect Voice Chat' : isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
        aria-label="Toggle Microphone"
      >
        <span className={styles.micIcon}>
          {!micEnabled ? '🎙️' : isMuted ? '🔇' : '🎙️'}
        </span>
        <span className={styles.micLabel}>
          {!micEnabled ? 'Connect Mic' : isMuted ? 'Muted' : 'Mic Live'}
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

      {/* Active speaker pill */}
      {activeSpeakers.length > 0 && (
        <div className={styles.speakerPill}>
          <span className={styles.speakerPulse} />
          <span>🗣️ {activeSpeakers.join(', ')} speaking...</span>
        </div>
      )}

      {permissionError && (
        <div className={styles.permError} onClick={() => setPermissionError(null)}>
          ⚠️ {permissionError}
        </div>
      )}
    </div>
  )
}
