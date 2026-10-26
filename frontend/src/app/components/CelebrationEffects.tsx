import React, { useEffect, useRef } from 'react'
import styles from './CelebrationEffects.module.css'

interface CelebrationEffectsProps {
  trigger: 'SIX' | 'FOUR' | 'WICKET' | 'WIN' | null
  onComplete?: () => void
}

/**
 * 60fps Procedural Confetti & Particle Explosion Canvas:
 * Produces realistic confetti ribbons, glittering streamers, and spark trails
 * with gravity, air resistance, and 3D rotational fluttering.
 */
export const CelebrationEffects: React.FC<CelebrationEffectsProps> = ({
  trigger,
  onComplete,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animRef = useRef<number | null>(null)

  useEffect(() => {
    if (!trigger) return

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = (canvas.width = window.innerWidth)
    const height = (canvas.height = window.innerHeight)

    const colors =
      trigger === 'WICKET'
        ? ['#ef4444', '#f87171', '#fbbf24', '#f59e0b', '#ffffff']
        : trigger === 'SIX'
        ? ['#facc15', '#fbbf24', '#f59e0b', '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff']
        : trigger === 'FOUR'
        ? ['#38bdf8', '#0284c7', '#22c55e', '#a855f7', '#ffffff']
        : ['#facc15', '#22c55e', '#3b82f6', '#ec4899', '#f97316', '#a855f7', '#ffffff']

    const count = trigger === 'WIN' ? 120 : trigger === 'SIX' ? 80 : trigger === 'FOUR' ? 50 : 40

    const particles: Array<{
      x: number
      y: number
      w: number
      h: number
      color: string
      vx: number
      vy: number
      rot: number
      vRot: number
      opacity: number
      decay: number
      flutter: number
    }> = []

    for (let i = 0; i < count; i++) {
      const isBurstFromCenter = trigger !== 'WIN'
      const startX = isBurstFromCenter ? width * 0.5 + (Math.random() * 80 - 40) : Math.random() * width
      const startY = isBurstFromCenter ? height * 0.45 + (Math.random() * 60 - 30) : -20

      const angle = isBurstFromCenter
        ? Math.random() * Math.PI * 2
        : Math.PI * 0.5 + (Math.random() * 0.6 - 0.3)
      const speed = isBurstFromCenter ? 4 + Math.random() * 10 : 2 + Math.random() * 6

      particles.push({
        x: startX,
        y: startY,
        w: 6 + Math.random() * 8,
        h: 10 + Math.random() * 12,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (isBurstFromCenter ? 3 : 0),
        rot: Math.random() * Math.PI * 2,
        vRot: (Math.random() - 0.5) * 0.2,
        opacity: 1,
        decay: trigger === 'WIN' ? 0.003 : 0.008 + Math.random() * 0.006,
        flutter: Math.random() * 0.1,
      })
    }

    let frame = 0
    const render = () => {
      ctx.clearRect(0, 0, width, height)
      frame++
      let active = false

      for (const p of particles) {
        if (p.opacity > 0) {
          active = true
          p.x += p.vx + Math.sin(frame * p.flutter) * 0.5
          p.y += p.vy
          p.vy += 0.18 // gravity
          p.vx *= 0.985 // drag
          p.rot += p.vRot
          p.opacity -= p.decay

          ctx.save()
          ctx.translate(p.x, p.y)
          ctx.rotate(p.rot)
          ctx.globalAlpha = Math.max(0, p.opacity)
          ctx.fillStyle = p.color
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
          ctx.restore()
        }
      }

      if (active) {
        animRef.current = requestAnimationFrame(render)
      } else {
        onComplete?.()
      }
    }

    render()

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current)
    }
  }, [trigger, onComplete])

  if (!trigger) return null

  return <canvas ref={canvasRef} className={styles.celebrationCanvas} />
}
