/**
 * Device capability detection.
 *
 * Video calling is only offered on laptops/desktops: phone cameras are held
 * in portrait, the video grid does not fit small screens, and mobile radios
 * switch networks constantly enough that a video call degrades the match.
 */

const MOBILE_TABLET_UA =
  /Android|iPhone|iPod|iPad|Windows Phone|IEMobile|Opera Mini|Mobile|Tablet|Kindle|Silk|PlayBook/i

export function isLaptopDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false

  // Chromium's UA-CH hint is authoritative when present.
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
  if (uaData?.mobile === true) return false

  // iPadOS 13+ masquerades as desktop Safari; the touch points give it away.
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return false

  if (MOBILE_TABLET_UA.test(navigator.userAgent)) return false

  if (typeof window.matchMedia === 'function') {
    const hasFinePointer = window.matchMedia('(any-pointer: fine)').matches
    const touchOnly =
      window.matchMedia('(pointer: coarse)').matches &&
      window.matchMedia('(hover: none)').matches
    // No mouse/trackpad, or a touch-first device: not a laptop experience.
    if (!hasFinePointer || touchOnly) return false
  }

  return true
}
