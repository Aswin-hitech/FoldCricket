/**
 * Creator Dashboard – interactive platform insights for the creator.
 *
 * Cross-filterable like a BI report: the mode donut slices the report, clicking
 * a day on a trend chart drills through to an hourly breakdown, and every
 * table can be sorted. Data comes from /api/creator/insights.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ThemeToggle } from '../../context/ThemeContext'
import {
  CreatorApiError,
  fetchCreatorInsights,
  loginCreator,
  type ActivityPoint,
  type CreatorFilters,
  type CreatorInsights,
  type CreatorMode,
  type HourlyPoint,
  type LiveRoom,
  type RecentMatch,
} from '../../services/creator'
import styles from './CreatorDashboardPage.module.css'

const TOKEN_STORAGE = 'hcl_creator_token'
const AUTO_STORAGE = 'hcl_creator_autorefresh'
const REFRESH_MS = 20000
const RANGES = [7, 14, 30] as const

type Gate = 'ok' | 'needs_login' | 'not_configured'
type Drill = { kind: 'day'; date: string } | { kind: 'match'; match: RecentMatch }

function asUtc(iso: string): Date {
  return new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`)
}

function formatWhen(iso: string): string {
  return asUtc(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })
}

function formatDay(iso: string): string {
  return asUtc(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function formatWeekday(iso: string): string {
  return asUtc(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
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

function matchDay(match: RecentMatch): string {
  return match.created_at.slice(0, 10)
}

function movingAverage(values: number[], window = 7): number[] {
  return values.map((_, index) => {
    const slice = values.slice(Math.max(0, index - window + 1), index + 1)
    return slice.reduce((sum, value) => sum + value, 0) / slice.length
  })
}

// ---------------------------------------------------------------------------
// Small reusable pieces
// ---------------------------------------------------------------------------

const Sparkline: React.FC<{ values: number[]; color: string }> = ({ values, color }) => {
  if (values.length < 2) return <span className={styles.sparkPlaceholder} />
  const max = Math.max(1, ...values)
  const step = 100 / (values.length - 1)
  const points = values
    .map((value, index) => `${(index * step).toFixed(2)},${(28 - (value / max) * 22).toFixed(2)}`)
    .join(' ')
  return (
    <svg
      className={styles.spark}
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polygon points={`0,30 ${points} 100,30`} fill={color} opacity="0.12" />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

const Delta: React.FC<{
  current: number
  previous: number
  invert?: boolean
  format?: 'pct' | 'pp'
}> = ({ current, previous, invert, format = 'pct' }) => {
  if (!previous) {
    if (!current) return <span className={styles.delta} data-tone="flat">–</span>
    return (
      <span className={styles.delta} data-tone="up" title="No activity in the previous period">
        new
      </span>
    )
  }
  const change =
    format === 'pp' ? (current - previous) * 100 : ((current - previous) / previous) * 100
  const flat = Math.abs(change) < 0.5
  const rising = change > 0
  const good = invert ? !rising : rising
  const tone = flat ? 'flat' : good ? 'up' : 'down'
  const label = `${rising ? '+' : ''}${change.toFixed(format === 'pp' ? 1 : 0)}${
    format === 'pp' ? 'pp' : '%'
  }`
  return (
    <span className={styles.delta} data-tone={tone} title={`${label} vs previous period`}>
      {flat ? '–' : `${rising ? '▲' : '▼'} ${Math.abs(change).toFixed(format === 'pp' ? 1 : 0)}${
        format === 'pp' ? 'pp' : '%'
      }`}
    </span>
  )
}

const KpiCard: React.FC<{
  label: string
  value: string
  hint: string
  accent?: string
  spark?: number[]
  delta?: React.ReactNode
}> = ({ label, value, hint, accent, spark, delta }) => (
  <div className={styles.kpi} style={accent ? { borderTopColor: accent } : undefined}>
    <div className={styles.kpiTop}>
      <span className={styles.kpiLabel}>{label}</span>
      {delta}
    </div>
    <span className={styles.kpiValue}>{value}</span>
    <span className={styles.kpiHint}>{hint}</span>
    {spark && accent ? <Sparkline values={spark} color={accent} /> : null}
  </div>
)

const TimeChart: React.FC<{
  points: ActivityPoint[]
  pick: (point: ActivityPoint) => number
  title: string
  unit: string
  accent: string
  selectedDate: string | null
  onSelectDate: (date: string) => void
}> = ({ points, pick, title, unit, accent, selectedDate, onSelectDate }) => {
  const [hover, setHover] = useState<number | null>(null)
  const values = points.map(pick)
  const max = Math.max(1, ...values)
  const total = values.reduce((sum, value) => sum + value, 0)
  const trend = movingAverage(values)
  const trendPoints = trend
    .map((value, index) => {
      const x = points.length === 1 ? 50 : ((index + 0.5) / points.length) * 100
      const y = 97 - (value / max) * 92
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')

  return (
    <div className={`${styles.card} ${styles.chart}`}>
      <div className={styles.chartHeader}>
        <div>
          <h3 className={styles.cardTitle}>{title}</h3>
          <p className={styles.cardSub}>
            {total.toLocaleString()} {unit} · click a bar to drill through
          </p>
        </div>
        <span className={styles.chartPeak}>peak {max.toLocaleString()}</span>
      </div>
      <div
        className={styles.chartPlot}
        role="group"
        aria-label={`${unit} per day`}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 1, 2, 3].map(line => (
          <span key={line} className={styles.gridLine} style={{ top: `${line * 33.3}%` }} />
        ))}
        <div className={styles.bars}>
          {points.map((point, index) => {
            const value = values[index]
            const height = value ? Math.max(4, (value / max) * 100) : 1.5
            const isSelected = selectedDate === point.date
            const isDimmed = Boolean(selectedDate && !isSelected)
            return (
              <button
                key={point.date}
                type="button"
                className={styles.barSlot}
                data-selected={isSelected ? 'true' : undefined}
                data-dimmed={isDimmed ? 'true' : undefined}
                aria-pressed={isSelected}
                aria-label={`${formatDay(point.date)}: ${value.toLocaleString()} ${unit}`}
                onClick={() => onSelectDate(point.date)}
                onMouseEnter={() => setHover(index)}
                onFocus={() => setHover(index)}
                onBlur={() => setHover(null)}
              >
                <span
                  className={styles.bar}
                  data-zero={value === 0 ? 'true' : undefined}
                  style={value ? { height: `${height}%`, background: accent } : { height: `${height}%` }}
                />
                {hover === index && (
                  <span className={styles.tooltip} role="tooltip">
                    <strong>{formatWeekday(point.date)}</strong>
                    <span>
                      <em>Matches</em>
                      <b>{point.matches.toLocaleString()}</b>
                    </span>
                    <span>
                      <em>Deliveries</em>
                      <b>{point.deliveries.toLocaleString()}</b>
                    </span>
                    <span>
                      <em>Runs</em>
                      <b>{point.runs.toLocaleString()}</b>
                    </span>
                    <span>
                      <em>New players</em>
                      <b>{point.new_players.toLocaleString()}</b>
                    </span>
                    <span>
                      <em>Batters</em>
                      <b>{point.batters.toLocaleString()}</b>
                    </span>
                  </span>
                )}
              </button>
            )
          })}
        </div>
        {points.length > 1 && (
          <svg
            className={styles.trend}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <polyline
              points={trendPoints}
              fill="none"
              stroke={accent}
              strokeWidth="1.5"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>
      <div className={styles.axis}>
        <span>{points.length ? formatDay(points[0].date) : ''}</span>
        <span>{points.length ? formatDay(points[Math.floor(points.length / 2)].date) : ''}</span>
        <span>{points.length ? formatDay(points[points.length - 1].date) : ''}</span>
      </div>
      <p className={styles.chartFoot}>Dashed line · 7-day moving average</p>
    </div>
  )
}

const ModeDonut: React.FC<{
  solo: number
  team: number
  mode: CreatorMode | null
  onSelectMode: (mode: CreatorMode | null) => void
}> = ({ solo, team, mode, onSelectMode }) => {
  const total = solo + team
  const radius = 42
  const circumference = 2 * Math.PI * radius
  const soloShare = total ? solo / total : 0
  const teamShare = total ? team / total : 0

  const toggle = (next: CreatorMode) => onSelectMode(mode === next ? null : next)

  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>Match modes</h3>
      <p className={styles.cardSub}>
        {mode ? `Filtered to ${mode.toLowerCase()} · click again to reset` : 'Click a slice to cross-filter'}
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
                strokeWidth={mode === 'SOLO' ? 16 : 13}
                strokeLinecap="round"
                strokeDasharray={`${circumference * soloShare} ${circumference}`}
                transform="rotate(-90 55 55)"
                className={styles.donutSlice}
                data-dimmed={mode === 'TEAM' ? 'true' : undefined}
                onClick={() => toggle('SOLO')}
              >
                <title>{`Solo: ${solo} matches`}</title>
              </circle>
              <circle
                cx="55"
                cy="55"
                r={radius}
                fill="none"
                stroke="var(--color-team-b)"
                strokeWidth={mode === 'TEAM' ? 16 : 13}
                strokeLinecap="round"
                strokeDasharray={`${circumference * teamShare} ${circumference}`}
                transform={`rotate(${-90 + soloShare * 360} 55 55)`}
                className={styles.donutSlice}
                data-dimmed={mode === 'SOLO' ? 'true' : undefined}
                onClick={() => toggle('TEAM')}
              >
                <title>{`Team: ${team} matches`}</title>
              </circle>
            </>
          )}
          <text x="55" y="51" textAnchor="middle" className={styles.donutTotal}>
            {total.toLocaleString()}
          </text>
          <text x="55" y="66" textAnchor="middle" className={styles.donutCaption}>
            {mode ? `${mode} matches` : 'matches'}
          </text>
        </svg>
        <div className={styles.legend}>
          <button
            type="button"
            className={styles.legendRow}
            data-active={mode === 'SOLO' ? 'true' : undefined}
            aria-pressed={mode === 'SOLO'}
            onClick={() => toggle('SOLO')}
          >
            <span className={styles.swatch} data-color="a" />
            <span className={styles.legendLabel}>Solo (1v1)</span>
            <span className={styles.legendValue}>{solo.toLocaleString()}</span>
          </button>
          <button
            type="button"
            className={styles.legendRow}
            data-active={mode === 'TEAM' ? 'true' : undefined}
            aria-pressed={mode === 'TEAM'}
            onClick={() => toggle('TEAM')}
          >
            <span className={styles.swatch} data-color="b" />
            <span className={styles.legendLabel}>Team</span>
            <span className={styles.legendValue}>{team.toLocaleString()}</span>
          </button>
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
  const pickTotal = picks.reduce((sum, pick) => sum + pick.count, 0)
  const max = Math.max(1, ...picks.map(pick => pick.count))

  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>Batter picks</h3>
      <p className={styles.cardSub}>{pickTotal.toLocaleString()} scoring deliveries in range</p>
      <div className={styles.mixRows}>
        {picks.map(pick => {
          const share = pickTotal ? Math.round((pick.count / pickTotal) * 100) : 0
          return (
            <div key={pick.label} className={styles.mixRow} title={`${share}% of scoring deliveries`}>
              <span className={styles.mixLabel}>{pick.label}</span>
              <div className={styles.mixTrack}>
                <div className={styles.mixBar} style={{ width: `${(pick.count / max) * 100}%` }} />
              </div>
              <span className={styles.mixValue}>
                {pick.count.toLocaleString()} · {share}%
              </span>
            </div>
          )
        })}
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

const Leaderboard: React.FC<{
  batters: CreatorInsights['top_batters']
  bowlers: CreatorInsights['top_bowlers']
}> = ({ batters, bowlers }) => {
  const maxRuns = Math.max(1, ...batters.map(batter => batter.runs))
  const maxWickets = Math.max(1, ...bowlers.map(bowler => bowler.wickets))

  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>Standout players</h3>
      <p className={styles.cardSub}>Most deliveries faced and wickets taken</p>
      <div className={styles.leaderGrid}>
        <div>
          <h4 className={styles.leaderHeading}>🏏 Batters</h4>
          {batters.length === 0 ? (
            <p className={styles.empty}>No batting data yet.</p>
          ) : (
            batters.map((batter, index) => (
              <div key={`${batter.name}-${index}`} className={styles.leaderRow}>
                <span
                  className={styles.leaderFill}
                  style={{ width: `${(batter.runs / maxRuns) * 100}%` }}
                />
                <span className={styles.leaderRank}>{index + 1}</span>
                <span className={styles.leaderName}>{batter.name}</span>
                <span className={styles.leaderMeta}>
                  {batter.runs} runs · {batter.balls} balls
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
            bowlers.map((bowler, index) => (
              <div key={`${bowler.name}-${index}`} className={styles.leaderRow}>
                <span
                  className={styles.leaderFill}
                  style={{ width: `${(bowler.wickets / maxWickets) * 100}%` }}
                />
                <span className={styles.leaderRank}>{index + 1}</span>
                <span className={styles.leaderName}>{bowler.name}</span>
                <span className={styles.leaderMeta}>{bowler.wickets} wkts</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

const SortHeader: React.FC<{
  label: string
  active: boolean
  direction: 'asc' | 'desc'
  onClick: () => void
  className?: string
}> = ({ label, active, direction, onClick, className }) => (
  <th className={className} aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
    <button type="button" className={styles.sortBtn} data-active={active ? 'true' : undefined} onClick={onClick}>
      {label}
      <span className={styles.sortArrow}>{active ? (direction === 'asc' ? '▲' : '▼') : '↕'}</span>
    </button>
  </th>
)

type LiveSortKey = 'join_code' | 'mode' | 'status' | 'players' | 'score' | 'created_at'
type MatchSortKey = 'join_code' | 'mode' | 'result' | 'duration' | 'created_at'

function nextSort<K extends string>(
  current: { key: K; dir: 'asc' | 'desc' },
  key: K
): { key: K; dir: 'asc' | 'desc' } {
  return current.key === key
    ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: key === 'created_at' ? 'desc' : 'asc' }
}

const LiveRooms: React.FC<{ rooms: LiveRoom[] }> = ({ rooms }) => {
  const [sort, setSort] = useState<{ key: LiveSortKey; dir: 'asc' | 'desc' }>({
    key: 'created_at',
    dir: 'desc',
  })

  const sorted = useMemo(() => {
    const factor = sort.dir === 'asc' ? 1 : -1
    return [...rooms].sort((a, b) => {
      switch (sort.key) {
        case 'players':
          return (a.players - b.players) * factor
        case 'score':
          return (a.score ?? '').localeCompare(b.score ?? '') * factor
        case 'mode':
          return a.mode.localeCompare(b.mode) * factor
        case 'status':
          return a.status.localeCompare(b.status) * factor
        case 'join_code':
          return a.join_code.localeCompare(b.join_code) * factor
        default:
          return a.created_at.localeCompare(b.created_at) * factor
      }
    })
  }, [rooms, sort])

  return (
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
                <SortHeader
                  label="Room"
                  active={sort.key === 'join_code'}
                  direction={sort.dir}
                  onClick={() => setSort(current => nextSort(current, 'join_code'))}
                />
                <SortHeader
                  label="Mode"
                  active={sort.key === 'mode'}
                  direction={sort.dir}
                  onClick={() => setSort(current => nextSort(current, 'mode'))}
                />
                <SortHeader
                  label="Status"
                  active={sort.key === 'status'}
                  direction={sort.dir}
                  onClick={() => setSort(current => nextSort(current, 'status'))}
                />
                <SortHeader
                  label="Players"
                  active={sort.key === 'players'}
                  direction={sort.dir}
                  onClick={() => setSort(current => nextSort(current, 'players'))}
                />
                <SortHeader
                  label="Score"
                  active={sort.key === 'score'}
                  direction={sort.dir}
                  onClick={() => setSort(current => nextSort(current, 'score'))}
                  className={styles.colOptional}
                />
                <SortHeader
                  label="Opened"
                  active={sort.key === 'created_at'}
                  direction={sort.dir}
                  onClick={() => setSort(current => nextSort(current, 'created_at'))}
                  className={styles.colOptional}
                />
              </tr>
            </thead>
            <tbody>
              {sorted.map(room => (
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
}

const RecentMatches: React.FC<{ matches: RecentMatch[]; onOpen: (match: RecentMatch) => void }> = ({
  matches,
  onOpen,
}) => {
  const [sort, setSort] = useState<{ key: MatchSortKey; dir: 'asc' | 'desc' }>({
    key: 'created_at',
    dir: 'desc',
  })

  const sorted = useMemo(() => {
    const factor = sort.dir === 'asc' ? 1 : -1
    return [...matches].sort((a, b) => {
      switch (sort.key) {
        case 'duration':
          return ((a.duration_minutes ?? -1) - (b.duration_minutes ?? -1)) * factor
        case 'mode':
          return a.mode.localeCompare(b.mode) * factor
        case 'result':
          return winnerLabel(a).localeCompare(winnerLabel(b)) * factor
        case 'join_code':
          return a.join_code.localeCompare(b.join_code) * factor
        default:
          return a.created_at.localeCompare(b.created_at) * factor
      }
    })
  }, [matches, sort])

  return (
    <div className={styles.card}>
      <div className={styles.cardHeadRow}>
        <div>
          <h3 className={styles.cardTitle}>Recent matches</h3>
          <p className={styles.cardSub}>Click a row to inspect the fixture</p>
        </div>
      </div>
      {matches.length === 0 ? (
        <p className={styles.empty}>No matches have been played in this range.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <SortHeader
                  label="Room"
                  active={sort.key === 'join_code'}
                  direction={sort.dir}
                  onClick={() => setSort(current => nextSort(current, 'join_code'))}
                />
                <SortHeader
                  label="Mode"
                  active={sort.key === 'mode'}
                  direction={sort.dir}
                  onClick={() => setSort(current => nextSort(current, 'mode'))}
                />
                <th>Fixture</th>
                <SortHeader
                  label="Result"
                  active={sort.key === 'result'}
                  direction={sort.dir}
                  onClick={() => setSort(current => nextSort(current, 'result'))}
                />
                <SortHeader
                  label="Duration"
                  active={sort.key === 'duration'}
                  direction={sort.dir}
                  onClick={() => setSort(current => nextSort(current, 'duration'))}
                  className={styles.colOptional}
                />
                <SortHeader
                  label="Started"
                  active={sort.key === 'created_at'}
                  direction={sort.dir}
                  onClick={() => setSort(current => nextSort(current, 'created_at'))}
                  className={styles.colOptional}
                />
              </tr>
            </thead>
            <tbody>
              {sorted.map(match => (
                <tr
                  key={match.id}
                  className={styles.clickRow}
                  tabIndex={0}
                  onClick={() => onOpen(match)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onOpen(match)
                    }
                  }}
                >
                  <td className={styles.codeCell}>{match.join_code}</td>
                  <td>
                    <span className={styles.modeChip} data-mode={match.mode}>
                      {match.mode}
                    </span>
                  </td>
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
}

// ---------------------------------------------------------------------------
// Drill-through drawer
// ---------------------------------------------------------------------------

const HourlyBars: React.FC<{ points: HourlyPoint[] }> = ({ points }) => {
  const max = Math.max(1, ...points.map(point => point.deliveries))
  return (
    <div className={styles.hourly} role="img" aria-label="Deliveries per hour">
      {points.map(point => (
        <div
          key={point.hour}
          className={styles.hourSlot}
          title={`${formatHour(point.hour)} — ${point.deliveries} deliveries · ${point.matches} matches`}
        >
          <span
            className={styles.hourBar}
            data-zero={point.deliveries === 0 ? 'true' : undefined}
            style={{ height: point.deliveries ? `${Math.max(5, (point.deliveries / max) * 100)}%` : '2%' }}
          />
        </div>
      ))}
      <div className={styles.hourAxis}>
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  )
}

const Drilldown: React.FC<{
  drill: Drill
  data: CreatorInsights
  onClose: () => void
  onOpenMatch: (match: RecentMatch) => void
  onFocusDay: (date: string) => void
}> = ({ drill, data, onClose, onOpenMatch, onFocusDay }) => {
  const dayReady = drill.kind === 'day' ? data.filters.date === drill.date : true

  return (
    <div className={styles.drawerBackdrop} onClick={onClose} role="presentation">
      <aside
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label={drill.kind === 'day' ? 'Day drill-through' : 'Match detail'}
        onClick={event => event.stopPropagation()}
      >
        <header className={styles.drawerHeader}>
          <div>
            <span className={styles.drawerEyebrow}>Drill-through</span>
            <h2 className={styles.drawerTitle}>
              {drill.kind === 'day' ? formatWeekday(drill.date) : `${drill.match.team_a} vs ${drill.match.team_b}`}
            </h2>
            <p className={styles.drawerSub}>
              {drill.kind === 'day'
                ? 'Every panel below is scoped to this day.'
                : `Room ${drill.match.join_code} · ${drill.match.mode}`}
            </p>
          </div>
          <button type="button" className={styles.drawerClose} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {drill.kind === 'day' ? (
          !dayReady ? (
            <div className={styles.drawerLoading}>
              <span className={styles.spinner} />
              Loading {formatDay(drill.date)}…
            </div>
          ) : (
            <div className={styles.drawerBody}>
              <section className={styles.drawerKpis}>
                {[
                  { label: 'Matches', value: data.totals.matches },
                  { label: 'Completed', value: data.totals.completed_matches },
                  { label: 'Deliveries', value: data.totals.deliveries },
                  { label: 'Runs', value: data.totals.runs },
                  { label: 'Active players', value: data.totals.active_players },
                  { label: 'Dead balls', value: data.totals.dead_balls },
                ].map(item => (
                  <div key={item.label} className={styles.drawerStat}>
                    <span className={styles.drawerStatLabel}>{item.label}</span>
                    <span className={styles.drawerStatValue}>{item.value.toLocaleString()}</span>
                  </div>
                ))}
              </section>

              <section className={styles.drawerCard}>
                <div className={styles.cardHeadRow}>
                  <div>
                    <h3 className={styles.cardTitle}>Hourly rhythm</h3>
                    <p className={styles.cardSub}>Deliveries committed each hour (UTC)</p>
                  </div>
                </div>
                <HourlyBars points={data.hourly} />
              </section>

              <section className={styles.drawerCard}>
                <h3 className={styles.cardTitle}>Mode split</h3>
                <div className={styles.splitBar}>
                  <span
                    className={styles.splitSolo}
                    style={{
                      width: `${
                        data.totals.matches
                          ? (data.totals.solo_matches / data.totals.matches) * 100
                          : 0
                      }%`,
                    }}
                  />
                </div>
                <div className={styles.splitLegend}>
                  <span>
                    Solo <b>{data.totals.solo_matches.toLocaleString()}</b>
                  </span>
                  <span>
                    Team <b>{data.totals.team_matches.toLocaleString()}</b>
                  </span>
                </div>
              </section>

              <section className={styles.drawerCard}>
                <h3 className={styles.cardTitle}>Fixtures started</h3>
                {data.recent_matches.length === 0 ? (
                  <p className={styles.empty}>No matches started on this day.</p>
                ) : (
                  <div className={styles.drawerMatches}>
                    {data.recent_matches.map(match => (
                      <button
                        key={match.id}
                        type="button"
                        className={styles.drawerMatch}
                        onClick={() => onOpenMatch(match)}
                      >
                        <span className={styles.codeCell}>{match.join_code}</span>
                        <span className={styles.drawerMatchFixture}>
                          {match.team_a} {match.team_a_score}
                          <em>vs</em>
                          {match.team_b} {match.team_b_score}
                        </span>
                        <span className={styles.drawerMatchResult}>{winnerLabel(match)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className={styles.drawerCard}>
                <h3 className={styles.cardTitle}>Top performers</h3>
                <div className={styles.leaderGrid}>
                  <div>
                    <h4 className={styles.leaderHeading}>🏏 Batters</h4>
                    {data.top_batters.length === 0 ? (
                      <p className={styles.empty}>No batting data.</p>
                    ) : (
                      data.top_batters.map((batter, index) => (
                        <div key={`${batter.name}-${index}`} className={styles.leaderRow}>
                          <span className={styles.leaderRank}>{index + 1}</span>
                          <span className={styles.leaderName}>{batter.name}</span>
                          <span className={styles.leaderMeta}>
                            {batter.runs} runs · {batter.balls} balls
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  <div>
                    <h4 className={styles.leaderHeading}>🎯 Bowlers</h4>
                    {data.top_bowlers.length === 0 ? (
                      <p className={styles.empty}>No wickets.</p>
                    ) : (
                      data.top_bowlers.map((bowler, index) => (
                        <div key={`${bowler.name}-${index}`} className={styles.leaderRow}>
                          <span className={styles.leaderRank}>{index + 1}</span>
                          <span className={styles.leaderName}>{bowler.name}</span>
                          <span className={styles.leaderMeta}>{bowler.wickets} wkts</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </section>
            </div>
          )
        ) : (
          <div className={styles.drawerBody}>
            <section className={styles.drawerCard}>
              <div className={styles.fixtureDetail}>
                <div className={styles.fixtureTeam}>
                  <span className={styles.fixtureTeamName}>{drill.match.team_a}</span>
                  <span className={styles.fixtureTeamScore}>{drill.match.team_a_score}</span>
                </div>
                <span className={styles.fixtureVs}>vs</span>
                <div className={styles.fixtureTeam}>
                  <span className={styles.fixtureTeamName}>{drill.match.team_b}</span>
                  <span className={styles.fixtureTeamScore}>{drill.match.team_b_score}</span>
                </div>
              </div>
              <p className={styles.fixtureResult}>{winnerLabel(drill.match)}</p>
              {drill.match.result_summary && (
                <p className={styles.fixtureSummary}>{drill.match.result_summary}</p>
              )}
            </section>

            <section className={styles.drawerKpis}>
              <div className={styles.drawerStat}>
                <span className={styles.drawerStatLabel}>Mode</span>
                <span className={styles.drawerStatValue}>{drill.match.mode}</span>
              </div>
              <div className={styles.drawerStat}>
                <span className={styles.drawerStatLabel}>Duration</span>
                <span className={styles.drawerStatValue}>
                  {drill.match.duration_minutes !== null ? `${drill.match.duration_minutes} min` : '—'}
                </span>
              </div>
              <div className={styles.drawerStat}>
                <span className={styles.drawerStatLabel}>Started</span>
                <span className={styles.drawerStatValue}>{formatWhen(drill.match.created_at)}</span>
              </div>
              <div className={styles.drawerStat}>
                <span className={styles.drawerStatLabel}>State</span>
                <span className={styles.drawerStatValue}>
                  {drill.match.completed ? 'Completed' : 'In progress'}
                </span>
              </div>
            </section>

            {data.activity.some(point => point.date === matchDay(drill.match)) && (
              <button
                type="button"
                className={styles.drillDayBtn}
                onClick={() => onFocusDay(matchDay(drill.match))}
              >
                Drill into {formatWeekday(matchDay(drill.match))} →
              </button>
            )}
          </div>
        )}
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CreatorDashboardPage() {
  const [days, setDays] = useState<number>(7)
  const [mode, setMode] = useState<CreatorMode | null>(null)
  const [date, setDate] = useState<string | null>(null)
  const [drill, setDrill] = useState<Drill | null>(null)
  const [data, setData] = useState<CreatorInsights | null>(null)
  const [gate, setGate] = useState<Gate>(() =>
    sessionStorage.getItem(TOKEN_STORAGE) ? 'ok' : 'needs_login'
  )
  const [usernameInput, setUsernameInput] = useState('')
  const [passwordInput, setPasswordInput] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [autoRefresh, setAutoRefresh] = useState<boolean>(
    () => localStorage.getItem(AUTO_STORAGE) !== 'off'
  )
  const seq = useRef(0)
  const tokenRef = useRef<string>(sessionStorage.getItem(TOKEN_STORAGE) || '')

  const load = useCallback(async (range: number, filters: CreatorFilters, token: string) => {
    if (!token) {
      setGate('needs_login')
      setLoading(false)
      return
    }
    const requestId = ++seq.current
    setLoading(true)
    try {
      const payload = await fetchCreatorInsights(range, token, filters)
      if (requestId !== seq.current) return
      setData(payload)
      setGate('ok')
      setError(null)
      setAuthError(null)
      setLastUpdated(new Date())
      // The server may drop filters it considers stale; stay in sync with it.
      setMode(current => (current === payload.filters.mode ? current : payload.filters.mode))
      setDate(current => (current === payload.filters.date ? current : payload.filters.date))
      setDrill(prev =>
        prev?.kind === 'day' && prev.date !== payload.filters.date ? null : prev
      )
    } catch (err) {
      if (requestId !== seq.current) return
      if (err instanceof CreatorApiError) {
        if (err.code === 'dashboard_not_configured') {
          setGate('not_configured')
        } else if (err.status === 401) {
          tokenRef.current = ''
          sessionStorage.removeItem(TOKEN_STORAGE)
          setGate('needs_login')
          setData(null)
          setDrill(null)
          if (token) setAuthError('Your session expired. Sign in again.')
        } else if (err.status === 429) {
          setError('Too many requests — wait a moment and retry.')
        } else {
          setError('The dashboard could not load. Retry in a moment.')
        }
      } else {
        setError('Cannot reach the server. Check the backend and retry.')
      }
    } finally {
      if (requestId === seq.current) setLoading(false)
    }
  }, [])

  const filters = useMemo<CreatorFilters>(() => ({ mode, date }), [mode, date])

  // Initial load and every cross-filter change.
  useEffect(() => {
    load(days, filters, tokenRef.current)
  }, [days, filters, load])

  // Auto-refresh while the tab is visible (toggleable).
  useEffect(() => {
    if (!autoRefresh) return
    const tick = () => {
      if (document.visibilityState === 'visible' && gate === 'ok') {
        load(days, filters, tokenRef.current)
      }
    }
    const interval = window.setInterval(tick, REFRESH_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && gate === 'ok') {
        load(days, filters, tokenRef.current)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [autoRefresh, days, filters, gate, load])

  useEffect(() => {
    if (!drill) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (drill.kind === 'day') setDate(null)
        setDrill(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drill])

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault()
    const username = usernameInput.trim()
    if (!username || !passwordInput) {
      setAuthError('Enter your username and password.')
      return
    }
    setSigningIn(true)
    setAuthError(null)
    try {
      const session = await loginCreator(username, passwordInput)
      tokenRef.current = session.token
      sessionStorage.setItem(TOKEN_STORAGE, session.token)
      setPasswordInput('')
      setGate('ok')
      await load(days, filters, session.token)
    } catch (err) {
      if (err instanceof CreatorApiError) {
        if (err.code === 'dashboard_not_configured') {
          setGate('not_configured')
        } else if (err.status === 401) {
          setAuthError('Invalid username or password.')
        } else if (err.status === 429) {
          setAuthError('Too many attempts. Wait a minute and retry.')
        } else {
          setAuthError('Sign in failed. Retry in a moment.')
        }
      } else {
        setAuthError('Cannot reach the server. Check the backend and retry.')
      }
    } finally {
      setSigningIn(false)
    }
  }

  const lock = () => {
    tokenRef.current = ''
    sessionStorage.removeItem(TOKEN_STORAGE)
    setGate('needs_login')
    setData(null)
    setDrill(null)
    setAuthError(null)
    setPasswordInput('')
  }

  const toggleAutoRefresh = () => {
    setAutoRefresh(current => {
      const next = !current
      localStorage.setItem(AUTO_STORAGE, next ? 'on' : 'off')
      return next
    })
  }

  const selectRange = (range: number) => {
    setDays(range)
    setDate(null)
    setDrill(prev => (prev?.kind === 'day' ? null : prev))
  }

  const selectDay = (day: string) => {
    if (date === day) {
      setDate(null)
      setDrill(prev => (prev?.kind === 'day' ? null : prev))
      return
    }
    setDate(day)
    setDrill({ kind: 'day', date: day })
  }

  const focusDay = (day: string) => {
    setDate(day)
    setDrill({ kind: 'day', date: day })
  }

  const clearDate = () => {
    setDate(null)
    setDrill(prev => (prev?.kind === 'day' ? null : prev))
  }

  const resetFilters = () => {
    setMode(null)
    setDate(null)
    setDrill(prev => (prev?.kind === 'day' ? null : prev))
  }

  const closeDrill = () => {
    if (drill?.kind === 'day') setDate(null)
    setDrill(null)
  }

  const totals = data?.totals
  const previous = data?.previous

  const kpis = useMemo(() => {
    if (!totals || !previous || !data) return []
    const activity = data.activity
    const spark = (pick: (point: ActivityPoint) => number) => activity.map(pick)
    const prevCompletion = previous.matches
      ? previous.completed_matches / previous.matches
      : 0
    const prevDeadRate = previous.deliveries ? previous.dead_balls / previous.deliveries : 0
    return [
      {
        label: 'Players',
        value: totals.players.toLocaleString(),
        hint: `${totals.new_players} new · ${totals.active_players} active`,
        accent: 'var(--color-info)',
        spark: spark(point => point.new_players),
        delta: <Delta current={totals.new_players} previous={previous.new_players} />,
      },
      {
        label: 'Active players',
        value: totals.active_players.toLocaleString(),
        hint: 'Faced at least one ball',
        accent: 'var(--color-team-a)',
        spark: spark(point => point.batters),
        delta: <Delta current={totals.active_players} previous={previous.active_players} />,
      },
      {
        label: 'Matches',
        value: totals.matches.toLocaleString(),
        hint: `${totals.completed_matches} completed · ${totals.live_matches} live`,
        accent: 'var(--color-team-b)',
        spark: spark(point => point.matches),
        delta: <Delta current={totals.matches} previous={previous.matches} />,
      },
      {
        label: 'Deliveries',
        value: totals.deliveries.toLocaleString(),
        hint: `${totals.runs.toLocaleString()} runs scored`,
        accent: 'var(--color-success)',
        spark: spark(point => point.deliveries),
        delta: <Delta current={totals.deliveries} previous={previous.deliveries} />,
      },
      {
        label: 'Runs',
        value: totals.runs.toLocaleString(),
        hint: 'Runs off the bat',
        accent: 'var(--color-warning)',
        spark: spark(point => point.runs),
        delta: <Delta current={totals.runs} previous={previous.runs} />,
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
        hint: `${totals.completed_matches}/${totals.matches} finished`,
        delta: (
          <Delta
            current={totals.completion_rate ?? 0}
            previous={prevCompletion}
            format="pp"
          />
        ),
      },
      {
        label: 'Dead-ball rate',
        value: percent(totals.dead_ball_rate),
        hint: `${totals.dead_balls} of ${totals.deliveries} balls`,
        accent: 'var(--color-warning)',
        spark: spark(point => point.dead_balls),
        delta: (
          <Delta
            current={totals.dead_ball_rate ?? 0}
            previous={prevDeadRate}
            invert
            format="pp"
          />
        ),
      },
    ]
  }, [totals, previous, data])

  const activeFilterCount = (mode ? 1 : 0) + (date ? 1 : 0)

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
                  onClick={() => selectRange(range)}
                >
                  {range}d
                </button>
              ))}
            </div>
            <button
              type="button"
              className={styles.autoBtn}
              data-on={autoRefresh ? 'true' : 'false'}
              aria-pressed={autoRefresh}
              onClick={toggleAutoRefresh}
              title="Toggle 20-second auto-refresh"
            >
              <span className={styles.autoDot} />
              Auto
            </button>
            <button
              type="button"
              className={styles.refreshBtn}
              onClick={() => load(days, filters, tokenRef.current)}
              disabled={loading}
            >
              ↻ Refresh
            </button>
            {tokenRef.current && (
              <button
                type="button"
                className={styles.lockBtn}
                onClick={lock}
                title="Sign out of the creator dashboard"
              >
                Sign out
              </button>
            )}
            <ThemeToggle />
          </div>
        </header>

        {gate === 'not_configured' && (
          <div className={styles.gateCard}>
            <h2>Dashboard not configured</h2>
            <p>
              Set <code>CREATOR_USERNAME</code> and <code>CREATOR_PASSWORD</code> in the backend
              environment and restart the server, then reload this page.
            </p>
          </div>
        )}

        {gate === 'needs_login' && (
          <form className={styles.gateCard} onSubmit={signIn}>
            <h2>Creator sign in</h2>
            <p>This dashboard is private. Sign in with the creator account to view insights.</p>
            <label className={styles.field}>
              <span>Username</span>
              <input
                className={styles.keyInput}
                name="username"
                autoComplete="username"
                value={usernameInput}
                onChange={event => setUsernameInput(event.target.value)}
                autoFocus
              />
            </label>
            <label className={styles.field}>
              <span>Password</span>
              <input
                className={styles.keyInput}
                name="password"
                type="password"
                autoComplete="current-password"
                value={passwordInput}
                onChange={event => setPasswordInput(event.target.value)}
              />
            </label>
            <button type="submit" className={styles.signInBtn} disabled={signingIn}>
              {signingIn ? 'Signing in…' : 'Sign in'}
            </button>
            {authError && <p className={styles.keyError}>{authError}</p>}
          </form>
        )}

        {gate === 'ok' && activeFilterCount > 0 && (
          <div className={styles.filterBar}>
            <span className={styles.filterLead}>Filters</span>
            {mode && (
              <button type="button" className={styles.filterChip} onClick={() => setMode(null)}>
                Mode · {mode}
                <span aria-hidden="true">✕</span>
              </button>
            )}
            {date && (
              <button type="button" className={styles.filterChip} onClick={clearDate}>
                Day · {formatDay(date)}
                <span aria-hidden="true">✕</span>
              </button>
            )}
            <button type="button" className={styles.filterReset} onClick={resetFilters}>
              Reset all
            </button>
          </div>
        )}

        {gate === 'ok' && error && (
          <div className={styles.errorBanner} role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => load(days, filters, tokenRef.current)}>
              Retry
            </button>
          </div>
        )}

        {gate === 'ok' && data && totals && previous && (
          <>
            <section className={styles.kpiGrid}>
              {kpis.map(kpi => (
                <KpiCard key={kpi.label} {...kpi} />
              ))}
            </section>

            <section className={styles.gridTwo}>
              <TimeChart
                points={data.activity}
                pick={point => point.matches}
                title="Matches per day"
                unit="matches"
                accent="var(--color-team-a)"
                selectedDate={date}
                onSelectDate={selectDay}
              />
              <TimeChart
                points={data.activity}
                pick={point => point.deliveries}
                title="Deliveries per day"
                unit="deliveries"
                accent="var(--color-team-b)"
                selectedDate={date}
                onSelectDate={selectDay}
              />
            </section>

            <section className={styles.gridThree}>
              <ModeDonut
                solo={totals.solo_matches}
                team={totals.team_matches}
                mode={mode}
                onSelectMode={setMode}
              />
              <DeliveryMix mix={data.delivery_mix} />
              <Leaderboard batters={data.top_batters} bowlers={data.top_bowlers} />
            </section>

            <section className={styles.gridOne}>
              <LiveRooms rooms={data.live} />
            </section>

            <section className={styles.gridOne}>
              <RecentMatches matches={data.recent_matches} onOpen={match => setDrill({ kind: 'match', match })} />
            </section>

            <p className={styles.footerNote}>
              {lastUpdated
                ? `Updated ${lastUpdated.toLocaleTimeString()} · ${
                    autoRefresh ? `auto-refresh every ${REFRESH_MS / 1000}s` : 'auto-refresh off'
                  }`
                : 'Waiting for the first sync…'}{' '}
              · All times UTC, range includes today{date ? ' · day drill-through active' : ''}.
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

      {gate === 'ok' && data && drill && (
        <Drilldown
          drill={drill}
          data={data}
          onClose={closeDrill}
          onOpenMatch={match => setDrill({ kind: 'match', match })}
          onFocusDay={focusDay}
        />
      )}
    </div>
  )
}
