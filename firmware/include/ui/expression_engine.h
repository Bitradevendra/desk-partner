/**
 * UI Subsystem - 60FPS Procedural Pet Expression Renderer & Autonomous Personality Engine
 * 
 * Features:
 * - Deterministic C++20 spring-physics interpolation (critically damped lerp)
 * - Continuous FaceRigParams for eye geometry, pupils, eyelids, tilt, mouth, and overlays
 * - Preset target postures for all 8 EmotionId values from petbot_protocol.h:
 *   (IDLE, HAPPY, CURIOUS, SLEEPY, FOCUSED, SPEAKING, LISTENING, ALERT)
 * - Procedural micro-saccades (1.8-4.5s random gaze shifts)
 * - Automatic double/single blinking every 3-6s
 * - Subtle breathing vertical bobbing (1.5px sine wave)
 * - Dynamic mouth viseme and live mic energy synchronization
 * - Pre-allocated particle systems (Zzz, Sparkles, Question Mark, Sweat Drop, HUD brackets)
 * - Autonomous Mood & Attention State Machine (energy, affection, idle timers, petting triggers)
 * - Zero dynamic heap allocations (new/malloc) during render loop or state updates
 */
#pragma once

#include <cstdint>
#include <cstddef>
#include <cmath>
#include <algorithm>

#include "petbot_protocol.h"
#include "petbot_widget_bytecode.h"
#include "hal/board_pins.h"
#include "hal/psram_allocator.h"
#include "hal/audio_hal.h"
#include "hal/touch_hal.h"

#ifdef ESP32
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#endif

namespace petbot::firmware::ui {

using petbot::protocol::EmotionId;
using petbot::hal::Canvas128x160;
namespace colors = petbot::hal::colors;
using petbot::hal::TouchGesture;
using petbot::hal::AudioHal;
using petbot::hal::SoundId;

// Uppercase Convenience Aliases matching protocol EmotionId
inline constexpr EmotionId IDLE      = EmotionId::Idle;
inline constexpr EmotionId HAPPY     = EmotionId::Happy;
inline constexpr EmotionId CURIOUS   = EmotionId::Curious;
inline constexpr EmotionId SLEEPY    = EmotionId::Sleepy;
inline constexpr EmotionId FOCUSED   = EmotionId::Focused;
inline constexpr EmotionId SPEAKING  = EmotionId::Speaking;
inline constexpr EmotionId LISTENING = EmotionId::Listening;
inline constexpr EmotionId ALERT     = EmotionId::Alert;

// ============================================================================
// Face Rig Continuous Interpolated Parameters
// ============================================================================

struct EyeRigParams {
    float    centerX{42.0f};
    float    centerY{66.0f};
    float    width{24.0f};
    float    height{32.0f};
    float    cornerRadius{8.0f};
    float    pupilOffsetX{0.0f};
    float    pupilOffsetY{0.0f};
    float    upperLidCrop{0.0f};   // 0.0 (fully open) .. 1.0 (fully closed)
    float    lowerLidCrop{0.0f};   // 0.0 (fully open) .. 1.0 (fully closed)
    float    tiltAngleDeg{0.0f};   // Eye tilt / brow angle in degrees
    uint16_t colorRGB565{0x077F};  // Glowing Cyan (#00F0FF) default
};

struct MouthRigParams {
    float mouthY{112.0f};
    float mouthWidth{18.0f};
    float mouthOpenness{0.0f};     // 0.0 .. 1.0 driven by visemeMouthOpen
    float curveSmile{0.15f};       // -1.0 (frown) .. +1.0 (happy arc)
};

struct OverlayRigParams {
    float blushIntensity{0.0f};    // 0.0 .. 1.0 cheek blush
    bool  zzzParticlesActive{false};
    bool  questionMarkActive{false};
    bool  sparkleParticlesActive{false};
    bool  sweatDropActive{false};
    bool  audioWaveActive{false};
};

struct FaceRigParams {
    EyeRigParams     leftEye{};
    EyeRigParams     rightEye{};
    MouthRigParams   mouth{};
    OverlayRigParams overlays{};

    // Direct overlay field variables for flat access convenience
    float blushIntensity{0.0f};
    bool  zzzParticlesActive{false};
    bool  questionMarkActive{false};
    bool  sparkleParticlesActive{false};
    bool  sweatDropActive{false};
    bool  audioWaveActive{false};

    void syncOverlays() noexcept {
        overlays.blushIntensity = blushIntensity;
        overlays.zzzParticlesActive = zzzParticlesActive;
        overlays.questionMarkActive = questionMarkActive;
        overlays.sparkleParticlesActive = sparkleParticlesActive;
        overlays.sweatDropActive = sweatDropActive;
        overlays.audioWaveActive = audioWaveActive;
    }

    void copyOverlaysToFlat() noexcept {
        blushIntensity = overlays.blushIntensity;
        zzzParticlesActive = overlays.zzzParticlesActive;
        questionMarkActive = overlays.questionMarkActive;
        sparkleParticlesActive = overlays.sparkleParticlesActive;
        sweatDropActive = overlays.sweatDropActive;
        audioWaveActive = overlays.audioWaveActive;
    }
};

struct FaceRigVelocities {
    // Left eye velocities
    float leftCenterX{0.0f};
    float leftCenterY{0.0f};
    float leftWidth{0.0f};
    float leftHeight{0.0f};
    float leftCornerRadius{0.0f};
    float leftPupilOffsetX{0.0f};
    float leftPupilOffsetY{0.0f};
    float leftUpperLidCrop{0.0f};
    float leftLowerLidCrop{0.0f};
    float leftTiltAngleDeg{0.0f};

    // Right eye velocities
    float rightCenterX{0.0f};
    float rightCenterY{0.0f};
    float rightWidth{0.0f};
    float rightHeight{0.0f};
    float rightCornerRadius{0.0f};
    float rightPupilOffsetX{0.0f};
    float rightPupilOffsetY{0.0f};
    float rightUpperLidCrop{0.0f};
    float rightLowerLidCrop{0.0f};
    float rightTiltAngleDeg{0.0f};

    // Mouth velocities
    float mouthY{0.0f};
    float mouthWidth{0.0f};
    float mouthOpenness{0.0f};
    float curveSmile{0.0f};

    // Overlay velocities
    float blushIntensity{0.0f};
};

// ============================================================================
// Pre-allocated Particle Structs
// ============================================================================

struct ZzzParticle {
    float   x{0.0f};
    float   y{0.0f};
    float   alpha{0.0f};
    float   progress{0.0f};
    float   speed{0.35f};
    uint8_t size{1};
    bool    active{false};
};

struct SparkleParticle {
    float    x{0.0f};
    float    y{0.0f};
    float    phase{0.0f};
    float    scale{0.0f};
    uint16_t color{0xFFE0}; // Yellow
    bool     active{false};
};

// ============================================================================
// ExpressionEngine Singleton Class
// ============================================================================

class ExpressionEngine {
public:
    static ExpressionEngine& instance() noexcept;

    ExpressionEngine(const ExpressionEngine&) = delete;
    ExpressionEngine& operator=(const ExpressionEngine&) = delete;
    ExpressionEngine(ExpressionEngine&&) = delete;
    ExpressionEngine& operator=(ExpressionEngine&&) = delete;

    /**
     * Initialize expression state, preset rigs, and timers.
     */
    void init() noexcept;

    /**
     * Transition to target emotion preset.
     * @param emotion Target emotion id.
     * @param forceInstant If true, skips spring interpolation.
     */
    void setEmotion(EmotionId emotion, bool forceInstant = false) noexcept;

    /**
     * Temporary emotion override (e.g. triggered by widget actions or voice events).
     * Automatically reverts to previous base emotion after durationMs.
     */
    void setTemporaryEmotion(EmotionId emotion, uint32_t durationMs) noexcept;
    void setTemporaryEmotion(petbot::widget::bytecode::EmotionType emotion, uint32_t durationMs) noexcept {
        setTemporaryEmotion(static_cast<EmotionId>(emotion), durationMs);
    }

    [[nodiscard]] EmotionId getEmotion() const noexcept { return currentEmotion_; }

    /**
     * Dynamic mouth waveform / viseme sync when speaking.
     * @param open Openness 0..255 (mapped to 0.0..1.0).
     * @param gazeX Gaze target horizontal offset (-128..127).
     * @param gazeY Gaze target vertical offset (-128..127).
     */
    void setVisemeOpenness(uint8_t open, int8_t gazeX = 0, int8_t gazeY = 0) noexcept;

    /**
     * Reactive live microphone energy (RMS) for listening ear/radar rings.
     */
    void setLiveMicEnergy(uint16_t rms) noexcept;
    [[nodiscard]] uint16_t getLiveMicEnergy() const noexcept { return liveMicEnergy_; }

    /**
     * 60FPS physics update step.
     * @param dtSeconds Timestep in seconds (~0.0166s for 60FPS).
     * @param nowMs Monotonic timestamp in milliseconds.
     */
    void update(float dtSeconds, uint32_t nowMs) noexcept;

    /**
     * Convenience update overload calculating dt internally.
     */
    void update(uint32_t nowMs) noexcept;

    /**
     * Render the face rig, eyes, pupils, lids, blush, mouth, and overlays onto Canvas128x160.
     * Zero heap allocations.
     * @param canvas Target 128x160 RGB565 canvas.
     */
    void render(Canvas128x160& canvas) noexcept;

    /**
     * Bounded box render overload for backward compatibility with widget layouts.
     */
    void render(
        Canvas128x160& canvas,
        int16_t x,
        int16_t y,
        int16_t w,
        int16_t h,
        EmotionId emotion = EmotionId::Idle,
        uint16_t faceColor = colors::Cyan
    ) noexcept;

    void render(
        Canvas128x160& canvas,
        int16_t x,
        int16_t y,
        int16_t w,
        int16_t h,
        petbot::widget::bytecode::EmotionType emotion,
        uint16_t faceColor = colors::Cyan
    ) noexcept {
        render(canvas, x, y, w, h, static_cast<EmotionId>(emotion), faceColor);
    }

    /**
     * Autonomous Mood & Attention Controller.
     * @param nowMs Current time in milliseconds.
     * @param userInteracted True if touch or command occurred this cycle.
     * @param hourOfDay Current 24-hour clock hour (0..23).
     */
    void updatePersonality(uint32_t nowMs, bool userInteracted, uint8_t hourOfDay = 12) noexcept;

    /**
     * Rapid petting touch trigger: spikes affection, transitions to Happy for 4s, plays audio cues.
     */
    void onPettingGesture() noexcept;

    /**
     * Handle touch gesture event directly.
     */
    void onUserTouch(TouchGesture gesture) noexcept;

    // Personality state queries
    [[nodiscard]] uint8_t  getEnergyLevel() const noexcept { return energyLevel_; }
    [[nodiscard]] uint8_t  getAffectionLevel() const noexcept { return affectionLevel_; }
    [[nodiscard]] uint32_t getIdleDurationMs() const noexcept { return idleDurationMs_; }
    [[nodiscard]] uint8_t  getTargetBacklightPct() const noexcept;

    void setEnergyLevel(uint8_t energy) noexcept { energyLevel_ = std::min<uint8_t>(100, energy); }
    void setAffectionLevel(uint8_t affection) noexcept { affectionLevel_ = std::min<uint8_t>(100, affection); }

    // Rig state inspection
    [[nodiscard]] const FaceRigParams& getCurrentRig() const noexcept { return currentRig_; }
    [[nodiscard]] const FaceRigParams& getTargetRig() const noexcept { return targetRig_; }

    /**
     * Return preset static rig configuration for an emotion.
     */
    static FaceRigParams getPresetPosture(EmotionId emotion) noexcept;

private:
    ExpressionEngine() noexcept;
    ~ExpressionEngine() noexcept = default;

    // Internal sub-renderers
    void renderEye(Canvas128x160& canvas, const EyeRigParams& eye, bool isLeft, uint32_t nowMs) noexcept;
    void renderCheekBlush(Canvas128x160& canvas, int16_t cx, int16_t cy, float intensity) noexcept;
    void renderMouth(Canvas128x160& canvas) noexcept;
    void renderOverlays(Canvas128x160& canvas, uint32_t nowMs) noexcept;
    void renderHudBrackets(Canvas128x160& canvas) noexcept;
    void renderRadarRings(Canvas128x160& canvas, uint32_t nowMs) noexcept;

    // Procedural helpers
    void updateBlinking(float dt, uint32_t nowMs) noexcept;
    void updateSaccades(float dt, uint32_t nowMs) noexcept;
    void updateParticles(float dt, uint32_t nowMs) noexcept;

    // Active state and interpolated parameters
    EmotionId         currentEmotion_{EmotionId::Idle};
    FaceRigParams     currentRig_{};
    FaceRigParams     targetRig_{};
    FaceRigVelocities velocities_{};

    // Autonomous mood parameters
    uint8_t  energyLevel_{100};
    uint8_t  affectionLevel_{60};
    uint32_t idleDurationMs_{0};
    uint32_t lastPersonalityUpdateMs_{0};
    uint32_t happyTimerMs_{0};
    uint32_t curiousTimerMs_{0};
    uint32_t lastCuriosityTriggerMs_{0};
    EmotionId prevEmotionBeforeTemp_{EmotionId::Idle};
    uint32_t tempEmotionExpiryMs_{0};
    bool tempEmotionActive_{false};

    // Live sync inputs
    float    visemeOpenness_{0.0f};
    float    visemeGazeX_{0.0f};
    float    visemeGazeY_{0.0f};
    uint16_t liveMicEnergy_{0};

    // Micro-saccades & Blinking state
    uint32_t nextSaccadeMs_{3000};
    float    saccadeTargetX_{0.0f};
    float    saccadeTargetY_{0.0f};
    float    saccadeDurationMs_{0.0f};
    uint32_t nextBlinkMs_{4000};
    bool     isBlinking_{false};
    float    blinkProgress_{0.0f};
    float    blinkDurationSec_{0.16f};
    bool     isDoubleBlink_{false};
    uint32_t lastUpdateMs_{0};

    // Pre-allocated Particle Systems
    static constexpr size_t MAX_ZZZ_PARTICLES = 4;
    ZzzParticle zzzParticles_[MAX_ZZZ_PARTICLES]{};

    static constexpr size_t MAX_SPARKLE_PARTICLES = 6;
    SparkleParticle sparkleParticles_[MAX_SPARKLE_PARTICLES]{};

#ifdef ESP32
    SemaphoreHandle_t mutex_{nullptr};
#endif
};

} // namespace petbot::firmware::ui
