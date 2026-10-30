/**
 * Social world API client: discovery, presence, direct messages and play
 * requests. Every call rides on the same account bearer session as the rest
 * of the account API.
 */

import { accountRequest, type Presence, type PublicProfile } from './accounts'

export interface SocialUser {
  user_id: string
  username: string
  display_name: string
  avatar: string
  friend_code: string
  presence: Presence
}

export interface SocialPlayer extends PublicProfile {
  user_id: string
  presence: Presence
}

export interface DirectMessage {
  id: string
  sender_id: string
  recipient_id: string
  body: string
  created_at: string
  read_at?: string | null
  mine: boolean
}

export interface ThreadSummary {
  peer: SocialUser
  last_message: DirectMessage
  unread: number
}

export interface ThreadsPayload {
  threads: ThreadSummary[]
  unread_total: number
}

export interface ThreadPayload {
  peer: SocialUser
  messages: DirectMessage[]
  unread: number
}

export type PlayRequestStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED'

export interface PlayRequest {
  id: string
  mode: 'SOLO' | 'TEAM'
  overs: number
  wickets: number
  status: PlayRequestStatus
  room_id?: string | null
  join_code?: string | null
  created_at: string
  direction: 'incoming' | 'outgoing'
  player: SocialUser
}

export interface PlayRequestsPayload {
  incoming: PlayRequest[]
  outgoing: PlayRequest[]
}

export interface AcceptedRoom {
  request_id: string
  room_id: string
  join_code: string
  mode: 'SOLO' | 'TEAM'
  overs: number
  wickets: number
}

export function searchSocialPlayers(query: string): Promise<{ results: SocialPlayer[] }> {
  return accountRequest(`/social/search?q=${encodeURIComponent(query)}`)
}

export function fetchPresence(): Promise<{ presence: Record<string, Presence> }> {
  return accountRequest('/social/presence')
}

export function fetchThreads(): Promise<ThreadsPayload> {
  return accountRequest('/social/threads')
}

export function fetchThread(identifier: string, limit = 80): Promise<ThreadPayload> {
  return accountRequest(
    `/social/threads/${encodeURIComponent(identifier)}?limit=${encodeURIComponent(String(limit))}`,
  )
}

export function sendDirectMessage(identifier: string, text: string): Promise<{
  message: DirectMessage
  peer: SocialUser
}> {
  return accountRequest(`/social/threads/${encodeURIComponent(identifier)}`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

export function markThreadRead(identifier: string): Promise<{ ok: boolean; unread_total: number }> {
  return accountRequest(`/social/threads/${encodeURIComponent(identifier)}/read`, {
    method: 'POST',
  })
}

export function fetchPlayRequests(): Promise<PlayRequestsPayload> {
  return accountRequest('/social/play-requests')
}

export function createPlayRequest(input: {
  identifier: string
  mode: 'SOLO' | 'TEAM'
  overs: number
  wickets: number
}): Promise<{ request: PlayRequest; already_sent: boolean }> {
  return accountRequest('/social/play-requests', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function acceptPlayRequest(requestId: string): Promise<{
  status: 'accepted'
  room: AcceptedRoom
  request: PlayRequest
}> {
  return accountRequest(`/social/play-requests/${encodeURIComponent(requestId)}/accept`, {
    method: 'POST',
  })
}

export function declinePlayRequest(requestId: string): Promise<{ status: 'declined' }> {
  return accountRequest(`/social/play-requests/${encodeURIComponent(requestId)}/decline`, {
    method: 'POST',
  })
}

export function cancelPlayRequest(requestId: string): Promise<{ request: PlayRequest }> {
  return accountRequest(`/social/play-requests/${encodeURIComponent(requestId)}/cancel`, {
    method: 'POST',
  })
}

export const PRESENCE_LABELS: Record<Presence['status'], string> = {
  online: 'Online',
  in_lobby: 'In a lobby',
  in_match: 'Playing a match',
  spectating: 'Spectating',
  offline: 'Offline',
}

export function presenceTone(status: Presence['status']): 'success' | 'info' | 'warning' | 'danger' | 'muted' {
  switch (status) {
    case 'online':
      return 'success'
    case 'in_lobby':
      return 'info'
    case 'in_match':
      return 'danger'
    case 'spectating':
      return 'warning'
    default:
      return 'muted'
  }
}

/** Play requests expire server-side after 10 minutes; mirror that locally. */
export const PLAY_REQUEST_TTL_MS = 10 * 60 * 1000
