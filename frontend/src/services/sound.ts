/**
 * Sound effects engine powered by Web Audio API.
 * 100% offline, zero external audio asset dependencies, immediate low-latency playback.
 */

class SoundEngine {
  private ctx: AudioContext | null = null
  private muted: boolean = false

  constructor() {
    if (typeof window !== 'undefined') {
      this.muted = localStorage.getItem('hcl_sound_muted') === 'true'
    }
  }

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (AudioCtx) {
        this.ctx = new AudioCtx()
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {})
    }
    return this.ctx
  }

  public isMuted(): boolean {
    return this.muted
  }

  public toggleMute(): boolean {
    this.muted = !this.muted
    if (typeof window !== 'undefined') {
      localStorage.setItem('hcl_sound_muted', String(this.muted))
    }
    return this.muted
  }

  // --- Coin Toss Sounds ---
  public playCoinToss(): void {
    if (this.muted) return
    const ctx = this.getContext()
    if (!ctx) return

    // Metallic ring with high resonance
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(1400, now)
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.6)

    gain.gain.setValueAtTime(0.3, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(now)
    osc.stop(now + 0.6)

    // Second harmonic sparkle
    const osc2 = ctx.createOscillator()
    const gain2 = ctx.createGain()
    osc2.type = 'triangle'
    osc2.frequency.setValueAtTime(2800, now)
    osc2.frequency.exponentialRampToValueAtTime(2400, now + 0.4)

    gain2.gain.setValueAtTime(0.15, now)
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.4)

    osc2.connect(gain2)
    gain2.connect(ctx.destination)

    osc2.start(now)
    osc2.stop(now + 0.4)
  }

  public playCoinLand(): void {
    if (this.muted) return
    const ctx = this.getContext()
    if (!ctx) return

    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(800, now)
    osc.frequency.exponentialRampToValueAtTime(400, now + 0.15)

    gain.gain.setValueAtTime(0.35, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.15)
  }

  // --- Out / Wicket Sound ---
  public playOut(): void {
    if (this.muted) return
    const ctx = this.getContext()
    if (!ctx) return

    const now = ctx.currentTime
    // Low dramatic thud & descending buzzer
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(320, now)
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.45)

    gain.gain.setValueAtTime(0.4, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(now)
    osc.stop(now + 0.45)
  }

  // --- Sixer Fanfare Sound ---
  public playSix(): void {
    if (this.muted) return
    const ctx = this.getContext()
    if (!ctx) return

    const now = ctx.currentTime
    const notes = [523.25, 659.25, 783.99, 1046.5] // C5, E5, G5, C6 arpeggio

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = freq

      const start = now + idx * 0.08
      gain.gain.setValueAtTime(0.25, start)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35)

      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.start(start)
      osc.stop(start + 0.35)
    })
  }

  // --- Four Boundary Sound ---
  public playFour(): void {
    if (this.muted) return
    const ctx = this.getContext()
    if (!ctx) return

    const now = ctx.currentTime
    const notes = [440, 554.37, 659.25] // A4, C#5, E5

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq

      const start = now + idx * 0.09
      gain.gain.setValueAtTime(0.2, start)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28)

      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.start(start)
      osc.stop(start + 0.28)
    })
  }

  // --- Run Scored Sound (1-5, 7-10) ---
  public playRuns(count: number): void {
    if (this.muted) return
    if (count === 6) {
      this.playSix()
      return
    }
    if (count === 4) {
      this.playFour()
      return
    }

    const ctx = this.getContext()
    if (!ctx) return

    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(350 + count * 40, now)

    gain.gain.setValueAtTime(0.2, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.18)
  }

  // --- Countdown Tick ---
  public playTick(): void {
    if (this.muted) return
    const ctx = this.getContext()
    if (!ctx) return

    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(880, now)

    gain.gain.setValueAtTime(0.12, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.05)
  }

  // --- Match Win Celebration ---
  public playWin(): void {
    if (this.muted) return
    const ctx = this.getContext()
    if (!ctx) return

    const now = ctx.currentTime
    const chord = [523.25, 659.25, 783.99, 1046.5, 1318.51]

    chord.forEach((freq, idx) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(freq, now)

      const start = now + idx * 0.12
      gain.gain.setValueAtTime(0.22, start)
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.8)

      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.8)
    })
  }

  // --- Button Click ---
  public playClick(): void {
    if (this.muted) return
    const ctx = this.getContext()
    if (!ctx) return

    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(600, now)

    gain.gain.setValueAtTime(0.08, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.04)
  }
}

export const sound = new SoundEngine()
