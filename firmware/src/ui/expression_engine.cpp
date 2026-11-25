/**
 * UI Subsystem - 60FPS Procedural Pet Expression Renderer & Autonomous Personality Engine
 * 
 * 100% complete C++20 implementation with spring-physics interpolation,
 * 8 EmotionId target postures, procedural saccades, blinking, particle systems,
 * and autonomous personality state machine. Zero dynamic allocations.
 */
#include "ui/expression_engine.h"
#include <cstring>
#include <cmath>
#include <algorithm>

#ifdef ESP32
#include <Arduino.h>
#include <esp_random.h>
#else
#include <cstdlib>
inline uint32_t esp_random() { return static_cast<uint32_t>(rand()); }
inline uint32_t millis() { return 0; }
#endif

namespace petbot::firmware::ui {

// ============================================================================
// Math & Physics Helpers
// ============================================================================

namespace {

inline void stepSpring(float& pos, float& vel, float target, float dt, float omega = 22.0f, float zeta = 1.0f) noexcept {
    if (dt > 0.05f) dt = 0.05f;
    if (dt <= 0.0001f) return;
    const float diff = pos - target;
    const float force = -omega * omega * diff - 2.0f * zeta * omega * vel;
    vel += force * dt;
    pos += vel * dt;
}

inline uint16_t lerpColor565(uint16_t c1, uint16_t c2, float t) noexcept {
    if (t <= 0.0f) return c1;
    if (t >= 1.0f) return c2;

    const uint32_t r1 = (c1 >> 11) & 0x1F;
    const uint32_t g1 = (c1 >> 5)  & 0x3F;
    const uint32_t b1 = c1 & 0x1F;

    const uint32_t r2 = (c2 >> 11) & 0x1F;
    const uint32_t g2 = (c2 >> 5)  & 0x3F;
    const uint32_t b2 = c2 & 0x1F;

    const uint32_t r = static_cast<uint32_t>(r1 + (r2 - r1) * t);
    const uint32_t g = static_cast<uint32_t>(g1 + (g2 - g1) * t);
    const uint32_t b = static_cast<uint32_t>(b1 + (b2 - b1) * t);

    return static_cast<uint16_t>((r << 11) | (g << 5) | b);
}

} // namespace

// ============================================================================
// Singleton & Lifecycle
// ============================================================================

ExpressionEngine& ExpressionEngine::instance() noexcept {
    static ExpressionEngine s_instance;
    return s_instance;
}

ExpressionEngine::ExpressionEngine() noexcept {
#ifdef ESP32
    mutex_ = xSemaphoreCreateMutex();
#endif
    currentRig_ = getPresetPosture(EmotionId::Idle);
    targetRig_ = currentRig_;
    currentRig_.copyOverlaysToFlat();
    targetRig_.copyOverlaysToFlat();
}

void ExpressionEngine::init() noexcept {
#ifdef ESP32
    if (mutex_ == nullptr) {
        mutex_ = xSemaphoreCreateMutex();
    }
#endif

    currentEmotion_ = EmotionId::Idle;
    currentRig_ = getPresetPosture(EmotionId::Idle);
    targetRig_ = currentRig_;
    currentRig_.copyOverlaysToFlat();
    targetRig_.copyOverlaysToFlat();

    std::memset(&velocities_, 0, sizeof(velocities_));

    energyLevel_ = 100;
    affectionLevel_ = 65;
    idleDurationMs_ = 0;
    lastPersonalityUpdateMs_ = 0;
    happyTimerMs_ = 0;
    curiousTimerMs_ = 0;
    lastCuriosityTriggerMs_ = 0;

    visemeOpenness_ = 0.0f;
    visemeGazeX_ = 0.0f;
    visemeGazeY_ = 0.0f;
    liveMicEnergy_ = 0;

    nextSaccadeMs_ = 2500;
    saccadeTargetX_ = 0.0f;
    saccadeTargetY_ = 0.0f;
    saccadeDurationMs_ = 0.0f;
    nextBlinkMs_ = 3500;
    isBlinking_ = false;
    blinkProgress_ = 0.0f;
    blinkDurationSec_ = 0.16f;
    isDoubleBlink_ = false;
    lastUpdateMs_ = 0;

    // Initialize Zzz particles (160x128 landscape)
    for (size_t i = 0; i < MAX_ZZZ_PARTICLES; ++i) {
        zzzParticles_[i].x = 122.0f + static_cast<float>(i * 7);
        zzzParticles_[i].y = 42.0f - static_cast<float>(i * 9);
        zzzParticles_[i].progress = static_cast<float>(i) / static_cast<float>(MAX_ZZZ_PARTICLES);
        zzzParticles_[i].speed = 0.25f + static_cast<float>(i) * 0.05f;
        zzzParticles_[i].alpha = 0.0f;
        zzzParticles_[i].size = (i % 2 == 0) ? 1 : 2;
        zzzParticles_[i].active = false;
    }

    // Initialize Sparkle particles (160x128 landscape, dark contrast on white face)
    const float sparkleCoords[MAX_SPARKLE_PARTICLES][2] = {
        {20.0f, 38.0f}, {140.0f, 38.0f}, {22.0f, 80.0f},
        {138.0f, 80.0f}, {36.0f, 24.0f}, {124.0f, 24.0f}
    };
    for (size_t i = 0; i < MAX_SPARKLE_PARTICLES; ++i) {
        sparkleParticles_[i].x = sparkleCoords[i][0];
        sparkleParticles_[i].y = sparkleCoords[i][1];
        sparkleParticles_[i].phase = static_cast<float>(i) * 1.047f; // ~60 deg offsets
        sparkleParticles_[i].scale = 0.0f;
        sparkleParticles_[i].color = colors::DarkGray;
        sparkleParticles_[i].active = false;
    }

#ifdef ESP32
    Serial.println("[ExpressionEngine] Initialized 60FPS procedural expression engine.");
#endif
}

// ============================================================================
// Posture Presets for Every EmotionId
// ============================================================================

FaceRigParams ExpressionEngine::getPresetPosture(EmotionId emotion) noexcept {
    FaceRigParams rig{};

    switch (emotion) {
        case EmotionId::Happy: {
            // Classic black crescent eyes (^ ^), warm pink cheek blush, sparkles, cheerful smile on white
            rig.leftEye.centerX       = 52.0f;
            rig.leftEye.centerY       = 56.0f;
            rig.leftEye.width         = 28.0f;
            rig.leftEye.height        = 28.0f;
            rig.leftEye.cornerRadius  = 11.0f;
            rig.leftEye.pupilOffsetX  = 0.0f;
            rig.leftEye.pupilOffsetY  = -1.0f;
            rig.leftEye.upperLidCrop  = 0.0f;
            rig.leftEye.lowerLidCrop  = 0.68f;
            rig.leftEye.tiltAngleDeg  = 6.0f;
            rig.leftEye.colorRGB565   = colors::Black;

            rig.rightEye.centerX      = 108.0f;
            rig.rightEye.centerY      = 56.0f;
            rig.rightEye.width        = 28.0f;
            rig.rightEye.height       = 28.0f;
            rig.rightEye.cornerRadius = 11.0f;
            rig.rightEye.pupilOffsetX = 0.0f;
            rig.rightEye.pupilOffsetY = -1.0f;
            rig.rightEye.upperLidCrop = 0.0f;
            rig.rightEye.lowerLidCrop = 0.68f;
            rig.rightEye.tiltAngleDeg = -6.0f;
            rig.rightEye.colorRGB565  = colors::Black;

            rig.mouth.mouthY          = 88.0f;
            rig.mouth.mouthWidth      = 26.0f;
            rig.mouth.mouthOpenness   = 0.30f;
            rig.mouth.curveSmile      = 0.92f;

            rig.overlays.blushIntensity         = 0.90f;
            rig.overlays.sparkleParticlesActive = true;
            break;
        }

        case EmotionId::Curious: {
            // Asymmetric black eyes: left eye normal, right eye enlarged +25% with raised brow tilt, ? icon
            rig.leftEye.centerX       = 52.0f;
            rig.leftEye.centerY       = 57.0f;
            rig.leftEye.width         = 24.0f;
            rig.leftEye.height        = 30.0f;
            rig.leftEye.cornerRadius  = 10.0f;
            rig.leftEye.pupilOffsetX  = 3.0f;
            rig.leftEye.pupilOffsetY  = -2.5f;
            rig.leftEye.upperLidCrop  = 0.05f;
            rig.leftEye.lowerLidCrop  = 0.0f;
            rig.leftEye.tiltAngleDeg  = 4.0f;
            rig.leftEye.colorRGB565   = colors::Black;

            rig.rightEye.centerX      = 108.0f;
            rig.rightEye.centerY      = 52.0f;
            rig.rightEye.width        = 30.0f;
            rig.rightEye.height       = 36.0f;
            rig.rightEye.cornerRadius = 12.0f;
            rig.rightEye.pupilOffsetX = 3.0f;
            rig.rightEye.pupilOffsetY = -2.5f;
            rig.rightEye.upperLidCrop = 0.0f;
            rig.rightEye.lowerLidCrop = 0.0f;
            rig.rightEye.tiltAngleDeg = -10.0f;
            rig.rightEye.colorRGB565  = colors::Black;

            rig.mouth.mouthY          = 90.0f;
            rig.mouth.mouthWidth      = 16.0f;
            rig.mouth.mouthOpenness   = 0.16f;
            rig.mouth.curveSmile      = 0.25f;

            rig.overlays.blushIntensity     = 0.42f;
            rig.overlays.questionMarkActive = true;
            break;
        }

        case EmotionId::Sleepy: {
            // Half-closed heavy eyelids, droopy gaze, rising Zzz particles, gentle blush
            rig.leftEye.centerX       = 52.0f;
            rig.leftEye.centerY       = 58.0f;
            rig.leftEye.width         = 24.0f;
            rig.leftEye.height        = 26.0f;
            rig.leftEye.cornerRadius  = 9.0f;
            rig.leftEye.pupilOffsetX  = 0.0f;
            rig.leftEye.pupilOffsetY  = 4.0f;
            rig.leftEye.upperLidCrop  = 0.65f;
            rig.leftEye.lowerLidCrop  = 0.15f;
            rig.leftEye.tiltAngleDeg  = 0.0f;
            rig.leftEye.colorRGB565   = colors::Black;

            rig.rightEye.centerX      = 108.0f;
            rig.rightEye.centerY      = 58.0f;
            rig.rightEye.width        = 24.0f;
            rig.rightEye.height       = 26.0f;
            rig.rightEye.cornerRadius = 9.0f;
            rig.rightEye.pupilOffsetX = 0.0f;
            rig.rightEye.pupilOffsetY = 4.0f;
            rig.rightEye.upperLidCrop = 0.65f;
            rig.rightEye.lowerLidCrop = 0.15f;
            rig.rightEye.tiltAngleDeg = 0.0f;
            rig.rightEye.colorRGB565  = colors::Black;

            rig.mouth.mouthY          = 90.0f;
            rig.mouth.mouthWidth      = 16.0f;
            rig.mouth.mouthOpenness   = 0.08f;
            rig.mouth.curveSmile      = 0.0f;

            rig.overlays.blushIntensity     = 0.35f;
            rig.overlays.zzzParticlesActive = true;
            break;
        }

        case EmotionId::Focused: {
            // Sharp narrowed black eyes, steady gaze, corner brackets
            rig.leftEye.centerX       = 53.0f;
            rig.leftEye.centerY       = 56.0f;
            rig.leftEye.width         = 28.0f;
            rig.leftEye.height        = 19.0f;
            rig.leftEye.cornerRadius  = 5.0f;
            rig.leftEye.pupilOffsetX  = 0.0f;
            rig.leftEye.pupilOffsetY  = 0.0f;
            rig.leftEye.upperLidCrop  = 0.12f;
            rig.leftEye.lowerLidCrop  = 0.10f;
            rig.leftEye.tiltAngleDeg  = -5.0f;
            rig.leftEye.colorRGB565   = colors::Black;

            rig.rightEye.centerX      = 107.0f;
            rig.rightEye.centerY      = 56.0f;
            rig.rightEye.width        = 28.0f;
            rig.rightEye.height       = 19.0f;
            rig.rightEye.cornerRadius = 5.0f;
            rig.rightEye.pupilOffsetX = 0.0f;
            rig.rightEye.pupilOffsetY = 0.0f;
            rig.rightEye.upperLidCrop = 0.12f;
            rig.rightEye.lowerLidCrop = 0.10f;
            rig.rightEye.tiltAngleDeg = 5.0f;
            rig.rightEye.colorRGB565  = colors::Black;

            rig.mouth.mouthY          = 89.0f;
            rig.mouth.mouthWidth      = 16.0f;
            rig.mouth.mouthOpenness   = 0.0f;
            rig.mouth.curveSmile      = 0.0f;

            rig.overlays.blushIntensity = 0.18f;
            break;
        }

        case EmotionId::Speaking: {
            // Animated speaking mouth with pink tongue, expressive bounce, blush
            rig.leftEye.centerX       = 52.0f;
            rig.leftEye.centerY       = 56.0f;
            rig.leftEye.width         = 26.0f;
            rig.leftEye.height        = 32.0f;
            rig.leftEye.cornerRadius  = 11.0f;
            rig.leftEye.pupilOffsetX  = 0.0f;
            rig.leftEye.pupilOffsetY  = 0.0f;
            rig.leftEye.upperLidCrop  = 0.0f;
            rig.leftEye.lowerLidCrop  = 0.0f;
            rig.leftEye.tiltAngleDeg  = 0.0f;
            rig.leftEye.colorRGB565   = colors::Black;

            rig.rightEye.centerX      = 108.0f;
            rig.rightEye.centerY      = 56.0f;
            rig.rightEye.width        = 26.0f;
            rig.rightEye.height       = 32.0f;
            rig.rightEye.cornerRadius = 11.0f;
            rig.rightEye.pupilOffsetX = 0.0f;
            rig.rightEye.pupilOffsetY = 0.0f;
            rig.rightEye.upperLidCrop = 0.0f;
            rig.rightEye.lowerLidCrop = 0.0f;
            rig.rightEye.tiltAngleDeg = 0.0f;
            rig.rightEye.colorRGB565  = colors::Black;

            rig.mouth.mouthY          = 88.0f;
            rig.mouth.mouthWidth      = 20.0f;
            rig.mouth.mouthOpenness   = 0.42f;
            rig.mouth.curveSmile      = 0.35f;

            rig.overlays.blushIntensity  = 0.50f;
            rig.overlays.audioWaveActive = true;
            break;
        }

        case EmotionId::Listening: {
            // Attentive wide black eyes with pink blush and gentle audio rings
            rig.leftEye.centerX       = 52.0f;
            rig.leftEye.centerY       = 55.0f;
            rig.leftEye.width         = 28.0f;
            rig.leftEye.height        = 34.0f;
            rig.leftEye.cornerRadius  = 12.0f;
            rig.leftEye.pupilOffsetX  = 0.0f;
            rig.leftEye.pupilOffsetY  = -1.5f;
            rig.leftEye.upperLidCrop  = 0.0f;
            rig.leftEye.lowerLidCrop  = 0.0f;
            rig.leftEye.tiltAngleDeg  = 0.0f;
            rig.leftEye.colorRGB565   = colors::Black;

            rig.rightEye.centerX      = 108.0f;
            rig.rightEye.centerY      = 55.0f;
            rig.rightEye.width        = 28.0f;
            rig.rightEye.height       = 34.0f;
            rig.rightEye.cornerRadius = 12.0f;
            rig.rightEye.pupilOffsetX = 0.0f;
            rig.rightEye.pupilOffsetY = -1.5f;
            rig.rightEye.upperLidCrop = 0.0f;
            rig.rightEye.lowerLidCrop = 0.0f;
            rig.rightEye.tiltAngleDeg = 0.0f;
            rig.rightEye.colorRGB565  = colors::Black;

            rig.mouth.mouthY          = 89.0f;
            rig.mouth.mouthWidth      = 16.0f;
            rig.mouth.mouthOpenness   = 0.12f;
            rig.mouth.curveSmile      = 0.20f;

            rig.overlays.blushIntensity  = 0.60f;
            rig.overlays.audioWaveActive = true;
            break;
        }

        case EmotionId::Alert: {
            // Wide startled black eyes with sweat drop and surprised gasp
            rig.leftEye.centerX       = 52.0f;
            rig.leftEye.centerY       = 54.0f;
            rig.leftEye.width         = 30.0f;
            rig.leftEye.height        = 35.0f;
            rig.leftEye.cornerRadius  = 13.0f;
            rig.leftEye.pupilOffsetX  = 0.0f;
            rig.leftEye.pupilOffsetY  = 0.0f;
            rig.leftEye.upperLidCrop  = 0.0f;
            rig.leftEye.lowerLidCrop  = 0.0f;
            rig.leftEye.tiltAngleDeg  = 0.0f;
            rig.leftEye.colorRGB565   = colors::Black;

            rig.rightEye.centerX      = 108.0f;
            rig.rightEye.centerY      = 54.0f;
            rig.rightEye.width        = 30.0f;
            rig.rightEye.height       = 35.0f;
            rig.rightEye.cornerRadius = 13.0f;
            rig.rightEye.pupilOffsetX = 0.0f;
            rig.rightEye.pupilOffsetY = 0.0f;
            rig.rightEye.upperLidCrop = 0.0f;
            rig.rightEye.lowerLidCrop = 0.0f;
            rig.rightEye.tiltAngleDeg = 0.0f;
            rig.rightEye.colorRGB565  = colors::Black;

            rig.mouth.mouthY          = 90.0f;
            rig.mouth.mouthWidth      = 20.0f;
            rig.mouth.mouthOpenness   = 0.35f;
            rig.mouth.curveSmile      = -0.40f;

            rig.overlays.blushIntensity  = 0.25f;
            rig.overlays.sweatDropActive = true;
            break;
        }

        case EmotionId::Idle:
        default: {
            // Default cute white background face: solid black eyes with highlights, gentle black smile, soft pink blush
            rig.leftEye.centerX       = 52.0f;
            rig.leftEye.centerY       = 56.0f;
            rig.leftEye.width         = 26.0f;
            rig.leftEye.height        = 32.0f;
            rig.leftEye.cornerRadius  = 11.0f;
            rig.leftEye.pupilOffsetX  = 0.0f;
            rig.leftEye.pupilOffsetY  = 0.0f;
            rig.leftEye.upperLidCrop  = 0.0f;
            rig.leftEye.lowerLidCrop  = 0.0f;
            rig.leftEye.tiltAngleDeg  = 0.0f;
            rig.leftEye.colorRGB565   = colors::Black;

            rig.rightEye.centerX      = 108.0f;
            rig.rightEye.centerY      = 56.0f;
            rig.rightEye.width        = 26.0f;
            rig.rightEye.height       = 32.0f;
            rig.rightEye.cornerRadius = 11.0f;
            rig.rightEye.pupilOffsetX = 0.0f;
            rig.rightEye.pupilOffsetY = 0.0f;
            rig.rightEye.upperLidCrop = 0.0f;
            rig.rightEye.lowerLidCrop = 0.0f;
            rig.rightEye.tiltAngleDeg = 0.0f;
            rig.rightEye.colorRGB565  = colors::Black;

            rig.mouth.mouthY          = 88.0f;
            rig.mouth.mouthWidth      = 20.0f;
            rig.mouth.mouthOpenness   = 0.0f;
            rig.mouth.curveSmile      = 0.45f;

            rig.overlays.blushIntensity = 0.58f;
            break;
        }
    }

    rig.copyOverlaysToFlat();
    return rig;
}

// ============================================================================
// Emotion Transition
// ============================================================================

void ExpressionEngine::setEmotion(EmotionId emotion, bool forceInstant) noexcept {
#ifdef ESP32
    if (mutex_ != nullptr) xSemaphoreTake(mutex_, portMAX_DELAY);
#endif

    currentEmotion_ = emotion;
    targetRig_ = getPresetPosture(emotion);
    targetRig_.copyOverlaysToFlat();

    if (forceInstant) {
        currentRig_ = targetRig_;
        currentRig_.copyOverlaysToFlat();
        std::memset(&velocities_, 0, sizeof(velocities_));
    }

#ifdef ESP32
    if (mutex_ != nullptr) xSemaphoreGive(mutex_);
#endif
}

void ExpressionEngine::setTemporaryEmotion(EmotionId emotion, uint32_t durationMs) noexcept {
    if (!tempEmotionActive_) {
        prevEmotionBeforeTemp_ = currentEmotion_;
    }
    tempEmotionActive_ = true;
    tempEmotionExpiryMs_ = millis() + durationMs;
    setEmotion(emotion);
}

void ExpressionEngine::setVisemeOpenness(uint8_t open, int8_t gazeX, int8_t gazeY) noexcept {
    visemeOpenness_ = static_cast<float>(open) / 255.0f;
    visemeGazeX_ = static_cast<float>(gazeX) * 0.05f;
    visemeGazeY_ = static_cast<float>(gazeY) * 0.04f;

    if (currentEmotion_ == EmotionId::Speaking) {
        targetRig_.mouth.mouthOpenness = visemeOpenness_;
        targetRig_.mouth.mouthWidth = 18.0f + 8.0f * visemeOpenness_;
        targetRig_.leftEye.pupilOffsetX = visemeGazeX_;
        targetRig_.leftEye.pupilOffsetY = visemeGazeY_;
        targetRig_.rightEye.pupilOffsetX = visemeGazeX_;
        targetRig_.rightEye.pupilOffsetY = visemeGazeY_;
    }
}

void ExpressionEngine::setLiveMicEnergy(uint16_t rms) noexcept {
    liveMicEnergy_ = rms;
}

uint8_t ExpressionEngine::getTargetBacklightPct() const noexcept {
    if (currentEmotion_ == EmotionId::Sleepy) {
        return 30; // Dimmed backlight target during sleep
    }
    return 100;
}

// ============================================================================
// Procedural Timers: Blinking & Saccades
// ============================================================================

void ExpressionEngine::updateBlinking(float dt, uint32_t nowMs) noexcept {
    if (isBlinking_) {
        blinkProgress_ += dt / blinkDurationSec_;
        if (blinkProgress_ >= 1.0f) {
            isBlinking_ = false;
            blinkProgress_ = 0.0f;

            if (isDoubleBlink_) {
                // Secondary quick blink after short gap
                isDoubleBlink_ = false;
                nextBlinkMs_ = nowMs + 100;
            } else {
                // Schedule next blink (3.0s to 6.0s)
                nextBlinkMs_ = nowMs + 3000 + (esp_random() % 3000);
                isDoubleBlink_ = ((esp_random() % 4) == 0); // 25% double-blink chance
            }
        }
    } else {
        if (nowMs >= nextBlinkMs_ && currentEmotion_ != EmotionId::Sleepy && currentEmotion_ != EmotionId::Alert) {
            isBlinking_ = true;
            blinkProgress_ = 0.0f;
            blinkDurationSec_ = 0.15f;
        }
    }
}

void ExpressionEngine::updateSaccades(float dt, uint32_t nowMs) noexcept {
    if (currentEmotion_ == EmotionId::Idle) {
        if (nowMs >= nextSaccadeMs_) {
            // Saccade gaze shift every 1.8 - 4.5s
            nextSaccadeMs_ = nowMs + 1800 + (esp_random() % 2700);

            const int8_t rx = static_cast<int8_t>((esp_random() % 9) - 4); // -4..+4
            const int8_t ry = static_cast<int8_t>((esp_random() % 5) - 2); // -2..+2

            saccadeTargetX_ = static_cast<float>(rx) * 0.75f;
            saccadeTargetY_ = static_cast<float>(ry) * 0.65f;
        }
    } else {
        saccadeTargetX_ = 0.0f;
        saccadeTargetY_ = 0.0f;
    }
}

void ExpressionEngine::updateParticles(float dt, uint32_t nowMs) noexcept {
    // 1. Zzz Particles (Sleepy)
    if (currentRig_.overlays.zzzParticlesActive) {
        for (size_t i = 0; i < MAX_ZZZ_PARTICLES; ++i) {
            auto& p = zzzParticles_[i];
            p.active = true;
            p.progress += dt * p.speed;
            if (p.progress >= 1.0f) {
                p.progress = 0.0f;
            }

            p.x = 88.0f + p.progress * 22.0f + sinf(p.progress * 6.28f + static_cast<float>(i)) * 3.5f;
            p.y = 52.0f - p.progress * 38.0f;

            if (p.progress < 0.2f) {
                p.alpha = p.progress / 0.2f;
            } else if (p.progress > 0.75f) {
                p.alpha = (1.0f - p.progress) / 0.25f;
            } else {
                p.alpha = 1.0f;
            }
        }
    } else {
        for (size_t i = 0; i < MAX_ZZZ_PARTICLES; ++i) {
            zzzParticles_[i].active = false;
        }
    }

    // 2. Sparkle Particles (Happy)
    if (currentRig_.overlays.sparkleParticlesActive) {
        for (size_t i = 0; i < MAX_SPARKLE_PARTICLES; ++i) {
            auto& p = sparkleParticles_[i];
            p.active = true;
            p.phase += dt * 4.0f;
            p.scale = (sinf(p.phase) + 1.0f) * 0.5f; // 0.0 .. 1.0
        }
    } else {
        for (size_t i = 0; i < MAX_SPARKLE_PARTICLES; ++i) {
            sparkleParticles_[i].active = false;
        }
    }
}

// ============================================================================
// 60FPS Physics Update Step
// ============================================================================

void ExpressionEngine::update(float dtSeconds, uint32_t nowMs) noexcept {
    const float dt = std::clamp(dtSeconds, 0.001f, 0.050f);

#ifdef ESP32
    if (mutex_ != nullptr) xSemaphoreTake(mutex_, 0);
#endif

    // Handle temporary emotion override expiration
    if (tempEmotionActive_ && nowMs >= tempEmotionExpiryMs_) {
        tempEmotionActive_ = false;
        setEmotion(prevEmotionBeforeTemp_);
    }

    updateBlinking(dt, nowMs);
    updateSaccades(dt, nowMs);
    updateParticles(dt, nowMs);

    // Subtle breathing vertical bobbing (1.5px sine wave in Idle)
    float breathingBob = 0.0f;
    if (currentEmotion_ == EmotionId::Idle) {
        breathingBob = sinf(static_cast<float>(nowMs) * 0.003f) * 1.5f;
    }

    // Animated voice-reactive eye bounce in Speaking
    float voiceBounce = 0.0f;
    if (currentEmotion_ == EmotionId::Speaking) {
        voiceBounce = sinf(static_cast<float>(nowMs) * 0.015f) * 1.8f * currentRig_.mouth.mouthOpenness;
    }

    const float targetLeftY  = targetRig_.leftEye.centerY  + breathingBob + voiceBounce;
    const float targetRightY = targetRig_.rightEye.centerY + breathingBob + voiceBounce;
    const float targetMouthY = targetRig_.mouth.mouthY     + breathingBob * 0.7f;

    // Apply micro-saccades to gaze target
    const float targetGazeX = targetRig_.leftEye.pupilOffsetX + saccadeTargetX_;
    const float targetGazeY = targetRig_.leftEye.pupilOffsetY + saccadeTargetY_;

    // Critically damped spring interpolation for Left Eye
    constexpr float OMEGA_DEFAULT = 22.0f;
    constexpr float ZETA_CRITICAL = 1.0f;

    stepSpring(currentRig_.leftEye.centerX, velocities_.leftCenterX, targetRig_.leftEye.centerX, dt, OMEGA_DEFAULT, ZETA_CRITICAL);
    stepSpring(currentRig_.leftEye.centerY, velocities_.leftCenterY, targetLeftY, dt, OMEGA_DEFAULT, ZETA_CRITICAL);
    stepSpring(currentRig_.leftEye.width,   velocities_.leftWidth,   targetRig_.leftEye.width,   dt, OMEGA_DEFAULT, ZETA_CRITICAL);
    stepSpring(currentRig_.leftEye.height,  velocities_.leftHeight,  targetRig_.leftEye.height,  dt, OMEGA_DEFAULT, ZETA_CRITICAL);
    stepSpring(currentRig_.leftEye.cornerRadius, velocities_.leftCornerRadius, targetRig_.leftEye.cornerRadius, dt, OMEGA_DEFAULT, ZETA_CRITICAL);
    stepSpring(currentRig_.leftEye.pupilOffsetX,  velocities_.leftPupilOffsetX,  targetGazeX, dt, 24.0f, ZETA_CRITICAL);
    stepSpring(currentRig_.leftEye.pupilOffsetY,  velocities_.leftPupilOffsetY,  targetGazeY, dt, 24.0f, ZETA_CRITICAL);
    stepSpring(currentRig_.leftEye.upperLidCrop,  velocities_.leftUpperLidCrop,  targetRig_.leftEye.upperLidCrop, dt, 26.0f, ZETA_CRITICAL);
    stepSpring(currentRig_.leftEye.lowerLidCrop,  velocities_.leftLowerLidCrop,  targetRig_.leftEye.lowerLidCrop, dt, 26.0f, ZETA_CRITICAL);
    stepSpring(currentRig_.leftEye.tiltAngleDeg,  velocities_.leftTiltAngleDeg,  targetRig_.leftEye.tiltAngleDeg, dt, OMEGA_DEFAULT, ZETA_CRITICAL);

    // Critically damped spring interpolation for Right Eye
    stepSpring(currentRig_.rightEye.centerX, velocities_.rightCenterX, targetRig_.rightEye.centerX, dt, OMEGA_DEFAULT, ZETA_CRITICAL);
    stepSpring(currentRig_.rightEye.centerY, velocities_.rightCenterY, targetRightY, dt, OMEGA_DEFAULT, ZETA_CRITICAL);
    stepSpring(currentRig_.rightEye.width,   velocities_.rightWidth,   targetRig_.rightEye.width,   dt, OMEGA_DEFAULT, ZETA_CRITICAL);
    stepSpring(currentRig_.rightEye.height,  velocities_.rightHeight,  targetRig_.rightEye.height,  dt, OMEGA_DEFAULT, ZETA_CRITICAL);
    stepSpring(currentRig_.rightEye.cornerRadius, velocities_.rightCornerRadius, targetRig_.rightEye.cornerRadius, dt, OMEGA_DEFAULT, ZETA_CRITICAL);
    stepSpring(currentRig_.rightEye.pupilOffsetX,  velocities_.rightPupilOffsetX,  targetGazeX, dt, 24.0f, ZETA_CRITICAL);
    stepSpring(currentRig_.rightEye.pupilOffsetY,  velocities_.rightPupilOffsetY,  targetGazeY, dt, 24.0f, ZETA_CRITICAL);
    stepSpring(currentRig_.rightEye.upperLidCrop,  velocities_.rightUpperLidCrop,  targetRig_.rightEye.upperLidCrop, dt, 26.0f, ZETA_CRITICAL);
    stepSpring(currentRig_.rightEye.lowerLidCrop,  velocities_.rightLowerLidCrop,  targetRig_.rightEye.lowerLidCrop, dt, 26.0f, ZETA_CRITICAL);
    stepSpring(currentRig_.rightEye.tiltAngleDeg,  velocities_.rightTiltAngleDeg,  targetRig_.rightEye.tiltAngleDeg, dt, OMEGA_DEFAULT, ZETA_CRITICAL);

    // Smooth Color Transition
    currentRig_.leftEye.colorRGB565  = lerpColor565(currentRig_.leftEye.colorRGB565,  targetRig_.leftEye.colorRGB565,  std::min(1.0f, dt * 10.0f));
    currentRig_.rightEye.colorRGB565 = lerpColor565(currentRig_.rightEye.colorRGB565, targetRig_.rightEye.colorRGB565, std::min(1.0f, dt * 10.0f));

    // Critically damped spring interpolation for Mouth
    stepSpring(currentRig_.mouth.mouthY,        velocities_.mouthY,        targetMouthY,                 dt, OMEGA_DEFAULT, ZETA_CRITICAL);
    stepSpring(currentRig_.mouth.mouthWidth,    velocities_.mouthWidth,    targetRig_.mouth.mouthWidth,    dt, OMEGA_DEFAULT, ZETA_CRITICAL);
    stepSpring(currentRig_.mouth.mouthOpenness, velocities_.mouthOpenness, targetRig_.mouth.mouthOpenness, dt, 28.0f,         ZETA_CRITICAL);
    stepSpring(currentRig_.mouth.curveSmile,    velocities_.curveSmile,    targetRig_.mouth.curveSmile,    dt, OMEGA_DEFAULT, ZETA_CRITICAL);

    // Critically damped spring interpolation for Overlays
    stepSpring(currentRig_.overlays.blushIntensity, velocities_.blushIntensity, targetRig_.overlays.blushIntensity, dt, 14.0f, ZETA_CRITICAL);

    currentRig_.overlays.zzzParticlesActive     = targetRig_.overlays.zzzParticlesActive;
    currentRig_.overlays.questionMarkActive     = targetRig_.overlays.questionMarkActive;
    currentRig_.overlays.sparkleParticlesActive = targetRig_.overlays.sparkleParticlesActive;
    currentRig_.overlays.sweatDropActive        = targetRig_.overlays.sweatDropActive;
    currentRig_.overlays.audioWaveActive        = targetRig_.overlays.audioWaveActive;

    currentRig_.copyOverlaysToFlat();

#ifdef ESP32
    if (mutex_ != nullptr) xSemaphoreGive(mutex_);
#endif
}

void ExpressionEngine::update(uint32_t nowMs) noexcept {
    if (lastUpdateMs_ == 0) {
        lastUpdateMs_ = nowMs;
    }
    const float dt = static_cast<float>(nowMs - lastUpdateMs_) * 0.001f;
    lastUpdateMs_ = nowMs;
    update(dt, nowMs);
}

// ============================================================================
// Autonomous Mood & Attention Controller
// ============================================================================

void ExpressionEngine::updatePersonality(uint32_t nowMs, bool userInteracted, uint8_t hourOfDay) noexcept {
    if (lastPersonalityUpdateMs_ == 0) {
        lastPersonalityUpdateMs_ = nowMs;
    }
    const uint32_t elapsed = nowMs - lastPersonalityUpdateMs_;
    lastPersonalityUpdateMs_ = nowMs;

    if (userInteracted) {
        idleDurationMs_ = 0;
        affectionLevel_ = std::min<uint8_t>(100, affectionLevel_ + 1);
        energyLevel_    = std::min<uint8_t>(100, energyLevel_ + 1);

        // Wake up if pet was asleep
        if (currentEmotion_ == EmotionId::Sleepy) {
            setEmotion(EmotionId::Idle);
            AudioHal::instance().playProceduralSound(SoundId::Chirp);
        }
    } else {
        idleDurationMs_ += elapsed;
    }

    // Active Happy timer countdown
    if (happyTimerMs_ > 0) {
        if (elapsed >= happyTimerMs_) {
            happyTimerMs_ = 0;
            setEmotion(EmotionId::Idle);
        } else {
            happyTimerMs_ -= elapsed;
            return; // Maintain Happy while petting bonus active
        }
    }

    // Active Curiosity timer countdown
    if (curiousTimerMs_ > 0) {
        if (elapsed >= curiousTimerMs_) {
            curiousTimerMs_ = 0;
            setEmotion(EmotionId::Idle);
        } else {
            curiousTimerMs_ -= elapsed;
            return;
        }
    }

    // Check autonomous sleep triggers: Late night (23:00 - 06:30) OR untouched for > 3 minutes (180,000ms)
    const bool isLateNight = (hourOfDay >= 23 || hourOfDay < 6);
    const bool isLongUntouched = (idleDurationMs_ >= 180000);

    if (isLateNight || isLongUntouched) {
        if (currentEmotion_ != EmotionId::Sleepy) {
            setEmotion(EmotionId::Sleepy);
            AudioHal::instance().playProceduralSound(SoundId::SleepySigh);
        }
        return;
    }

    // Check autonomous curiosity trigger: idle > 20s (20,000ms)
    if (idleDurationMs_ >= 20000 && currentEmotion_ == EmotionId::Idle) {
        if (nowMs - lastCuriosityTriggerMs_ >= 25000) {
            lastCuriosityTriggerMs_ = nowMs;
            curiousTimerMs_ = 3500; // Look around curiously for 3.5 seconds
            setEmotion(EmotionId::Curious);
            AudioHal::instance().playProceduralSound(SoundId::CuriousBeep);
        }
    }
}

void ExpressionEngine::onPettingGesture() noexcept {
    idleDurationMs_ = 0;
    affectionLevel_ = std::min<uint8_t>(100, affectionLevel_ + 25);
    energyLevel_    = std::min<uint8_t>(100, energyLevel_ + 10);

    setEmotion(EmotionId::Happy);
    happyTimerMs_ = 4000; // Happy for 4.0 seconds

    // Audio cue sequence: Happy Trill + Affectionate Purr
    AudioHal::instance().playProceduralSound(SoundId::HappyTrill);
    AudioHal::instance().playProceduralSound(SoundId::Purr);
}

void ExpressionEngine::onUserTouch(TouchGesture gesture) noexcept {
    switch (gesture) {
        case TouchGesture::SingleTap:
        case TouchGesture::DoubleTap:
        case TouchGesture::LongPress:
            updatePersonality(millis(), true, 12);
            break;
        case TouchGesture::PettingRapid:
            onPettingGesture();
            break;
        default:
            break;
    }
}

// ============================================================================
// Render Pipeline on Canvas128x160 (Zero Dynamic Heap Allocations)
// ============================================================================

void ExpressionEngine::render(Canvas128x160& canvas) noexcept {
    const uint32_t now = millis();

    // 1. Background Overlays (HUD brackets, radar rings)
    if (currentEmotion_ == EmotionId::Focused) {
        renderHudBrackets(canvas);
    }
    if (currentEmotion_ == EmotionId::Listening || currentRig_.overlays.audioWaveActive) {
        renderRadarRings(canvas, now);
    }

    // 2. Cheek Blush (Rendered under outer eyes on 160x128 landscape)
    if (currentRig_.overlays.blushIntensity > 0.02f) {
        renderCheekBlush(canvas, 28, 72, currentRig_.overlays.blushIntensity);
        renderCheekBlush(canvas, 132, 72, currentRig_.overlays.blushIntensity);
    }

    // 3. Left & Right Eyes
    renderEye(canvas, currentRig_.leftEye, true, now);
    renderEye(canvas, currentRig_.rightEye, false, now);

    // 4. Procedural Mouth
    renderMouth(canvas);

    // 5. Floating Overlays (Zzz, Sparkles, Question Mark, Sweat Drop)
    renderOverlays(canvas, now);
}

void ExpressionEngine::render(
    Canvas128x160& canvas,
    int16_t x,
    int16_t y,
    int16_t w,
    int16_t h,
    EmotionId emotion,
    uint16_t faceColor
) noexcept {
    (void)faceColor;
    if (w < 8 || h < 8) return;
    setEmotion(emotion, true);
    render(canvas);
}

// ============================================================================
// Sub-Renderers
// ============================================================================

void ExpressionEngine::renderEye(
    Canvas128x160& canvas,
    const EyeRigParams& eye,
    bool isLeft,
    uint32_t nowMs
) noexcept {
    (void)isLeft;
    (void)nowMs;

    const float hw = eye.width * 0.5f;
    const float hh = eye.height * 0.5f;
    const float r  = std::min(eye.cornerRadius, std::min(hw, hh));
    const float rad = -eye.tiltAngleDeg * (3.14159265f / 180.0f);
    const float cosA = cosf(rad);
    const float sinA = sinf(rad);

    // Compute bounding box on screen
    const float maxExtent = sqrtf(hw * hw + hh * hh) + 2.0f;
    const int16_t minX = std::max<int16_t>(0, static_cast<int16_t>(eye.centerX - maxExtent));
    const int16_t maxX = std::min<int16_t>(Canvas128x160::width() - 1, static_cast<int16_t>(eye.centerX + maxExtent));
    const int16_t minY = std::max<int16_t>(0, static_cast<int16_t>(eye.centerY - maxExtent));
    const int16_t maxY = std::min<int16_t>(Canvas128x160::height() - 1, static_cast<int16_t>(eye.centerY + maxExtent));

    // Combine base eyelid crop with live blinking
    float effectiveUpperCrop = eye.upperLidCrop;
    if (isBlinking_) {
        const float blinkFactor = (blinkProgress_ < 0.5f) ? (blinkProgress_ * 2.0f) : ((1.0f - blinkProgress_) * 2.0f);
        effectiveUpperCrop = std::clamp(effectiveUpperCrop + blinkFactor * (1.0f - effectiveUpperCrop), 0.0f, 1.0f);
    }

    const float upperCutoff = -hh + eye.height * effectiveUpperCrop;
    const float lowerCutoff = hh - eye.height * eye.lowerLidCrop;

    const bool isHappyCrescent = (currentEmotion_ == EmotionId::Happy);

    for (int16_t py = minY; py <= maxY; ++py) {
        for (int16_t px = minX; px <= maxX; ++px) {
            const float dx = static_cast<float>(px) - eye.centerX;
            const float dy = static_cast<float>(py) - eye.centerY;
            const float lx = dx * cosA - dy * sinA;
            const float ly = dx * sinA + dy * cosA;

            // Check if inside rounded rectangle
            const float qx = fabsf(lx) - (hw - r);
            const float qy = fabsf(ly) - (hh - r);
            bool inside = false;
            if (qx <= 0.0f && fabsf(ly) <= hh) {
                inside = true;
            } else if (qy <= 0.0f && fabsf(lx) <= hw) {
                inside = true;
            } else if (qx > 0.0f && qy > 0.0f && (qx * qx + qy * qy <= r * r)) {
                inside = true;
            }

            if (!inside) continue;

            // Check eyelid crops
            if (ly < upperCutoff) continue; // Upper lid closed

            if (isHappyCrescent) {
                // Inverted crescent arc for Happy (^ ^)
                const float normX = lx / (hw > 0.1f ? hw : 1.0f);
                const float crescentY = 1.0f - normX * normX * 8.0f;
                if (ly > crescentY) continue;
            } else {
                if (ly > lowerCutoff) continue; // Lower lid closed
            }

            // Determine pixel color (Specular reflection, iris, glow)
            uint16_t pixelColor = eye.colorRGB565;

            // Primary specular glint highlight dot
            const float glint1Dx = lx - (eye.pupilOffsetX + 3.0f);
            const float glint1Dy = ly - (eye.pupilOffsetY - 4.0f);
            if (glint1Dx * glint1Dx + glint1Dy * glint1Dy <= 3.5f) {
                pixelColor = colors::White;
            } else {
                // Secondary tiny glint
                const float glint2Dx = lx - (eye.pupilOffsetX - 3.5f);
                const float glint2Dy = ly - (eye.pupilOffsetY + 3.5f);
                if (glint2Dx * glint2Dx + glint2Dy * glint2Dy <= 1.2f) {
                    pixelColor = colors::White;
                } else if (eye.colorRGB565 != colors::Black) {
                    // Inner pupil iris for colored eyes
                    const float pupilDx = lx - eye.pupilOffsetX;
                    const float pupilDy = ly - eye.pupilOffsetY;
                    if (pupilDx * pupilDx + pupilDy * pupilDy <= 18.0f) {
                        pixelColor = Canvas128x160::blendAlpha(eye.colorRGB565, colors::Black, 160);
                    }
                }
            }

            canvas.drawPixel(px, py, pixelColor);
        }
    }
}

void ExpressionEngine::renderCheekBlush(Canvas128x160& canvas, int16_t cx, int16_t cy, float intensity) noexcept {
    const int16_t rx = 11;
    const int16_t ry = 7;
    const uint16_t blushPink = Canvas128x160::colorRGB(255, 118, 168);
    const uint8_t maxAlpha = static_cast<uint8_t>(std::clamp(intensity * 185.0f, 0.0f, 255.0f));

    for (int16_t dy = -ry; dy <= ry; ++dy) {
        for (int16_t dx = -rx; dx <= rx; ++dx) {
            const float nx = static_cast<float>(dx) / static_cast<float>(rx);
            const float ny = static_cast<float>(dy) / static_cast<float>(ry);
            const float distSq = nx * nx + ny * ny;
            if (distSq <= 1.0f) {
                const float dist = sqrtf(distSq);
                const float falloff = 1.0f - dist;
                const uint8_t alpha = static_cast<uint8_t>(falloff * maxAlpha);
                if (alpha > 4) {
                    canvas.blendPixel(cx + dx, cy + dy, blushPink, alpha);
                }
            }
        }
    }
}

void ExpressionEngine::renderMouth(Canvas128x160& canvas) noexcept {
    const int16_t cx = Canvas128x160::width() / 2;
    const int16_t cy = static_cast<int16_t>(currentRig_.mouth.mouthY);
    const int16_t hw = static_cast<int16_t>(currentRig_.mouth.mouthWidth * 0.5f);
    const float curve = currentRig_.mouth.curveSmile;
    const float open = currentRig_.mouth.mouthOpenness;

    if (hw <= 2) return;

    if (open > 0.06f) {
        // Open expressive classic black mouth with warm pink tongue
        for (int16_t dx = -hw; dx <= hw; ++dx) {
            const float normX = static_cast<float>(dx) / static_cast<float>(hw);
            const float arch = (normX * normX - 1.0f) * curve * 3.5f;
            const int16_t topY = static_cast<int16_t>(static_cast<float>(cy) + arch - open * 3.0f);
            const int16_t botY = static_cast<int16_t>(static_cast<float>(cy) + arch + open * 7.0f);

            for (int16_t y = topY; y <= botY; ++y) {
                uint16_t col = colors::Black;
                if (y >= botY - 2 && fabsf(normX) < 0.58f) {
                    col = Canvas128x160::colorRGB(255, 130, 168); // Pink tongue
                }
                canvas.drawPixel(cx + dx, y, col);
            }
            canvas.drawPixel(cx + dx, topY, colors::Black);
            canvas.drawPixel(cx + dx, botY, colors::Black);
        }
    } else {
        // Crisp black smiling/neutral mouth line on white face
        for (int16_t dx = -hw; dx <= hw; ++dx) {
            const float normX = static_cast<float>(dx) / static_cast<float>(hw);
            const float arch = (1.0f - normX * normX) * curve * 4.5f;
            const int16_t y = static_cast<int16_t>(static_cast<float>(cy) + arch);
            canvas.drawPixel(cx + dx, y, colors::Black);
            canvas.drawPixel(cx + dx, y + 1, colors::Black);
        }
    }
}

void ExpressionEngine::renderOverlays(Canvas128x160& canvas, uint32_t nowMs) noexcept {
    // 1. Rising Zzz Particles (Charcoal on White)
    if (currentRig_.overlays.zzzParticlesActive) {
        for (size_t i = 0; i < MAX_ZZZ_PARTICLES; ++i) {
            const auto& p = zzzParticles_[i];
            if (p.active && p.alpha > 0.05f) {
                const uint16_t col = Canvas128x160::blendAlpha(colors::DarkGray, colors::White, static_cast<uint8_t>(p.alpha * 240.0f));
                canvas.drawChar(static_cast<int16_t>(p.x), static_cast<int16_t>(p.y), 'Z', col, colors::White, p.size, true);
            }
        }
    }

    // 2. Sparkle Twinkle Stars
    if (currentRig_.overlays.sparkleParticlesActive) {
        for (size_t i = 0; i < MAX_SPARKLE_PARTICLES; ++i) {
            const auto& p = sparkleParticles_[i];
            if (p.active && p.scale > 0.35f) {
                const int16_t sx = static_cast<int16_t>(p.x);
                const int16_t sy = static_cast<int16_t>(p.y);
                const int16_t arm = static_cast<int16_t>(p.scale * 3.0f);
                canvas.drawFastHLine(sx - arm, sy, 2 * arm + 1, p.color);
                canvas.drawFastVLine(sx, sy - arm, 2 * arm + 1, p.color);
                canvas.drawPixel(sx, sy, colors::Black);
            }
        }
    }

    // 3. Floating Question Mark
    if (currentRig_.overlays.questionMarkActive) {
        const int16_t qx = 132;
        const int16_t qy = 22 + static_cast<int16_t>(sinf(static_cast<float>(nowMs) * 0.006f) * 3.0f);
        canvas.drawChar(qx + 1, qy + 1, '?', colors::LightGray, colors::White, 2, true);
        canvas.drawChar(qx, qy, '?', colors::Black, colors::White, 2, true);
    }

    // 4. Startled Sweat Drop
    if (currentRig_.overlays.sweatDropActive) {
        const float dropY = 26.0f + fmodf(static_cast<float>(nowMs) * 0.02f, 20.0f);
        const int16_t sx = 20;
        const int16_t sy = static_cast<int16_t>(dropY);
        canvas.fillCircle(sx, sy, 2, colors::Blue);
        canvas.drawPixel(sx, sy - 2, colors::Cyan);
        canvas.drawPixel(sx, sy - 3, colors::LightGray);
    }
}

void ExpressionEngine::renderHudBrackets(Canvas128x160& canvas) noexcept {
    constexpr uint16_t hudColor = colors::DarkGray;
    constexpr int16_t BRACKET_LEN = 12;

    // Top-Left
    canvas.drawFastHLine(8, 12, BRACKET_LEN, hudColor);
    canvas.drawFastVLine(8, 12, BRACKET_LEN, hudColor);

    // Top-Right
    canvas.drawFastHLine(151 - BRACKET_LEN, 12, BRACKET_LEN, hudColor);
    canvas.drawFastVLine(151, 12, BRACKET_LEN, hudColor);

    // Bottom-Left
    canvas.drawFastHLine(8, 115, BRACKET_LEN, hudColor);
    canvas.drawFastVLine(8, 115 - BRACKET_LEN, BRACKET_LEN, hudColor);

    // Bottom-Right
    canvas.drawFastHLine(151 - BRACKET_LEN, 115, BRACKET_LEN, hudColor);
    canvas.drawFastVLine(151, 115 - BRACKET_LEN, BRACKET_LEN, hudColor);
}

void ExpressionEngine::renderRadarRings(Canvas128x160& canvas, uint32_t nowMs) noexcept {
    constexpr uint16_t waveColor = colors::Black;

    // Mini Audio Waveform below mouth (when audioWaveActive)
    if (currentRig_.overlays.audioWaveActive) {
        for (int16_t i = -2; i <= 2; ++i) {
            const int16_t bx = 80 + i * 6;
            const float phase = static_cast<float>(nowMs) * 0.012f + static_cast<float>(i) * 1.3f;
            const int16_t bh = 2 + static_cast<int16_t>(fabsf(sinf(phase)) * (4.0f + 10.0f * currentRig_.mouth.mouthOpenness));
            canvas.drawFastVLine(bx, 108 - bh / 2, bh, waveColor);
        }
    }

    // Border Radar Rings for Listening (reactive to live mic RMS)
    if (currentEmotion_ == EmotionId::Listening) {
        const float energyScale = std::min(1.0f, static_cast<float>(liveMicEnergy_) / 250.0f);
        const int16_t radius = 6 + static_cast<int16_t>(fmodf(static_cast<float>(nowMs) * 0.016f, 12.0f) + energyScale * 4.0f);
        canvas.drawCircle(6, 56, radius, colors::DarkGray);
        canvas.drawCircle(153, 56, radius, colors::DarkGray);
    }
}

} // namespace petbot::firmware::ui
