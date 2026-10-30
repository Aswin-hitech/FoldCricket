/**
 * Creator dashboard API client.
 * The dashboard is read-only and gated by the server's CREATOR_DASHBOARD_KEY.
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
  new_players: number
  deliveries: number
  batters: number
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
  totals: CreatorTotals
  activity: ActivityPoint[]
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

export async function fetchCreatorInsights(days: number, key: string): Promise<CreatorInsights> {
  const response = await fetch(`${BACKEND_URL}/api/creator/insights?days=${days}`, {
    headers: key ? { 'X-Creator-Key': key } : {},
    cache: 'no-store',
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new CreatorApiError(response.status, payload.error || `http_${response.status}`)
  }

  return (await response.json()) as CreatorInsights
}
