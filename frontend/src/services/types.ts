/**
 * Global game state types.
 */

export interface PlayerInfo {
  id: string
  display_name: string
  connection_state: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING'
}

export interface MemberInfo {
  player: PlayerInfo
  team: 'A' | 'B' | null
  is_captain: boolean
  is_host: boolean
  role: 'BATTER' | 'BOWLER' | 'SPECTATOR'
  readiness: 'READY' | 'NOT_READY' | 'DISCONNECTED' | 'WAITING_FOR_BOWLER'
}

export interface TossInfo {
  state: 'CALLING' | 'FLIPPING' | 'DECIDING' | 'COMPLETED'
  caller_id: string
  caller_name: string
  caller_team: 'A' | 'B'
  called_choice: 'HEADS' | 'TAILS' | null
  coin_result: 'HEADS' | 'TAILS' | null
  winner_id: string | null
  winner_name: string | null
  winner_team: 'A' | 'B' | null
  elected_choice: 'BAT' | 'BOWL' | null
}

export interface RoomInfo {
  id: string
  join_code: string
  mode: 'SOLO' | 'TEAM'
  status: string
  overs: number
  wickets?: number
  max_wickets?: number
  capacity: number
  rules_version: string
  toss?: TossInfo | null
  team_a_name?: string
  team_b_name?: string
  is_paused?: boolean
}

export interface PausedInfo {
  paused: boolean
  reason?: 'player_disconnected' | 'manual_pause' | string
  player_id?: string
  player_name?: string
  grace_seconds?: number
}

export interface MatchInfo {
  id: string
  phase: 'FIRST' | 'SECOND'
  overs: number
  wickets?: number
  team_a_runs: number
  team_a_wickets: number
  team_b_runs: number
  team_b_wickets: number
  target: number | null
  current_over: number
  current_ball: number
  batting_team: 'A' | 'B'
  active_batter_id: string | null
  active_bowler_id: string | null
  delivery_deadline: string | null
  winner: string | null
  result_summary: string | null
  team_a_name?: string
  team_b_name?: string
}

export interface VoiceState {
  player_id: string
  player_name: string
  is_speaking: boolean
  is_muted: boolean
}

export interface DeliveryInfo {
  id: string
  batter_submitted: boolean
  bowler_submitted: boolean
  my_pick: number | null
}

export interface InningsBreakInfo {
  innings: 'SECOND'
  target: number
  first_batting_team: 'A' | 'B'
  first_innings_runs: number
  overs: number
}

export interface ResolvedDelivery {
  id?: string
  over: number
  ball: number
  result: 'RUNS' | 'OUT' | 'TIMEOUT' | 'DOT' | string
  runs_scored: number
  batter_pick?: number | null
  bowler_pick?: number | null
  batter_id?: string | null
  bowler_id?: string | null
  innings?: string
}

export interface RoomSnapshot {
  room: RoomInfo
  members: MemberInfo[]
  match: MatchInfo | null
  current_delivery: DeliveryInfo | null
  recent_deliveries?: ResolvedDelivery[]
}

export interface ChatMessage {
  player_id: string
  display_name: string
  text: string
  timestamp: string
}

export interface DeliveryReveal {
  id: string
  over: number
  ball: number
  batter_pick: number
  bowler_pick: number
  batter_id?: string
  bowler_id?: string
  result: 'RUNS' | 'OUT' | 'TIMEOUT'
  runs_scored: number
}
