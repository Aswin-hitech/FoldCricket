import React, { useEffect, useState } from 'react'
import type { TossInfo } from '../../services/types'
import { sound } from '../../services/sound'
import styles from './CoinTossModal.module.css'

interface CoinTossModalProps {
  toss: TossInfo | null | undefined
  myPlayerId: string
  onCall: (choice: 'HEADS' | 'TAILS') => void
  onDecide: (decision: 'BAT' | 'BOWL') => void
}

export const CoinTossModal: React.FC<CoinTossModalProps> = ({
  toss,
  myPlayerId,
  onCall,
  onDecide,
}) => {
  const [isFlipping, setIsFlipping] = useState(false)
  const [displayResult, setDisplayResult] = useState<'HEADS' | 'TAILS' | null>(null)

  const isCaller = toss?.caller_id === myPlayerId
  const isWinner = toss?.winner_id === myPlayerId

  useEffect(() => {
    if (toss?.coin_result && !displayResult) {
      setIsFlipping(true)
      sound.playCoinToss()

      const timer = setTimeout(() => {
        setIsFlipping(false)
        setDisplayResult(toss.coin_result)
        sound.playCoinLand()
      }, 2200)

      return () => clearTimeout(timer)
    }
  }, [toss?.coin_result, displayResult])

  if (!toss) return null

  return (
    <div className={styles.overlay} role="dialog" aria-modal aria-label="Coin Toss">
      <div className={styles.card}>
        <h2 className={styles.title}>🪙 The Match Toss</h2>

        {/* 3D Coin Graphic */}
        <div className={styles.coinStage}>
          <div
            className={`${styles.coin} ${isFlipping ? styles.flipping : ''} ${
              displayResult === 'TAILS' ? styles.showTails : ''
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
        {!toss.coin_result && (
          <div className={styles.section}>
            {isCaller ? (
              <>
                <p className={styles.prompt}>You are calling the toss. Choose Heads or Tails:</p>
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
                <p>Waiting for <strong>{toss.caller_name || 'Captain'}</strong> to call the toss…</p>
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

        {/* Toss Phase 2: Deciding Bat or Bowl */}
        {!isFlipping && displayResult && (
          <div className={styles.resultSection}>
            <div className={styles.resultBanner}>
              It's <strong>{displayResult}</strong>!
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
      </div>
    </div>
  )
}
