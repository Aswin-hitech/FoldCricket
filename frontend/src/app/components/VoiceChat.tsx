/**
 * VoiceChat – Real-Time Bi-Directional WebRTC Voice Communication.
 * Features:
 * - Peer-to-peer audio streaming with Google STUN servers
 * - Speech visualizer wave bars and active speaking indicator
 * - Team Match Voice Control:
 *     - Only active in team matches
 *     - Player list displaying: player - talk / block your voice
 *     - Real-time RTCRtpSender.replaceTrack(null / track) transport switching
 *     - Opponent protection presets: Talk to Everyone / Team Only
 */

import React, { useEffect, useRef, useState, useCallback } from 'react'
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
  incomingVoiceSignal?: { from_player_id: string; signal: unknown; timestamp: number } | null
  onSendSignal?: (roomId: string, targetId: string, signal: unknown) => void
  onSetVoiceMode?: (roomId: string, mode: string, allowedRecipients: string[]) => void
  isTeamMatch?: boolean
  isOpenVoiceList?: boolean
  onCloseVoiceList?: () => void
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
  isTeamMatch = false,
  isOpenVoiceList,
  onCloseVoiceList,
}) => {
  const [micEnabled, setMicEnabled] = useState(false)
  const [isMuted, setIsMuted] = useState(true)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [isSpeakingLocal, setIsSpeakingLocal] = useState(false)

  // Team Match Voice Control: tracks which players have outgoing voice blocked
  const [showVoiceListModal, setShowVoiceListModal] = useState(false)
  const [blockedRecipients, setBlockedRecipients] = useState<Record<string, boolean>>({})

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

  // Identify current player's team
  const myMem = members.find((m) => m.player.id === myPlayerId)
  const myTeam = myMem?.team

  // Synchronize external modal trigger if provided
  useEffect(() => {
    if (isOpenVoiceList !== undefined) {
      setShowVoiceListModal(isOpenVoiceList)
    }
  }, [isOpenVoiceList])

  // In team matches: initialize default blocked state (opponents default to blocked, teammates default to talk)
  useEffect(() => {
    if (!isTeamMatch || !myTeam) return
    setBlockedRecipients((prev) => {
      const updated = { ...prev }
      members.forEach((m) => {
        if (m.player.id === myPlayerId) return
        // Only set default if user has not yet customized this player
        if (updated[m.player.id] === undefined) {
          if (m.team && m.team !== myTeam) {
            updated[m.player.id] = true // Block opponents by default in team matches
          } else {
            updated[m.player.id] = false // Teammates can talk by default
          }
        }
      })
      return updated
    })
  }, [isTeamMatch, myTeam, members, myPlayerId])

  // Apply real-time transport permissions to WebRTC senders
  const applyVoicePermissions = useCallback(
    (blockedMap: Record<string, boolean>) => {
      const localTrack = mediaStreamRef.current?.getAudioTracks()[0]
      peerConnectionsRef.current.forEach((pc, peerId) => {
        const isBlocked = isTeamMatch && Boolean(blockedMap[peerId])
        const senders = pc.getSenders().filter((s) => !s.track || s.track.kind === 'audio')
        senders.forEach((s) => {
          if (!isBlocked && localTrack && localTrack.enabled && !isMuted) {
            s.replaceTrack(localTrack).catch(() => {})
          } else {
            s.replaceTrack(null).catch(() => {})
          }
        })
      })
    },
    [isTeamMatch, isMuted]
  )

  // Helper to create or get an RTCPeerConnection for a given peer ID
  const getOrCreatePeerConnection = useCallback(
    (peerId: string): RTCPeerConnection => {
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
          console.warn('Audio auto-play prevented (will resume on user interaction):', err)
        })
      }

      // Attach local audio track if we already have mic stream
      if (mediaStreamRef.current) {
        const isBlocked = isTeamMatch && Boolean(blockedRecipients[peerId])
        mediaStreamRef.current.getAudioTracks().forEach((track) => {
          try {
            const sender = pc.addTrack(track, mediaStreamRef.current!)
            if (isBlocked || isMuted) {
              sender.replaceTrack(null).catch(() => {})
            }
          } catch {
            // ignore duplicate track
          }
        })
      }

      return pc
    },
    [roomId, onSendSignal, isTeamMatch, blockedRecipients, isMuted]
  )

  // Attach local tracks to all existing peer connections respecting blocked state
  const addLocalTracksToAllPeers = useCallback(
    (stream: MediaStream) => {
      peerConnectionsRef.current.forEach((pc, peerId) => {
        const isBlocked = isTeamMatch && Boolean(blockedRecipients[peerId])
        const senders = pc.getSenders()
        stream.getAudioTracks().forEach((track) => {
          const existingSender = senders.find((s) => !s.track || s.track.kind === 'audio')
          if (existingSender) {
            existingSender.replaceTrack(isBlocked || isMuted ? null : track).catch(() => {})
          } else {
            try {
              const sender = pc.addTrack(track, stream)
              if (isBlocked || isMuted) {
                sender.replaceTrack(null).catch(() => {})
              }
            } catch {
              // ignore
            }
          }
        })
      })
    },
    [isTeamMatch, blockedRecipients, isMuted]
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

      // Set up Web Audio Analyser to detect speech volume
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

      // Broadcast ready signal to all members in the room
      members
        .filter((m) => m.player.id !== myPlayerId)
        .forEach((m) => {
          const pc = getOrCreatePeerConnection(m.player.id)
          onSendSignal?.(roomId, m.player.id, { type: 'ready' })

          // Lexicographically larger ID creates the initial offer
          if (myPlayerId > m.player.id) {
            pc.createOffer()
              .then((offer) => pc.setLocalDescription(offer).then(() => offer))
              .then((offer) => {
                onSendSignal?.(roomId, m.player.id, { type: 'offer', sdp: offer })
              })
              .catch((err) => console.warn('Error creating offer:', err))
          }
        })
    } catch (err) {
      console.error('Microphone access denied:', err)
      setPermissionError('Microphone permission denied. Allow mic access in your browser to talk.')
      setMicEnabled(false)
      setIsMuted(true)
    }
  }, [roomId, myPlayerId, members, onVoiceStateChange, onSendSignal, getOrCreatePeerConnection, addLocalTracksToAllPeers])

  // Handle incoming WebRTC signaling from peers
  useEffect(() => {
    if (!incomingVoiceSignal) return
    const { from_player_id, signal, timestamp } = incomingVoiceSignal
    if (timestamp === lastSignalTimeRef.current) return
    lastSignalTimeRef.current = timestamp

    const data = signal as {
      type: string
      sdp?: RTCSessionDescriptionInit
      candidate?: RTCIceCandidateInit
    }
    if (!data || !data.type) return

    const handleSignal = async () => {
      const pc = getOrCreatePeerConnection(from_player_id)

      if (data.type === 'ready') {
        if (myPlayerId > from_player_id) {
          try {
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            onSendSignal?.(roomId, from_player_id, { type: 'offer', sdp: offer })
          } catch (err) {
            console.warn('Error creating offer on ready:', err)
          }
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
          onSendSignal?.(roomId, from_player_id, { type: 'answer', sdp: answer })
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
  }, [incomingVoiceSignal, getOrCreatePeerConnection, onSendSignal, roomId, myPlayerId])

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
      const isBlocked = isTeamMatch && Boolean(blockedRecipients[peerId])
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

  // Set individual player voice action: talk (blocked=false) or block your voice (blocked=true)
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

  // Quick preset: Talk to Everyone
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

  // Quick preset: Team Only (Block Opponents)
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
      })
      audioElementsRef.current.clear()
    }
  }, [])

  // Find other players currently speaking in the room
  const activeSpeakers = Object.entries(voiceStates)
    .filter(([id, state]) => state.is_speaking && id !== myPlayerId)
    .map(([, state]) => state.player_name)

  const otherMembers = members.filter((m) => m.player.id !== myPlayerId)
  const blockedCount = otherMembers.filter((m) => blockedRecipients[m.player.id]).length
  const isTeamOnlyActive =
    otherMembers.length > 0 &&
    otherMembers.every((m) => {
      const isOpponent = Boolean(myTeam && m.team && m.team !== myTeam)
      return isOpponent ? blockedRecipients[m.player.id] : !blockedRecipients[m.player.id]
    })

  return (
    <div className={styles.voiceContainer}>
      {/* Microphone Main Toggle */}
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
        </button>
      )}

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
                  <span className={styles.modalSub}>Manage who can hear your voice in real time</span>
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
                  className={`${styles.presetBtn} ${blockedCount === 0 ? styles.presetBtnActive : ''}`}
                  onClick={setTalkToEveryone}
                >
                  🗣️ Talk to Everyone
                </button>
                <button
                  type="button"
                  className={`${styles.presetBtn} ${isTeamOnlyActive ? styles.presetBtnActive : ''}`}
                  onClick={setTeamOnly}
                >
                  🛡️ Team Only (Block Opponents)
                </button>
              </div>
            </div>

            {/* Player List */}
            <div className={styles.playerListSection}>
              <div className={styles.sectionTitleRow}>
                <span className={styles.sectionTitle}>PLAYER LIST:</span>
                <span className={styles.playerCountBadge}>
                  {otherMembers.length} Player{otherMembers.length !== 1 ? 's' : ''}
                </span>
              </div>

              {otherMembers.length === 0 ? (
                <div className={styles.emptyList}>
                  Waiting for other players to join the match...
                </div>
              ) : (
                <div className={styles.playerListContainer}>
                  {otherMembers.map((m) => {
                    const peerId = m.player.id
                    const isBlocked = Boolean(blockedRecipients[peerId])
                    const isTeammate = Boolean(myTeam && m.team === myTeam)
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
                            <span className={isTeammate ? styles.teammateTag : styles.opponentTag}>
                              {isTeammate ? '🛡️ My Team' : '⚔️ Opponent'}
                              {m.team ? ` (Team ${m.team})` : ''}
                            </span>
                            {m.is_captain && <span className={styles.captainTag}>⭐ Captain</span>}
                          </div>
                        </div>

                        {/* player - talk / block your voice */}
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
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className={styles.modalFooter}>
              <div className={styles.modalFooterHint}>
                💡 <strong>Tip:</strong> Switching between <em>Talk</em> and <em>Block your voice</em> applies instantly during the game without disconnecting audio.
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
