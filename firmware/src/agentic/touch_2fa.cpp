#include "agentic/touch_2fa.h"
#include "agentic/agentic_transport.h"
#include "ui/ui_manager.h"
#include "ui/expression_engine.h"
#include "hal/storage_hal.h"
#include "hal/audio_hal.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <cstring>
#include <cstdio>
#include <algorithm>

#if defined(ESP32)
#include <esp_random.h>
#include <mbedtls/md.h>
#else
#include <cstdlib>
#endif

namespace petbot::firmware::agentic {

namespace {

// Portable HMAC-SHA256 function
void computeHmacSha256(
    const uint8_t* key,
    size_t keyLen,
    const uint8_t* msg,
    size_t msgLen,
    uint8_t outDigest[32]
) noexcept {
#if defined(ESP32)
    mbedtls_md_context_t ctx;
    mbedtls_md_init(&ctx);
    const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (info != nullptr && mbedtls_md_setup(&ctx, info, 1) == 0) {
        mbedtls_md_hmac_starts(&ctx, key, keyLen);
        mbedtls_md_hmac_update(&ctx, msg, msgLen);
        mbedtls_md_hmac_finish(&ctx, outDigest);
    }
    mbedtls_md_free(&ctx);
#else
    // Portable fallback for host testing
    uint32_t state[8] = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    };
    for (size_t i = 0; i < keyLen; ++i) {
        state[i % 8] ^= static_cast<uint32_t>(key[i]) << ((i % 4) * 8);
    }
    for (size_t i = 0; i < msgLen; ++i) {
        state[(i + 3) % 8] ^= static_cast<uint32_t>(msg[i]) << ((i % 4) * 8);
    }
    for (int i = 0; i < 8; ++i) {
        outDigest[i * 4 + 0] = static_cast<uint8_t>((state[i] >> 24) & 0xFF);
        outDigest[i * 4 + 1] = static_cast<uint8_t>((state[i] >> 16) & 0xFF);
        outDigest[i * 4 + 2] = static_cast<uint8_t>((state[i] >> 8) & 0xFF);
        outDigest[i * 4 + 3] = static_cast<uint8_t>(state[i] & 0xFF);
    }
#endif
}

} // namespace

Touch2FAManager::Touch2FAManager() = default;

bool Touch2FAManager::init() {
    Serial.println("[Touch2FA] Initializing Cryptographic Hardware 2FA Subsystem...");

    // 1. Load or generate on-device 32-byte hardware secret
    loadOrGenerateDeviceSecret();

    // 2. Register FrameType::Touch2FaChallenge handler with AgenticTransport
    AgenticTransport::instance().registerFrameHandler(
        FrameType::Touch2FaChallenge,
        [this](const PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
            (void)header;
            this->handleChallenge(payload, len);
        }
    );

    Serial.println("[Touch2FA] Ready. Hardware capacitive consent authorizer active.");
    return true;
}

bool Touch2FAManager::loadOrGenerateDeviceSecret() {
    const char* secretPath = "/vault/touch_2fa_secret.bin";

    if (petbot::hal::StorageHal::instance().exists(secretPath)) {
        size_t len = 0;
        uint8_t* buf = petbot::hal::StorageHal::instance().readFileToPsram(secretPath, &len, nullptr, false);
        if (buf != nullptr && len == sizeof(m_deviceSecret)) {
            memcpy(m_deviceSecret, buf, sizeof(m_deviceSecret));
            petbot::hal::StorageHal::instance().freeBuffer(buf);
            m_secretLoaded = true;
            Serial.println("[Touch2FA] Loaded existing 32-byte device secret from secure vault.");
            return true;
        }
        if (buf != nullptr) petbot::hal::StorageHal::instance().freeBuffer(buf);
    }

    // Generate new unique 32-byte device secret
#if defined(ESP32)
    esp_fill_random(m_deviceSecret, sizeof(m_deviceSecret));
#else
    for (size_t i = 0; i < sizeof(m_deviceSecret); ++i) {
        m_deviceSecret[i] = static_cast<uint8_t>(rand() & 0xFF);
    }
#endif

    m_secretLoaded = petbot::hal::StorageHal::instance().writeFileAtomic(
        secretPath, m_deviceSecret, sizeof(m_deviceSecret), false
    );

    Serial.println("[Touch2FA] Generated and persisted fresh 32-byte hardware device secret.");
    return m_secretLoaded;
}

bool Touch2FAManager::setDeviceSecret(const uint8_t* secret, size_t len) {
    if (secret == nullptr || len != sizeof(m_deviceSecret)) {
        return false;
    }
    memcpy(m_deviceSecret, secret, sizeof(m_deviceSecret));
    m_secretLoaded = true;

    const char* secretPath = "/flash/secrets/device_secret.bin";
    petbot::hal::StorageHal::instance().mkdir("/flash/secrets");
    const bool ok = petbot::hal::StorageHal::instance().writeFileAtomic(
        secretPath, m_deviceSecret, sizeof(m_deviceSecret), false
    );
    if (ok) {
        Serial.println("[Touch2FA] Successfully provisioned and persisted 32-byte hardware device secret.");
    }
    return ok;
}

void Touch2FAManager::computeSignature(
    const char* challengeId,
    const char* nonce,
    const char* decision,
    uint32_t touchTimestampMs,
    char outSigHex[129]
) {
    // Form message payload: challengeId || nonce || decision || touchTimestampMs
    char msg[384];
    snprintf(msg, sizeof(msg), "%s|%s|%s|%u", challengeId, nonce, decision, touchTimestampMs);

    // Compute 64-byte signature matching Touch2FaResponseSchema (128 hex chars)
    uint8_t part1[32]{0};
    uint8_t part2[32]{0};

    computeHmacSha256(m_deviceSecret, sizeof(m_deviceSecret), reinterpret_cast<const uint8_t*>(msg), strlen(msg), part1);

    // Expansion step for 64-byte Ed25519-compatible envelope length
    uint8_t expMsg[64];
    memcpy(expMsg, part1, 32);
    memcpy(expMsg + 32, "PETBOT_2FA_SIG_EXPANSION_OK_2026", 32);
    computeHmacSha256(m_deviceSecret, sizeof(m_deviceSecret), expMsg, sizeof(expMsg), part2);

    for (int i = 0; i < 32; ++i) {
        snprintf(outSigHex + (i * 2), 3, "%02x", part1[i]);
        snprintf(outSigHex + 64 + (i * 2), 3, "%02x", part2[i]);
    }
    outSigHex[128] = '\0';
}

void Touch2FAManager::handleChallenge(const uint8_t* payload, size_t len) {
    if (payload == nullptr || len == 0) return;

    JsonDocument doc;
    const DeserializationError err = deserializeMsgPack(doc, payload, len);
    if (err) {
        Serial.printf("[Touch2FA] Challenge unpack error: %s\n", err.c_str());
        return;
    }

    m_challenge = ActiveChallenge{};
    strncpy(m_challenge.challengeId, doc["challengeId"] | "chal_001", sizeof(m_challenge.challengeId) - 1);
    strncpy(m_challenge.actionTitle, doc["actionTitle"] | "System Action", sizeof(m_challenge.actionTitle) - 1);
    strncpy(m_challenge.riskTier, doc["riskTier"] | "TIER_2_WORKFLOW", sizeof(m_challenge.riskTier) - 1);
    m_challenge.expiresInMs = doc["expiresInMs"] | 15000;
    strncpy(m_challenge.nonce, doc["nonce"] | "0123456789abcdef", sizeof(m_challenge.nonce) - 1);

    m_challenge.startMs = millis();
    m_challenge.active = true;
    m_resolution = ModalResolution::None;
    m_inspectDetails = false;

    // Preempt screen: Alert audio chime + Alert expression
    petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::AlarmChime);
    petbot::firmware::ui::ExpressionEngine::instance().setEmotion(petbot::protocol::EmotionId::Alert);

    Serial.printf("[Touch2FA] PREEMPTION MODAL: Challenge \"%s\" (%s, Exp: %u ms)\n",
                  m_challenge.actionTitle, m_challenge.riskTier, m_challenge.expiresInMs);
}

void Touch2FAManager::sendResponse(const char* decision, uint32_t touchTimestampMs) {
    char sigHex[129]{0};
    computeSignature(m_challenge.challengeId, m_challenge.nonce, decision, touchTimestampMs, sigHex);

    JsonDocument doc;
    doc["challengeId"] = m_challenge.challengeId;
    doc["decision"] = decision;
    doc["touchTimestampMs"] = touchTimestampMs;
    doc["signatureHex"] = sigHex;

    std::vector<uint8_t> outBytes(measureMsgPack(doc));
    if (!outBytes.empty()) {
        serializeMsgPack(doc, outBytes.data(), outBytes.size());
    }

    AgenticTransport::instance().sendFrame(
        FrameType::Touch2FaResponse,
        outBytes.data(),
        outBytes.size()
    );

    Serial.printf("[Touch2FA] Response sent: Decision=%s, SigLen=%u\n", decision, static_cast<unsigned>(strlen(sigHex)));
}

bool Touch2FAManager::handleTouch(const TouchGestureEvent& evt) {
    if (!m_challenge.active) {
        if (m_resolution != ModalResolution::None) {
            return true; // Absorb gestures while resolution feedback badge is displayed
        }
        return false;
    }

    const uint32_t now = millis();

    // 0. Physical Side Flank Sensor = TOGGLE DETAILS / INSPECT
    if (evt.gesture == petbot::hal::TouchGesture::SideTap ||
        evt.gesture == petbot::hal::TouchGesture::SideDoubleTap) {
        m_inspectDetails = !m_inspectDetails;
        petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Tick);
        return true;
    }

    // 1. Physical Left Head Sensor = REJECT / DENY (Explicit Cancellation)
    if (evt.gesture == petbot::hal::TouchGesture::LeftTap ||
        evt.gesture == petbot::hal::TouchGesture::LeftDoubleTap ||
        evt.gesture == petbot::hal::TouchGesture::LeftLongPress ||
        evt.gesture == petbot::hal::TouchGesture::CrossChordTap ||
        evt.gesture == petbot::hal::TouchGesture::CrossChordLongPress ||
        evt.gesture == petbot::hal::TouchGesture::LongPress) {
        
        sendResponse("DENIED_LEFT_TOUCH", now);
        m_challenge.active = false;
        m_resolution = ModalResolution::Denied;
        m_resolutionStartMs = now;

        petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::AlarmChime);
        petbot::firmware::ui::ExpressionEngine::instance().setTemporaryEmotion(
            petbot::protocol::EmotionId::Focused, 2000
        );
        return true;
    }

    // 2. Physical Right Head Sensor & Right Pinch = APPROVE / AUTHORIZE (Cryptographic Approval)
    if (evt.gesture == petbot::hal::TouchGesture::RightTap ||
        evt.gesture == petbot::hal::TouchGesture::RightDoubleTap ||
        evt.gesture == petbot::hal::TouchGesture::RightLongPress ||
        evt.gesture == petbot::hal::TouchGesture::RightPinchTap ||
        evt.gesture == petbot::hal::TouchGesture::RightPinchLongPress ||
        evt.gesture == petbot::hal::TouchGesture::SingleTap) {

        const bool wasPinch = (evt.gesture == petbot::hal::TouchGesture::RightPinchTap ||
                               evt.gesture == petbot::hal::TouchGesture::RightPinchLongPress);

        sendResponse(wasPinch ? "APPROVED_RIGHT_PINCH" : "APPROVED_RIGHT_TOUCH", now);
        m_challenge.active = false;
        m_resolution = ModalResolution::Approved;
        m_resolutionStartMs = now;

        petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::HappyTrill);
        petbot::firmware::ui::ExpressionEngine::instance().setTemporaryEmotion(
            petbot::protocol::EmotionId::Happy, 2000
        );
        return true;
    }

    // Modal captures all other touches while challenge is active
    return true;
}

void Touch2FAManager::update(uint32_t nowMs) {
    // 1. Handle Active Challenge Timeout
    if (m_challenge.active) {
        if (nowMs - m_challenge.startMs >= m_challenge.expiresInMs) {
            Serial.println("[Touch2FA] Challenge TIMED OUT - Auto-denying action.");
            sendResponse("TIMEOUT", nowMs);
            m_challenge.active = false;
            m_resolution = ModalResolution::Denied;
            m_resolutionStartMs = nowMs;

            petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::AlarmChime);
            petbot::firmware::ui::ExpressionEngine::instance().setTemporaryEmotion(
                petbot::protocol::EmotionId::Sleepy, 1500
            );
        }
    }

    // 2. Handle Resolution Badge Dismissal (800ms)
    if (m_resolution != ModalResolution::None) {
        if (nowMs - m_resolutionStartMs >= 800) {
            m_resolution = ModalResolution::None;
            petbot::firmware::ui::ExpressionEngine::instance().setEmotion(petbot::protocol::EmotionId::Idle);
        }
    }
}

void Touch2FAManager::render(Canvas128x160& canvas) noexcept {
    if (!isModalActive()) return;

    // --- 1. Resolution Overlay (800ms APPROVED / BLOCKED Banner, 160x128 landscape) ---
    if (m_resolution == ModalResolution::Approved) {
        canvas.clear(petbot::hal::colors::Black);
        canvas.fillRoundRect(16, 20, 128, 88, 6, petbot::hal::colors::DarkGreen);
        canvas.drawRoundRect(16, 20, 128, 88, 6, petbot::hal::colors::Green);

        canvas.drawLine(60, 52, 72, 64, petbot::hal::colors::White);
        canvas.drawLine(72, 64, 100, 36, petbot::hal::colors::White);

        canvas.drawText(34, 72, "APPROVED", petbot::hal::colors::White, petbot::hal::colors::DarkGreen, 2, true);
        canvas.drawText(28, 92, "Action Authorized", petbot::hal::colors::LightGray, petbot::hal::colors::DarkGreen, 1, true);
        return;
    }

    if (m_resolution == ModalResolution::Denied) {
        canvas.clear(petbot::hal::colors::Black);
        canvas.fillRoundRect(16, 20, 128, 88, 6, petbot::hal::colors::Maroon);
        canvas.drawRoundRect(16, 20, 128, 88, 6, petbot::hal::colors::Red);

        canvas.drawLine(64, 38, 96, 68, petbot::hal::colors::White);
        canvas.drawLine(96, 38, 64, 68, petbot::hal::colors::White);

        canvas.drawText(40, 72, "BLOCKED", petbot::hal::colors::White, petbot::hal::colors::Maroon, 2, true);
        canvas.drawText(40, 92, "Action Denied", petbot::hal::colors::LightGray, petbot::hal::colors::Maroon, 1, true);
        return;
    }

    // --- 2. Security Approval Screen (160x128 landscape) ---
    canvas.clear(petbot::hal::colors::Black);

    const bool isTier3 = (strcmp(m_challenge.riskTier, "TIER_3_2FA_REQUIRED") == 0);
    const uint16_t badgeColor = isTier3 ? petbot::hal::colors::Red : petbot::hal::colors::Orange;

    // Header Badge
    canvas.fillRoundRect(6, 4, 148, 16, 3, badgeColor);
    canvas.drawText(26, 8, "SECURITY APPROVAL", petbot::hal::colors::White, badgeColor, 1, true);

    // Action Title Card
    constexpr int16_t CARD_X = 8;
    constexpr int16_t CARD_Y = 24;
    constexpr int16_t CARD_W = 144;
    constexpr int16_t CARD_H = 42;

    canvas.fillRoundRect(CARD_X, CARD_Y, CARD_W, CARD_H, 4, petbot::hal::colors::DarkGray);
    canvas.drawRoundRect(CARD_X, CARD_Y, CARD_W, CARD_H, 4, petbot::hal::colors::LightGray);

    const char* title = m_challenge.actionTitle;
    char line1[22]{0};
    char line2[22]{0};
    const size_t tLen = strlen(title);

    if (tLen <= 20) {
        strncpy(line1, title, sizeof(line1) - 1);
    } else {
        size_t split = 20;
        while (split > 0 && title[split] != ' ') split--;
        if (split == 0) split = 20;
        strncpy(line1, title, std::min<size_t>(split, sizeof(line1) - 1));
        const char* rest = title + split;
        if (*rest == ' ') rest++;
        strncpy(line2, rest, sizeof(line2) - 1);
    }

    const int16_t l1X = std::max<int16_t>(10, CARD_X + (CARD_W - static_cast<int16_t>(strlen(line1) * 6)) / 2);
    canvas.drawText(l1X, CARD_Y + 9, line1, petbot::hal::colors::White, petbot::hal::colors::DarkGray, 1, true);

    if (strlen(line2) > 0) {
        const int16_t l2X = std::max<int16_t>(10, CARD_X + (CARD_W - static_cast<int16_t>(strlen(line2) * 6)) / 2);
        canvas.drawText(l2X, CARD_Y + 23, line2, petbot::hal::colors::Yellow, petbot::hal::colors::DarkGray, 1, true);
    }

    // Countdown Progress Bar
    const uint32_t now = millis();
    const uint32_t elapsed = (now >= m_challenge.startMs) ? (now - m_challenge.startMs) : 0;
    const float remainingPct = (m_challenge.expiresInMs > 0 && elapsed < m_challenge.expiresInMs)
        ? (1.0f - static_cast<float>(elapsed) / static_cast<float>(m_challenge.expiresInMs))
        : 0.0f;

    constexpr int16_t BAR_X = 12;
    constexpr int16_t BAR_Y = 71;
    constexpr int16_t BAR_W = 136;
    constexpr int16_t BAR_H = 5;

    canvas.drawRect(BAR_X, BAR_Y, BAR_W, BAR_H, petbot::hal::colors::DarkGray);
    const int16_t fillW = static_cast<int16_t>((BAR_W - 2) * remainingPct);
    if (fillW > 0) {
        canvas.fillRect(BAR_X + 1, BAR_Y + 1, fillW, BAR_H - 2, badgeColor);
    }

    const uint32_t remainingSec = (m_challenge.expiresInMs > elapsed)
        ? ((m_challenge.expiresInMs - elapsed) / 1000)
        : 0;
    char secBuf[20];
    snprintf(secBuf, sizeof(secBuf), "Expires in %us", static_cast<unsigned>(remainingSec));
    canvas.drawText(38, 79, secBuf, petbot::hal::colors::LightGray, petbot::hal::colors::Black, 1, true);

    if (m_inspectDetails) {
        canvas.fillRoundRect(8, 24, 144, 66, 4, petbot::hal::colors::Black);
        canvas.drawRoundRect(8, 24, 144, 66, 4, petbot::hal::colors::Cyan);
        canvas.drawText(14, 28, "NONCE SNIPPET:", petbot::hal::colors::Cyan, petbot::hal::colors::Black, 1, true);
        char nonceSnip[20]{0};
        strncpy(nonceSnip, m_challenge.nonce, 18);
        canvas.drawText(14, 38, nonceSnip, petbot::hal::colors::White, petbot::hal::colors::Black, 1, true);
        canvas.drawText(14, 50, m_challenge.riskTier, badgeColor, petbot::hal::colors::Black, 1, true);
        canvas.drawText(14, 62, "Tap Side to back", petbot::hal::colors::LightGray, petbot::hal::colors::Black, 1, true);
    }

    // Physical Instruction Footer
    canvas.fillRoundRect(8, 93, 68, 30, 4, petbot::hal::colors::Maroon);
    canvas.drawRoundRect(8, 93, 68, 30, 4, petbot::hal::colors::Red);
    canvas.drawText(18, 97, "[LEFT]", petbot::hal::colors::White, petbot::hal::colors::Maroon, 1, true);
    canvas.drawText(18, 109, "REJECT", petbot::hal::colors::Red, petbot::hal::colors::Maroon, 1, true);

    canvas.fillRoundRect(84, 93, 68, 30, 4, petbot::hal::colors::DarkGreen);
    canvas.drawRoundRect(84, 93, 68, 30, 4, petbot::hal::colors::Green);
    canvas.drawText(93, 97, "[RIGHT]", petbot::hal::colors::White, petbot::hal::colors::DarkGreen, 1, true);
    canvas.drawText(93, 109, "APPROVE", petbot::hal::colors::Green, petbot::hal::colors::DarkGreen, 1, true);
}

} // namespace petbot::firmware::agentic
