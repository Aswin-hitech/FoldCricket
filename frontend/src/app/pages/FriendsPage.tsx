import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useSocial } from '../../context/SocialContext'
import {
  acceptFriendRequest,
  accountErrorMessage,
  declineFriendRequest,
  fetchFriends,
  removeFriend,
  searchPlayers,
  sendFriendRequest,
  type FriendSummary,
  type FriendsPayload,
  type Presence,
  type PublicProfile,
} from '../../services/accounts'
import { AccountHeader } from '../components/AccountHeader'
import { Footer } from '../components/Footer'
import { PresenceBadge } from '../components/PresenceBadge'
import styles from './FriendsPage.module.css'

function levelLabel(level: number): string {
  return `Lv ${level}`
}

export default function FriendsPage() {
  const navigate = useNavigate()
  const { ready, user, refresh } = useAuth()
  const { openChat, invitePlayer, presenceOf } = useSocial()

  const livePresence = (person: { user_id?: string; presence?: Presence }): Presence => {
    const live = presenceOf(person.user_id)
    return live.status !== 'offline' ? live : person.presence ?? { status: 'offline' }
  }

  const canInvite = (presence: Presence) => presence.status === 'online'

  const [data, setData] = useState<FriendsPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [confirming, setConfirming] = useState('')
  const [copied, setCopied] = useState(false)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PublicProfile[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')

  useEffect(() => {
    if (ready && !user) {
      navigate('/login', { replace: true, state: { from: '/friends' } })
    }
  }, [ready, user, navigate])

  const flash = useCallback((message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 3200)
  }, [])

  const load = useCallback(async () => {
    setError('')
    try {
      setData(await fetchFriends())
    } catch (err) {
      setError(accountErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (ready && user) void load()
  }, [ready, user, load])

  const incomingByCode = useMemo(
    () => new Map((data?.incoming ?? []).map((person) => [person.friend_code, person])),
    [data],
  )

  async function runSearch(value: string) {
    setSearching(true)
    setSearchError('')
    try {
      const payload = await searchPlayers(value)
      setResults(payload.results)
    } catch (err) {
      setSearchError(accountErrorMessage(err))
    } finally {
      setSearching(false)
    }
  }

  useEffect(() => {
    const value = query.trim()
    if (value.length < 3) {
      setResults([])
      setSearchError('')
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = window.setTimeout(() => void runSearch(value), 350)
    return () => window.clearTimeout(timer)
  }, [query])

  async function addFriend(identifier: string) {
    if (busy) return
    setBusy(identifier)
    setError('')
    try {
      const result = await sendFriendRequest(identifier)
      flash(result.status === 'accepted' ? 'You are now friends!' : 'Friend request sent.')
      setResults((prev) =>
        prev.map((person) =>
          person.friend_code === identifier
            ? { ...person, relationship: result.status === 'accepted' ? 'friend' : 'outgoing' }
            : person,
        ),
      )
      await load()
      await refresh()
    } catch (err) {
      setError(accountErrorMessage(err))
    } finally {
      setBusy('')
    }
  }

  async function acceptRequest(requestId: string) {
    if (busy) return
    setBusy(requestId)
    setError('')
    try {
      await acceptFriendRequest(requestId)
      flash('Friend added to your circle.')
      if (query.trim().length >= 3) void runSearch(query.trim())
      await load()
      await refresh()
    } catch (err) {
      setError(accountErrorMessage(err))
    } finally {
      setBusy('')
    }
  }

  async function declineRequest(requestId: string) {
    if (busy) return
    setBusy(requestId)
    setError('')
    try {
      await declineFriendRequest(requestId)
      flash('Request declined.')
      await load()
      await refresh()
    } catch (err) {
      setError(accountErrorMessage(err))
    } finally {
      setBusy('')
    }
  }

  async function dropFriend(friend: FriendSummary) {
    if (busy) return
    setBusy(friend.friend_code)
    setError('')
    try {
      await removeFriend(friend.friend_code)
      setConfirming('')
      flash(`${friend.display_name} was removed from your friends.`)
      await load()
      await refresh()
    } catch (err) {
      setError(accountErrorMessage(err))
    } finally {
      setBusy('')
    }
  }

  async function copyCode() {
    if (!user) return
    try {
      await navigator.clipboard.writeText(user.friend_code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError(`Copy failed — your player ID is ${user.friend_code}.`)
    }
  }

  if (!ready || !user) {
    return (
      <div className={styles.page}>
        <AccountHeader />
        <div className={styles.loading}>Loading…</div>
      </div>
    )
  }

  const incoming = data?.incoming ?? []
  const outgoing = data?.outgoing ?? []
  const friends = data?.friends ?? []

  return (
    <div className={styles.page}>
      <AccountHeader />

      <main className={styles.main}>
        <section className={styles.intro}>
          <div>
            <span className={styles.eyebrow}>Friends circle</span>
            <h1 className={styles.title}>Your regulars</h1>
            <p className={styles.subtitle}>
              Share your player ID, add friends by ID or username, and get a match going in seconds.
            </p>
          </div>
          <div className={styles.myCode}>
            <span>Your player ID</span>
            <button type="button" className={styles.codeBtn} onClick={copyCode}>
              {user.friend_code}
              <em>{copied ? 'Copied' : 'Copy'}</em>
            </button>
          </div>
        </section>

        {notice && <p className={styles.notice} role="status">{notice}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}

        <section className={styles.card}>
          <div className={styles.cardHead}>
            <h2>Find a player</h2>
            <span>Search by player ID or username</span>
          </div>
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon}>🔍</span>
            <input
              className={`input ${styles.searchInput}`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="FC-AB12CD or username"
              autoCapitalize="characters"
              spellCheck={false}
            />
            {searching && <span className={styles.searchSpinner} />}
          </div>

          {query.trim().length > 0 && query.trim().length < 3 && (
            <p className={styles.hint}>Type at least 3 characters.</p>
          )}
          {searchError && <p className={styles.error}>{searchError}</p>}

          {results.length > 0 && (
            <div className={styles.results}>
              {results.map((person) => {
                const incomingRequest = incomingByCode.get(person.friend_code)
                return (
                  <div key={person.friend_code} className={styles.personRow}>
                    <span className={styles.avatar}>{person.avatar}</span>
                    <div className={styles.personInfo}>
                      <Link to={`/u/${person.friend_code}`} className={styles.personName}>
                        {person.display_name}
                      </Link>
                      <span>
                        @{person.username} · {levelLabel(person.level)} · {person.wins}W / {person.matches}M
                      </span>
                    </div>
                    <div className={styles.personActions}>
                      <PresenceBadge presence={livePresence(person)} />
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => void openChat(person.user_id || person.friend_code)}
                      >
                        💬 Chat
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={!canInvite(livePresence(person))}
                        title={
                          canInvite(livePresence(person))
                            ? `Invite ${person.display_name} to a match`
                            : 'They are offline or already in a room.'
                        }
                        onClick={() =>
                          invitePlayer({
                            user_id: person.user_id || person.friend_code,
                            username: person.username,
                            display_name: person.display_name,
                            avatar: person.avatar,
                            friend_code: person.friend_code,
                            presence: livePresence(person),
                          })
                        }
                      >
                        🎮 Invite
                      </button>
                      {person.relationship === 'self' && <span className={styles.muted}>You</span>}
                      {person.relationship === 'friend' && (
                        <span className={styles.friendTag}>Friends ✓</span>
                      )}
                      {person.relationship === 'outgoing' && (
                        <span className={styles.muted}>Requested</span>
                      )}
                      {person.relationship === 'incoming' && incomingRequest && (
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy === incomingRequest.friendship_id}
                          onClick={() => acceptRequest(incomingRequest.friendship_id || '')}
                        >
                          Accept
                        </button>
                      )}
                      {person.relationship === 'none' && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy === person.friend_code}
                          onClick={() => addFriend(person.friend_code)}
                        >
                          {busy === person.friend_code ? 'Sending…' : '+ Add friend'}
                        </button>
                      )}
                      <Link to={`/u/${person.friend_code}`} className={styles.viewLink}>
                        View
                      </Link>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {!searching && query.trim().length >= 3 && results.length === 0 && !searchError && (
            <p className={styles.hint}>No players matched “{query.trim()}”.</p>
          )}
        </section>

        {incoming.length > 0 && (
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h2>Requests</h2>
              <span>{incoming.length} waiting</span>
            </div>
            <div className={styles.results}>
              {incoming.map((person) => (
                <div key={person.friendship_id || person.friend_code} className={styles.personRow}>
                  <span className={styles.avatar}>{person.avatar}</span>
                  <div className={styles.personInfo}>
                    <Link to={`/u/${person.friend_code}`} className={styles.personName}>
                      {person.display_name}
                    </Link>
                    <span>
                      @{person.username} · {levelLabel(person.level)} wants to be friends
                    </span>
                  </div>
                  <div className={styles.personActions}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy === person.friendship_id}
                      onClick={() => acceptRequest(person.friendship_id || '')}
                    >
                      {busy === person.friendship_id ? 'Accepting…' : 'Accept'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy === person.friendship_id}
                      onClick={() => declineRequest(person.friendship_id || '')}
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {outgoing.length > 0 && (
          <section className={styles.card}>
            <div className={styles.cardHead}>
              <h2>Sent requests</h2>
              <span>{outgoing.length} pending</span>
            </div>
            <div className={styles.results}>
              {outgoing.map((person) => (
                <div key={person.friendship_id || person.friend_code} className={styles.personRow}>
                  <span className={styles.avatar}>{person.avatar}</span>
                  <div className={styles.personInfo}>
                    <Link to={`/u/${person.friend_code}`} className={styles.personName}>
                      {person.display_name}
                    </Link>
                    <span>@{person.username} · waiting for a reply</span>
                  </div>
                  <span className={styles.muted}>Pending</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className={styles.card}>
          <div className={styles.cardHead}>
            <h2>Friends</h2>
            <span>{friends.length} in your circle</span>
          </div>

          {loading ? (
            <p className={styles.hint}>Loading your circle…</p>
          ) : friends.length === 0 ? (
            <div className={styles.empty}>
              <span>🫂</span>
              <p>No friends yet. Search their player ID above to send your first request.</p>
            </div>
          ) : (
            <div className={styles.friendsGrid}>
              {friends.map((friend) => (
                <div key={friend.friendship_id || friend.friend_code} className={styles.friendCard}>
                  <Link to={`/u/${friend.friend_code}`} className={styles.friendTop}>
                    <span className={styles.avatar}>{friend.avatar}</span>
                    <div className={styles.personInfo}>
                      <span className={styles.personName}>{friend.display_name}</span>
                      <span>
                        {levelLabel(friend.level)} · {friend.wins}W / {friend.matches}M · {friend.win_rate}%
                      </span>
                      <PresenceBadge presence={livePresence(friend)} showRoom />
                    </div>
                  </Link>
                  <div className={styles.friendFooter}>
                    {confirming === friend.friend_code ? (
                      <>
                        <span className={styles.confirmText}>Remove?</span>
                        <button
                          type="button"
                          className={styles.dangerBtn}
                          disabled={busy === friend.friend_code}
                          onClick={() => dropFriend(friend)}
                        >
                          {busy === friend.friend_code ? '…' : 'Yes'}
                        </button>
                        <button type="button" className={styles.ghostBtn} onClick={() => setConfirming('')}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <Link to={`/u/${friend.friend_code}`} className={styles.viewLink}>
                          View profile
                        </Link>
                        <button
                          type="button"
                          className={styles.ghostBtn}
                          onClick={() => void openChat(friend.user_id || friend.friend_code)}
                        >
                          💬 Chat
                        </button>
                        <button
                          type="button"
                          className={styles.ghostBtn}
                          disabled={!canInvite(livePresence(friend))}
                          title={
                            canInvite(livePresence(friend))
                              ? `Invite ${friend.display_name} to a match`
                              : 'They are offline or already in a room.'
                          }
                          onClick={() =>
                            invitePlayer({
                              user_id: friend.user_id || friend.friend_code,
                              username: friend.username,
                              display_name: friend.display_name,
                              avatar: friend.avatar,
                              friend_code: friend.friend_code,
                              presence: livePresence(friend),
                            })
                          }
                        >
                          🎮 Invite
                        </button>
                        <button type="button" className={styles.ghostBtn} onClick={() => setConfirming(friend.friend_code)}>
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      <Footer />
    </div>
  )
}
