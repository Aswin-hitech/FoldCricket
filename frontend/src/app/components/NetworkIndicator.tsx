import React from 'react'
import type { ConnectionStatus } from '../../hooks/useSocket'
import styles from './NetworkIndicator.module.css'

interface NetworkIndicatorProps {
  status: ConnectionStatus
  latency: number | null
  showReconnectingBanner?: boolean
}

export const NetworkIndicator: React.FC<NetworkIndicatorProps> = ({
  status,
  latency,
  showReconnectingBanner = true,
}) => {
  const isDisconnected = status === 'disconnected' || status === 'error' || status === 'connecting'

  // Determine bar levels & quality
  // < 100ms -> 4 bars (Green)
  // 100 - 250ms -> 2-3 bars (Yellow)
  // > 250ms or null -> 1 bar (Red)
  let level = 4
  let qualityClass = styles.excellent
  let qualityText = 'Excellent'

  if (isDisconnected || latency === null) {
    level = 0
    qualityClass = styles.offline
    qualityText = 'Offline'
  } else if (latency < 80) {
    level = 4
    qualityClass = styles.excellent
    qualityText = 'Super Fast'
  } else if (latency < 160) {
    level = 3
    qualityClass = styles.good
    qualityText = 'Good'
  } else if (latency < 280) {
    level = 2
    qualityClass = styles.moderate
    qualityText = 'Moderate'
  } else {
    level = 1
    qualityClass = styles.poor
    qualityText = 'Slow'
  }

  return (
    <>
      {/* Floating Reconnection Alert Banner if connection issue */}
      {showReconnectingBanner && isDisconnected && (
        <div className={styles.reconnectingBanner} role="alert">
          <div className={styles.reconnectingPulse} />
          <span className={styles.reconnectingIcon}>⚠️</span>
          <span className={styles.reconnectingText}>
            Connection issue . reconnecting
          </span>
          <span className={styles.reconnectingDots}>
            <span>.</span><span>.</span><span>.</span>
          </span>
        </div>
      )}

      {/* Real-time Internet Speed Pill in Header */}
      <div
        className={`${styles.indicatorContainer} ${qualityClass}`}
        title={`Network Latency: ${latency !== null ? `${latency} ms` : 'Disconnected'} (${qualityText})`}
      >
        <div className={styles.bars}>
          <span className={`${styles.bar} ${styles.bar1} ${level >= 1 ? styles.barActive : ''}`} />
          <span className={`${styles.bar} ${styles.bar2} ${level >= 2 ? styles.barActive : ''}`} />
          <span className={`${styles.bar} ${styles.bar3} ${level >= 3 ? styles.barActive : ''}`} />
          <span className={`${styles.bar} ${styles.bar4} ${level >= 4 ? styles.barActive : ''}`} />
        </div>
        <span className={styles.pingValue}>
          {isDisconnected ? 'Reconnecting' : `${latency ?? '--'} ms`}
        </span>
      </div>
    </>
  )
}
