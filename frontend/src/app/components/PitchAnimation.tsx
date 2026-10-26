import React, { useEffect, useRef } from 'react'
import type { DeliveryReveal } from '../../services/types'
import styles from './PitchAnimation.module.css'

interface PitchAnimationProps {
  reveal: DeliveryReveal | null
  countdown: number | null
  hasBowler: boolean
  isBatterSubmitted: boolean
  isBowlerSubmitted: boolean
}

/**
 * High-energy 3D interactive Pitch Animation:
 * - Dynamic 22-yard turf with authentic crease lines & wooden stumps.
 * - Live animated leather cricket ball with spinning seam.
 * - Wicket collision: stumps shatter and bails fly into the air with spark particles!
 * - Sixer: towering golden parabolic ball flight with trailing stardust!
 * - Four: high-speed supersonic boundary tracer across turf!
 * - Runs: quick gap shot roll with sprint pulses!
 */
export const PitchAnimation: React.FC<PitchAnimationProps> = ({
  reveal,
  countdown,
  hasBowler,
  isBatterSubmitted,
  isBowlerSubmitted,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animIdRef = useRef<number | null>(null)

  // Particle bursts on boundary or wicket
  useEffect(() => {
    if (!reveal) return

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = canvas.parentElement?.clientWidth || 360
    canvas.height = canvas.parentElement?.clientHeight || 120

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
    const originX = isWicket ? canvas.width * 0.25 : canvas.width * 0.5
    const originY = canvas.height * 0.6

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

    const render = () => {
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

      if (active) {
        animIdRef.current = requestAnimationFrame(render)
      }
    }

    render()

    return () => {
      if (animIdRef.current) cancelAnimationFrame(animIdRef.current)
    }
  }, [reveal])

  const isWicket = reveal?.result === 'OUT'
  const isSix = reveal?.runs_scored === 6
  const isFour = reveal?.runs_scored === 4
  const isRegularRuns = reveal && !isWicket && !isSix && !isFour && (reveal.runs_scored ?? 0) > 0

  return (
    <div className={styles.pitchContainer}>
      {/* 22-Yard Pitch Strip */}
      <div className={styles.pitchStrip}>
        {/* Crease lines */}
        <div className={`${styles.creaseLine} ${styles.battingCrease}`} />
        <div className={`${styles.creaseLine} ${styles.bowlingCrease}`} />

        {/* Batsman Stumps (Left) */}
        <div className={`${styles.stumpsGroup} ${styles.batterStumps} ${isWicket ? styles.stumpsShattered : ''}`}>
          <div className={`${styles.bail} ${styles.bailLeft}`} />
          <div className={`${styles.bail} ${styles.bailRight}`} />
          <div className={`${styles.stump} ${styles.stump1}`} />
          <div className={`${styles.stump} ${styles.stump2}`} />
          <div className={`${styles.stump} ${styles.stump3}`} />
        </div>

        {/* Bowler Stumps (Right) */}
        <div className={`${styles.stumpsGroup} ${styles.bowlerStumps}`}>
          <div className={styles.bail} />
          <div className={`${styles.stump} ${styles.stump1}`} />
          <div className={`${styles.stump} ${styles.stump2}`} />
          <div className={`${styles.stump} ${styles.stump3}`} />
        </div>

        {/* Dynamic Cricket Ball Animations */}
        {reveal && (
          <div
            className={`${styles.ball} ${
              isWicket
                ? styles.ballWicketHit
                : isSix
                ? styles.ballSixArc
                : isFour
                ? styles.ballFourDrive
                : styles.ballRunRoll
            }`}
          >
            <div className={styles.ballSeam} />
            <div className={styles.ballShine} />
          </div>
        )}

        {/* Particle Canvas overlay */}
        <canvas ref={canvasRef} className={styles.particleCanvas} />
      </div>

      {/* Countdown and Delivery State Center */}
      <div className={styles.centerMeta}>
        {countdown !== null && (
          <div className={styles.countdownBadge} data-urgent={countdown <= 5}>
            <span className={styles.countdownNumber}>{countdown}</span>
            <span className={styles.countdownSec}>SEC</span>
          </div>
        )}

        {countdown === null && !hasBowler && (
          <div className={styles.statusPill}>Select Bowler</div>
        )}

        {/* Readiness pulse lights */}
        <div className={styles.readyTrack}>
          <div
            className={`${styles.readyDot} ${isBatterSubmitted ? styles.dotReady : ''}`}
            title={isBatterSubmitted ? 'Batter pick locked' : 'Waiting for batter'}
          >
            <span>🏏</span>
          </div>
          <span className={styles.readyDivider}>⚡</span>
          <div
            className={`${styles.readyDot} ${isBowlerSubmitted ? styles.dotReady : ''}`}
            title={isBowlerSubmitted ? 'Bowler pick locked' : 'Waiting for bowler'}
          >
            <span>🎯</span>
          </div>
        </div>
      </div>
    </div>
  )
}
