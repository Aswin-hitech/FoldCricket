/**
 * Creator dashboard API client.
 * Sign-in returns a short-lived bearer token; insights never carry the
 * creator password.
 */

const rawBackend = import.meta.env.VITE_BACKEND_URL || ''
const BACKEND_URL = rawBackend.trim().replace(/\/+$/, '')

export interface CreatorTotals {
  players: number
  new_players: number
  active_players: number
  rooms: number
  live_rooms: number
  matches: number
  completed_matches: number
  live_matches: number
  completion_rate: number | null
  solo_matches: number
  team_matches: number
  deliveries: number
  runs: number
  dead_balls: number
  dead_ball_rate: number | null
  avg_match_minutes: number | null
}

export interface ActivityPoint {
  date: string
  matches: number
  solo_matches: number
  team_matches: number
  new_players: number
  deliveries: number
  batters: number
  runs: number
  dead_balls: number
}

export interface HourlyPoint {
  hour: number
  deliveries: number
  matches: number
}

export interface PreviousTotals {
  matches: number
  completed_matches: number
  deliveries: number
  active_players: number
  runs: number
  new_players: number
  dead_balls: number
}

export type CreatorMode = 'SOLO' | 'TEAM'

export interface CreatorFilters {
  mode: CreatorMode | null
  date: string | null
}

export interface LiveRoom {
  id: string
  join_code: string
  mode: 'SOLO' | 'TEAM'
  status: string
  players: number
  overs: number
  created_at: string
  score: string | null
  team_a: string | null
  team_b: string | null
}

export interface RecentMatch {
  id: string
  join_code: string
  mode: 'SOLO' | 'TEAM'
  completed: boolean
  team_a: string
  team_b: string
  team_a_score: string
  team_b_score: string
  winner: 'A' | 'B' | 'TIE' | null
  result_summary: string | null
  created_at: string
  duration_minutes: number | null
}

export interface TopBatter {
  name: string
  balls: number
  runs: number
}

export interface TopBowler {
  name: string
  wickets: number
}

export interface CreatorInsights {
  days: number
  window_start: string
  filters: CreatorFilters
  totals: CreatorTotals
  previous: PreviousTotals
  activity: ActivityPoint[]
  hourly: HourlyPoint[]
  delivery_mix: Record<string, number>
  live: LiveRoom[]
  recent_matches: RecentMatch[]
  top_batters: TopBatter[]
  top_bowlers: TopBowler[]
}

export class CreatorApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string) {
    super(code)
    this.name = 'CreatorApiError'
    this.status = status
    this.code = code
  }
}

export interface CreatorSession {
  token: string
  expires_in: number
}

async function parseError(response: Response): Promise<CreatorApiError> {
  const payload = await response.json().catch(() => ({}))
  return new CreatorApiError(response.status, payload.error || `http_${response.status}`)
}

export async function loginCreator(
  username: string,
  password: string
): Promise<CreatorSession> {
  const response = await fetch(`${BACKEND_URL}/api/creator/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    cache: 'no-store',
  })

  if (!response.ok) throw await parseError(response)
  return (await response.json()) as CreatorSession
}

export async function fetchCreatorInsights(
  days: number,
  token: string,
  filters: Partial<CreatorFilters> = {}
): Promise<CreatorInsights> {
  const params = new URLSearchParams({ days: String(days) })
  if (filters.mode) params.set('mode', filters.mode)
  if (filters.date) params.set('date', filters.date)

  const response = await fetch(`${BACKEND_URL}/api/creator/insights?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    cache: 'no-store',
  })

  if (!response.ok) throw await parseError(response)
  return (await response.json()) as CreatorInsights
}
