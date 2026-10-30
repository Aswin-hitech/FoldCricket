import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useSocial } from '../../context/SocialContext'
import { ChatDrawer } from './ChatDrawer'
import { IncomingInviteModal, InviteComposer } from './PlayInviteModals'
import styles from './SocialOverlay.module.css'

const HIDE_LAUNCHER_ON = ['/room/', '/login', '/players']

export function SocialOverlay() {
  const { user } = useAuth()
  const { unreadTotal, requests, toasts, dismissToast, openInbox, openChat } = useSocial()
  const location = useLocation()
  const navigate = useNavigate()

  if (!user) return null

  const hideLauncher = HIDE_LAUNCHER_ON.some((prefix) => location.pathname.startsWith(prefix))
  const incomingCount = requests.incoming.filter((request) => request.status === 'PENDING').length

  return (
    <>
      {!hideLauncher && (
        <div className={styles.launcher}>
          <Link to="/players" className={styles.launcherBtn} title="Players & presence">
            <span aria-hidden="true">🔎</span>
            <span className={styles.launcherLabel}>Players</span>
            {incomingCount > 0 && <span className={styles.badge}>{incomingCount}</span>}
          </Link>
          <button
            type="button"
            className={`${styles.launcherBtn} ${styles.launcherPrimary}`}
            title="Messages"
            onClick={openInbox}
          >
            <span aria-hidden="true">💬</span>
            <span className={styles.launcherLabel}>Messages</span>
            {unreadTotal > 0 && <span className={styles.badge}>{unreadTotal > 99 ? '99+' : unreadTotal}</span>}
          </button>
        </div>
      )}

      <div className={styles.toasts} aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`${styles.toast} ${styles[`toast_${toast.kind}`]}`}>
            <span className={styles.toastIcon} aria-hidden="true">
              {toast.kind === 'dm' ? toast.peer?.avatar || '💬' : toast.kind === 'invite' ? '🏏' : toast.kind === 'error' ? '⚠️' : 'ℹ️'}
            </span>
            <div className={styles.toastBody}>
              <strong>
                {toast.kind === 'dm' && toast.peer
                  ? `New message from ${toast.peer.display_name}`
                  : toast.kind === 'invite'
                    ? 'Match invite'
                    : toast.kind === 'error'
                      ? 'Something went wrong'
                      : 'Update'}
              </strong>
              <p>{toast.text}</p>
            </div>
            <div className={styles.toastActions}>
              {toast.roomId && (
                <button
                  type="button"
                  className={styles.toastAction}
                  onClick={() => {
                    dismissToast(toast.id)
                    navigate(`/room/${toast.roomId}`)
                  }}
                >
                  Open
                </button>
              )}
              {toast.kind === 'dm' && toast.peer && (
                <button
                  type="button"
                  className={styles.toastAction}
                  onClick={() => {
                    dismissToast(toast.id)
                    void openChat(toast.peer!.user_id)
                  }}
                >
                  Reply
                </button>
              )}
              <button
                type="button"
                className={styles.toastClose}
                aria-label="Dismiss"
                onClick={() => dismissToast(toast.id)}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      <IncomingInviteModal />
      <InviteComposer />
      <ChatDrawer />
    </>
  )
}
