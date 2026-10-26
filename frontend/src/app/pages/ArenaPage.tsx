/**
 * Arena Page – TV Broadcast-style match screen.
 */

import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useSocket } from '../../hooks/useSocket'
import { ThemeToggle } from '../../context/ThemeContext'
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
    selectBowler,
    submitPick,
    sendChat,
  } = useSocket(sessionToken)

  const [chatInput, setChatInput] = useState('')
  const [selectedPick, setSelectedPick] = useState<number | null>(null)
  const [pickSubmitted, setPickSubmitted] = useState(false)
  const [revealAnimation, setRevealAnimation] = useState<DeliveryReveal | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
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

  // Handle match finished
  useEffect(() => {
    if (matchFinished) {
      setTimeout(() => navigate(`/room/${roomId}/result`), 3000)
    }
  }, [matchFinished, navigate, roomId])

  // Handle reveal animation
  useEffect(() => {
    if (lastReveal) {
      setRevealAnimation(lastReveal)
      setPickSubmitted(false)
      setSelectedPick(null)
      setTimeout(() => setRevealAnimation(null), 3000)
    }
  }, [lastReveal])

  // Countdown timer
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current)
    if (!match?.delivery_deadline) { setCountdown(null); return }

    const tick = () => {
      const deadline = new Date(match.delivery_deadline!).getTime()
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      setCountdown(remaining)
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
    setSelectedPick(pick)
  }

  function handlePickSubmit() {
    if (selectedPick === null || pickSubmitted || !roomId) return
    submitPick(roomId, selectedPick)
    setPickSubmitted(true)
  }

  function handleSendChat(e: React.FormEvent) {
    e.preventDefault()
    const text = chatInput.trim()
    if (!text || !roomId) return
    sendChat(roomId, text)
    setChatInput('')
  }

  function handleBowlerSelect(bowlerId: string) {
    if (!roomId) return
    selectBowler(roomId, bowlerId)
  }

  if (status === 'connecting' || !match) {
    return (
      <div className={styles.centered}>
        <div className={styles.loader} />
        <p>Loading arena…</p>
      </div>
    )
  }

  const bowlingTeam = match.batting_team === 'A' ? 'B' : 'A'
  const bowlingMembers = members.filter(m => m.team === bowlingTeam)
  const needsBowlerSelect = !match.active_bowler_id && (isCaptain || isHost) && myMembership?.team === bowlingTeam
  const currentDelivery = snapshot?.current_delivery

  return (
    <div className={styles.arena}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerBrand}>🏏 HandCricket LIVE</div>
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
          {status === 'disconnected' && (
            <span className={styles.connBadge} data-disconnected>⚠ Reconnecting…</span>
          )}
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
              label="Team A"
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
              label="Team B"
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
            />
            <div className={styles.stageCenter}>
              {/* Countdown */}
              {countdown !== null && (
                <div
                  className={styles.countdown}
                  data-urgent={countdown <= 5}
                >
                  {countdown}
                </div>
              )}
              {countdown === null && !match.active_bowler_id && (
                <div className={styles.waitingBowler}>Waiting for bowler selection…</div>
              )}
            </div>
            <ActivePlayer
              label="🎯 Bowler"
              playerId={match.active_bowler_id}
              members={members}
              isMe={isActiveBowler}
              submitted={currentDelivery?.bowler_submitted}
            />
          </div>

          {/* Reveal animation */}
          {revealAnimation && (
            <div className={`${styles.revealBanner} ${revealAnimation.result === 'OUT' ? styles.revealOut : styles.revealRuns}`}>
              <div className={styles.revealPicks}>
                <span>{revealAnimation.batter_pick}</span>
                <span className={styles.revealVs}>vs</span>
                <span>{revealAnimation.bowler_pick}</span>
              </div>
              <div className={styles.revealResult}>
                {revealAnimation.result === 'OUT' ? '❌ OUT!' : `✅ +${revealAnimation.runs_scored} RUNS`}
              </div>
            </div>
          )}

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

          {/* Number pad */}
          {isActivePlayer && match.active_bowler_id && (
            <div className={styles.numberPad}>
              <p className={styles.padLabel}>
                {isActiveBatter ? 'Pick your batting number' : 'Pick your bowling number'}
              </p>
              <div className={styles.pad}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                  <button
                    key={n}
                    className={`${styles.padBtn} ${selectedPick === n ? styles.padBtnSelected : ''} ${pickSubmitted ? styles.padBtnDisabled : ''}`}
                    onClick={() => handlePickSelect(n)}
                    disabled={pickSubmitted}
                    aria-label={`Pick ${n}`}
                    aria-pressed={selectedPick === n}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <button
                className={`btn btn-primary ${styles.submitBtn}`}
                onClick={handlePickSubmit}
                disabled={selectedPick === null || pickSubmitted}
              >
                {pickSubmitted ? '✅ Submitted' : '🎯 Submit Pick'}
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
  return (
    <div className={`${styles.scoreCard} ${isBatting ? styles.scoreCardBatting : ''}`} data-team={team}>
      <div className={styles.scoreLabel}>{label}</div>
      <div className={styles.scoreRuns}>{runs}</div>
      <div className={styles.scoreWickets}>-{wickets}</div>
      {isBatting && <div className={styles.battingIndicator}>▶ BATTING</div>}
      {target && <div className={styles.targetLabel}>Target: {target}</div>}
    </div>
  )
}

function ActivePlayer({
  label, playerId, members, isMe, submitted
}: {
  label: string
  playerId: string | null
  members: MemberInfo[]
  isMe: boolean
  submitted?: boolean
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
      {[{ label: 'Team A', players: teamA, team: 'A' }, { label: 'Team B', players: teamB, team: 'B' }].map(t => (
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
