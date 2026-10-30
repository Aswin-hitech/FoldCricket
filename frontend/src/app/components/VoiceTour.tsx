/**
 * First-match voice introduction tour.
 * Spotlights the real controls (mic, voice list, per-player listen button) and
 * leaves the page usable underneath, so players can try each step immediately.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './VoiceTour.module.css'

interface VoiceTourProps {
  isTeamMatch: boolean
  onOpenVoiceList: () => void
  onCloseVoiceList: () => void
  onFinish: () => void
}

interface TargetRect {
  top: number
  left: number
  width: number
  height: number
}

const MIC_TARGET = '[data-tour="mic"]'
const LIST_TARGET = '[data-tour="voice-list"]'
const LISTEN_TARGET = '[data-tour="mute-incoming"]'

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export const VoiceTour: React.FC<VoiceTourProps> = ({
  isTeamMatch,
  onOpenVoiceList,
  onCloseVoiceList,
  onFinish,
}) => {
  const steps = useMemo(
    () => [
      {
        eyebrow: 'Step 1 of 4 · Microphone',
        title: 'Connect your microphone',
        body:
          'Tap "Connect Mic" once and allow microphone access. Tap it again whenever you want to mute or unmute yourself — the mic stays connected between matches.',
        target: MIC_TARGET,
        opensVoiceList: false,
      },
      {
        eyebrow: 'Step 2 of 4 · Voice List',
        title: 'Open the Voice List',
        body:
          'The Voice List is your control room: it shows everyone in this match and exactly who can hear you and who you hear.',
        target: LIST_TARGET,
        opensVoiceList: false,
      },
      {
        eyebrow: 'Step 3 of 4 · Hearing others',
        title: 'Hear only the players you want',
        body: isTeamMatch
          ? 'Tap 🔊 next to a player to mute their voice for yourself (tap again to unmute). "🚫 Block your voice" hides you from a player. Talking to an opponent needs a Request Talk they accept, and either side can revoke it.'
          : 'Tap 🔊 next to a player to mute their voice for yourself (tap again to unmute). "🚫 Block your voice" stops that player from hearing you — nobody is forced to listen to anyone.',
        target: LISTEN_TARGET,
        opensVoiceList: true,
      },
      {
        eyebrow: 'Step 4 of 4 · All set',
        title: "You're ready to play",
        body:
          'That is everything: connect the mic, open the Voice List, and mute or block anyone you do not want to hear. The Sound On/Off button next to the mic controls game audio. This tour will not interrupt you again after your first few matches.',
        target: '',
        opensVoiceList: false,
      },
    ],
    [isTeamMatch]
  )

  const [step, setStep] = useState(0)
  const [rect, setRect] = useState<TargetRect | null>(null)
  const nextBtnRef = useRef<HTMLButtonElement | null>(null)
  const stepCount = steps.length
  const current = steps[Math.min(step, stepCount - 1)]
  const isLast = step === stepCount - 1

  const finish = useCallback(() => {
    onCloseVoiceList()
    onFinish()
  }, [onCloseVoiceList, onFinish])

  const goNext = useCallback(() => {
    if (isLast) {
      finish()
      return
    }
    setStep((prev) => Math.min(prev + 1, stepCount - 1))
  }, [finish, isLast, stepCount])

  const goBack = useCallback(() => {
    setStep((prev) => Math.max(prev - 1, 0))
  }, [])

  // Open the real Voice List only for the step that teaches it; close it again
  // when the tour moves on or ends.
  useEffect(() => {
    if (current.opensVoiceList) {
      const timer = setTimeout(onOpenVoiceList, 80)
      return () => clearTimeout(timer)
    }
    onCloseVoiceList()
  }, [current.opensVoiceList, onOpenVoiceList, onCloseVoiceList])

  // Anchor the spotlight to the live element. The header moves on resize and
  // the modal mounts a moment after the step changes, so keep re-measuring.
  useEffect(() => {
    if (!current.target) {
      setRect(null)
      return
    }
    const measure = () => {
      const el = document.querySelector(current.target)
      if (!el) {
        setRect(null)
        return
      }
      const r = el.getBoundingClientRect()
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    measure()
    const interval = window.setInterval(measure, 250)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [current.target])

  useEffect(() => {
    nextBtnRef.current?.focus({ preventScroll: true })
  }, [step])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish()
      } else if (event.key === 'ArrowRight' && !isLast) {
        event.preventDefault()
        goNext()
      } else if (event.key === 'ArrowLeft' && step > 0) {
        event.preventDefault()
        goBack()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [finish, goBack, goNext, isLast, step])

  const tooltipStyle = useMemo<React.CSSProperties>(() => {
    const width = Math.min(360, window.innerWidth - 24)
    if (!rect) {
      return { left: '50%', top: '50%', width, transform: 'translate(-50%, -50%)' }
    }
    const left = clamp(rect.left + rect.width / 2 - width / 2, 12, window.innerWidth - width - 12)
    const spaceBelow = window.innerHeight - (rect.top + rect.height)
    if (spaceBelow >= 230) {
      return { left, top: rect.top + rect.height + 14, width }
    }
    if (rect.top >= 230) {
      return { left, bottom: window.innerHeight - rect.top + 14, width }
    }
    return { left, bottom: 16, width }
  }, [rect])

  return createPortal(
    <div className={styles.overlay}>
      {rect && (
        <div
          className={styles.spotlight}
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      )}

      <div
        className={styles.tooltip}
        style={tooltipStyle}
        role="dialog"
        aria-modal="false"
        aria-label="Voice introduction tour"
      >
        <div className={styles.eyebrow}>
          <span>{current.eyebrow}</span>
          <div className={styles.dots} aria-hidden="true">
            {steps.map((_, index) => (
              <span
                key={index}
                className={`${styles.dot} ${index === step ? styles.dotActive : ''}`}
              />
            ))}
          </div>
        </div>

        <h3 className={styles.title}>{current.title}</h3>
        <p className={styles.body}>{current.body}</p>

        <div className={styles.actions}>
          <button type="button" className={styles.skipBtn} onClick={finish}>
            Skip tour
          </button>
          <div className={styles.primaryActions}>
            {step > 0 && (
              <button type="button" className={styles.backBtn} onClick={goBack}>
                Back
              </button>
            )}
            <button
              ref={nextBtnRef}
              type="button"
              className={styles.nextBtn}
              onClick={goNext}
            >
              {isLast ? 'Got it' : step === 1 ? 'Open it' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
