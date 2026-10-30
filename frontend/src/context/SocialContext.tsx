/**
 * Social world provider.
 *
 * Keeps one live account socket open while a player is signed in, so direct
 * messages and play invites arrive on any page, and derives presence from the
 * server (never from local guesses). The game socket is the same singleton used
 * by the lobby/arena pages, so there is exactly one transport per tab.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { accountErrorMessage, getAccountToken, type Presence } from '../services/accounts'
import { connectSocket } from '../services/socket'
import {
  acceptPlayRequest,
  cancelPlayRequest,
  createPlayRequest,
  declinePlayRequest,
  fetchPlayRequests,
  fetchPresence,
  fetchThread,
  fetchThreads,
  markThreadRead,
  sendDirectMessage,
  type DirectMessage,
  type PlayRequest,
  type PlayRequestsPayload,
  type SocialUser,
  type ThreadSummary,
} from '../services/social'

export type SocialToastKind = 'dm' | 'invite' | 'info' | 'error'

export interface SocialToast {
  id: number
  kind: SocialToastKind
  text: string
  peer?: SocialUser
  roomId?: string
}

interface InviteSettings {
  mode: 'SOLO' | 'TEAM'
  overs: number
  wickets: number
}

interface SocialContextValue {
  threads: ThreadSummary[]
  unreadTotal: number
  requests: PlayRequestsPayload
  presence: Record<string, Presence>
  chatOpen: boolean
  activePeer: SocialUser | null
  messages: DirectMessage[]
  chatLoading: boolean
  sending: boolean
  inviteTarget: SocialUser | null
  toasts: SocialToast[]
  presenceOf: (userId?: string) => Presence
  openInbox: () => void
  closeInbox: () => void
  openChat: (identifier: string) => Promise<void>
  showInbox: () => void
  sendMessage: (text: string) => Promise<void>
  invitePlayer: (player: SocialUser) => void
  closeInvite: () => void
  sendInvite: (settings: InviteSettings) => Promise<{ already_sent: boolean }>
  acceptInvite: (requestId: string) => Promise<void>
  declineInvite: (requestId: string) => Promise<void>
  cancelInvite: (requestId: string) => Promise<void>
  dismissToast: (id: number) => void
  refresh: () => Promise<void>
}

const SocialContext = createContext<SocialContextValue | null>(null)

const EMPTY_REQUESTS: PlayRequestsPayload = { incoming: [], outgoing: [] }

function mergeMessage(list: DirectMessage[], message: DirectMessage): DirectMessage[] {
  if (list.some((item) => item.id === message.id)) return list
  return [...list, message].sort((a, b) => a.created_at.localeCompare(b.created_at))
}

function upsertRequest(list: PlayRequest[], request: PlayRequest): PlayRequest[] {
  const rest = list.filter((item) => item.id !== request.id)
  return [request, ...rest]
}

function dropRequest(payload: PlayRequestsPayload, requestId: string): PlayRequestsPayload {
  return {
    incoming: payload.incoming.filter((item) => item.id !== requestId),
    outgoing: payload.outgoing.filter((item) => item.id !== requestId),
  }
}

function upsertThread(
  threads: ThreadSummary[],
  peer: SocialUser,
  message: DirectMessage,
  unreadBoost = 0,
): ThreadSummary[] {
  const existing = threads.find((thread) => thread.peer.user_id === peer.user_id)
  const next: ThreadSummary = {
    peer,
    last_message: message,
    unread: Math.max(0, (existing?.unread ?? 0) + unreadBoost),
  }
  return [next, ...threads.filter((thread) => thread.peer.user_id !== peer.user_id)]
}

/** Do not yank a player out of a live arena or a finished-result screen. */
function inLiveMatch(): boolean {
  const path = window.location.pathname
  return path.includes('/arena') || path.includes('/result')
}

export function SocialProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const navigate = useNavigate()

  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [unreadTotal, setUnreadTotal] = useState(0)
  const [requests, setRequests] = useState<PlayRequestsPayload>(EMPTY_REQUESTS)
  const [presence, setPresence] = useState<Record<string, Presence>>({})
  const [chatOpen, setChatOpen] = useState(false)
  const [activePeer, setActivePeer] = useState<SocialUser | null>(null)
  const [messages, setMessages] = useState<DirectMessage[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [inviteTarget, setInviteTarget] = useState<SocialUser | null>(null)
  const [toasts, setToasts] = useState<SocialToast[]>([])

  const activePeerRef = useRef<SocialUser | null>(null)
  const chatOpenRef = useRef(false)
  const userRef = useRef(user)
  const toastSeqRef = useRef(0)
  const toastTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  userRef.current = user

  const selectPeer = useCallback((peer: SocialUser | null) => {
    activePeerRef.current = peer
    setActivePeer(peer)
  }, [])

  const setDrawerOpen = useCallback((open: boolean) => {
    chatOpenRef.current = open
    setChatOpen(open)
  }, [])

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      toastTimersRef.current.delete(id)
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id))
  }, [])

  const pushToast = useCallback(
    (toast: Omit<SocialToast, 'id'>) => {
      toastSeqRef.current += 1
      const id = toastSeqRef.current
      setToasts((prev) => [...prev.slice(-2), { ...toast, id }])
      const timer = setTimeout(() => dismissToast(id), toast.kind === 'error' ? 6000 : 8000)
      toastTimersRef.current.set(id, timer)
    },
    [dismissToast],
  )

  const presenceOf = useCallback(
    (userId?: string): Presence => {
      if (!userId) return { status: 'offline' }
      return presence[userId] ?? { status: 'offline' }
    },
    [presence],
  )

  const refresh = useCallback(async () => {
    if (!userRef.current) return
    try {
      const [threadPayload, requestPayload, presencePayload] = await Promise.all([
        fetchThreads(),
        fetchPlayRequests(),
        fetchPresence(),
      ])
      setThreads(threadPayload.threads)
      setUnreadTotal(threadPayload.unread_total)
      setRequests(requestPayload)
      setPresence(presencePayload.presence)
    } catch {
      // A transient network blip must not break the page; the poll retries.
    }
  }, [])

  // -------------------------------------------------------------------------
  // Socket: identity + live social events
  // -------------------------------------------------------------------------
  const accountKey = user?.username ?? ''

  useEffect(() => {
    if (!user) {
      setThreads([])
      setUnreadTotal(0)
      setRequests(EMPTY_REQUESTS)
      setPresence({})
      setMessages([])
      setDrawerOpen(false)
      selectPeer(null)
      setInviteTarget(null)
      return
    }

    const socket = connectSocket()
    const accountToken = getAccountToken()

    const onConnect = () => {
      const storedName = localStorage.getItem('hcl_display_name') || ''
      const sessionToken = localStorage.getItem('hcl_session') || ''
      socket.emit('player:register', {
        display_name: storedName || user.display_name,
        session_token: sessionToken || undefined,
        ...(accountToken ? { account_token: accountToken } : {}),
      })
      void refresh()
    }

    const onRegistered = (data: {
      success: boolean
      player_id?: string
      session_token?: string
      display_name?: string
    }) => {
      if (!data?.success) return
      if (data.session_token) {
        localStorage.setItem('hcl_session', data.session_token)
        sessionStorage.setItem('hcl_session_token', data.session_token)
      }
      if (data.player_id) localStorage.setItem('hcl_player_id', data.player_id)
      if (data.display_name) localStorage.setItem('hcl_display_name', data.display_name)
    }

    const onDirectMessage = (data: { peer?: SocialUser; message?: DirectMessage }) => {
      if (!data?.peer || !data?.message) return
      const peer = data.peer
      const message = data.message
      const isActive =
        chatOpenRef.current && activePeerRef.current?.user_id === peer.user_id

      if (isActive) {
        setMessages((prev) => mergeMessage(prev, message))
      }
      setThreads((prev) => upsertThread(prev, peer, message, isActive || message.mine ? 0 : 1))

      if (!message.mine) {
        if (isActive) {
          void markThreadRead(peer.user_id)
            .then((result) => {
              setUnreadTotal(result.unread_total)
              setThreads((prev) =>
                prev.map((thread) =>
                  thread.peer.user_id === peer.user_id ? { ...thread, unread: 0 } : thread,
                ),
              )
            })
            .catch(() => undefined)
        } else {
          setUnreadTotal((prev) => prev + 1)
          pushToast({ kind: 'dm', text: message.body, peer })
        }
      }
    }

    const onThreadRead = (data: { by?: string }) => {
      if (!data?.by || activePeerRef.current?.user_id !== data.by) return
      const stamp = new Date().toISOString()
      setMessages((prev) =>
        prev.map((message) =>
          message.mine && !message.read_at ? { ...message, read_at: stamp } : message,
        ),
      )
    }

    const onInvite = (data: { request?: PlayRequest; from?: SocialUser }) => {
      if (!data?.request) return
      setRequests((prev) => ({
        ...prev,
        incoming: upsertRequest(prev.incoming, data.request as PlayRequest),
      }))
      const name = data.from?.display_name || data.request.player?.display_name || 'A player'
      pushToast({ kind: 'invite', text: `${name} wants to play ${data.request.mode === 'TEAM' ? 'a team match' : 'a solo match'}.` })
    }

    const onAccepted = (payload: { request_id?: string; room_id?: string }) => {
      if (payload?.request_id) {
        setRequests((prev) => dropRequest(prev, payload.request_id as string))
      }
      if (!payload?.room_id) return
      if (inLiveMatch()) {
        pushToast({
          kind: 'info',
          text: 'Your match room is ready. Finish this game, then open the room from Messages.',
          roomId: payload.room_id,
        })
        return
      }
      setDrawerOpen(false)
      navigate(`/room/${payload.room_id}`)
    }

    const onDeclined = (data: { request_id?: string; player?: SocialUser }) => {
      if (data?.request_id) setRequests((prev) => dropRequest(prev, data.request_id as string))
      const name = data?.player?.display_name || 'the other player'
      pushToast({ kind: 'info', text: `${name} declined your invite.` })
    }

    const onCancelled = (data: { request_id?: string }) => {
      if (data?.request_id) setRequests((prev) => dropRequest(prev, data.request_id as string))
      pushToast({ kind: 'info', text: 'That play invite was cancelled.' })
    }

    const onExpired = (data: { request_id?: string }) => {
      if (data?.request_id) setRequests((prev) => dropRequest(prev, data.request_id as string))
      pushToast({ kind: 'info', text: 'A play invite expired.' })
    }

    socket.on('connect', onConnect)
    socket.on('player:registered', onRegistered)
    socket.on('dm:message', onDirectMessage)
    socket.on('dm:read', onThreadRead)
    socket.on('play:invite', onInvite)
    socket.on('play:accepted', onAccepted)
    socket.on('play:declined', onDeclined)
    socket.on('play:cancelled', onCancelled)
    socket.on('play:expired', onExpired)

    if (socket.connected) onConnect()
    void refresh()

    const wake = () => {
      if (document.visibilityState === 'hidden') return
      void refresh()
      if (socket.connected) onConnect()
      else connectSocket()
    }
    window.addEventListener('pageshow', wake)
    document.addEventListener('visibilitychange', wake)

    const poll = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void refresh()
    }, 45000)

    return () => {
      clearInterval(poll)
      window.removeEventListener('pageshow', wake)
      document.removeEventListener('visibilitychange', wake)
      socket.off('connect', onConnect)
      socket.off('player:registered', onRegistered)
      socket.off('dm:message', onDirectMessage)
      socket.off('dm:read', onThreadRead)
      socket.off('play:invite', onInvite)
      socket.off('play:accepted', onAccepted)
      socket.off('play:declined', onDeclined)
      socket.off('play:cancelled', onCancelled)
      socket.off('play:expired', onExpired)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey])

  useEffect(
    () => () => {
      toastTimersRef.current.forEach((timer) => clearTimeout(timer))
      toastTimersRef.current.clear()
    },
    [],
  )

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const openInbox = useCallback(() => {
    setDrawerOpen(true)
    selectPeer(null)
    void refresh()
  }, [refresh, selectPeer, setDrawerOpen])

  const closeInbox = useCallback(() => setDrawerOpen(false), [setDrawerOpen])

  const showInbox = useCallback(() => {
    selectPeer(null)
    setDrawerOpen(true)
  }, [selectPeer, setDrawerOpen])

  const openChat = useCallback(
    async (identifier: string) => {
      setDrawerOpen(true)
      setChatLoading(true)
      try {
        const payload = await fetchThread(identifier)
        selectPeer(payload.peer)
        setMessages(payload.messages)

        const existing = threads.find((thread) => thread.peer.user_id === payload.peer.user_id)
        setThreads((prev) => {
          if (!existing) return prev
          return [
            { ...existing, peer: payload.peer },
            ...prev.filter((thread) => thread.peer.user_id !== payload.peer.user_id),
          ]
        })

        const read = await markThreadRead(payload.peer.user_id)
        setUnreadTotal(read.unread_total)
        setThreads((prev) =>
          prev.map((thread) =>
            thread.peer.user_id === payload.peer.user_id ? { ...thread, unread: 0 } : thread,
          ),
        )
      } catch (error) {
        pushToast({ kind: 'error', text: accountErrorMessage(error, 'Could not open this chat.') })
        if (!activePeerRef.current) setDrawerOpen(false)
      } finally {
        setChatLoading(false)
      }
    },
    [pushToast, selectPeer, setDrawerOpen, threads],
  )

  const sendMessage = useCallback(
    async (text: string) => {
      const peer = activePeerRef.current
      if (!peer) return
      setSending(true)
      try {
        const payload = await sendDirectMessage(peer.user_id, text)
        setMessages((prev) => mergeMessage(prev, payload.message))
        setThreads((prev) => upsertThread(prev, payload.peer, payload.message))
      } catch (error) {
        pushToast({ kind: 'error', text: accountErrorMessage(error, 'Message not sent.') })
        throw error
      } finally {
        setSending(false)
      }
    },
    [pushToast],
  )

  const invitePlayer = useCallback((player: SocialUser) => setInviteTarget(player), [])
  const closeInvite = useCallback(() => setInviteTarget(null), [])

  const sendInvite = useCallback(
    async (settings: InviteSettings) => {
      const target = inviteTarget
      if (!target) throw new Error('pick_player')
      const result = await createPlayRequest({
        identifier: target.user_id,
        mode: settings.mode,
        overs: settings.overs,
        wickets: settings.wickets,
      })
      setRequests((prev) => ({
        ...prev,
        outgoing: upsertRequest(prev.outgoing, result.request),
      }))
      setInviteTarget(null)
      pushToast({
        kind: 'info',
        text: result.already_sent
          ? `You already invited ${target.display_name}.`
          : `Invite sent to ${target.display_name}.`,
      })
      return result
    },
    [inviteTarget, pushToast],
  )

  const acceptInvite = useCallback(
    async (requestId: string) => {
      const result = await acceptPlayRequest(requestId)
      setRequests((prev) => dropRequest(prev, requestId))
      if (result.room?.room_id && !inLiveMatch()) {
        setDrawerOpen(false)
        navigate(`/room/${result.room.room_id}`)
      }
    },
    [navigate, setDrawerOpen],
  )

  const declineInvite = useCallback(async (requestId: string) => {
    await declinePlayRequest(requestId)
    setRequests((prev) => dropRequest(prev, requestId))
  }, [])

  const cancelInvite = useCallback(async (requestId: string) => {
    await cancelPlayRequest(requestId)
    setRequests((prev) => dropRequest(prev, requestId))
  }, [])

  const value = useMemo<SocialContextValue>(
    () => ({
      threads,
      unreadTotal,
      requests,
      presence,
      chatOpen,
      activePeer,
      messages,
      chatLoading,
      sending,
      inviteTarget,
      toasts,
      presenceOf,
      openInbox,
      closeInbox,
      openChat,
      showInbox,
      sendMessage,
      invitePlayer,
      closeInvite,
      sendInvite,
      acceptInvite,
      declineInvite,
      cancelInvite,
      dismissToast,
      refresh,
    }),
    [
      threads,
      unreadTotal,
      requests,
      presence,
      chatOpen,
      activePeer,
      messages,
      chatLoading,
      sending,
      inviteTarget,
      toasts,
      presenceOf,
      openInbox,
      closeInbox,
      openChat,
      showInbox,
      sendMessage,
      invitePlayer,
      closeInvite,
      sendInvite,
      acceptInvite,
      declineInvite,
      cancelInvite,
      dismissToast,
      refresh,
    ],
  )

  return <SocialContext.Provider value={value}>{children}</SocialContext.Provider>
}

export function useSocial(): SocialContextValue {
  const context = useContext(SocialContext)
  if (!context) throw new Error('useSocial must be used inside SocialProvider')
  return context
}
