/**
 * Feedback service for submitting first-game player feedback reports
 * to Supabase Storage and Database via REST or backend proxy.
 */

export interface FeedbackReport {
  player_id: string
  player_name: string
  rating: number
  feedback_text: string
  categories: string[]
  room_code?: string | null
  metadata?: Record<string, unknown>
}

export async function submitFeedbackReport(report: FeedbackReport): Promise<boolean> {
  const backendUrl = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/$/, '')
  const endpoints = [
    '/api/feedback',
    backendUrl ? `${backendUrl}/api/feedback` : null,
  ].filter(Boolean) as string[]

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      })
      if (res.ok) {
        return true
      }
    } catch {
      // try next candidate endpoint
    }
  }

  return false
}
