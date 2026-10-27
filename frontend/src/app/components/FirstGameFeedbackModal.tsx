import React, { useState } from 'react'
import { sound } from '../../services/sound'
import { vibration } from '../../services/vibration'
import { submitFeedbackReport } from '../../services/feedback'
import styles from './FirstGameFeedbackModal.module.css'

interface FirstGameFeedbackModalProps {
  isOpen: boolean
  onClose: () => void
  myPlayerId: string
  myDisplayName: string
  roomCode?: string | null
  matchSummary?: string | null
}

const RATING_LABELS: Record<number, string> = {
  1: 'Needs Work 😔',
  2: 'Fair 😐',
  3: 'Good 🙂',
  4: 'Great Game! 😃',
  5: 'Nostalgic & Amazing! 🏆',
}

const CATEGORY_TAGS = [
  '🏏 Vintage School Memories',
  '🎙️ Voice Chat',
  '⚡ Fast Real-time Sync',
  '📱 Smooth Mobile Touch',
  '🐞 Found a Bug',
  '💡 Feature Idea',
]

export const FirstGameFeedbackModal: React.FC<FirstGameFeedbackModalProps> = ({
  isOpen,
  onClose,
  myPlayerId,
  myDisplayName,
  roomCode,
  matchSummary,
}) => {
  const [rating, setRating] = useState<number>(5)
  const [hoverRating, setHoverRating] = useState<number | null>(null)
  const [selectedCategories, setSelectedCategories] = useState<string[]>([
    '🏏 Vintage School Memories',
  ])
  const [feedbackText, setFeedbackText] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  if (!isOpen) return null

  const toggleCategory = (cat: string) => {
    sound.playClick()
    vibration.tap()
    setSelectedCategories(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    sound.playClick()
    vibration.tap()

    try {
      await submitFeedbackReport({
        player_id: myPlayerId,
        player_name: myDisplayName,
        rating,
        feedback_text: feedbackText.trim(),
        categories: selectedCategories,
        room_code: roomCode,
        metadata: {
          match_summary: matchSummary,
          user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
          is_first_game: true,
        },
      })

      // Mark feedback as submitted so it won't prompt again
      localStorage.setItem('hcl_feedback_submitted', 'true')
      if (myPlayerId) {
        localStorage.setItem(`hcl_feedback_${myPlayerId}`, 'true')
      }

      setSubmitted(true)
      sound.playWin()
      vibration.win()

      setTimeout(() => {
        onClose()
      }, 2400)
    } catch {
      // Even if network blips, mark as attempted
      localStorage.setItem('hcl_feedback_submitted', 'true')
      setSubmitted(true)
      setTimeout(() => {
        onClose()
      }, 2000)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSkip = () => {
    sound.playClick()
    // Remember skip so user is not prompted repeatedly
    localStorage.setItem('hcl_feedback_submitted', 'true')
    onClose()
  }

  return (
    <div className={styles.overlay} role="dialog" aria-modal aria-label="First Game Feedback Report">
      <div className={styles.modal}>
        {submitted ? (
          <div className={styles.thankYouContainer}>
            <span className={styles.thankYouIcon}>🎉</span>
            <h3 className={styles.thankYouTitle}>Thank You for Your Feedback!</h3>
            <p className={styles.thankYouDesc}>
              Your feedback has been collected in Supabase to help us perfect the vintage school hand cricket experience.
            </p>
          </div>
        ) : (
          <>
            <div className={styles.badge}>First Match Feedback</div>
            <div className={styles.header}>
              <h2 className={styles.title}>
                <span>🏏</span> How was your first game?
              </h2>
              <p className={styles.subtitle}>
                We would love your report on FoldCricket to keep improving the nostalgia, speed, and gameplay!
              </p>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Star Rating */}
              <div className={styles.ratingSection}>
                <div className={styles.starsRow}>
                  {[1, 2, 3, 4, 5].map(star => {
                    const currentRating = hoverRating ?? rating
                    const isActive = star <= currentRating
                    return (
                      <button
                        key={star}
                        type="button"
                        className={`${styles.starBtn} ${isActive ? styles.starActive : styles.starInactive}`}
                        onMouseEnter={() => setHoverRating(star)}
                        onMouseLeave={() => setHoverRating(null)}
                        onClick={() => {
                          sound.playClick()
                          vibration.tap()
                          setRating(star)
                        }}
                        aria-label={`${star} Stars`}
                      >
                        ★
                      </button>
                    )
                  })}
                </div>
                <div className={styles.ratingLabel}>
                  {RATING_LABELS[hoverRating ?? rating]}
                </div>
              </div>

              {/* Category tags */}
              <div className={styles.categorySection}>
                <label className={styles.sectionLabel}>What stood out to you?</label>
                <div className={styles.chipGroup}>
                  {CATEGORY_TAGS.map(cat => {
                    const isSelected = selectedCategories.includes(cat)
                    return (
                      <button
                        key={cat}
                        type="button"
                        className={`${styles.chip} ${isSelected ? styles.chipSelected : ''}`}
                        onClick={() => toggleCategory(cat)}
                      >
                        {cat}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Feedback text area */}
              <div className={styles.textAreaGroup}>
                <label className={styles.sectionLabel} htmlFor="feedback-text">
                  Your Thoughts or Suggestions (Optional)
                </label>
                <textarea
                  id="feedback-text"
                  className={styles.textarea}
                  placeholder="Tell us what vintage memories came back, any bugs encountered, or suggestions..."
                  value={feedbackText}
                  onChange={e => setFeedbackText(e.target.value)}
                  maxLength={500}
                />
              </div>

              {/* Buttons */}
              <div className={styles.btnRow}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleSkip}
                  disabled={isSubmitting}
                >
                  Maybe Later
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Submitting to Supabase…' : '🌟 Submit Report'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
