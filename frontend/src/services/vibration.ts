/**
 * Haptic Vibration Feedback Service.
 * Provides tactile vibration feedback for mobile and supported devices on
 * wickets, boundaries (4s and 6s), and match wins using standard HTML5 Vibration API.
 */

class VibrationService {
  private isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      'vibrate' in navigator &&
      typeof navigator.vibrate === 'function'
    )
  }

  /**
   * Powerful double shock followed by an extended rumble for a Wicket / Out.
   */
  public wicket(): void {
    if (!this.isSupported()) return
    try {
      navigator.vibrate([220, 80, 220, 80, 450])
    } catch {}
  }

  /**
   * Energetic celebratory crescendo pulses for a Maximum / Six (6).
   */
  public six(): void {
    if (!this.isSupported()) return
    try {
      navigator.vibrate([120, 60, 120, 60, 250, 80, 350])
    } catch {}
  }

  /**
   * Crisp double boundary strike for a Boundary / Four (4).
   */
  public four(): void {
    if (!this.isSupported()) return
    try {
      navigator.vibrate([120, 80, 180])
    } catch {}
  }

  /**
   * Triumphant pattern for Match Victory.
   */
  public win(): void {
    if (!this.isSupported()) return
    try {
      navigator.vibrate([150, 70, 150, 70, 200, 70, 400])
    } catch {}
  }

  /**
   * Subtle tactile tick on button taps.
   */
  public tap(): void {
    if (!this.isSupported()) return
    try {
      navigator.vibrate(25)
    } catch {}
  }
}

export const vibration = new VibrationService()
