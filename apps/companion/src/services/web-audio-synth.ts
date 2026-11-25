/**
 * ============================================================================
 * Web Audio API Procedural Synthesizer
 * Mirrors the ESP32-S3 AudioHal hardware sound engine with zero external dependencies.
 * Generates expressive procedural chirps, trills, purrs, and clicks for real-time haptics.
 * ============================================================================
 */

export type PetSoundEffect =
  | "CHIRP"
  | "HAPPY_TRILL"
  | "PURR"
  | "CURIOUS_BEEP"
  | "SLEEPY_SIGH"
  | "TICK"
  | "SUCCESS"
  | "WARNING";

export class WebAudioSynth {
  private static instance: WebAudioSynth | null = null;

  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private isMutedState = false;
  private volumeLevel = 0.65;
  private isUnlocked = false;

  private constructor() {
    this.setupAutoUnlock();
  }

  public static getInstance(): WebAudioSynth {
    if (!WebAudioSynth.instance) {
      WebAudioSynth.instance = new WebAudioSynth();
    }
    return WebAudioSynth.instance;
  }

  /**
   * Automatically unlocks AudioContext upon user's first physical interaction.
   */
  private setupAutoUnlock(): void {
    if (typeof window === "undefined") return;

    const unlockHandler = () => {
      this.ensureContext();
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume().then(() => {
          this.isUnlocked = true;
        }).catch(() => {
          // Ignore browser restriction errors
        });
      } else {
        this.isUnlocked = true;
      }

      window.removeEventListener("pointerdown", unlockHandler);
      window.removeEventListener("keydown", unlockHandler);
      window.removeEventListener("touchstart", unlockHandler);
    };

    window.addEventListener("pointerdown", unlockHandler, { once: true, passive: true });
    window.addEventListener("keydown", unlockHandler, { once: true, passive: true });
    window.addEventListener("touchstart", unlockHandler, { once: true, passive: true });
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === "undefined") return null;

    if (!this.ctx) {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtxClass) return null;

      try {
        this.ctx = new AudioCtxClass();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.setValueAtTime(this.isMutedState ? 0 : this.volumeLevel, this.ctx.currentTime);
        this.masterGain.connect(this.ctx.destination);
      } catch {
        return null;
      }
    }

    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }

    return this.ctx;
  }

  public getVolume(): number {
    return this.volumeLevel;
  }

  public setVolume(val: number): void {
    this.volumeLevel = Math.max(0, Math.min(1, val));
    if (this.masterGain && this.ctx && !this.isMutedState) {
      this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.masterGain.gain.setValueAtTime(this.volumeLevel, this.ctx.currentTime);
    }
  }

  public isMuted(): boolean {
    return this.isMutedState;
  }

  public setMuted(muted: boolean): void {
    this.isMutedState = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.masterGain.gain.setValueAtTime(
        this.isMutedState ? 0 : this.volumeLevel,
        this.ctx.currentTime
      );
    }
  }

  public toggleMute(): boolean {
    this.setMuted(!this.isMutedState);
    return this.isMutedState;
  }

  /**
   * Plays a designated robot sound effect.
   */
  public play(effect: PetSoundEffect): void {
    if (this.isMutedState) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    try {
      switch (effect) {
        case "CHIRP":
          this.synthesizeChirp(ctx);
          break;
        case "HAPPY_TRILL":
          this.synthesizeHappyTrill(ctx);
          break;
        case "PURR":
          this.synthesizePurr(ctx);
          break;
        case "CURIOUS_BEEP":
          this.synthesizeCuriousBeep(ctx);
          break;
        case "SLEEPY_SIGH":
          this.synthesizeSleepySigh(ctx);
          break;
        case "TICK":
          this.synthesizeTick(ctx);
          break;
        case "SUCCESS":
          this.synthesizeSuccess(ctx);
          break;
        case "WARNING":
          this.synthesizeWarning(ctx);
          break;
      }
    } catch {
      // Audio synthesis should never crash UI
    }
  }

  /**
   * Arbitrary frequency tone player (for widget rules specifying custom frequency & duration).
   */
  public playTone(
    frequencyHz: number,
    durationMs: number,
    type: OscillatorType = "sine"
  ): void {
    if (this.isMutedState) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;

    try {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(Math.max(20, Math.min(20000, frequencyHz)), now);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.3, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + durationMs / 1000);

      osc.connect(gain);
      gain.connect(this.masterGain);

      osc.start(now);
      osc.stop(now + durationMs / 1000 + 0.05);
    } catch {
      // Graceful fallback
    }
  }

  // ============================================================================
  // Procedural Sound Synthesis Algorithms
  // ============================================================================

  /**
   * CHIRP: Upward cheerful frequency sweep (1200Hz -> 2600Hz) with fast exponential decay.
   */
  private synthesizeChirp(ctx: AudioContext): void {
    if (!this.masterGain) return;
    const master = this.masterGain;
    const now = ctx.currentTime;
    const duration = 0.12;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.exponentialRampToValueAtTime(2600, now + duration * 0.7);
    osc.frequency.exponentialRampToValueAtTime(2200, now + duration);

    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.4, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(master);

    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /**
   * HAPPY_TRILL: Rapid 4-note ascending robotic arpeggio (A5 -> D6 -> F#6 -> A6).
   */
  private synthesizeHappyTrill(ctx: AudioContext): void {
    if (!this.masterGain) return;
    const master = this.masterGain;
    const now = ctx.currentTime;
    const notes = [880, 1175, 1480, 1760];
    const noteDuration = 0.06;

    notes.forEach((freq, idx) => {
      const noteStart = now + idx * noteDuration;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, noteStart);
      osc.frequency.linearRampToValueAtTime(freq * 1.05, noteStart + noteDuration);

      gain.gain.setValueAtTime(0.01, noteStart);
      gain.gain.linearRampToValueAtTime(0.35, noteStart + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, noteStart + noteDuration);

      osc.connect(gain);
      gain.connect(master);

      osc.start(noteStart);
      osc.stop(noteStart + noteDuration + 0.02);
    });
  }

  /**
   * PURR: 65Hz warm tone with 22Hz tremolo amplitude modulation simulating feline motor.
   */
  private synthesizePurr(ctx: AudioContext): void {
    if (!this.masterGain) return;
    const now = ctx.currentTime;
    const duration = 0.55;

    // Carrier
    const carrier = ctx.createOscillator();
    carrier.type = "sine";
    carrier.frequency.setValueAtTime(65, now);
    carrier.frequency.linearRampToValueAtTime(70, now + duration * 0.5);
    carrier.frequency.linearRampToValueAtTime(62, now + duration);

    // Tremolo LFO
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.setValueAtTime(22, now); // 22Hz motor vibration

    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(0.2, now);

    const purrGain = ctx.createGain();
    purrGain.gain.setValueAtTime(0.01, now);
    purrGain.gain.linearRampToValueAtTime(0.25, now + 0.08);
    purrGain.gain.exponentialRampToValueAtTime(0.01, now + duration);

    // Connect LFO to gain
    lfo.connect(lfoGain);
    lfoGain.connect(purrGain.gain);

    carrier.connect(purrGain);
    purrGain.connect(this.masterGain);

    carrier.start(now);
    lfo.start(now);
    carrier.stop(now + duration);
    lfo.stop(now + duration);
  }

  /**
   * CURIOUS_BEEP: Two-tone inquisitive rising pitch (680Hz -> 1350Hz).
   */
  private synthesizeCuriousBeep(ctx: AudioContext): void {
    if (!this.masterGain) return;
    const now = ctx.currentTime;

    // First inquiry tone
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(680, now);
    gain1.gain.setValueAtTime(0.01, now);
    gain1.gain.linearRampToValueAtTime(0.3, now + 0.01);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc1.connect(gain1);
    gain1.connect(this.masterGain);
    osc1.start(now);
    osc1.stop(now + 0.09);

    // Second upward pitch sweep tone
    const start2 = now + 0.1;
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(950, start2);
    osc2.frequency.exponentialRampToValueAtTime(1420, start2 + 0.14);

    gain2.gain.setValueAtTime(0.01, start2);
    gain2.gain.linearRampToValueAtTime(0.38, start2 + 0.02);
    gain2.gain.exponentialRampToValueAtTime(0.001, start2 + 0.16);

    osc2.connect(gain2);
    gain2.connect(this.masterGain);
    osc2.start(start2);
    osc2.stop(start2 + 0.18);
  }

  /**
   * SLEEPY_SIGH: Downward gentle sweep with warm low-pass filtered breath.
   */
  private synthesizeSleepySigh(ctx: AudioContext): void {
    if (!this.masterGain) return;
    const now = ctx.currentTime;
    const duration = 0.75;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(160, now + duration);

    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.15);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  /**
   * TICK: Crisp tactile 1800Hz snap with instantaneous 12ms decay.
   */
  private synthesizeTick(ctx: AudioContext): void {
    if (!this.masterGain) return;
    const now = ctx.currentTime;
    const duration = 0.018;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(1950, now);
    osc.frequency.exponentialRampToValueAtTime(700, now + duration);

    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(now);
    osc.stop(now + duration + 0.01);
  }

  /**
   * SUCCESS: Uplifting 3-chord fanfare (C5 -> G5 -> C6).
   */
  private synthesizeSuccess(ctx: AudioContext): void {
    if (!this.masterGain) return;
    const master = this.masterGain;
    const now = ctx.currentTime;
    const notes = [523.25, 783.99, 1046.5];
    const offsets = [0, 0.1, 0.22];
    const durations = [0.12, 0.14, 0.3];

    notes.forEach((freq, idx) => {
      const offset = offsets[idx] ?? 0;
      const dur = durations[idx] ?? 0.15;
      const start = now + offset;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, start);

      gain.gain.setValueAtTime(0.01, start);
      gain.gain.linearRampToValueAtTime(0.35, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);

      osc.connect(gain);
      gain.connect(master);

      osc.start(start);
      osc.stop(start + dur + 0.03);
    });
  }

  /**
   * WARNING: Discordant dual pulse warning beeps (880Hz + 830Hz).
   */
  private synthesizeWarning(ctx: AudioContext): void {
    if (!this.masterGain) return;
    const master = this.masterGain;
    const now = ctx.currentTime;
    const pulses = [0, 0.14];

    pulses.forEach((pulseStart) => {
      const start = now + pulseStart;
      const dur = 0.09;

      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = "sawtooth";
      osc2.type = "sawtooth";
      osc1.frequency.setValueAtTime(880, start);
      osc2.frequency.setValueAtTime(835, start);

      gain.gain.setValueAtTime(0.01, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(master);

      osc1.start(start);
      osc2.start(start);
      osc1.stop(start + dur + 0.02);
      osc2.stop(start + dur + 0.02);
    });
  }
}

export const webAudioSynth = WebAudioSynth.getInstance();
