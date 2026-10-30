/**
 * Player account API client (auth, profile, friends).
 * The bearer token is stored in localStorage so a signed-in player stays
 * signed in across reloads; the server stores only its SHA-256 hash.
 */

const rawBackend = import.meta.env.VITE_BACKEND_URL || ''
const BACKEND_URL = rawBackend.trim().replace(/\/+$/, '')

export const ACCOUNT_TOKEN_KEY = 'hcl_account_token'
const GUEST_KEYS = ['hcl_session', 'hcl_session_token', 'hcl_display_name', 'hcl_player_id']

/** Mirror of the server's avatar allow-list. */
export const ACCOUNT_AVATARS = [
  '🏏', '🏆', '⚡', '🔥', '🎯', '👑', '🦅', '🐯',
  '🦊', '🚀', '🧊', '🌟', '🎽', '🥇', '🫂', '✨',
] as const

const ERROR_MESSAGES: Record<string, string> = {
  network: 'Could not reach the server. Check your connection and try again.',
  rate_limited: 'Too many attempts. Please wait a moment and try again.',
  invalid_credentials: 'Incorrect username or password.',
  not_authenticated: 'Your session expired. Please sign in again.',
  username_taken: 'That username is already taken.',
  username_invalid: 'Username must be 3–20 letters, numbers or underscores.',
  password_too_short: 'Password must be at least 8 characters.',
  password_invalid: 'Choose a password with at least 8 characters.',
  password_unchanged: 'Choose a password different from your current one.',
  invalid_password: 'Current password is incorrect.',
  avatar_invalid: 'Pick one of the available avatars.',
  bio_too_long: 'Bio must be 160 characters or fewer.',
  user_not_found: 'No player found with that ID.',
  cannot_add_self: "That's your own friend code.",
  already_friends: 'You are already friends.',
  request_pending: 'Friend request already sent.',
  request_not_found: 'That request no longer exists.',
  request_not_pending: 'That request was already handled.',
  not_friends: 'You are not friends with that player.',
}

/** Human-readable message for an API failure. */
export function accountErrorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (error instanceof AccountApiError) {
    const mapped = ERROR_MESSAGES[error.code]
    if (mapped) return mapped
    if (error.message && error.message !== error.code) return error.message
  }
  return fallback
}

export class AccountApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message?: string) {
    super(message || code)
    this.name = 'AccountApiError'
    this.status = status
    this.code = code
  }
}

export interface Badge {
  code: string
  name: string
  description: string
  icon: string
  tier: 'bronze' | 'silver' | 'gold'
  metric: string
  threshold: number
  earned: boolean
  progress: number
  value: number
}

export interface UserStats {
  matches: number
  wins: number
  losses: number
  ties: number
  win_rate: number
  runs: number
  wickets: number
  wickets_lost: number
  balls_faced: number
  balls_bowled: number
  best_score: number
  super_overs: number
  super_over_wins: number
  team_matches: number
  dead_balls: number
  best_streak: number
  current_streak: number
  xp: number
  level: number
  xp_into_level: number
  xp_for_level: number
}

export interface ProfileUser {
  username: string
  display_name: string
  avatar: string
  friend_code: string
  level: number
  wins: number
  matches: number
  win_rate: number
  bio?: string
  default_mode?: 'SOLO' | 'TEAM'
  default_overs?: number
  default_wickets?: number
  profile_complete?: boolean
  created_at?: string
}

export interface RecentMatch {
  match_id: string
  mode: 'SOLO' | 'TEAM'
  team: string | null
  result: 'WIN' | 'LOSS' | 'TIE'
  opponent_name: string
  runs_scored: number
  wickets_taken: number
  wickets_lost: number
  super_over: boolean | number
  overs: number
  created_at: string
}

export interface OwnerProfile {
  user: ProfileUser
  stats: UserStats
  achievements: Badge[]
  recent_matches: RecentMatch[]
  friends_count: number
  incoming_requests: number
  new_achievements: string[]
}

export interface PublicProfile extends ProfileUser {
  relationship: 'self' | 'friend' | 'incoming' | 'outgoing' | 'none'
  is_friend: boolean
  is_self: boolean
  bio?: string
  stats?: UserStats
  achievements?: Badge[]
  recent_matches?: RecentMatch[]
  friends_count?: number
}

export interface FriendSummary {
  username: string
  display_name: string
  avatar: string
  friend_code: string
  level: number
  wins: number
  matches: number
  win_rate: number
  friendship_id?: string
  friends_since?: string
  requested_at?: string
}

export interface FriendsPayload {
  friends: FriendSummary[]
  incoming: FriendSummary[]
  outgoing: FriendSummary[]
  friends_count: number
  incoming_count: number
}

interface AuthResponse {
  token: string
  profile: OwnerProfile
}

export function getAccountToken(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem(ACCOUNT_TOKEN_KEY) || ''
}

export function setAccountToken(token: string): void {
  localStorage.setItem(ACCOUNT_TOKEN_KEY, token)
}

export function clearAccountToken(): void {
  localStorage.removeItem(ACCOUNT_TOKEN_KEY)
}

/** Logging in/out starts a fresh game identity so stats never leak across accounts. */
export function clearGuestIdentity(): void {
  for (const key of GUEST_KEYS) {
    localStorage.removeItem(key)
    sessionStorage.removeItem(key)
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccountToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  let response: Response
  try {
    response = await fetch(`${BACKEND_URL}/api${path}`, {
      ...init,
      headers,
      cache: 'no-store',
    })
  } catch {
    throw new AccountApiError(0, 'network', 'Could not reach the server.')
  }

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new AccountApiError(
      response.status,
      payload?.error || `http_${response.status}`,
      payload?.message,
    )
  }
  return payload as T
}

export function registerAccount(input: {
  username: string
  display_name: string
  password: string
  avatar?: string
}): Promise<AuthResponse> {
  return request<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function loginAccount(username: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export function logoutAccount(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/auth/logout', { method: 'POST' })
}

export function fetchMe(): Promise<OwnerProfile> {
  return request<OwnerProfile>('/auth/me')
}

export function changePassword(current_password: string, new_password: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/auth/password', {
    method: 'POST',
    body: JSON.stringify({ current_password, new_password }),
  })
}

export function updateMyProfile(input: {
  display_name?: string
  avatar?: string
  bio?: string
  default_mode?: string
  default_overs?: number
  default_wickets?: number
}): Promise<OwnerProfile> {
  return request<OwnerProfile>('/profile', {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function searchPlayers(query: string): Promise<{ results: PublicProfile[] }> {
  return request<{ results: PublicProfile[] }>(`/users/search?q=${encodeURIComponent(query)}`)
}

export function fetchPlayer(identifier: string): Promise<PublicProfile> {
  return request<PublicProfile>(`/users/${encodeURIComponent(identifier)}`)
}

export function fetchFriends(): Promise<FriendsPayload> {
  return request<FriendsPayload>('/friends')
}

export function sendFriendRequest(identifier: string): Promise<{
  status: 'pending' | 'accepted'
  request_id?: string
  friend?: PublicProfile
  profile: OwnerProfile
}> {
  return request('/friends/requests', {
    method: 'POST',
    body: JSON.stringify({ identifier }),
  })
}

export function acceptFriendRequest(requestId: string): Promise<{
  status: 'accepted'
  friend: PublicProfile | null
  new_achievements: string[]
  profile: OwnerProfile
}> {
  return request(`/friends/requests/${encodeURIComponent(requestId)}/accept`, { method: 'POST' })
}

export function declineFriendRequest(requestId: string): Promise<{ status: 'declined' }> {
  return request(`/friends/requests/${encodeURIComponent(requestId)}/decline`, { method: 'POST' })
}

export function removeFriend(identifier: string): Promise<{ status: 'removed' }> {
  return request(`/friends/${encodeURIComponent(identifier)}`, { method: 'DELETE' })
}

/** Presentational helpers shared by profile/friend screens. */
export function achievementTierLabel(tier: Badge['tier']): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1)
}

export function avatarHue(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 360
  }
  return hash
}
