/**
 * Result Page – match summary, personalized win/loss/draw outcome, thank you card,
 * and automatic/manual return to landing page.
 */

import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useSocket } from '../../hooks/useSocket'
import { ThemeToggle } from '../../context/ThemeContext'
import { Footer } from '../components/Footer'
import { CelebrationEffects } from '../components/CelebrationEffects'
import { FirstGameFeedbackModal } from '../components/FirstGameFeedbackModal'
import { sound } from '../../services/sound'
import { vibration } from '../../services/vibration'
import styles from './ResultPage.module.css'

export default function ResultPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const sessionToken = localStorage.getItem('hcl_session') || undefined
  const myPlayerId = localStorage.getItem('hcl_player_id') || ''
  const { snapshot, syncRoom } = useSocket(sessionToken)

  const [countdown, setCountdown] = useState(25)
  const [showFeedbackModal, setShowFeedbackModal] = useState(false)

  // First game check: prompt feedback modal for new players
  useEffect(() => {
    const feedbackDone = localStorage.getItem('hcl_feedback_submitted') === 'true'
    if (!feedbackDone) {
      const timer = setTimeout(() => {
        setShowFeedbackModal(true)
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (roomId) {
      syncRoom(roomId)
    }
  }, [roomId, syncRoom])

  const match = snapshot?.match
  const members = snapshot?.members ?? []
  const myMembership = members.find(m => m.player.id === myPlayerId)
  const myTeam = myMembership?.team

  const teamATotal = match?.team_a_runs ?? 0
  const teamBTotal = match?.team_b_runs ?? 0
  const winner = match?.winner

  const isTie = winner === 'TIE'
  const isWin = !!myTeam && winner === myTeam
  const isLoss = !!myTeam && (winner === 'A' || winner === 'B') && winner !== myTeam
  const isAbrupted =
    match?.result_summary?.toLowerCase().includes('forfeit') ||
    match?.result_summary?.toLowerCase().includes('disconnect')

  const teamA = members.filter(m => m.team === 'A')
  const teamB = members.filter(m => m.team === 'B')

  // Sound and vibration effect based on player outcome
  useEffect(() => {
    if (isWin || isTie) {
      sound.playWin()
      vibration.win()
    }
  }, [isWin, isTie])

  // Automatic return countdown to landing page (paused while feedback modal is open)
  useEffect(() => {
    if (showFeedbackModal) return

    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer)
          navigate('/')
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [navigate, showFeedbackModal])

  const outcomeType = isWin ? 'WIN' : isLoss ? 'LOSS' : isTie ? 'TIE' : 'SPECTATOR'

  return (
    <div className={styles.page}>
      <div className={styles.topBar}>
        <div className={styles.brandLockup} onClick={() => navigate('/')} style={{ cursor: 'pointer' }}>
          <img src="/logo.jpg" alt="FoldCricket" className={styles.brandLogo} />
          <span>FoldCricket</span>
        </div>
        <ThemeToggle />
      </div>

      <div className={styles.content}>
        {/* Outcome Trophy / Emoji */}
        <div className={styles.trophy}>
          {isWin ? '🏆' : isLoss ? '🏏' : isTie ? '🤝' : '🏆'}
        </div>

        {/* 1. Mention the Match Score First */}
        <div className={styles.scoreSummaryBox}>
          <div className={styles.scoreSummaryItem}>
            <span className={styles.scoreSummaryTeam}>{match?.team_a_name || 'Team A'}</span>
            <span className={styles.scoreSummaryRuns}>{teamATotal}/{match?.team_a_wickets ?? 0}</span>
          </div>
          <span className={styles.scoreSummaryVs}>VS</span>
          <div className={styles.scoreSummaryItem}>
            <span className={styles.scoreSummaryTeam}>{match?.team_b_name || 'Team B'}</span>
            <span className={styles.scoreSummaryRuns}>{teamBTotal}/{match?.team_b_wickets ?? 0}</span>
          </div>
        </div>

        {/* 2. Then Display the Match Result */}
        <h1
          className={`${styles.title} ${
            isWin ? styles.titleWin : isLoss ? styles.titleLoss : styles.titleTie
          }`}
        >
          {match?.result_summary
            ? match.result_summary
            : isWin
            ? 'You Won the Match!'
            : isLoss
            ? 'Hard Luck — You Lost'
            : isTie
            ? 'What a Match! It’s a Draw!'
            : 'Match Concluded'}
        </h1>

        {/* Outcome Badge */}
        <div className={styles.outcomeBadge} data-type={outcomeType}>
          {isWin
            ? '🎉 VICTORY'
            : isLoss
            ? '💔 MATCH OVER'
            : isTie
            ? '🤝 TIED MATCH'
            : 'MATCH COMPLETE'}
        </div>

        <p className={styles.summary}>{match?.result_summary ?? ''}</p>

        {/* Abrupted / Forfeit notification banner if game ended prematurely */}
        {isAbrupted && (
          <div className={styles.abruptedNotice}>
            <span>⚠️</span>
            <span>Match concluded early due to player disconnection or forfeit.</span>
          </div>
        )}

        {/* Scorecard */}
        <div className={styles.scorecard}>
          <TeamScore
            label={match?.team_a_name || 'Team A'}
            team="A"
            runs={teamATotal}
            wickets={match?.team_a_wickets ?? 0}
            isWinner={winner === 'A'}
            players={teamA.map(m => m.player.display_name)}
            isMyTeam={myTeam === 'A'}
          />
          <div className={styles.vs}>VS</div>
          <TeamScore
            label={match?.team_b_name || 'Team B'}
            team="B"
            runs={teamBTotal}
            wickets={match?.team_b_wickets ?? 0}
            isWinner={winner === 'B'}
            players={teamB.map(m => m.player.display_name)}
            isMyTeam={myTeam === 'B'}
          />
        </div>

        {/* Thank You Section */}
        <div className={styles.thankYouCard}>
          <div className={styles.thankYouEmoji}>🏏✨</div>
          <h2 className={styles.thankYouTitle}>Thank You for Playing FoldCricket!</h2>
          <p className={styles.thankYouText}>
            Thank you for picking your vintage school memories with us today. Whether it was a thrilling boundary or a nail-biting wicket, we hope you enjoyed every delivery!
          </p>
        </div>

        {/* Auto Return Countdown Notice */}
        <div className={styles.autoReturnBanner}>
          <span>⏱️ Automatically returning to landing page in <strong>{countdown}s</strong></span>
        </div>

        {/* Actions */}
        <div className={styles.actions}>
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            🏠 Return to Landing Page Now ({countdown}s)
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => navigate(`/room/${roomId}`)}
          >
            🔄 Rematch in Lobby
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              sound.playClick()
              setShowFeedbackModal(true)
            }}
          >
            📝 First Game Feedback Report
          </button>
        </div>
      </div>

      {/* First Game Feedback Report Modal for Supabase collection */}
      <FirstGameFeedbackModal
        isOpen={showFeedbackModal}
        onClose={() => setShowFeedbackModal(false)}
        myPlayerId={myPlayerId}
        myDisplayName={myMembership?.player.display_name || 'Player'}
        roomCode={snapshot?.room?.join_code}
        matchSummary={match?.result_summary}
      />

      <Footer />

      {/* Confetti celebration shower for victory / tie */}
      {(isWin || isTie || !myTeam) && <CelebrationEffects trigger="WIN" />}
    </div>
  )
}

function TeamScore({
  label,
  team,
  runs,
  wickets,
  isWinner,
  players,
  isMyTeam,
}: {
  label: string
  team: 'A' | 'B'
  runs: number
  wickets: number
  isWinner: boolean
  players: string[]
  isMyTeam?: boolean
}) {
  return (
    <div
      className={`${styles.teamScore} ${isWinner ? styles.winnerCard : ''}`}
      data-team={team}
    >
      {isWinner && <div className={styles.winnerBadge}>🏆 WINNER</div>}
      <h2 className={styles.teamLabel}>
        {label} {isMyTeam && <small style={{ color: 'var(--color-team-a)' }}>(Your Team)</small>}
      </h2>
      <div className={styles.runs}>{runs}</div>
      <div className={styles.wickets}>/{wickets} wkts</div>
      <div className={styles.players}>
        {players.map(p => (
          <span key={p} className={styles.player}>
            {p}
          </span>
        ))}
      </div>
    </div>
  )
}
