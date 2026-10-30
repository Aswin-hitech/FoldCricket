import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  AccountApiError,
  clearAccountToken,
  clearGuestIdentity,
  fetchMe,
  getAccountToken,
  loginAccount,
  logoutAccount,
  registerAccount,
  setAccountToken,
  updateMyProfile,
  type Badge,
  type OwnerProfile,
  type ProfileUser,
  type UserStats,
} from '../services/accounts'
import { disconnectSocket } from '../services/socket'

interface AuthContextValue {
  /** True once the persisted session has been checked. */
  ready: boolean
  user: ProfileUser | null
  profile: OwnerProfile | null
  stats: UserStats | null
  achievements: Badge[]
  login: (username: string, password: string) => Promise<OwnerProfile>
  register: (input: {
    username: string
    display_name: string
    password: string
    avatar?: string
  }) => Promise<OwnerProfile>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  updateProfile: (input: {
    display_name?: string
    avatar?: string
    bio?: string
    default_mode?: string
    default_overs?: number
    default_wickets?: number
  }) => Promise<OwnerProfile>
  applyProfile: (profile: OwnerProfile) => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * A new login/logout starts a fresh anonymous game identity. The socket
 * singleton is torn down so it cannot keep restoring the previous player
 * token and mis-credit matches to the wrong account.
 */
function resetGameIdentity(): void {
  clearGuestIdentity()
  disconnectSocket()
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<OwnerProfile | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!getAccountToken()) {
      setReady(true)
      return
    }
    fetchMe()
      .then(result => {
        if (!cancelled) setProfile(result)
      })
      .catch(error => {
        if (error instanceof AccountApiError && error.status === 401) {
          clearAccountToken()
        }
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const applyProfile = useCallback((next: OwnerProfile) => setProfile(next), [])

  const login = useCallback(async (username: string, password: string) => {
    const result = await loginAccount(username, password)
    setAccountToken(result.token)
    resetGameIdentity()
    setProfile(result.profile)
    setReady(true)
    return result.profile
  }, [])

  const register = useCallback(
    async (input: { username: string; display_name: string; password: string; avatar?: string }) => {
      const result = await registerAccount(input)
      setAccountToken(result.token)
      resetGameIdentity()
      setProfile(result.profile)
      setReady(true)
      return result.profile
    },
    [],
  )

  const logout = useCallback(async () => {
    try {
      await logoutAccount()
    } catch {
      // An expired/offline session still has to be cleared locally.
    } finally {
      clearAccountToken()
      resetGameIdentity()
      setProfile(null)
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!getAccountToken()) {
      setProfile(null)
      return
    }
    try {
      setProfile(await fetchMe())
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 401) {
        clearAccountToken()
        setProfile(null)
      }
    }
  }, [])

  const updateProfile = useCallback(
    async (input: {
      display_name?: string
      avatar?: string
      bio?: string
      default_mode?: string
      default_overs?: number
      default_wickets?: number
    }) => {
      const result = await updateMyProfile(input)
      setProfile(result)
      return result
    },
    [],
  )

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      user: profile?.user ?? null,
      profile,
      stats: profile?.stats ?? null,
      achievements: profile?.achievements ?? [],
      login,
      register,
      logout,
      refresh,
      updateProfile,
      applyProfile,
    }),
    [ready, profile, login, register, logout, refresh, updateProfile, applyProfile],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider')
  }
  return context
}
