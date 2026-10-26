/**
 * Landing Page – brand intro, create/join room form.
 */

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { connectSocket } from '../../services/socket'
import { ThemeToggle } from '../../context/ThemeContext'
import { logClientSession } from '../../services/telemetry'
import { sound } from '../../services/sound'
import { Footer } from '../components/Footer'
import { NetworkIndicator } from '../components/NetworkIndicator'
import { useSocket } from '../../hooks/useSocket'
import styles from './LandingPage.module.css'

type Tab = 'create' | 'join'

export default function LandingPage() {
  const navigate = useNavigate()
  const { status, pingLatency } = useSocket()
  const [tab, setTab] = useState<Tab>('create')
  const [displayName, setDisplayName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [mode, setMode] = useState<'SOLO' | 'TEAM'>('SOLO')
  const [overs, setOvers] = useState(2)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Restore display name from storage
  useEffect(() => {
    const saved = localStorage.getItem('hcl_display_name')
    if (saved) setDisplayName(saved)
  }, [])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    const name = displayName.trim()
    if (name.length < 1 || name.length > 24) {
      setError('Display name must be 1–24 characters.')
      return
    }

    setLoading(true)
    const sessionToken = localStorage.getItem('hcl_session') || undefined
    const socket = connectSocket(sessionToken)

    // Register player
    socket.emit('player:register', { display_name: name, session_token: sessionToken })

    socket.once('player:registered', (data: { success: boolean; player_id: string; session_token: string; error?: string }) => {
      if (!data.success) {
        setError(data.error || 'Registration failed')
        setLoading(false)
        return
      }
      localStorage.setItem('hcl_session', data.session_token)
      localStorage.setItem('hcl_player_id', data.player_id)
      localStorage.setItem('hcl_display_name', name)

      if (tab === 'create') {
        logClientSession('create_room', { mode, overs, display_name: name })
        socket.emit('room:create', { mode, overs, session_token: data.session_token })
        socket.once('room:created', (roomData: { success: boolean; room_id?: string; join_code?: string; error?: string }) => {
          setLoading(false)
          if (!roomData.success) {
            setError(roomData.error || 'Failed to create room')
            return
          }
          navigate(`/room/${roomData.room_id}`)
        })
      } else {
        const code = joinCode.trim().toUpperCase()
        if (!code) {
          setError('Enter a join code.')
          setLoading(false)
          return
        }
        logClientSession('join_room', { join_code: code, display_name: name })
        socket.emit('room:join', { join_code: code, session_token: data.session_token })
        socket.once('room:joined', (roomData: { success: boolean; room_id?: string; error?: string }) => {
          setLoading(false)
          if (!roomData.success) {
            setError(roomData.error || 'Failed to join room')
            return
          }
          navigate(`/room/${roomData.room_id}`)
        })
      }
    })
  }

  return (
    <div className={styles.page}>
      {/* Top action bar with Internet Speed & Light/Dark Theme toggle */}
      <div className={styles.topBar}>
        <NetworkIndicator status={status} latency={pingLatency} showReconnectingBanner={false} />
        <ThemeToggle />
      </div>

      {/* Hero */}
      <header className={styles.hero}>
        <div className={styles.heroGlow} />
        <div className={styles.heroContent}>
          <div className={styles.logo}>
            <img src="/logo.jpg" alt="FoldCricket Logo" className={styles.logoImg} />
            <h1 className={styles.logoText}>FoldCricket</h1>
          </div>
          <p className={styles.tagline}>
            Pick your vintage school memories here.
          </p>
          <div className={styles.features}>
            {['Solo & Team Matches', '1–10 Overs Selection', 'Interactive 3D Coin Toss', 'Instant Ball-by-Ball Sync'].map(f => (
              <span key={f} className={styles.featurePill}>✓ {f}</span>
            ))}
          </div>
        </div>
      </header>

      {/* Form card */}
      <main className={styles.main}>
        <div className={styles.card}>
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${tab === 'create' ? styles.tabActive : ''}`}
              onClick={() => setTab('create')}
              type="button"
            >
              Create Room
            </button>
            <button
              className={`${styles.tab} ${tab === 'join' ? styles.tabActive : ''}`}
              onClick={() => setTab('join')}
              type="button"
            >
              Join Room
            </button>
          </div>

          <form onSubmit={handleSubmit} className={styles.form}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="displayName">Your Name</label>
              <input
                id="displayName"
                className="input"
                type="text"
                placeholder="e.g. Sachin"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                maxLength={24}
                autoComplete="nickname"
                required
              />
            </div>

            {tab === 'create' ? (
              <>
                <div className={styles.field}>
                  <label className={styles.label}>Game Mode</label>
                  <div className={styles.modeRow}>
                    {(['SOLO', 'TEAM'] as const).map(m => (
                      <button
                        key={m}
                        type="button"
                        className={`${styles.modeBtn} ${mode === m ? styles.modeBtnActive : ''}`}
                        onClick={() => setMode(m)}
                      >
                        {m === 'SOLO' ? '👤 Solo (1v1)' : '👥 Team Match'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={styles.field}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label className={styles.label}>Match Overs</label>
                    <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--color-team-a)', fontSize: '1.15rem' }}>
                      {overs} {overs === 1 ? 'Over' : 'Overs'} ({overs * 6} Balls)
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    step="1"
                    value={overs}
                    onChange={e => {
                      sound.playClick()
                      setOvers(Number(e.target.value))
                    }}
                    className={styles.rangeSlider}
                    aria-label="Match Overs Slider"
                  />
                  <div className={styles.quickChips}>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(o => (
                      <button
                        key={o}
                        type="button"
                        className={`${styles.chipBtn} ${overs === o ? styles.chipBtnActive : ''}`}
                        onClick={() => {
                          sound.playClick()
                          setOvers(o)
                        }}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className={styles.field}>
                <label className={styles.label} htmlFor="joinCode">Room Code</label>
                <input
                  id="joinCode"
                  className={`input ${styles.codeInput}`}
                  type="text"
                  placeholder="ABC123"
                  value={joinCode}
                  onChange={e => setJoinCode(e.target.value.toUpperCase())}
                  maxLength={6}
                  autoComplete="off"
                />
              </div>
            )}

            {error && <p className={styles.error}>{error}</p>}

            <button
              type="submit"
              className="btn btn-primary"
              style={{ width: '100%', padding: '14px' }}
              disabled={loading}
            >
              {loading ? (
                <span className={styles.spinner} />
              ) : tab === 'create' ? (
                '🚀 Create Room'
              ) : (
                '🎯 Join Room'
              )}
            </button>
          </form>
        </div>

        <p className={styles.rules}>
          <strong>Authentic Rules:</strong> Choose numbers <strong>1, 2, 3, 4, or 6</strong> each delivery. If batter and bowler pick the same number, it is a <strong>WICKET !!!</strong> Otherwise, the batter scores their chosen number.
        </p>
      </main>

      <Footer />
    </div>
  )
}
