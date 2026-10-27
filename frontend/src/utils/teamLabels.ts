/**
 * Consistent Team Identification helper.
 * Provides the exact labels specified:
 * - (You)
 * - (Your Team)
 * - (Opponent)
 */

export function getTeamRoleLabel(
  playerId: string,
  myPlayerId: string,
  playerTeam: 'A' | 'B' | string | null | undefined,
  myTeam: 'A' | 'B' | string | null | undefined
): string {
  if (playerId === myPlayerId) {
    return '(You)'
  }
  if (!playerTeam || !myTeam) {
    return ''
  }
  return playerTeam === myTeam ? '(Your Team)' : '(Opponent)'
}

export function formatPlayerWithTeam(
  displayName: string,
  playerId: string,
  myPlayerId: string,
  playerTeam: 'A' | 'B' | string | null | undefined,
  myTeam: 'A' | 'B' | string | null | undefined,
  isCaptain?: boolean
): string {
  const label = getTeamRoleLabel(playerId, myPlayerId, playerTeam, myTeam)
  const cap = isCaptain ? '(c)' : ''
  return [displayName, label, cap].filter(Boolean).join(' ')
}
