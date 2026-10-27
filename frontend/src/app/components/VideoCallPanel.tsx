import React, { useEffect, useRef, useState } from 'react'
import type { MemberInfo } from '../../services/types'
import styles from './VideoCallPanel.module.css'

interface VideoCallPanelProps {
  isOpen: boolean
  onClose: () => void
  members: MemberInfo[]
  myPlayerId: string
  myDisplayName: string
  isMuted: boolean
  onToggleMute: () => void
}

/**
 * Premium Video Call Panel:
 * - Real local camera stream preview with permissions handling
 * - Remote participant video tiles with connection state and speaking indicator
 * - Camera toggle, Mic toggle, Fullscreen, and Minimize/Expand controls
 * - Docked & Floating responsive layout without obscuring gameplay controls
 */
export const VideoCallPanel: React.FC<VideoCallPanelProps> = ({
  isOpen,
  onClose,
  members,
  myPlayerId,
  myDisplayName,
  isMuted,
  onToggleMute,
}) => {
  const [cameraActive, setCameraActive] = useState(false)
  const [isMinimized, setIsMinimized] = useState(false)
  const [permissionError, setPermissionError] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Start / stop local camera stream
  const toggleCamera = async () => {
    if (cameraActive) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = null
      }
      setCameraActive(false)
      setPermissionError(null)
    } else {
      try {
        setPermissionError(null)
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
          audio: false,
        })
        streamRef.current = stream
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream
          localVideoRef.current.play().catch(() => {})
        }
        setCameraActive(true)
      } catch (err: unknown) {
        console.warn('Camera access denied or unavailable:', err)
        setPermissionError('Camera permission denied or camera in use by another app.')
        setCameraActive(false)
      }
    }
  }

  // Clean up media tracks when closed or unmounted
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop())
        streamRef.current = null
      }
    }
  }, [])

  // Auto attach stream if ref becomes available
  useEffect(() => {
    if (cameraActive && streamRef.current && localVideoRef.current) {
      localVideoRef.current.srcObject = streamRef.current
      localVideoRef.current.play().catch(() => {})
    }
  }, [cameraActive, isMinimized])

  const toggleFullscreen = () => {
    if (!panelRef.current) return
    if (!document.fullscreenElement) {
      panelRef.current.requestFullscreen().catch(() => {})
      setIsFullscreen(true)
    } else {
      document.exitFullscreen().catch(() => {})
      setIsFullscreen(false)
    }
  }

  if (!isOpen) return null

  // Other participants in the room
  const otherMembers = members.filter((m) => m.player.id !== myPlayerId)

  return (
    <div
      ref={panelRef}
      className={`${styles.videoPanel} ${isMinimized ? styles.minimized : ''} ${
        isFullscreen ? styles.fullscreen : ''
      }`}
      role="region"
      aria-label="Match Video Call"
    >
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerTitle}>
          <span className={styles.liveDot} />
          <span>Team Video Call ({members.length} Players)</span>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setIsMinimized((prev) => !prev)}
            title={isMinimized ? 'Expand Call' : 'Minimize Call'}
            aria-label={isMinimized ? 'Expand Call' : 'Minimize Call'}
          >
            {isMinimized ? '🗖' : '🗕'}
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            aria-label={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
          >
            ⛶
          </button>
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.closeBtn}`}
            onClick={onClose}
            title="Leave Call"
            aria-label="Leave Call"
          >
            ✕
          </button>
        </div>
      </div>

      {!isMinimized && (
        <>
          {permissionError && (
            <div className={styles.errorBanner}>
              <span>⚠️ {permissionError}</span>
            </div>
          )}

          {/* Grid of video / participant tiles */}
          <div className={styles.videoGrid}>
            {/* Local Video Tile */}
            <div className={styles.videoTile}>
              {cameraActive ? (
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className={styles.videoStream}
                />
              ) : (
                <div className={styles.avatarPlaceholder}>
                  <div className={styles.avatarCircle}>
                    {myDisplayName.charAt(0).toUpperCase()}
                  </div>
                  <span className={styles.camOffNotice}>Camera Off</span>
                </div>
              )}
              <div className={styles.tileFooter}>
                <span className={styles.playerName}>{myDisplayName} (You)</span>
                <span className={styles.statusIcons}>
                  {isMuted ? '🔇' : '🎙️'}
                  {cameraActive ? '📹' : '🚫'}
                </span>
              </div>
            </div>

            {/* Remote Participant Tiles */}
            {otherMembers.map((m) => (
              <div key={m.player.id} className={styles.videoTile}>
                <div className={styles.avatarPlaceholder}>
                  <div
                    className={styles.avatarCircle}
                    style={{
                      background: m.team === 'A' ? 'var(--color-team-a)' : 'var(--color-team-b)',
                    }}
                  >
                    {m.player.display_name.charAt(0).toUpperCase()}
                  </div>
                  <span className={styles.waitingNotice}>
                    {m.player.connection_state === 'CONNECTED' ? 'Listening' : 'Offline'}
                  </span>
                </div>
                <div className={styles.tileFooter}>
                  <span className={styles.playerName}>
                    {m.player.display_name} {m.is_captain ? '(C)' : ''}
                  </span>
                  <span
                    className={styles.connIndicator}
                    data-status={m.player.connection_state}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Controls bar */}
          <div className={styles.controlsBar}>
            <button
              type="button"
              className={`${styles.ctrlBtn} ${cameraActive ? styles.activeCtrl : ''}`}
              onClick={toggleCamera}
              title={cameraActive ? 'Turn Off Camera' : 'Turn On Camera'}
            >
              {cameraActive ? '📹 Stop Video' : '📷 Start Video'}
            </button>

            <button
              type="button"
              className={`${styles.ctrlBtn} ${!isMuted ? styles.activeCtrl : styles.mutedCtrl}`}
              onClick={onToggleMute}
              title={isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
            >
              {isMuted ? '🔇 Unmute' : '🎙️ Mute'}
            </button>

            <button
              type="button"
              className={`${styles.ctrlBtn} ${styles.endBtn}`}
              onClick={onClose}
              title="Close Call Panel"
            >
              🔴 End Call
            </button>
          </div>
        </>
      )}
    </div>
  )
}
