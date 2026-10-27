import React, { useEffect, useRef, useState, useCallback } from 'react'
import { formatPlayerWithTeam, getTeamRoleLabel } from '../../utils/teamLabels'
import styles from './VoiceChat.module.css'

export type VoiceAudienceMode = 'EVERYONE' | 'TEAM_ONLY' | 'SELECTED_PLAYERS' | 'MUTED'

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
  incomingVoiceSignal?: { from_player_id: string; signal: unknown; timestamp: number } | null
  onSendSignal?: (roomId: string, targetId: string, signal: unknown) => void
  onSetVoiceMode?: (roomId: string, mode: string, allowedRecipients: string[]) => void
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
  onSetVoiceMode,
}) => {
  const [micEnabled, setMicEnabled] = useState(false)
  const [isMuted, setIsMuted] = useState(true)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [isSpeakingLocal, setIsSpeakingLocal] = useState(false)

  // Selective Voice Permission Modes
  const [voiceMode, setVoiceMode] = useState<VoiceAudienceMode>('TEAM_ONLY')
  const [selectedRecipients, setSelectedRecipients] = useState<string[]>([])
  const [showPermissionsModal, setShowPermissionsModal] = useState(false)
  const [playerMutes, setPlayerMutes] = useState<Record<string, boolean>>({})
  const [playerVolumes, setPlayerVolumes] = useState<Record<string, number>>({})

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

  const myMem = members.find((m) => m.player.id === myPlayerId)
  const myTeam = myMem?.team

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

  // ============================================================
  // Audio Transport Permission Enforcement
  // When an audience is restricted (e.g. TEAM_ONLY or SELECTED),
  // replaceTrack(null) stops sending audio packets to blocked peers!
  // ============================================================
  const enforceAudioPermissions = useCallback(() => {
    if (!mediaStreamRef.current) return
    const audioTracks = mediaStreamRef.current.getAudioTracks()
    const localTrack = audioTracks[0]

    const effectiveMuted = isMuted || voiceMode === 'MUTED' || !micEnabled

    if (effectiveMuted) {
      if (localTrack) localTrack.enabled = false
      peerConnectionsRef.current.forEach((pc) => {
        pc.getSenders().forEach((s) => {
          if (s.track?.kind === 'audio') {
            s.replaceTrack(null).catch(() => {})
          }
        })
      })
      return
    }

    if (localTrack) localTrack.enabled = true

    // Check each remote peer against the audience mode
    members.forEach((m) => {
      const peerId = m.player.id
      if (peerId === myPlayerId) return
      const pc = peerConnectionsRef.current.get(peerId)
      if (!pc) return

      let isAllowed = false
      if (voiceMode === 'EVERYONE') {
        isAllowed = true
      } else if (voiceMode === 'TEAM_ONLY') {
        isAllowed = Boolean(myTeam && m.team === myTeam)
      } else if (voiceMode === 'SELECTED_PLAYERS') {
        isAllowed = selectedRecipients.includes(peerId)
      }

      const senders = pc.getSenders()
      const audioSender = senders.find((s) => s.track?.kind === 'audio')
      if (audioSender) {
        if (isAllowed) {
          audioSender.replaceTrack(localTrack).catch(() => {})
        } else {
          // Transport-level packet cutoff: opponent receives 0 audio packets!
          audioSender.replaceTrack(null).catch(() => {})
        }
      }
    })
  }, [isMuted, voiceMode, micEnabled, members, myPlayerId, myTeam, selectedRecipients])

  // Sync permissions whenever audience mode, mute status, or members change
  useEffect(() => {
    enforceAudioPermissions()
    const allowed =
      voiceMode === 'EVERYONE'
        ? members.map((m) => m.player.id)
        : voiceMode === 'TEAM_ONLY'
        ? members.filter((m) => m.team === myTeam).map((m) => m.player.id)
        : selectedRecipients
    onSetVoiceMode?.(roomId, voiceMode, allowed)
  }, [voiceMode, selectedRecipients, isMuted, micEnabled, enforceAudioPermissions, onSetVoiceMode, roomId, members, myTeam])

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

      // Web Audio Analyser for speaking volume detection
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

      addLocalTracksToAllPeers(stream)

      // Broadcast ready signal to all other room members
      members
        .filter((m) => m.player.id !== myPlayerId)
        .forEach((m) => {
          getOrCreatePeerConnection(m.player.id)
          onSendSignal?.(roomId, m.player.id, { type: 'ready' })
        })

      // Audio elements resume on user gesture
      audioElementsRef.current.forEach((audio) => {
        if (audio.paused && audio.srcObject) {
          audio.play().catch(() => {})
        }
      })

      // Start volume detection loop
      const bufferLength = analyser.frequencyBinCount
      const dataArray = new Uint8Array(bufferLength)

      const detectSpeech = () => {
        if (!analyserRef.current || isMuted || voiceMode === 'MUTED') {
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
  }, [roomId, onVoiceStateChange, isMuted, voiceMode, members, myPlayerId, onSendSignal, getOrCreatePeerConnection, addLocalTracksToAllPeers])

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
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
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
        try {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
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

  // Toggle Mute / Unmute
  const toggleMute = () => {
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

  // Local audio receiver controls
  const handleTogglePlayerMute = (peerId: string) => {
    const audio = audioElementsRef.current.get(peerId)
    const next = !playerMutes[peerId]
    setPlayerMutes((prev) => ({ ...prev, [peerId]: next }))
    if (audio) {
      audio.muted = next
    }
  }

  const handlePlayerVolumeChange = (peerId: string, vol: number) => {
    const audio = audioElementsRef.current.get(peerId)
    setPlayerVolumes((prev) => ({ ...prev, [peerId]: vol }))
    if (audio) {
      audio.volume = Math.max(0, Math.min(1, vol))
    }
  }

  const toggleRecipientSelection = (peerId: string) => {
    setSelectedRecipients((prev) =>
      prev.includes(peerId) ? prev.filter((id) => id !== peerId) : [...prev, peerId]
    )
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

  // Speakers currently active in room
  const activeSpeakers = Object.entries(voiceStates)
    .filter(([id, state]) => state.is_speaking && id !== myPlayerId)
    .map(([, state]) => state.player_name)

  // Audience list split
  const allowedRecipientsList = members.filter((m) => {
    if (m.player.id === myPlayerId) return true
    if (voiceMode === 'EVERYONE') return true
    if (voiceMode === 'TEAM_ONLY') return Boolean(myTeam && m.team === myTeam)
    if (voiceMode === 'SELECTED_PLAYERS') return selectedRecipients.includes(m.player.id)
    return false
  })

  const blockedRecipientsList = members.filter((m) => {
    if (m.player.id === myPlayerId) return false
    return !allowedRecipientsList.some((a) => a.player.id === m.player.id)
  })

  const getModeLabel = (mode: VoiceAudienceMode) => {
    switch (mode) {
      case 'EVERYONE':
        return '🌐 Everyone'
      case 'TEAM_ONLY':
        return '🛡️ Your Team Only'
      case 'SELECTED_PLAYERS':
        return `🎯 Selected (${selectedRecipients.length})`
      case 'MUTED':
        return '🔇 Muted'
    }
  }

  return (
    <div className={styles.voiceContainer}>
      {/* 1. Primary Mic Button */}
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

        {micEnabled && !isMuted && (
          <div className={styles.waveBars}>
            <span className={`${styles.wave} ${isSpeakingLocal ? styles.waveActive : ''}`} />
            <span className={`${styles.wave} ${isSpeakingLocal ? styles.waveActive : ''}`} />
            <span className={`${styles.wave} ${isSpeakingLocal ? styles.waveActive : ''}`} />
          </div>
        )}
      </button>

      {/* 2. Selective Voice Audience Selector Pill */}
      <button
        type="button"
        className={styles.audienceBtn}
        onClick={() => setShowPermissionsModal(true)}
        title="Change Voice Chat Audience & Permissions"
      >
        <span>{getModeLabel(voiceMode)}</span>
        <span style={{ fontSize: '0.7rem' }}>⚙️</span>
      </button>

      {/* 3. Speaking Indicator Pill */}
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

      {/* ============================================================
          4. Selective Voice Permissions Panel / Modal
          ============================================================ */}
      {showPermissionsModal && (
        <div className={styles.modalOverlay} onClick={() => setShowPermissionsModal(false)}>
          <div className={styles.permissionsModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div className={styles.modalTitleGroup}>
                <span style={{ fontSize: '1.4rem' }}>🎙️</span>
                <h3 className={styles.modalTitle}>Voice Audience & Permissions</h3>
              </div>
              <button
                type="button"
                className={styles.closeBtn}
                onClick={() => setShowPermissionsModal(false)}
              >
                ✕
              </button>
            </div>

            {/* A. Select Voice Mode */}
            <div>
              <div className={styles.sectionTitle}>Select Voice Mode</div>
              <div className={styles.modeGrid}>
                <button
                  type="button"
                  className={`${styles.modeOptionBtn} ${voiceMode === 'EVERYONE' ? styles.modeOptionActive : ''}`}
                  onClick={() => setVoiceMode('EVERYONE')}
                >
                  <span className={styles.modeTitle}>🌐 Everyone</span>
                  <span className={styles.modeDesc}>All participants in the match can hear you</span>
                </button>

                <button
                  type="button"
                  className={`${styles.modeOptionBtn} ${voiceMode === 'TEAM_ONLY' ? styles.modeOptionActive : ''}`}
                  onClick={() => setVoiceMode('TEAM_ONLY')}
                >
                  <span className={styles.modeTitle}>🛡️ Your Team Only</span>
                  <span className={styles.modeDesc}>Opponents cannot hear your private team strategy</span>
                </button>

                <button
                  type="button"
                  className={`${styles.modeOptionBtn} ${voiceMode === 'SELECTED_PLAYERS' ? styles.modeOptionActive : ''}`}
                  onClick={() => setVoiceMode('SELECTED_PLAYERS')}
                >
                  <span className={styles.modeTitle}>🎯 Selected Players</span>
                  <span className={styles.modeDesc}>Choose specific teammates who can hear you</span>
                </button>

                <button
                  type="button"
                  className={`${styles.modeOptionBtn} ${voiceMode === 'MUTED' ? styles.modeOptionActive : ''}`}
                  onClick={() => setVoiceMode('MUTED')}
                >
                  <span className={styles.modeTitle}>🔇 Muted</span>
                  <span className={styles.modeDesc}>Your microphone audio is completely cut off</span>
                </button>
              </div>
            </div>

            {/* B. Current Audience Status */}
            <div className={styles.statusCard}>
              <div className={styles.audienceBadge}>
                Microphone Audience: {getModeLabel(voiceMode)}
              </div>

              <div>
                <div style={{ fontSize: '0.75rem', fontWeight: 700, marginBottom: '4px', color: '#22c55e' }}>
                  Allowed Recipients ({allowedRecipientsList.length})
                </div>
                <div className={styles.recipientList}>
                  {allowedRecipientsList.map((m) => (
                    <div key={m.player.id} className={styles.recipientItem}>
                      <span>{formatPlayerWithTeam(m.player.display_name, m.player.id, myPlayerId, m.team, myTeam, m.is_captain)}</span>
                      <span className={styles.allowedTag}>Allowed</span>
                    </div>
                  ))}
                </div>
              </div>

              {blockedRecipientsList.length > 0 && (
                <div>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, marginBottom: '4px', color: '#ef4444' }}>
                    Blocked Recipients ({blockedRecipientsList.length})
                  </div>
                  <div className={styles.recipientList}>
                    {blockedRecipientsList.map((m) => (
                      <div key={m.player.id} className={styles.recipientItem}>
                        <span>{formatPlayerWithTeam(m.player.display_name, m.player.id, myPlayerId, m.team, myTeam, m.is_captain)}</span>
                        <span className={styles.blockedTag}>Blocked</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* C. Teammate Selection (if in SELECTED_PLAYERS mode) */}
            {voiceMode === 'SELECTED_PLAYERS' && (
              <div>
                <div className={styles.sectionTitle}>Pick Teammates Who Can Hear You</div>
                <div className={styles.recipientList}>
                  {members
                    .filter((m) => m.player.id !== myPlayerId && m.team === myTeam)
                    .map((m) => {
                      const isChecked = selectedRecipients.includes(m.player.id)
                      return (
                        <label key={m.player.id} className={styles.recipientItem} style={{ cursor: 'pointer' }}>
                          <span>{formatPlayerWithTeam(m.player.display_name, m.player.id, myPlayerId, m.team, myTeam, m.is_captain)}</span>
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleRecipientSelection(m.player.id)}
                          />
                        </label>
                      )
                    })}
                </div>
              </div>
            )}

            {/* D. Receiving Audio & Volume Controls */}
            <div>
              <div className={styles.sectionTitle}>Participant Audio Controls (What You Hear)</div>
              <div className={styles.volumeControlsSection}>
                {members
                  .filter((m) => m.player.id !== myPlayerId)
                  .map((m) => {
                    const peerId = m.player.id
                    const isLocallyMuted = playerMutes[peerId] || false
                    const vol = playerVolumes[peerId] ?? 1
                    const isSpeaking = voiceStates[peerId]?.is_speaking || false
                    return (
                      <div key={peerId} className={styles.playerAudioRow}>
                        <span className={styles.playerAudioName}>
                          {isSpeaking ? '🟢 ' : '⚪ '}
                          {formatPlayerWithTeam(m.player.display_name, peerId, myPlayerId, m.team, myTeam, m.is_captain)}
                        </span>
                        <div className={styles.sliderGroup}>
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            value={isLocallyMuted ? 0 : vol}
                            onChange={(e) => handlePlayerVolumeChange(peerId, parseFloat(e.target.value))}
                            className={styles.volumeSlider}
                            title={`Volume: ${Math.round(vol * 100)}%`}
                          />
                          <button
                            type="button"
                            className={styles.localMuteBtn}
                            onClick={() => handleTogglePlayerMute(peerId)}
                            title={isLocallyMuted ? 'Unmute Player' : 'Mute Player Locally'}
                          >
                            {isLocallyMuted ? '🔇' : '🔊'}
                          </button>
                        </div>
                      </div>
                    )
                  })}
              </div>
            </div>

            <button
              type="button"
              className="btn btn-primary"
              style={{ width: '100%', marginTop: '4px', padding: '10px' }}
              onClick={() => setShowPermissionsModal(false)}
            >
              Done & Save Permissions
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
