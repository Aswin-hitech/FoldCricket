/**
 * Room/Lobby Page – waiting room, team assignment, match settings, toss, and start match.
 * Features 10-second post-toss decision announcement, dynamic team naming, and broadcast gaming UI.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useSocket } from '../../hooks/useSocket'
import { useNetworkQuality } from '../../hooks/useNetworkQuality'
import { ThemeToggle } from '../../context/ThemeContext'
import { CoinTossModal } from '../components/CoinTossModal'
import { Footer } from '../components/Footer'
import { NetworkIndicator } from '../components/NetworkIndicator'
import { VoiceChat } from '../components/VoiceChat'
import { VoiceTour } from '../components/VoiceTour'
import { sound } from '../../services/sound'
import { claimVoiceTour } from '../../services/voiceTour'
import { formatPlayerWithTeam } from '../../utils/teamLabels'
import type { MemberInfo, RoomInfo } from '../../services/types'
import styles from './RoomPage.module.css'

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const sessionToken = localStorage.getItem('hcl_session') || undefined
  const myPlayerId = localStorage.getItem('hcl_player_id') || ''

  const {
    status,
    snapshot,
    chatMessages,
    pingLatency,
    voiceStates,
    syncRoom,
    reconnect,
    startMatch,
    callToss,
    decideToss,
    ackRules,
    setReady,
    assignTeam,
    updateSettings,
    updateTeams,
    updateVoiceState,
    voiceSignals,
    sendVoiceSignal,
    setVoiceMode,
    crossTeamRequests,
    requestCrossTeamVoice,
    respondCrossTeamVoice,
    revokeCrossTeamVoice,
    incomingVideoCall,
    videoCallPeer,
    videoCallError,
    clearVideoCallError,
    requestVideoCall,
    respondVideoCall,
    endVideoCall,
    sendChat,
    leaveLobby,
    removePlayerFromLobby,
    lobbyLeft,
    lobbyRemoved,
    lobbyRemoveAck,
    clearLobbyLeft,
    clearLobbyRemoved,
    clearLobbyRemoveAck,
  } = useSocket(sessionToken)

  const videoNetwork = useNetworkQuality(pingLatency)

  const [chatInput, setChatInput] = useState('')
  const [rulesAcked, setRulesAcked] = useState(false)
  const [showRules, setShowRules] = useState(false)
  const [overs, setOvers] = useState(2)
  const [wickets, setWickets] = useState(1)
  const [copiedLink, setCopiedLink] = useState(false)
  const [copiedCode, setCopiedCode] = useState(false)
  const [tossCountdown, setTossCountdown] = useState<number | null>(null)
  const [isSoundMuted, setIsSoundMuted] = useState(() => sound.isMuted())

  // Lobby exit / captain removal UI
  const [showExitConfirm, setShowExitConfirm] = useState(false)
  const [exitError, setExitError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<MemberInfo | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  // Whether this client actually watched this match's toss happen. Someone who
  // lands on the room at the first-ball gate must never be shown "Toss
  // Concluded" for a toss they never saw.
  const sawTossRef = useRef(false)

  // Voice introduction tour: runs in the lobby for the first 5 TEAM and first
  // 2 SOLO matches. `tourVoiceListOpen` drives the real Voice List modal.
  const [voiceTourOpen, setVoiceTourOpen] = useState(false)
  const [tourVoiceListOpen, setTourVoiceListOpen] = useState<boolean | undefined>(undefined)
  const voiceTourClaimedRef = useRef(false)

  // Keep sound mute state in sync
  useEffect(() => {
    const onSoundChange = (e: Event) => {
      const custom = e as CustomEvent<{ muted: boolean }>
      if (custom.detail) {
        setIsSoundMuted(custom.detail.muted)
      }
    }
    window.addEventListener('hcl:sound_mute_changed', onSoundChange)
    return () => window.removeEventListener('hcl:sound_mute_changed', onSoundChange)
  }, [])

  function handleToggleSound() {
    const next = sound.toggleMute()
    setIsSoundMuted(next)
    if (!next) {
      sound.playClick()
    }
  }

  const room: RoomInfo | null = snapshot?.room ?? null
  const members: MemberInfo[] = snapshot?.members ?? []
  const myMembership = members.find(m => m.player.id === myPlayerId)
  const isHost = myMembership?.is_host ?? false
  const isSpectator = Boolean(myMembership?.is_spectator)
  const inLobby = Boolean(
    room && ['WAITING_FOR_PLAYERS', 'LOBBY_READY', 'RULEBOOK_REQUIRED'].includes(room.status)
  )

  // Hosts remove anyone (except themselves/the host); other captains only their
  // own team, mirroring the server-side check.
  const canRemoveMember = (m: MemberInfo) => {
    if (!myMembership || m.player.id === myPlayerId || m.is_host) return false
    if (isHost) return true
    return Boolean(myMembership.is_captain && m.team && m.team === myMembership.team)
  }

  // Wait for a real lobby, then let players settle before the spotlight opens.
  // Spectators are not playing, so the mic tour never applies to them.
  useEffect(() => {
    if (!roomId || !myPlayerId || isSpectator) return
    const mode = room?.mode
    if (mode !== 'TEAM' && mode !== 'SOLO') return
    if (room?.status !== 'LOBBY_READY' || voiceTourClaimedRef.current) return
    voiceTourClaimedRef.current = true
    if (!claimVoiceTour(myPlayerId, mode, roomId)) return
    const timer = setTimeout(() => setVoiceTourOpen(true), 1200)
    return () => clearTimeout(timer)
  }, [roomId, myPlayerId, room?.mode, room?.status, isSpectator])

  // The tour belongs to the lobby; never let it follow the room into the match.
  useEffect(() => {
    if (voiceTourOpen && room?.status !== 'LOBBY_READY') {
      setVoiceTourOpen(false)
      setTourVoiceListOpen(false)
    }
  }, [room?.status, voiceTourOpen])

  const openVoiceListForTour = useCallback(() => setTourVoiceListOpen(true), [])
  const closeVoiceListForTour = useCallback(() => setTourVoiceListOpen(false), [])
  const finishVoiceTour = useCallback(() => {
    setVoiceTourOpen(false)
    setTourVoiceListOpen(false)
  }, [])

  // Instant room synchronization on mount & connection
  useEffect(() => {
    if (roomId) {
      syncRoom(roomId)
    }
  }, [roomId, syncRoom, status])

  // Sync settings when room snapshot updates
  useEffect(() => {
    if (room?.overs) setOvers(room.overs)
    if (room?.wickets) setWickets(room.wickets)
  }, [room?.overs, room?.wickets])

  // 10-Second Toss Conclusion Display:
  // When toss winner makes choice, hold for exactly 10s showing the decision before moving to Arena.
  // It only belongs to the window between this match's toss decision and its arena entry.
  useEffect(() => {
    if (snapshot?.room?.status === 'TOSS') sawTossRef.current = true
  }, [snapshot?.room?.status])

  useEffect(() => {
    const roomStatus = snapshot?.room?.status
    if (
      roomStatus === 'INNINGS_ACTIVE' ||
      roomStatus === 'INNINGS_BREAK' ||
      roomStatus === 'PAUSED'
    ) {
      // Rejoining a match already in progress: go straight to the arena
      navigate(`/room/${roomId}/arena`, { replace: true })
      return
    }

    const tossConcluded = roomStatus === 'AWAITING_FIRST_BALL' && Boolean(room?.toss?.elected_choice)
    if (!tossConcluded) {
      // Back in a lobby/finished room: drop any leftover countdown so a later toss starts fresh.
      if (tossCountdown !== null && roomStatus !== 'TOSS') setTossCountdown(null)
      return
    }

    if (!sawTossRef.current) {
      // Joined or reloaded at the gate: no toss replay, go straight in.
      navigate(`/room/${roomId}/arena`, { replace: true })
      return
    }

    if (tossCountdown === null) {
      setTossCountdown(10)
    } else if (tossCountdown > 0) {
      const timer = setTimeout(() => {
        setTossCountdown(prev => (prev !== null && prev > 0 ? prev - 1 : 0))
      }, 1000)
      return () => clearTimeout(timer)
    } else {
      // Arena shows the "Are you ready for the first ball?" gate
      navigate(`/room/${roomId}/arena`, { replace: true })
    }
  }, [room?.toss?.elected_choice, tossCountdown, snapshot?.room?.status, roomId, navigate])

  function handleAckRules() {
    sound.playClick()
    if (roomId) ackRules(roomId)
    setRulesAcked(true)
    setShowRules(false)
  }

  function handleReadyToggle() {
    sound.playClick()
    if (roomId && myMembership) {
      const nextState = myMembership.readiness !== 'READY'
      setReady(roomId, nextState)
    }
  }

  function handleStartMatch() {
    sound.playClick()
    if (roomId) startMatch(roomId)
  }

  function handleCallToss(choice: 'HEADS' | 'TAILS') {
    if (roomId) callToss(roomId, choice)
  }

  function handleDecideToss(decision: 'BAT' | 'BOWL') {
    if (roomId) {
      sound.playClick()
      decideToss(roomId, decision)
      setTossCountdown(10)
    }
  }

  function handleAssignTeam(playerId: string, team: 'A' | 'B') {
    sound.playClick()
    if (roomId) assignTeam(roomId, playerId, team)
  }

  function handleLeaveLobby() {
    sound.playClick()
    if (!roomId) return
    setExitError(null)
    leaveLobby(roomId)
  }

  function handleConfirmRemove() {
    if (!roomId || !removeTarget) return
    sound.playClick()
    setRemoveError(null)
    removePlayerFromLobby(roomId, removeTarget.player.id)
  }

  // Leaving is confirmed by the server; navigate only once it succeeded.
  useEffect(() => {
    if (!lobbyLeft) return
    if (lobbyLeft.success) {
      navigate('/', { replace: true })
      return
    }
    setExitError(lobbyLeft.error || 'Could not leave the lobby')
    clearLobbyLeft()
  }, [lobbyLeft, navigate, clearLobbyLeft])

  useEffect(() => {
    if (!lobbyRemoveAck) return
    if (lobbyRemoveAck.success) {
      setRemoveTarget(null)
      setRemoveError(null)
    } else {
      setRemoveError(lobbyRemoveAck.error || 'Could not remove this player')
    }
    clearLobbyRemoveAck()
  }, [lobbyRemoveAck, clearLobbyRemoveAck])

  function handleOversChange(o: number) {
    setOvers(o)
    if (roomId) updateSettings(roomId, o, wickets)
  }

  function handleWicketsChange(w: number) {
    setWickets(w)
    if (roomId) updateSettings(roomId, overs, w)
  }

  function handleSendChat(e: React.FormEvent) {
    e.preventDefault()
    const text = chatInput.trim()
    if (!text || !roomId) return
    sound.playClick()
    sendChat(roomId, text)
    setChatInput('')
  }

  // Smooth synced loading screen with retry fallback
  if (status === 'connecting' && !snapshot) {
    return (
      <div className={styles.centered}>
        <div className={styles.loader} />
        <p>Connecting to game room…</p>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginTop: '8px' }}
          onClick={() => {
            if (!roomId) return
            reconnect()
            syncRoom(roomId)
          }}
        >
          🔄 Refresh Connection
        </button>
      </div>
    )
  }

  // Spectators never hold a team slot, count towards readiness, or gate the
  // start of the match.
  const players = members.filter(m => !m.is_spectator)
  const spectators = members.filter(m => m.is_spectator)
  const teamA = players.filter(m => m.team === 'A')
  const teamB = players.filter(m => m.team === 'B')
  const unassigned = players.filter(m => !m.team)
  const allReady = players.length >= 2 && players.every(m => m.readiness === 'READY')

  // Dynamic default team naming: <Player Name>'s Team
  const defaultTeamAName = teamA[0]?.player.display_name ? `${teamA[0].player.display_name}'s Team` : 'Team A'
  const defaultTeamBName = teamB[0]?.player.display_name ? `${teamB[0].player.display_name}'s Team` : 'Team B'

  const displayTeamAName = room?.team_a_name && room.team_a_name !== 'Team A' ? room.team_a_name : defaultTeamAName
  const displayTeamBName = room?.team_b_name && room.team_b_name !== 'Team B' ? room.team_b_name : defaultTeamBName

  function handleUpdateTeamAName(newName: string) {
    if (!roomId) return
    sound.playClick()
    updateTeams(roomId, newName, displayTeamBName)
  }

  function handleUpdateTeamBName(newName: string) {
    if (!roomId) return
    sound.playClick()
    updateTeams(roomId, displayTeamAName, newName)
  }

  return (
    <div className={styles.page}>
      {/* Top Navigation Bar */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.logo}>
            <img src="/logo.jpg" alt="FoldCricket" className={styles.logoImg} />
            <span>FoldCricket</span>
          </div>
          {room && (
            <span className={styles.statusBadge} data-status={room.status}>
              {room.status === 'LOBBY_READY' ? 'Lobby Ready' : room.status.replace(/_/g, ' ')}
            </span>
          )}
          {isSpectator && (
            <span className={styles.statusBadge} data-status="SPECTATOR">
              👀 Spectator
            </span>
          )}
        </div>

        <div className={styles.headerRight}>
          {/* Voice Chat Microphone facility */}
          <VoiceChat
            roomId={roomId || ''}
            myPlayerId={myPlayerId}
            myDisplayName={myMembership?.player.display_name || ''}
            voiceStates={voiceStates}
            onVoiceStateChange={updateVoiceState}
            members={members}
            incomingVoiceSignals={voiceSignals}
            onSendSignal={sendVoiceSignal}
            onSetVoiceMode={setVoiceMode}
            isTeamMatch={room?.mode === 'TEAM'}
            crossTeamRequests={crossTeamRequests}
            onRequestCrossTeam={requestCrossTeamVoice}
            onRespondCrossTeam={respondCrossTeamVoice}
            onRevokeCrossTeam={revokeCrossTeamVoice}
            voicePermissions={snapshot?.voice_permissions || []}
            isSoundMuted={isSoundMuted}
            videoNetwork={videoNetwork}
            videoCallPeer={videoCallPeer}
            incomingVideoCall={incomingVideoCall}
            onRequestVideoCall={requestVideoCall}
            onRespondVideoCall={respondVideoCall}
            onEndVideoCall={endVideoCall}
            videoCallError={videoCallError}
            onClearVideoCallError={clearVideoCallError}
            isOpenVoiceList={tourVoiceListOpen}
            onCloseVoiceList={closeVoiceListForTour}
          />

          {/* Leave the lobby (available to every player, host included) */}
          {inLobby && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                sound.playClick()
                setExitError(null)
                setShowExitConfirm(true)
              }}
              title="Leave this lobby"
              style={{ height: '36px', padding: '6px 14px', borderRadius: '999px', fontSize: '0.82rem', fontWeight: 700 }}
            >
              🚪 <span className={styles.controlLabel}>Exit Lobby</span>
            </button>
          )}

          {/* Sound Toggle (Speaker output for voice chat & sounds) */}
          <button
            type="button"
            className={`btn btn-secondary ${styles.soundBtn}`}
            onClick={handleToggleSound}
            title={isSoundMuted ? 'Sound is OFF: Click to turn Sound ON and hear other players' : 'Sound is ON: Hearing other players & game. Click to Mute'}
            style={{
              height: '36px',
              padding: '6px 14px',
              borderRadius: '999px',
              fontSize: '0.82rem',
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              background: isSoundMuted ? 'var(--color-surface-2)' : 'rgba(34, 197, 94, 0.15)',
              borderColor: isSoundMuted ? 'var(--color-border)' : 'rgba(34, 197, 94, 0.5)',
              color: isSoundMuted ? 'var(--color-text)' : '#22c55e',
            }}
            aria-label={isSoundMuted ? 'Turn sound on' : 'Mute sound'}
          >
            <span aria-hidden="true">{isSoundMuted ? '🔇' : '🔊'}</span>
            <span className={styles.controlLabel}>{isSoundMuted ? 'Sound Off' : 'Sound On'}</span>
          </button>

          {/* Real-time Internet Speed Indicator with signal bars */}
          <NetworkIndicator status={status} latency={pingLatency} />

          {/* Theme Toggle */}
          <ThemeToggle />

          {/* Room Code & Share Link */}
          {room && (
            <div className={styles.joinInfo}>
              <span className={styles.joinLabel}>Room</span>
              <span className={styles.joinCode}>{room.join_code}</span>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '6px 10px', fontSize: '0.8rem' }}
                onClick={() => {
                  sound.playClick()
                  navigator.clipboard.writeText(room.join_code)
                  setCopiedCode(true)
                  setTimeout(() => setCopiedCode(false), 2000)
                }}
                title="Copy room code"
              >
                {copiedCode ? 'Copied! ✅' : 'Code'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ padding: '6px 12px', fontSize: '0.8rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                onClick={() => {
                  sound.playClick()
                  const link = `${window.location.origin}/join/${room.join_code}`
                  navigator.clipboard.writeText(link)
                  setCopiedLink(true)
                  setTimeout(() => setCopiedLink(false), 2000)
                }}
                title="Copy direct invite link for friends"
              >
                {copiedLink ? 'Link Copied! 📋' : '🔗 Copy Link'}
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main Broadcast Lobby Grid */}
      <div className={styles.layout}>
        {/* Left / Center – Match Settings & Teams Showcase */}
        <section className={styles.teamsPanel}>
          {/* Match Configuration Card */}
          <div className={styles.configCard}>
            <div className={styles.configHeader}>
              <div className={styles.configTitleRow}>
                <span className={styles.sectionTitle}>⚙️ Match Configuration</span>
                <span className={styles.modeBadge}>
                  {room?.mode === 'SOLO' ? '👤 1v1 Solo' : '👥 Team Match'}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                onClick={() => setShowRules(true)}
              >
                📋 View Rules
              </button>
            </div>

            {isHost ? (
              <div className={styles.settingsGrid}>
                {/* Overs Selection */}
                <div className={styles.settingBlock}>
                  <div className={styles.settingLabelRow}>
                    <span className={styles.settingLabel}>Match Overs:</span>
                    <span className={styles.settingValue}>
                      {overs} {overs === 1 ? 'Over' : 'Overs'} ({overs * 6} Balls)
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    step="1"
                    value={overs}
                    onChange={e => handleOversChange(Number(e.target.value))}
                    className={styles.rangeSlider}
                    aria-label="Match Overs Slider"
                  />
                  <div className={styles.quickChips}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(o => (
                      <button
                        key={o}
                        type="button"
                        className={`${styles.chipBtn} ${overs === o ? styles.chipBtnActive : ''}`}
                        onClick={() => handleOversChange(o)}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Wickets Selection */}
                <div className={styles.settingBlock}>
                  <div className={styles.settingLabelRow}>
                    <span className={styles.settingLabel}>
                      Wickets Per Team:
                      <small style={{ marginLeft: '6px', color: 'var(--color-text-muted)', fontWeight: 500 }}>
                        ({room?.mode === 'SOLO' ? 'Max 5 for Solo' : 'Max 10 for Group'})
                      </small>
                    </span>
                    <span className={styles.settingValue}>
                      {wickets} {wickets === 1 ? 'Wicket' : 'Wickets'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max={room?.mode === 'SOLO' ? 5 : 10}
                    step="1"
                    value={wickets}
                    onChange={e => handleWicketsChange(Number(e.target.value))}
                    className={styles.rangeSlider}
                    aria-label="Wickets Per Team Slider"
                  />
                  <div className={styles.quickChips}>
                    {(room?.mode === 'SOLO' ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).map(w => (
                      <button
                        key={w}
                        type="button"
                        className={`${styles.chipBtn} ${wickets === w ? styles.chipBtnActive : ''}`}
                        onClick={() => handleWicketsChange(w)}
                      >
                        {w}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className={styles.guestSummaryRow}>
                <div className={styles.guestSummaryItem}>
                  <span className={styles.summaryLabel}>Overs</span>
                  <span className={styles.summaryValue}>{overs} ({overs * 6} Balls)</span>
                </div>
                <div className={styles.guestSummaryItem}>
                  <span className={styles.summaryLabel}>Wickets Limit</span>
                  <span className={styles.summaryValue}>{wickets} per team</span>
                </div>
                <div className={styles.guestSummaryItem}>
                  <span className={styles.summaryLabel}>Delivery Timeout</span>
                  <span className={styles.summaryValue}>15 Seconds</span>
                </div>
              </div>
            )}
          </div>

          {/* Teams Showdown Card with Center VS Badge */}
          <div className={styles.teamsShowcaseCard}>
            <div className={styles.teamsGrid}>
              {/* Team A Card (Blue Accent) */}
              <TeamColumn
                label={displayTeamAName}
                members={teamA}
                myPlayerId={myPlayerId}
                myTeam={myMembership?.team}
                isHost={isHost}
                team="A"
                onAssign={handleAssignTeam}
                onUpdateTeamName={handleUpdateTeamAName}
                canRemove={canRemoveMember}
                onRemove={setRemoveTarget}
              />

              {/* Central VS Badge */}
              <div className={styles.vsBadgeContainer}>
                <div className={styles.vsBadge}>VS</div>
              </div>

              {/* Team B Card (Orange Accent) */}
              <TeamColumn
                label={displayTeamBName}
                members={teamB}
                myPlayerId={myPlayerId}
                myTeam={myMembership?.team}
                isHost={isHost}
                team="B"
                onAssign={handleAssignTeam}
                onUpdateTeamName={handleUpdateTeamBName}
                canRemove={canRemoveMember}
                onRemove={setRemoveTarget}
              />
            </div>

            {/* Unassigned Players Pool (if any) */}
            {unassigned.length > 0 && (
              <div className={styles.unassigned}>
                <p className={styles.unassignedLabel}>⏳ Waiting for Team Assignment</p>
                <div className={styles.unassignedList}>
                  {unassigned.map(m => (
                    <div key={m.player.id} className={styles.unassignedPlayer}>
                      <span className={styles.playerName}>{m.player.display_name}</span>
                      {isHost && (
                        <div className={styles.assignBtns}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                            onClick={() => handleAssignTeam(m.player.id, 'A')}
                          >
                            → {displayTeamAName}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                            onClick={() => handleAssignTeam(m.player.id, 'B')}
                          >
                            → {displayTeamBName}
                          </button>
                        </div>
                      )}
                      {canRemoveMember(m) && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{
                            padding: '4px 10px',
                            fontSize: '0.78rem',
                            borderColor: 'rgba(239, 68, 68, 0.5)',
                            color: '#ef4444',
                          }}
                          onClick={() => setRemoveTarget(m)}
                          title="Remove this player from the lobby"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Spectator Gallery */}
            {spectators.length > 0 && (
              <div className={styles.unassigned}>
                <p className={styles.unassignedLabel}>👀 Spectators ({spectators.length})</p>
                <div className={styles.unassignedList}>
                  {spectators.map(m => (
                    <div key={m.player.id} className={styles.unassignedPlayer}>
                      <span className={styles.playerName}>
                        {m.player.display_name}{m.player.id === myPlayerId ? ' (You)' : ''}
                      </span>
                      {isHost && (
                        <div className={styles.assignBtns}>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                            onClick={() => handleAssignTeam(m.player.id, 'A')}
                            title="Move this spectator into a team"
                          >
                            → {displayTeamAName}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary"
                            style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                            onClick={() => handleAssignTeam(m.player.id, 'B')}
                            title="Move this spectator into a team"
                          >
                            → {displayTeamBName}
                          </button>
                        </div>
                      )}
                      {canRemoveMember(m) && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{
                            padding: '4px 10px',
                            fontSize: '0.78rem',
                            borderColor: 'rgba(239, 68, 68, 0.5)',
                            color: '#ef4444',
                          }}
                          onClick={() => setRemoveTarget(m)}
                          title="Remove this spectator from the room"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Lower Action Row: Ready Toggle and Start Match Button */}
          <div className={styles.actionsBar}>
            {isSpectator ? (
              <div className={styles.spectatorNotice}>
                <span>👀 You are watching as a spectator</span>
                <small>You can chat with everyone. The host can move you into a team if a slot opens.</small>
              </div>
            ) : (
              <div className={styles.readyControl}>
                <button
                  type="button"
                  className={`${styles.readyBtn} ${myMembership?.readiness === 'READY' ? styles.readyBtnActive : ''}`}
                  onClick={handleReadyToggle}
                >
                  {myMembership?.readiness === 'READY' ? '✅ You are Ready' : '🟢 Click to Get Ready'}
                </button>
                <span className={styles.readyHint}>
                  {myMembership?.readiness === 'READY' ? 'Waiting for host to start the toss' : 'Mark yourself ready to begin'}
                </span>
              </div>
            )}

            {isHost && (
              <button
                type="button"
                className="btn btn-primary"
                style={{ padding: '12px 28px', fontSize: '1.05rem', fontWeight: 700 }}
                onClick={handleStartMatch}
                disabled={!allReady}
                title={!allReady ? 'Wait for all players to click Ready' : 'Start the match toss'}
              >
                🪙 Start Toss & Match
              </button>
            )}
          </div>

          {players.length < 2 && (
            <div className={styles.waitingBanner}>
              <span className={styles.pulseDot} />
              <span>Invite an opponent or share the room link above to start playing!</span>
            </div>
          )}
        </section>

        {/* Right – Integrated Match Lobby Chat */}
        <section className={styles.chatPanel}>
          <div className={styles.chatHeader}>
            <span className={styles.sectionTitle}>💬 Lobby Chat</span>
            <span className={styles.chatCounter}>{chatMessages.length} msgs</span>
          </div>

          <div className={styles.chatMessages}>
            {chatMessages.length === 0 ? (
              <p className={styles.chatEmpty}>No messages yet. Send a message to say hello! 👋</p>
            ) : (
              chatMessages.map((msg, i) => {
                const senderMem = members.find(m => m.player.display_name === msg.display_name || m.player.id === msg.player_id)
                return (
                  <div key={i} className={styles.chatMsg}>
                    <div className={styles.chatMsgTop}>
                      <span className={styles.chatName}>
                        {formatPlayerWithTeam(msg.display_name, senderMem?.player.id || msg.player_id, myPlayerId, senderMem?.team, myMembership?.team)}
                      </span>
                      <span className={styles.chatTime}>
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <span className={styles.chatText}>{msg.text}</span>
                  </div>
                )
              })
            )}
          </div>

          <form onSubmit={handleSendChat} className={styles.chatForm}>
            <input
              className="input"
              placeholder="Type in lobby chat…"
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              maxLength={200}
            />
            <button type="submit" className="btn btn-primary" style={{ padding: '10px 18px', fontWeight: 700 }}>
              Send
            </button>
          </form>
        </section>
      </div>

      {/* Rules Modal */}
      {showRules && (
        <div className={styles.modalOverlay} role="dialog" aria-modal aria-label="Rules">
          <div className={styles.modal}>
            <h2 className={styles.modalTitle}>📋 FoldCricket Match Rules</h2>
            <div className={styles.rulesContent}>
              <p>1. Each player picks a number from <strong>1, 2, 3, 4, 5, or 6</strong> per delivery.</p>
              <p>2. If both picks match exactly → the batter is <strong>OUT</strong>.</p>
              <p>3. If picks differ → the batter scores <strong>their chosen number</strong>.</p>
              <p>4. The first ball of each innings has a <strong>30-second</strong> deadline; every other ball <strong>15 seconds</strong>.</p>
              <p>5. If a player runs out of time, the delivery is dead: <strong>0 runs, no wicket</strong>, and the ball is <strong>re-bowled</strong>.</p>
              <p>6. An innings ends when the <strong>overs limit or wickets limit</strong> is reached.</p>
              <p>7. Second innings target = first innings runs + 1.</p>
              <p>8. Play begins only after every player confirms they are ready for the first ball.</p>
              <p>9. Toss is called by the visiting opponent; winner elects Bat or Bowl.</p>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: '100%', padding: '12px', fontWeight: 700 }}
              onClick={handleAckRules}
            >
              ✅ I Understand – Continue
            </button>
          </div>
        </div>
      )}

      {/* Exit Lobby Confirmation */}
      {showExitConfirm && (
        <div className={styles.modalOverlay} role="dialog" aria-modal aria-label="Exit lobby">
          <div className={styles.modal}>
            <h2 className={styles.modalTitle}>
              {isSpectator ? '👀 Stop Watching?' : '🚪 Exit Lobby?'}
            </h2>
            <p className={styles.modalText}>
              {isSpectator
                ? 'You will leave the spectator stand. The players stay in the lobby, and you can rejoin at any time with the room code.'
                : 'You will leave this room. The remaining players stay in the lobby, and you can rejoin later with the room code.'}
            </p>
            {exitError && <p className={styles.modalError}>{exitError}</p>}
            <div className={styles.modalActions}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ flex: 1, padding: '12px', fontWeight: 700 }}
                onClick={() => {
                  sound.playClick()
                  setShowExitConfirm(false)
                }}
              >
                Stay
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1, padding: '12px', fontWeight: 700 }}
                onClick={handleLeaveLobby}
              >
                {isSpectator ? 'Stop Watching' : 'Exit Lobby'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Captain removes a player */}
      {removeTarget && (
        <div className={styles.modalOverlay} role="dialog" aria-modal aria-label="Remove player">
          <div className={styles.modal}>
            <h2 className={styles.modalTitle}>Remove Player?</h2>
            <p className={styles.modalText}>
              Remove <strong>{removeTarget.player.display_name}</strong> from the lobby? They can
              rejoin later with the room code.
            </p>
            {removeError && <p className={styles.modalError}>{removeError}</p>}
            <div className={styles.modalActions}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ flex: 1, padding: '12px', fontWeight: 700 }}
                onClick={() => {
                  sound.playClick()
                  setRemoveTarget(null)
                  setRemoveError(null)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1, padding: '12px', fontWeight: 700 }}
                onClick={handleConfirmRemove}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* This player was removed from the lobby by a captain/host */}
      {lobbyRemoved && (
        <div className={styles.modalOverlay} role="dialog" aria-modal aria-label="Removed from lobby">
          <div className={styles.modal}>
            <h2 className={styles.modalTitle}>Removed from Lobby</h2>
            <p className={styles.modalText}>
              {lobbyRemoved.message || 'You were removed from this lobby.'}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: '100%', padding: '12px', fontWeight: 700 }}
              onClick={() => {
                sound.playClick()
                clearLobbyRemoved()
                navigate('/', { replace: true })
              }}
            >
              Back to Home
            </button>
          </div>
        </div>
      )}

      {/* 3D Animated Coin Toss Modal - runs during the toss and shows the
          decision for 10 seconds, only for the match that actually had it */}
      {(room?.status === 'TOSS' ||
        (room?.status === 'AWAITING_FIRST_BALL' &&
          Boolean(room?.toss?.elected_choice) &&
          tossCountdown !== null &&
          tossCountdown > 0)) && (
        <CoinTossModal
          toss={room?.toss}
          myPlayerId={myPlayerId}
          countdownSeconds={tossCountdown}
          onCall={handleCallToss}
          onDecide={handleDecideToss}
        />
      )}

      {voiceTourOpen && (
        <VoiceTour
          isTeamMatch={room?.mode === 'TEAM'}
          onOpenVoiceList={openVoiceListForTour}
          onCloseVoiceList={closeVoiceListForTour}
          onFinish={finishVoiceTour}
        />
      )}

      <div className={styles.pageFooter}>
        <Footer />
      </div>
    </div>
  )
}

function TeamColumn({
  label,
  members,
  myPlayerId,
  myTeam,
  isHost,
  team,
  onAssign,
  onUpdateTeamName,
  canRemove,
  onRemove,
}: {
  label: string
  members: MemberInfo[]
  myPlayerId: string
  myTeam?: string | null
  isHost: boolean
  team: 'A' | 'B'
  onAssign: (playerId: string, team: 'A' | 'B') => void
  onUpdateTeamName: (newName: string) => void
  canRemove: (m: MemberInfo) => boolean
  onRemove: (m: MemberInfo) => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [nameInput, setNameInput] = useState(label)

  useEffect(() => {
    setNameInput(label)
  }, [label])

  const handleSave = () => {
    setIsEditing(false)
    const trimmed = nameInput.trim()
    if (trimmed && trimmed !== label) {
      onUpdateTeamName(trimmed)
    }
  }

  return (
    <div className={`${styles.teamCol} ${team === 'A' ? styles.teamColA : styles.teamColB}`}>
      <div className={styles.teamHeaderRow}>
        {isEditing ? (
          <div className={styles.teamEditBox}>
            <input
              type="text"
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
              className={styles.teamNameInput}
              maxLength={24}
              autoFocus
            />
            <button type="button" className={styles.saveBtn} onClick={handleSave}>✓</button>
          </div>
        ) : (
          <div className={styles.teamTitleWrap}>
            <span className={styles.teamIcon}>{team === 'A' ? '🏏' : '⚾'}</span>
            <h3 className={styles.teamLabel}>{label}</h3>
            {isHost && (
              <button
                type="button"
                className={styles.editTeamBtn}
                onClick={() => setIsEditing(true)}
                title="Edit Team Name"
                aria-label="Edit Team Name"
              >
                ✏️
              </button>
            )}
          </div>
        )}
        <span className={styles.memberCountBadge}>{members.length} Player{members.length !== 1 ? 's' : ''}</span>
      </div>

      <div className={styles.playerList}>
        {members.length === 0 ? (
          <div className={styles.emptySlotPlaceholder}>
            <span>Waiting for player to join…</span>
          </div>
        ) : (
          members.map(m => (
            <div
              key={m.player.id}
              className={`${styles.playerRow} ${m.player.id === myPlayerId ? styles.myRow : ''}`}
            >
              <div className={styles.playerInfoCol}>
                <div className={styles.playerAvatar}>👤</div>
                <div className={styles.playerNameCol}>
                  <span className={styles.playerName}>
                    {formatPlayerWithTeam(m.player.display_name, m.player.id, myPlayerId, m.team, myTeam)}
                  </span>
                  <div className={styles.playerBadges}>
                    {m.is_host && <span className="badge badge-warning">Host</span>}
                    {m.is_captain && <span className={`badge ${team === 'A' ? 'badge-a' : 'badge-b'}`}>Captain</span>}
                  </div>
                </div>
              </div>

              <div className={styles.playerStatusCol}>
                <span className={`badge ${m.readiness === 'READY' ? 'badge-success' : 'badge-warning'}`}>
                  {m.readiness === 'READY' ? 'Ready' : 'Not Ready'}
                </span>
                {isHost && m.player.id !== myPlayerId && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ padding: '3px 8px', fontSize: '0.72rem' }}
                    onClick={() => onAssign(m.player.id, team === 'A' ? 'B' : 'A')}
                    title={`Move to ${team === 'A' ? 'Team B' : 'Team A'}`}
                  >
                    Move
                  </button>
                )}
                {canRemove(m) && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{
                      padding: '3px 8px',
                      fontSize: '0.72rem',
                      borderColor: 'rgba(239, 68, 68, 0.5)',
                      color: '#ef4444',
                    }}
                    onClick={() => onRemove(m)}
                    title="Remove this player from the lobby"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
