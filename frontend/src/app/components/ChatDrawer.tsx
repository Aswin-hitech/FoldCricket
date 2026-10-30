import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSocial } from '../../context/SocialContext'
import { PRESENCE_LABELS } from '../../services/social'
import { PresenceBadge } from './PresenceBadge'
import styles from './ChatDrawer.module.css'

function parseServerDate(value: string): Date {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`)
}

function messageTime(value: string): string {
  const date = parseServerDate(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function threadTime(value: string): string {
  const date = parseServerDate(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function ChatDrawer() {
  const {
    chatOpen,
    activePeer,
    messages,
    threads,
    unreadTotal,
    requests,
    chatLoading,
    sending,
    closeInbox,
    showInbox,
    openChat,
    sendMessage,
    invitePlayer,
    cancelInvite,
    presenceOf,
  } = useSocial()

  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!chatOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeInbox()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [chatOpen, closeInbox])

  useEffect(() => {
    if (!chatOpen || !activePeer) return
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [chatOpen, activePeer, messages])

  useEffect(() => {
    if (chatOpen && activePeer) {
      setDraft('')
      const timer = setTimeout(() => inputRef.current?.focus(), 120)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [chatOpen, activePeer])

  if (!chatOpen) return null

  const presence = activePeer ? presenceOf(activePeer.user_id) : null
  const peerPresence = presence && presence.status !== 'offline' ? presence : activePeer?.presence
  // A play invite opens a fresh room, so only a player who is online and not
  // already committed to another room can receive one.
  const canInvite = Boolean(activePeer) && peerPresence?.status === 'online'

  async function handleSend(event: React.FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    try {
      await sendMessage(text)
      setDraft('')
      inputRef.current?.focus()
    } catch {
      // The provider already surfaced the failure.
    }
  }

  return (
    <div className={styles.overlay} role="presentation">
      <button
        type="button"
        className={styles.backdrop}
        aria-label="Close messages"
        onClick={closeInbox}
      />
      <aside className={styles.drawer} role="dialog" aria-modal="true" aria-label="Messages">
        <header className={styles.header}>
          {activePeer ? (
            <button type="button" className={styles.backBtn} onClick={showInbox} title="All conversations">
              ←
            </button>
          ) : (
            <span className={styles.headerIcon} aria-hidden="true">
              💬
            </span>
          )}
          <div className={styles.headText}>
            <strong>{activePeer ? activePeer.display_name : 'Messages'}</strong>
            <span>
              {activePeer ? (
                <PresenceBadge presence={peerPresence} showRoom />
              ) : unreadTotal > 0 ? (
                `${unreadTotal} unread`
              ) : (
                'Your private conversations'
              )}
            </span>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={closeInbox}
            aria-label="Close messages"
          >
            ✕
          </button>
        </header>

        {activePeer ? (
          <>
            <div className={styles.peerBar}>
              <span className={styles.peerAvatar}>{activePeer.avatar}</span>
              <div className={styles.peerMeta}>
                <Link to={`/u/${encodeURIComponent(activePeer.friend_code)}`} className={styles.peerLink}>
                  View profile
                </Link>
                <span>@{activePeer.username} · {activePeer.friend_code}</span>
              </div>
              <button
                type="button"
                className={styles.inviteBtn}
                onClick={() => invitePlayer(activePeer)}
                disabled={!canInvite}
                title={
                  canInvite
                    ? 'Invite this player to a match'
                    : 'They are not available to play right now.'
                }
              >
                🎮 Invite
              </button>
            </div>

            <div className={styles.messages} ref={listRef}>
              {chatLoading && messages.length === 0 && (
                <p className={styles.hint}>Loading conversation…</p>
              )}
              {!chatLoading && messages.length === 0 && (
                <div className={styles.emptyChat}>
                  <span>👋</span>
                  <p>Say hello to {activePeer.display_name}. Only you two can see this chat.</p>
                </div>
              )}
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`${styles.bubbleRow} ${message.mine ? styles.mineRow : styles.theirRow}`}
                >
                  {!message.mine && <span className={styles.bubbleAvatar}>{activePeer.avatar}</span>}
                  <div className={`${styles.bubble} ${message.mine ? styles.mine : styles.theirs}`}>
                    <p>{message.body}</p>
                    <span className={styles.stamp}>
                      {messageTime(message.created_at)}
                      {message.mine && message.read_at ? ' · Read' : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <form className={styles.composer} onSubmit={handleSend}>
              <input
                ref={inputRef}
                className={styles.input}
                value={draft}
                onChange={(event) => setDraft(event.target.value.slice(0, 200))}
                placeholder={`Message ${activePeer.display_name}…`}
                maxLength={200}
                autoComplete="off"
              />
              <button
                type="submit"
                className={styles.sendBtn}
                disabled={!draft.trim() || sending}
              >
                {sending ? '…' : 'Send'}
              </button>
            </form>
          </>
        ) : (
          <div className={styles.inbox}>
            {requests.outgoing.length > 0 && (
              <div className={styles.pendingStrip}>
                {requests.outgoing.map((request) => (
                  <div key={request.id} className={styles.pendingRow}>
                    <span className={styles.pendingAvatar}>{request.player.avatar}</span>
                    <div className={styles.pendingInfo}>
                      <strong>Invite sent to {request.player.display_name}</strong>
                      <span>
                        {request.mode === 'TEAM' ? 'Team' : 'Solo'} · {request.overs}{' '}
                        {request.overs === 1 ? 'over' : 'overs'} · waiting…
                      </span>
                    </div>
                    <button
                      type="button"
                      className={styles.cancelBtn}
                      onClick={() => void cancelInvite(request.id)}
                    >
                      Cancel
                    </button>
                  </div>
                ))}
              </div>
            )}

            {threads.length === 0 ? (
              <div className={styles.emptyInbox}>
                <span>💬</span>
                <h3>No conversations yet</h3>
                <p>Find a player on the Players page and send them a message.</p>
                <Link to="/players" className="btn btn-primary" onClick={closeInbox}>
                  Find players
                </Link>
              </div>
            ) : (
              <ul className={styles.threadList}>
                {threads.map((thread) => {
                  const threadPresence = presenceOf(thread.peer.user_id)
                  const finalPresence =
                    threadPresence.status === 'offline' ? thread.peer.presence : threadPresence
                  return (
                    <li key={thread.peer.user_id}>
                      <button
                        type="button"
                        className={`${styles.thread} ${thread.unread > 0 ? styles.threadUnread : ''}`}
                        onClick={() => void openChat(thread.peer.user_id)}
                      >
                        <span className={styles.threadAvatar}>
                          {thread.peer.avatar}
                          <PresenceBadge presence={finalPresence} compact />
                        </span>
                        <span className={styles.threadBody}>
                          <span className={styles.threadTop}>
                            <strong>{thread.peer.display_name}</strong>
                            <em>{threadTime(thread.last_message.created_at)}</em>
                          </span>
                          <span className={styles.threadBottom}>
                            <span className={styles.preview}>
                              {thread.last_message.mine ? 'You: ' : ''}
                              {thread.last_message.body}
                            </span>
                            {thread.unread > 0 && <span className={styles.unread}>{thread.unread}</span>}
                          </span>
                          <span className={styles.threadPresence}>
                            {PRESENCE_LABELS[finalPresence?.status ?? 'offline']}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </aside>
    </div>
  )
}
