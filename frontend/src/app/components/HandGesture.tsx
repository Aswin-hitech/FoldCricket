import React from 'react'
import styles from './HandGesture.module.css'

interface HandGestureProps {
  number: number
  size?: number
  className?: string
  animated?: boolean
}

/**
 * Realistic Hand & Finger Gestures for classic Hand Cricket numbers (1, 2, 3, 4, 6).
 * Crafted with lifelike gradients, finger joints, creases, and 3D depth shadows.
 */
export const HandGesture: React.FC<HandGestureProps> = ({
  number,
  size = 48,
  className = '',
  animated = false,
}) => {
  return (
    <div
      className={`${styles.handWrapper} ${animated ? styles.animatedHand : ''} ${className}`}
      style={{ width: size, height: size }}
      aria-label={`Hand gesture showing ${number}`}
    >
      <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        className={styles.svgHand}
      >
        <defs>
          {/* Realistic skin gradient */}
          <linearGradient id="skinGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#fcd3a1" />
            <stop offset="50%" stopColor="#f6ad55" />
            <stop offset="100%" stopColor="#dd6b20" />
          </linearGradient>

          {/* Palm shadow gradient */}
          <linearGradient id="palmShadow" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stopColor="#c05621" />
            <stop offset="100%" stopColor="#ed8936" />
          </linearGradient>

          {/* Finger highlight gradient */}
          <linearGradient id="fingerHighlight" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#feebc8" />
            <stop offset="70%" stopColor="#f6ad55" />
            <stop offset="100%" stopColor="#c05621" />
          </linearGradient>

          {/* Filter for realistic depth shadow */}
          <filter id="handShadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="1" dy="3" stdDeviation="2.5" floodColor="rgba(0,0,0,0.35)" />
          </filter>
        </defs>

        <g filter="url(#handShadow)">
          {number === 1 && (
            // ONE: Index finger extended high, other fingers curled in fist
            <g>
              {/* Palm fist base */}
              <path d="M 32 50 C 32 40, 68 40, 68 50 L 66 84 C 66 90, 34 90, 34 84 Z" fill="url(#palmShadow)" />
              {/* Curled Middle, Ring, Pinky */}
              <rect x="44" y="48" width="10" height="24" rx="5" fill="url(#fingerHighlight)" />
              <rect x="54" y="50" width="9" height="22" rx="4.5" fill="url(#fingerHighlight)" />
              <rect x="62" y="54" width="8" height="18" rx="4" fill="url(#fingerHighlight)" />
              {/* Folded Thumb */}
              <path d="M 32 60 C 32 52, 48 54, 52 64 C 48 72, 34 72, 32 60 Z" fill="url(#skinGrad)" />
              {/* Extended Index Finger */}
              <rect x="36" y="14" width="11" height="42" rx="5.5" fill="url(#fingerHighlight)" stroke="#dd6b20" strokeWidth="1" />
              {/* Index Knuckle & Fingernail */}
              <ellipse cx="41.5" cy="18" rx="3.5" ry="2.5" fill="#fff5eb" opacity="0.8" />
              <line x1="37" y1="28" x2="46" y2="28" stroke="#c05621" strokeWidth="1" strokeLinecap="round" />
              <line x1="37" y1="40" x2="46" y2="40" stroke="#c05621" strokeWidth="1" strokeLinecap="round" />
            </g>
          )}

          {number === 2 && (
            // TWO: Index + Middle finger extended (Peace / Victory gesture)
            <g>
              {/* Palm fist base */}
              <path d="M 30 52 C 30 42, 70 42, 70 52 L 68 85 C 68 90, 32 90, 32 85 Z" fill="url(#palmShadow)" />
              {/* Curled Ring & Pinky */}
              <rect x="52" y="50" width="10" height="24" rx="5" fill="url(#fingerHighlight)" />
              <rect x="61" y="54" width="9" height="20" rx="4.5" fill="url(#fingerHighlight)" />
              {/* Folded Thumb holding ring/pinky */}
              <path d="M 30 62 C 30 54, 50 56, 54 66 C 48 74, 32 74, 30 62 Z" fill="url(#skinGrad)" />
              {/* Index Finger (angled slightly left) */}
              <rect x="34" y="16" width="10" height="40" rx="5" fill="url(#fingerHighlight)" stroke="#dd6b20" strokeWidth="1" transform="rotate(-6 39 46)" />
              {/* Middle Finger (angled slightly right) */}
              <rect x="47" y="14" width="10.5" height="42" rx="5.2" fill="url(#fingerHighlight)" stroke="#dd6b20" strokeWidth="1" transform="rotate(7 52 46)" />
              {/* Fingernails */}
              <ellipse cx="36" cy="19" rx="3" ry="2" fill="#fff5eb" opacity="0.8" />
              <ellipse cx="56" cy="17" rx="3.2" ry="2" fill="#fff5eb" opacity="0.8" />
            </g>
          )}

          {number === 3 && (
            // THREE: Index, Middle, and Ring fingers extended
            <g>
              {/* Palm */}
              <path d="M 28 52 C 28 42, 72 42, 72 52 L 70 85 C 70 90, 30 90, 30 85 Z" fill="url(#palmShadow)" />
              {/* Curled Pinky */}
              <rect x="62" y="54" width="9" height="20" rx="4.5" fill="url(#fingerHighlight)" />
              {/* Folded Thumb pinning pinky */}
              <path d="M 28 62 C 28 54, 56 56, 60 66 C 54 74, 30 74, 28 62 Z" fill="url(#skinGrad)" />
              {/* Index Finger */}
              <rect x="31" y="18" width="9.5" height="38" rx="4.7" fill="url(#fingerHighlight)" stroke="#dd6b20" strokeWidth="1" transform="rotate(-10 35 48)" />
              {/* Middle Finger */}
              <rect x="44" y="14" width="10" height="42" rx="5" fill="url(#fingerHighlight)" stroke="#dd6b20" strokeWidth="1" />
              {/* Ring Finger */}
              <rect x="56" y="18" width="9.5" height="38" rx="4.7" fill="url(#fingerHighlight)" stroke="#dd6b20" strokeWidth="1" transform="rotate(10 61 48)" />
              {/* Nails */}
              <ellipse cx="30" cy="21" rx="2.8" ry="2" fill="#fff5eb" opacity="0.8" />
              <ellipse cx="49" cy="17" rx="3" ry="2" fill="#fff5eb" opacity="0.8" />
              <ellipse cx="68" cy="21" rx="2.8" ry="2" fill="#fff5eb" opacity="0.8" />
            </g>
          )}

          {number === 4 && (
            // FOUR: Four fingers extended straight up, thumb tucked inward
            <g>
              {/* Palm */}
              <path d="M 25 50 C 25 40, 75 40, 75 50 L 72 86 C 72 90, 28 90, 28 86 Z" fill="url(#palmShadow)" />
              {/* Thumb tucked inside palm */}
              <path d="M 26 62 C 26 55, 46 58, 48 68 C 42 74, 28 73, 26 62 Z" fill="url(#skinGrad)" />
              {/* Index */}
              <rect x="29" y="18" width="9" height="38" rx="4.5" fill="url(#fingerHighlight)" stroke="#dd6b20" strokeWidth="1" transform="rotate(-9 33 48)" />
              {/* Middle */}
              <rect x="40" y="14" width="9.5" height="42" rx="4.7" fill="url(#fingerHighlight)" stroke="#dd6b20" strokeWidth="1" transform="rotate(-3 44 48)" />
              {/* Ring */}
              <rect x="51" y="16" width="9.5" height="40" rx="4.7" fill="url(#fingerHighlight)" stroke="#dd6b20" strokeWidth="1" transform="rotate(3 55 48)" />
              {/* Pinky */}
              <rect x="62" y="24" width="8.5" height="32" rx="4.2" fill="url(#fingerHighlight)" stroke="#dd6b20" strokeWidth="1" transform="rotate(9 66 48)" />
            </g>
          )}

          {number === 6 && (
            // SIX: Iconic Indian Hand Cricket Six: Thumb extended outwards horizontally from fist!
            <g>
              {/* Fist body */}
              <path d="M 38 42 C 38 34, 76 34, 76 45 L 72 85 C 72 90, 42 90, 42 85 Z" fill="url(#palmShadow)" />
              {/* 4 Curled fingers in tight fist */}
              <rect x="42" y="44" width="30" height="9" rx="4.5" fill="url(#fingerHighlight)" stroke="#c05621" strokeWidth="1" />
              <rect x="43" y="54" width="29" height="9" rx="4.5" fill="url(#fingerHighlight)" stroke="#c05621" strokeWidth="1" />
              <rect x="44" y="64" width="28" height="9" rx="4.5" fill="url(#fingerHighlight)" stroke="#c05621" strokeWidth="1" />
              <rect x="45" y="74" width="26" height="8" rx="4" fill="url(#fingerHighlight)" stroke="#c05621" strokeWidth="1" />
              {/* Bold Thumb pointing outward / upward (SIX boundary signal) */}
              <path d="M 44 60 C 35 60, 16 52, 12 40 C 10 32, 20 28, 28 34 C 36 40, 44 48, 46 54 Z" fill="url(#fingerHighlight)" stroke="#dd6b20" strokeWidth="1.2" />
              {/* Thumb nail & knuckle */}
              <ellipse cx="17" cy="35" rx="3.5" ry="2.5" fill="#fff5eb" opacity="0.85" transform="rotate(-25 17 35)" />
              <line x1="26" y1="40" x2="30" y2="48" stroke="#c05621" strokeWidth="1.2" strokeLinecap="round" />
            </g>
          )}
        </g>
      </svg>
    </div>
  )
}
