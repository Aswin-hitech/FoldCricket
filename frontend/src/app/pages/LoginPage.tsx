import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import {
  ACCOUNT_AVATARS,
  accountErrorMessage,
} from '../../services/accounts'
import { AvatarPicker } from '../components/AvatarPicker'
import { AccountHeader } from '../components/AccountHeader'
import { sound } from '../../services/sound'
import styles from './LoginPage.module.css'

type Tab = 'login' | 'register'

const BENEFITS = [
  { icon: '⚡', title: 'One-tap matches', text: 'Your saved overs and wickets are ready the moment you sign in.' },
  { icon: '🫂', title: 'Friends circle', text: 'Share your player ID, send requests and build your regulars.' },
  { icon: '🏆', title: 'Badges & levels', text: 'Every run, wicket and win moves your level forward.' },
  { icon: '📊', title: 'Career stats', text: 'Wins, losses, streaks and super overs — kept match after match.' },
]

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const { ready, user, login, register } = useAuth()

  const requested = (location.state as { from?: string } | null)?.from
  const next = requested && requested.startsWith('/') ? requested : searchParams.get('next') || '/profile'

  const [tab, setTab] = useState<Tab>('login')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [avatar, setAvatar] = useState<string>(ACCOUNT_AVATARS[0])
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (ready && user) navigate(next, { replace: true })
  }, [ready, user, next, navigate])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setError('')

    if (tab === 'register' && password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setBusy(true)
    try {
      if (tab === 'login') {
        await login(username.trim(), password)
      } else {
        await register({
          username: username.trim(),
          display_name: displayName.trim() || username.trim(),
          password,
          avatar,
        })
      }
      sound.playClick()
      navigate(next, { replace: true })
    } catch (err) {
      setError(accountErrorMessage(err))
      setBusy(false)
    }
  }

  function switchTab(nextTab: Tab) {
    sound.playClick()
    setTab(nextTab)
    setError('')
    setPassword('')
    setConfirm('')
  }

  return (
    <div className={styles.page}>
      <AccountHeader />

      <main className={styles.main}>
        <div className={styles.shell}>
          <section className={styles.promise}>
            <span className={styles.eyebrow}>FoldCricket accounts</span>
            <h1 className={styles.promiseTitle}>
              Your game.
              <br />
              Your record.
            </h1>
            <p className={styles.promiseText}>
              Keep the same hand-cricket you know — just with a career that carries across every match.
            </p>
            <ul className={styles.benefits}>
              {BENEFITS.map((benefit) => (
                <li key={benefit.title} className={styles.benefit}>
                  <span className={styles.benefitIcon}>{benefit.icon}</span>
                  <div>
                    <strong>{benefit.title}</strong>
                    <p>{benefit.text}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className={styles.guestNote}>
              Just want to play? You can still create or join a room without an account.
            </p>
          </section>

          <section className={styles.panel}>
            <div className={styles.tabs} role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'login'}
                className={`${styles.tab} ${tab === 'login' ? styles.tabActive : ''}`}
                onClick={() => switchTab('login')}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'register'}
                className={`${styles.tab} ${tab === 'register' ? styles.tabActive : ''}`}
                onClick={() => switchTab('register')}
              >
                Create account
              </button>
            </div>

            <form onSubmit={handleSubmit} className={styles.form}>
              <label className={styles.field}>
                <span>Username</span>
                <input
                  className="input"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder={tab === 'login' ? 'your username' : 'e.g. aswin_07'}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={20}
                  required
                />
              </label>

              {tab === 'register' && (
                <>
                  <label className={styles.field}>
                    <span>Display name</span>
                    <input
                      className="input"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      placeholder="Name shown in matches"
                      autoComplete="nickname"
                      maxLength={24}
                    />
                  </label>

                  <div className={styles.field}>
                    <span>Pick your avatar</span>
                    <AvatarPicker value={avatar} onChange={setAvatar} disabled={busy} />
                  </div>
                </>
              )}

              <label className={styles.field}>
                <span>Password</span>
                <div className={styles.passwordWrap}>
                  <input
                    className="input"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={tab === 'login' ? 'your password' : 'at least 8 characters'}
                    autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
                    required
                  />
                  <button
                    type="button"
                    className={styles.eye}
                    onClick={() => setShowPassword((value) => !value)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>

              {tab === 'register' && (
                <label className={styles.field}>
                  <span>Confirm password</span>
                  <input
                    className="input"
                    type={showPassword ? 'text' : 'password'}
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    placeholder="repeat your password"
                    autoComplete="new-password"
                    required
                  />
                </label>
              )}

              {error && (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              )}

              <button type="submit" className="btn btn-primary" disabled={busy} style={{ padding: '13px' }}>
                {busy ? (
                  <span className={styles.spinner} />
                ) : tab === 'login' ? (
                  'Sign in'
                ) : (
                  'Create account'
                )}
              </button>

              <p className={styles.fineprint}>
                {tab === 'login'
                  ? 'Sessions stay signed in for 30 days on this device.'
                  : 'Passwords are hashed on the server. We never store them in plain text.'}
              </p>
            </form>
          </section>
        </div>
      </main>
    </div>
  )
}
