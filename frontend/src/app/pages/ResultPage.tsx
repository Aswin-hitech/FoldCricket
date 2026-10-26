/**
 * Result Page – match summary and winner display.
 */

import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useSocket } from '../../hooks/useSocket'
import { ThemeToggle } from '../../context/ThemeContext'
import { Footer } from '../components/Footer'
import { CelebrationEffects } from '../components/CelebrationEffects'
import { sound } from '../../services/sound'
import styles from './ResultPage.module.css'

export default function ResultPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const sessionToken = localStorage.getItem('hcl_session') || undefined
  const { snapshot, syncRoom } = useSocket(sessionToken)

  useEffect(() => {
    if (roomId) {
      syncRoom(roomId)
    }
    sound.playWin()
  }, [roomId, syncRoom])

  const match = snapshot?.match
  const members = snapshot?.members ?? []

  const teamATotal = match?.team_a_runs ?? 0
  const teamBTotal = match?.team_b_runs ?? 0
  const winner = match?.winner

  const teamA = members.filter(m => m.team === 'A')
  const teamB = members.filter(m => m.team === 'B')

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
        <div className={styles.trophy}>🏆</div>
        <h1 className={styles.title}>
          {winner === 'TIE' ? "It's a Tie!" : winner === 'A' ? `${match?.team_a_name || 'Team A'} Wins!` : winner === 'B' ? `${match?.team_b_name || 'Team B'} Wins!` : 'Match Complete'}
        </h1>
        <p className={styles.summary}>{match?.result_summary ?? ''}</p>

        {/* Scorecard */}
        <div className={styles.scorecard}>
          <TeamScore
            label={match?.team_a_name || 'Team A'}
            team="A"
            runs={teamATotal}
            wickets={match?.team_a_wickets ?? 0}
            isWinner={winner === 'A'}
            players={teamA.map(m => m.player.display_name)}
          />
          <div className={styles.vs}>VS</div>
          <TeamScore
            label={match?.team_b_name || 'Team B'}
            team="B"
            runs={teamBTotal}
            wickets={match?.team_b_wickets ?? 0}
            isWinner={winner === 'B'}
            players={teamB.map(m => m.player.display_name)}
          />
        </div>

        <div className={styles.actions}>
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            🏠 Play Again
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => navigate(`/room/${roomId}`)}
          >
            🔄 Back to Lobby
          </button>
        </div>
      </div>

      <Footer />

      {/* Confetti celebration shower for match victory */}
      <CelebrationEffects trigger="WIN" />
    </div>
  )
}

function TeamScore({
  label, team, runs, wickets, isWinner, players
}: {
  label: string
  team: 'A' | 'B'
  runs: number
  wickets: number
  isWinner: boolean
  players: string[]
}) {
  return (
    <div className={`${styles.teamScore} ${isWinner ? styles.winnerCard : ''}`} data-team={team}>
      {isWinner && <div className={styles.winnerBadge}>🏆 WINNER</div>}
      <h2 className={styles.teamLabel}>{label}</h2>
      <div className={styles.runs}>{runs}</div>
      <div className={styles.wickets}>/{wickets} wkts</div>
      <div className={styles.players}>
        {players.map(p => <span key={p} className={styles.player}>{p}</span>)}
      </div>
    </div>
  )
}
