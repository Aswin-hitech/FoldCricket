import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import {
  accountErrorMessage,
  changePassword,
  type Badge,
  type RecentMatch,
} from '../../services/accounts'
import { startInstantMatch } from '../../services/instantMatch'
import { AvatarPicker } from '../components/AvatarPicker'
import { AccountHeader } from '../components/AccountHeader'
import { Footer } from '../components/Footer'
import { sound } from '../../services/sound'
import styles from './ProfilePage.module.css'

function parseServerDate(value: string): Date {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`)
}

function shortDate(value: string): string {
  const date = parseServerDate(value)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function tierClass(tier: Badge['tier']): string {
  return tier === 'gold' ? styles.tierGold : tier === 'silver' ? styles.tierSilver : styles.tierBronze
}

function ResultPill({ result }: { result: RecentMatch['result'] }) {
  const cls = result === 'WIN' ? styles.win : result === 'LOSS' ? styles.loss : styles.tie
  return <span className={`${styles.resultPill} ${cls}`}>{result}</span>
}

function BadgeCard({ badge }: { badge: Badge }) {
  return (
    <div className={`${styles.badgeCard} ${badge.earned ? styles.badgeEarned : ''}`}>
      <div className={`${styles.badgeIcon} ${badge.earned ? styles.badgeIconEarned : ''}`}>
        {badge.earned ? badge.icon : '🔒'}
      </div>
      <div className={styles.badgeBody}>
        <div className={styles.badgeTitleRow}>
          <strong>{badge.name}</strong>
          <span className={`${styles.tierDot} ${tierClass(badge.tier)}`} title={`${badge.tier} tier`} />
        </div>
        <p className={styles.badgeDesc}>{badge.description}</p>
        {badge.earned ? (
          <span className={styles.earnedTag}>Earned</span>
        ) : (
          <div className={styles.progressRow}>
            <div className={styles.progressTrack}>
              <div className={styles.progressFill} style={{ width: `${Math.round(badge.progress * 100)}%` }} />
            </div>
            <span>
              {badge.value}/{badge.threshold}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

export default function ProfilePage() {
  const navigate = useNavigate()
  const {
    ready,
    user,
    profile,
    stats,
    achievements,
    refresh,
    updateProfile,
  } = useAuth()

  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState('')
  const [playError, setPlayError] = useState('')
  const [starting, setStarting] = useState(false)
  const [dismissedBadges, setDismissedBadges] = useState(false)

  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({
    display_name: '',
    avatar: '🏏',
    bio: '',
    default_mode: 'SOLO' as 'SOLO' | 'TEAM',
    default_overs: 2,
    default_wickets: 1,
  })
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState('')

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordMessage, setPasswordMessage] = useState('')
  const [passwordError, setPasswordError] = useState('')

  const settingsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (ready && !user) {
      navigate('/login', { replace: true, state: { from: '/profile' } })
    }
  }, [ready, user, navigate])

  useEffect(() => {
    if (ready && user) void refresh()
    // `user` is re-created whenever the profile refreshes; key the effect on
    // the stable username so this runs once, not in a refresh loop.
  }, [ready, user?.username, refresh])

  useEffect(() => {
    if (window.location.hash === '#settings' && settingsRef.current) {
      settingsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [profile])

  const defaults = useMemo(() => {
    const mode: 'SOLO' | 'TEAM' = user?.default_mode === 'TEAM' ? 'TEAM' : 'SOLO'
    return {
      mode,
      overs: Math.min(10, Math.max(1, user?.default_overs ?? 2)),
      wickets: Math.min(mode === 'SOLO' ? 5 : 10, Math.max(1, user?.default_wickets ?? 1)),
    }
  }, [user])

  const badgeNames = useMemo(
    () => new Map(achievements.map((badge) => [badge.code, badge.name])),
    [achievements],
  )

  const earnedCount = achievements.filter((badge) => badge.earned).length
  const freshBadges = dismissedBadges
    ? []
    : (profile?.new_achievements ?? []).map((code) => badgeNames.get(code)).filter(Boolean)

  if (!ready || !user || !profile || !stats) {
    return (
      <div className={styles.page}>
        <AccountHeader />
        <div className={styles.loading}>Loading your profile…</div>
      </div>
    )
  }

  async function copyFriendCode() {
    if (!user) return
    try {
      await navigator.clipboard.writeText(user.friend_code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setNotice('Copy failed — your player ID is ' + user.friend_code)
    }
  }

  async function playInstant() {
    if (!user || starting) return
    setStarting(true)
    setPlayError('')
    try {
      const { roomId } = await startInstantMatch({
        displayName: user.display_name,
        mode: defaults.mode,
        overs: defaults.overs,
        wickets: defaults.wickets,
      })
      navigate(`/room/${roomId}`)
    } catch (error) {
      setPlayError(error instanceof Error ? error.message : 'Could not start the match.')
      setStarting(false)
    }
  }

  function openEditor() {
    if (!user) return
    setNotice('')
    setEditError('')
    setForm({
      display_name: user.display_name,
      avatar: user.avatar,
      bio: user.bio || '',
      default_mode: (user.default_mode as 'SOLO' | 'TEAM') || 'SOLO',
      default_overs: user.default_overs ?? 2,
      default_wickets: user.default_wickets ?? 1,
    })
    setEditing(true)
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    setEditError('')
    try {
      await updateProfile({
        display_name: form.display_name.trim(),
        avatar: form.avatar,
        bio: form.bio.trim(),
        default_mode: form.default_mode,
        default_overs: form.default_overs,
        default_wickets: form.default_wickets,
      })
      setEditing(false)
      setNotice('Profile updated.')
      sound.playClick()
    } catch (error) {
      setEditError(accountErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault()
    if (passwordBusy) return
    setPasswordError('')
    setPasswordMessage('')
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match.')
      return
    }
    setPasswordBusy(true)
    try {
      await changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordMessage('Password updated. Other devices were signed out.')
    } catch (error) {
      setPasswordError(accountErrorMessage(error))
    } finally {
      setPasswordBusy(false)
    }
  }

  const statTiles = [
    { label: 'Matches', value: stats.matches },
    { label: 'Wins', value: stats.wins, tone: 'positive' },
    { label: 'Losses', value: stats.losses, tone: 'negative' },
    { label: 'Win rate', value: `${stats.win_rate}%` },
    { label: 'Runs', value: stats.runs },
    { label: 'Wickets', value: stats.wickets },
    { label: 'Best score', value: stats.best_score },
    { label: 'Super overs', value: `${stats.super_over_wins}/${stats.super_overs}` },
    { label: 'Best streak', value: stats.best_streak },
    { label: 'Team matches', value: stats.team_matches },
  ]

  return (
    <div className={styles.page}>
      <AccountHeader />

      <main className={styles.main}>
        {freshBadges.length > 0 && (
          <div className={styles.freshBanner}>
            <span className={styles.freshIcon}>🎉</span>
            <div>
              <strong>New badge{freshBadges.length > 1 ? 's' : ''}: {freshBadges.join(', ')}</strong>
              <p>Nice work — keep the streak going.</p>
            </div>
            <button type="button" onClick={() => setDismissedBadges(true)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}

        <section className={styles.hero}>
          <div className={styles.heroMain}>
            <div className={styles.avatarLarge}>{user.avatar}</div>
            <div className={styles.identity}>
              <span className={styles.username}>@{user.username}</span>
              <h1 className={styles.displayName}>{user.display_name}</h1>
              <p className={styles.bio}>
                {user.bio || 'Add a short bio so friends know who they are playing.'}
              </p>
              <div className={styles.codeRow}>
                <span className={styles.codeLabel}>Player ID</span>
                <button type="button" className={styles.codeChip} onClick={copyFriendCode}>
                  {user.friend_code}
                  <span className={styles.codeAction}>{copied ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </div>
          </div>

          <div className={styles.heroSide}>
            <div className={styles.levelCard}>
              <div className={styles.levelTop}>
                <span className={styles.levelNumber}>Lv {stats.level}</span>
                <span className={styles.xpText}>
                  {stats.xp_into_level} / {stats.xp_for_level} XP
                </span>
              </div>
              <div className={styles.xpTrack}>
                <div
                  className={styles.xpFill}
                  style={{
                    width: `${stats.xp_for_level ? Math.round((stats.xp_into_level / stats.xp_for_level) * 100) : 0}%`,
                  }}
                />
              </div>
              <p className={styles.xpHint}>{stats.xp} career XP · next level at {stats.xp_for_level} into-level XP</p>
            </div>

            <div className={styles.heroActions}>
              <button type="button" className={`btn btn-primary ${styles.primary}`} onClick={playInstant} disabled={starting}>
                {starting ? <span className={styles.miniSpinner} /> : '⚡ Instant match'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={openEditor}>
                Edit profile
              </button>
            </div>
            <p className={styles.defaultsHint}>
              Default: {defaults.mode === 'SOLO' ? 'Solo 1v1' : 'Team'} · {defaults.overs}{' '}
              {defaults.overs === 1 ? 'over' : 'overs'} · {defaults.wickets}{' '}
              {defaults.wickets === 1 ? 'wicket' : 'wickets'}
            </p>
            <Link to="/friends" className={styles.friendsLink}>
              🫂 {profile.friends_count} friend{profile.friends_count === 1 ? '' : 's'}
              {profile.incoming_requests > 0 && (
                <span className={styles.requestDot}>{profile.incoming_requests} new</span>
              )}
            </Link>
          </div>
        </section>

        {(playError || notice) && (
          <p className={playError ? styles.error : styles.notice} role="status">
            {playError || notice}
          </p>
        )}

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>Career stats</h2>
            <span>Every completed match counts</span>
          </div>
          <div className={styles.statsGrid}>
            {statTiles.map((tile) => (
              <div key={tile.label} className={`${styles.statTile} ${tile.tone ? styles[tile.tone] : ''}`}>
                <span className={styles.statValue}>{tile.value}</span>
                <span className={styles.statLabel}>{tile.label}</span>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>Achievements</h2>
            <span>
              {earnedCount} of {achievements.length} unlocked
            </span>
          </div>
          <div className={styles.badgesGrid}>
            {achievements.map((badge) => (
              <BadgeCard key={badge.code} badge={badge} />
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>Recent matches</h2>
            <span>Last {profile.recent_matches.length || 0}</span>
          </div>
          {profile.recent_matches.length === 0 ? (
            <p className={styles.empty}>
              No matches yet. Your first game will appear here — try an instant match.
            </p>
          ) : (
            <div className={styles.matchList}>
              {profile.recent_matches.map((match) => (
                <div key={match.match_id} className={styles.matchRow}>
                  <ResultPill result={match.result} />
                  <div className={styles.matchWho}>
                    <strong>vs {match.opponent_name}</strong>
                    <span>
                      {match.mode === 'TEAM' ? 'Team' : 'Solo'} · {match.overs}{' '}
                      {match.overs === 1 ? 'over' : 'overs'}
                      {match.super_over ? ' · Super over' : ''}
                    </span>
                  </div>
                  <div className={styles.matchScore}>
                    <strong>
                      {match.runs_scored}/{match.wickets_lost}
                    </strong>
                    <span>{match.wickets_taken} wkts</span>
                  </div>
                  <span className={styles.matchDate}>{shortDate(match.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className={styles.section} ref={settingsRef} id="settings">
          <div className={styles.sectionHead}>
            <h2>Settings</h2>
            <span>Applies to instant matches</span>
          </div>

          {editing ? (
            <form className={styles.editCard} onSubmit={saveProfile}>
              <div className={styles.editHeader}>
                <h3>Edit profile</h3>
                <button type="button" className={styles.textBtn} onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>

              <label className={styles.field}>
                <span>Display name</span>
                <input
                  className="input"
                  value={form.display_name}
                  onChange={(event) => setForm({ ...form, display_name: event.target.value })}
                  maxLength={24}
                  required
                />
              </label>

              <div className={styles.field}>
                <span>Avatar</span>
                <AvatarPicker value={form.avatar} onChange={(avatar) => setForm({ ...form, avatar })} />
              </div>

              <label className={styles.field}>
                <span>Bio</span>
                <textarea
                  className={`input ${styles.textarea}`}
                  value={form.bio}
                  onChange={(event) => setForm({ ...form, bio: event.target.value.slice(0, 160) })}
                  rows={3}
                  maxLength={160}
                  placeholder="A line about your game"
                />
                <small className={styles.counter}>{form.bio.length}/160</small>
              </label>

              <div className={styles.field}>
                <span>Default mode</span>
                <div className={styles.modeRow}>
                  {(['SOLO', 'TEAM'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`${styles.modeBtn} ${form.default_mode === mode ? styles.modeBtnActive : ''}`}
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          default_mode: mode,
                          default_wickets:
                            mode === 'SOLO' ? Math.min(prev.default_wickets, 5) : prev.default_wickets,
                        }))
                      }
                    >
                      {mode === 'SOLO' ? '👤 Solo' : '👥 Team'}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.settingsTwo}>
                <label className={styles.field}>
                  <span>Default overs</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={10}
                    value={form.default_overs}
                    onChange={(event) =>
                      setForm({ ...form, default_overs: Math.min(10, Math.max(1, Number(event.target.value) || 1)) })
                    }
                  />
                </label>
                <label className={styles.field}>
                  <span>Default wickets</span>
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={form.default_mode === 'SOLO' ? 5 : 10}
                    value={form.default_wickets}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        default_wickets: Math.min(
                          form.default_mode === 'SOLO' ? 5 : 10,
                          Math.max(1, Number(event.target.value) || 1),
                        ),
                      })
                    }
                  />
                </label>
              </div>

              {editError && <p className={styles.error}>{editError}</p>}

              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </form>
          ) : (
            <div className={styles.settingsCard}>
              <div>
                <h3>Profile & match defaults</h3>
                <p>Change your name, avatar, bio and the settings instant matches use.</p>
              </div>
              <button type="button" className="btn btn-secondary" onClick={openEditor}>
                Edit profile
              </button>
            </div>
          )}

          <form className={styles.passwordCard} onSubmit={savePassword}>
            <div>
              <h3>Password</h3>
              <p>Changing it signs out every other device.</p>
            </div>
            <div className={styles.passwordFields}>
              <input
                className="input"
                type="password"
                placeholder="Current password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
              />
              <input
                className="input"
                type="password"
                placeholder="New password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
              />
              <input
                className="input"
                type="password"
                placeholder="Confirm new password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
              />
              <button type="submit" className="btn btn-secondary" disabled={passwordBusy}>
                {passwordBusy ? 'Updating…' : 'Update password'}
              </button>
            </div>
            {passwordError && <p className={styles.error}>{passwordError}</p>}
            {passwordMessage && <p className={styles.notice}>{passwordMessage}</p>}
          </form>
        </section>
      </main>

      <Footer />
    </div>
  )
}
