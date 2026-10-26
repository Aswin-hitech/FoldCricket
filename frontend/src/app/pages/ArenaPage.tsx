/**
 * Arena Page – TV Broadcast-style match screen.
 */

import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useSocket } from '../../hooks/useSocket'
import { ThemeToggle } from '../../context/ThemeContext'
import { sound } from '../../services/sound'
import { HandGesture } from '../components/HandGesture'
import { NetworkIndicator } from '../components/NetworkIndicator'
import { VoiceChat } from '../components/VoiceChat'
import { PitchAnimation } from '../components/PitchAnimation'
import { CelebrationEffects } from '../components/CelebrationEffects'
import type { DeliveryReveal, MatchInfo, MemberInfo } from '../../services/types'
import styles from './ArenaPage.module.css'

export default function ArenaPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const sessionToken = localStorage.getItem('hcl_session') || undefined
  const myPlayerId = localStorage.getItem('hcl_player_id') || ''

  const {
    status,
    snapshot,
    chatMessages,
    lastReveal,
    matchFinished,
    pingLatency,
    voiceStates,
    pausedInfo,
    syncRoom,
    selectBowler,
    submitPick,
    pauseMatch,
    resumeMatch,
    sendChat,
    updateVoiceState,
    incomingVoiceSignal,
    sendVoiceSignal,
  } = useSocket(sessionToken)

  const [chatInput, setChatInput] = useState('')
  const [selectedPick, setSelectedPick] = useState<number | null>(null)
  const [pickSubmitted, setPickSubmitted] = useState(false)
  const [revealAnimation, setRevealAnimation] = useState<DeliveryReveal | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [isMuted, setIsMuted] = useState(() => sound.isMuted())
  const [celebrationTrigger, setCelebrationTrigger] = useState<'SIX' | 'FOUR' | 'WICKET' | 'WIN' | null>(null)
  const countdownRef = useRef<NodeJS.Timeout | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

  const match: MatchInfo | null = snapshot?.match ?? null
  const members: MemberInfo[] = snapshot?.members ?? []
  const myMembership = members.find(m => m.player.id === myPlayerId)
  const isActiveBatter = match?.active_batter_id === myPlayerId
  const isActiveBowler = match?.active_bowler_id === myPlayerId
  const isActivePlayer = isActiveBatter || isActiveBowler
  const isHost = myMembership?.is_host ?? false
  const isCaptain = myMembership?.is_captain ?? false
  const isPaused = snapshot?.room?.status === 'PAUSED' || snapshot?.room?.is_paused || (pausedInfo?.paused ?? false)

  // Instant room sync on mount & reconnect
  useEffect(() => {
    if (roomId) {
      syncRoom(roomId)
    }
  }, [roomId, syncRoom, status])

  // Handle match finished with celebration sound and confetti
  useEffect(() => {
    if (matchFinished) {
      sound.playWin()
      setCelebrationTrigger('WIN')
      const timer = setTimeout(() => navigate(`/room/${roomId}/result`), 3500)
      return () => clearTimeout(timer)
    }
  }, [matchFinished, navigate, roomId])

  // Handle reveal animation, celebration particle triggers, and sound effects
  useEffect(() => {
    if (lastReveal) {
      setRevealAnimation(lastReveal)
      setPickSubmitted(false)
      setSelectedPick(null)

      if (lastReveal.result === 'OUT') {
        sound.playOut()
        setCelebrationTrigger('WICKET')
      } else if (lastReveal.runs_scored === 6) {
        sound.playSix()
        setCelebrationTrigger('SIX')
      } else if (lastReveal.runs_scored === 4) {
        sound.playFour()
        setCelebrationTrigger('FOUR')
      } else {
        sound.playRuns(lastReveal.runs_scored)
      }

      const timer = setTimeout(() => setRevealAnimation(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [lastReveal])

  // Countdown timer with tick sound
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current)
    if (!match?.delivery_deadline) { setCountdown(null); return }

    const tick = () => {
      const deadline = new Date(match.delivery_deadline!).getTime()
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      setCountdown(remaining)
      if (remaining <= 5 && remaining > 0) {
        sound.playTick()
      }
      if (remaining <= 0 && countdownRef.current) clearInterval(countdownRef.current)
    }
    tick()
    countdownRef.current = setInterval(tick, 500)
    return () => { if (countdownRef.current) clearInterval(countdownRef.current) }
  }, [match?.delivery_deadline])

  // Scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  function handlePickSelect(pick: number) {
    if (pickSubmitted || !isActivePlayer) return
    sound.playClick()
    setSelectedPick(pick)
  }

  function handlePickSubmit() {
    if (selectedPick === null || pickSubmitted || !roomId) return
    sound.playClick()
    submitPick(roomId, selectedPick)
    setPickSubmitted(true)
  }

  function handleSendChat(e: React.FormEvent) {
    e.preventDefault()
    const text = chatInput.trim()
    if (!text || !roomId) return
    sound.playClick()
    sendChat(roomId, text)
    setChatInput('')
  }

  function handleBowlerSelect(bowlerId: string) {
    if (!roomId) return
    sound.playClick()
    selectBowler(roomId, bowlerId)
  }

  const currentDelivery = snapshot?.current_delivery

  // Seamless delivery progression: automatically unlock keypad when server starts a new delivery
  useEffect(() => {
    if (isActiveBatter) {
      if (!currentDelivery || !currentDelivery.batter_submitted) {
        setPickSubmitted(false)
      }
    } else if (isActiveBowler) {
      if (!currentDelivery || !currentDelivery.bowler_submitted) {
        setPickSubmitted(false)
      }
    } else {
      setPickSubmitted(false)
    }
  }, [
    currentDelivery?.batter_submitted,
    currentDelivery?.bowler_submitted,
    isActiveBatter,
    isActiveBowler,
    match?.current_ball,
    match?.current_over,
    match?.phase,
  ])

  // Smooth loading without getting stuck
  if (!match) {
    if (
      snapshot?.room &&
      snapshot.room.status !== 'INNINGS_ACTIVE' &&
      snapshot.room.status !== 'MATCH_COMPLETE' &&
      snapshot.room.status !== 'PAUSED' &&
      snapshot.room.status !== 'INNINGS_BREAK'
    ) {
      navigate(`/room/${roomId}`)
      return null
    }

    return (
      <div className={styles.centered}>
        <div className={styles.loader} />
        <p>Loading arena…</p>
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

  const bowlingTeam = match.batting_team === 'A' ? 'B' : 'A'
  const bowlingMembers = members.filter(m => m.team === bowlingTeam)
  const needsBowlerSelect = !match.active_bowler_id && (isCaptain || isHost) && myMembership?.team === bowlingTeam

  return (
    <div className={styles.arena}>
      {/* Header */}
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerBrand}>
          <img src="/logo.jpg" alt="FoldCricket" className={styles.headerBrandLogo} />
          <span>FoldCricket</span>
        </div>
        <div className={styles.headerMeta}>
          <span className={styles.metaItem}>
            {match.phase === 'FIRST' ? '1st Innings' : '2nd Innings'}
          </span>
          <span className={styles.metaItem}>
            Over {match.current_over + 1}/{match.overs}
          </span>
          <span className={styles.metaItem}>
            Ball {match.current_ball + 1}/6
          </span>

          {/* Voice Chat Microphone facility */}
          <VoiceChat
            roomId={roomId || ''}
            myPlayerId={myPlayerId}
            myDisplayName={myMembership?.player.display_name || ''}
            voiceStates={voiceStates}
            onVoiceStateChange={updateVoiceState}
            members={members}
            incomingVoiceSignal={incomingVoiceSignal}
            onSendSignal={sendVoiceSignal}
          />

          {/* Real-time Internet Speed Indicator with signal bars & reconnecting banner */}
          <NetworkIndicator status={status} latency={pingLatency} />

          <button
            type="button"
            onClick={() => setIsMuted(sound.toggleMute())}
            className={styles.audioToggleBtn}
            title={isMuted ? 'Unmute Sound Effects' : 'Mute Sound Effects'}
            aria-label={isMuted ? 'Unmute Sound Effects' : 'Mute Sound Effects'}
          >
            {isMuted ? '🔇 Muted' : '🔊 Sound'}
          </button>

          <button
            type="button"
            onClick={() => roomId && (isPaused ? resumeMatch(roomId) : pauseMatch(roomId))}
            className={styles.audioToggleBtn}
            title={isPaused ? 'Resume Match' : 'Pause Match'}
            aria-label={isPaused ? 'Resume Match' : 'Pause Match'}
          >
            {isPaused ? '▶️ Resume' : '⏸️ Pause'}
          </button>
          <ThemeToggle />
        </div>
      </header>

      {/* Main layout */}
      <div className={styles.layout}>
        {/* Left – scoreboard + number pad */}
        <main className={styles.mainPanel}>
          {/* Scoreboard */}
          <div className={styles.scoreboard}>
            <ScoreCard
              label={match.team_a_name || 'Team A'}
              team="A"
              runs={match.team_a_runs}
              wickets={match.team_a_wickets}
              isBatting={match.batting_team === 'A'}
              target={match.batting_team === 'B' ? match.target : null}
            />
            <div className={styles.vsSection}>
              {match.target && match.batting_team !== 'A' ? (
                <div className={styles.target}>
                  Need {Math.max(0, match.target - match.team_b_runs)} from {(match.overs - match.current_over) * 6 - match.current_ball} balls
                </div>
              ) : match.target && match.batting_team !== 'B' ? (
                <div className={styles.target}>
                  Target {match.target}
                </div>
              ) : (
                <div className={styles.vs}>VS</div>
              )}
            </div>
            <ScoreCard
              label={match.team_b_name || 'Team B'}
              team="B"
              runs={match.team_b_runs}
              wickets={match.team_b_wickets}
              isBatting={match.batting_team === 'B'}
              target={match.batting_team === 'A' ? match.target : null}
            />
          </div>

          {/* Active players stage */}
          <div className={styles.stage}>
            <ActivePlayer
              label="🏏 Batter"
              playerId={match.active_batter_id}
              members={members}
              isMe={isActiveBatter}
              submitted={currentDelivery?.batter_submitted}
              pickRevealed={revealAnimation ? revealAnimation.batter_pick : null}
            />
            <PitchAnimation
              reveal={revealAnimation}
              countdown={countdown}
              hasBowler={!!match.active_bowler_id}
              isBatterSubmitted={!!currentDelivery?.batter_submitted}
              isBowlerSubmitted={!!currentDelivery?.bowler_submitted}
            />
            <ActivePlayer
              label="🎯 Bowler"
              playerId={match.active_bowler_id}
              members={members}
              isMe={isActiveBowler}
              submitted={currentDelivery?.bowler_submitted}
              pickRevealed={revealAnimation ? revealAnimation.bowler_pick : null}
            />

            {/* Stage Popup: WICKET !!! or +Runs popup */}
            {revealAnimation && (
              <div className={styles.stagePopupWrapper}>
                {revealAnimation.result === 'OUT' ? (
                  <div className={styles.wicketPopup}>
                    <span className={styles.wicketEmoji}>💥</span>
                    <div className={styles.wicketTitle}>WICKET !!!</div>
                    <div className={styles.wicketSub}>Equal numbers matched — Batter is OUT!</div>
                  </div>
                ) : (
                  <div
                    className={`${styles.runsPopup} ${
                      revealAnimation.runs_scored === 6
                        ? styles.runsSix
                        : revealAnimation.runs_scored === 4
                        ? styles.runsFour
                        : styles.runsNormal
                    }`}
                  >
                    <span className={styles.runsScoreText}>
                      +{revealAnimation.runs_scored}
                    </span>
                    <span className={styles.runsScoreLabel}>
                      {revealAnimation.runs_scored === 6
                        ? 'MAXIMUM! 6 RUNS'
                        : revealAnimation.runs_scored === 4
                        ? 'BOUNDARY! 4 RUNS'
                        : revealAnimation.runs_scored === 1
                        ? 'RUN'
                        : 'RUNS'}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bowler selection */}
          {needsBowlerSelect && (
            <div className={styles.bowlerSelect}>
              <h3>Select Bowler for this over</h3>
              <div className={styles.bowlerList}>
                {bowlingMembers.map(m => (
                  <button
                    key={m.player.id}
                    className="btn btn-secondary"
                    onClick={() => handleBowlerSelect(m.player.id)}
                  >
                    {m.player.display_name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Number pad with 1, 2, 3, 4, 6 and realistic hand gestures */}
          {isActivePlayer && match.active_bowler_id && (
            <div className={styles.numberPad}>
              <div className={styles.padHeader}>
                <p className={styles.padLabel}>
                  {isActiveBatter ? '🏏 Batter: Pick your run shot' : '🎯 Bowler: Pick your delivery'}
                </p>
                <span className={styles.padSubLabel}>
                  Traditional Hand Cricket: 1, 2, 3, 4, or 6
                </span>
              </div>
              <div className={styles.pad}>
                {[1, 2, 3, 4, 6].map(n => (
                  <button
                    key={n}
                    className={`${styles.padBtn} ${selectedPick === n ? styles.padBtnSelected : ''} ${pickSubmitted ? styles.padBtnDisabled : ''}`}
                    onClick={() => handlePickSelect(n)}
                    disabled={pickSubmitted}
                    aria-label={`Pick ${n}`}
                    aria-pressed={selectedPick === n}
                  >
                    <div className={styles.gestureSlot}>
                      <HandGesture number={n} size={36} />
                    </div>
                    <span className={styles.padBtnNumber}>{n}</span>
                  </button>
                ))}
              </div>
              <button
                className={`btn btn-primary ${styles.submitBtn}`}
                onClick={handlePickSubmit}
                disabled={selectedPick === null || pickSubmitted}
              >
                {pickSubmitted ? '✅ Pick Locked & Sent' : selectedPick !== null ? `🎯 Lock In ${selectedPick} Runs` : '👉 Choose 1, 2, 3, 4, or 6'}
              </button>
            </div>
          )}

          {!isActivePlayer && !needsBowlerSelect && (
            <div className={styles.spectatorMsg}>
              <span>👀 Watching the match…</span>
            </div>
          )}
        </main>

        {/* Right – roster + chat */}
        <aside className={styles.sidePanel}>
          {/* Roster */}
          <div className={styles.rosterSection}>
            <h2 className={styles.sidePanelTitle}>Roster</h2>
            <RosterList members={members} match={match} myPlayerId={myPlayerId} />
          </div>

          {/* Chat */}
          <div className={styles.chatSection}>
            <h2 className={styles.sidePanelTitle}>Chat</h2>
            <div className={styles.chatMessages}>
              {chatMessages.map((msg, i) => (
                <div key={i} className={styles.chatMsg}>
                  <span className={styles.chatName}>{msg.display_name}:</span>
                  <span>{msg.text}</span>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <form onSubmit={handleSendChat} className={styles.chatForm}>
              <input
                className="input"
                style={{ fontSize: '0.85rem', padding: '7px 10px' }}
                placeholder="Message…"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                maxLength={200}
              />
              <button type="submit" className="btn btn-secondary" style={{ padding: '7px 12px' }}>
                →
              </button>
            </form>
          </div>
        </aside>
      </div>

      {/* Match finished overlay */}
      {matchFinished && (
        <div className={styles.finishedOverlay}>
          <div className={styles.finishedCard}>
            <div className={styles.finishedEmoji}>🏆</div>
            <h2 className={styles.finishedTitle}>{matchFinished.result_summary}</h2>
            <p className={styles.finishedSub}>Redirecting to results…</p>
          </div>
        </div>
      )}

      {/* Paused / Reconnecting Overlay */}
      {isPaused && (
        <div className={styles.pausedOverlay} role="dialog" aria-modal aria-label="Match Paused">
          <div className={styles.pausedCard}>
            <div className={styles.pausedPulseRing}>
              <div className={styles.pausedSpinner} />
            </div>
            <div className={styles.pausedBadge}>MATCH PAUSED</div>
            <h2 className={styles.pausedTitle}>
              {pausedInfo?.reason === 'player_disconnected'
                ? 'Player Disconnected'
                : 'Match Paused'}
            </h2>
            <p className={styles.pausedDesc}>
              {pausedInfo?.reason === 'player_disconnected'
                ? `${pausedInfo?.player_name || 'A player'} lost connection. The match is paused while waiting for reconnection.`
                : 'The match is paused. Timers and delivery countdowns are frozen.'}
            </p>
            {pausedInfo?.grace_seconds && (
              <div className={styles.graceTimerBox}>
                <span>⏱️ Reconnection window active: {pausedInfo.grace_seconds}s</span>
              </div>
            )}
            <div className={styles.pausedBtnRow}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => roomId && syncRoom(roomId)}
              >
                🔄 Refresh Connection
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => roomId && resumeMatch(roomId)}
              >
                ▶️ Resume Match
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 60fps Celebration Particle Effects on 4, 6, Wicket, and Match Win */}
      <CelebrationEffects
        trigger={celebrationTrigger}
        onComplete={() => setCelebrationTrigger(null)}
      />
    </div>
  )
}

// -----------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------

function ScoreCard({
  label, team, runs, wickets, isBatting, target
}: {
  label: string
  team: 'A' | 'B'
  runs: number
  wickets: number
  isBatting: boolean
  target: number | null | undefined
}) {
  const [pop, setPop] = useState(false)
  const prevRuns = useRef(runs)

  useEffect(() => {
    if (runs !== prevRuns.current) {
      prevRuns.current = runs
      setPop(true)
      const timer = setTimeout(() => setPop(false), 500)
      return () => clearTimeout(timer)
    }
  }, [runs])

  return (
    <div className={`${styles.scoreCard} ${isBatting ? styles.scoreCardBatting : ''}`} data-team={team}>
      <div className={styles.scoreLabel}>{label}</div>
      <div className={`${styles.scoreRuns} ${pop ? 'scorePopAnim' : ''}`}>{runs}</div>
      <div className={styles.scoreWickets}>-{wickets}</div>
      {isBatting && <div className={styles.battingIndicator}>▶ BATTING</div>}
      {target && <div className={styles.targetLabel}>Target: {target}</div>}
    </div>
  )
}

function ActivePlayer({
  label, playerId, members, isMe, submitted, pickRevealed
}: {
  label: string
  playerId: string | null
  members: MemberInfo[]
  isMe: boolean
  submitted?: boolean
  pickRevealed?: number | null
}) {
  const member = members.find(m => m.player.id === playerId)
  return (
    <div className={`${styles.activePlayer} ${isMe ? styles.activePlayerMe : ''}`}>
      <div className={styles.activePlayerLabel}>{label}</div>
      <div className={styles.activePlayerName}>
        {member?.player.display_name ?? '—'}
      </div>
      {isMe && <div className={styles.activePlayerYou}>YOU</div>}
      {submitted && <div className={styles.activePlayerSubmitted}>✅ Submitted</div>}
      {!submitted && playerId && <div className={styles.activePlayerWaiting}>⏳ Choosing…</div>}

      {/* Pick reveal below player card with realistic finger gesture */}
      {pickRevealed !== undefined && pickRevealed !== null && (
        <div className={styles.pickRevealContainer}>
          <span className={styles.pickLabelTag}>CHOSE</span>
          <div className={styles.pickBadge}>
            <HandGesture number={pickRevealed} size={32} animated />
            <span className={styles.pickBadgeNum}>{pickRevealed}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function RosterList({
  members, match, myPlayerId
}: {
  members: MemberInfo[]
  match: MatchInfo
  myPlayerId: string
}) {
  const teamA = members.filter(m => m.team === 'A')
  const teamB = members.filter(m => m.team === 'B')

  return (
    <div className={styles.roster}>
      {[
        { label: match.team_a_name || 'Team A', players: teamA, team: 'A' },
        { label: match.team_b_name || 'Team B', players: teamB, team: 'B' }
      ].map(t => (
        <div key={t.team} className={styles.rosterTeam}>
          <h4 className={styles.rosterTeamLabel} data-team={t.team}>{t.label}</h4>
          {t.players.map(m => (
            <div
              key={m.player.id}
              className={`${styles.rosterPlayer} ${m.player.id === myPlayerId ? styles.rosterPlayerMe : ''}`}
            >
              <span className={styles.rosterName}>{m.player.display_name}</span>
              <div className={styles.rosterMeta}>
                {m.player.id === match.active_batter_id && <span className="badge badge-a">Bat</span>}
                {m.player.id === match.active_bowler_id && <span className="badge badge-b">Bowl</span>}
                {m.is_captain && <span className="badge badge-warning">C</span>}
                <span
                  className={styles.connDot}
                  data-state={m.player.connection_state}
                  title={m.player.connection_state}
                />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
