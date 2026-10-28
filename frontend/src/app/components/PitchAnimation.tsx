import React, { useEffect, useRef } from 'react'
import type { DeliveryReveal } from '../../services/types'
import styles from './PitchAnimation.module.css'

interface BallOutcome {
  ball: number
  runs: number
  isOut: boolean
}

interface PitchAnimationProps {
  reveal: DeliveryReveal | null
  countdown: number | null
  hasBowler: boolean
  isBatterSubmitted: boolean
  isBowlerSubmitted: boolean
  currentOver: number
  currentBall: number
  totalOvers: number
  recentBalls?: BallOutcome[]
  activeBatterName?: string
  activeBowlerName?: string
  isOverComplete?: boolean
  bowlingCaptainName?: string
  isCaptainOrHost?: boolean
  onSelectBowlerClick?: () => void
}

/**
 * TV Broadcast-style 3D Perspective Cricket Pitch & Stadium:
 * - Floodlights & night stadium atmosphere
 * - 3D perspective pitch strip with crease markings and wooden stumps
 * - Overhead over navigator & ball outcome circular chips
 * - Player cards for bowler (top) and batter (bottom)
 * - Live delivery countdown timer
 * - Dynamic animated ball trajectories & celebrations (WICKET, SIX, FOUR)
 */
export const PitchAnimation: React.FC<PitchAnimationProps> = ({
  reveal,
  countdown,
  hasBowler,
  isBatterSubmitted,
  isBowlerSubmitted,
  currentOver,
  currentBall,
  totalOvers,
  recentBalls = [],
  activeBatterName = 'Batter',
  activeBowlerName = 'Bowler',
  isOverComplete = false,
  bowlingCaptainName,
  isCaptainOrHost = false,
  onSelectBowlerClick,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animIdRef = useRef<number | null>(null)

  // 60fps Particle celebration effects on canvas
  useEffect(() => {
    if (!reveal) return
    // Dead deliveries (timeout) get no celebration particles
    if (reveal.result === 'TIMEOUT') return

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = canvas.parentElement?.clientWidth || 400
    canvas.height = canvas.parentElement?.clientHeight || 320

    const particles: Array<{
      x: number
      y: number
      vx: number
      vy: number
      color: string
      size: number
      alpha: number
      decay: number
      gravity: number
    }> = []

    const isWicket = reveal.result === 'OUT'
    const isSix = reveal.runs_scored === 6
    const isFour = reveal.runs_scored === 4

    const particleCount = isWicket ? 45 : isSix ? 50 : isFour ? 35 : 15
    const originX = canvas.width * 0.5
    const originY = canvas.height * 0.55

    const colors = isWicket
      ? ['#ef4444', '#dc2626', '#fbbf24', '#f59e0b', '#ffffff']
      : isSix
      ? ['#facc15', '#fbbf24', '#3b82f6', '#ec4899', '#8b5cf6', '#ffffff']
      : isFour
      ? ['#3b82f6', '#60a5fa', '#06b6d4', '#22c55e', '#ffffff']
      : ['#22c55e', '#4ade80', '#ffffff']

    for (let i = 0; i < particleCount; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = isSix ? 2 + Math.random() * 5 : 1.5 + Math.random() * 4
      particles.push({
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (isSix || isWicket ? 2.5 : 1),
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 2 + Math.random() * 4,
        alpha: 1,
        decay: 0.015 + Math.random() * 0.02,
        gravity: 0.12,
      })
    }

    let frame = 0
    const render = () => {
      frame++
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      let active = false

      for (const p of particles) {
        if (p.alpha > 0) {
          active = true
          p.x += p.vx
          p.y += p.vy
          p.vy += p.gravity
          p.alpha -= p.decay

          ctx.save()
          ctx.globalAlpha = Math.max(0, p.alpha)
          ctx.fillStyle = p.color
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }
      }

      if (active && frame < 120) {
        animIdRef.current = requestAnimationFrame(render)
      }
    }

    render()

    return () => {
      if (animIdRef.current) cancelAnimationFrame(animIdRef.current)
    }
  }, [reveal])

  const isWicket = reveal?.result === 'OUT'
  const isTimeout = reveal?.result === 'TIMEOUT'
  const isSix = reveal?.runs_scored === 6
  const isFour = reveal?.runs_scored === 4

  // Construct current over ball slots (6 balls)
  const currentOverDisplay = `${currentOver}.${currentBall}`
  const overBalls: Array<{ label: string; type: 'neutral' | 'four' | 'six' | 'out' | 'empty' }> = []
  for (let i = 0; i < 6; i++) {
    const outcome = recentBalls[i]
    if (outcome) {
      if (outcome.isOut) {
        overBalls.push({ label: 'W', type: 'out' })
      } else if (outcome.runs === 6) {
        overBalls.push({ label: '6', type: 'six' })
      } else if (outcome.runs === 4) {
        overBalls.push({ label: '4', type: 'four' })
      } else if (outcome.runs > 0) {
        overBalls.push({ label: String(outcome.runs), type: 'neutral' })
      } else {
        overBalls.push({ label: '•', type: 'neutral' })
      }
    } else {
      overBalls.push({ label: '', type: 'empty' })
    }
  }

  return (
    <div className={styles.stadiumContainer}>
      {/* Stadium Overhead Lights */}
      <div className={styles.floodlightLeft} />
      <div className={styles.floodlightRight} />

      {/* Overhead Over Tracker & Ball Outcome Chips */}
      <div className={styles.overheadTracker}>
        <div className={styles.overPill}>
          <span className={styles.arrowIcon}>‹</span>
          <span className={styles.overLabel}>Over {currentOverDisplay}</span>
          <span className={styles.arrowIcon}>›</span>
        </div>
        <div className={styles.ballChipsRow}>
          {overBalls.map((b, idx) => (
            <div
              key={idx}
              className={`${styles.ballChip} ${
                b.type === 'four'
                  ? styles.chipFour
                  : b.type === 'six'
                  ? styles.chipSix
                  : b.type === 'out'
                  ? styles.chipOut
                  : b.type === 'neutral'
                  ? styles.chipNeutral
                  : styles.chipEmpty
              }`}
            >
              {b.label}
            </div>
          ))}
        </div>
      </div>

      {/* Top Bowler Card at the Bowling Crease */}
      <div className={styles.bowlerPitchCard}>
        <div className={styles.playerAvatarSmall}>👤</div>
        <div className={styles.playerMetaCol}>
          <span className={styles.playerName}>{activeBowlerName || 'Bowler'}</span>
          <span className={styles.playerSub}>Right Arm</span>
        </div>
      </div>

      {/* 3D Perspective Cricket Pitch */}
      <div className={styles.pitchScene}>
        {/* Far Stumps (Bowler End) */}
        <div className={styles.farStumps}>
          <div className={styles.bailFar} />
          <div className={styles.stumpFar} />
          <div className={styles.stumpFar} />
          <div className={styles.stumpFar} />
        </div>

        {/* 22-Yard Turf in Perspective */}
        <div className={styles.perspectivePitch}>
          <div className={styles.creaseLineFar} />
          <div className={styles.creaseLineNear} />
          <div className={styles.pitchTexture} />
        </div>

        {/* Near Stumps (Striker End) */}
        <div className={`${styles.nearStumps} ${isWicket ? styles.stumpsShattered : ''}`}>
          <div className={styles.bailNear} />
          <div className={`${styles.stumpNear} ${styles.stump1}`} />
          <div className={`${styles.stumpNear} ${styles.stump2}`} />
          <div className={`${styles.stumpNear} ${styles.stump3}`} />
        </div>

        {/* Animated Cricket Ball */}
        {reveal && (
          <div
            className={`${styles.cricketBall} ${
              isWicket
                ? styles.ballWicket
                : isSix
                ? styles.ballSix
                : isFour
                ? styles.ballFour
                : styles.ballRun
            }`}
          >
            <div className={styles.ballSeam} />
          </div>
        )}

        {/* Particle Canvas */}
        <canvas ref={canvasRef} className={styles.particleCanvas} />

        {/* Delivery Result Popup: WICKET or +Runs with 2-second smooth fade in and fade out */}
        {reveal && (
          <div
            className={`${styles.deliveryResultPopup} ${
              isWicket
                ? styles.popupWicket
                : isTimeout
                ? styles.popupRuns
                : isSix
                ? styles.popupSix
                : isFour
                ? styles.popupFour
                : styles.popupRuns
            }`}
          >
            <span className={styles.popupEmoji}>
              {isWicket ? '💥' : isTimeout ? '⏱️' : isSix ? '🚀' : isFour ? '🔥' : '🏏'}
            </span>
            <div className={styles.popupTitle}>
              {isWicket
                ? 'WICKET !!!'
                : isTimeout
                ? 'TIME OUT — 0 RUNS'
                : isSix
                ? '+6 MAXIMUM!'
                : isFour
                ? '+4 BOUNDARY!'
                : `+${reveal.runs_scored} RUNS`}
            </div>
            <div className={styles.popupSub}>
              {isWicket
                ? 'Equal numbers matched — Batter is OUT!'
                : isTimeout
                ? 'No pick in time — dead ball, no wicket'
                : `Batter chose ${reveal.batter_pick} vs Bowler ${reveal.bowler_pick}`}
            </div>
          </div>
        )}

        {/* Center Countdown Timer */}
        {countdown !== null && countdown !== undefined && (
          <div className={styles.centerTimerBadge} data-urgent={countdown <= 5}>
            <span className={styles.timerIcon}>⏱️</span>
            <span className={styles.timerNum}>{countdown}s</span>
          </div>
        )}

        {/* Over Complete Message */}
        {isOverComplete && (
          <div className={styles.overCompleteBanner}>
            <span className={styles.overCompleteEmoji}>🔔</span>
            <div className={styles.overCompleteText}>
              <strong>OVER COMPLETED!</strong>
              <span>
                {isCaptainOrHost
                  ? 'Select the bowler for the next over below'
                  : `Waiting for Captain (${bowlingCaptainName || 'Bowling Captain'}) to choose bowler`}
              </span>
            </div>
            {isCaptainOrHost && onSelectBowlerClick && (
              <button
                type="button"
                className={styles.chooseBowlerBtn}
                onClick={onSelectBowlerClick}
              >
                🎯 Choose Bowler
              </button>
            )}
          </div>
        )}

        {/* Readiness pulse indicators */}
        <div className={styles.readinessBar}>
          <div
            className={`${styles.readyChip} ${isBatterSubmitted ? styles.readyDone : ''}`}
            title={isBatterSubmitted ? 'Batter ready' : 'Batter choosing'}
          >
            🏏 {isBatterSubmitted ? 'Ready' : 'Thinking'}
          </div>
          <div
            className={`${styles.readyChip} ${isBowlerSubmitted ? styles.readyDone : ''}`}
            title={isBowlerSubmitted ? 'Bowler ready' : 'Bowler choosing'}
          >
            🎯 {isBowlerSubmitted ? 'Ready' : 'Thinking'}
          </div>
        </div>
      </div>

      {/* Bottom Batter Card at the Batting Crease */}
      <div className={styles.batterPitchCard}>
        <div className={styles.playerAvatarSmall}>🏏</div>
        <div className={styles.playerMetaCol}>
          <span className={styles.playerName}>{activeBatterName || 'Batter'}</span>
          <span className={styles.playerSub}>Right Hand Bat</span>
        </div>
      </div>
    </div>
  )
}
