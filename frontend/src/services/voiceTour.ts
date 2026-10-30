/**
 * Per-player budget for the voice/mic introduction tour.
 * A player sees the tour for their first 5 TEAM matches and first 2 SOLO
 * matches; after that it never appears again.
 */

export type VoiceTourMode = 'TEAM' | 'SOLO'

export const VOICE_TOUR_LIMITS: Record<VoiceTourMode, number> = { TEAM: 5, SOLO: 2 }

interface VoiceTourState {
  counts: Record<VoiceTourMode, number>
  lastRoom: Partial<Record<VoiceTourMode, string>>
}

type VoiceTourStore = Record<string, VoiceTourState>

const STORAGE_KEY = 'hcl_voice_tour_v1'

function emptyState(): VoiceTourState {
  return { counts: { TEAM: 0, SOLO: 0 }, lastRoom: {} }
}

function readStore(): VoiceTourStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as VoiceTourStore) : {}
  } catch {
    return {}
  }
}

function writeStore(store: VoiceTourStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // A blocked storage just means the tour may run again; nothing to recover.
  }
}

/**
 * Reserves this room's tour slot for the player.
 * Returns true only the first time the player enters a countable lobby, so a
 * reload or a StrictMode double effect cannot spend two matches at once.
 */
export function claimVoiceTour(
  playerId: string,
  mode: VoiceTourMode,
  roomId: string
): boolean {
  if (!playerId || !roomId || (mode !== 'TEAM' && mode !== 'SOLO')) return false

  const store = readStore()
  const state = store[playerId] ?? emptyState()

  if (state.counts[mode] >= VOICE_TOUR_LIMITS[mode]) return false
  if (state.lastRoom[mode] === roomId) return false

  state.counts[mode] += 1
  state.lastRoom[mode] = roomId
  store[playerId] = state
  writeStore(store)
  return true
}
