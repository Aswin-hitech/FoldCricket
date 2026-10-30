import type { Presence } from '../../services/accounts'
import { PRESENCE_LABELS } from '../../services/social'
import styles from './PresenceBadge.module.css'

interface PresenceBadgeProps {
  presence?: Presence
  /** Icon dot only — used inside dense list rows. */
  compact?: boolean
  /** Show the room code while the player is in a lobby or match. */
  showRoom?: boolean
}

export function PresenceBadge({ presence, compact = false, showRoom = false }: PresenceBadgeProps) {
  const status = presence?.status ?? 'offline'
  const label = PRESENCE_LABELS[status]
  const room = showRoom && presence?.join_code ? ` · ${presence.join_code}` : ''
  const title = status === 'offline' ? 'Offline' : `${label}${room}`

  if (compact) {
    return (
      <span
        className={`${styles.compact} ${styles[status]}`}
        title={title}
        aria-label={title}
      >
        <span className={styles.dot} aria-hidden="true" />
      </span>
    )
  }

  return (
    <span className={`${styles.badge} ${styles[status]}`} title={title}>
      <span className={styles.dot} aria-hidden="true" />
      <span>
        {label}
        {room && <em className={styles.room}>{room}</em>}
      </span>
    </span>
  )
}
