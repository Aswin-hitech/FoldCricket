/**
 * Creator Dashboard – read-only platform insights for the creator.
 * Data comes from /api/creator/insights and refreshes automatically.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ThemeToggle } from '../../context/ThemeContext'
import {
  CreatorApiError,
  fetchCreatorInsights,
  type ActivityPoint,
  type CreatorInsights,
  type LiveRoom,
  type RecentMatch,
} from '../../services/creator'
import styles from './CreatorDashboardPage.module.css'

const KEY_STORAGE = 'hcl_creator_key'
const REFRESH_MS = 20000
const RANGES = [7, 14, 30] as const

type Gate = 'ok' | 'needs_key' | 'not_configured'

function asUtc(iso: string): Date {
  return new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`)
}

function formatWhen(iso: string): string {
  return asUtc(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDay(iso: string): string {
  return asUtc(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`
}

function humanStatus(status: string): string {
  return status.replace(/_/g, ' ').toLowerCase()
}

function winnerLabel(match: RecentMatch): string {
  if (match.winner === 'A') return match.team_a
  if (match.winner === 'B') return match.team_b
  if (match.winner === 'TIE') return 'Tie'
  return 'In progress'
}

const KpiCard: React.FC<{ label: string; value: string; hint: string; accent?: string }> = ({
  label,
  value,
  hint,
  accent,
}) => (
  <div className={styles.kpi} style={accent ? { borderTopColor: accent } : undefined}>
    <span className={styles.kpiLabel}>{label}</span>
    <span className={styles.kpiValue}>{value}</span>
    <span className={styles.kpiHint}>{hint}</span>
  </div>
)

const BarChart: React.FC<{
  points: ActivityPoint[]
  pick: (p: ActivityPoint) => number
  title: string
  unit: string
}> = ({ points, pick, title, unit }) => {
  const values = points.map(pick)
  const max = Math.max(1, ...values)
  const total = values.reduce((sum, v) => sum + v, 0)

  return (
    <div className={`${styles.card} ${styles.chart}`}>
      <div className={styles.chartHeader}>
        <div>
          <h3 className={styles.cardTitle}>{title}</h3>
          <p className={styles.cardSub}>
            {total.toLocaleString()} {unit} in the last {points.length} days
          </p>
        </div>
        <span className={styles.chartPeak}>peak {max.toLocaleString()}</span>
      </div>
      <div className={styles.chartPlot} role="img" aria-label={`${unit} per day`}>
        {[0, 1, 2, 3].map(line => (
          <span key={line} className={styles.gridLine} style={{ top: `${line * 33.3}%` }} />
        ))}
        <div className={styles.bars}>
          {points.map((point, i) => {
            const value = values[i]
            const height = value ? Math.max(4, (value / max) * 100) : 1.5
            return (
              <div
                key={point.date}
                className={styles.barSlot}
                title={`${formatDay(point.date)} — ${value.toLocaleString()} ${unit}`}
              >
                <div
                  className={styles.bar}
                  data-zero={value === 0 ? 'true' : undefined}
                  style={{ height: `${height}%` }}
                />
              </div>
            )
          })}
        </div>
      </div>
      <div className={styles.axis}>
        <span>{points.length ? formatDay(points[0].date) : ''}</span>
        <span>{points.length ? formatDay(points[Math.floor(points.length / 2)].date) : ''}</span>
        <span>{points.length ? formatDay(points[points.length - 1].date) : ''}</span>
      </div>
    </div>
  )
}

const ModeDonut: React.FC<{ solo: number; team: number }> = ({ solo, team }) => {
  const total = solo + team
  const radius = 42
  const circumference = 2 * Math.PI * radius
  const soloShare = total ? solo / total : 0
  const teamShare = total ? team / total : 0

  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>Match modes</h3>
      <p className={styles.cardSub}>
        {total ? `${total.toLocaleString()} matches in range` : 'No matches yet in this range'}
      </p>
      <div className={styles.donutWrap}>
        <svg viewBox="0 0 110 110" className={styles.donut} role="img" aria-label="Solo vs team matches">
          <circle cx="55" cy="55" r={radius} fill="none" stroke="var(--color-border)" strokeWidth="13" />
          {total > 0 && (
            <>
              <circle
                cx="55"
                cy="55"
                r={radius}
                fill="none"
                stroke="var(--color-team-a)"
                strokeWidth="13"
                strokeLinecap="round"
                strokeDasharray={`${circumference * soloShare} ${circumference}`}
                transform="rotate(-90 55 55)"
              />
              <circle
                cx="55"
                cy="55"
                r={radius}
                fill="none"
                stroke="var(--color-team-b)"
                strokeWidth="13"
                strokeLinecap="round"
                strokeDasharray={`${circumference * teamShare} ${circumference}`}
                transform={`rotate(${-90 + soloShare * 360} 55 55)`}
              />
            </>
          )}
          <text x="55" y="51" textAnchor="middle" className={styles.donutTotal}>
            {total.toLocaleString()}
          </text>
          <text x="55" y="66" textAnchor="middle" className={styles.donutCaption}>
            matches
          </text>
        </svg>
        <div className={styles.legend}>
          <div className={styles.legendRow}>
            <span className={styles.swatch} data-color="a" />
            <span className={styles.legendLabel}>Solo (1v1)</span>
            <span className={styles.legendValue}>{solo.toLocaleString()}</span>
          </div>
          <div className={styles.legendRow}>
            <span className={styles.swatch} data-color="b" />
            <span className={styles.legendLabel}>Team</span>
            <span className={styles.legendValue}>{team.toLocaleString()}</span>
          </div>
          <div className={styles.legendRow}>
            <span className={styles.swatch} data-color="muted" />
            <span className={styles.legendLabel}>Team share</span>
            <span className={styles.legendValue}>{percent(total ? teamShare : null)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

const DeliveryMix: React.FC<{ mix: Record<string, number> }> = ({ mix }) => {
  const picks = [1, 2, 3, 4, 5, 6].map(n => ({ label: String(n), count: mix[String(n)] ?? 0 }))
  const outs = mix.out ?? 0
  const dead = mix.dead ?? 0
  const pickTotal = picks.reduce((sum, p) => sum + p.count, 0)
  const max = Math.max(1, ...picks.map(p => p.count))

  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>Batter picks</h3>
      <p className={styles.cardSub}>{pickTotal.toLocaleString()} scoring deliveries in range</p>
      <div className={styles.mixRows}>
        {picks.map(p => (
          <div key={p.label} className={styles.mixRow}>
            <span className={styles.mixLabel}>{p.label}</span>
            <div className={styles.mixTrack}>
              <div className={styles.mixBar} style={{ width: `${(p.count / max) * 100}%` }} />
            </div>
            <span className={styles.mixValue}>{p.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
      <div className={styles.mixStats}>
        <div className={styles.mixStat}>
          <span className={styles.mixStatLabel}>Wickets</span>
          <span className={styles.mixStatValue}>{outs.toLocaleString()}</span>
        </div>
        <div className={styles.mixStat}>
          <span className={styles.mixStatLabel}>Dead balls</span>
          <span className={styles.mixStatValue}>{dead.toLocaleString()}</span>
        </div>
      </div>
    </div>
  )
}

const LiveRooms: React.FC<{ rooms: LiveRoom[] }> = ({ rooms }) => (
  <div className={styles.card}>
    <div className={styles.cardHeadRow}>
      <div>
        <h3 className={styles.cardTitle}>Live now</h3>
        <p className={styles.cardSub}>Open lobbies and matches on the server</p>
      </div>
      <span className={styles.liveBadge}>{rooms.length} active</span>
    </div>
    {rooms.length === 0 ? (
      <p className={styles.empty}>Nobody is in a room right now.</p>
    ) : (
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Room</th>
              <th>Mode</th>
              <th>Status</th>
              <th>Players</th>
              <th className={styles.colOptional}>Score</th>
              <th className={styles.colOptional}>Opened</th>
            </tr>
          </thead>
          <tbody>
            {rooms.map(room => (
              <tr key={room.id}>
                <td className={styles.codeCell}>{room.join_code}</td>
                <td>
                  <span className={styles.modeChip} data-mode={room.mode}>
                    {room.mode}
                  </span>
                </td>
                <td>
                  <span className={styles.statusPill} data-status={room.status}>
                    {humanStatus(room.status)}
                  </span>
                </td>
                <td>{room.players}</td>
                <td className={`${styles.mono} ${styles.colOptional}`}>{room.score ?? '—'}</td>
                <td className={`${styles.muted} ${styles.colOptional}`}>
                  {formatWhen(room.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
)

const RecentMatches: React.FC<{ matches: RecentMatch[] }> = ({ matches }) => (
  <div className={styles.card}>
    <div className={styles.cardHeadRow}>
      <div>
        <h3 className={styles.cardTitle}>Recent matches</h3>
        <p className={styles.cardSub}>Latest fixtures inside the selected range</p>
      </div>
    </div>
    {matches.length === 0 ? (
      <p className={styles.empty}>No matches have been played in this range.</p>
    ) : (
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Room</th>
              <th>Fixture</th>
              <th>Result</th>
              <th className={styles.colOptional}>Duration</th>
              <th className={styles.colOptional}>Started</th>
            </tr>
          </thead>
          <tbody>
            {matches.map(match => (
              <tr key={match.id}>
                <td className={styles.codeCell}>{match.join_code}</td>
                <td>
                  <div className={styles.fixture}>
                    <span>{match.team_a}</span>
                    <span className={styles.fixtureScore}>{match.team_a_score}</span>
                    <span className={styles.fixtureVs}>vs</span>
                    <span>{match.team_b}</span>
                    <span className={styles.fixtureScore}>{match.team_b_score}</span>
                  </div>
                </td>
                <td>
                  <span
                    className={styles.resultChip}
                    data-complete={match.completed ? 'true' : undefined}
                  >
                    {winnerLabel(match)}
                  </span>
                </td>
                <td className={styles.colOptional}>
                  {match.duration_minutes !== null ? `${match.duration_minutes} min` : '—'}
                </td>
                <td className={`${styles.muted} ${styles.colOptional}`}>
                  {formatWhen(match.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
)

const Leaderboard: React.FC<{
  batters: CreatorInsights['top_batters']
  bowlers: CreatorInsights['top_bowlers']
}> = ({ batters, bowlers }) => (
  <div className={styles.card}>
    <h3 className={styles.cardTitle}>Standout players</h3>
    <p className={styles.cardSub}>Most deliveries faced and wickets taken</p>
    <div className={styles.leaderGrid}>
      <div>
        <h4 className={styles.leaderHeading}>🏏 Batters</h4>
        {batters.length === 0 ? (
          <p className={styles.empty}>No batting data yet.</p>
        ) : (
          batters.map((b, i) => (
            <div key={`${b.name}-${i}`} className={styles.leaderRow}>
              <span className={styles.leaderRank}>{i + 1}</span>
              <span className={styles.leaderName}>{b.name}</span>
              <span className={styles.leaderMeta}>
                {b.runs} runs · {b.balls} balls
              </span>
            </div>
          ))
        )}
      </div>
      <div>
        <h4 className={styles.leaderHeading}>🎯 Bowlers</h4>
        {bowlers.length === 0 ? (
          <p className={styles.empty}>No wickets yet.</p>
        ) : (
          bowlers.map((b, i) => (
            <div key={`${b.name}-${i}`} className={styles.leaderRow}>
              <span className={styles.leaderRank}>{i + 1}</span>
              <span className={styles.leaderName}>{b.name}</span>
              <span className={styles.leaderMeta}>{b.wickets} wkts</span>
            </div>
          ))
        )}
      </div>
    </div>
  </div>
)

export default function CreatorDashboardPage() {
  const [days, setDays] = useState<number>(7)
  const [data, setData] = useState<CreatorInsights | null>(null)
  const [gate, setGate] = useState<Gate>('ok')
  const [keyInput, setKeyInput] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const inFlight = useRef(false)
  const keyRef = useRef<string>(sessionStorage.getItem(KEY_STORAGE) || '')

  const load = useCallback(
    async (value: number, key: string) => {
      if (inFlight.current) return
      inFlight.current = true
      setLoading(true)
      try {
        const payload = await fetchCreatorInsights(value, key)
        setData(payload)
        setGate('ok')
        setError(null)
        setKeyError(null)
        setLastUpdated(new Date())
      } catch (err) {
        if (err instanceof CreatorApiError) {
          if (err.code === 'dashboard_not_configured') {
            setGate('not_configured')
          } else if (err.status === 401) {
            setGate('needs_key')
            if (key) setKeyError('That creator key was not accepted.')
          } else if (err.status === 429) {
            setError('Too many requests — wait a moment and retry.')
          } else {
            setError('The dashboard could not load. Retry in a moment.')
          }
        } else {
          setError('Cannot reach the server. Check the backend and retry.')
        }
      } finally {
        inFlight.current = false
        setLoading(false)
      }
    },
    []
  )

  // Initial load + range change.
  useEffect(() => {
    load(days, keyRef.current)
  }, [days, load])

  // Auto-refresh while the tab is visible.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible' && gate === 'ok') {
        load(days, keyRef.current)
      }
    }
    const interval = window.setInterval(tick, REFRESH_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && gate === 'ok') load(days, keyRef.current)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [days, gate, load])

  const unlock = (event: React.FormEvent) => {
    event.preventDefault()
    const candidate = keyInput.trim()
    if (!candidate) {
      setKeyError('Enter the creator key.')
      return
    }
    keyRef.current = candidate
    sessionStorage.setItem(KEY_STORAGE, candidate)
    load(days, candidate)
  }

  const lock = () => {
    keyRef.current = ''
    sessionStorage.removeItem(KEY_STORAGE)
    setGate('needs_key')
    setData(null)
    setKeyError(null)
  }

  const totals = data?.totals
  const kpis = useMemo(() => {
    if (!totals) return []
    return [
      {
        label: 'Players',
        value: totals.players.toLocaleString(),
        hint: `${totals.new_players} new · ${totals.active_players} played`,
      },
      {
        label: 'Matches',
        value: totals.matches.toLocaleString(),
        hint: `${totals.completed_matches} completed · ${totals.live_matches} live`,
        accent: 'var(--color-team-a)',
      },
      {
        label: 'Live rooms',
        value: totals.live_rooms.toLocaleString(),
        hint: 'Open lobbies and matches',
        accent: 'var(--color-success)',
      },
      {
        label: 'Completion',
        value: percent(totals.completion_rate),
        hint: 'Started matches finished',
      },
      {
        label: 'Dead balls',
        value: percent(totals.dead_ball_rate),
        hint: `${totals.dead_balls} of ${totals.deliveries} deliveries`,
        accent: 'var(--color-warning)',
      },
      {
        label: 'Avg match',
        value: totals.avg_match_minutes !== null ? `${totals.avg_match_minutes} min` : '—',
        hint: 'First ball to finish',
      },
    ]
  }, [totals])

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <Link to="/" className={styles.brand} title="Back to FoldCricket">
            <img src="/logo.jpg" alt="" className={styles.logo} />
            <div className={styles.brandText}>
              <span className={styles.eyebrow}>FoldCricket · Creator</span>
              <h1 className={styles.title}>Platform Insights</h1>
            </div>
          </Link>

          <div className={styles.topbarActions}>
            {gate === 'ok' && (
              <span className={styles.connection} data-live={loading ? 'syncing' : 'live'}>
                <span className={styles.connectionDot} />
                {loading ? 'Syncing' : 'Live'}
              </span>
            )}
            <div className={styles.rangeGroup} role="group" aria-label="Date range">
              {RANGES.map(range => (
                <button
                  key={range}
                  type="button"
                  className={styles.rangeBtn}
                  data-active={days === range ? 'true' : undefined}
                  onClick={() => setDays(range)}
                >
                  {range}d
                </button>
              ))}
            </div>
            <button
              type="button"
              className={styles.refreshBtn}
              onClick={() => load(days, keyRef.current)}
              disabled={loading}
            >
              ↻ Refresh
            </button>
            {keyRef.current && (
              <button type="button" className={styles.lockBtn} onClick={lock} title="Forget creator key">
                🔒 Lock
              </button>
            )}
            <ThemeToggle />
          </div>
        </header>

        {gate === 'not_configured' && (
          <div className={styles.gateCard}>
            <h2>Dashboard not configured</h2>
            <p>
              Set <code>CREATOR_DASHBOARD_KEY</code> in the backend environment and restart the
              server, then reload this page and unlock it with that key.
            </p>
          </div>
        )}

        {gate === 'needs_key' && (
          <form className={styles.gateCard} onSubmit={unlock}>
            <h2>Creator access</h2>
            <p>Enter the creator key configured on the server to view platform insights.</p>
            <div className={styles.keyRow}>
              <input
                type="password"
                className={styles.keyInput}
                placeholder="Creator key"
                value={keyInput}
                onChange={event => setKeyInput(event.target.value)}
                autoFocus
              />
              <button type="submit" className="btn btn-primary" disabled={loading}>
                Unlock
              </button>
            </div>
            {keyError && <p className={styles.keyError}>{keyError}</p>}
          </form>
        )}

        {gate === 'ok' && error && (
          <div className={styles.errorBanner} role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => load(days, keyRef.current)}>
              Retry
            </button>
          </div>
        )}

        {gate === 'ok' && data && totals && (
          <>
            <section className={styles.kpiGrid}>
              {kpis.map(kpi => (
                <KpiCard key={kpi.label} {...kpi} />
              ))}
            </section>

            <section className={styles.gridTwo}>
              <BarChart
                points={data.activity}
                pick={p => p.matches}
                title="Matches per day"
                unit="matches"
              />
              <BarChart
                points={data.activity}
                pick={p => p.deliveries}
                title="Deliveries per day"
                unit="deliveries"
              />
            </section>

            <section className={styles.gridThree}>
              <ModeDonut solo={totals.solo_matches} team={totals.team_matches} />
              <DeliveryMix mix={data.delivery_mix} />
              <Leaderboard batters={data.top_batters} bowlers={data.top_bowlers} />
            </section>

            <section className={styles.gridOne}>
              <LiveRooms rooms={data.live} />
            </section>

            <section className={styles.gridOne}>
              <RecentMatches matches={data.recent_matches} />
            </section>

            <p className={styles.footerNote}>
              {lastUpdated
                ? `Updated ${lastUpdated.toLocaleTimeString()} · auto-refresh every ${REFRESH_MS / 1000}s`
                : 'Waiting for the first sync…'}{' '}
              · All times UTC, range includes today.
            </p>
          </>
        )}

        {gate === 'ok' && !totals && loading && (
          <div className={styles.loadingCard}>
            <span className={styles.spinner} />
            Loading platform insights…
          </div>
        )}
      </div>
    </div>
  )
}
