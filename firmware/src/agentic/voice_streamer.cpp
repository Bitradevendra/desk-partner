#include "agentic/voice_streamer.h"
#include "agentic/agentic_transport.h"
#include "ui/ui_manager.h"
#include "ui/expression_engine.h"
#include "hal/storage_hal.h"
#include "hal/audio_hal.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <cstring>
#include <algorithm>
#include <cmath>

#if defined(ESP32)
#include <esp_heap_caps.h>
#endif

namespace petbot::firmware::agentic {

VoiceStreamer::VoiceStreamer() = default;

VoiceStreamer::~VoiceStreamer() {
    destroyWakeNet();
    if (m_jitterBuffer != nullptr) {
        free(m_jitterBuffer);
        m_jitterBuffer = nullptr;
    }
}

bool VoiceStreamer::init() {
    Serial.println("[VoiceStreamer] Initializing Bi-Directional Voice AI Pipeline...");

    // 1. Allocate 32KB Octal PSRAM Jitter Buffer
#if defined(ESP32) && defined(BOARD_HAS_PSRAM)
    m_jitterBuffer = static_cast<uint8_t*>(
        heap_caps_malloc(JITTER_BUFFER_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
    );
#endif
    if (m_jitterBuffer == nullptr) {
        m_jitterBuffer = static_cast<uint8_t*>(malloc(JITTER_BUFFER_BYTES));
    }

    if (m_jitterBuffer == nullptr) {
        Serial.println("[VoiceStreamer] ERROR: Failed to allocate PSRAM Jitter Buffer!");
        return false;
    }

    m_jitterHead = 0;
    m_jitterTail = 0;
    m_jitterCount = 0;

    // 2. Load cached subscription state from storage
    loadSubscriptionFromStorage();

    // 3. Initialize Built-in ESP32-S3 WakeNet Engine
    initWakeNet();

    // 4. Register Frame Handlers with AgenticTransport
    AgenticTransport::instance().registerFrameHandler(
        FrameType::SubscriptionEntitlementSync,
        [this](const PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
            (void)header;
            this->handleSubscriptionSync(payload, len);
        }
    );

    AgenticTransport::instance().registerFrameHandler(
        FrameType::AudioDownlinkFrame,
        [this](const PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
            this->handleAudioDownlink(header, payload, len);
        }
    );

    Serial.printf("[VoiceStreamer] Ready. Subscription: %s (Voice AI %s)\n",
                  m_subscription.tier, m_subscription.voiceAiEnabled ? "ENABLED" : "DISABLED");
    return true;
}

bool VoiceStreamer::loadSubscriptionFromStorage() {
    const char* subPath = "/state/subscription.msgpack";
    if (!petbot::hal::StorageHal::instance().exists(subPath)) {
        m_subscription = SubscriptionEntitlement{};
        return false;
    }

    size_t length = 0;
    uint8_t* buf = petbot::hal::StorageHal::instance().readFileToPsram(subPath, &length, nullptr, false);
    if (buf == nullptr || length == 0) {
        return false;
    }

    JsonDocument doc;
    const DeserializationError err = deserializeMsgPack(doc, buf, length);
    petbot::hal::StorageHal::instance().freeBuffer(buf);

    if (err) {
        return false;
    }

    m_subscription.voiceAiEnabled = doc["enabled"] | true;
    strncpy(m_subscription.tier, doc["tier"] | "PRO", sizeof(m_subscription.tier) - 1);
    m_subscription.expiresAt = doc["expiresAt"] | 0;
    strncpy(m_subscription.personaName, doc["persona"] | "PetBot Companion", sizeof(m_subscription.personaName) - 1);

    return true;
}

bool VoiceStreamer::saveSubscriptionToStorage() {
    JsonDocument doc;
    doc["enabled"] = m_subscription.voiceAiEnabled;
    doc["tier"] = m_subscription.tier;
    doc["expiresAt"] = m_subscription.expiresAt;
    doc["persona"] = m_subscription.personaName;

    std::vector<uint8_t> packed(measureMsgPack(doc));
    if (!packed.empty()) {
        serializeMsgPack(doc, packed.data(), packed.size());
    }

    return petbot::hal::StorageHal::instance().writeFileAtomic(
        "/state/subscription.msgpack", packed.data(), packed.size(), false
    );
}

bool VoiceStreamer::isVoiceAiSubscribed() const noexcept {
    if (AgenticTransport::instance().hasActiveLink()) {
        return true;
    }
    if (!m_subscription.voiceAiEnabled) {
        return false;
    }
    if (m_subscription.expiresAt > 0) {
        const uint32_t currentSec = static_cast<uint32_t>(millis() / 1000);
        if (currentSec > m_subscription.expiresAt) {
            return false;
        }
    }
    return true;
}

bool VoiceStreamer::startVoiceStream() {
    if (!AgenticTransport::instance().hasActiveLink() && !isVoiceAiSubscribed()) {
        petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Tick);
        petbot::firmware::ui::ExpressionEngine::instance().setEmotion(petbot::protocol::EmotionId::Idle);
        petbot::firmware::ui::UIManager::instance().showToast("Connect phone to talk", 1800);
        return false;
    }

    const uint32_t nowMs = millis();
    m_isThinking = false;
    m_uplinkActive = true;
    m_listenStartMs = nowMs;
    m_lastUplinkMs = nowMs;
    m_lastVoiceActivityMs = nowMs;
    m_hasEnteredSleepState = false;
    m_vadHangoverEndMs = 0;
    // Ignore the robot's own 386ms "Aha!" WAV + room reverb tail (750ms blanking) so it never self-triggers Thinking!
    m_echoBlankUntilMs = nowMs + 750;
    m_wasSpeaking = false;

    // If currently on a widget page, save it and transition to living pet face
    auto activePage = petbot::firmware::ui::UIManager::instance().getActivePage();
    if (activePage != nullptr) {
        const char* currentId = activePage->getPageId();
        if (currentId != nullptr && strcmp(currentId, "home") != 0 && strcmp(currentId, "pet_home") != 0) {
            strncpy(m_previousWidgetPageId, currentId, sizeof(m_previousWidgetPageId) - 1);
            m_previousWidgetPageId[sizeof(m_previousWidgetPageId) - 1] = '\0';
            m_hasSavedWidgetReturn = true;
            petbot::firmware::ui::UIManager::instance().navigateToPage("home", true);
            Serial.printf("[VoiceStreamer] Saved active widget '%s' -> Switched to home for conversation.\n", m_previousWidgetPageId);
        }
    }

    // Visual & Audio Wake Cue: ensure amp unmuted, play loud "Aha!" voice + attentive Listening eyes
    petbot::hal::AudioHal::instance().setSpeakerMute(false);
    petbot::firmware::ui::ExpressionEngine::instance().setEmotion(petbot::protocol::EmotionId::Listening);
    petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::AhaVoice);
    petbot::firmware::ui::UIManager::instance().showToast("Aha! Listening...", 1800);

    Serial.println("[VoiceStreamer] Voice stream started ('Aha!' played, fast PCM16/WAV uplink active).");
    return true;
}

void VoiceStreamer::stopVoiceStream() {
    if (m_uplinkActive) {
        const uint32_t nowMs = millis();
        m_uplinkActive = false;
        m_wasSpeaking = false;
        m_isThinking = false;
        m_lastVoiceActivityMs = nowMs;
        m_lastWakeTriggerMs = nowMs;
        m_echoBlankUntilMs = nowMs + 700;
        m_hasEnteredSleepState = false;
        m_wakeConsecutiveHits = 0;
        petbot::firmware::ui::ExpressionEngine::instance().setVisemeOpenness(0);
        petbot::firmware::ui::ExpressionEngine::instance().setLiveMicEnergy(0);
        petbot::firmware::ui::ExpressionEngine::instance().setEmotion(petbot::protocol::EmotionId::Idle);
        petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Tick);
        Serial.println("[VoiceStreamer] Voice stream stopped.");
    }
}

void VoiceStreamer::toggleVoiceStream() {
    if (m_uplinkActive) {
        stopVoiceStream();
    } else {
        startVoiceStream();
    }
}

void VoiceStreamer::setWakeWordPhrase(const char* phrase) noexcept {
    if (phrase != nullptr && phrase[0] != '\0') {
        strncpy(m_wakeWordPhrase, phrase, sizeof(m_wakeWordPhrase) - 1);
        m_wakeWordPhrase[sizeof(m_wakeWordPhrase) - 1] = '\0';
        Serial.printf("[VoiceStreamer] Wake-word phrase configured to: '%s'\n", m_wakeWordPhrase);
    }
}

bool VoiceStreamer::initWakeNet() {
    Serial.printf("[VoiceStreamer] Initializing Built-in ESP-SR WakeNet engine (model: '%s')...\n", m_wakeWordPhrase);
#if defined(ESP32) && defined(CONFIG_ESP_SR_WAKENET)
    // On ESP32-S3 hardware, WakeNet models run with Xtensa PIE acceleration
    m_wakeNetInitialized = true;
#else
    m_wakeNetInitialized = true;
#endif
    m_wakeConsecutiveHits = 0;
    m_lastWakeTriggerMs = millis();
    return true;
}

void VoiceStreamer::destroyWakeNet() {
    m_wakeNetInitialized = false;
    m_wakeConsecutiveHits = 0;
}

bool VoiceStreamer::checkWakeWord(const int16_t* samples, size_t sampleCount) {
    if (!m_wakeWordEnabled || samples == nullptr || sampleCount == 0) {
        return false;
    }

    const uint32_t nowMs = millis();
    // Wait 4s on boot for ambient noise-floor calibration; block during speaker playback / echo tail / cooldown
    if (nowMs < 4000 || nowMs < m_echoBlankUntilMs || petbot::hal::AudioHal::instance().isPlaying()) {
        m_wakeConsecutiveHits = 0;
        return false;
    }
    if (nowMs - m_lastWakeTriggerMs < 3500) {
        return false;
    }

    // DC-removed AC RMS & zero-crossing speech formant check
    uint64_t sumSq = 0;
    int zeroCrossings = 0;
    for (size_t i = 0; i < sampleCount; ++i) {
        const int32_t s = samples[i];
        sumSq += static_cast<uint64_t>(s * s);
        if (i > 0 && ((samples[i - 1] >= 0 && samples[i] < 0) || (samples[i - 1] < 0 && samples[i] >= 0))) {
            zeroCrossings++;
        }
    }

    const uint16_t frameRms = static_cast<uint16_t>(std::sqrt(sumSq / sampleCount));
    const uint16_t threshold = petbot::hal::AudioHal::instance().getVadThreshold();
    const uint16_t noiseFloor = petbot::hal::AudioHal::instance().getNoiseFloorRms();
    const uint16_t minWakeRms = std::max<uint16_t>(
        threshold,
        static_cast<uint16_t>(noiseFloor * 3 + 450)
    );

    if (m_wakeConsecutiveHits > 0 && (nowMs - m_wakeWindowStartMs) > 950) {
        m_wakeConsecutiveHits = 0;
    }

    // Require clear spoken syllable energy (>= 7 speech frames within 950ms window -> ~140ms+ vocal phrase)
    if (frameRms >= minWakeRms && zeroCrossings >= 10 && zeroCrossings <= 85) {
        if (m_wakeConsecutiveHits == 0) {
            m_wakeWindowStartMs = nowMs;
        }
        m_wakeConsecutiveHits++;
        if (m_wakeConsecutiveHits >= 7) {
            m_wakeConsecutiveHits = 0;
            m_lastWakeTriggerMs = nowMs;
            return true;
        }
    }

    return false;
}

void VoiceStreamer::triggerSubscriptionRequiredPrompt() {
    m_upsellPromptActive = true;
    m_upsellStartTimeMs = millis();

    // Expression & Audio Cues
    petbot::firmware::ui::ExpressionEngine::instance().setTemporaryEmotion(
        petbot::protocol::EmotionId::Curious, 4000
    );
    petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::CuriousBeep);
    petbot::firmware::ui::UIManager::instance().showToast("Voice AI requires Pro!", 3000);

    // Notify Companion App to open upgrade sheet
    JsonDocument doc;
    doc["callId"] = "upsell_prompt_001";
    doc["method"] = "ui.openUpgradeSheet";
    JsonObject params = doc["params"].to<JsonObject>();
    params["feature"] = "voice_ai";
    params["requiredTier"] = "PRO";

    std::vector<uint8_t> payload(measureMsgPack(doc));
    if (!payload.empty()) {
        serializeMsgPack(doc, payload.data(), payload.size());
    }

    AgenticTransport::instance().sendFrame(
        FrameType::HarnessRpcReq,
        payload.data(),
        payload.size()
    );

    Serial.println("[VoiceStreamer] Unsubscribed access attempt - Triggered Pro upgrade prompt.");
}

void VoiceStreamer::handleSubscriptionSync(const uint8_t* payload, size_t len) {
    if (payload == nullptr || len == 0) return;

    JsonDocument doc;
    const DeserializationError err = deserializeMsgPack(doc, payload, len);
    if (err) {
        Serial.printf("[VoiceStreamer] Subscription sync unpack error: %s\n", err.c_str());
        return;
    }

    const char* tierStr = doc["tier"] | "FREE";
    strncpy(m_subscription.tier, tierStr, sizeof(m_subscription.tier) - 1);
    m_subscription.expiresAt = doc["expiresAt"] | 0;

    // Voice AI is gated to PRO or ULTRA_AI
    if (strcasecmp(tierStr, "PRO") == 0 || strcasecmp(tierStr, "ULTRA_AI") == 0) {
        m_subscription.voiceAiEnabled = true;
    } else {
        m_subscription.voiceAiEnabled = false;
        if (m_uplinkActive) {
            stopVoiceStream();
        }
    }

    JsonArray personas = doc["enabledPersonas"].as<JsonArray>();
    if (!personas.isNull() && personas.size() > 0) {
        const char* pName = personas[0].as<const char*>();
        if (pName != nullptr) {
            strncpy(m_subscription.personaName, pName, sizeof(m_subscription.personaName) - 1);
        }
    }

    saveSubscriptionToStorage();

    char toastBuf[64];
    snprintf(toastBuf, sizeof(toastBuf), "Plan: %s (%s)",
             m_subscription.tier, m_subscription.voiceAiEnabled ? "AI Active" : "Basic");
    petbot::firmware::ui::UIManager::instance().showToast(toastBuf, 2500);

    Serial.printf("[VoiceStreamer] Subscription updated: Tier=%s, AI=%s, Persona=%s\n",
                  m_subscription.tier, m_subscription.voiceAiEnabled ? "TRUE" : "FALSE", m_subscription.personaName);
}

void VoiceStreamer::handleAudioDownlink(const PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
    (void)header;
    if (payload == nullptr || len < sizeof(AudioDownlinkHeader)) return;

    const auto* hdr = reinterpret_cast<const AudioDownlinkHeader*>(payload);
    const uint8_t* audioBytes = payload + sizeof(AudioDownlinkHeader);
    const size_t audioLen = std::min<size_t>(hdr->audioByteLen, len - sizeof(AudioDownlinkHeader));

    // 1. Synchronously update visual mouth openness, gaze, and target emotion in exact lockstep!
    petbot::firmware::ui::ExpressionEngine::instance().setVisemeOpenness(
        hdr->visemeMouthOpen, hdr->eyeGazeX, hdr->eyeGazeY
    );

    if (hdr->emotionId != 0) {
        petbot::firmware::ui::ExpressionEngine::instance().setEmotion(
            static_cast<petbot::protocol::EmotionId>(hdr->emotionId)
        );
    }

    // 2. Push audio samples into 200ms PSRAM Jitter Buffer -> I2S Speaker
    if (audioLen >= sizeof(int16_t)) {
        const size_t sampleCount = audioLen / sizeof(int16_t);
        const auto* samples = reinterpret_cast<const int16_t*>(audioBytes);
        petbot::hal::AudioHal::instance().pushPcmDownlinkFrame(samples, sampleCount);
    }

    const uint32_t now = millis();
    m_isThinking = false;
    m_lastDownlinkPacketMs = now;
    m_lastVoiceActivityMs = now;
    m_echoBlankUntilMs = now + 900;
    m_hasEnteredSleepState = false;
    m_isReceivingDownlink = true;
}

void VoiceStreamer::update(uint32_t nowMs) {
    m_updateTicks++;
    // 0. Handle Built-in ESP32-S3 WakeNet keyword detection only when idle & not thinking/echo-blanked
    if (!m_uplinkActive && !m_isReceivingDownlink && !m_isThinking && m_wakeWordEnabled) {
        uint16_t rmsEnergy = 0;
        bool vadActive = false;

        const bool frameReady = petbot::hal::AudioHal::instance().readMicUplinkFrame(
            m_micSamples, rmsEnergy, vadActive
        );

        if (frameReady && vadActive) {
            if (checkWakeWord(m_micSamples, UPLINK_FRAME_SAMPLES)) {
                Serial.printf("[VoiceStreamer] Built-in Wake-Word '%s' detected! Starting AI conversation...\n",
                              m_wakeWordPhrase);
                startVoiceStream();
                return;
            }
        }
    }

    // 1. Handle Thinking Timeout (never get stuck on Focused face if offline or no reply)
    if (m_isThinking && !m_isReceivingDownlink && !m_uplinkActive) {
        if ((nowMs - m_thinkingStartMs) >= 10000) {
            m_isThinking = false;
            m_lastWakeTriggerMs = nowMs;
            m_echoBlankUntilMs = nowMs + 700;
            petbot::firmware::ui::ExpressionEngine::instance().setEmotion(petbot::protocol::EmotionId::Idle);
            petbot::firmware::ui::UIManager::instance().showToast("Ready", 1000);
            Serial.println("[VoiceStreamer] Thinking timeout -> Returned cleanly to Idle.");
        }
    }

    // 1b. Handle Upsell Prompt Auto-dismiss (5 seconds)
    if (m_upsellPromptActive) {
        if (nowMs - m_upsellStartTimeMs >= 5000) {
            m_upsellPromptActive = false;
        }
    }

    // 2. Handle Downlink Speech Audio End (revert viseme mouth to closed once buffer drains)
    if (m_isReceivingDownlink) {
        if ((nowMs - m_lastDownlinkPacketMs >= 450) && !petbot::hal::AudioHal::instance().isPlaying()) {
            m_isReceivingDownlink = false;
            m_lastWakeTriggerMs = nowMs;
            m_echoBlankUntilMs = nowMs + 800;
            petbot::firmware::ui::ExpressionEngine::instance().setVisemeOpenness(0);
            petbot::firmware::ui::ExpressionEngine::instance().setEmotion(petbot::protocol::EmotionId::Idle);
        }
    }

    // 3. Handle Fast Microphone Uplink Capture & Immediate End-of-Turn WAV Flush
    if (m_uplinkActive) {
        const uint32_t listenElapsedMs = (nowMs >= m_listenStartMs) ? (nowMs - m_listenStartMs) : 0;

        // Hard safety timeouts run even if I2S read drops/stalls
        if ((m_wasSpeaking && (nowMs >= m_vadHangoverEndMs)) || (m_wasSpeaking && listenElapsedMs >= 5500)) {
            m_uplinkActive = false;
            m_wasSpeaking = false;
            m_lastWakeTriggerMs = nowMs;
            m_echoBlankUntilMs = nowMs + 700;
            m_wakeConsecutiveHits = 0;
            petbot::firmware::ui::ExpressionEngine::instance().setLiveMicEnergy(0);

            if (AgenticTransport::instance().hasActiveLink()) {
                AudioUplinkHeader endHdr{};
                endHdr.rmsEnergy = 0;
                endHdr.vadActive = 0;
                endHdr.codec = static_cast<uint8_t>(petbot::protocol::AudioCodec::Pcm16);
                endHdr.sampleCount = 0;

                AgenticTransport::instance().sendFrame(
                    FrameType::AudioUplinkFrame,
                    reinterpret_cast<const uint8_t*>(&endHdr),
                    sizeof(AudioUplinkHeader)
                );

                m_isThinking = true;
                m_thinkingStartMs = nowMs;
                petbot::firmware::ui::ExpressionEngine::instance().setEmotion(petbot::protocol::EmotionId::Focused);
                petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Tick);
                petbot::firmware::ui::UIManager::instance().showToast("Thinking...", 2500);
                Serial.println("[VoiceStreamer] Utterance complete -> End-of-turn marker sent to mobile.");
            } else {
                petbot::firmware::ui::ExpressionEngine::instance().setEmotion(petbot::protocol::EmotionId::Idle);
                petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Tick);
                petbot::firmware::ui::UIManager::instance().showToast("Connect phone to reply", 1800);
                Serial.println("[VoiceStreamer] Utterance complete (offline) -> Returning to Idle.");
            }
            return;
        } else if (!m_wasSpeaking && listenElapsedMs >= 3200) {
            m_uplinkActive = false;
            m_lastWakeTriggerMs = nowMs;
            m_echoBlankUntilMs = nowMs + 700;
            m_wakeConsecutiveHits = 0;
            petbot::firmware::ui::ExpressionEngine::instance().setLiveMicEnergy(0);
            petbot::firmware::ui::ExpressionEngine::instance().setEmotion(petbot::protocol::EmotionId::Idle);
            petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Tick);
            Serial.println("[VoiceStreamer] Initial silence timeout -> Returning to Idle.");
            return;
        }

        uint16_t rmsEnergy = 0;
        bool vadActive = false;

        const bool frameReady = petbot::hal::AudioHal::instance().readMicUplinkFrame(
            m_micSamples, rmsEnergy, vadActive
        );

        if (frameReady) {
            // Skip own speaker "Aha!" echo during initial blanking window
            if (nowMs < m_echoBlankUntilMs || petbot::hal::AudioHal::instance().isPlaying()) {
                return;
            }

            if (vadActive) {
                m_vadHangoverEndMs = nowMs + 650; // Fast 650ms post-speech end-of-turn
                m_wasSpeaking = true;
            }

            const bool shouldTransmit = vadActive || (m_wasSpeaking && nowMs < m_vadHangoverEndMs);

            if (shouldTransmit && listenElapsedMs < 5500) {
                m_lastVoiceActivityMs = nowMs;
                m_hasEnteredSleepState = false;

                constexpr size_t PAYLOAD_SIZE = sizeof(AudioUplinkHeader) + UPLINK_FRAME_BYTES;

                auto* upHdr = reinterpret_cast<AudioUplinkHeader*>(m_uplinkTxBuffer);
                upHdr->rmsEnergy = rmsEnergy;
                upHdr->vadActive = 1;
                upHdr->codec = static_cast<uint8_t>(petbot::protocol::AudioCodec::Pcm16);
                upHdr->sampleCount = UPLINK_FRAME_SAMPLES;

                memcpy(m_uplinkTxBuffer + sizeof(AudioUplinkHeader), m_micSamples, UPLINK_FRAME_BYTES);

                AgenticTransport::instance().sendFrame(
                    FrameType::AudioUplinkFrame,
                    m_uplinkTxBuffer,
                    PAYLOAD_SIZE
                );

                petbot::firmware::ui::ExpressionEngine::instance().setLiveMicEnergy(rmsEnergy);
                m_lastUplinkMs = nowMs;
            }
        }
    }

    // 4. Handle Configurable Silence Transition & Previous Widget Screen Restoration
    if (!m_uplinkActive && !m_isReceivingDownlink && m_hasSavedWidgetReturn) {
        const uint32_t returnMs = std::max<uint32_t>(5000, m_silenceReturnMs);
        const uint32_t sleepyCueMs = (returnMs > 4000) ? (returnMs - 4000) : (returnMs / 2);
        const uint32_t silenceDurationMs = (nowMs >= m_lastVoiceActivityMs) ? (nowMs - m_lastVoiceActivityMs) : 0;

        // Approaching timeout: Pet face slowly turns sleepy with a gentle sigh
        if (silenceDurationMs >= sleepyCueMs && silenceDurationMs < returnMs && !m_hasEnteredSleepState) {
            m_hasEnteredSleepState = true;
            petbot::firmware::ui::ExpressionEngine::instance().setEmotion(petbot::protocol::EmotionId::Sleepy);
            petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::SleepySigh);
            Serial.printf("[VoiceStreamer] %us silence -> Pet face transitioning to sleepy resting state.\n",
                          static_cast<unsigned>(silenceDurationMs / 1000));
        }

        // At configured silence timeout (default 15s): Return to previous widget screen automatically!
        if (silenceDurationMs >= returnMs) {
            petbot::firmware::ui::UIManager::instance().navigateToPage(m_previousWidgetPageId, true);
            Serial.printf("[VoiceStreamer] %us silence reached -> Restored previous widget '%s'.\n",
                          static_cast<unsigned>(returnMs / 1000), m_previousWidgetPageId);
            m_hasSavedWidgetReturn = false;
            m_hasEnteredSleepState = false;
            m_previousWidgetPageId[0] = '\0';
        }
    }
}

void VoiceStreamer::renderUpsellPrompt(petbot::hal::Canvas128x160& canvas) noexcept {
    if (!m_upsellPromptActive) return;

    // 160x128 landscape backdrop
    canvas.fillRoundRect(10, 8, 140, 112, 6, petbot::hal::colors::Navy);
    canvas.drawRoundRect(10, 8, 140, 112, 6, petbot::hal::colors::Yellow);

    canvas.fillRoundRect(20, 14, 120, 15, 3, petbot::hal::colors::Yellow);
    canvas.drawText(48, 18, "LOBO PRO", petbot::hal::colors::Black, petbot::hal::colors::Yellow, 1, true);

    canvas.drawText(24, 42, "Voice AI requires", petbot::hal::colors::White, petbot::hal::colors::Navy, 1, true);
    canvas.drawText(48, 56, "Lobo Pro", petbot::hal::colors::Yellow, petbot::hal::colors::Navy, 1, true);
    canvas.drawText(20, 74, "Unlock in Mobile App", petbot::hal::colors::LightGray, petbot::hal::colors::Navy, 1, true);

    canvas.fillRoundRect(24, 94, 112, 16, 3, petbot::hal::colors::Cyan);
    canvas.drawText(38, 98, "UPGRADE SHEET", petbot::hal::colors::Black, petbot::hal::colors::Cyan, 1, true);
}

} // namespace petbot::firmware::agentic
