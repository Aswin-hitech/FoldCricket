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

export interface HighestTeamScore {
  team: string
  runs: number
  wickets: number
  opponent: string
  join_code: string
  mode: CreatorMode
  played_at: string
}

export interface HighestTotal {
  team_a_name: string
  team_b_name: string
  team_a_runs: number
  team_a_wickets: number
  team_b_runs: number
  team_b_wickets: number
  total: number
  join_code: string
  mode: CreatorMode
  played_at: string
}

export interface MarginRecord {
  winner_name: string
  loser_name: string
  team_a_runs: number
  team_a_wickets: number
  team_b_runs: number
  team_b_wickets: number
  margin: number
  join_code: string
  mode: CreatorMode
  played_at: string
}

export interface CompletedGame {
  id: string
  join_code: string
  mode: CreatorMode
  team_a: string
  team_b: string
  team_a_score: string
  team_b_score: string
  winner: 'A' | 'B' | 'TIE' | null
  result_summary: string | null
  played_at: string
}

export interface LifetimeStats {
  games_started: number
  games_completed: number
  unfinished: number
  legacy_games: number
  in_progress: number
  ties: number
  solo_games: number
  team_games: number
  runs: number
  deliveries: number
  dead_balls: number
  avg_match_minutes: number | null
  first_game_at: string | null
  last_game_at: string | null
  highest_team_score: HighestTeamScore | null
  highest_total: HighestTotal | null
  biggest_win: MarginRecord | null
  closest_game: MarginRecord | null
  recent_completed: CompletedGame[]
}

export interface CommunityStats {
  accounts: number
  new_accounts_24h: number
  new_accounts_7d: number
  online_accounts: number
  friendships: number
  direct_messages: number
  achievements: number
  play_requests: number
}

export interface FeedbackCategory {
  name: string
  count: number
}

export interface FeedbackEntry {
  player_name: string
  rating: number | null
  feedback_text: string
  categories: string[]
  room_code: string | null
  created_at: string | null
}

export interface FeedbackSummary {
  total: number
  average_rating: number | null
  rating_distribution: Record<string, number>
  categories: FeedbackCategory[]
  recent: FeedbackEntry[]
  last_at: string | null
  sampled: boolean
}

export interface VisitAction {
  action: string
  count: number
}

export interface VisitActivityPoint {
  date: string
  visits: number
  visitors: number
}

export interface VisitStats {
  total_visits: number
  unique_visitors: number
  visits_today: number
  unique_today: number
  total_events: number
  actions: VisitAction[]
  activity: VisitActivityPoint[]
  first_visit_at: string | null
  last_visit_at: string | null
  days_covered: number
  truncated: boolean
}

export type AnalyticsSource = 'supabase' | 'unavailable' | 'not_configured'

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
  lifetime: LifetimeStats
  community: CommunityStats
  feedback: FeedbackSummary
  visits: VisitStats
  analytics_source: AnalyticsSource
  analytics_updated_at: string | null
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
