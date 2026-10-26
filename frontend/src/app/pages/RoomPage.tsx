/**
 * Room/Lobby Page – waiting room, team assignment, rules, toss, start match.
 */

import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useSocket } from '../../hooks/useSocket'
import { ThemeToggle } from '../../context/ThemeContext'
import { CoinTossModal } from '../components/CoinTossModal'
import { Footer } from '../components/Footer'
import { NetworkIndicator } from '../components/NetworkIndicator'
import { VoiceChat } from '../components/VoiceChat'
import { sound } from '../../services/sound'
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
    startMatch,
    callToss,
    decideToss,
    ackRules,
    setReady,
    assignTeam,
    updateSettings,
    updateTeams,
    updateVoiceState,
    sendChat,
  } = useSocket(sessionToken)

  const [chatInput, setChatInput] = useState('')
  const [rulesAcked, setRulesAcked] = useState(false)
  const [showRules, setShowRules] = useState(true)
  const [overs, setOvers] = useState(2)

  const room: RoomInfo | null = snapshot?.room ?? null
  const members: MemberInfo[] = snapshot?.members ?? []
  const myMembership = members.find(m => m.player.id === myPlayerId)
  const isHost = myMembership?.is_host ?? false

  // Instant room synchronization on mount & connection
  useEffect(() => {
    if (roomId) {
      syncRoom(roomId)
    }
  }, [roomId, syncRoom, status])

  // Navigate to arena when match starts
  useEffect(() => {
    if (snapshot?.match && snapshot.room.status === 'INNINGS_ACTIVE') {
      navigate(`/room/${roomId}/arena`)
    }
  }, [snapshot?.room?.status, snapshot?.match, navigate, roomId])

  useEffect(() => {
    if (room?.overs) setOvers(room.overs)
  }, [room?.overs])

  function handleAckRules() {
    sound.playClick()
    if (roomId) ackRules(roomId)
    setRulesAcked(true)
    setShowRules(false)
  }

  function handleReady() {
    sound.playClick()
    if (roomId) setReady(roomId, true)
  }

  function handleStartMatch() {
    sound.playClick()
    if (roomId) startMatch(roomId)
  }

  function handleCallToss(choice: 'HEADS' | 'TAILS') {
    if (roomId) callToss(roomId, choice)
  }

  function handleDecideToss(decision: 'BAT' | 'BOWL') {
    if (roomId) decideToss(roomId, decision)
  }

  function handleAssignTeam(playerId: string, team: 'A' | 'B') {
    sound.playClick()
    if (roomId) assignTeam(roomId, playerId, team)
  }

  function handleOversChange(o: number) {
    setOvers(o)
    if (roomId) updateSettings(roomId, o)
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
        <p>Connecting to room…</p>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ marginTop: '8px' }}
          onClick={() => roomId && syncRoom(roomId)}
        >
          🔄 Refresh Connection
        </button>
      </div>
    )
  }

  const teamA = members.filter(m => m.team === 'A')
  const teamB = members.filter(m => m.team === 'B')
  const allReady = members.length >= 2 && members.every(m => m.readiness === 'READY')

  function handleUpdateTeamAName(newName: string) {
    if (!roomId) return
    sound.playClick()
    updateTeams(roomId, newName, room?.team_b_name || 'Team B')
  }

  function handleUpdateTeamBName(newName: string) {
    if (!roomId) return
    sound.playClick()
    updateTeams(roomId, room?.team_a_name || 'Team A', newName)
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.logo}>
            <img src="/logo.jpg" alt="FoldCricket" className={styles.logoImg} />
            <span>FoldCricket</span>
          </div>
          {room && (
            <span className={styles.statusBadge} data-status={room.status}>
              {room.status.replace(/_/g, ' ')}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Voice Chat Microphone facility */}
          <VoiceChat
            roomId={roomId || ''}
            myPlayerId={myPlayerId}
            myDisplayName={myMembership?.player.display_name || ''}
            voiceStates={voiceStates}
            onVoiceStateChange={updateVoiceState}
          />

          {/* Real-time Internet Speed Indicator with signal bars & reconnecting banner */}
          <NetworkIndicator status={status} latency={pingLatency} />

          <ThemeToggle />
          {room && (
            <div className={styles.joinInfo}>
              <span className={styles.joinLabel}>Room Code</span>
              <span className={styles.joinCode}>{room.join_code}</span>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                onClick={() => {
                  sound.playClick()
                  navigator.clipboard.writeText(room.join_code)
                }}
                aria-label="Copy room code"
              >
                Copy
              </button>
            </div>
          )}
        </div>
      </header>

      <div className={styles.layout}>
        {/* Left – teams */}
        <section className={styles.teamsPanel}>
          <h2 className={styles.sectionTitle}>Teams</h2>

          {isHost && (
            <div className={styles.settingsRow}>
              <div className={styles.settingsHeader}>
                <span className={styles.settingsLabel}>Match Overs:</span>
                <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--color-team-a)', fontSize: '1.1rem' }}>
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
                aria-label="Room Overs Range Slider"
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
          )}

          <div className={styles.teamsGrid}>
            <TeamColumn
              label={room?.team_a_name || 'Team A'}
              members={teamA}
              myPlayerId={myPlayerId}
              isHost={isHost}
              team="A"
              onAssign={handleAssignTeam}
              onUpdateTeamName={handleUpdateTeamAName}
            />
            <TeamColumn
              label={room?.team_b_name || 'Team B'}
              members={teamB}
              myPlayerId={myPlayerId}
              isHost={isHost}
              team="B"
              onAssign={handleAssignTeam}
              onUpdateTeamName={handleUpdateTeamBName}
            />
          </div>

          {/* Unassigned */}
          {members.some(m => !m.team) && (
            <div className={styles.unassigned}>
              <p className={styles.unassignedLabel}>Waiting for assignment</p>
              {members.filter(m => !m.team).map(m => (
                <div key={m.player.id} className={styles.unassignedPlayer}>
                  <span>{m.player.display_name}</span>
                  {isHost && (
                    <div className={styles.assignBtns}>
                      <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '0.78rem' }} onClick={() => handleAssignTeam(m.player.id, 'A')}>→ A</button>
                      <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '0.78rem' }} onClick={() => handleAssignTeam(m.player.id, 'B')}>→ B</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className={styles.actions}>
            {!rulesAcked && (
              <button className="btn btn-primary" onClick={() => setShowRules(true)}>
                📋 View & Acknowledge Rules
              </button>
            )}
            {rulesAcked && (
              <button className="btn btn-success" onClick={handleReady}>
                ✅ Ready
              </button>
            )}
            {isHost && (
              <button
                className="btn btn-primary"
                onClick={handleStartMatch}
                disabled={!allReady}
                title={!allReady ? 'Wait for all players to be ready' : ''}
              >
                🪙 Start Toss & Match
              </button>
            )}
          </div>

          {members.length < 2 && (
            <p className={styles.waitingMsg}>⏳ Waiting for opponent to join…</p>
          )}
        </section>

        {/* Right – chat */}
        <section className={styles.chatPanel}>
          <h2 className={styles.sectionTitle}>Chat</h2>
          <div className={styles.chatMessages}>
            {chatMessages.length === 0 && (
              <p className={styles.chatEmpty}>No messages yet. Say hi! 👋</p>
            )}
            {chatMessages.map((msg, i) => (
              <div key={i} className={styles.chatMsg}>
                <span className={styles.chatName}>{msg.display_name}</span>
                <span className={styles.chatText}>{msg.text}</span>
                <span className={styles.chatTime}>
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </div>
          <form onSubmit={handleSendChat} className={styles.chatForm}>
            <input
              className="input"
              placeholder="Type a message…"
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              maxLength={200}
            />
            <button type="submit" className="btn btn-primary" style={{ padding: '10px 16px' }}>
              Send
            </button>
          </form>
        </section>
      </div>

      {/* Rules modal */}
      {showRules && (
        <div className={styles.modalOverlay} role="dialog" aria-modal aria-label="Rules">
          <div className={styles.modal}>
            <h2 className={styles.modalTitle}>📋 FoldCricket Match Rules</h2>
            <div className={styles.rulesContent}>
              <p>1. Each player picks a number from <strong>1 to 10</strong> per delivery.</p>
              <p>2. If both picks are <strong>equal → the batter is OUT</strong>.</p>
              <p>3. If picks differ → the batter scores <strong>their chosen number</strong>.</p>
              <p>4. Each delivery has a <strong>15-second</strong> server-enforced deadline.</p>
              <p>5. An innings ends when the <strong>over limit or wicket limit</strong> is reached.</p>
              <p>6. Second innings target = first innings runs + 1.</p>
              <p>7. A disconnect starts a <strong>120-second</strong> grace period; then forfeit applies.</p>
              <p>8. The smaller team receives <strong>one extra wicket</strong> allowance.</p>
            </div>
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleAckRules}>
              ✅ I Understand – Continue
            </button>
          </div>
        </div>
      )}

      {/* 3D Animated Coin Toss Modal */}
      {room?.status === 'TOSS' && (
        <CoinTossModal
          toss={room.toss}
          myPlayerId={myPlayerId}
          onCall={handleCallToss}
          onDecide={handleDecideToss}
        />
      )}

      <Footer />
    </div>
  )
}

function TeamColumn({
  label,
  members,
  myPlayerId,
  isHost,
  team,
  onAssign,
  onUpdateTeamName,
}: {
  label: string
  members: MemberInfo[]
  myPlayerId: string
  isHost: boolean
  team: 'A' | 'B'
  onAssign: (playerId: string, team: 'A' | 'B') => void
  onUpdateTeamName: (newName: string) => void
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
            <h3 className={styles.teamLabel}>{label}</h3>
            <button
              type="button"
              className={styles.editTeamBtn}
              onClick={() => setIsEditing(true)}
              title="Edit Team Name"
              aria-label="Edit Team Name"
            >
              ✏️
            </button>
          </div>
        )}
        <span className={styles.memberCountBadge}>{members.length} Players</span>
      </div>

      {members.length === 0 && <p className={styles.emptyTeam}>No players yet</p>}
      {members.map(m => (
        <div
          key={m.player.id}
          className={`${styles.playerRow} ${m.player.id === myPlayerId ? styles.myRow : ''}`}
        >
          <span className={styles.playerName}>{m.player.display_name}</span>
          <div className={styles.playerBadges}>
            {m.is_host && <span className="badge badge-warning">Host</span>}
            {m.is_captain && <span className="badge badge-a">Captain</span>}
            <span className={`badge ${m.readiness === 'READY' ? 'badge-success' : 'badge-warning'}`}>
              {m.readiness}
            </span>
          </div>
          {isHost && m.player.id !== myPlayerId && (
            <button
              className="btn btn-secondary"
              style={{ padding: '4px 8px', fontSize: '0.75rem' }}
              onClick={() => onAssign(m.player.id, team === 'A' ? 'B' : 'A')}
            >
              Move to {team === 'A' ? 'B' : 'A'}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
