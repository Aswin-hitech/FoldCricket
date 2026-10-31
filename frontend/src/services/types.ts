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
  /** True for watchers who joined without a team and never take part in play. */
  is_spectator?: boolean
  readiness: 'READY' | 'NOT_READY' | 'DISCONNECTED' | 'WAITING_FOR_BOWLER'
  voice_mode?: 'EVERYONE' | 'TEAM_ONLY' | 'SELECTED_PLAYERS' | 'MUTED'
  allowed_recipients?: string[]
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
  version?: number
  phase: 'FIRST' | 'SECOND' | 'SUPER_OVER_FIRST' | 'SUPER_OVER_SECOND'
  overs: number
  wickets?: number
  team_a_wicket_limit?: number
  team_b_wicket_limit?: number
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
  innings_break_deadline?: string | null
  break_seconds?: number
  winner: string | null
  result_summary: string | null
  first_batting_team?: string
  team_a_name?: string
  team_b_name?: string
  dismissed_batters_a?: string[]
  dismissed_batters_b?: string[]
  is_all_out?: boolean
  all_out_team?: 'A' | 'B' | string | null
  is_all_out_a?: boolean
  is_all_out_b?: boolean
  is_super_over?: boolean
  main_match_team_a_runs?: number | null
  main_match_team_b_runs?: number | null
  main_match_team_a_wickets?: number | null
  main_match_team_b_wickets?: number | null
}

export interface SuperOverInfo {
  message: string
  batting_team: string
  overs: number
  wickets: number
}

export interface AllOutInfo {
  team: string
  team_name: string
  runs: number
  wickets: number
  phase: string
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

/** Ack for `delivery:submit`, correlated to the ball the pick was aimed at. */
export interface DeliveryAck {
  success: boolean
  error?: string
  pick_received?: boolean
  over?: number | null
  ball?: number | null
  phase?: string | null
}

export interface InningsBreakInfo {
  innings: 'SECOND' | 'SUPER_OVER_SECOND' | string
  target: number
  first_batting_team: 'A' | 'B' | string
  first_batting_team_name?: string
  first_innings_runs: number
  chasing_team?: 'A' | 'B' | string
  chasing_team_name?: string
  overs: number
  break_seconds?: number
  break_deadline?: string | null
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
  timeout_reason?: string | null
}

export interface VoicePermissionEntry {
  sender_id: string
  receiver_id: string
  status: 'MUTUAL_ACCEPTED' | 'PENDING_REQUEST' | 'BLOCKED' | string
}

export interface CrossTeamVoiceRequest {
  room_id: string
  from_player_id: string
  from_player_name: string
  from_team: string
  to_player_id: string
}

export interface VideoCallInvite {
  room_id: string
  from_player_id: string
  from_player_name: string
  from_team?: string | null
  to_player_id: string
}

export interface VideoCallSession {
  peerId: string
  peerName: string
  state: 'ringing' | 'active'
  direction: 'outgoing' | 'incoming'
}

export interface RoomSnapshot {
  server_time?: string
  /** The player this snapshot was built for (the server's view of "you"). */
  self_player_id?: string | null
  room: RoomInfo
  members: MemberInfo[]
  match: MatchInfo | null
  current_delivery: DeliveryInfo | null
  recent_deliveries?: ResolvedDelivery[]
  voice_permissions?: VoicePermissionEntry[]
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
  timeout_reason?: string | null
}
