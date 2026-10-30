import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useSocial } from '../../context/SocialContext'
import styles from './AccountMenu.module.css'

export function AccountMenu() {
  const { ready, profile, user, stats, logout } = useAuth()
  const { unreadTotal, requests, openInbox } = useSocial()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutside)
    document.addEventListener('touchstart', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside)
      document.removeEventListener('touchstart', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  if (!ready) return <span className={styles.placeholder} aria-hidden="true" />

  if (!user) {
    return (
      <Link to="/login" className={styles.signIn}>
        Sign in
      </Link>
    )
  }

  const pending = profile?.incoming_requests ?? 0
  const pendingInvites = requests.incoming.length

  async function handleLogout() {
    setBusy(true)
    try {
      await logout()
      // Full reload: the socket handshake and guest identity both change, and
      // the page may still be holding listeners on the old connection.
      window.location.replace('/')
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className={styles.avatar}>{user.avatar}</span>
        <span className={styles.identity}>
          <span className={styles.name}>{user.display_name}</span>
          <span className={styles.level}>Lv {stats?.level ?? user.level}</span>
        </span>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.header}>
            <span className={styles.headerAvatar}>{user.avatar}</span>
            <div className={styles.headerText}>
              <strong>{user.display_name}</strong>
              <span>@{user.username}</span>
            </div>
          </div>

          <Link to="/profile" className={styles.item} role="menuitem" onClick={() => setOpen(false)}>
            <span className={styles.itemIcon}>👤</span> My profile
          </Link>
          <Link to="/players" className={styles.item} role="menuitem" onClick={() => setOpen(false)}>
            <span className={styles.itemIcon}>🔎</span> Players
            {pendingInvites > 0 && <span className={styles.count}>{pendingInvites}</span>}
          </Link>
          <Link to="/friends" className={styles.item} role="menuitem" onClick={() => setOpen(false)}>
            <span className={styles.itemIcon}>🫂</span> Friends
            {pending > 0 && <span className={styles.count}>{pending}</span>}
          </Link>
          <button
            type="button"
            className={styles.item}
            role="menuitem"
            onClick={() => {
              setOpen(false)
              openInbox()
            }}
          >
            <span className={styles.itemIcon}>💬</span> Messages
            {unreadTotal > 0 && <span className={styles.count}>{unreadTotal}</span>}
          </button>
          <Link to="/profile#settings" className={styles.item} role="menuitem" onClick={() => setOpen(false)}>
            <span className={styles.itemIcon}>⚙️</span> Match defaults
          </Link>

          <button
            type="button"
            className={`${styles.item} ${styles.signOut}`}
            role="menuitem"
            onClick={handleLogout}
            disabled={busy}
          >
            <span className={styles.itemIcon}>↩︎</span> {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  )
}
