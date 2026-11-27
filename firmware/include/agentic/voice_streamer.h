#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>
#include <atomic>

#include "petbot_protocol.h"
#include "hal/psram_allocator.h"
#include "hal/audio_hal.h"
#include "ui/expression_engine.h"

namespace petbot::firmware::agentic {

using petbot::protocol::PetBotFrameHeader;
using petbot::protocol::FrameType;
using petbot::protocol::AudioUplinkHeader;
using petbot::protocol::AudioDownlinkHeader;
using petbot::protocol::EmotionId;

/**
 * Subscription Entitlement Status
 */
struct SubscriptionEntitlement {
    bool voiceAiEnabled{true};
    char tier[16]{"PRO"};
    uint32_t expiresAt{0};
    char personaName[64]{"PetBot Companion"};
};

/**
 * Bi-Directional Voice AI Streaming Pipeline (VoiceStreamer)
 *
 * Coordinates:
 * 1. Subscription Entitlement Guard (gated to PRO and ULTRA_AI tiers)
 * 2. Uplink Audio Capture (I2S MEMS Mic -> 20ms PCM -> WebSocket with VAD)
 * 3. 200ms PSRAM Jitter Buffer (absorbs network packet delay variations)
 * 4. Zero-Lag Downlink Playback & Lockstep Viseme/Facial Sync
 */
class VoiceStreamer {
public:
    static constexpr size_t JITTER_BUFFER_BYTES = 32 * 1024; // 32KB Octal PSRAM Ring Buffer (~1000ms @ 16kHz)
    static constexpr size_t UPLINK_FRAME_SAMPLES = petbot::hal::AUDIO_FRAME_SAMPLES; // 320 samples (20ms @ 16kHz)
    static constexpr size_t UPLINK_FRAME_BYTES   = petbot::hal::AUDIO_FRAME_BYTES;   // 640 bytes PCM16

    static VoiceStreamer& instance() {
        static VoiceStreamer s_instance;
        return s_instance;
    }

    VoiceStreamer(const VoiceStreamer&) = delete;
    VoiceStreamer& operator=(const VoiceStreamer&) = delete;

    /**
     * Initialize VoiceStreamer:
     * - Allocate 32KB PSRAM jitter buffer
     * - Load subscription state from /state/subscription.msgpack
     * - Register binary frame handlers with AgenticTransport
     */
    bool init();

    /**
     * Start/Stop live microphone uplink capture.
     * @return true if started, false if blocked by subscription guard.
     */
    bool startVoiceStream();
    void stopVoiceStream();
    void toggleVoiceStream();

    [[nodiscard]] bool isVoiceStreaming() const noexcept { return m_uplinkActive; }
    [[nodiscard]] bool isThinking() const noexcept { return m_isThinking; }
    [[nodiscard]] bool wasSpeaking() const noexcept { return m_wasSpeaking; }
    [[nodiscard]] uint32_t getEchoBlankUntilMs() const noexcept { return m_echoBlankUntilMs; }
    [[nodiscard]] uint32_t getUpdateTicks() const noexcept { return m_updateTicks; }
    [[nodiscard]] bool isVoiceAiSubscribed() const noexcept;
    [[nodiscard]] const SubscriptionEntitlement& getSubscription() const noexcept { return m_subscription; }

    void setWakeWordEnabled(bool enabled) noexcept { m_wakeWordEnabled = enabled; }
    [[nodiscard]] bool isWakeWordEnabled() const noexcept { return m_wakeWordEnabled; }

    [[nodiscard]] const char* getWakeWordPhrase() const noexcept { return m_wakeWordPhrase; }
    void setWakeWordPhrase(const char* phrase) noexcept;

    /**
     * Feeds 16kHz audio samples into the on-chip ESP-SR WakeNet detection engine.
     * @return true if wake-word ("Hi ESP" / "Hey Lobo") is recognized.
     */
    bool checkWakeWord(const int16_t* samples, size_t sampleCount);

    void setSilenceReturnMs(uint32_t timeoutMs) noexcept { m_silenceReturnMs = timeoutMs; }
    [[nodiscard]] uint32_t getSilenceReturnMs() const noexcept { return m_silenceReturnMs; }
    void clearSavedWidgetReturn() noexcept {
        m_hasSavedWidgetReturn = false;
        m_hasEnteredSleepState = false;
        m_previousWidgetPageId[0] = '\0';
    }

    /**
     * Core 0 / Audio loop update: reads mic samples, evaluates VAD, transmits uplink frames.
     */
    void update(uint32_t nowMs);

    /**
     * Protocol Frame Handlers
     */
    void handleSubscriptionSync(const uint8_t* payload, size_t len);
    void handleAudioDownlink(const PetBotFrameHeader& header, const uint8_t* payload, size_t len);

    /**
     * Checks if the upsell promotion prompt is currently visible.
     */
    [[nodiscard]] bool isUpsellPromptActive() const noexcept { return m_upsellPromptActive; }
    void dismissUpsellPrompt() noexcept { m_upsellPromptActive = false; }
    void renderUpsellPrompt(petbot::hal::Canvas128x160& canvas) noexcept;

private:
    VoiceStreamer();
    ~VoiceStreamer();

    bool loadSubscriptionFromStorage();
    bool saveSubscriptionToStorage();

    void triggerSubscriptionRequiredPrompt();

    // 32KB PSRAM Ring Buffer for downlink audio jitter mitigation
    uint8_t* m_jitterBuffer{nullptr};
    size_t m_jitterHead{0};
    size_t m_jitterTail{0};
    size_t m_jitterCount{0};

    SubscriptionEntitlement m_subscription{};
    std::atomic<bool> m_uplinkActive{false};

    // VAD & Uplink Timing
    uint32_t m_listenStartMs{0};
    uint32_t m_lastUplinkMs{0};
    uint32_t m_vadHangoverEndMs{0};
    uint32_t m_echoBlankUntilMs{0};
    uint32_t m_thinkingStartMs{0};
    bool m_isThinking{false};
    bool m_wasSpeaking{false};

    // Upsell Prompt State
    bool m_upsellPromptActive{false};
    uint32_t m_upsellStartTimeMs{0};

    // Downlink Audio active tracking
    uint32_t m_lastDownlinkPacketMs{0};
    bool m_isReceivingDownlink{false};

    // Dynamic Widget Return after Voice Conversation
    char m_previousWidgetPageId[32]{0};
    bool m_hasSavedWidgetReturn{false};
    uint32_t m_lastVoiceActivityMs{0};
    bool m_hasEnteredSleepState{false};
    uint32_t m_silenceReturnMs{15000};
    bool m_wakeWordEnabled{true};

    // Built-in ESP32-S3 WakeNet Engine
    char m_wakeWordPhrase[32]{"Hi ESP"};
    bool m_wakeNetInitialized{false};
    uint32_t m_lastWakeTriggerMs{0};
    uint32_t m_wakeWindowStartMs{0};
    uint16_t m_wakeConsecutiveHits{0};
    uint32_t m_updateTicks{0};
    // Preallocated scratch buffers (keeps FreeRTOS task stack small and fragmentation zero)
    int16_t m_micSamples[UPLINK_FRAME_SAMPLES]{};
    uint8_t m_uplinkTxBuffer[sizeof(AudioUplinkHeader) + UPLINK_FRAME_BYTES]{};

    bool initWakeNet();
    void destroyWakeNet();
};

} // namespace petbot::firmware::agentic
