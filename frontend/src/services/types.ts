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

export interface RoomInfo {
  id: string
  join_code: string
  mode: 'SOLO' | 'TEAM'
  status: string
  overs: number
  capacity: number
  rules_version: string
}

export interface MatchInfo {
  id: string
  phase: 'FIRST' | 'SECOND'
  overs: number
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
}

export interface DeliveryInfo {
  id: string
  batter_submitted: boolean
  bowler_submitted: boolean
  my_pick: number | null
}

export interface RoomSnapshot {
  room: RoomInfo
  members: MemberInfo[]
  match: MatchInfo | null
  current_delivery: DeliveryInfo | null
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
  result: 'RUNS' | 'OUT' | 'TIMEOUT'
  runs_scored: number
}
