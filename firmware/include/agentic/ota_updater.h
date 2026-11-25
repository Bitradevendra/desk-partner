#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include <memory>

#include "petbot_protocol.h"
#include "apps/app_page.h"
#include "hal/psram_allocator.h"
#include "hal/display_hal.h"

#ifdef ESP32
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <mbedtls/sha256.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#endif

namespace petbot::firmware::agentic {

using petbot::protocol::PetBotFrameHeader;
using petbot::protocol::FrameType;
using petbot::protocol::FrameFlags;
using petbot::protocol::OtaAckStatus;
using petbot::protocol::OtaChunkHeader;
using petbot::protocol::OtaAckPayload;
using petbot::protocol::petbot_crc32;
using petbot::firmware::apps::IAppPage;
using petbot::hal::Canvas128x160;

/**
 * Dedicated 128x160 60FPS OTA Firmware Update Progress Screen
 *
 * Displays a focused, concentrating pet eye animation, "Updating Pet Brain...",
 * version label, and smooth horizontal progress bar during OTA flashing.
 */
class OtaProgressPage : public IAppPage {
public:
    OtaProgressPage() = default;
    ~OtaProgressPage() override = default;

    [[nodiscard]] const char* getPageId() const noexcept override {
        return "ota_progress";
    }

    [[nodiscard]] const char* getPageTitle() const noexcept override {
        return "Brain Update";
    }

    void onEnter() override;
    void onExit() override;

    void update(uint32_t nowMs, float dt) override;
    void render(Canvas128x160& canvas) override;

    void setProgress(uint8_t progressPct, const char* version) noexcept;

private:
    uint8_t m_targetProgress{0};
    float m_smoothProgress{0.0f};
    char m_version[32]{"v2.0.0"};
    uint32_t m_lastUpdateMs{0};
    float m_eyePulse{0.0f};
};

/**
 * ESP32-S3 Dual-Partition Over-The-Air (OTA) Firmware Updater
 *
 * Coordinates:
 * - Boot health check and automatic bootloader rollback cancellation (app0 / app1)
 * - Ed25519 digital signature and SHA-256 binary integrity verification
 * - 16KB chunk streaming with IEEE 802.3 CRC32 verification
 * - Dedicated 60FPS focused pet OTA Progress Screen
 * - Safe atomic partition swap and reboot on completion
 */
class OtaUpdater {
public:
    static OtaUpdater& instance() {
        static OtaUpdater s_instance;
        return s_instance;
    }

    OtaUpdater(const OtaUpdater&) = delete;
    OtaUpdater& operator=(const OtaUpdater&) = delete;

    /**
     * Called during early boot to verify partition health.
     * Cancels automatic bootloader rollback once display & storage are confirmed operational.
     */
    void initOnBoot();

    /**
     * Confirms the running application is healthy, cancelling bootloader rollback.
     */
    bool confirmRunningAppValid();

    /**
     * Initialize OTA subsystems and register frame handlers with AgenticTransport.
     */
    bool init();

    /**
     * Inbound Protocol Frame Handlers
     */
    void handleOtaStart(const PetBotFrameHeader& header, const uint8_t* payload, size_t len);
    void handleOtaChunk(const PetBotFrameHeader& header, const uint8_t* payload, size_t len);

    [[nodiscard]] bool isOtaActive() const noexcept {
        return m_active;
    }

    [[nodiscard]] uint8_t getProgressPercentage() const noexcept {
        return m_progressPct;
    }

    [[nodiscard]] const char* getTargetVersion() const noexcept {
        return m_version;
    }

    [[nodiscard]] const char* getRunningPartitionLabel() const noexcept {
        return m_runningPartitionLabel;
    }

private:
    OtaUpdater();
    ~OtaUpdater();

    void sendAck(uint32_t transferId, uint32_t nextExpectedChunk, uint8_t progressPct, OtaAckStatus status, uint16_t seqId = 0);
    void abortUpdate(OtaAckStatus status, const char* reason, uint16_t seqId = 0);

#ifdef ESP32
    esp_ota_handle_t m_otaHandle{0};
    const esp_partition_t* m_updatePartition{nullptr};
    mbedtls_sha256_context m_shaCtx{};
    mutable SemaphoreHandle_t m_mutex{nullptr};
#endif

    bool m_active{false};
    uint32_t m_transferId{0};
    char m_version[32]{0};
    uint32_t m_totalBytes{0};
    uint32_t m_totalChunks{0};
    char m_sha256Hex[65]{0};
    char m_ed25519SignatureHex[129]{0};
    uint32_t m_nextExpectedChunk{0};
    uint32_t m_writtenBytes{0};
    uint8_t m_progressPct{0};

    char m_runningPartitionLabel[16]{"app0"};
    std::shared_ptr<OtaProgressPage> m_progressPage{nullptr};
};

} // namespace petbot::firmware::agentic
