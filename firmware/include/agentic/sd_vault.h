#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>
#include <memory>

#include "petbot_protocol.h"
#include "apps/app_page.h"
#include "hal/psram_allocator.h"
#include "hal/touch_hal.h"

namespace petbot::firmware::agentic {

using petbot::protocol::PetBotFrameHeader;
using petbot::protocol::FrameType;
using petbot::protocol::FrameFlags;
using petbot::protocol::SdVaultChunkHeader;

/**
 * SD Vault Transfer Acknowledgement Status
 */
enum class SdVaultStatus : uint8_t {
    OK                 = 0,
    CRC_MISMATCH_RETRY = 1,
    DISK_FULL          = 2,
    COMPLETED          = 3
};

#pragma pack(push, 1)
/**
 * 9-byte packed Little-Endian SD Vault Acknowledgement frame payload.
 */
struct SdVaultAckPayload {
    uint32_t transferId;
    uint32_t nextExpectedChunk;
    uint8_t  status; // SdVaultStatus
};
#pragma pack(pop)

static_assert(sizeof(SdVaultAckPayload) == 9, "SdVaultAckPayload must be exactly 9 bytes");

/**
 * Vaulted File Metadata Entry (persisted in /sd/vault/index.msgpack)
 */
struct VaultFileEntry {
    char fileId[64]{0};
    char filename[128]{0};
    uint32_t sizeBytes{0};
    char mimeType[32]{0};
    char sha256Hex[65]{0};
    uint32_t timestamp{0};
    bool hasThumbnail{false};
};

/**
 * Live Transfer Progress State
 */
struct ActiveTransferState {
    uint32_t transferId{0};
    char fileId[64]{0};
    char path[128]{0};
    char filename[128]{0};
    uint32_t totalBytes{0};
    uint32_t totalChunks{0};
    char expectedSha256Hex[65]{0};
    char direction[20]{0}; // "PUSH_TO_ROBOT" or "FETCH_FROM_ROBOT"
    uint32_t nextExpectedChunk{0};
    uint32_t receivedBytes{0};
    uint32_t startMs{0};
    uint32_t lastChunkMs{0};
    float liveSpeedKbps{0.0f};
    bool active{false};
    bool hasPreviewThumb{false};
};

/**
 * SD Card Vault Engine ("Send & Collect")
 *
 * Coordinates:
 * - 128KB PSRAM contiguous write-combining buffer for SPI SD throughput
 * - Hardware-accelerated mbedtls SHA-256 integrity verification
 * - Resumable chunked file transfers (PUSH_TO_ROBOT and FETCH_FROM_ROBOT)
 * - /sd/vault/index.msgpack directory catalog
 * - Outbound RPC beaming to companion apps
 */
class SdVaultEngine {
public:
    static constexpr size_t WRITE_BUFFER_SIZE = 128 * 1024; // 128KB PSRAM write buffer
    static constexpr size_t THUMB_WIDTH       = 64;
    static constexpr size_t THUMB_HEIGHT      = 80;
    static constexpr size_t THUMB_BYTES       = THUMB_WIDTH * THUMB_HEIGHT * sizeof(uint16_t); // 10,240 bytes

    static SdVaultEngine& instance() {
        static SdVaultEngine s_instance;
        return s_instance;
    }

    SdVaultEngine(const SdVaultEngine&) = delete;
    SdVaultEngine& operator=(const SdVaultEngine&) = delete;

    /**
     * Initialize engine:
     * - Pre-allocate 128KB PSRAM write-combining buffer
     * - Ensure /sd/vault, /sd/vault/files, /sd/vault/thumbs directories exist
     * - Load /sd/vault/index.msgpack metadata index
     * - Register binary frame handlers with AgenticTransport
     */
    bool init();

    /**
     * Protocol Frame Handlers
     */
    void handleVaultStart(const uint8_t* payload, size_t len);
    void handleVaultChunk(const PetBotFrameHeader& header, const uint8_t* payload, size_t len);
    void handleVaultListReq(const uint8_t* payload, size_t len);

    /**
     * Outbound "Quick Beam" trigger: sends HARNESS_RPC_REQ to connected host/companion.
     */
    bool beamFileToHost(const char* fileId);

    /**
     * Index queries & operations
     */
    [[nodiscard]] const std::vector<VaultFileEntry>& getFiles() const noexcept { return m_files; }
    [[nodiscard]] size_t getFileCount() const noexcept { return m_files.size(); }
    [[nodiscard]] const VaultFileEntry* getFileByIndex(size_t index) const noexcept;
    [[nodiscard]] const VaultFileEntry* findFileById(const char* fileId) const noexcept;
    bool deleteFile(const char* fileId);

    /**
     * Live Transfer Queries & Preemption Overlay
     */
    [[nodiscard]] bool isTransferActive() const noexcept { return m_transfer.active; }
    [[nodiscard]] const ActiveTransferState& getTransferState() const noexcept { return m_transfer; }
    [[nodiscard]] const uint16_t* getLiveThumbnail() const noexcept {
        return m_transfer.hasPreviewThumb ? m_liveThumbBuffer : nullptr;
    }
    void renderTransferOverlay(petbot::hal::Canvas128x160& canvas) noexcept;

    /**
     * Load 64x80 RGB565 thumbnail from /sd/vault/thumbs/<fileId>.rgb into destination buffer.
     */
    bool loadThumbnail(const char* fileId, uint16_t* outBuffer, size_t maxPixels) const;

    /**
     * Persist metadata index to /sd/vault/index.msgpack
     */
    bool saveIndex();

private:
    SdVaultEngine();
    ~SdVaultEngine();

    bool loadIndex();
    bool flushWriteBuffer();
    void sendAck(uint32_t transferId, uint32_t nextExpectedChunk, SdVaultStatus status);

    // 128KB PSRAM write-combining cache buffer
    uint8_t* m_writeBuffer{nullptr};
    size_t m_writeBufferOffset{0};

    // Live 64x80 RGB565 thumbnail buffer (10,240 bytes)
    uint16_t* m_liveThumbBuffer{nullptr};

    ActiveTransferState m_transfer{};
    std::vector<VaultFileEntry> m_files;

    // Internal SHA-256 Context Storage (opaque to keep header clean)
    uint8_t m_shaCtx[128]{0};
};

/**
 * Factory function creating the Interactive SdVaultPage implementing IAppPage.
 */
std::shared_ptr<petbot::firmware::apps::IAppPage> createSdVaultPage();

} // namespace petbot::firmware::agentic
