import React, { useEffect, useRef, useState } from 'react'
import type { VideoCallSession } from '../../services/types'
import styles from './VideoCallPanel.module.css'

interface PanelMember {
  player: { id: string; display_name: string; connection_state?: string }
  team?: 'A' | 'B' | string | null
  is_captain?: boolean
}

interface VideoCallPanelProps {
  isOpen: boolean
  /** Ends a private call, or stops the camera in broadcast mode. */
  onClose: () => void
  members: PanelMember[]
  myPlayerId: string
  myDisplayName: string
  isMuted: boolean
  onToggleMute: () => void
  localStream: MediaStream | null
  remoteStreams: Record<string, MediaStream>
  cameraOn: boolean
  cameraError: string | null
  network: { allowed: boolean; reason: string; latency: number | null }
  callPeer: VideoCallSession | null
  onToggleCamera: () => void
  canToggleCamera: boolean
}

/** Mirrors a live MediaStream into a muted <video> element. */
const StreamVideo: React.FC<{ stream: MediaStream | null; mirrored?: boolean }> = ({
  stream,
  mirrored = false,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
    if (stream) el.play().catch(() => {})
    return () => {
      if (el.srcObject === stream) el.srcObject = null
    }
  }, [stream])

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      className={styles.videoStream}
      style={mirrored ? undefined : { transform: 'none' }}
    />
  )
}

/**
 * Beta video panel: shows the live local camera plus incoming peer video.
 * Media is owned by VoiceChat (one camera, one WebRTC mesh); this panel only
 * renders and exposes the camera/mic/call controls.
 */
export const VideoCallPanel: React.FC<VideoCallPanelProps> = ({
  isOpen,
  onClose,
  members,
  myPlayerId,
  myDisplayName,
  isMuted,
  onToggleMute,
  localStream,
  remoteStreams,
  cameraOn,
  cameraError,
  network,
  callPeer,
  onToggleCamera,
  canToggleCamera,
}) => {
  const [isMinimized, setIsMinimized] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)

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

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  if (!isOpen) return null

  const inCall = Boolean(callPeer)
  const peerMembers = inCall
    ? members.filter((m) => m.player.id === callPeer?.peerId)
    : members.filter((m) => m.player.id !== myPlayerId)
  const callConnected = callPeer?.state === 'active'

  return (
    <div
      ref={panelRef}
      className={`${styles.videoPanel} ${isMinimized ? styles.minimized : ''} ${
        isFullscreen ? styles.fullscreen : ''
      }`}
      role="region"
      aria-label={inCall ? 'Private video call' : 'Camera broadcast'}
    >
      <div className={styles.header}>
        <div className={styles.headerTitle}>
          <span className={styles.liveDot} />
          <span>
            {inCall
              ? callConnected
                ? `📹 ${callPeer?.peerName || 'Video call'}`
                : `⏳ Calling ${callPeer?.peerName || '…'}`
              : `📷 Camera broadcast${
                  Object.keys(remoteStreams).length ? ` (${Object.keys(remoteStreams).length} live)` : ''
                }`}
          </span>
          {network.latency !== null && (
            <span className={styles.networkTag}>{network.latency} ms</span>
          )}
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setIsMinimized((prev) => !prev)}
            title={isMinimized ? 'Expand' : 'Minimize'}
            aria-label={isMinimized ? 'Expand' : 'Minimize'}
          >
            {isMinimized ? '🗖' : '🗕'}
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            ⛶
          </button>
          <button
            type="button"
            className={`${styles.iconBtn} ${styles.closeBtn}`}
            onClick={onClose}
            title={inCall ? 'Leave video call' : 'Stop camera'}
            aria-label={inCall ? 'Leave video call' : 'Stop camera'}
          >
            ✕
          </button>
        </div>
      </div>

      {!isMinimized && (
        <>
          {(cameraError || !network.allowed) && (
            <div className={styles.errorBanner}>
              <span>⚠️ {cameraError || network.reason}</span>
            </div>
          )}

          <div className={styles.videoGrid}>
            <div className={styles.videoTile}>
              {localStream && cameraOn ? (
                <StreamVideo stream={localStream} mirrored />
              ) : (
                <div className={styles.avatarPlaceholder}>
                  <div className={styles.avatarCircle}>
                    {myDisplayName.charAt(0).toUpperCase()}
                  </div>
                  <span className={styles.camOffNotice}>
                    {inCall && callConnected ? 'Sending audio only' : 'Camera off'}
                  </span>
                </div>
              )}
              <div className={styles.tileFooter}>
                <span className={styles.playerName}>{myDisplayName} (You)</span>
                <span className={styles.statusIcons}>
                  {isMuted ? '🔇' : '🎙️'}
                  {localStream && cameraOn ? '📹' : '🚫'}
                </span>
              </div>
            </div>

            {peerMembers.map((m) => {
              const stream = remoteStreams[m.player.id] || null
              return (
                <div key={m.player.id} className={styles.videoTile}>
                  {stream ? (
                    <StreamVideo stream={stream} />
                  ) : (
                    <div className={styles.avatarPlaceholder}>
                      <div
                        className={styles.avatarCircle}
                        style={{
                          background:
                            m.team === 'A' ? 'var(--color-team-a)' : 'var(--color-team-b)',
                        }}
                      >
                        {m.player.display_name.charAt(0).toUpperCase()}
                      </div>
                      <span className={styles.waitingNotice}>
                        {inCall && !callConnected
                          ? 'Connecting…'
                          : m.player.connection_state === 'CONNECTED'
                            ? 'Camera off'
                            : 'Offline'}
                      </span>
                    </div>
                  )}
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
              )
            })}
          </div>

          <div className={styles.controlsBar}>
            <button
              type="button"
              className={`${styles.ctrlBtn} ${cameraOn ? styles.activeCtrl : ''}`}
              onClick={onToggleCamera}
              disabled={!canToggleCamera}
              title={
                network.allowed
                  ? cameraOn
                    ? 'Stop sending video (audio stays live)'
                    : 'Resume camera'
                  : `Video unavailable: ${network.reason}`
              }
            >
              {cameraOn ? '📹 Camera On' : '📷 Camera Off'}
            </button>

            <button
              type="button"
              className={`${styles.ctrlBtn} ${!isMuted ? styles.activeCtrl : styles.mutedCtrl}`}
              onClick={onToggleMute}
              title={isMuted ? 'Unmute microphone' : 'Mute microphone'}
            >
              {isMuted ? '🔇 Unmute' : '🎙️ Mute'}
            </button>

            <button
              type="button"
              className={`${styles.ctrlBtn} ${styles.endBtn}`}
              onClick={onClose}
              title={inCall ? 'End video call' : 'Stop camera'}
            >
              {inCall ? '🔴 End Call' : '⏹ Stop Video'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
