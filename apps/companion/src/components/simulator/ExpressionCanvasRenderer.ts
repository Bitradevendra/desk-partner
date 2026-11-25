import type { EmotionType } from "@petbot/widget-schema";

export interface FaceRigBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  life: number;
  maxLife: number;
  type: "sparkle" | "zzz" | "question" | "exclamation";
  rotation: number;
  rotSpeed: number;
}

interface EyeTargetState {
  w: number;
  h: number;
  radius: number;
  topLid: number;     // 0 = wide open, 1 = fully closed
  bottomLid: number;  // 0 = open, 1 = fully squinched up
  rotationDeg: number;
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Procedural 60FPS Pet Eye & Face Rig Renderer
 * Operates directly on CanvasRenderingContext2D with spring-interpolated transitions,
 * micro-saccades, blinks, cheek blushes, particles, and viseme mouth movements.
 */
export class ExpressionCanvasRenderer {
  private emotion: EmotionType = "IDLE";
  private baseEmotion: EmotionType = "IDLE";
  private temporaryEmotionTimer = 0;

  // Real-time animation clocks
  private timeSeconds = 0;
  private blinkTimer = 0;
  private nextBlinkDelay = 3.2;
  private isBlinking = false;
  private blinkProgress = 0; // 0 -> 1 -> 0

  // Gaze & Saccade state
  private targetGazeX = 0; // -1 to 1
  private targetGazeY = 0; // -1 to 1
  private currentGazeX = 0;
  private currentGazeY = 0;
  private saccadeTimer = 0;
  private nextSaccadeDelay = 1.8;

  // Mouth / Viseme state
  private mouthOpen = 0;
  private mouthTarget = 0;

  // Cheek blush
  private blushOpacity = 0;
  private blushTarget = 0;

  // Spring interpolated eye properties (Left & Right)
  private leftEye: EyeTargetState = {
    w: 22,
    h: 36,
    radius: 11,
    topLid: 0,
    bottomLid: 0,
    rotationDeg: 0,
    scaleX: 1,
    scaleY: 1,
    offsetX: 0,
    offsetY: 0,
  };

  private rightEye: EyeTargetState = {
    w: 22,
    h: 36,
    radius: 11,
    topLid: 0,
    bottomLid: 0,
    rotationDeg: 0,
    scaleX: 1,
    scaleY: 1,
    offsetX: 0,
    offsetY: 0,
  };

  // Active particle system
  private particles: Particle[] = [];
  private particleSpawnTimer = 0;

  constructor(initialEmotion: EmotionType = "IDLE") {
    this.emotion = initialEmotion;
    this.baseEmotion = initialEmotion;
  }

  public getEmotion(): EmotionType {
    return this.emotion;
  }

  public setEmotion(emotion: EmotionType, durationMs?: number): void {
    if (durationMs && durationMs > 0) {
      this.emotion = emotion;
      this.temporaryEmotionTimer = durationMs / 1000;
    } else {
      this.emotion = emotion;
      this.baseEmotion = emotion;
      this.temporaryEmotionTimer = 0;
    }
  }

  public setGaze(x: number, y: number): void {
    this.targetGazeX = Math.max(-1, Math.min(1, x));
    this.targetGazeY = Math.max(-1, Math.min(1, y));
  }

  public triggerBlink(): void {
    this.isBlinking = true;
    this.blinkProgress = 0;
  }

  /**
   * Main 60FPS update cycle.
   */
  public update(dtSeconds: number): void {
    this.timeSeconds += dtSeconds;

    // Handle temporary emotion expiration
    if (this.temporaryEmotionTimer > 0) {
      this.temporaryEmotionTimer -= dtSeconds;
      if (this.temporaryEmotionTimer <= 0) {
        this.emotion = this.baseEmotion;
      }
    }

    // 1. Procedural Blinking Engine
    this.updateBlinking(dtSeconds);

    // 2. Micro-saccade autonomous wandering
    this.updateSaccades(dtSeconds);

    // 3. Smooth Gaze lerp
    const gazeLerpRate = 1 - Math.exp(-12 * dtSeconds);
    this.currentGazeX += (this.targetGazeX - this.currentGazeX) * gazeLerpRate;
    this.currentGazeY += (this.targetGazeY - this.currentGazeY) * gazeLerpRate;

    // 4. Update Target Parameters based on Current Emotion
    const targets = this.computeEmotionTargets();

    // 5. Spring / Exponential Lerp towards Target Parameters
    const lerpFactor = 1 - Math.exp(-16 * dtSeconds);

    this.interpolateEye(this.leftEye, targets.left, lerpFactor);
    this.interpolateEye(this.rightEye, targets.right, lerpFactor);

    // Apply blink lid override
    if (this.isBlinking) {
      const lidBlink = Math.sin(this.blinkProgress * Math.PI);
      this.leftEye.topLid = Math.max(this.leftEye.topLid, lidBlink);
      this.rightEye.topLid = Math.max(this.rightEye.topLid, lidBlink);
    }

    // 6. Blush interpolation
    this.blushTarget = targets.blush;
    this.blushOpacity += (this.blushTarget - this.blushOpacity) * lerpFactor;

    // 7. Viseme mouth interpolation
    this.mouthTarget = targets.mouth;
    this.mouthOpen += (this.mouthTarget - this.mouthOpen) * lerpFactor;

    // 8. Update floating particles
    this.updateParticles(dtSeconds);
  }

  private updateBlinking(dt: number): void {
    if (this.emotion === "SLEEPY") {
      // Very few blinks when already asleep
      return;
    }

    if (this.isBlinking) {
      this.blinkProgress += dt * 8.0; // ~125ms blink duration
      if (this.blinkProgress >= 1.0) {
        this.isBlinking = false;
        this.blinkProgress = 0;
        this.blinkTimer = 0;
        this.nextBlinkDelay = 2.5 + Math.random() * 3.5;
      }
    } else {
      this.blinkTimer += dt;
      if (this.blinkTimer >= this.nextBlinkDelay) {
        this.triggerBlink();
      }
    }
  }

  private updateSaccades(dt: number): void {
    if (this.emotion === "SLEEPY" || this.emotion === "FOCUSED") {
      return;
    }

    this.saccadeTimer += dt;
    if (this.saccadeTimer >= this.nextSaccadeDelay) {
      this.saccadeTimer = 0;
      this.nextSaccadeDelay = 1.2 + Math.random() * 2.8;

      // Small wandering saccade
      const wanderMagnitude = this.emotion === "ALERT" ? 0.6 : 0.25;
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * wanderMagnitude;
      this.targetGazeX = Math.cos(angle) * dist;
      this.targetGazeY = Math.sin(angle) * dist * 0.5;
    }
  }

  private updateParticles(dt: number): void {
    this.particleSpawnTimer += dt;

    // Spawn particles according to mood
    if (this.emotion === "HAPPY" && this.particleSpawnTimer > 0.45) {
      this.particleSpawnTimer = 0;
      this.spawnParticle("sparkle");
    } else if (this.emotion === "SLEEPY" && this.particleSpawnTimer > 0.8) {
      this.particleSpawnTimer = 0;
      this.spawnParticle("zzz");
    } else if (this.emotion === "CURIOUS" && this.particleSpawnTimer > 1.2) {
      this.particleSpawnTimer = 0;
      this.spawnParticle("question");
    } else if (this.emotion === "ALERT" && this.particleSpawnTimer > 0.9) {
      this.particleSpawnTimer = 0;
      this.spawnParticle("exclamation");
    }

    // Update existing particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.rotSpeed * dt;
      p.life += dt;
      p.alpha = Math.max(0, 1 - p.life / p.maxLife);

      if (p.life >= p.maxLife) {
        this.particles.splice(i, 1);
      }
    }
  }

  private spawnParticle(type: Particle["type"]): void {
    if (this.particles.length > 12) return;

    if (type === "sparkle") {
      const side = Math.random() > 0.5 ? 1 : -1;
      this.particles.push({
        x: 80 + side * (32 + Math.random() * 28),
        y: 54 + (Math.random() * 20 - 10),
        vx: (Math.random() - 0.5) * 10,
        vy: -14 - Math.random() * 16,
        size: 3 + Math.random() * 3,
        alpha: 1,
        life: 0,
        maxLife: 1.0 + Math.random() * 0.6,
        type: "sparkle",
        rotation: Math.random() * Math.PI,
        rotSpeed: (Math.random() - 0.5) * 4,
      });
    } else if (type === "zzz") {
      this.particles.push({
        x: 118 + Math.random() * 12,
        y: 42,
        vx: 8 + Math.random() * 6,
        vy: -10 - Math.random() * 8,
        size: 8 + Math.random() * 3,
        alpha: 1,
        life: 0,
        maxLife: 2.2,
        type: "zzz",
        rotation: 0,
        rotSpeed: 0,
      });
    } else if (type === "question") {
      this.particles.push({
        x: 126,
        y: 36,
        vx: 2,
        vy: -6,
        size: 11,
        alpha: 1,
        life: 0,
        maxLife: 1.8,
        type: "question",
        rotation: 0.15,
        rotSpeed: 0,
      });
    } else if (type === "exclamation") {
      this.particles.push({
        x: 80,
        y: 26,
        vx: 0,
        vy: -5,
        size: 12,
        alpha: 1,
        life: 0,
        maxLife: 1.2,
        type: "exclamation",
        rotation: 0,
        rotSpeed: 0,
      });
    }
  }

  private computeEmotionTargets(): {
    left: EyeTargetState;
    right: EyeTargetState;
    blush: number;
    mouth: number;
  } {
    // Subtle natural breathing oscillation
    const breath = Math.sin(this.timeSeconds * 2.2) * 0.04;

    const base: EyeTargetState = {
      w: 22,
      h: 30 * (1 + breath),
      radius: 11,
      topLid: 0,
      bottomLid: 0,
      rotationDeg: 0,
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
    };

    switch (this.emotion) {
      case "IDLE":
        return {
          left: { ...base },
          right: { ...base },
          blush: 0.58,
          mouth: 0.16,
        };

      case "HAPPY":
        return {
          left: {
            ...base,
            w: 24,
            h: 26,
            topLid: 0.18,
            bottomLid: 0.62, // Joyful upward crescent squint
            rotationDeg: 10,
            scaleY: 0.9,
          },
          right: {
            ...base,
            w: 24,
            h: 26,
            topLid: 0.18,
            bottomLid: 0.62,
            rotationDeg: -10,
            scaleY: 0.9,
          },
          blush: 0.92,
          mouth: 0.45 + Math.sin(this.timeSeconds * 4) * 0.08,
        };

      case "CURIOUS":
        return {
          left: {
            ...base,
            w: 20,
            h: 28,
            topLid: 0.08,
            rotationDeg: -5,
            scaleY: 0.95,
          },
          right: {
            ...base,
            w: 25,
            h: 34, // Asymmetric inquisitive eye
            topLid: 0,
            rotationDeg: 6,
            scaleY: 1.12,
            offsetY: -2,
          },
          blush: 0.42,
          mouth: 0.2,
        };

      case "SLEEPY": {
        const sleepBreath = Math.sin(this.timeSeconds * 1.4) * 0.06;
        return {
          left: {
            ...base,
            w: 22,
            h: 22 * (1 + sleepBreath),
            topLid: 0.72, // Heavy drowsy eyelids
            bottomLid: 0.14,
            rotationDeg: 3,
            scaleY: 0.7,
          },
          right: {
            ...base,
            w: 22,
            h: 22 * (1 + sleepBreath),
            topLid: 0.72,
            bottomLid: 0.14,
            rotationDeg: -3,
            scaleY: 0.7,
          },
          blush: 0.36,
          mouth: 0.09,
        };
      }

      case "FOCUSED":
        return {
          left: {
            ...base,
            w: 23,
            h: 24,
            topLid: 0.44,
            bottomLid: 0.1,
            rotationDeg: -12,
            scaleY: 0.84,
          },
          right: {
            ...base,
            w: 23,
            h: 24,
            topLid: 0.44,
            bottomLid: 0.1,
            rotationDeg: 12,
            scaleY: 0.84,
          },
          blush: 0.18,
          mouth: 0.06,
        };

      case "SPEAKING": {
        const talkMouth = 0.45 + Math.sin(this.timeSeconds * 12) * 0.35;
        const headBob = Math.sin(this.timeSeconds * 12) * 1.2;
        return {
          left: {
            ...base,
            offsetY: headBob,
          },
          right: {
            ...base,
            offsetY: headBob,
          },
          blush: 0.52,
          mouth: Math.max(0.14, talkMouth),
        };
      }

      case "LISTENING": {
        const pulse = Math.sin(this.timeSeconds * 6) * 0.08;
        return {
          left: {
            ...base,
            w: 24,
            h: 32,
            scaleX: 1 + pulse,
            scaleY: 1 + pulse,
          },
          right: {
            ...base,
            w: 24,
            h: 32,
            scaleX: 1 + pulse,
            scaleY: 1 + pulse,
          },
          blush: 0.6,
          mouth: 0.15,
        };
      }

      case "ALERT": {
        const twitch = (Math.random() - 0.5) * 1.0;
        return {
          left: {
            ...base,
            w: 25,
            h: 34,
            radius: 12,
            topLid: 0,
            bottomLid: 0,
            scaleX: 1.12,
            scaleY: 1.12,
            offsetX: twitch,
          },
          right: {
            ...base,
            w: 25,
            h: 34,
            radius: 12,
            topLid: 0,
            bottomLid: 0,
            scaleX: 1.12,
            scaleY: 1.12,
            offsetX: twitch,
          },
          blush: 0.25,
          mouth: 0.4,
        };
      }
    }
  }

  private interpolateEye(
    current: EyeTargetState,
    target: EyeTargetState,
    factor: number
  ): void {
    current.w += (target.w - current.w) * factor;
    current.h += (target.h - current.h) * factor;
    current.radius += (target.radius - current.radius) * factor;
    current.topLid += (target.topLid - current.topLid) * factor;
    current.bottomLid += (target.bottomLid - current.bottomLid) * factor;
    current.rotationDeg += (target.rotationDeg - current.rotationDeg) * factor;
    current.scaleX += (target.scaleX - current.scaleX) * factor;
    current.scaleY += (target.scaleY - current.scaleY) * factor;
    current.offsetX += (target.offsetX - current.offsetX) * factor;
    current.offsetY += (target.offsetY - current.offsetY) * factor;
  }

  /**
   * Render the complete procedural face rig onto the canvas (160x128 landscape reference).
   */
  public render(ctx: CanvasRenderingContext2D, bounds?: FaceRigBounds): void {
    const b: FaceRigBounds = bounds ?? { x: 0, y: 0, w: 160, h: 128 };

    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.clip();

    // Scale rig to target bounds (reference rig is 160x128 horizontal landscape)
    const scaleFactor = Math.min(b.w / 160, b.h / 128);
    const centerX = b.x + b.w / 2;
    const centerY = b.y + b.h * 0.44;

    const eyeSeparation = 28 * scaleFactor;
    const maxGazeOffset = 6 * scaleFactor;
    const gazePxX = this.currentGazeX * maxGazeOffset;
    const gazePxY = this.currentGazeY * maxGazeOffset * 0.7;

    // 1. Render Pink Cheek Blushes (under outer cheeks)
    if (this.blushOpacity > 0.01) {
      this.renderCheekBlush(
        ctx,
        centerX - eyeSeparation * 1.18,
        centerY + 19 * scaleFactor,
        10 * scaleFactor,
        this.blushOpacity
      );
      this.renderCheekBlush(
        ctx,
        centerX + eyeSeparation * 1.18,
        centerY + 19 * scaleFactor,
        10 * scaleFactor,
        this.blushOpacity
      );
    }

    // 2. Render Left Eye (Classic Black)
    const leftPosX = centerX - eyeSeparation + gazePxX + this.leftEye.offsetX * scaleFactor;
    const leftPosY = centerY + gazePxY + this.leftEye.offsetY * scaleFactor;
    this.renderSingleEye(ctx, leftPosX, leftPosY, this.leftEye, scaleFactor, -1);

    // 3. Render Right Eye (Classic Black)
    const rightPosX = centerX + eyeSeparation + gazePxX + this.rightEye.offsetX * scaleFactor;
    const rightPosY = centerY + gazePxY + this.rightEye.offsetY * scaleFactor;
    this.renderSingleEye(ctx, rightPosX, rightPosY, this.rightEye, scaleFactor, 1);

    // 4. Render Classic Expressive Black Mouth (always visible smile or active viseme)
    this.renderClassicMouth(
      ctx,
      centerX + gazePxX * 0.5,
      centerY + 23 * scaleFactor + gazePxY * 0.5,
      scaleFactor
    );

    // 5. Render Subtle Particles
    this.renderParticles(ctx, b, scaleFactor);

    ctx.restore();
  }

  private renderSingleEye(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    state: EyeTargetState,
    scale: number,
    side: -1 | 1
  ): void {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((state.rotationDeg * Math.PI) / 180);
    ctx.scale(state.scaleX, state.scaleY);

    const w = state.w * scale;
    const h = state.h * scale;
    const r = Math.min(state.radius * scale, w / 2, h / 2);

    ctx.shadowBlur = 0;

    // 1. Clip to rounded eye capsule
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, [r, r, r, r]);
    ctx.clip();

    // 2. Apply background-agnostic eyelid aperture clip (works cleanly on white or dark screens!)
    if (state.topLid > 0.01 || state.bottomLid > 0.01) {
      const topCut = -h / 2 + h * Math.min(0.96, state.topLid);
      const botCut = h / 2 - h * Math.min(0.96, state.bottomLid);
      ctx.beginPath();
      if (state.bottomLid > 0.45) {
        // Curved cheerful arch aperture (^ ^)
        const archPeak = topCut + (botCut - topCut) * 0.35;
        ctx.moveTo(-w, topCut);
        ctx.lineTo(w, topCut);
        ctx.lineTo(w, botCut + 3 * scale);
        ctx.quadraticCurveTo(0, archPeak - 5 * scale, -w, botCut + 3 * scale);
      } else {
        ctx.rect(-w, topCut, w * 2, Math.max(2 * scale, botCut - topCut));
      }
      ctx.closePath();
      ctx.clip();
    }

    // 3. Solid Classic Black Iris (#111111)
    ctx.fillStyle = this.emotion === "ALERT" ? "#1C1917" : "#111111";
    ctx.fillRect(-w / 2 - 2, -h / 2 - 2, w + 4, h + 4);

    // 4. Crisp White Eye Catchlights
    if (state.topLid < 0.72) {
      ctx.beginPath();
      ctx.arc((side * 1.5 + 3.2) * scale, -h * 0.2, 2.7 * scale, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
      ctx.fill();

      ctx.beginPath();
      ctx.arc((-side * 1.5 - 2.2) * scale, h * 0.16, 1.3 * scale, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.68)";
      ctx.fill();
    }

    ctx.restore();
  }

  private renderCheekBlush(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    opacity: number
  ): void {
    ctx.save();
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0, `rgba(255, 110, 165, ${0.58 * opacity})`);
    grad.addColorStop(0.55, `rgba(255, 130, 178, ${0.3 * opacity})`);
    grad.addColorStop(1, "rgba(255, 130, 178, 0)");

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, radius * 1.25, radius * 0.78, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private renderClassicMouth(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    scale: number
  ): void {
    ctx.save();
    ctx.shadowBlur = 0;

    if (this.mouthOpen > 0.24) {
      // Open expressive black mouth with warm pink tongue
      const mouthW = 16 * scale;
      const mouthH = Math.max(4 * scale, 10 * this.mouthOpen * scale);

      ctx.fillStyle = "#111111";
      ctx.beginPath();
      ctx.ellipse(cx, cy + 1 * scale, mouthW / 2, mouthH / 2, 0, 0, Math.PI * 2);
      ctx.fill();

      // Inner warm pink tongue at bottom of mouth cavity
      ctx.fillStyle = "#FF84A8";
      ctx.beginPath();
      ctx.ellipse(
        cx,
        cy + (1 + mouthH * 0.18 / scale) * scale,
        (mouthW / 2) * 0.62,
        Math.max(1.5 * scale, (mouthH / 2) * 0.45),
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();
    } else if (this.emotion === "FOCUSED" || this.emotion === "SLEEPY") {
      // Gentle calm short line / flat smirk
      const hw = 7 * scale;
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = Math.max(1.8, 2.2 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - hw, cy);
      ctx.quadraticCurveTo(cx, cy + 2 * scale, cx + hw, cy);
      ctx.stroke();
    } else {
      // Classic cute curved black smile (Idle, Curious, Listening)
      const hw = 9 * scale;
      const smileDepth = this.emotion === "CURIOUS" ? 3 * scale : 5.5 * scale;
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = Math.max(2, 2.4 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - hw, cy - 1 * scale);
      ctx.quadraticCurveTo(cx, cy + smileDepth, cx + hw, cy - 1 * scale);
      ctx.stroke();
    }

    ctx.restore();
  }

  private renderParticles(
    ctx: CanvasRenderingContext2D,
    bounds: FaceRigBounds,
    scale: number
  ): void {
    for (const p of this.particles) {
      ctx.save();
      ctx.translate(bounds.x + p.x * (bounds.w / 160), bounds.y + p.y * (bounds.h / 128));
      ctx.rotate(p.rotation);
      ctx.globalAlpha = p.alpha;
      ctx.shadowBlur = 0;

      if (p.type === "sparkle") {
        ctx.fillStyle = "#111111";

        // Crisp subtle twinkle diamond
        const s = p.size * scale;
        ctx.beginPath();
        ctx.moveTo(0, -s);
        ctx.quadraticCurveTo(0, 0, s, 0);
        ctx.quadraticCurveTo(0, 0, 0, s);
        ctx.quadraticCurveTo(0, 0, -s, 0);
        ctx.quadraticCurveTo(0, 0, 0, -s);
        ctx.closePath();
        ctx.fill();
      } else if (p.type === "zzz") {
        ctx.fillStyle = "#3F3F46";
        ctx.font = `bold ${Math.round(p.size * scale)}px 'JetBrains Mono', monospace`;
        ctx.fillText("Z", 0, 0);
      } else if (p.type === "question") {
        ctx.fillStyle = "#111111";
        ctx.font = `bold ${Math.round(p.size * scale)}px 'JetBrains Mono', monospace`;
        ctx.fillText("?", 0, 0);
      } else if (p.type === "exclamation") {
        ctx.fillStyle = "#DC2626";
        ctx.font = `bold ${Math.round(p.size * scale)}px 'JetBrains Mono', monospace`;
        ctx.fillText("!", 0, 0);
      }

      ctx.restore();
    }
  }
}
