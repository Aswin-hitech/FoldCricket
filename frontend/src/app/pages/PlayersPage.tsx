/**
 * Players hub: the social world for signed-in accounts. Search by name,
 * username or player ID, filter the live roster by presence, open profiles,
 * start a chat or send a match invite.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useSocial } from '../../context/SocialContext'
import {
  accountErrorMessage,
  fetchFriends,
  type FriendSummary,
  type Presence,
  type PresenceStatus,
} from '../../services/accounts'
import { searchSocialPlayers, type SocialPlayer, type SocialUser } from '../../services/social'
import { AccountHeader } from '../components/AccountHeader'
import { Footer } from '../components/Footer'
import { PresenceBadge } from '../components/PresenceBadge'
import styles from './PlayersPage.module.css'

type FilterTab = 'all' | 'online' | 'lobby' | 'match' | 'spectating' | 'friends'

const TABS: Array<{ id: FilterTab; label: string }> = [
  { id: 'all', label: 'All players' },
  { id: 'online', label: 'Online' },
  { id: 'lobby', label: 'In lobby' },
  { id: 'match', label: 'In match' },
  { id: 'spectating', label: 'Spectating' },
  { id: 'friends', label: 'Friends' },
]

interface HubPlayer {
  user_id: string
  username: string
  display_name: string
  avatar: string
  friend_code: string
  level: number
  wins: number
  matches: number
  win_rate: number
  isFriend: boolean
  presence?: Presence
}

function matchesTab(player: HubPlayer, tab: FilterTab, presence: Presence): boolean {
  switch (tab) {
    case 'online':
      return presence.status !== 'offline'
    case 'lobby':
      return presence.status === 'in_lobby'
    case 'match':
      return presence.status === 'in_match'
    case 'spectating':
      return presence.status === 'spectating'
    case 'friends':
      return player.isFriend
    default:
      return true
  }
}

function presenceRank(status: PresenceStatus): number {
  return { in_match: 0, in_lobby: 1, spectating: 2, online: 3, offline: 4 }[status]
}

export default function PlayersPage() {
  const navigate = useNavigate()
  const { ready, user } = useAuth()
  const { openChat, invitePlayer, presenceOf, refresh } = useSocial()

  const [friends, setFriends] = useState<FriendSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SocialPlayer[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<FilterTab>('all')
  const [copied, setCopied] = useState(false)
  const searchSeq = useRef(0)

  useEffect(() => {
    if (ready && !user) {
      navigate('/login', { replace: true, state: { from: '/players' } })
    }
  }, [ready, user, navigate])

  const loadFriends = useCallback(async () => {
    try {
      const payload = await fetchFriends()
      setFriends(payload.friends)
    } catch {
      // Presence polling is best-effort; the header cards stay hidden.
    }
  }, [])

  useEffect(() => {
    if (ready && user) void loadFriends()
  }, [ready, user, loadFriends])

  useEffect(() => {
    if (!ready || !user) return
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadFriends()
      void refresh()
    }, 25000)
    return () => clearInterval(timer)
  }, [ready, user, loadFriends, refresh])

  useEffect(() => {
    const value = query.trim()
    if (value.length < 2) {
      setResults(null)
      setSearching(false)
      setError('')
      return
    }
    setSearching(true)
    setError('')
    searchSeq.current += 1
    const seq = searchSeq.current
    const timer = setTimeout(() => {
      searchSocialPlayers(value)
        .then((payload) => {
          if (seq !== searchSeq.current) return
          setResults(payload.results)
        })
        .catch((err) => {
          if (seq !== searchSeq.current) return
          setResults([])
          setError(accountErrorMessage(err, 'Search failed. Please try again.'))
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearching(false)
        })
    }, 320)
    return () => clearTimeout(timer)
  }, [query])

  const presenceFor = useCallback(
    (player: HubPlayer): Presence => {
      const live = presenceOf(player.user_id)
      if (live.status !== 'offline') return live
      return player.presence ?? { status: 'offline' }
    },
    [presenceOf],
  )

  const basePlayers = useMemo<HubPlayer[]>(() => {
    if (results) {
      return results.map((player) => ({
        user_id: player.user_id,
        username: player.username,
        display_name: player.display_name,
        avatar: player.avatar,
        friend_code: player.friend_code,
        level: player.level,
        wins: player.wins,
        matches: player.matches,
        win_rate: player.win_rate,
        isFriend: player.is_friend,
        presence: player.presence,
      }))
    }
    return (friends ?? [])
      .filter((friend) => friend.user_id)
      .map((friend) => ({
        user_id: friend.user_id as string,
        username: friend.username,
        display_name: friend.display_name,
        avatar: friend.avatar,
        friend_code: friend.friend_code,
        level: friend.level,
        wins: friend.wins,
        matches: friend.matches,
        win_rate: friend.win_rate,
        isFriend: true,
        presence: friend.presence,
      }))
  }, [friends, results])

  const visiblePlayers = useMemo(() => {
    const list = basePlayers.filter((player) => matchesTab(player, tab, presenceFor(player)))
    return [...list].sort((a, b) => {
      const rank = presenceRank(presenceFor(a).status) - presenceRank(presenceFor(b).status)
      if (rank !== 0) return rank
      return b.level - a.level
    })
  }, [basePlayers, tab, presenceFor])

  const counts = useMemo(() => {
    const tally = { online: 0, lobby: 0, match: 0, spectating: 0, friends: 0 }
    for (const player of basePlayers) {
      const status = presenceFor(player).status
      if (status !== 'offline') tally.online += 1
      if (status === 'in_lobby') tally.lobby += 1
      if (status === 'in_match') tally.match += 1
      if (status === 'spectating') tally.spectating += 1
      if (player.isFriend) tally.friends += 1
    }
    return tally
  }, [basePlayers, presenceFor])

  const searchingNow = query.trim().length >= 2
  const totalFriends = friends?.length ?? 0
  const friendsOnline = (friends ?? []).filter(
    (friend) => presenceFor({
      user_id: friend.user_id ?? '',
      username: friend.username,
      display_name: friend.display_name,
      avatar: friend.avatar,
      friend_code: friend.friend_code,
      level: friend.level,
      wins: friend.wins,
      matches: friend.matches,
      win_rate: friend.win_rate,
      isFriend: true,
      presence: friend.presence,
    }).status !== 'offline',
  ).length

  async function copyCode() {
    if (!user) return
    try {
      await navigator.clipboard.writeText(user.friend_code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setError(`Copy failed — your player ID is ${user.friend_code}.`)
    }
  }

  function asSocialUser(player: HubPlayer): SocialUser {
    return {
      user_id: player.user_id,
      username: player.username,
      display_name: player.display_name,
      avatar: player.avatar,
      friend_code: player.friend_code,
      presence: presenceFor(player),
    }
  }

  if (!ready || !user) {
    return (
      <div className={styles.page}>
        <AccountHeader />
        <div className={styles.loading}>Loading the players lounge…</div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <AccountHeader />

      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroGlow} aria-hidden="true" />
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>Players lounge</span>
            <h1 className={styles.title}>Find your next match</h1>
            <p className={styles.subtitle}>
              Search by display name, username, player ID or account ID. See who is online right
              now, chat privately, and send a match invite in one tap.
            </p>

            <div className={styles.searchWrap}>
              <span className={styles.searchIcon} aria-hidden="true">🔍</span>
              <input
                className={styles.searchInput}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search players by name or ID…"
                spellCheck={false}
                autoCapitalize="none"
              />
              {searching && <span className={styles.spinner} aria-label="Searching" />}
              {query && !searching && (
                <button
                  type="button"
                  className={styles.clearBtn}
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          <div className={styles.myCard}>
            <span className={styles.myLabel}>Your player ID</span>
            <button type="button" className={styles.myCode} onClick={copyCode}>
              {user.friend_code}
              <em>{copied ? 'Copied' : 'Copy'}</em>
            </button>
            <div className={styles.myStats}>
              <div>
                <strong>{totalFriends}</strong>
                <span>Friends</span>
              </div>
              <div>
                <strong>{friendsOnline}</strong>
                <span>Online now</span>
              </div>
              <div>
                <strong>{counts.match}</strong>
                <span>In match</span>
              </div>
            </div>
            <Link to="/friends" className={styles.manageFriends}>
              Manage friends →
            </Link>
          </div>
        </section>

        {error && <p className={styles.error} role="alert">{error}</p>}

        <section className={styles.toolbar}>
          <div className={styles.tabs} role="tablist" aria-label="Presence filters">
            {TABS.map((entry) => {
              const badge =
                entry.id === 'online'
                  ? counts.online
                  : entry.id === 'lobby'
                    ? counts.lobby
                    : entry.id === 'match'
                      ? counts.match
                      : entry.id === 'spectating'
                        ? counts.spectating
                        : entry.id === 'friends'
                          ? counts.friends
                          : basePlayers.length
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id}
                  className={tab === entry.id ? styles.tabActive : styles.tab}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.label}
                  <span className={styles.tabCount}>{badge}</span>
                </button>
              )
            })}
          </div>
          <span className={styles.resultsMeta}>
            {searchingNow
              ? `${visiblePlayers.length} result${visiblePlayers.length === 1 ? '' : 's'} for “${query.trim()}”`
              : `${visiblePlayers.length} player${visiblePlayers.length === 1 ? '' : 's'} in view`}
          </span>
        </section>

        {visiblePlayers.length === 0 ? (
          <section className={styles.empty}>
            <span className={styles.emptyIcon}>{searchingNow ? '🔍' : '🫂'}</span>
            <h2>
              {searchingNow
                ? 'No players matched that search'
                : tab === 'friends'
                  ? 'No friends to show yet'
                  : 'Nobody is here right now'}
            </h2>
            <p>
              {searchingNow
                ? 'Try a display name, username, player ID (FC-XXXXXX) or account ID.'
                : 'Add friends from the Friends page, or search for a player above to start a conversation.'}
            </p>
            {!searchingNow && (
              <Link to="/friends" className="btn btn-primary">
                Find friends
              </Link>
            )}
          </section>
        ) : (
          <section className={styles.grid}>
            {visiblePlayers.map((player) => {
              const livePresence = presenceFor(player)
              const available = livePresence.status === 'online'
              return (
                <article key={player.user_id} className={styles.card}>
                  <div className={styles.cardTop}>
                    <div className={styles.avatarWrap}>
                      <span className={styles.avatar}>{player.avatar}</span>
                      <PresenceBadge presence={livePresence} compact />
                    </div>
                    <div className={styles.identity}>
                      <Link
                        to={`/u/${encodeURIComponent(player.friend_code)}`}
                        className={styles.name}
                      >
                        {player.display_name}
                      </Link>
                      <span className={styles.username}>@{player.username}</span>
                      <PresenceBadge presence={livePresence} showRoom />
                    </div>
                    {player.isFriend && <span className={styles.friendTag}>Friend</span>}
                  </div>

                  <div className={styles.statRow}>
                    <span>Lv {player.level}</span>
                    <span>{player.wins} wins</span>
                    <span>{player.matches} matches</span>
                    {player.win_rate > 0 && <span>{player.win_rate}%</span>}
                  </div>

                  <div className={styles.cardActions}>
                    <Link
                      to={`/u/${encodeURIComponent(player.friend_code)}`}
                      className={styles.viewBtn}
                    >
                      View profile
                    </Link>
                    <button
                      type="button"
                      className={styles.messageBtn}
                      onClick={() => void openChat(player.user_id)}
                    >
                      💬 Message
                    </button>
                    <button
                      type="button"
                      className={styles.inviteBtn}
                      onClick={() => invitePlayer(asSocialUser(player))}
                      disabled={!available}
                      title={
                        available
                          ? `Invite ${player.display_name} to a match`
                          : 'They are offline or already in a room.'
                      }
                    >
                      🎮 Invite
                    </button>
                  </div>
                </article>
              )
            })}
          </section>
        )}
      </main>

      <Footer />
    </div>
  )
}
