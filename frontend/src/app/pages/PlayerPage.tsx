import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useSocial } from '../../context/SocialContext'
import {
  acceptFriendRequest,
  accountErrorMessage,
  fetchFriends,
  fetchPlayer,
  removeFriend,
  sendFriendRequest,
  type Presence,
  type PublicProfile,
} from '../../services/accounts'
import { AccountHeader } from '../components/AccountHeader'
import { Footer } from '../components/Footer'
import { PresenceBadge } from '../components/PresenceBadge'
import styles from './PlayerPage.module.css'

function parseServerDate(value: string): Date {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`)
}

function shortDate(value: string): string {
  const date = parseServerDate(value)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function PlayerPage() {
  const { code = '' } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const { ready, user, refresh } = useAuth()
  const { openChat, invitePlayer, presenceOf } = useSocial()

  const [profile, setProfile] = useState<PublicProfile | null>(null)
  const [incomingRequestId, setIncomingRequestId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (ready && !user) {
      navigate('/login', { replace: true, state: { from: `/u/${code}` } })
    }
  }, [ready, user, navigate, code])

  const load = useCallback(async () => {
    if (!code) return
    setLoading(true)
    setError('')
    try {
      const result = await fetchPlayer(code)
      if (result.is_self) {
        navigate('/profile', { replace: true })
        return
      }
      setProfile(result)
      if (result.relationship === 'incoming') {
        const friends = await fetchFriends()
        const match = friends.incoming.find((person) => person.friend_code === result.friend_code)
        setIncomingRequestId(match?.friendship_id || '')
      }
    } catch (err) {
      setError(accountErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [code, navigate])

  useEffect(() => {
    if (ready && user) void load()
  }, [ready, user, load])

  const stats = profile?.stats
  const achievements = profile?.achievements ?? []
  const earned = useMemo(() => achievements.filter((badge) => badge.earned), [achievements])

  const livePresence: Presence = (() => {
    if (!profile) return { status: 'offline' }
    const live = presenceOf(profile.user_id)
    return live.status !== 'offline' ? live : profile.presence ?? { status: 'offline' }
  })()
  const canInvite = livePresence.status === 'online'

  async function addFriend() {
    if (!profile || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await sendFriendRequest(profile.friend_code)
      setNotice(result.status === 'accepted' ? 'You are now friends!' : 'Friend request sent.')
      await load()
      await refresh()
    } catch (err) {
      setError(accountErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function acceptFriend() {
    if (!incomingRequestId || busy) return
    setBusy(true)
    setError('')
    try {
      await acceptFriendRequest(incomingRequestId)
      setNotice('Friend added to your circle.')
      await load()
      await refresh()
    } catch (err) {
      setError(accountErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function dropFriend() {
    if (!profile || busy) return
    setBusy(true)
    setError('')
    try {
      await removeFriend(profile.friend_code)
      setConfirmRemove(false)
      setNotice('Friend removed.')
      await load()
      await refresh()
    } catch (err) {
      setError(accountErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function copyCode() {
    if (!profile) return
    try {
      await navigator.clipboard.writeText(profile.friend_code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError(`Copy failed — player ID is ${profile.friend_code}.`)
    }
  }

  if (!ready || !user || loading) {
    return (
      <div className={styles.page}>
        <AccountHeader />
        <div className={styles.loading}>Loading player…</div>
      </div>
    )
  }

  if (!profile) {
    return (
      <div className={styles.page}>
        <AccountHeader />
        <main className={styles.main}>
          <div className={styles.card}>
            <h1 className={styles.title}>Player not found</h1>
            <p className={styles.subtitle}>{error || 'That player ID does not exist.'}</p>
            <Link to="/friends" className="btn btn-secondary">
              Back to friends
            </Link>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <AccountHeader />

      <main className={styles.main}>
        <Link to="/players" className={styles.backLink}>
          ← Players
        </Link>

        {notice && <p className={styles.notice} role="status">{notice}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}

        <section className={styles.hero}>
          <div className={styles.heroMain}>
            <div className={styles.avatar}>{profile.avatar}</div>
            <div>
              <span className={styles.username}>@{profile.username}</span>
              <h1 className={styles.name}>{profile.display_name}</h1>
              <div className={styles.chips}>
                <PresenceBadge presence={livePresence} showRoom />
                <span className={styles.levelChip}>Lv {profile.level}</span>
                <span className={styles.chip}>{profile.wins} wins</span>
                <span className={styles.chip}>{profile.matches} matches</span>
                <span className={styles.chip}>{profile.win_rate}% win rate</span>
                {profile.relationship === 'friend' && <span className={styles.friendChip}>Friends ✓</span>}
                {profile.relationship === 'incoming' && <span className={styles.requestChip}>Wants to be friends</span>}
                {profile.relationship === 'outgoing' && <span className={styles.chip}>Request sent</span>}
              </div>
              {profile.bio && <p className={styles.bio}>{profile.bio}</p>}
              <button type="button" className={styles.codeChip} onClick={copyCode}>
                {profile.friend_code}
                <em>{copied ? 'Copied' : 'Copy ID'}</em>
              </button>
            </div>
          </div>

          <div className={styles.actions}>
            {profile.relationship === 'none' && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={addFriend}>
                {busy ? 'Sending…' : '+ Add friend'}
              </button>
            )}
            {profile.relationship === 'incoming' && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !incomingRequestId}
                onClick={acceptFriend}
              >
                {busy ? 'Accepting…' : 'Accept request'}
              </button>
            )}
            {profile.relationship === 'outgoing' && (
              <span className={styles.pending}>Friend request pending</span>
            )}
            {profile.relationship === 'friend' &&
              (confirmRemove ? (
                <div className={styles.confirmBox}>
                  <span>Remove friend?</span>
                  <button type="button" className={styles.dangerBtn} disabled={busy} onClick={dropFriend}>
                    {busy ? '…' : 'Yes, remove'}
                  </button>
                  <button type="button" className={styles.ghostBtn} onClick={() => setConfirmRemove(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button type="button" className="btn btn-secondary" onClick={() => setConfirmRemove(true)}>
                  Remove friend
                </button>
              ))}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void openChat(profile.user_id || profile.friend_code)}
            >
              💬 Message
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canInvite}
              title={
                canInvite
                  ? `Invite ${profile.display_name} to a match`
                  : 'They are offline or already in a room.'
              }
              onClick={() =>
                invitePlayer({
                  user_id: profile.user_id || profile.friend_code,
                  username: profile.username,
                  display_name: profile.display_name,
                  avatar: profile.avatar,
                  friend_code: profile.friend_code,
                  presence: livePresence,
                })
              }
            >
              🎮 Invite to play
            </button>
          </div>
        </section>

        {profile.is_friend && stats ? (
          <>
            <section className={styles.card}>
              <div className={styles.cardHead}>
                <h2>Career stats</h2>
                <span>Visible to friends</span>
              </div>
              <div className={styles.statsGrid}>
                {[
                  { label: 'Matches', value: stats.matches },
                  { label: 'Wins', value: stats.wins },
                  { label: 'Losses', value: stats.losses },
                  { label: 'Win rate', value: `${stats.win_rate}%` },
                  { label: 'Runs', value: stats.runs },
                  { label: 'Wickets', value: stats.wickets },
                  { label: 'Best score', value: stats.best_score },
                  { label: 'Super overs', value: `${stats.super_over_wins}/${stats.super_overs}` },
                  { label: 'Best streak', value: stats.best_streak },
                  { label: 'Team matches', value: stats.team_matches },
                ].map((tile) => (
                  <div key={tile.label} className={styles.statTile}>
                    <span className={styles.statValue}>{tile.value}</span>
                    <span className={styles.statLabel}>{tile.label}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className={styles.card}>
              <div className={styles.cardHead}>
                <h2>Achievements</h2>
                <span>
                  {earned.length} of {achievements.length} unlocked
                </span>
              </div>
              <div className={styles.badgesGrid}>
                {achievements.map((badge) => (
                  <div
                    key={badge.code}
                    className={`${styles.badge} ${badge.earned ? styles.badgeEarned : styles.badgeLocked}`}
                    title={badge.description}
                  >
                    <span className={styles.badgeIcon}>{badge.earned ? badge.icon : '🔒'}</span>
                    <div>
                      <strong>{badge.name}</strong>
                      <p>{badge.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className={styles.card}>
              <div className={styles.cardHead}>
                <h2>Recent matches</h2>
                <span>Last {profile.recent_matches?.length ?? 0}</span>
              </div>
              {(profile.recent_matches?.length ?? 0) === 0 ? (
                <p className={styles.hint}>No completed matches yet.</p>
              ) : (
                <div className={styles.matchList}>
                  {profile.recent_matches?.map((match) => (
                    <div key={match.match_id} className={styles.matchRow}>
                      <span
                        className={`${styles.result} ${
                          match.result === 'WIN' ? styles.win : match.result === 'LOSS' ? styles.loss : styles.tie
                        }`}
                      >
                        {match.result}
                      </span>
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
          </>
        ) : (
          <section className={styles.card}>
            <div className={styles.locked}>
              <span>🔒</span>
              <h2>Full stats are for friends</h2>
              <p>
                You can see {profile.display_name}'s level and win summary. Add them as a friend to see career
                stats, badges and recent matches.
              </p>
            </div>
          </section>
        )}
      </main>

      <Footer />
    </div>
  )
}
