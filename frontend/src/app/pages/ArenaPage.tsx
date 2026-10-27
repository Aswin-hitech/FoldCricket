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
import { ThemeToggle } from '../../context/ThemeContext'
import { sound } from '../../services/sound'
import { vibration } from '../../services/vibration'
import { HandGesture } from '../components/HandGesture'
import { NetworkIndicator } from '../components/NetworkIndicator'
import { VoiceChat } from '../components/VoiceChat'
import { PitchAnimation } from '../components/PitchAnimation'
import { VideoCallPanel } from '../components/VideoCallPanel'
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
    incomingVoiceSignal,
    sendVoiceSignal,
  } = useSocket(sessionToken)

  const [chatInput, setChatInput] = useState('')
  const [selectedPick, setSelectedPick] = useState<number | null>(null)
  const [pickSubmitted, setPickSubmitted] = useState(false)
  const [revealAnimation, setRevealAnimation] = useState<DeliveryReveal | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [isMuted, setIsMuted] = useState(() => sound.isMuted())
  const [celebrationTrigger, setCelebrationTrigger] = useState<'SIX' | 'FOUR' | 'WICKET' | 'WIN' | null>(null)
  const [copiedRoomId, setCopiedRoomId] = useState(false)

  // Drawer / modal states
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [isVideoCallOpen, setIsVideoCallOpen] = useState(false)
  const [showBowlerModal, setShowBowlerModal] = useState(false)
  const [showBatterModal, setShowBatterModal] = useState(false)
  const [showVideoBetaModal, setShowVideoBetaModal] = useState(false)
  const [allOutAnnouncement, setAllOutAnnouncement] = useState<{
    teamName: string
    runs: number
    wickets: number
    phase: string
  } | null>(null)
  const [showInningsBreakBanner, setShowInningsBreakBanner] = useState(false)
  const [activeMobileTab, setActiveMobileTab] = useState<'game' | 'chat' | 'teams' | 'call'>('game')

  // Entry pop-up mic prompt
  const [showMicPrompt, setShowMicPrompt] = useState(() => {
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

  const bowlingTeam = match?.batting_team === 'A' ? 'B' : 'A'
  const bowlingMembers = members.filter(m => m.team === bowlingTeam)
  const bowlingCaptain = bowlingMembers.find(m => m.is_captain) || bowlingMembers.find(m => m.is_host) || bowlingMembers[0]

  const battingTeam = match?.batting_team || 'A'
  const battingMembers = members.filter(m => m.team === battingTeam)
  const battingCaptain = battingMembers.find(m => m.is_captain) || battingMembers.find(m => m.is_host) || battingMembers[0]
  const isBattingCaptain = (isCaptain || isHost) && myMembership?.team === battingTeam

  const dismissedBatters = battingTeam === 'A' ? (match?.dismissed_batters_a || []) : (match?.dismissed_batters_b || [])
  const eligibleBatters = battingMembers.filter(m => !dismissedBatters.includes(m.player.id))

  const isAllOut = Boolean(match?.is_all_out)

  const needsBatterSelect = Boolean(
    match &&
    !match.active_batter_id &&
    !match.winner &&
    !isAllOut &&
    eligibleBatters.length > 0 &&
    battingMembers.length > 1
  )

  // Detect over complete state
  const isOverComplete = Boolean(
    match &&
    !match.active_bowler_id &&
    !match.winner &&
    !isAllOut &&
    ((match.current_ball === 0 && match.current_over > 0) ||
     (match.phase === 'SECOND' && match.current_over === 0 && match.current_ball === 0))
  )

  const needsBowlerSelect = Boolean(
    match &&
    !match.active_bowler_id &&
    !match.winner &&
    !isAllOut &&
    (isCaptain || isHost) &&
    myMembership?.team === bowlingTeam
  )

  // Handle ALL OUT declaration - 5 second transition
  useEffect(() => {
    if (allOutInfo || (match?.is_all_out && !allOutAnnouncement)) {
      const info = allOutInfo
        ? {
            teamName: allOutInfo.team_name,
            runs: allOutInfo.runs,
            wickets: allOutInfo.wickets,
            phase: allOutInfo.phase,
          }
        : {
            teamName: (match?.all_out_team || match?.batting_team) === 'A' ? (match?.team_a_name || 'Team A') : (match?.team_b_name || 'Team B'),
            runs: (match?.all_out_team || match?.batting_team) === 'A' ? (match?.team_a_runs ?? 0) : (match?.team_b_runs ?? 0),
            wickets: (match?.all_out_team || match?.batting_team) === 'A' ? (match?.team_a_wickets ?? 0) : (match?.team_b_wickets ?? 0),
            phase: match?.phase || 'FIRST',
          }
      setAllOutAnnouncement(info)
      sound.playOut()
      vibration.wicket()
      setCelebrationTrigger('WICKET')

      const timer = setTimeout(() => {
        setAllOutAnnouncement(null)
      }, 5000)

      return () => clearTimeout(timer)
    }
  }, [allOutInfo, match?.is_all_out])

  // Sync room on mount
  useEffect(() => {
    if (roomId) {
      syncRoom(roomId)
    }
  }, [roomId, syncRoom, status])

  // Handle match finished redirect - 5 second transition
  useEffect(() => {
    if (matchFinished) {
      sound.playWin()
      vibration.win()
      setCelebrationTrigger('WIN')
      const popperTimer = setTimeout(() => setCelebrationTrigger(null), 2000)
      const timer = setTimeout(() => navigate(`/room/${roomId}/result`), 5000)
      return () => {
        clearTimeout(popperTimer)
        clearTimeout(timer)
      }
    }
  }, [matchFinished, navigate, roomId])

  // Handle delivery reveal sound & vibration - 5s popup animation & 2s party popper
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
      // Reveal popup outcome animation holds for 5 seconds
      const timer = setTimeout(() => setRevealAnimation(null), 5000)
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
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
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
  }, [match?.delivery_deadline, match?.active_bowler_id, isPaused])

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

  // Handle Innings Break notification
  useEffect(() => {
    if (inningsBreak || (match?.phase === 'SECOND' && match.current_over === 0 && match.current_ball === 0 && !match.winner)) {
      setShowInningsBreakBanner(true)
      setPickSubmitted(false)
      setSelectedPick(null)
      sound.playClick()
      const timer = setTimeout(() => setShowInningsBreakBanner(false), 9000)
      return () => clearTimeout(timer)
    }
  }, [inningsBreak, match?.phase, match?.current_over, match?.current_ball, match?.winner])

  const dismissMicPrompt = () => {
    setShowMicPrompt(false)
    try {
      sessionStorage.setItem(`hcl_mic_prompt_${roomId}`, '1')
    } catch {}
  }

  // Handle pick select
  function handlePickSelect(pick: number) {
    if (pickSubmitted || !isActivePlayer) return
    sound.playClick()
    vibration.tap()
    setSelectedPick(pick)
  }

  // Handle pick submit
  function handlePickSubmit() {
    if (selectedPick === null || pickSubmitted || !roomId) return
    sound.playClick()
    vibration.tap()
    submitPick(roomId, selectedPick)
    setPickSubmitted(true)
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

  const currentDelivery = snapshot?.current_delivery

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

    // Filter deliveries belonging to current innings (valid hand-cricket outcomes: OUT or 1, 2, 3, 4, 6)
    const inningsDelivs = recentDeliveries.filter(
      d => (d.innings === curInnings || !d.innings) && (d.result === 'OUT' || d.runs_scored > 0)
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
    if (snapshot?.room && snapshot.room.status === 'LOBBY') {
      navigate(`/room/${roomId}`)
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
              {match.phase === 'FIRST' ? '1st INNINGS' : '2nd INNINGS'} • OVER {match.current_over}.{match.current_ball} ({match.overs})
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

          {/* Voice Chat Microphone facility */}
          <VoiceChat
            roomId={roomId || ''}
            myPlayerId={myPlayerId}
            myDisplayName={myMembership?.player.display_name || 'Player'}
            voiceStates={voiceStates}
            onVoiceStateChange={updateVoiceState}
            members={members}
            incomingVoiceSignal={incomingVoiceSignal}
            onSendSignal={sendVoiceSignal}
            onSetVoiceMode={setVoiceMode}
          />

          {/* Video Call (Beta Feature Notice) */}
          <button
            type="button"
            className={styles.videoBetaBtn}
            onClick={() => setShowVideoBetaModal(true)}
            title="Video Calling (Beta Feature)"
          >
            <span>📹 Video Call</span>
            <span className={styles.videoBetaBadge}>BETA</span>
          </button>

          {/* Sound Toggle */}
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => setIsMuted(sound.toggleMute())}
            title={isMuted ? 'Unmute Sound' : 'Mute Sound'}
          >
            {isMuted ? '🔇 Muted' : '🔊 Sound'}
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

          {/* Video Call Modal Toggle */}
          <button
            type="button"
            className={`${styles.navBtn} ${isVideoCallOpen ? styles.activeNavBtn : ''}`}
            onClick={() => setIsVideoCallOpen(prev => !prev)}
            title="Toggle Team Video Call"
          >
            📹 Video
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
                setIsVideoCallOpen(true)
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
        {/* Innings Break Notification Banner */}
        {showInningsBreakBanner && (
          <div className={styles.inningsBreakBanner} role="alert">
            <span style={{ fontSize: '1.8rem' }}>🏏</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
              <strong style={{ fontSize: '1rem', color: 'var(--color-team-a)' }}>1st Innings Complete!</strong>
              <span style={{ fontSize: '0.88rem', color: 'var(--color-text)' }}>
                Target is <strong>{match.target} runs</strong> in {match.overs} overs ({match.overs * 6} balls). 2nd Innings has begun!
              </span>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ padding: '4px 10px', fontSize: '0.8rem' }}
              onClick={() => setShowInningsBreakBanner(false)}
            >
              ✕
            </button>
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
                    {((match.is_all_out && match.all_out_team === 'A') || (match.phase === 'SECOND' && match.first_batting_team === 'A' && match.team_a_wickets >= (match.wickets || 10))) && (
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
          <div className={pitchCardClass} style={{ minHeight: '400px' }}>
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
                    {((match.is_all_out && match.all_out_team === 'B') || (match.phase === 'SECOND' && match.first_batting_team === 'B' && match.team_b_wickets >= (match.wickets || 10))) && (
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
                <span>{match.target ? match.target : '-'}</span>
              </div>
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

              {isActivePlayer && match.active_bowler_id ? (
                <>
                  <div className={styles.deliveryCardsRow}>
                    {[1, 2, 3, 4, 5, 6].map(n => (
                      <button
                        key={n}
                        type="button"
                        className={`${styles.deliveryCardBtn} ${selectedPick === n ? styles.deliveryCardSelected : ''} ${pickSubmitted ? styles.deliveryCardDisabled : ''}`}
                        onClick={() => handlePickSelect(n)}
                        disabled={pickSubmitted}
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
                    disabled={selectedPick === null || pickSubmitted}
                  >
                    {pickSubmitted
                      ? '✅ Pick Locked & Sent'
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
                      {b.isOut ? 'W' : b.runs}
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
          Video Call (Beta Feature Notice) Modal
          ============================================================ */}
      {showVideoBetaModal && (
        <div className={styles.betaModalOverlay} onClick={() => setShowVideoBetaModal(false)}>
          <div className={styles.betaModal} onClick={e => e.stopPropagation()}>
            <div className={styles.betaModalIcon}>📹</div>
            <h3 className={styles.betaModalTitle}>Video Call (Beta Preview)</h3>
            <div className={styles.betaBadgeLarge}>UNDER CONSTRUCTION</div>
            <p className={styles.betaModalDesc}>
              Video calling is currently being built and optimized for smooth multiplayer gaming.
              It will be enabled in an upcoming release of FoldCricket!
            </p>
            <div className={styles.betaModalTip}>
              💡 <strong>Tip:</strong> High-definition <strong>Voice Chat</strong> with private team audio channels is fully live! Click the <strong>🎙️ Mic</strong> button in the top bar to talk with your team.
            </div>
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: '100%', marginTop: '8px', padding: '10px' }}
              onClick={() => setShowVideoBetaModal(false)}
            >
              Got It & Return to Game
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
          F. Team Video Call Panel (Docked / Floating)
          ============================================================ */}
      <VideoCallPanel
        isOpen={isVideoCallOpen}
        onClose={() => setIsVideoCallOpen(false)}
        members={members}
        myPlayerId={myPlayerId}
        myDisplayName={myMembership?.player.display_name || 'Player'}
        isMuted={isMuted}
        onToggleMute={() => setIsMuted(sound.toggleMute())}
      />

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
        <button
          type="button"
          className={`${styles.mobileTabBtn} ${activeMobileTab === 'call' ? styles.activeMobileTab : ''}`}
          onClick={() => {
            setActiveMobileTab('call')
            setIsVideoCallOpen(true)
          }}
        >
          <span className={styles.mobileTabIcon}>📹</span>
          <span>Call</span>
        </button>
      </nav>

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

      {/* Celebration Particle Effects on 4, 6, Wicket, and Match Win */}
      <CelebrationEffects
        trigger={celebrationTrigger}
        onComplete={() => setCelebrationTrigger(null)}
      />
    </div>
  )
}
