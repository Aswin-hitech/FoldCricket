/**
 * Arena Page – TV Broadcast-style match screen matching reference design.
 * Features:
 * - 3-column desktop layout (Batting Scorecard, 3D Stadium Pitch, Bowling Scorecard)
 * - Lower panels (Current Batsmen, Large Delivery Controls, Recent Balls & Match Info)
 * - Rock-solid live countdown timer with UTC sync
 * - Captain bowler selection after over completion with banner announcement
 * - Arena entry mic toast prompt
 * - Integrated Chat drawer, WebRTC VoiceChat, and VideoCallPanel
 * - Mobile responsive bottom navigation with Game, Chat, Teams, and Call tabs
 */

import React, { useEffect, useRef, useState, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useSocket } from '../../hooks/useSocket'
import { useNetworkQuality } from '../../hooks/useNetworkQuality'
import { ThemeToggle } from '../../context/ThemeContext'
import { sound } from '../../services/sound'
import { vibration } from '../../services/vibration'
import { HandGesture } from '../components/HandGesture'
import { NetworkIndicator } from '../components/NetworkIndicator'
import { VoiceChat } from '../components/VoiceChat'
import { voiceSession } from '../../services/voiceSession'
import { PitchAnimation } from '../components/PitchAnimation'
import { CelebrationEffects } from '../components/CelebrationEffects'
import { formatPlayerWithTeam, getTeamRoleLabel } from '../../utils/teamLabels'
import type { DeliveryReveal, MatchInfo, MemberInfo, ResolvedDelivery } from '../../services/types'
import styles from './ArenaPage.module.css'

export default function ArenaPage() {
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const sessionToken = localStorage.getItem('hcl_session') || undefined
  const myPlayerId = localStorage.getItem('hcl_player_id') || ''

  const {
    status,
    snapshot,
    chatMessages,
    lastReveal,
    inningsBreak,
    matchFinished,
    allOutInfo,
    superOverInfo,
    clearSuperOverInfo,
    pingLatency,
    voiceStates,
    pausedInfo,
    syncRoom,
    selectBowler,
    selectBatter,
    submitPick,
    pauseMatch,
    resumeMatch,
    sendChat,
    updateVoiceState,
    setVoiceMode,
    voiceSignals,
    sendVoiceSignal,
    crossTeamRequests,
    requestCrossTeamVoice,
    respondCrossTeamVoice,
    revokeCrossTeamVoice,
    incomingVideoCall,
    videoCallPeer,
    videoCallError,
    clearVideoCallError,
    requestVideoCall,
    respondVideoCall,
    endVideoCall,
    firstBallReady,
    firstBallAck,
    deliveryAck,
    serverNow,
  } = useSocket(sessionToken)

  const videoNetwork = useNetworkQuality(pingLatency)

  const [chatInput, setChatInput] = useState('')
  const [selectedPick, setSelectedPick] = useState<number | null>(null)
  const [pickSubmitted, setPickSubmitted] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const [revealAnimation, setRevealAnimation] = useState<DeliveryReveal | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [isMuted, setIsMuted] = useState(() => sound.isMuted())
  const [celebrationTrigger, setCelebrationTrigger] = useState<'SIX' | 'FOUR' | 'WICKET' | 'WIN' | null>(null)
  const [copiedRoomId, setCopiedRoomId] = useState(false)

  // Drawer / modal states
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [showBowlerModal, setShowBowlerModal] = useState(false)
  const [showBatterModal, setShowBatterModal] = useState(false)
  const [allOutAnnouncement, setAllOutAnnouncement] = useState<{
    teamName: string
    runs: number
    wickets: number
    phase: string
  } | null>(null)
  const [superOverAnnouncement, setSuperOverAnnouncement] = useState<{
    message: string
  } | null>(null)
  const [showQuitModal, setShowQuitModal] = useState(false)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const shownSuperOverMatchesRef = useRef<Set<string>>(new Set())
  const shownAllOutRef = useRef<Set<string>>(new Set())
  const [showInningsBreakBanner, setShowInningsBreakBanner] = useState(false)
  const [breakCountdown, setBreakCountdown] = useState<number>(10)
  const [activeMobileTab, setActiveMobileTab] = useState<'game' | 'chat' | 'teams'>('game')
  const [isVoiceListOpen, setIsVoiceListOpen] = useState(false)

  // Entry pop-up mic prompt. The voice session survives the lobby → arena
  // transition, so the nudge is pointless (and confusing) once the mic is live.
  const [showMicPrompt, setShowMicPrompt] = useState(() => {
    if (voiceSession.roomId === roomId && voiceSession.micEnabled && !voiceSession.isMuted) {
      return false
    }
    try {
      return !sessionStorage.getItem(`hcl_mic_prompt_${roomId}`)
    } catch {
      return true
    }
  })

  const countdownRef = useRef<NodeJS.Timeout | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)

  const match: MatchInfo | null = snapshot?.match ?? null
  const members: MemberInfo[] = snapshot?.members ?? []
  const recentDeliveries: ResolvedDelivery[] = snapshot?.recent_deliveries ?? []
  const myMembership = members.find(m => m.player.id === myPlayerId)
  const isActiveBatter = match?.active_batter_id === myPlayerId
  const isActiveBowler = match?.active_bowler_id === myPlayerId
  const isActivePlayer = isActiveBatter || isActiveBowler
  const isHost = myMembership?.is_host ?? false
  const isCaptain = myMembership?.is_captain ?? false
  const isPaused = snapshot?.room?.status === 'PAUSED' || snapshot?.room?.is_paused || (pausedInfo?.paused ?? false)
  const isTeamMatch = snapshot?.room?.mode === 'TEAM'

  // Arena entry gate: no delivery starts until every connected player
  // explicitly confirms they are ready for the first ball.
  const awaitingFirstBall = snapshot?.room?.status === 'AWAITING_FIRST_BALL'
  const myFirstBallReady = myMembership?.readiness === 'READY'
  const connectedMembers = members.filter(m => m.player.connection_state === 'CONNECTED')
  const allConnected = members.length > 0 && connectedMembers.length === members.length
  const readyCount = members.filter(m => m.readiness === 'READY').length

  const bowlingTeam = match?.batting_team === 'A' ? 'B' : 'A'
  const bowlingMembers = members.filter(m => m.team === bowlingTeam)
  const bowlingCaptain = bowlingMembers.find(m => m.is_captain) || bowlingMembers.find(m => m.is_host) || bowlingMembers[0]

  const battingTeam = match?.batting_team || 'A'
  const battingMembers = members.filter(m => m.team === battingTeam)
  const battingCaptain = battingMembers.find(m => m.is_captain) || battingMembers.find(m => m.is_host) || battingMembers[0]
  const isBattingCaptain = (isCaptain || isHost) && myMembership?.team === battingTeam

  const dismissedBatters = battingTeam === 'A' ? (match?.dismissed_batters_a || []) : (match?.dismissed_batters_b || [])
  const eligibleBatters = battingMembers.filter(m => !dismissedBatters.includes(m.player.id))

  const isCurrentInningsAllOut = Boolean(
    match?.is_all_out && (match?.all_out_team === match?.batting_team || !match?.all_out_team)
  )
  const isAllOut = isCurrentInningsAllOut

  const needsBatterSelect = Boolean(
    match &&
    !match.active_batter_id &&
    !match.winner &&
    !isAllOut &&
    eligibleBatters.length > 0 &&
    battingMembers.length > 1
  )

  // Innings Break state & server-authoritative countdown synchronization
  const isInningsBreak =
    snapshot?.room?.status === 'INNINGS_BREAK' ||
    Boolean(
      inningsBreak &&
        !match?.winner &&
        match?.phase === 'SECOND' &&
        match?.current_over === 0 &&
        match?.current_ball === 0 &&
        snapshot?.room?.status !== 'INNINGS_ACTIVE'
    )

  // Detect over complete state
  const isOverComplete = Boolean(
    match &&
    !match.active_bowler_id &&
    !match.winner &&
    !isAllOut &&
    !isInningsBreak &&
    ((match.current_ball === 0 && match.current_over > 0) ||
     (match.phase === 'SECOND' && match.current_over === 0 && match.current_ball === 0 && !isInningsBreak))
  )

  // SOLO matches auto-assign the bowler server-side, so the captain prompt only
  // applies to TEAM mode and must not appear while the innings break is running.
  const needsBowlerSelect = Boolean(
    match &&
    isTeamMatch &&
    !match.active_bowler_id &&
    !match.winner &&
    !isAllOut &&
    !isInningsBreak &&
    (isCaptain || isHost) &&
    myMembership?.team === bowlingTeam
  )

  // Handle ALL OUT declaration - 5 second transition, STRICTLY ONCE per team per match
  useEffect(() => {
    const matchId = match?.id || 'm'
    if (allOutInfo) {
      const key = `${matchId}_${allOutInfo.team}`
      if (!shownAllOutRef.current.has(key)) {
        shownAllOutRef.current.add(key)
        setAllOutAnnouncement({
          teamName: allOutInfo.team_name,
          runs: allOutInfo.runs,
          wickets: allOutInfo.wickets,
          phase: allOutInfo.phase,
        })
        sound.playOut()
        vibration.wicket()
        setCelebrationTrigger('WICKET')
      }
    } else if (match?.is_all_out && match?.all_out_team) {
      const key = `${matchId}_${match.all_out_team}`
      if (!shownAllOutRef.current.has(key)) {
        shownAllOutRef.current.add(key)
        setAllOutAnnouncement({
          teamName: match.all_out_team === 'A' ? (match.team_a_name || 'Team A') : (match.team_b_name || 'Team B'),
          runs: match.all_out_team === 'A' ? match.team_a_runs : match.team_b_runs,
          wickets: match.all_out_team === 'A' ? match.team_a_wickets : match.team_b_wickets,
          phase: match.phase || 'FIRST',
        })
        sound.playOut()
        vibration.wicket()
        setCelebrationTrigger('WICKET')
      }
    }
  }, [allOutInfo, match?.is_all_out, match?.all_out_team, match?.id, match?.team_a_name, match?.team_b_name, match?.team_a_runs, match?.team_b_runs, match?.team_a_wickets, match?.team_b_wickets, match?.phase])

  // Auto-dismiss the ALL OUT declaration after 5 seconds. Kept separate from the
  // trigger effect above so unrelated snapshot updates cannot cancel the timer.
  useEffect(() => {
    if (!allOutAnnouncement) return
    const timer = setTimeout(() => setAllOutAnnouncement(null), 5000)
    return () => clearTimeout(timer)
  }, [allOutAnnouncement])

  // Handle MATCH TIED: ENTERING SUPER OVER - exact 5 second payload display (strictly once per match)
  useEffect(() => {
    const isSuperOverStarting =
      Boolean(superOverInfo) ||
      Boolean(match?.is_super_over && match?.phase === 'SUPER_OVER_FIRST')

    const matchId = match?.id || 'so_match'
    if (!shownSuperOverMatchesRef.current.has(matchId) && isSuperOverStarting) {
      shownSuperOverMatchesRef.current.add(matchId)
      clearSuperOverInfo()
      setSuperOverAnnouncement({
        message: 'MATCH TIED: ENTERING SUPER OVER',
      })
      sound.playOut()
      vibration.wicket()
      setCelebrationTrigger('WICKET')
    }
  }, [superOverInfo, match?.is_super_over, match?.phase, match?.id, clearSuperOverInfo])

  // Auto-dismiss the super-over declaration after 5 seconds (separate effect so
  // the clearSuperOverInfo() call above cannot cancel its own timer).
  useEffect(() => {
    if (!superOverAnnouncement) return
    const timer = setTimeout(() => setSuperOverAnnouncement(null), 5000)
    return () => clearTimeout(timer)
  }, [superOverAnnouncement])

  // "Are you sure you want to quit?" warning on browser navigation / tab close
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (match && !match.winner) {
        e.preventDefault()
        e.returnValue = 'Are you sure you want to quit? Your match progress will be lost.'
        return e.returnValue
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [match])

  // Sync room on mount
  useEffect(() => {
    if (roomId) {
      syncRoom(roomId)
    }
  }, [roomId, syncRoom, status])

  // Handle match finished redirect - 2 second transition
  useEffect(() => {
    if (matchFinished) {
      sound.playWin()
      vibration.win()
      setCelebrationTrigger('WIN')
      const popperTimer = setTimeout(() => setCelebrationTrigger(null), 2000)
      const timer = setTimeout(() => navigate(`/room/${roomId}/result`), 2000)
      return () => {
        clearTimeout(popperTimer)
        clearTimeout(timer)
      }
    }
  }, [matchFinished, navigate, roomId])

  // Handle delivery reveal sound & vibration - 2s popup animation & 2s party popper
  useEffect(() => {
    if (lastReveal) {
      setRevealAnimation(lastReveal)
      setPickSubmitted(false)
      setSelectedPick(null)

      if (lastReveal.result === 'OUT') {
        sound.playOut()
        vibration.wicket()
        setCelebrationTrigger('WICKET')
      } else if (lastReveal.runs_scored === 6) {
        sound.playSix()
        vibration.six()
        setCelebrationTrigger('SIX')
      } else if (lastReveal.runs_scored === 4) {
        sound.playFour()
        vibration.four()
        setCelebrationTrigger('FOUR')
      } else {
        sound.playRuns(lastReveal.runs_scored)
      }

      // Party popper effect strictly for 2 seconds
      const popperTimer = setTimeout(() => setCelebrationTrigger(null), 2000)
      // Reveal popup outcome animation holds for 2 seconds
      const timer = setTimeout(() => setRevealAnimation(null), 2000)
      return () => {
        clearTimeout(popperTimer)
        clearTimeout(timer)
      }
    }
  }, [lastReveal])

  // Fixed Live Countdown Timer: Syncs UTC deadline cleanly across all timezones
  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current)
    if (!match?.delivery_deadline || !match?.active_bowler_id || isPaused) {
      setCountdown(null)
      return
    }

    const tick = () => {
      let deadlineStr = match.delivery_deadline!
      if (!deadlineStr.endsWith('Z') && !deadlineStr.includes('+')) {
        deadlineStr += 'Z'
      }
      const deadline = new Date(deadlineStr).getTime()
      const remaining = Math.max(0, Math.ceil((deadline - serverNow()) / 1000))
      setCountdown(remaining)
      if (remaining <= 5 && remaining > 0) {
        sound.playTick()
      }
      if (remaining <= 0 && countdownRef.current) {
        clearInterval(countdownRef.current)
      }
    }

    tick()
    countdownRef.current = setInterval(tick, 250)
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [match?.delivery_deadline, match?.active_bowler_id, isPaused, serverNow])

  // Scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, isChatOpen])

  // Auto-dismiss mic prompt after 7 seconds
  useEffect(() => {
    if (showMicPrompt) {
      const timer = setTimeout(() => {
        setShowMicPrompt(false)
        try {
          sessionStorage.setItem(`hcl_mic_prompt_${roomId}`, '1')
        } catch {}
      }, 7000)
      return () => clearTimeout(timer)
    }
  }, [showMicPrompt, roomId])

  // Nothing to prompt for while the mic is already live.
  useEffect(() => {
    const micLive =
      voiceStates[myPlayerId]?.is_muted === false ||
      (voiceSession.roomId === roomId && voiceSession.micEnabled && !voiceSession.isMuted)
    if (micLive) setShowMicPrompt(false)
  }, [voiceStates, myPlayerId, roomId])

  useEffect(() => {
    const deadlineStr = match?.innings_break_deadline || inningsBreak?.break_deadline
    if (isInningsBreak || deadlineStr) {
      setPickSubmitted(false)
      setSelectedPick(null)
      const updateRemaining = () => {
        if (deadlineStr) {
          const ms = new Date(deadlineStr).getTime() - serverNow()
          const secs = Math.max(0, Math.ceil(ms / 1000))
          setBreakCountdown(secs)
        } else {
          setBreakCountdown(prev => Math.max(0, prev - 1))
        }
      }
      updateRemaining()
      const timer = setInterval(updateRemaining, 1000)
      return () => clearInterval(timer)
    } else {
      setBreakCountdown(10)
    }
  }, [isInningsBreak, match?.innings_break_deadline, inningsBreak?.break_deadline, serverNow])

  const dismissMicPrompt = () => {
    setShowMicPrompt(false)
    try {
      sessionStorage.setItem(`hcl_mic_prompt_${roomId}`, '1')
    } catch {}
  }

  // Handle pick select
  function handlePickSelect(pick: number) {
    if (pickSubmitted || !isActivePlayer || isInningsBreak || awaitingFirstBall || match?.winner) return
    sound.playClick()
    vibration.tap()
    setSelectedPick(pick)
  }

  // Handle pick submit
  function handlePickSubmit() {
    if (selectedPick === null || pickSubmitted || !roomId || isInningsBreak || awaitingFirstBall || match?.winner) return
    sound.playClick()
    vibration.tap()
    submitPick(roomId, selectedPick)
    setPickSubmitted(true)
  }

  // Arena entry gate: confirm readiness for the first ball
  function handleFirstBallReady() {
    if (!roomId || myFirstBallReady || !allConnected) return
    sound.playClick()
    vibration.tap()
    firstBallReady(roomId)
  }

  // Handle send chat
  function handleSendChat(e: React.FormEvent) {
    e.preventDefault()
    const text = chatInput.trim()
    if (!text || !roomId) return
    sound.playClick()
    sendChat(roomId, text)
    setChatInput('')
  }

  // Handle bowler selection
  function handleBowlerSelect(bowlerId: string) {
    if (!roomId) return
    sound.playClick()
    selectBowler(roomId, bowlerId)
    setShowBowlerModal(false)
  }

  // Handle captain batter selection
  function handleBatterSelect(batterId: string) {
    if (!roomId) return
    sound.playClick()
    selectBatter(roomId, batterId)
    setShowBatterModal(false)
  }

  // Copy Room Code
  function handleCopyRoomId() {
    if (!roomId) return
    sound.playClick()
    navigator.clipboard.writeText(roomId).then(() => {
      setCopiedRoomId(true)
      setTimeout(() => setCopiedRoomId(false), 2000)
    }).catch(() => {})
  }

  // Master Sound on/off toggle (controls both game effects and remote voice audio)
  function handleToggleSound() {
    const nextMuted = sound.toggleMute()
    setIsMuted(nextMuted)
    if (!nextMuted) {
      sound.playCoinLand()
    }
  }

  const currentDelivery = snapshot?.current_delivery

  // Server rejected the pick (deadline passed / already submitted): unlock the
  // keypad instead of leaving the player stuck on "Pick Locked".
  useEffect(() => {
    if (!deliveryAck) return
    if (deliveryAck.success) {
      setPickError(null)
      return
    }
    setPickSubmitted(false)
    setSelectedPick(null)
    setPickError(deliveryAck.error || 'pick_rejected')
    const timer = setTimeout(() => setPickError(null), 3500)
    return () => clearTimeout(timer)
  }, [deliveryAck])

  // Unlock keypad on new ball
  useEffect(() => {
    if (isActiveBatter) {
      if (!currentDelivery || !currentDelivery.batter_submitted) {
        setPickSubmitted(false)
      }
    } else if (isActiveBowler) {
      if (!currentDelivery || !currentDelivery.bowler_submitted) {
        setPickSubmitted(false)
      }
    } else {
      setPickSubmitted(false)
    }
  }, [
    currentDelivery?.batter_submitted,
    currentDelivery?.bowler_submitted,
    isActiveBatter,
    isActiveBowler,
    match?.current_ball,
    match?.current_over,
    match?.phase,
  ])

  // Compute Run Rates (CRR, RRR)
  const { crr, rrr } = useMemo(() => {
    if (!match) return { crr: '-', rrr: '-' }
    const battingRuns = match.batting_team === 'A' ? match.team_a_runs : match.team_b_runs
    const totalBalls = match.current_over * 6 + match.current_ball

    let crrVal = '-'
    if (totalBalls > 0) {
      crrVal = (battingRuns / (totalBalls / 6)).toFixed(2)
    }

    let rrrVal = '-'
    if (match.phase === 'SECOND' && match.target !== null && match.target !== undefined) {
      const remainingBalls = Math.max(0, match.overs * 6 - totalBalls)
      const runsNeeded = Math.max(0, match.target - battingRuns)
      if (remainingBalls > 0 && runsNeeded > 0) {
        rrrVal = (runsNeeded / (remainingBalls / 6)).toFixed(2)
      } else if (runsNeeded === 0) {
        rrrVal = '0.00'
      }
    }

    return { crr: crrVal, rrr: rrrVal }
  }, [match])

  // Extract recent balls of current over for the overhead pitch display and recent balls panel
  const { currentOverBalls, recentBallList } = useMemo(() => {
    if (!match) return { currentOverBalls: [], recentBallList: [] }

    const curOver = match.current_over
    const curInnings = match.phase

    // Filter deliveries belonging to current innings. Timed-out deliveries are
    // dead balls (0 runs, no wicket) and must still appear as dots.
    const inningsDelivs = recentDeliveries.filter(
      d => (d.innings === curInnings || !d.innings) &&
        (d.result === 'OUT' || d.result === 'TIMEOUT' || d.runs_scored > 0)
    )

    // Current over deliveries
    const overDelivs = inningsDelivs.filter(d => d.over === curOver)
    const overBalls = overDelivs.map(d => ({
      ball: d.ball,
      runs: d.runs_scored,
      isOut: d.result === 'OUT',
    }))

    // Recent 6 deliveries overall
    const lastSix = inningsDelivs.slice(-6).map(d => ({
      runs: d.runs_scored,
      isOut: d.result === 'OUT',
    }))

    return { currentOverBalls: overBalls, recentBallList: lastSix }
  }, [match, recentDeliveries])

  // Batsmen & Bowlers details
  const activeBatter = members.find(m => m.player.id === match?.active_batter_id)
  const activeBowler = members.find(m => m.player.id === match?.active_bowler_id)

  // Compute player-level stats for batting and bowling tables
  const { teamABatters, teamBBowlers, teamBBatters, teamABowlers } = useMemo(() => {
    const memsA = members.filter(m => m.team === 'A')
    const memsB = members.filter(m => m.team === 'B')

    const calcBatter = (m: MemberInfo, isBattingTeam: boolean) => {
      // Runs & balls from resolved deliveries
      const myDelivs = recentDeliveries.filter(d => d.batter_id === m.player.id)
      const runs = myDelivs.reduce((sum, d) => sum + (d.runs_scored || 0), 0)
      const balls = myDelivs.length
      const fours = myDelivs.filter(d => d.runs_scored === 4).length
      const sixes = myDelivs.filter(d => d.runs_scored === 6).length
      const sr = balls > 0 ? ((runs / balls) * 100).toFixed(1) : '0.0'
      const isStriker = m.player.id === match?.active_batter_id

      const teamDismissed = m.team === 'A' ? (match?.dismissed_batters_a || []) : (match?.dismissed_batters_b || [])
      const isDismissed = teamDismissed.includes(m.player.id) || myDelivs.some(d => d.result === 'OUT')

      let status = 'Yet to Bat'
      if (m.player.connection_state === 'DISCONNECTED') {
        status = 'Disconnected'
      } else if (isDismissed) {
        status = 'Out'
      } else if (isStriker) {
        status = 'Currently Batting'
      } else if (match?.active_batter_id === null && isBattingTeam && !isDismissed) {
        status = 'Waiting for Selection'
      } else if (balls > 0) {
        status = 'Not Out'
      }

      return {
        member: m,
        runs,
        balls,
        fours,
        sixes,
        sr,
        status,
        isStriker,
        isDismissed,
      }
    }

    const calcBowler = (m: MemberInfo) => {
      const myDelivs = recentDeliveries.filter(d => d.bowler_id === m.player.id)
      const balls = myDelivs.length
      const overs = `${Math.floor(balls / 6)}.${balls % 6}`
      const runs = myDelivs.reduce((sum, d) => sum + (d.runs_scored || 0), 0)
      const wickets = myDelivs.filter(d => d.result === 'OUT').length
      const econ = balls > 0 ? ((runs / (balls / 6))).toFixed(1) : '0.0'
      const isBowling = m.player.id === match?.active_bowler_id

      return {
        member: m,
        overs,
        maidens: 0,
        runs,
        wickets,
        econ,
        isBowling,
      }
    }

    return {
      teamABatters: memsA.map(m => calcBatter(m, match?.batting_team === 'A')),
      teamBBowlers: memsB.map(m => calcBowler(m)),
      teamBBatters: memsB.map(m => calcBatter(m, match?.batting_team === 'B')),
      teamABowlers: memsA.map(m => calcBowler(m)),
    }
  }, [members, recentDeliveries, match])

  if (!match) {
    const lobbyStatuses = ['WAITING_FOR_PLAYERS', 'LOBBY_READY', 'RULEBOOK_REQUIRED', 'TOSS']
    if (snapshot?.room && lobbyStatuses.includes(snapshot.room.status)) {
      navigate(`/room/${roomId}`, { replace: true })
      return null
    }

    return (
      <div className={styles.centered}>
        <div className={styles.loader} />
        <p>Loading arena broadcast…</p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => roomId && syncRoom(roomId)}
        >
          🔄 Refresh Connection
        </button>
      </div>
    )
  }

  // Decide striker vs non-striker for lower left CURRENT BATSMEN card
  const battingTeamKey = match.batting_team
  const currentBatters = battingTeamKey === 'A' ? teamABatters : teamBBatters
  const strikerStat = currentBatters.find(b => b.member.player.id === match.active_batter_id) || currentBatters[0]
  const nonStrikerStat = currentBatters.find(b => b.member.player.id !== strikerStat?.member.player.id)

  // Current bowler figures for lower center card
  const bowlingStatsList = battingTeamKey === 'A' ? teamBBowlers : teamABowlers
  const currentBowlerStat = bowlingStatsList.find(b => b.member.player.id === match.active_bowler_id) || bowlingStatsList[0]

  // Check which team card is "My Team" vs "Opponent Team"
  const isMyTeamA = myMembership?.team === 'A'
  const isMyTeamB = myMembership?.team === 'B'
  const teamACardClass = `${styles.card} ${isMyTeamA ? styles.myTeamCard : styles.opponentTeamCard}`
  const pitchCardClass = `${styles.card} ${styles.centerPitchCard}`
  const teamBCardClass = `${styles.card} ${isMyTeamB ? styles.myTeamCard : styles.opponentTeamCard}`

  const captainA = members.find(m => m.team === 'A' && m.is_captain) || members.find(m => m.team === 'A')
  const captainB = members.find(m => m.team === 'B' && m.is_captain) || members.find(m => m.team === 'B')
  const displayTeamAName = match.team_a_name && match.team_a_name !== 'Team A' ? match.team_a_name : (captainA ? `${captainA.player.display_name}'s Team` : 'Team A')
  const displayTeamBName = match.team_b_name && match.team_b_name !== 'Team B' ? match.team_b_name : (captainB ? `${captainB.player.display_name}'s Team` : 'Team B')

  const firstBatTeam = match.first_batting_team || (match.batting_team === 'B' ? 'A' : 'B')
  const firstBattingTeamName = firstBatTeam === 'A' ? displayTeamAName : displayTeamBName
  const firstInningsTotal = firstBatTeam === 'A' ? match.team_a_runs ?? 0 : match.team_b_runs ?? 0
  const firstInningsWkts = firstBatTeam === 'A' ? match.team_a_wickets ?? 0 : match.team_b_wickets ?? 0
  const chasingTeam = firstBatTeam === 'A' ? 'B' : 'A'
  const chasingTeamName = chasingTeam === 'A' ? displayTeamAName : displayTeamBName
  const chaseTarget = match.target ?? (firstInningsTotal + 1)

  const isChasing = match.phase === 'SECOND' || match.phase === 'SUPER_OVER_SECOND'
  const chasingRuns = match.batting_team === 'A' ? match.team_a_runs ?? 0 : match.team_b_runs ?? 0
  const runsRemainingToWin = chaseTarget > 0 ? Math.max(0, chaseTarget - chasingRuns) : 0
  const totalChasingBallsBowled = ((match.current_over ?? 0) * 6) + (match.current_ball ?? 0)
  const chaseBallsRemaining = Math.max(0, ((match.overs ?? 0) * 6) - totalChasingBallsBowled)

  // Live team overs calculation:
  // Whichever team is currently batting reflects the live over.ball;
  // If not currently batting: 0.0 before they bat, or their completed overs after batting in 1st innings.
  const teamAOvers = match.batting_team === 'A'
    ? `${match.current_over}.${match.current_ball}`
    : match.phase === 'SECOND'
    ? `${match.overs}.0`
    : '0.0'

  const teamBOvers = match.batting_team === 'B'
    ? `${match.current_over}.${match.current_ball}`
    : match.phase === 'SECOND'
    ? `${match.overs}.0`
    : '0.0'

  return (
    <div className={styles.arena}>
      {/* ============================================================
          A. Top Navigation Bar (Header)
          ============================================================ */}
      <header className={styles.topNav}>
        <div className={styles.brandGroup}>
          <img src="/logo.jpg" alt="FoldCricket Logo" className={styles.brandLogo} />
          <span>FoldCricket</span>
        </div>

        {/* Center: Live Match Status & Innings */}
        <div className={styles.navCenter}>
          <div className={styles.matchStatusRow}>
            <span className={styles.matchStatusText}>
              {match.is_super_over
                ? (match.phase === 'SUPER_OVER_FIRST' ? 'SUPER OVER (1st Inn)' : 'SUPER OVER (2nd Inn)')
                : (match.phase === 'FIRST' ? '1st INNINGS' : '2nd INNINGS')} • OVER {match.current_over}.{match.current_ball} ({match.overs})
            </span>
            <span className={styles.liveBadge}>LIVE</span>
          </div>
          <span className={styles.matchSubtitle}>
            {isActiveBatter
              ? '🏏 You are Batting'
              : isActiveBowler
              ? '🎯 You are Bowling'
              : myMembership?.team === match.batting_team
              ? `🏏 Your Team is Batting (${match.batting_team === 'A' ? displayTeamAName : displayTeamBName})`
              : `🎯 Your Team is Bowling (${bowlingTeam === 'A' ? displayTeamAName : displayTeamBName})`}
          </span>
        </div>

        {/* Right Action Controls */}
        <div className={styles.navRight}>
          {/* Voice Chat Microphone facility */}
          <div className={styles.navVoiceWrapper}>
            <VoiceChat
              roomId={roomId || ''}
              myPlayerId={myPlayerId}
              myDisplayName={myMembership?.player.display_name || 'Player'}
              voiceStates={voiceStates}
              onVoiceStateChange={updateVoiceState}
              members={members}
              incomingVoiceSignals={voiceSignals}
              onSendSignal={sendVoiceSignal}
              onSetVoiceMode={setVoiceMode}
              isTeamMatch={isTeamMatch}
              isOpenVoiceList={isVoiceListOpen}
              onCloseVoiceList={() => setIsVoiceListOpen(false)}
              crossTeamRequests={crossTeamRequests}
              onRequestCrossTeam={requestCrossTeamVoice}
              onRespondCrossTeam={respondCrossTeamVoice}
              onRevokeCrossTeam={revokeCrossTeamVoice}
              voicePermissions={snapshot?.voice_permissions || []}
              isSoundMuted={isMuted}
              videoNetwork={videoNetwork}
              videoCallPeer={videoCallPeer}
              incomingVideoCall={incomingVideoCall}
              onRequestVideoCall={requestVideoCall}
              onRespondVideoCall={respondVideoCall}
              onEndVideoCall={endVideoCall}
              videoCallError={videoCallError}
              onClearVideoCallError={clearVideoCallError}
            />
          </div>

          {/* Desktop Nav Controls */}
          <div className={styles.navDesktopItems}>
            {/* Room Code with one-click copy */}
            <button
              type="button"
              className={styles.roomPill}
              onClick={handleCopyRoomId}
              title="Click to copy Room Code"
            >
              <span>Room: {roomId}</span>
              <span className={styles.copyIcon}>{copiedRoomId ? '✅' : '📋'}</span>
            </button>

            {/* Network Latency Indicator */}
            <NetworkIndicator status={status} latency={pingLatency} />

            {/* Sound Toggle (controls remote speech & sound effects) */}
            <button
              type="button"
              className={`${styles.navBtn} ${isMuted ? styles.soundOffBtn : styles.soundOnBtn}`}
              onClick={handleToggleSound}
              title={isMuted ? 'Sound is OFF: Click to turn Sound ON and hear other players & game audio' : 'Sound is ON: Hearing players & game. Click to Mute'}
            >
              {isMuted ? '🔇 Sound Off' : '🔊 Sound On'}
            </button>

            {/* Pause / Resume match */}
            <button
              type="button"
              className={styles.navBtn}
              onClick={() => roomId && (isPaused ? resumeMatch(roomId) : pauseMatch(roomId))}
              title={isPaused ? 'Resume Match' : 'Pause Match'}
            >
              {isPaused ? '▶️ Resume' : '⏸️ Pause'}
            </button>

            {/* Chat Drawer Toggle with unread counter */}
            <button
              type="button"
              className={`${styles.navBtn} ${isChatOpen ? styles.activeNavBtn : ''}`}
              onClick={() => setIsChatOpen(prev => !prev)}
              title="Toggle Match Chat"
            >
              💬 Chat
              {chatMessages.length > 0 && (
                <span className={styles.badgePill}>{chatMessages.length}</span>
              )}
            </button>

            {/* Dark / Light Theme Toggle */}
            <ThemeToggle />

            {/* Quit Match Button */}
            <button
              type="button"
              className={`${styles.navBtn} ${styles.quitBtn}`}
              onClick={() => setShowQuitModal(true)}
              title="Quit Match"
            >
              🚪 Quit
            </button>
          </div>

          {/* Mobile Sandwich (Hamburger) Menu Button */}
          <button
            type="button"
            className={styles.hamburgerBtn}
            onClick={() => setIsMobileMenuOpen(prev => !prev)}
            aria-label="Toggle mobile menu"
            title="Match Menu"
          >
            <span className={styles.hamburgerIcon}>{isMobileMenuOpen ? '✕' : '☰'}</span>
            {chatMessages.length > 0 && !isMobileMenuOpen && (
              <span className={styles.hamburgerBadge}>{chatMessages.length}</span>
            )}
          </button>
        </div>
      </header>

      {/* ============================================================
          B. Entry Toast Pop-Up: "Click mic to speak with the team"
          ============================================================ */}
      {showMicPrompt && (
        <div className={styles.micPromptBanner} role="alert">
          <span className={styles.micPromptIcon}>🎙️</span>
          <div className={styles.micPromptText}>
            <strong>Team Voice Chat Active</strong>
            <span>Click the mic button to speak with your teammates!</span>
          </div>
          <div className={styles.micPromptActions}>
            <button
              type="button"
              className={styles.micEnableBtn}
              onClick={() => {
                dismissMicPrompt()
              }}
            >
              🎙️ Open Mic
            </button>
            <button
              type="button"
              className={styles.micDismissBtn}
              onClick={dismissMicPrompt}
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* ============================================================
          C. Main Responsive Broadcast Dashboard Grid
          ============================================================ */}
      <main className={styles.dashboardContainer}>
        {/* Second Innings Authoritative Chase Status Banner */}
        {isChasing && chaseTarget > 0 && !match.winner && (
          <div className={styles.chaseStatusBanner} role="status">
            <div className={styles.chaseTargetCol}>
              <span className={styles.chaseTargetLabel}>TARGET</span>
              <span className={styles.chaseTargetVal}>{chaseTarget}</span>
            </div>
            <div className={styles.chaseDivider} />
            <div className={styles.chaseEquationCol}>
              <span className={styles.chaseNeedText}>
                <strong>{match.batting_team === 'A' ? displayTeamAName : displayTeamBName}</strong> needs{' '}
                <span className={styles.chaseHighlight}>
                  {runsRemainingToWin} run{runsRemainingToWin !== 1 ? 's' : ''}
                </span>{' '}
                to win
              </span>
              <span className={styles.chaseSubText}>
                from {chaseBallsRemaining} ball{chaseBallsRemaining !== 1 ? 's' : ''} (RRR: {rrr})
              </span>
            </div>
          </div>
        )}

        {/* Upper Row: Team A Scorecard | Center Pitch | Team B Scorecard */}
        <div className={styles.topRowGrid}>
          {/* LEFT: Team A Scorecard (Blue Header) */}
          <div className={teamACardClass}>
            <div className={styles.cardHeaderBlue}>
              <div className={styles.headerTeamCol}>
                <div className={styles.headerTeamName}>
                  <span>🏏</span>
                  <span>{displayTeamAName}</span>
                </div>
                <div className={styles.headerScoreRow}>
                  <span className={styles.headerRunsWkts}>
                    {match.team_a_runs}/{match.team_a_wickets}
                    {(Boolean(match.is_all_out_a) || (match.is_all_out && match.all_out_team === 'A') || (match.team_a_wickets >= (match.wickets || 10))) && (
                      <span className={styles.allOutBadgeHeader}>ALL OUT</span>
                    )}
                  </span>
                  <span className={styles.headerOvers}>
                    ({teamAOvers} / {match.overs} ov)
                  </span>
                </div>
              </div>
              <div className={styles.headerRightIcon}>🏏</div>
            </div>

            {/* Run Rate Bar */}
            <div className={styles.statsBar}>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>CRR:</span>
                <span>{match.batting_team === 'A' ? crr : '-'}</span>
              </div>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>RRR:</span>
                <span>{match.batting_team === 'A' && match.phase === 'SECOND' ? rrr : '-'}</span>
              </div>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>Target:</span>
                <span>{match.batting_team === 'A' && match.target ? match.target : '-'}</span>
              </div>
              {match.batting_team === 'A' && match.phase === 'SECOND' && match.target && (
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Need:</span>
                  <span style={{ fontWeight: 800, color: 'var(--color-team-a)' }}>{runsRemainingToWin}</span>
                </div>
              )}
            </div>

            {/* Scorecard Table */}
            <div className={styles.tableContainer}>
              <table className={styles.cricTable}>
                <thead>
                  <tr>
                    <th>Player</th>
                    <th style={{ textAlign: 'right' }}>R</th>
                    <th style={{ textAlign: 'right' }}>B</th>
                    <th style={{ textAlign: 'right' }}>SR</th>
                    <th style={{ textAlign: 'center' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {teamABatters.map(b => (
                    <tr key={b.member.player.id}>
                      <td>
                        <div className={styles.playerCell}>
                          <div className={styles.playerIcon}>👤</div>
                          <div className={styles.playerNameCol}>
                            <span className={styles.tableName}>
                              {formatPlayerWithTeam(b.member.player.display_name, b.member.player.id, myPlayerId, b.member.team, myMembership?.team, b.member.is_captain)}
                            </span>
                            <span className={styles.tableSub}>Right Hand Bat</span>
                          </div>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{b.runs}</td>
                      <td style={{ textAlign: 'right' }}>{b.balls}</td>
                      <td style={{ textAlign: 'right' }}>{b.sr}</td>
                      <td style={{ textAlign: 'center' }}>
                        {b.isStriker ? (
                          <span className={styles.activeDot} title="Currently Batting" />
                        ) : (
                          <span style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>
                            {b.status}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* CENTER: 3D Stadium Perspective Pitch */}
          <div className={pitchCardClass}>
            <PitchAnimation
              reveal={revealAnimation}
              countdown={countdown}
              hasBowler={Boolean(match.active_bowler_id)}
              isBatterSubmitted={Boolean(currentDelivery?.batter_submitted)}
              isBowlerSubmitted={Boolean(currentDelivery?.bowler_submitted)}
              currentOver={match.current_over}
              currentBall={match.current_ball}
              totalOvers={match.overs}
              recentBalls={currentOverBalls}
              activeBatterName={activeBatter?.player.display_name || 'Batter'}
              activeBowlerName={activeBowler?.player.display_name || 'Bowler'}
              isOverComplete={isOverComplete}
              bowlingCaptainName={bowlingCaptain?.player.display_name}
              isCaptainOrHost={isCaptain || isHost}
              onSelectBowlerClick={() => setShowBowlerModal(true)}
            />
          </div>

          {/* RIGHT: Team B Scorecard (Orange Header) */}
          <div className={teamBCardClass}>
            <div className={styles.cardHeaderOrange}>
              <div className={styles.headerTeamCol}>
                <div className={styles.headerTeamName}>
                  <span>⚾</span>
                  <span>{displayTeamBName}</span>
                </div>
                <div className={styles.headerScoreRow}>
                  <span className={styles.headerRunsWkts}>
                    {match.team_b_runs}/{match.team_b_wickets}
                    {(Boolean(match.is_all_out_b) || (match.is_all_out && match.all_out_team === 'B') || (match.team_b_wickets >= (match.wickets || 10))) && (
                      <span className={styles.allOutBadgeHeader}>ALL OUT</span>
                    )}
                  </span>
                  <span className={styles.headerOvers}>
                    ({teamBOvers} / {match.overs} ov)
                  </span>
                </div>
              </div>
              <div className={styles.headerRightIcon}>⚾</div>
            </div>

            {/* Run Rate Bar */}
            <div className={styles.statsBar}>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>CRR:</span>
                <span>{match.batting_team === 'B' ? crr : '-'}</span>
              </div>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>RRR:</span>
                <span>{match.batting_team === 'B' && match.phase === 'SECOND' ? rrr : '-'}</span>
              </div>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>Target:</span>
                <span>{match.batting_team === 'B' && match.target ? match.target : '-'}</span>
              </div>
              {match.batting_team === 'B' && match.phase === 'SECOND' && match.target && (
                <div className={styles.statItem}>
                  <span className={styles.statLabel}>Need:</span>
                  <span style={{ fontWeight: 800, color: 'var(--color-team-b)' }}>{runsRemainingToWin}</span>
                </div>
              )}
            </div>

            {/* Bowling Scorecard Table */}
            <div className={styles.tableContainer}>
              <table className={styles.cricTable}>
                <thead>
                  <tr>
                    <th>Player</th>
                    <th style={{ textAlign: 'right' }}>O</th>
                    <th style={{ textAlign: 'right' }}>M</th>
                    <th style={{ textAlign: 'right' }}>R</th>
                    <th style={{ textAlign: 'right' }}>W</th>
                    <th style={{ textAlign: 'right' }}>Econ</th>
                  </tr>
                </thead>
                <tbody>
                  {teamBBowlers.map(bw => (
                    <tr key={bw.member.player.id}>
                      <td>
                        <div className={styles.playerCell}>
                          <div className={styles.playerIcon} style={{ background: 'rgba(234, 88, 12, 0.12)' }}>
                            🎯
                          </div>
                          <div className={styles.playerNameCol}>
                            <span className={styles.tableName}>
                              {formatPlayerWithTeam(bw.member.player.display_name, bw.member.player.id, myPlayerId, bw.member.team, myMembership?.team, bw.member.is_captain)}
                            </span>
                            <span className={styles.tableSub}>Right Arm Medium</span>
                          </div>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }}>{bw.overs}</td>
                      <td style={{ textAlign: 'right' }}>{bw.maidens}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{bw.runs}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{bw.wickets}</td>
                      <td style={{ textAlign: 'right' }}>
                        {bw.econ} {bw.isBowling && <span className={styles.activeDot} style={{ marginLeft: 4 }} title="Currently Bowling" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Lower Row: Current Batsmen | Delivery Controls Pad | Recent Balls & Info */}
        <div className={styles.bottomRowGrid}>
          {/* LOWER LEFT: CURRENT BATSMEN - TEAM A/B */}
          <div className={`${styles.card} ${styles.batsmenCard}`}>
            <div className={styles.cardTitleBar}>
              <span>CURRENT BATSMEN — {match.batting_team === 'A' ? (match.team_a_name || 'TEAM A') : (match.team_b_name || 'TEAM B')}</span>
            </div>
            <div className={styles.tableContainer}>
              <table className={styles.cricTable}>
                <thead>
                  <tr>
                    <th>Player</th>
                    <th style={{ textAlign: 'right' }}>R</th>
                    <th style={{ textAlign: 'right' }}>B</th>
                    <th style={{ textAlign: 'right' }}>4s</th>
                    <th style={{ textAlign: 'right' }}>6s</th>
                    <th style={{ textAlign: 'right' }}>SR</th>
                  </tr>
                </thead>
                <tbody>
                  {strikerStat && (
                    <tr>
                      <td>
                        <div className={styles.playerCell}>
                          <span>🏏</span>
                          <div className={styles.playerNameCol}>
                            <span className={styles.tableName}>
                              {formatPlayerWithTeam(strikerStat.member.player.display_name, strikerStat.member.player.id, myPlayerId, strikerStat.member.team, myMembership?.team, strikerStat.member.is_captain)}
                            </span>
                            <span className={styles.tableSub}>Right Hand Bat</span>
                          </div>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 800 }}>{strikerStat.runs}</td>
                      <td style={{ textAlign: 'right' }}>{strikerStat.balls}</td>
                      <td style={{ textAlign: 'right' }}>{strikerStat.fours}</td>
                      <td style={{ textAlign: 'right' }}>{strikerStat.sixes}</td>
                      <td style={{ textAlign: 'right' }}>{strikerStat.sr}</td>
                    </tr>
                  )}
                  {nonStrikerStat && (
                    <tr>
                      <td>
                        <div className={styles.playerCell}>
                          <div className={styles.playerIcon}>👤</div>
                          <div className={styles.playerNameCol}>
                            <span className={styles.tableName}>
                              {formatPlayerWithTeam(nonStrikerStat.member.player.display_name, nonStrikerStat.member.player.id, myPlayerId, nonStrikerStat.member.team, myMembership?.team, nonStrikerStat.member.is_captain)}
                            </span>
                            <span className={styles.tableSub}>Left Hand Bat</span>
                          </div>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 800 }}>{nonStrikerStat.runs}</td>
                      <td style={{ textAlign: 'right' }}>{nonStrikerStat.balls}</td>
                      <td style={{ textAlign: 'right' }}>{nonStrikerStat.fours}</td>
                      <td style={{ textAlign: 'right' }}>{nonStrikerStat.sixes}</td>
                      <td style={{ textAlign: 'right' }}>{nonStrikerStat.sr}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* LOWER CENTER: BOWLER & LARGE DELIVERY CONTROLS */}
          <div className={`${styles.card} ${styles.controlsCard}`}>
            {/* Dynamic Real-time Gameplay Role Banner */}
            <div className={`${styles.roleStatusBanner} ${isActiveBatter || myMembership?.team === match.batting_team ? styles.roleBatting : styles.roleBowling}`}>
              <span className={styles.roleIcon}>
                {isActiveBatter || myMembership?.team === match.batting_team ? '🏏' : '🎯'}
              </span>
              <div className={styles.roleTextGroup}>
                <span className={styles.roleMainText}>
                  {isActiveBatter
                    ? 'YOU ARE BATTING'
                    : isActiveBowler
                    ? 'YOU ARE BOWLING'
                    : myMembership?.team === match.batting_team
                    ? 'YOUR TEAM IS BATTING'
                    : 'YOUR TEAM IS BOWLING'}
                </span>
                <span className={styles.roleSubText}>
                  {isActiveBatter
                    ? 'Choose your shot (1 to 6) to score runs. If bowler matches your pick, you are OUT!'
                    : isActiveBowler
                    ? 'Choose your delivery (1 to 6). Match the batter’s pick to take a WICKET!'
                    : myMembership?.team === match.batting_team
                    ? `${activeBatter?.player.display_name || 'Striker'} is currently at the crease.`
                    : `${activeBowler?.player.display_name || 'Bowler'} is bowling this over.`}
                </span>
              </div>
            </div>

            {/* Active Bowler Card Header */}
            <div className={styles.bowlerInfoBar}>
              <div className={styles.bowlerInfoLeft}>
                <div className={styles.bowlerBadgeIcon}>🎯</div>
                <div className={styles.bowlerTextCol}>
                  <span className={styles.bowlerTitle}>
                    BOWLER: <span>{activeBowler ? formatPlayerWithTeam(activeBowler.player.display_name, activeBowler.player.id, myPlayerId, activeBowler.team, myMembership?.team, activeBowler.is_captain) : 'Awaiting Selection'}</span>
                  </span>
                  <span className={styles.bowlerSubtext}>Right Arm Medium</span>
                </div>
              </div>
              <div className={styles.bowlerFiguresRight}>
                <span>Figures: {currentBowlerStat?.overs || '0.0'} - {currentBowlerStat?.runs || 0} - {currentBowlerStat?.wickets || 0}</span>
                <span className={styles.bowlerEcon}>Economy: {currentBowlerStat?.econ || '0.0'}</span>
              </div>
            </div>

            {/* Delivery Keypad: 1, 2, 3, 4, 5, 6 */}
            <div className={styles.deliveryPadArea}>
              <div className={styles.pickDeliveryHeading}>
                {isActiveBatter
                  ? '🏏 BATTER: PICK YOUR RUN SHOT'
                  : isActiveBowler
                  ? '🎯 BOWLER: PICK YOUR DELIVERY'
                  : 'PICK YOUR DELIVERY'}
              </div>

              {pickError && (
                <div
                  role="alert"
                  style={{
                    margin: '0 12px 8px',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    background: 'rgba(239, 68, 68, 0.12)',
                    border: '1px solid rgba(239, 68, 68, 0.45)',
                    color: '#ef4444',
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    textAlign: 'center',
                  }}
                >
                  ⚠️ Pick not accepted: {pickError.replace(/_/g, ' ')}
                </div>
              )}

              {isActivePlayer && match.active_bowler_id && !awaitingFirstBall ? (
                <>
                  <div className={styles.deliveryCardsRow}>
                    {[1, 2, 3, 4, 5, 6].map(n => (
                      <button
                        key={n}
                        type="button"
                        className={`${styles.deliveryCardBtn} ${selectedPick === n ? styles.deliveryCardSelected : ''} ${pickSubmitted || isInningsBreak || Boolean(match.winner) ? styles.deliveryCardDisabled : ''}`}
                        onClick={() => handlePickSelect(n)}
                        disabled={pickSubmitted || isInningsBreak || Boolean(match.winner)}
                        aria-label={`Pick ${n}`}
                      >
                        <HandGesture number={n} size={36} />
                        <span className={styles.deliveryNum}>{n}</span>
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    className={styles.lockInBtn}
                    onClick={handlePickSubmit}
                    disabled={selectedPick === null || pickSubmitted || isInningsBreak || Boolean(match.winner)}
                  >
                    {pickSubmitted
                      ? '✅ Pick Locked & Sent'
                      : isInningsBreak
                      ? '⏳ Innings Break in Progress'
                      : match.winner
                      ? '🏆 Match Finished'
                      : selectedPick !== null
                      ? `🎯 Lock In ${selectedPick} Runs`
                      : '👉 Choose 1, 2, 3, 4, 5, or 6'}
                  </button>
                </>
              ) : (
                <div className={styles.spectatorDeliveryBanner}>
                  {needsBatterSelect ? (
                    isBattingCaptain ? (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                        <span>🏏 Batter dismissed! You are the batting captain.</span>
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ padding: '6px 16px', fontSize: '0.88rem' }}
                          onClick={() => setShowBatterModal(true)}
                        >
                          Select Next Batter 🏏
                        </button>
                      </div>
                    ) : (
                      <span>🔔 Batter dismissed! Waiting for Captain ({battingCaptain?.player.display_name}) to select next batter…</span>
                    )
                  ) : needsBowlerSelect ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                      <span>🎯 Over completed! You are the bowling captain.</span>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ padding: '6px 16px', fontSize: '0.88rem' }}
                        onClick={() => setShowBowlerModal(true)}
                      >
                        Select Bowler 🎯
                      </button>
                    </div>
                  ) : isOverComplete ? (
                    <span>🔔 Over completed! Waiting for Captain ({bowlingCaptain?.player.display_name}) to choose bowler…</span>
                  ) : (
                    <span>👀 Watching the delivery in play…</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* LOWER RIGHT: RECENT BALLS & MATCH INFO */}
          <div className={`${styles.card} ${styles.infoCard}`}>
            {/* Recent Balls */}
            <div className={styles.recentBallsContainer}>
              <div className={styles.recentBallsTitle}>RECENT BALLS</div>
              <div className={styles.recentChipsRow}>
                {recentBallList.length > 0 ? (
                  recentBallList.map((b, i) => (
                    <div
                      key={i}
                      className={`${styles.ballChip} ${
                        b.isOut
                          ? styles.chipOut
                          : b.runs === 4
                          ? styles.chipFour
                          : b.runs === 6
                          ? styles.chipSix
                          : styles.chipNeutral
                      }`}
                    >
                      {b.isOut ? 'W' : b.runs === 0 ? '•' : b.runs}
                    </div>
                  ))
                ) : (
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                    No deliveries yet this innings
                  </span>
                )}
              </div>
            </div>

            {/* Match Info */}
            <div className={styles.matchInfoContainer}>
              <div className={styles.matchInfoTitle}>MATCH INFO</div>
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Format</span>
                <span className={styles.infoVal}>Traditional Hand Cricket (1, 2, 3, 4, 5, 6)</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Innings</span>
                <span className={styles.infoVal}>{match.phase === 'FIRST' ? '1st Innings' : '2nd Innings'}</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Current Over</span>
                <span className={styles.infoVal}>{match.current_over}.{match.current_ball} / {match.overs}</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Toss</span>
                <span className={styles.infoVal}>
                  {snapshot?.room.toss?.winner_team
                    ? `${snapshot.room.toss.winner_team === 'A' ? (match.team_a_name || 'Team A') : (match.team_b_name || 'Team B')} chose to ${snapshot.room.toss.elected_choice?.toLowerCase() || 'bat'}`
                    : '-'}
                </span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.infoLabel}>Venue</span>
                <span className={styles.infoVal}>FoldCricket Arena</span>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ============================================================
          C2. Arena Entry Gate: "Are you ready for the first ball?"
          ============================================================ */}
      {awaitingFirstBall && !isPaused && (
        <div className={styles.pausedOverlay} role="dialog" aria-modal="true" aria-label="Ready for the first ball">
          <div className={styles.pausedCard}>
            <span style={{ fontSize: '3rem' }}>🏏</span>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.8rem', margin: 0 }}>
              Are you ready for the first ball?
            </h2>
            <p style={{ color: 'var(--color-text-dim)', fontSize: '0.95rem', margin: 0 }}>
              The match starts only when every player is connected and has confirmed readiness.
            </p>

            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
              {members.map(m => {
                const isMe = m.player.id === myPlayerId
                const isConnected = m.player.connection_state === 'CONNECTED'
                const isReady = m.readiness === 'READY'
                return (
                  <div
                    key={m.player.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '8px',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      background: 'var(--color-surface-2)',
                      fontSize: '0.88rem',
                    }}
                  >
                    <span style={{ fontWeight: isMe ? 800 : 600 }}>
                      {m.player.display_name}{isMe ? ' (You)' : ''}
                    </span>
                    <span style={{ color: isConnected ? (isReady ? '#22c55e' : 'var(--color-text-muted)') : '#ef4444', fontWeight: 700 }}>
                      {isConnected ? (isReady ? '✅ Ready' : '⏳ Waiting') : '🔌 Disconnected'}
                    </span>
                  </div>
                )
              })}
            </div>

            {!allConnected && (
              <p style={{ color: 'var(--color-warning, #f59e0b)', fontSize: '0.85rem', margin: 0, fontWeight: 700 }}>
                Waiting for all players to reconnect…
              </p>
            )}

            <button
              type="button"
              className="btn btn-primary"
              style={{ width: '100%', padding: '12px', fontWeight: 800 }}
              disabled={myFirstBallReady || !allConnected}
              onClick={handleFirstBallReady}
            >
              {myFirstBallReady ? '✅ Ready — waiting for other players' : '🏏 I’m Ready for the First Ball'}
            </button>

            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
              {readyCount} of {members.length} player{members.length !== 1 ? 's' : ''} ready
            </span>

            {firstBallAck && !firstBallAck.success && (
              <span style={{ fontSize: '0.8rem', color: '#ef4444', fontWeight: 700 }}>
                ⚠️ {firstBallAck.error?.replace(/_/g, ' ')}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ============================================================
          D. Captain Bowler Selection Modal
          ============================================================ */}
      {(showBowlerModal || (needsBowlerSelect && !match.active_bowler_id)) && (
        <div className={styles.bowlerModalOverlay} role="dialog" aria-modal aria-label="Select Bowler">
          <div className={styles.bowlerModalCard}>
            <span style={{ fontSize: '2.5rem' }}>🎯</span>
            <h3 className={styles.bowlerModalTitle}>
              Select Bowler for Over {match.current_over + 1}
            </h3>
            <p className={styles.bowlerModalDesc}>
              As bowling team captain, pick which player will bowl this over:
            </p>
            <div className={styles.bowlerModalList}>
              {bowlingMembers.map(m => (
                <button
                  key={m.player.id}
                  type="button"
                  className={styles.bowlerPickBtn}
                  onClick={() => handleBowlerSelect(m.player.id)}
                >
                  <span>{formatPlayerWithTeam(m.player.display_name, m.player.id, myPlayerId, m.team, myMembership?.team, m.is_captain)}</span>
                  <span>👉 Select</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: '12px' }}
              onClick={() => setShowBowlerModal(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ============================================================
          Captain Batter Selection Modal
          ============================================================ */}
      {(showBatterModal || (needsBatterSelect && isBattingCaptain && !match.active_batter_id)) && (
        <div className={styles.bowlerModalOverlay} role="dialog" aria-modal aria-label="Select Next Batter">
          <div className={styles.bowlerModalCard}>
            <span style={{ fontSize: '2.5rem' }}>🏏</span>
            <h3 className={styles.bowlerModalTitle}>
              Select Next Batter
            </h3>
            <p className={styles.bowlerModalDesc}>
              As batting team captain, select an eligible player from your roster to bat:
            </p>
            <div className={styles.bowlerModalList}>
              {eligibleBatters.map(m => (
                <button
                  key={m.player.id}
                  type="button"
                  className={styles.bowlerPickBtn}
                  onClick={() => handleBatterSelect(m.player.id)}
                >
                  <span>{formatPlayerWithTeam(m.player.display_name, m.player.id, myPlayerId, m.team, myMembership?.team, m.is_captain)}</span>
                  <span>🏏 Send to Bat</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: '12px' }}
              onClick={() => setShowBatterModal(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}


      {/* ============================================================
          ALL OUT 5-Second Declaration Overlay
          ============================================================ */}
      {allOutAnnouncement && (
        <div className={styles.allOutOverlay}>
          <div className={styles.allOutCard}>
            <div className={styles.allOutIcon}>💥</div>
            <h2 className={styles.allOutTitle}>ALL OUT!</h2>
            <p className={styles.allOutSubtitle}>
              <strong>{allOutAnnouncement.teamName}</strong> is all out!
            </p>
            <div className={styles.allOutScore}>
              {allOutAnnouncement.runs} Runs • {allOutAnnouncement.wickets} Wickets
            </div>
            <div className={styles.allOutTimerBar}>
              <div className={styles.allOutTimerFill} />
            </div>
            <span className={styles.allOutNextHint}>
              {allOutAnnouncement.phase === 'FIRST'
                ? 'Preparing 2nd Innings run chase in 5 seconds…'
                : 'Finalizing match results in 5 seconds…'}
            </span>
          </div>
        </div>
      )}

      {/* ============================================================
          E. Slide-Out Chat Drawer
          ============================================================ */}
      {isChatOpen && (
        <>
          <div
            className={styles.chatDrawerOverlay}
            onClick={() => setIsChatOpen(false)}
          />
          <div className={styles.chatDrawer} role="region" aria-label="Match Chat">
            <div className={styles.chatDrawerHeader}>
              <span className={styles.chatDrawerTitle}>Match Chat</span>
              <button
                type="button"
                className={styles.chatCloseBtn}
                onClick={() => setIsChatOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className={styles.chatMessagesList}>
              {chatMessages.length === 0 ? (
                <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem', textAlign: 'center', margin: 'auto' }}>
                  No messages yet. Say hello to your teammates!
                </p>
              ) : (
                chatMessages.map((msg, i) => (
                  <div key={i} className={styles.chatItem}>
                    <div className={styles.chatMeta}>
                      <span className={styles.chatAuthor}>
                        {(() => {
                          const senderMem = members.find(m => m.player.display_name === msg.display_name || m.player.id === msg.player_id)
                          return formatPlayerWithTeam(msg.display_name, senderMem?.player.id || msg.player_id, myPlayerId, senderMem?.team, myMembership?.team)
                        })()}:
                      </span>
                      <span className={styles.chatTime}>
                        {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <span className={styles.chatText}>{msg.text}</span>
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>
            <form onSubmit={handleSendChat} className={styles.chatInputForm}>
              <input
                className={styles.chatInput}
                placeholder="Type a message…"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                maxLength={200}
              />
              <button type="submit" className={styles.chatSendBtn}>
                Send
              </button>
            </form>
          </div>
        </>
      )}

      {/* ============================================================
          G. Mobile Bottom Navigation Bar (< 768px)
          ============================================================ */}
      <nav className={styles.mobileBottomNav} aria-label="Mobile Navigation">
        <button
          type="button"
          className={`${styles.mobileTabBtn} ${activeMobileTab === 'game' ? styles.activeMobileTab : ''}`}
          onClick={() => setActiveMobileTab('game')}
        >
          <span className={styles.mobileTabIcon}>🏏</span>
          <span>Game</span>
        </button>
        <button
          type="button"
          className={`${styles.mobileTabBtn} ${activeMobileTab === 'chat' ? styles.activeMobileTab : ''}`}
          onClick={() => {
            setActiveMobileTab('chat')
            setIsChatOpen(true)
          }}
        >
          <span className={styles.mobileTabIcon}>💬</span>
          <span>Chat</span>
        </button>
        {isTeamMatch && (
          <button
            type="button"
            className={`${styles.mobileTabBtn} ${activeMobileTab === 'teams' ? styles.activeMobileTab : ''}`}
            onClick={() => {
              setActiveMobileTab('teams')
              setIsVoiceListOpen(true)
            }}
          >
            <span className={styles.mobileTabIcon}>👥</span>
            <span>Voice</span>
          </button>
        )}
      </nav>

      {/* ============================================================
          G2. Authoritative Innings Break Full Screen Overlay
          ============================================================ */}
      {isInningsBreak && (
        <div className={styles.inningsBreakOverlay} role="dialog" aria-modal="true" aria-label="First Innings Over">
          <div className={styles.inningsBreakCard}>
            <div className={styles.inningsBreakHeader}>
              <span className={styles.inningsBreakIcon}>🏏</span>
              <h2 className={styles.inningsBreakTitle}>FIRST INNINGS OVER!</h2>
              <span className={styles.inningsBreakSub}>Innings Transition</span>
            </div>

            <div className={styles.inningsBreakBody}>
              <div className={styles.inningsBreakStatRow}>
                <span className={styles.inningsBreakStatLabel}>{firstBattingTeamName} scored:</span>
                <span className={styles.statValueHighlight}>
                  <strong>{firstInningsTotal} run{firstInningsTotal !== 1 ? 's' : ''}</strong> ({firstInningsWkts} wkts)
                </span>
              </div>

              <div className={styles.inningsBreakStatRow}>
                <span className={styles.inningsBreakStatLabel}>{chasingTeamName}'s target:</span>
                <span className={styles.statTargetHighlight}>
                  <strong>{chaseTarget} runs to win</strong>
                </span>
              </div>

              <div className={styles.countdownBox}>
                <span className={styles.countdownLabel}>Second innings starts in:</span>
                <div className={styles.countdownNumber}>{breakCountdown}</div>
                <span className={styles.countdownUnit}>seconds</span>
              </div>

              <div className={styles.startingSoonStatus}>
                <span className={styles.pulseDot} />
                <span>Second innings starting soon...</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================
          H. Match Finished Overlay (Scores first, then result)
          ============================================================ */}
      {matchFinished && (
        <div className={styles.finishedOverlay} role="dialog" aria-modal aria-label="Match Complete">
          <div className={styles.finishedCard}>
            <span style={{ fontSize: '3.5rem' }}>🏆</span>
            <div className={styles.finishedScores}>
              <span>{match.team_a_name || 'Team A'}: <strong>{match.team_a_runs}/{match.team_a_wickets}</strong></span>
              <span className={styles.finishedScoresVs}>vs</span>
              <span>{match.team_b_name || 'Team B'}: <strong>{match.team_b_runs}/{match.team_b_wickets}</strong></span>
            </div>
            <h2 className={styles.finishedTitle}>{matchFinished.result_summary}</h2>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>Redirecting to results…</p>
          </div>
        </div>
      )}

      {/* ============================================================
          I. Match Paused / Reconnecting Overlay
          ============================================================ */}
      {isPaused && (
        <div className={styles.pausedOverlay} role="dialog" aria-modal aria-label="Match Paused">
          <div className={styles.pausedCard}>
            <span style={{ fontSize: '3rem' }}>⏸️</span>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.8rem', margin: 0 }}>
              {pausedInfo?.reason === 'player_disconnected' ? 'Player Disconnected' : 'Match Paused'}
            </h2>
            <p style={{ color: 'var(--color-text-dim)', fontSize: '0.95rem', margin: 0 }}>
              {pausedInfo?.reason === 'player_disconnected'
                ? `${pausedInfo?.player_name || 'A player'} lost connection. The match is paused while waiting for reconnection.`
                : 'The match is paused. Timers and delivery countdowns are frozen.'}
            </p>
            {pausedInfo?.grace_seconds && (
              <div style={{ padding: '6px 14px', background: 'var(--color-surface-2)', borderRadius: '8px', color: 'var(--color-warning)', fontWeight: 700 }}>
                ⏱️ Reconnection window active: {pausedInfo.grace_seconds}s
              </div>
            )}
            <div style={{ display: 'flex', gap: '10px', width: '100%', marginTop: '8px' }}>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ flex: 1 }}
                onClick={() => roomId && syncRoom(roomId)}
              >
                🔄 Refresh
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={() => roomId && resumeMatch(roomId)}
              >
                ▶️ Resume Match
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================
          J. Quit Match Confirmation Modal
          ============================================================ */}
      {showQuitModal && (
        <div className={styles.quitModalOverlay} role="dialog" aria-modal="true" aria-labelledby="quit-title">
          <div className={styles.quitModalCard}>
            <div className={styles.quitModalIcon}>⚠️</div>
            <h3 id="quit-title" className={styles.quitModalTitle}>Are you sure you want to quit?</h3>
            <p className={styles.quitModalText}>
              If you leave now, you will forfeit or disconnect from the active live match.
            </p>
            <div className={styles.quitModalActions}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowQuitModal(false)}
              >
                Cancel / Stay
              </button>
              <button
                type="button"
                className="btn btn-danger"
                style={{ background: '#ef4444', color: '#fff', fontWeight: 700 }}
                onClick={() => {
                  setShowQuitModal(false)
                  navigate('/')
                }}
              >
                Yes, Quit Game
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================
          K. Match Tied: Entering Super Over (Exact 5-second Overlay)
          ============================================================ */}
      {superOverAnnouncement && (
        <div className={styles.superOverOverlay} role="alert">
          <div className={styles.superOverCard}>
            <div className={styles.superOverBadge}>⚔️ SUPER OVER</div>
            <h1 className={styles.superOverTitle}>MATCH TIED: ENTERING SUPER OVER</h1>
            <p className={styles.superOverSubtitle}>
              Main match ended in a tie! 1 Over per side • Maximum 2 Wickets
            </p>
            <div className={styles.superOverTimerBar}>
              <div className={styles.superOverProgress} />
            </div>
            <span className={styles.superOverCountdown}>Starting Super Over in 5 seconds…</span>
          </div>
        </div>
      )}

      {/* ============================================================
          L. Mobile Sandwich Menu Drawer
          ============================================================ */}
      {isMobileMenuOpen && (
        <div className={styles.mobileMenuBackdrop} onClick={() => setIsMobileMenuOpen(false)}>
          <div className={styles.mobileMenuPanel} onClick={e => e.stopPropagation()}>
            <div className={styles.mobileMenuHeader}>
              <span className={styles.mobileMenuTitle}>⚙️ Match Menu</span>
              <button
                type="button"
                className={styles.mobileMenuCloseBtn}
                onClick={() => setIsMobileMenuOpen(false)}
                aria-label="Close menu"
              >
                ✕
              </button>
            </div>

            <div className={styles.mobileMenuItems}>
              {/* Room Code */}
              <button
                type="button"
                className={styles.mobileMenuItem}
                onClick={() => {
                  handleCopyRoomId()
                  setIsMobileMenuOpen(false)
                }}
              >
                <span>📋 Room: {roomId}</span>
                <span className={styles.mobileItemSub}>{copiedRoomId ? 'Copied!' : 'Tap to copy'}</span>
              </button>

              {/* Voice List Settings (Team Match) */}
              {isTeamMatch && (
                <button
                  type="button"
                  className={styles.mobileMenuItem}
                  onClick={() => {
                    setIsVoiceListOpen(true)
                    setIsMobileMenuOpen(false)
                  }}
                >
                  <span>👥 Voice List (Talk / Block)</span>
                  <span className={styles.mobileItemSub}>Configure player voice permissions</span>
                </button>
              )}

              {/* Match Chat Button */}
              <button
                type="button"
                className={styles.mobileMenuItem}
                onClick={() => {
                  setIsChatOpen(true)
                  setIsMobileMenuOpen(false)
                }}
              >
                <span>💬 Match Chat</span>
                {chatMessages.length > 0 && (
                  <span className={styles.badgePill}>{chatMessages.length}</span>
                )}
              </button>

              {/* Sound Toggle */}
              <button
                type="button"
                className={styles.mobileMenuItem}
                onClick={handleToggleSound}
                title={isMuted ? 'Turn Sound On' : 'Turn Sound Off'}
              >
                <span>{isMuted ? '🔇 Sound Off' : '🔊 Sound On'}</span>
              </button>

              {/* Pause/Resume */}
              <button
                type="button"
                className={styles.mobileMenuItem}
                onClick={() => {
                  if (roomId) {
                    if (isPaused) resumeMatch(roomId)
                    else pauseMatch(roomId)
                  }
                  setIsMobileMenuOpen(false)
                }}
              >
                <span>{isPaused ? '▶️ Resume Match' : '⏸️ Pause Match'}</span>
              </button>

              {/* Network Latency & Theme Toggle Row */}
              <div className={styles.mobileMenuBottomRow}>
                <NetworkIndicator status={status} latency={pingLatency} />
                <ThemeToggle />
              </div>

              {/* Quit Match Action */}
              <button
                type="button"
                className={styles.mobileQuitItem}
                onClick={() => {
                  setIsMobileMenuOpen(false)
                  setShowQuitModal(true)
                }}
              >
                🚪 Quit Match
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Celebration Particle Effects on 4, 6, Wicket, and Match Win */}
      <CelebrationEffects
        trigger={celebrationTrigger}
        onComplete={() => setCelebrationTrigger(null)}
      />
    </div>
  )
}
