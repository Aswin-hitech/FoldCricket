/**
 * Voice session state that outlives route changes.
 *
 * The lobby (/room/:roomId) and the arena (/room/:roomId/arena) are separate
 * routes, so the VoiceChat component unmounts when the match starts. Without a
 * shared session that unmount would stop the microphone and close every
 * peer connection, forcing the player to reconnect mid-match.
 *
 * The session is created when the mic is enabled and only torn down when the
 * match is over (Result page) or the player leaves the room routes.
 */

export interface VoiceSessionState {
  roomId: string | null
  stream: MediaStream | null
  micEnabled: boolean
  isMuted: boolean
  blockedRecipients: Record<string, boolean>
  incomingMutes: Record<string, boolean>
  peerConnections: Map<string, RTCPeerConnection>
  audioElements: Map<string, HTMLAudioElement>
  iceQueues: Map<string, RTCIceCandidateInit[]>
  offeredPeers: Set<string>
  readySent: Set<string>
}

export const voiceSession: VoiceSessionState = {
  roomId: null,
  stream: null,
  micEnabled: false,
  isMuted: true,
  blockedRecipients: {},
  incomingMutes: {},
  peerConnections: new Map(),
  audioElements: new Map(),
  iceQueues: new Map(),
  offeredPeers: new Set(),
  readySent: new Set(),
}

/** Release the microphone and every voice transport. */
export function stopVoiceSession(): void {
  const session = voiceSession

  if (session.stream) {
    session.stream.getTracks().forEach((track) => {
      // Detach first: a stopping track must not trigger the mid-match
      // re-acquisition path.
      track.onended = null
      try {
        track.stop()
      } catch {
        // already stopped
      }
    })
    session.stream = null
  }

  session.peerConnections.forEach((pc) => {
    pc.onconnectionstatechange = null
    pc.onicecandidate = null
    pc.ontrack = null
    try {
      pc.close()
    } catch {
      // already closed
    }
  })
  session.peerConnections.clear()

  session.audioElements.forEach((audio) => {
    audio.pause()
    audio.srcObject = null
    audio.remove()
  })
  session.audioElements.clear()

  session.iceQueues.clear()
  session.offeredPeers.clear()
  session.readySent.clear()

  session.roomId = null
  session.micEnabled = false
  session.isMuted = true
  session.blockedRecipients = {}
  session.incomingMutes = {}
}
