import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useSocial } from '../../context/SocialContext'
import {
  PLAY_REQUEST_TTL_MS,
  PRESENCE_LABELS,
  type PlayRequest,
} from '../../services/social'
import { accountErrorMessage } from '../../services/accounts'
import { PresenceBadge } from './PresenceBadge'
import styles from './PlayInviteModals.module.css'

function parseServerDate(value: string): Date {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`)
}

function secondsLeft(request: PlayRequest): number {
  const created = parseServerDate(request.created_at).getTime()
  if (Number.isNaN(created)) return 0
  return Math.max(0, Math.ceil((created + PLAY_REQUEST_TTL_MS - Date.now()) / 1000))
}

function countdownLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/** Incoming play request: accept opens a shared room, decline is silent. */
export function IncomingInviteModal() {
  const { requests, acceptInvite, declineInvite, presenceOf, refresh } = useSocial()
  const [busy, setBusy] = useState<'accept' | 'decline' | ''>('')
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)

  const active = useMemo(
    () =>
      requests.incoming.find(
        (request) => request.status === 'PENDING' && secondsLeft(request) > 0,
      ) ?? null,
    // `tick` re-evaluates the expiry clock every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requests.incoming, tick],
  )

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [active])

  useEffect(() => {
    if (!active) return
    const left = secondsLeft(active)
    if (left > 0) return
    void refresh()
  }, [active, refresh])

  useEffect(() => {
    setError('')
  }, [active?.id])

  if (!active) return null

  const presence = presenceOf(active.player.user_id)
  const peerPresence = presence.status === 'offline' ? active.player.presence : presence
  const left = secondsLeft(active)

  async function handleAccept() {
    setBusy('accept')
    setError('')
    try {
      await acceptInvite(active!.id)
    } catch (err) {
      setError(accountErrorMessage(err, 'Could not accept this invite.'))
    } finally {
      setBusy('')
    }
  }

  async function handleDecline() {
    setBusy('decline')
    setError('')
    try {
      await declineInvite(active!.id)
    } catch (err) {
      setError(accountErrorMessage(err, 'Could not decline this invite.'))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className={styles.overlay} role="presentation">
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Play invite">
        <div className={styles.pulseRing} aria-hidden="true">🏏</div>
        <span className={styles.eyebrow}>Match invite</span>
        <h2 className={styles.title}>{active.player.display_name} wants to play</h2>

        <div className={styles.playerRow}>
          <span className={styles.avatar}>{active.player.avatar}</span>
          <div className={styles.playerInfo}>
            <strong>@{active.player.username}</strong>
            <span>{active.player.friend_code}</span>
          </div>
          <PresenceBadge presence={peerPresence} />
        </div>

        <div className={styles.metaGrid}>
          <div>
            <span>Mode</span>
            <strong>{active.mode === 'TEAM' ? 'Team' : 'Solo'}</strong>
          </div>
          <div>
            <span>Overs</span>
            <strong>{active.overs}</strong>
          </div>
          <div>
            <span>Wickets</span>
            <strong>{active.wickets}</strong>
          </div>
          <div>
            <span>Expires in</span>
            <strong>{countdownLabel(left)}</strong>
          </div>
        </div>

        <p className={styles.note}>
          Accepting opens a room with {active.player.display_name} as host and puts you in the
          challenger slot. You can still decide teams and settings in the lobby.
        </p>

        {error && <p className={styles.error} role="alert">{error}</p>}

        <div className={styles.actions}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={Boolean(busy)}
            onClick={handleDecline}
          >
            {busy === 'decline' ? 'Declining…' : 'Not now'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={Boolean(busy) || left <= 0}
            onClick={handleAccept}
          >
            {busy === 'accept' ? 'Opening room…' : 'Accept & play'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Compose a play request for a chosen player. */
export function InviteComposer() {
  const { inviteTarget, closeInvite, sendInvite, presenceOf } = useSocial()
  const { user } = useAuth()
  const [mode, setMode] = useState<'SOLO' | 'TEAM'>('SOLO')
  const [overs, setOvers] = useState(2)
  const [wickets, setWickets] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!inviteTarget) return
    const nextMode = user?.default_mode === 'TEAM' ? 'TEAM' : 'SOLO'
    setMode(nextMode)
    setOvers(Math.min(10, Math.max(1, user?.default_overs ?? 2)))
    setWickets(
      Math.min(
        nextMode === 'SOLO' ? 5 : 10,
        Math.max(1, user?.default_wickets ?? (nextMode === 'SOLO' ? 1 : 5)),
      ),
    )
    setError('')
  }, [inviteTarget, user?.default_mode, user?.default_overs, user?.default_wickets])

  useEffect(() => {
    setWickets((current) => Math.min(mode === 'SOLO' ? 5 : 10, Math.max(1, current)))
  }, [mode])

  if (!inviteTarget) return null

  const presence = presenceOf(inviteTarget.user_id)
  const finalPresence = presence.status === 'offline' ? inviteTarget.presence : presence
  const available = finalPresence?.status === 'online'
  const maxWickets = mode === 'SOLO' ? 5 : 10

  async function handleSend() {
    setBusy(true)
    setError('')
    try {
      await sendInvite({ mode, overs, wickets })
    } catch (err) {
      setError(accountErrorMessage(err, 'Could not send this invite.'))
      setBusy(false)
      return
    }
    setBusy(false)
  }

  return (
    <div className={styles.overlay} role="presentation">
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Invite to play">
        <button type="button" className={styles.modalClose} onClick={closeInvite} aria-label="Close">
          ✕
        </button>
        <span className={styles.eyebrow}>New match invite</span>
        <h2 className={styles.title}>Play with {inviteTarget.display_name}</h2>

        <div className={styles.playerRow}>
          <span className={styles.avatar}>{inviteTarget.avatar}</span>
          <div className={styles.playerInfo}>
            <strong>@{inviteTarget.username}</strong>
            <span>{inviteTarget.friend_code}</span>
          </div>
          <PresenceBadge presence={finalPresence} showRoom />
        </div>

        {!available && (
          <p className={styles.warn}>
            {PRESENCE_LABELS[finalPresence?.status ?? 'offline']} — invites only reach players who
            are online and free to play.
          </p>
        )}

        <div className={styles.field}>
          <span className={styles.fieldLabel}>Format</span>
          <div className={styles.segmented}>
            <button
              type="button"
              className={mode === 'SOLO' ? styles.segmentActive : styles.segment}
              onClick={() => setMode('SOLO')}
            >
              👤 Solo 1v1
            </button>
            <button
              type="button"
              className={mode === 'TEAM' ? styles.segmentActive : styles.segment}
              onClick={() => setMode('TEAM')}
            >
              👥 Team
            </button>
          </div>
        </div>

        <div className={styles.field}>
          <div className={styles.fieldHead}>
            <span className={styles.fieldLabel}>Overs</span>
            <strong>{overs}</strong>
          </div>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={overs}
            onChange={(event) => setOvers(Number(event.target.value))}
            className={styles.range}
          />
          <div className={styles.chips}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((value) => (
              <button
                key={value}
                type="button"
                className={overs === value ? styles.chipActive : styles.chip}
                onClick={() => setOvers(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <div className={styles.fieldHead}>
            <span className={styles.fieldLabel}>Wickets</span>
            <strong>{wickets}</strong>
          </div>
          <div className={styles.chips}>
            {Array.from({ length: maxWickets }, (_, index) => index + 1).map((value) => (
              <button
                key={value}
                type="button"
                className={wickets === value ? styles.chipActive : styles.chip}
                onClick={() => setWickets(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        {error && <p className={styles.error} role="alert">{error}</p>}

        <div className={styles.actions}>
          <button type="button" className="btn btn-secondary" onClick={closeInvite} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSend}
            disabled={busy || !available}
          >
            {busy ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      </div>
    </div>
  )
}
