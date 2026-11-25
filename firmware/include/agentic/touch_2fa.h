#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

#include "petbot_protocol.h"
#include "hal/psram_allocator.h"
#include "hal/touch_hal.h"
#include "ui/expression_engine.h"

namespace petbot::firmware::agentic {

using petbot::protocol::PetBotFrameHeader;
using petbot::protocol::FrameType;
using petbot::protocol::Touch2FADecision;
using petbot::hal::TouchGestureEvent;
using petbot::hal::Canvas128x160;

/**
 * Active Touch 2FA Challenge State
 */
struct ActiveChallenge {
    char challengeId[64]{0};
    char actionTitle[64]{0};
    char riskTier[32]{"TIER_2_WORKFLOW"};
    uint32_t expiresInMs{15000};
    char nonce[128]{0};
    uint32_t startMs{0};
    bool active{false};
};

enum class ModalResolution : uint8_t {
    None     = 0,
    Approved = 1,
    Denied   = 2
};

/**
 * Cryptographic Hardware 2FA Consent Manager (Touch2FAManager)
 *
 * Turns the pet robot's physical capacitive touch sensor into a hardware security key.
 * Signs challenge nonces with an on-device 32-byte hardware secret and presents
 * a high-visibility 128x160 preemption consent modal on the TFT display.
 */
class Touch2FAManager {
public:
    static Touch2FAManager& instance() {
        static Touch2FAManager s_instance;
        return s_instance;
    }

    Touch2FAManager(const Touch2FAManager&) = delete;
    Touch2FAManager& operator=(const Touch2FAManager&) = delete;

    /**
     * Initialize 2FA manager:
     * - Generate or load 32-byte hardware device secret from secure storage
     * - Register FrameType::Touch2FaChallenge with AgenticTransport
     */
    bool init();

    /**
     * Set and persist the 32-byte hardware device secret used for HMAC-SHA256 signature generation.
     */
    bool setDeviceSecret(const uint8_t* secret, size_t len);

    /**
     * Protocol Frame Handler for incoming Desktop Harness 2FA challenges.
     */
    void handleChallenge(const uint8_t* payload, size_t len);

    /**
     * Intercept physical touch gesture from TouchHal while modal is active.
     * @return true if event was consumed by 2FA modal.
     */
    bool handleTouch(const TouchGestureEvent& evt);

    /**
     * Periodic 60FPS update for countdown progress bar, auto-timeout, and resolution badge timers.
     */
    void update(uint32_t nowMs);

    /**
     * Render the high-visibility Security Consent Modal over the active screen.
     */
    void render(Canvas128x160& canvas) noexcept;

    [[nodiscard]] bool isModalActive() const noexcept {
        return m_challenge.active || (m_resolution != ModalResolution::None);
    }

    [[nodiscard]] const ActiveChallenge& getActiveChallenge() const noexcept {
        return m_challenge;
    }

private:
    Touch2FAManager();
    ~Touch2FAManager() = default;

    bool loadOrGenerateDeviceSecret();
    void computeSignature(
        const char* challengeId,
        const char* nonce,
        const char* decision,
        uint32_t touchTimestampMs,
        char outSigHex[129]
    );

    void sendResponse(const char* decision, uint32_t touchTimestampMs);

    uint8_t m_deviceSecret[32]{0};
    bool m_secretLoaded{false};

    ActiveChallenge m_challenge{};
    ModalResolution m_resolution{ModalResolution::None};
    uint32_t m_resolutionStartMs{0};
    bool m_inspectDetails{false};
};

} // namespace petbot::firmware::agentic
