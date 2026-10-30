/**
 * Landing Page – brand intro, create/join room form.
 */

import { useState, useEffect } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { connectSocket } from '../../services/socket'
import { ThemeToggle } from '../../context/ThemeContext'
import { useAuth } from '../../context/AuthContext'
import { logClientSession } from '../../services/telemetry'
import { sound } from '../../services/sound'
import { startInstantMatch } from '../../services/instantMatch'
import { getAccountToken } from '../../services/accounts'
import { Footer } from '../components/Footer'
import { NetworkIndicator } from '../components/NetworkIndicator'
import { AccountMenu } from '../components/AccountMenu'
import { useSocket } from '../../hooks/useSocket'
import { stopVoiceSession } from '../../services/voiceSession'
import styles from './LandingPage.module.css'

type Tab = 'create' | 'join'

export default function LandingPage() {
  const navigate = useNavigate()
  const { code: routeCode } = useParams<{ code?: string }>()
  const [searchParams] = useSearchParams()
  const invitedCode = routeCode || searchParams.get('join') || searchParams.get('code')
  const { user } = useAuth()

  const { status, pingLatency } = useSocket()
  const [tab, setTab] = useState<Tab>(invitedCode ? 'join' : 'create')
  const [displayName, setDisplayName] = useState('')
  const [joinCode, setJoinCode] = useState(invitedCode ? invitedCode.toUpperCase() : '')
  const [mode, setMode] = useState<'SOLO' | 'TEAM'>('SOLO')
  const [overs, setOvers] = useState(2)
  const [wickets, setWickets] = useState(1)
  const [joinAsSpectator, setJoinAsSpectator] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Pre-fill join code if invited via link
  useEffect(() => {
    if (invitedCode) {
      setTab('join')
      setJoinCode(invitedCode.toUpperCase())
    }
  }, [invitedCode])

  // Restore display name from storage
  useEffect(() => {
    const saved = localStorage.getItem('hcl_display_name')
    if (saved) setDisplayName(saved)
  }, [])

  // Signed-in players start with their profile name already filled in.
  useEffect(() => {
    if (user) {
      setDisplayName((current) => current || user.display_name)
    }
  }, [user])

  // Leaving the room routes always releases the microphone.
  useEffect(() => {
    stopVoiceSession()
  }, [])

  async function handleInstantMatch() {
    if (!user || loading) return
    setError('')
    setLoading(true)
    const mode = user.default_mode === 'TEAM' ? 'TEAM' : 'SOLO'
    const overs = Math.min(10, Math.max(1, user.default_overs ?? 2))
    const wickets = Math.min(mode === 'SOLO' ? 5 : 10, Math.max(1, user.default_wickets ?? 1))

    try {
      const { roomId } = await startInstantMatch({
        displayName: displayName.trim() || user.display_name,
        mode,
        overs,
        wickets,
      })
      logClientSession('create_room', { mode, overs, wickets, instant: true })
      navigate(`/room/${roomId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the match.')
      setLoading(false)
    }
  }

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
    const accountToken = getAccountToken() || undefined
    const socket = connectSocket(sessionToken)

    socket.once('player:registered', (data: { success: boolean; player_id: string; session_token: string; error?: string }) => {
      if (!data.success) {
        setError(data.error || 'Registration failed')
        setLoading(false)
        return
      }
      localStorage.setItem('hcl_session', data.session_token)
      sessionStorage.setItem('hcl_session_token', data.session_token)
      localStorage.setItem('hcl_player_id', data.player_id)
      localStorage.setItem('hcl_display_name', name)

      if (tab === 'create') {
        socket.once('room:created', (roomData: { success: boolean; room_id?: string; join_code?: string; error?: string }) => {
          setLoading(false)
          if (!roomData.success) {
            setError(roomData.error || 'Failed to create room')
            return
          }
          navigate(`/room/${roomData.room_id}`)
        })
        logClientSession('create_room', { mode, overs, wickets, display_name: name })
        socket.emit('room:create', {
          mode,
          overs,
          wickets,
          session_token: data.session_token,
          ...(accountToken ? { account_token: accountToken } : {}),
        })
      } else {
        const code = joinCode.trim().toUpperCase()
        if (!code) {
          setError('Enter a join code.')
          setLoading(false)
          return
        }
        socket.once('room:joined', (roomData: { success: boolean; room_id?: string; error?: string }) => {
          setLoading(false)
          if (!roomData.success) {
            if (roomData.error === 'game_in_progress' && !joinAsSpectator) {
              setError('This match is already live. Tick “Join as spectator” to watch it.')
            } else if (roomData.error === 'room_full' && !joinAsSpectator) {
              setError('This room is full. Tick “Join as spectator” to watch instead.')
            } else {
              setError(roomData.error || 'Failed to join room')
            }
            return
          }
          navigate(`/room/${roomData.room_id}`)
        })
        logClientSession('join_room', {
          join_code: code,
          display_name: name,
          as_spectator: joinAsSpectator,
        })
        socket.emit('room:join', {
          join_code: code,
          session_token: data.session_token,
          as_spectator: joinAsSpectator,
          ...(accountToken ? { account_token: accountToken } : {}),
        })
      }
    })

    // Register player
    socket.emit('player:register', {
      display_name: name,
      session_token: sessionToken,
      ...(accountToken ? { account_token: accountToken } : {}),
    })
  }

  return (
    <div className={styles.page}>
      {/* Top action bar with Internet Speed & Light/Dark Theme toggle */}
      <div className={styles.topBar}>
        <NetworkIndicator status={status} latency={pingLatency} showReconnectingBanner={false} />
        <ThemeToggle />
        <AccountMenu />
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
          {user && (
            <div className={styles.instant}>
              <div className={styles.instantText}>
                <span className={styles.instantTag}>Signed in as {user.display_name}</span>
                <strong>⚡ Instant match</strong>
                <p>
                  {user.default_mode === 'TEAM' ? 'Team' : 'Solo 1v1'} · {user.default_overs ?? 2}{' '}
                  {(user.default_overs ?? 2) === 1 ? 'over' : 'overs'} · {user.default_wickets ?? 1}{' '}
                  {(user.default_wickets ?? 1) === 1 ? 'wicket' : 'wickets'}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleInstantMatch}
                disabled={loading}
              >
                {loading ? <span className={styles.spinner} /> : 'Start now'}
              </button>
            </div>
          )}
          {invitedCode && (
            <div className={styles.invitedBanner}>
              <span>🔗</span>
              <span>
                Invited to room <strong>{invitedCode.toUpperCase()}</strong>! Enter your name to play,
                or tick “Join as spectator” to watch and chat.
              </span>
            </div>
          )}
          <div className={styles.tabs}>
            <button
              className={`${styles.tab} ${tab === 'create' ? styles.tabActive : ''}`}
              onClick={() => { sound.playClick(); setTab('create') }}
              type="button"
            >
              Create Room
            </button>
            <button
              className={`${styles.tab} ${tab === 'join' ? styles.tabActive : ''}`}
              onClick={() => { sound.playClick(); setTab('join') }}
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
                placeholder="Enter your name"
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
                        onClick={() => {
                          sound.playClick()
                          setMode(m)
                          if (m === 'SOLO' && wickets > 5) setWickets(1)
                          if (m === 'TEAM' && wickets < 2) setWickets(5)
                        }}
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

                {/* Wickets per team selection */}
                <div className={styles.field}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label className={styles.label}>
                      Wickets Per Team <small style={{ textTransform: 'none', color: 'var(--color-text-muted)' }}>({mode === 'SOLO' ? 'Max 5 for Solo' : 'Max 10 for Group'})</small>
                    </label>
                    <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--color-team-a)', fontSize: '1.15rem' }}>
                      {wickets} {wickets === 1 ? 'Wicket' : 'Wickets'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max={mode === 'SOLO' ? 5 : 10}
                    step="1"
                    value={wickets}
                    onChange={e => {
                      sound.playClick()
                      setWickets(Number(e.target.value))
                    }}
                    className={styles.rangeSlider}
                    aria-label="Wickets Per Team Slider"
                  />
                  <div className={styles.quickChips}>
                    {(mode === 'SOLO' ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).map(w => (
                      <button
                        key={w}
                        type="button"
                        className={`${styles.chipBtn} ${wickets === w ? styles.chipBtnActive : ''}`}
                        onClick={() => {
                          sound.playClick()
                          setWickets(w)
                        }}
                      >
                        {w}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
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
                <label className={styles.spectatorToggle} htmlFor="joinAsSpectator">
                  <input
                    id="joinAsSpectator"
                    type="checkbox"
                    checked={joinAsSpectator}
                    onChange={e => setJoinAsSpectator(e.target.checked)}
                  />
                  <span>
                    <strong>👀 Join as spectator</strong>
                    <small>Watch the match and chat with everyone. You can join at any time.</small>
                  </span>
                </label>
              </>
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
              ) : joinAsSpectator ? (
                '👀 Watch as Spectator'
              ) : (
                '🎯 Join Room'
              )}
            </button>
          </form>
        </div>

        <p className={styles.rules}>
          <strong>Authentic Rules:</strong> Choose numbers <strong>1, 2, 3, 4, 5, or 6</strong> each delivery. If batter and bowler pick the same number, it is a <strong>WICKET !!!</strong> Otherwise, the batter scores their chosen number.
        </p>
      </main>

      <Footer />
    </div>
  )
}
