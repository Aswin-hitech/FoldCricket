import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
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
  // `connecting` is the normal startup state, not a fault: only an actual
  // dropped/errored socket should surface the reconnection alert.
  const isDisconnected = status === 'disconnected' || status === 'error'
  const isConnecting = status === 'connecting'

  // Don't flash the alert banner for sub-second blips or the initial handshake.
  const [bannerVisible, setBannerVisible] = useState(false)
  useEffect(() => {
    if (!isDisconnected) {
      setBannerVisible(false)
      return
    }
    const timer = setTimeout(() => setBannerVisible(true), 2500)
    return () => clearTimeout(timer)
  }, [isDisconnected])

  // Determine bar levels & quality
  // < 100ms -> 4 bars (Green)
  // 100 - 250ms -> 2-3 bars (Yellow)
  // > 250ms or null -> 1 bar (Red)
  let level = 4
  let qualityClass = styles.excellent
  let qualityText = 'Excellent'

  if (isDisconnected) {
    level = 0
    qualityClass = styles.offline
    qualityText = 'Offline'
  } else if (isConnecting || latency === null) {
    level = 0
    qualityClass = styles.pending
    qualityText = 'Connecting'
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
      {/* Floating Reconnection Alert Banner if connection issue. Portaled so a
          desktop-only or collapsed menu container cannot hide it on phones. */}
      {showReconnectingBanner &&
        isDisconnected &&
        bannerVisible &&
        createPortal(
          <div className={styles.reconnectingBanner} role="alert">
            <div className={styles.reconnectingPulse} />
            <span className={styles.reconnectingIcon}>⚠️</span>
            <span className={styles.reconnectingText}>
              Connection issue . reconnecting
            </span>
            <span className={styles.reconnectingDots}>
              <span>.</span><span>.</span><span>.</span>
            </span>
          </div>,
          document.body
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
          {isDisconnected ? 'Reconnecting' : isConnecting ? 'Connecting…' : `${latency ?? '--'} ms`}
        </span>
      </div>
    </>
  )
}
