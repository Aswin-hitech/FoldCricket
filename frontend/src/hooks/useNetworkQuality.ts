import { useEffect, useRef, useState } from 'react'

export interface NetworkQuality {
  /** Whether starting a video call is currently advisable. */
  allowed: boolean
  /** Human-readable explanation shown next to the camera control. */
  reason: string
  latency: number | null
  effectiveType: string | null
  downlinkMbps: number | null
}

interface ConnectionLike {
  effectiveType?: string
  downlink?: number
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
}

const GOOD_LATENCY_MS = 100
const BAD_LATENCY_MS = 160
const MIN_DOWNLINK_MBPS = 4

/**
 * Gates the beta video call on network quality. Uses the Network Information
 * API when the browser exposes it and always falls back to measured socket
 * round-trip time. Hysteresis (1 good sample to enable, 2 bad samples to
 * disable) keeps a single latency spike from killing an ongoing call.
 */
export function useNetworkQuality(pingLatency: number | null): NetworkQuality {
  const [effectiveType, setEffectiveType] = useState<string | null>(null)
  const [downlinkMbps, setDownlinkMbps] = useState<number | null>(null)
  const [allowed, setAllowed] = useState(false)
  const [reason, setReason] = useState('Measuring network quality…')

  const goodStreak = useRef(0)
  const badStreak = useRef(0)

  useEffect(() => {
    const conn = (navigator as Navigator & { connection?: ConnectionLike }).connection
    if (!conn) return

    const update = () => {
      setEffectiveType(conn.effectiveType || null)
      setDownlinkMbps(typeof conn.downlink === 'number' ? conn.downlink : null)
    }
    update()
    conn.addEventListener?.('change', update)
    return () => conn.removeEventListener?.('change', update)
  }, [])

  useEffect(() => {
    const evaluate = () => {
      const conn = (navigator as Navigator & { connection?: ConnectionLike }).connection
      const et = conn?.effectiveType
      const dl = typeof conn?.downlink === 'number' ? conn.downlink : undefined

      let sample: { ok: boolean; reason: string }
      if (!navigator.mediaDevices?.getUserMedia) {
        sample = { ok: false, reason: 'Video calls are not supported in this browser' }
      } else if (et === 'slow-2g' || et === '2g' || et === '3g') {
        sample = { ok: false, reason: `Network too slow for video (${et.toUpperCase()})` }
      } else if (et === '4g' && dl !== undefined && dl < MIN_DOWNLINK_MBPS) {
        sample = { ok: false, reason: `Low bandwidth for video (~${dl.toFixed(1)} Mbps)` }
      } else if (pingLatency !== null && pingLatency > BAD_LATENCY_MS) {
        sample = { ok: false, reason: `Connection too slow for video (${Math.round(pingLatency)} ms)` }
      } else if (pingLatency !== null && pingLatency > GOOD_LATENCY_MS) {
        sample = { ok: false, reason: `Marginal connection (${Math.round(pingLatency)} ms) — video may stutter` }
      } else if (pingLatency === null) {
        sample = { ok: false, reason: 'Measuring network quality…' }
      } else {
        sample = { ok: true, reason: `Good connection (${Math.round(pingLatency)} ms)` }
      }

      if (sample.ok) {
        goodStreak.current += 1
        badStreak.current = 0
        if (goodStreak.current >= 1) {
          setAllowed(true)
          setReason(sample.reason)
        }
      } else {
        badStreak.current += 1
        goodStreak.current = 0
        if (badStreak.current >= 2) {
          setAllowed(false)
          setReason(sample.reason)
        }
      }
    }

    evaluate()
    const id = window.setInterval(evaluate, 5000)
    return () => window.clearInterval(id)
  }, [pingLatency])

  return { allowed, reason, latency: pingLatency, effectiveType, downlinkMbps }
}
