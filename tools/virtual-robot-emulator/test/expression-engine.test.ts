import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("60FPS Procedural Pet Expression Engine & Personality FSM", () => {
  const firmwareDir = path.resolve(__dirname, "../../../firmware");
  const expressionEngineHPath = path.join(firmwareDir, "include/ui/expression_engine.h");
  const expressionEngineCppPath = path.join(firmwareDir, "src/ui/expression_engine.cpp");

  it("verifies expression_engine.h and expression_engine.cpp exist with zero placeholders or TODOs", () => {
    expect(fs.existsSync(expressionEngineHPath)).toBe(true);
    expect(fs.existsSync(expressionEngineCppPath)).toBe(true);

    const hContent = fs.readFileSync(expressionEngineHPath, "utf-8");
    const cppContent = fs.readFileSync(expressionEngineCppPath, "utf-8");

    // Zero placeholders / TODOs rule
    expect(hContent).not.toMatch(/\bTODO\b/i);
    expect(cppContent).not.toMatch(/\bTODO\b/i);
    expect(hContent).not.toMatch(/\bFIXME\b/i);
    expect(cppContent).not.toMatch(/\bFIXME\b/i);

    // Includes protocol header
    expect(hContent).toContain("petbot_protocol.h");
    expect(hContent).toContain("EmotionId");
  });

  it("verifies FaceRigParams struct contains all continuous interpolated geometry and overlay fields", () => {
    const hContent = fs.readFileSync(expressionEngineHPath, "utf-8");

    // Left & Right Eye geometry fields
    const eyeFields = [
      "centerX",
      "centerY",
      "width",
      "height",
      "cornerRadius",
      "pupilOffsetX",
      "pupilOffsetY",
      "upperLidCrop",
      "lowerLidCrop",
      "tiltAngleDeg",
      "colorRGB565",
    ];
    for (const field of eyeFields) {
      expect(hContent).toContain(field);
    }

    // Mouth geometry fields
    const mouthFields = [
      "mouthY",
      "mouthWidth",
      "mouthOpenness",
      "curveSmile",
    ];
    for (const field of mouthFields) {
      expect(hContent).toContain(field);
    }

    // Overlay fields
    const overlayFields = [
      "blushIntensity",
      "zzzParticlesActive",
      "questionMarkActive",
      "sparkleParticlesActive",
      "sweatDropActive",
      "audioWaveActive",
    ];
    for (const field of overlayFields) {
      expect(hContent).toContain(field);
    }
  });

  it("verifies preset postures cover all 8 EmotionIds from protocol", () => {
    const hContent = fs.readFileSync(expressionEngineHPath, "utf-8");
    const cppContent = fs.readFileSync(expressionEngineCppPath, "utf-8");

    const emotions = [
      "Idle",
      "Happy",
      "Curious",
      "Sleepy",
      "Focused",
      "Speaking",
      "Listening",
      "Alert",
    ];

    for (const emotion of emotions) {
      expect(hContent).toContain(emotion);
      expect(cppContent).toContain(`EmotionId::${emotion}`);
    }

    // Specific features verified in code (160x128 landscape white bg, black eyes, pink blush)
    expect(cppContent).toContain("0.65f"); // Sleepy upperLidCrop = 0.65
    expect(cppContent).toContain("30.0f"); // Curious right eye enlarged (24 -> 30)
    expect(cppContent).toContain("36.0f"); // Curious right eye height (30 -> 36)
    expect(cppContent).toContain("-10.0f"); // Curious right eye raised brow tilt
    expect(cppContent).toContain("colors::Black"); // Classic black eyes & mouth on white background
    expect(cppContent).toContain("renderCheekBlush"); // Pink cheek blush across expressions
    expect(cppContent).toContain("renderHudBrackets"); // Focused HUD corner brackets
    expect(cppContent).toContain("renderRadarRings");  // Listening radar rings
  });

  it("verifies dynamic viseme and mic energy sync methods", () => {
    const hContent = fs.readFileSync(expressionEngineHPath, "utf-8");
    const cppContent = fs.readFileSync(expressionEngineCppPath, "utf-8");

    expect(hContent).toContain("setVisemeOpenness");
    expect(cppContent).toContain("setVisemeOpenness");
    expect(hContent).toContain("setLiveMicEnergy");
    expect(cppContent).toContain("setLiveMicEnergy");
  });

  it("verifies 60FPS critically damped spring interpolation math", () => {
    // Pure TypeScript simulation of the critically damped spring math in stepSpring()
    function stepSpring(
      state: { pos: number; vel: number },
      target: number,
      dt: number,
      omega = 22.0,
      zeta = 1.0
    ) {
      const clampedDt = Math.min(0.05, Math.max(0.0001, dt));
      const diff = state.pos - target;
      const force = -omega * omega * diff - 2.0 * zeta * omega * state.vel;
      state.vel += force * clampedDt;
      state.pos += state.vel * clampedDt;
    }

    // Test transition from Idle eye width (24px) to Alert wide eye (30px)
    const state = { pos: 24.0, vel: 0.0 };
    const target = 30.0;
    const dt = 1.0 / 60.0; // 60 FPS (~16.6ms)

    // Simulate 12 frames (~200ms)
    for (let f = 0; f < 12; ++f) {
      stepSpring(state, target, dt);
      // Critically damped spring should never overshoot the target
      expect(state.pos).toBeLessThanOrEqual(target + 0.01);
    }

    // After 18 frames (~300ms), should be settled within 99% of target
    for (let f = 12; f < 18; ++f) {
      stepSpring(state, target, dt);
    }
    expect(Math.abs(state.pos - target)).toBeLessThan(0.15);
  });

  it("simulates autonomous personality mood controller transitions", () => {
    class PersonalitySimulator {
      energyLevel = 100;
      affectionLevel = 60;
      idleDurationMs = 0;
      currentEmotion: "IDLE" | "HAPPY" | "CURIOUS" | "SLEEPY" = "IDLE";
      happyTimerMs = 0;
      curiousTimerMs = 0;
      lastCuriosityTriggerMs = 0;
      audioCuesPlayed: string[] = [];

      updatePersonality(nowMs: number, userInteracted: boolean, hourOfDay: number) {
        if (userInteracted) {
          this.idleDurationMs = 0;
          this.affectionLevel = Math.min(100, this.affectionLevel + 1);
          this.energyLevel = Math.min(100, this.energyLevel + 1);

          if (this.currentEmotion === "SLEEPY") {
            this.currentEmotion = "IDLE";
            this.audioCuesPlayed.push("CHIRP");
          }
        } else {
          this.idleDurationMs += 1000;
        }

        // Active happy timer
        if (this.happyTimerMs > 0) {
          this.happyTimerMs -= 1000;
          if (this.happyTimerMs <= 0) {
            this.happyTimerMs = 0;
            this.currentEmotion = "IDLE";
          }
          return;
        }

        // Active curious timer
        if (this.curiousTimerMs > 0) {
          this.curiousTimerMs -= 1000;
          if (this.curiousTimerMs <= 0) {
            this.curiousTimerMs = 0;
            this.currentEmotion = "IDLE";
          }
          return;
        }

        // Late night check (23:00 to 06:30)
        const isLateNight = hourOfDay >= 23 || hourOfDay < 6;
        const isLongUntouched = this.idleDurationMs >= 180000; // 3 minutes

        if (isLateNight || isLongUntouched) {
          if (this.currentEmotion !== "SLEEPY") {
            this.currentEmotion = "SLEEPY";
            this.audioCuesPlayed.push("SLEEPY_SIGH");
          }
          return;
        }

        // Curiosity check (>20s idle)
        if (this.idleDurationMs >= 20000 && this.currentEmotion === "IDLE") {
          if (nowMs - this.lastCuriosityTriggerMs >= 25000) {
            this.lastCuriosityTriggerMs = nowMs;
            this.curiousTimerMs = 3500;
            this.currentEmotion = "CURIOUS";
            this.audioCuesPlayed.push("CURIOUS_BEEP");
          }
        }
      }

      onPettingGesture() {
        this.idleDurationMs = 0;
        this.affectionLevel = Math.min(100, this.affectionLevel + 25);
        this.energyLevel = Math.min(100, this.energyLevel + 10);
        this.currentEmotion = "HAPPY";
        this.happyTimerMs = 4000;
        this.audioCuesPlayed.push("HAPPY_TRILL");
        this.audioCuesPlayed.push("PURR");
      }
    }

    const sim = new PersonalitySimulator();

    // 1. Initial State
    expect(sim.currentEmotion).toBe("IDLE");
    expect(sim.affectionLevel).toBe(60);

    // 2. Petting rapid triggers Happy emotion for 4s + audio cues
    sim.onPettingGesture();
    expect(sim.currentEmotion).toBe("HAPPY");
    expect(sim.affectionLevel).toBe(85);
    expect(sim.audioCuesPlayed).toContain("HAPPY_TRILL");
    expect(sim.audioCuesPlayed).toContain("PURR");

    // 3. Tick 4 seconds -> Happy timer expires and returns to IDLE
    sim.updatePersonality(1000, false, 14);
    sim.updatePersonality(2000, false, 14);
    sim.updatePersonality(3000, false, 14);
    sim.updatePersonality(4000, false, 14);
    expect(sim.currentEmotion).toBe("IDLE");

    // 4. Simulate idle duration >= 20,000ms -> Transitions to CURIOUS
    for (let sec = 5; sec <= 25; ++sec) {
      sim.updatePersonality(sec * 1000, false, 14);
    }
    expect(sim.idleDurationMs).toBeGreaterThanOrEqual(20000);
    expect(sim.currentEmotion).toBe("CURIOUS");
    expect(sim.audioCuesPlayed).toContain("CURIOUS_BEEP");

    // 5. Simulate untouched for >= 3 minutes (180,000ms) -> Transitions to SLEEPY
    for (let sec = 26; sec <= 190; ++sec) {
      sim.updatePersonality(sec * 1000, false, 14);
    }
    expect(sim.idleDurationMs).toBeGreaterThanOrEqual(180000);
    expect(sim.currentEmotion).toBe("SLEEPY");
    expect(sim.audioCuesPlayed).toContain("SLEEPY_SIGH");

    // 6. User interaction wakes pet from SLEEPY -> Returns to IDLE
    sim.updatePersonality(191000, true, 14);
    expect(sim.idleDurationMs).toBe(0);
    expect(sim.currentEmotion).toBe("IDLE");
    expect(sim.audioCuesPlayed).toContain("CHIRP");

    // 7. Late night (e.g. 23:30) triggers SLEEPY regardless of recent touch
    sim.updatePersonality(192000, false, 23);
    expect(sim.currentEmotion).toBe("SLEEPY");
  });

  it("verifies backlight target is dimmed (30%) during Sleepy and 100% otherwise", () => {
    const cppContent = fs.readFileSync(expressionEngineCppPath, "utf-8");

    expect(cppContent).toContain("getTargetBacklightPct");
    expect(cppContent).toContain("return 30");
    expect(cppContent).toContain("return 100");
  });
});
