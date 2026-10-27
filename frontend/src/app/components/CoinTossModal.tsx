import React, { useEffect, useState } from 'react'
import type { TossInfo } from '../../services/types'
import { sound } from '../../services/sound'
import styles from './CoinTossModal.module.css'

interface CoinTossModalProps {
  toss: TossInfo | null | undefined
  myPlayerId: string
  countdownSeconds?: number | null
  onCall: (choice: 'HEADS' | 'TAILS') => void
  onDecide: (decision: 'BAT' | 'BOWL') => void
}

export const CoinTossModal: React.FC<CoinTossModalProps> = ({
  toss,
  myPlayerId,
  countdownSeconds,
  onCall,
  onDecide,
}) => {
  const [isFlipping, setIsFlipping] = useState(false)
  const [displayResult, setDisplayResult] = useState<'HEADS' | 'TAILS' | null>(null)

  const isCaller = toss?.caller_id === myPlayerId
  const isWinner = toss?.winner_id === myPlayerId

  useEffect(() => {
    if (toss?.coin_result && !displayResult && !toss.elected_choice) {
      setIsFlipping(true)
      sound.playCoinToss()

      // Smooth coin flip (2200ms)
      const timer = setTimeout(() => {
        setIsFlipping(false)
        setDisplayResult(toss.coin_result)
        sound.playCoinLand()
      }, 2200)

      return () => clearTimeout(timer)
    } else if (toss?.coin_result && !displayResult && toss.elected_choice) {
      // Direct result if already decided
      setDisplayResult(toss.coin_result)
    }
  }, [toss?.coin_result, toss?.elected_choice, displayResult])

  // Don't render if no toss data
  if (!toss) return null

  // If 10s countdown reached 0, unmount
  if (countdownSeconds !== null && countdownSeconds !== undefined && countdownSeconds <= 0) {
    return null
  }

  const secondsRemaining = countdownSeconds ?? 10
  const progressPercent = Math.max(0, Math.min(100, ((10 - secondsRemaining) / 10) * 100))

  return (
    <div className={styles.overlay} role="dialog" aria-modal aria-label="Coin Toss">
      <div className={styles.card}>
        <h2 className={styles.title}>🪙 The Match Toss</h2>

        {/* 3D Coin Graphic */}
        <div className={styles.coinStage}>
          <div
            className={`${styles.coin} ${isFlipping ? styles.flipping : ''} ${
              (displayResult || toss.coin_result) === 'TAILS' ? styles.showTails : ''
            }`}
          >
            <div className={`${styles.coinFace} ${styles.coinHeads}`}>
              <span>👑</span>
              <small>HEADS</small>
            </div>
            <div className={`${styles.coinFace} ${styles.coinTails}`}>
              <span>🏏</span>
              <small>TAILS</small>
            </div>
          </div>
        </div>

        {/* Toss Phase 1: Calling Heads or Tails */}
        {!toss.coin_result && !toss.elected_choice && (
          <div className={styles.section}>
            {isCaller ? (
              <>
                <p className={styles.prompt}>
                  🪙 As the opponent, you call the toss! Choose <strong>Heads</strong> or <strong>Tails</strong>:
                </p>
                <div className={styles.btnRow}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ flex: 1, padding: '14px', fontSize: '1.05rem' }}
                    onClick={() => {
                      sound.playClick()
                      onCall('HEADS')
                    }}
                  >
                    👑 HEADS
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ flex: 1, padding: '14px', fontSize: '1.05rem' }}
                    onClick={() => {
                      sound.playClick()
                      onCall('TAILS')
                    }}
                  >
                    🏏 TAILS
                  </button>
                </div>
              </>
            ) : (
              <div className={styles.waiting}>
                <span className={styles.spinner} />
                <p>Waiting for opponent <strong>{toss.caller_name || 'Captain'}</strong> to call the toss…</p>
              </div>
            )}
          </div>
        )}

        {/* Coin in mid-air */}
        {isFlipping && (
          <div className={styles.flippingText}>
            Coin is in the air…
          </div>
        )}

        {/* Toss Phase 2: Choosing Bat/Bowl (before election) */}
        {!isFlipping && !toss.elected_choice && (displayResult || toss.coin_result) && (
          <div className={styles.resultSection}>
            <div className={styles.resultBanner}>
              It's <strong>{displayResult || toss.coin_result}</strong>!
            </div>
            <p className={styles.winnerText}>
              🎉 <strong>{toss.winner_name || `Team ${toss.winner_team}`}</strong> won the toss!
            </p>

            {isWinner ? (
              <div className={styles.decisionBox}>
                <p className={styles.prompt}>What do you elect to do first?</p>
                <div className={styles.btnRow}>
                  <button
                    type="button"
                    className="btn btn-success"
                    style={{ flex: 1, padding: '14px', fontSize: '1.05rem' }}
                    onClick={() => {
                      sound.playClick()
                      onDecide('BAT')
                    }}
                  >
                    🏏 BAT FIRST
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ flex: 1, padding: '14px', fontSize: '1.05rem' }}
                    onClick={() => {
                      sound.playClick()
                      onDecide('BOWL')
                    }}
                  >
                    🎯 BOWL FIRST
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.waiting}>
                <span className={styles.spinner} />
                <p>Waiting for {toss.winner_name || 'opponent'} to choose Bat or Bowl…</p>
              </div>
            )}
          </div>
        )}

        {/* Toss Phase 3: Post-Decision 10-Second Display Screen */}
        {toss.elected_choice && (
          <div className={styles.announcementSection}>
            <span className={styles.announcementBadge}>Toss Concluded</span>
            <h3 className={styles.announcementTitle}>
              🎉 {toss.winner_name || `Team ${toss.winner_team}`} won the toss and chose to{' '}
              <span style={{ color: toss.elected_choice === 'BAT' ? 'var(--color-success)' : 'var(--color-team-a)', textDecoration: 'underline' }}>
                {toss.elected_choice === 'BAT' ? 'BAT FIRST' : 'BOWL FIRST'}
              </span>
            </h3>
            <p className={styles.announcementSub}>
              {toss.winner_name || `Team ${toss.winner_team}`} will {toss.elected_choice === 'BAT' ? 'set the target' : 'bowl first'}. Prepare your opening strategy!
            </p>

            <div className={styles.transitionCountdown}>
              <span className={styles.pulseDot} />
              <span>Moving to match arena in <strong>{secondsRemaining}s</strong></span>
            </div>

            <div className={styles.tossProgressBar}>
              <div
                className={styles.tossProgressFill}
                style={{ width: `${progressPercent}%`, animation: 'none', transition: 'width 0.9s linear' }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
