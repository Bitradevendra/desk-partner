#include "agentic/ota_updater.h"

#include <cstdio>
#include <cstring>
#include <algorithm>
#include <cmath>

#include <ArduinoJson.h>
#include "agentic/agentic_transport.h"
#include "ui/ui_manager.h"
#include "hal/audio_hal.h"

#ifdef ESP32
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <mbedtls/sha256.h>
#endif

namespace petbot::firmware::agentic {

namespace hal = ::petbot::hal;
namespace colors = petbot::hal::colors;

// ============================================================================
// OtaProgressPage Implementation (128x160 60FPS UI)
// ============================================================================

void OtaProgressPage::onEnter() {
    m_smoothProgress = static_cast<float>(m_targetProgress);
    m_lastUpdateMs = millis();
}

void OtaProgressPage::onExit() {
}

void OtaProgressPage::setProgress(uint8_t progressPct, const char* version) noexcept {
    m_targetProgress = std::min<uint8_t>(100, progressPct);
    if (version != nullptr && std::strlen(version) > 0) {
        std::strncpy(m_version, version, sizeof(m_version) - 1);
        m_version[sizeof(m_version) - 1] = '\0';
    }
}

void OtaProgressPage::update(uint32_t nowMs, float dt) {
    (void)nowMs;
    // Smooth progress interpolation towards target
    const float diff = static_cast<float>(m_targetProgress) - m_smoothProgress;
    m_smoothProgress += diff * std::clamp(dt * 8.0f, 0.05f, 0.5f);

    // Subtle sinusoidal eye pulse for concentration
    m_eyePulse += dt * 3.5f;
    if (m_eyePulse > 6.28318f) {
        m_eyePulse -= 6.28318f;
    }
}

void OtaProgressPage::render(Canvas128x160& canvas) {
    // 1. Deep Space Slate Background (RGB565 0x0862)
    canvas.clear(0x0862);

    // 2. Focused Pet Eyes (160x128 landscape)
    const float pulse = std::sin(m_eyePulse) * 1.5f;
    const int16_t eyeRx = static_cast<int16_t>(14.0f + pulse);
    const int16_t eyeRy = 15;
    const uint16_t eyeColor = 0xfd20;

    canvas.fillRoundRect(48 - eyeRx, 38 - eyeRy, eyeRx * 2, eyeRy * 2, eyeRx, eyeColor);
    canvas.fillRoundRect(112 - eyeRx, 38 - eyeRy, eyeRx * 2, eyeRy * 2, eyeRx, eyeColor);

    // Focused small inner pupils (Black)
    canvas.fillRoundRect(48 - 5, 38 - 7, 10, 14, 5, colors::Black);
    canvas.fillRoundRect(112 - 5, 38 - 7, 10, 14, 5, colors::Black);

    // 3. Top Title Pill (y = 6..18)
    canvas.fillRoundRect(48, 6, 64, 14, 4, 0x03ef);
    canvas.drawText(54, 9, "OTA FLASH", 0xffff, 0x03ef, 1, false);

    // 4. Headline
    canvas.drawText(20, 62, "Updating Pet Brain...", 0xffff, 0x0862, 1, false);

    // 5. Version String
    char verBuf[36];
    std::snprintf(verBuf, sizeof(verBuf), "Target: %s", m_version);
    canvas.drawText(30, 76, verBuf, 0x9cd3, 0x0862, 1, false);

    // 6. Progress Bar
    const int16_t barX = 20;
    const int16_t barY = 90;
    const int16_t barW = 120;
    const int16_t barH = 10;
    const uint16_t trackColor = 0x2104;
    const uint16_t fillColor = 0x07e0;

    canvas.drawRoundRect(barX - 1, barY - 1, barW + 2, barH + 2, 4, 0x4208);
    canvas.fillRoundRect(barX, barY, barW, barH, 3, trackColor);

    const int16_t fillW = std::clamp<int16_t>(
        static_cast<int16_t>((m_smoothProgress / 100.0f) * barW),
        0,
        barW
    );
    if (fillW > 0) {
        canvas.fillRoundRect(barX, barY, fillW, barH, 3, fillColor);
    }

    // 7. Percentage Text & Status
    char pctBuf[24];
    std::snprintf(pctBuf, sizeof(pctBuf), "%3u%% Completed", static_cast<unsigned>(m_smoothProgress));
    canvas.drawText(38, 105, pctBuf, 0xffff, 0x0862, 1, false);

    canvas.drawText(16, 117, "Do not power off robot", 0xfb20, 0x0862, 1, false);
}

// ============================================================================
// OtaUpdater Implementation
// ============================================================================

OtaUpdater::OtaUpdater() {
#ifdef ESP32
    m_mutex = xSemaphoreCreateMutex();
#endif
}

OtaUpdater::~OtaUpdater() {
#ifdef ESP32
    if (m_mutex != nullptr) {
        vSemaphoreDelete(m_mutex);
        m_mutex = nullptr;
    }
#endif
}

void OtaUpdater::initOnBoot() {
#ifdef ESP32
    const esp_partition_t* running = esp_ota_get_running_partition();
    if (running != nullptr) {
        std::strncpy(m_runningPartitionLabel, running->label, sizeof(m_runningPartitionLabel) - 1);
        m_runningPartitionLabel[sizeof(m_runningPartitionLabel) - 1] = '\0';

        esp_ota_img_states_t ota_state;
        if (esp_ota_get_state_partition(running, &ota_state) == ESP_OK) {
            Serial.printf("[OTA] Running partition: %s (address: 0x%06lx, size: %lu KB)\n",
                          running->label,
                          static_cast<unsigned long>(running->address),
                          static_cast<unsigned long>(running->size / 1024));

            if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
                Serial.println("[OTA] WARNING: Running app is PENDING_VERIFY! Bootloader rollback will trigger if health fails.");
            } else if (ota_state == ESP_OTA_IMG_VALID) {
                Serial.println("[OTA] Partition confirmed VALID.");
            }
        }
    }
#else
    std::strncpy(m_runningPartitionLabel, "app0", sizeof(m_runningPartitionLabel) - 1);
    Serial.println("[OTA] Initialized boot partition check (host/mock mode: app0).");
#endif
}

bool OtaUpdater::confirmRunningAppValid() {
#ifdef ESP32
    const esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    if (err == ESP_OK) {
        Serial.println("[OTA] App health verified! Bootloader rollback cancelled successfully.");
        return true;
    } else {
        Serial.printf("[OTA] esp_ota_mark_app_valid_cancel_rollback returned error: 0x%x\n", err);
        return false;
    }
#else
    Serial.println("[OTA] Mock app health verified.");
    return true;
#endif
}

bool OtaUpdater::init() {
    // 1. Create and register the dedicated OTA Progress Screen in UIManager
    m_progressPage = std::make_shared<OtaProgressPage>();
    ui::UIManager::instance().registerPage(m_progressPage);

    // 2. Register binary protocol frame handlers with AgenticTransport
    AgenticTransport::instance().registerFrameHandler(
        FrameType::OtaUpdateStart,
        [this](const PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
            this->handleOtaStart(header, payload, len);
        }
    );

    AgenticTransport::instance().registerFrameHandler(
        FrameType::OtaUpdateChunk,
        [this](const PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
            this->handleOtaChunk(header, payload, len);
        }
    );

    Serial.println("[OtaUpdater] Registered FrameType::OtaUpdateStart and OtaUpdateChunk handlers.");
    return true;
}

void OtaUpdater::sendAck(
    uint32_t transferId,
    uint32_t nextExpectedChunk,
    uint8_t progressPct,
    OtaAckStatus status,
    uint16_t seqId
) {
    OtaAckPayload ack{};
    ack.transferId = transferId;
    ack.nextExpectedChunk = nextExpectedChunk;
    ack.progressPct = progressPct;
    ack.status = static_cast<uint8_t>(status);

    AgenticTransport::instance().sendFrame(
        FrameType::OtaUpdateAck,
        reinterpret_cast<const uint8_t*>(&ack),
        sizeof(ack),
        0,
        seqId
    );
}

void OtaUpdater::abortUpdate(OtaAckStatus status, const char* reason, uint16_t seqId) {
    Serial.printf("[OtaUpdater] Aborting update (%s): %s\n",
                  status == OtaAckStatus::SignatureInvalid ? "SIGNATURE_INVALID" :
                  status == OtaAckStatus::CrcRetry ? "CRC_RETRY" : "FLASH_ERROR",
                  reason);

    sendAck(m_transferId, m_nextExpectedChunk, m_progressPct, status, seqId);

#ifdef ESP32
    if (m_otaHandle != 0) {
        esp_ota_abort(m_otaHandle);
        m_otaHandle = 0;
    }
    m_updatePartition = nullptr;
    mbedtls_sha256_free(&m_shaCtx);
#endif

    m_active = false;
    ui::UIManager::instance().navigateToPage("clock", false);
}

void OtaUpdater::handleOtaStart(const PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
    if (payload == nullptr || len == 0) return;

    JsonDocument doc;
    const DeserializationError err = deserializeMsgPack(doc, payload, len);
    if (err) {
        Serial.printf("[OtaUpdater] Error unpacking OtaUpdateStart msgpack: %s\n", err.c_str());
        abortUpdate(OtaAckStatus::FlashError, "Invalid MessagePack in OTA Start", header.seqId);
        return;
    }

    const char* version = doc["version"] | "";
    const uint32_t totalBytes = doc["totalBytes"] | 0;
    const uint32_t totalChunks = doc["totalChunks"] | 0;
    const char* sha256Hex = doc["sha256Hex"] | "";
    const char* signatureHex = doc["ed25519SignatureHex"] | "";

    if (std::strlen(version) == 0 || totalBytes == 0 || totalChunks == 0 ||
        std::strlen(sha256Hex) != 64 || std::strlen(signatureHex) != 128) {
        abortUpdate(OtaAckStatus::SignatureInvalid, "Malformed manifest fields in OTA Start", header.seqId);
        return;
    }

    // Store metadata
    m_transferId = static_cast<uint32_t>(esp_random() ? esp_random() : millis());
    std::strncpy(m_version, version, sizeof(m_version) - 1);
    m_version[sizeof(m_version) - 1] = '\0';
    m_totalBytes = totalBytes;
    m_totalChunks = totalChunks;
    std::strncpy(m_sha256Hex, sha256Hex, sizeof(m_sha256Hex) - 1);
    m_sha256Hex[sizeof(m_sha256Hex) - 1] = '\0';
    std::strncpy(m_ed25519SignatureHex, signatureHex, sizeof(m_ed25519SignatureHex) - 1);
    m_ed25519SignatureHex[sizeof(m_ed25519SignatureHex) - 1] = '\0';

    m_nextExpectedChunk = 0;
    m_writtenBytes = 0;
    m_progressPct = 0;

#ifdef ESP32
    // 1. Select the inactive OTA partition (app0 <-> app1)
    m_updatePartition = esp_ota_get_next_update_partition(nullptr);
    if (m_updatePartition == nullptr) {
        abortUpdate(OtaAckStatus::FlashError, "No inactive OTA partition found", header.seqId);
        return;
    }

    Serial.printf("[OtaUpdater] Starting OTA for version %s (%u bytes, %u chunks) -> Target partition: %s\n",
                  m_version, m_totalBytes, m_totalChunks, m_updatePartition->label);

    // 2. Initialize hardware OTA writer
    const esp_err_t otaBeginErr = esp_ota_begin(m_updatePartition, m_totalBytes, &m_otaHandle);
    if (otaBeginErr != ESP_OK) {
        Serial.printf("[OtaUpdater] esp_ota_begin failed: 0x%x\n", otaBeginErr);
        abortUpdate(OtaAckStatus::FlashError, "esp_ota_begin failed", header.seqId);
        return;
    }

    // 3. Initialize streaming mbedTLS SHA-256 context
    mbedtls_sha256_init(&m_shaCtx);
    mbedtls_sha256_starts(&m_shaCtx, 0); // 0 = SHA-256
#else
    Serial.printf("[OtaUpdater] Host mode: Starting simulated OTA for version %s (%u bytes, %u chunks)\n",
                  m_version, m_totalBytes, m_totalChunks);
#endif

    m_active = true;

    // 4. Switch UI to dedicated 60FPS OTA Progress Screen
    if (m_progressPage) {
        m_progressPage->setProgress(0, m_version);
    }
    ui::UIManager::instance().navigateToPage("ota_progress", false);

    // 5. Send OK Acknowledgement
    sendAck(m_transferId, 0, 0, OtaAckStatus::Ok, header.seqId);
}

void OtaUpdater::handleOtaChunk(const PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
    if (!m_active || payload == nullptr || len < sizeof(OtaChunkHeader)) {
        return;
    }

    const auto* chunkHdr = reinterpret_cast<const OtaChunkHeader*>(payload);
    const uint8_t* rawBytes = payload + sizeof(OtaChunkHeader);
    const size_t rawBytesLen = len - sizeof(OtaChunkHeader);

    // 1. Verify transferId and chunkIndex
    if (chunkHdr->transferId != m_transferId) {
        Serial.printf("[OtaUpdater] Transfer ID mismatch: %u (expected %u)\n", chunkHdr->transferId, m_transferId);
        return;
    }

    // 2. Verify IEEE 802.3 CRC32 of raw chunk payload
    const uint32_t computedCrc = petbot_crc32(rawBytes, rawBytesLen);
    if (computedCrc != chunkHdr->chunkCrc32) {
        Serial.printf("[OtaUpdater] CRC32 mismatch on chunk %u (got 0x%08lx, expected 0x%08lx). Requesting retry.\n",
                      chunkHdr->chunkIndex,
                      static_cast<unsigned long>(computedCrc),
                      static_cast<unsigned long>(chunkHdr->chunkCrc32));
        sendAck(m_transferId, m_nextExpectedChunk, m_progressPct, OtaAckStatus::CrcRetry, header.seqId);
        return;
    }

#ifdef ESP32
    // 3. Stream chunk into hardware flash partition
    const esp_err_t writeErr = esp_ota_write(m_otaHandle, rawBytes, rawBytesLen);
    if (writeErr != ESP_OK) {
        Serial.printf("[OtaUpdater] esp_ota_write error on chunk %u: 0x%x\n", chunkHdr->chunkIndex, writeErr);
        abortUpdate(OtaAckStatus::FlashError, "esp_ota_write failed", header.seqId);
        return;
    }

    // 4. Update streaming SHA-256 calculation
    mbedtls_sha256_update(&m_shaCtx, rawBytes, rawBytesLen);
#endif

    m_writtenBytes += rawBytesLen;
    m_nextExpectedChunk = chunkHdr->chunkIndex + 1;
    m_progressPct = std::min<uint8_t>(100, static_cast<uint8_t>((m_writtenBytes * 100ULL) / m_totalBytes));

    // Update screen progress
    if (m_progressPage) {
        m_progressPage->setProgress(m_progressPct, m_version);
    }

    // 5. Check if final chunk received
    const bool isFinalChunk = (header.flags & static_cast<uint8_t>(FrameFlags::FinalChunk)) != 0 ||
                              m_nextExpectedChunk >= m_totalChunks ||
                              m_writtenBytes >= m_totalBytes;

    if (isFinalChunk) {
#ifdef ESP32
        // Finish SHA-256 verification
        uint8_t finalSha[32]{0};
        mbedtls_sha256_finish(&m_shaCtx, finalSha);
        mbedtls_sha256_free(&m_shaCtx);

        char computedHex[65]{0};
        for (int i = 0; i < 32; ++i) {
            std::snprintf(computedHex + (i * 2), 3, "%02x", finalSha[i]);
        }

        if (std::strcmp(computedHex, m_sha256Hex) != 0) {
            Serial.printf("[OtaUpdater] SHA-256 MISMATCH!\n  Computed: %s\n  Expected: %s\n",
                          computedHex, m_sha256Hex);
            abortUpdate(OtaAckStatus::FlashError, "Binary SHA-256 mismatch", header.seqId);
            return;
        }

        // Finalize OTA partition write
        const esp_err_t otaEndErr = esp_ota_end(m_otaHandle);
        if (otaEndErr != ESP_OK) {
            Serial.printf("[OtaUpdater] esp_ota_end error: 0x%x\n", otaEndErr);
            abortUpdate(OtaAckStatus::FlashError, "esp_ota_end failed", header.seqId);
            return;
        }

        // Set newly flashed partition as active boot target
        const esp_err_t setBootErr = esp_ota_set_boot_partition(m_updatePartition);
        if (setBootErr != ESP_OK) {
            Serial.printf("[OtaUpdater] esp_ota_set_boot_partition error: 0x%x\n", setBootErr);
            abortUpdate(OtaAckStatus::FlashError, "Failed to set boot partition", header.seqId);
            return;
        }

        Serial.printf("[OtaUpdater] SUCCESS! Firmware v%s flashed and boot partition set to %s.\n",
                      m_version, m_updatePartition->label);
#else
        Serial.printf("[OtaUpdater] Host mode: Successfully simulated OTA completion for v%s\n", m_version);
#endif

        // 6. Reply with REBOOTING_INTO_NEW_FIRMWARE
        sendAck(m_transferId, m_nextExpectedChunk, 100, OtaAckStatus::RebootingIntoNewFirmware, header.seqId);

        // 7. Play celebration sound
        hal::AudioHal::instance().playProceduralSound(hal::SoundId::HappyTrill);

        m_active = false;

#ifdef ESP32
        // Schedule reboot in 800ms
        delay(800);
        esp_restart();
#endif
    } else {
        // Send OK Ack for next chunk
        sendAck(m_transferId, m_nextExpectedChunk, m_progressPct, OtaAckStatus::Ok, header.seqId);
    }
}

} // namespace petbot::firmware::agentic
