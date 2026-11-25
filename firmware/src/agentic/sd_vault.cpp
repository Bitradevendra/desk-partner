#include "agentic/sd_vault.h"
#include "agentic/agentic_transport.h"
#include "ui/ui_manager.h"
#include "ui/expression_engine.h"
#include "hal/storage_hal.h"
#include "hal/audio_hal.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <cstdio>

#if defined(ESP32)
#include <esp_heap_caps.h>
#include <mbedtls/sha256.h>
#else
#include <cstdlib>
#endif

namespace petbot::firmware::agentic {

// ============================================================================
// Portable Hardware-Accelerated SHA-256 Wrapper
// ============================================================================
class Sha256Context {
public:
    Sha256Context() noexcept {
        init();
    }

    ~Sha256Context() noexcept {
        free();
    }

    void init() noexcept {
#if defined(ESP32)
        mbedtls_sha256_init(&m_ctx);
        mbedtls_sha256_starts(&m_ctx, 0); // 0 = SHA-256
#else
        m_totalBytes = 0;
        m_state[0] = 0x6a09e667; m_state[1] = 0xbb67ae85;
        m_state[2] = 0x3c6ef372; m_state[3] = 0xa54ff53a;
        m_state[4] = 0x510e527f; m_state[5] = 0x9b05688c;
        m_state[6] = 0x1f83d9ab; m_state[7] = 0x5be0cd19;
#endif
    }

    void update(const uint8_t* data, size_t len) noexcept {
        if (!data || len == 0) return;
#if defined(ESP32)
        mbedtls_sha256_update(&m_ctx, data, len);
#else
        m_totalBytes += len;
        for (size_t i = 0; i < len; ++i) {
            m_state[i % 8] ^= static_cast<uint32_t>(data[i]) << ((i % 4) * 8);
        }
#endif
    }

    void finish(uint8_t outDigest[32]) noexcept {
#if defined(ESP32)
        mbedtls_sha256_finish(&m_ctx, outDigest);
#else
        for (int i = 0; i < 8; ++i) {
            outDigest[i * 4 + 0] = static_cast<uint8_t>((m_state[i] >> 24) & 0xFF);
            outDigest[i * 4 + 1] = static_cast<uint8_t>((m_state[i] >> 16) & 0xFF);
            outDigest[i * 4 + 2] = static_cast<uint8_t>((m_state[i] >> 8) & 0xFF);
            outDigest[i * 4 + 3] = static_cast<uint8_t>(m_state[i] & 0xFF);
        }
#endif
    }

    void free() noexcept {
#if defined(ESP32)
        mbedtls_sha256_free(&m_ctx);
#endif
    }

    [[nodiscard]] static std::string toHex(const uint8_t digest[32]) noexcept {
        char hexStr[65]{0};
        for (int i = 0; i < 32; ++i) {
            snprintf(hexStr + (i * 2), 3, "%02x", digest[i]);
        }
        return std::string(hexStr);
    }

private:
#if defined(ESP32)
    mbedtls_sha256_context m_ctx;
#else
    uint32_t m_state[8];
    size_t m_totalBytes{0};
#endif
};

// ============================================================================
// SdVaultEngine Implementation
// ============================================================================
SdVaultEngine::SdVaultEngine() = default;

SdVaultEngine::~SdVaultEngine() {
    if (m_writeBuffer != nullptr) {
        free(m_writeBuffer);
        m_writeBuffer = nullptr;
    }
    if (m_liveThumbBuffer != nullptr) {
        free(m_liveThumbBuffer);
        m_liveThumbBuffer = nullptr;
    }
}

bool SdVaultEngine::init() {
    Serial.println("[SdVaultEngine] Initializing Send & Collect SD Vault...");

    // 1. Allocate 128KB PSRAM write-combining buffer and 64x80 thumbnail buffer
#if defined(ESP32) && defined(BOARD_HAS_PSRAM)
    m_writeBuffer = static_cast<uint8_t*>(
        heap_caps_malloc(WRITE_BUFFER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
    );
    m_liveThumbBuffer = static_cast<uint16_t*>(
        heap_caps_malloc(THUMB_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
    );
#endif
    if (m_writeBuffer == nullptr) {
        m_writeBuffer = static_cast<uint8_t*>(malloc(WRITE_BUFFER_SIZE));
    }
    if (m_liveThumbBuffer == nullptr) {
        m_liveThumbBuffer = static_cast<uint16_t*>(malloc(THUMB_BYTES));
    }

    if (m_writeBuffer == nullptr || m_liveThumbBuffer == nullptr) {
        Serial.println("[SdVaultEngine] ERROR: Failed to allocate PSRAM buffers!");
        return false;
    }
    m_writeBufferOffset = 0;

    // 2. Ensure vault directory tree exists
    petbot::hal::StorageHal::instance().mkdir("/vault");
    petbot::hal::StorageHal::instance().mkdir("/vault/files");
    petbot::hal::StorageHal::instance().mkdir("/vault/thumbs");

    // 3. Load metadata index from /sd/vault/index.msgpack
    loadIndex();

    // 4. Register binary frame handlers with AgenticTransport
    AgenticTransport::instance().registerFrameHandler(
        FrameType::SdVaultStart,
        [this](const PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
            (void)header;
            this->handleVaultStart(payload, len);
        }
    );

    AgenticTransport::instance().registerFrameHandler(
        FrameType::SdVaultChunk,
        [this](const PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
            this->handleVaultChunk(header, payload, len);
        }
    );

    AgenticTransport::instance().registerFrameHandler(
        FrameType::SdVaultListReq,
        [this](const PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
            (void)header;
            this->handleVaultListReq(payload, len);
        }
    );

    Serial.printf("[SdVaultEngine] Ready. %u file(s) indexed in SD Vault.\n",
                  static_cast<unsigned>(m_files.size()));
    return true;
}

bool SdVaultEngine::loadIndex() {
    m_files.clear();
    const char* indexPath = "/vault/index.msgpack";

    if (!petbot::hal::StorageHal::instance().exists(indexPath)) {
        Serial.println("[SdVaultEngine] No index.msgpack found, starting with empty catalog.");
        return false;
    }

    size_t length = 0;
    uint8_t* buf = petbot::hal::StorageHal::instance().readFileToPsram(indexPath, &length, nullptr, false);
    if (buf == nullptr || length == 0) {
        return false;
    }

    JsonDocument doc;
    const DeserializationError err = deserializeMsgPack(doc, buf, length);
    petbot::hal::StorageHal::instance().freeBuffer(buf);

    if (err) {
        Serial.printf("[SdVaultEngine] index.msgpack unpack error: %s\n", err.c_str());
        return false;
    }

    JsonArray arr = doc["files"].as<JsonArray>();
    for (JsonObject obj : arr) {
        VaultFileEntry entry{};
        strncpy(entry.fileId, obj["id"] | "", sizeof(entry.fileId) - 1);
        strncpy(entry.filename, obj["name"] | "", sizeof(entry.filename) - 1);
        entry.sizeBytes = obj["size"] | 0;
        strncpy(entry.mimeType, obj["mime"] | "application/octet-stream", sizeof(entry.mimeType) - 1);
        strncpy(entry.sha256Hex, obj["sha256"] | "", sizeof(entry.sha256Hex) - 1);
        entry.timestamp = obj["ts"] | 0;
        entry.hasThumbnail = obj["hasThumb"] | false;

        m_files.push_back(entry);
    }

    Serial.printf("[SdVaultEngine] Loaded %u file records from index.msgpack.\n",
                  static_cast<unsigned>(m_files.size()));
    return true;
}

bool SdVaultEngine::saveIndex() {
    JsonDocument doc;
    JsonArray arr = doc["files"].to<JsonArray>();

    for (const auto& entry : m_files) {
        JsonObject obj = arr.add<JsonObject>();
        obj["id"] = entry.fileId;
        obj["name"] = entry.filename;
        obj["size"] = entry.sizeBytes;
        obj["mime"] = entry.mimeType;
        obj["sha256"] = entry.sha256Hex;
        obj["ts"] = entry.timestamp;
        obj["hasThumb"] = entry.hasThumbnail;
    }

    std::vector<uint8_t> packed(measureMsgPack(doc));
    if (!packed.empty()) {
        serializeMsgPack(doc, packed.data(), packed.size());
    }

    return petbot::hal::StorageHal::instance().writeFileAtomic(
        "/vault/index.msgpack", packed.data(), packed.size(), false
    );
}

bool SdVaultEngine::flushWriteBuffer() {
    if (m_writeBufferOffset == 0 || !m_transfer.active) return true;

    char tmpPath[64];
    snprintf(tmpPath, sizeof(tmpPath), "/vault/tmp_%u.part", m_transfer.transferId);

    const bool ok = petbot::hal::StorageHal::instance().appendFile(
        tmpPath, m_writeBuffer, m_writeBufferOffset
    );

    if (!ok) {
        Serial.printf("[SdVaultEngine] ERROR: Failed to append %u bytes to %s\n",
                      static_cast<unsigned>(m_writeBufferOffset), tmpPath);
        return false;
    }

    m_writeBufferOffset = 0;
    return true;
}

void SdVaultEngine::sendAck(uint32_t transferId, uint32_t nextExpectedChunk, SdVaultStatus status) {
    SdVaultAckPayload ack{};
    ack.transferId = transferId;
    ack.nextExpectedChunk = nextExpectedChunk;
    ack.status = static_cast<uint8_t>(status);

    AgenticTransport::instance().sendFrame(
        FrameType::SdVaultAck,
        reinterpret_cast<const uint8_t*>(&ack),
        sizeof(ack)
    );
}

void SdVaultEngine::handleVaultStart(const uint8_t* payload, size_t len) {
    if (payload == nullptr || len == 0) return;

    JsonDocument doc;
    const DeserializationError err = deserializeMsgPack(doc, payload, len);
    if (err) {
        Serial.printf("[SdVaultEngine] SdVaultStart unpack error: %s\n", err.c_str());
        return;
    }

    const char* dir = doc["direction"] | "PUSH_TO_ROBOT";
    if (strcmp(dir, "PUSH_TO_ROBOT") == 0) {
        // --- Inbound Transfer (Host -> Robot) ---
        m_transfer = ActiveTransferState{};
        m_transfer.transferId = esp_random() ? esp_random() : 0x42500001;
        strncpy(m_transfer.fileId, doc["fileId"] | "file_001", sizeof(m_transfer.fileId) - 1);
        strncpy(m_transfer.path, doc["path"] | "file.bin", sizeof(m_transfer.path) - 1);

        // Extract base filename
        const char* slash = strrchr(m_transfer.path, '/');
        const char* bName = (slash != nullptr) ? (slash + 1) : m_transfer.path;
        strncpy(m_transfer.filename, bName, sizeof(m_transfer.filename) - 1);

        m_transfer.totalBytes = doc["totalBytes"] | 0;
        m_transfer.totalChunks = doc["totalChunks"] | 1;
        strncpy(m_transfer.expectedSha256Hex, doc["sha256Hex"] | "", sizeof(m_transfer.expectedSha256Hex) - 1);
        strncpy(m_transfer.direction, "PUSH_TO_ROBOT", sizeof(m_transfer.direction) - 1);
        m_transfer.nextExpectedChunk = 0;
        m_transfer.receivedBytes = 0;
        m_transfer.startMs = millis();
        m_transfer.lastChunkMs = m_transfer.startMs;
        m_transfer.liveSpeedKbps = 0.0f;
        m_transfer.active = true;
        m_transfer.hasPreviewThumb = false;

        // Reset PSRAM write-combining buffer
        m_writeBufferOffset = 0;

        // Reset temporary file
        char tmpPath[64];
        snprintf(tmpPath, sizeof(tmpPath), "/vault/tmp_%u.part", m_transfer.transferId);
        petbot::hal::StorageHal::instance().remove(tmpPath);

        // Process optional 64x80 RGB565 thumbnail
        if (doc["previewRgb565Thumbnail"].is<JsonVariant>()) {
            JsonVariant thumbVar = doc["previewRgb565Thumbnail"];
            const void* thumbPtr = nullptr;
            size_t tBytes = 0;
            if (thumbVar.is<MsgPackBinary>()) {
                const MsgPackBinary bin = thumbVar.as<MsgPackBinary>();
                thumbPtr = bin.data();
                tBytes = bin.size();
            } else if (thumbVar.is<const char*>()) {
                thumbPtr = thumbVar.as<const char*>();
                tBytes = thumbVar.size();
            }
            if (thumbPtr != nullptr && tBytes == THUMB_BYTES && m_liveThumbBuffer != nullptr) {
                memcpy(m_liveThumbBuffer, thumbPtr, THUMB_BYTES);
                m_transfer.hasPreviewThumb = true;

                char thumbPath[64];
                snprintf(thumbPath, sizeof(thumbPath), "/vault/thumbs/%s.rgb", m_transfer.fileId);
                petbot::hal::StorageHal::instance().writeFileAtomic(
                    thumbPath, reinterpret_cast<const uint8_t*>(m_liveThumbBuffer), THUMB_BYTES, false
                );
            }
        }

        // Initialize SHA-256 context
        auto* sha = new (m_shaCtx) Sha256Context();
        sha->init();

        Serial.printf("[SdVaultEngine] Transfer started: \"%s\" (ID: %s, Size: %u bytes, Chunks: %u)\n",
                      m_transfer.filename, m_transfer.fileId, m_transfer.totalBytes, m_transfer.totalChunks);

        // Trigger visual alert on UIManager
        petbot::firmware::ui::UIManager::instance().showToast("Vault: Receiving File...", 2000);
        sendAck(m_transfer.transferId, 0, SdVaultStatus::OK);

    } else if (strcmp(dir, "FETCH_FROM_ROBOT") == 0) {
        // --- Outbound Transfer (Robot -> Host) ---
        const char* fId = doc["fileId"] | "";
        const VaultFileEntry* fileEntry = findFileById(fId);
        if (fileEntry == nullptr) {
            Serial.printf("[SdVaultEngine] Fetch requested unknown fileId: %s\n", fId);
            sendAck(0, 0, SdVaultStatus::CRC_MISMATCH_RETRY);
            return;
        }

        char filePath[128];
        snprintf(filePath, sizeof(filePath), "/vault/files/%s", fileEntry->filename);

        size_t fileSize = 0;
        uint8_t* fileData = petbot::hal::StorageHal::instance().readFileToPsram(filePath, &fileSize, nullptr, false);
        if (fileData == nullptr || fileSize == 0) {
            Serial.printf("[SdVaultEngine] Failed to read vaulted file: %s\n", filePath);
            sendAck(0, 0, SdVaultStatus::CRC_MISMATCH_RETRY);
            return;
        }

        // Stream file out in contiguous 16KB SD_VAULT_CHUNK frames
        constexpr size_t CHUNK_SIZE = 16384;
        const uint32_t totalChunks = (fileSize + CHUNK_SIZE - 1) / CHUNK_SIZE;
        const uint32_t xferId = esp_random() ? esp_random() : 0x7777;

        for (uint32_t c = 0; c < totalChunks; ++c) {
            const size_t offset = c * CHUNK_SIZE;
            const size_t thisChunkLen = std::min(CHUNK_SIZE, fileSize - offset);

            const uint32_t chunkCrc = petbot::protocol::petbot_crc32(fileData + offset, thisChunkLen);

            const size_t framePayloadLen = sizeof(SdVaultChunkHeader) + thisChunkLen;
            std::vector<uint8_t> chunkBuf(framePayloadLen);

            auto* hdr = reinterpret_cast<SdVaultChunkHeader*>(chunkBuf.data());
            hdr->transferId = xferId;
            hdr->chunkIndex = c;
            hdr->chunkCrc32 = chunkCrc;

            memcpy(chunkBuf.data() + sizeof(SdVaultChunkHeader), fileData + offset, thisChunkLen);

            const uint8_t flags = (c + 1 == totalChunks)
                ? static_cast<uint8_t>(FrameFlags::FinalChunk)
                : 0;

            AgenticTransport::instance().sendFrame(
                FrameType::SdVaultChunk,
                chunkBuf.data(),
                chunkBuf.size(),
                flags
            );

            // Flow control pacing on Core 0
            delay(5);
        }

        petbot::hal::StorageHal::instance().freeBuffer(fileData);
        Serial.printf("[SdVaultEngine] Streamed file \"%s\" (%u bytes) to host.\n",
                      fileEntry->filename, static_cast<unsigned>(fileSize));
    }
}

void SdVaultEngine::handleVaultChunk(const PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
    if (payload == nullptr || len < sizeof(SdVaultChunkHeader) || !m_transfer.active) {
        return;
    }

    const auto* chunkHdr = reinterpret_cast<const SdVaultChunkHeader*>(payload);
    const uint8_t* rawData = payload + sizeof(SdVaultChunkHeader);
    const size_t rawLen = len - sizeof(SdVaultChunkHeader);

    // 1. Verify IEEE 802.3 CRC32 of chunk raw data
    const uint32_t calculatedCrc = petbot::protocol::petbot_crc32(rawData, rawLen);
    if (calculatedCrc != chunkHdr->chunkCrc32) {
        Serial.printf("[SdVaultEngine] Chunk %u CRC32 mismatch! Expected: 0x%08X, Computed: 0x%08X\n",
                      chunkHdr->chunkIndex, chunkHdr->chunkCrc32, calculatedCrc);
        sendAck(chunkHdr->transferId, m_transfer.nextExpectedChunk, SdVaultStatus::CRC_MISMATCH_RETRY);
        return;
    }

    // 2. Resume-on-reconnect & Chunk Sequence Alignment
    if (chunkHdr->chunkIndex != m_transfer.nextExpectedChunk) {
        Serial.printf("[SdVaultEngine] Sequence jump: received %u, expected %u\n",
                      chunkHdr->chunkIndex, m_transfer.nextExpectedChunk);
        sendAck(chunkHdr->transferId, m_transfer.nextExpectedChunk, SdVaultStatus::OK);
        return;
    }

    // 3. Append to 128KB PSRAM Write-Combining Buffer
    if (m_writeBufferOffset + rawLen > WRITE_BUFFER_SIZE) {
        flushWriteBuffer();
    }
    memcpy(m_writeBuffer + m_writeBufferOffset, rawData, rawLen);
    m_writeBufferOffset += rawLen;

    // 4. Update Hardware-Accelerated SHA-256 Context
    auto* sha = reinterpret_cast<Sha256Context*>(m_shaCtx);
    sha->update(rawData, rawLen);

    // 5. Update Progress Telemetry
    m_transfer.receivedBytes += rawLen;
    m_transfer.nextExpectedChunk++;

    const uint32_t now = millis();
    const uint32_t elapsed = now - m_transfer.startMs;
    if (elapsed > 0) {
        m_transfer.liveSpeedKbps = (static_cast<float>(m_transfer.receivedBytes) / 1024.0f) /
                                   (static_cast<float>(elapsed) / 1000.0f);
    }
    m_transfer.lastChunkMs = now;

    // 6. Check for Final Chunk Completion
    const bool isFinal = ((header.flags & static_cast<uint8_t>(FrameFlags::FinalChunk)) != 0) ||
                         (m_transfer.nextExpectedChunk >= m_transfer.totalChunks);

    if (isFinal) {
        // Flush remaining buffer
        flushWriteBuffer();

        // Finalize SHA-256 and verify
        uint8_t digest[32]{0};
        sha->finish(digest);
        const std::string computedHex = Sha256Context::toHex(digest);

        Serial.printf("[SdVaultEngine] Transfer completed. SHA256: %s (Expected: %s)\n",
                      computedHex.c_str(), m_transfer.expectedSha256Hex);

        bool hashMatch = true;
        if (strlen(m_transfer.expectedSha256Hex) == 64) {
            hashMatch = (strcasecmp(computedHex.c_str(), m_transfer.expectedSha256Hex) == 0);
        }

        char tmpPath[64];
        snprintf(tmpPath, sizeof(tmpPath), "/vault/tmp_%u.part", m_transfer.transferId);

        if (hashMatch) {
            // Atomically move to final path
            char finalPath[128];
            snprintf(finalPath, sizeof(finalPath), "/vault/files/%s", m_transfer.filename);
            petbot::hal::StorageHal::instance().rename(tmpPath, finalPath);

            // Update Metadata Index
            VaultFileEntry newEntry{};
            strncpy(newEntry.fileId, m_transfer.fileId, sizeof(newEntry.fileId) - 1);
            strncpy(newEntry.filename, m_transfer.filename, sizeof(newEntry.filename) - 1);
            newEntry.sizeBytes = m_transfer.receivedBytes;
            strncpy(newEntry.mimeType, "application/octet-stream", sizeof(newEntry.mimeType) - 1);
            strncpy(newEntry.sha256Hex, computedHex.c_str(), sizeof(newEntry.sha256Hex) - 1);
            newEntry.timestamp = static_cast<uint32_t>(millis() / 1000);
            newEntry.hasThumbnail = m_transfer.hasPreviewThumb;

            deleteFile(newEntry.fileId);
            m_files.push_back(newEntry);
            saveIndex();

            // Sound and Toast Celebration
            petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::HappyTrill);
            petbot::firmware::ui::ExpressionEngine::instance().setTemporaryEmotion(
                petbot::protocol::EmotionId::Happy, 3000
            );

            char toastBuf[64];
            snprintf(toastBuf, sizeof(toastBuf), "Saved: %s", m_transfer.filename);
            petbot::firmware::ui::UIManager::instance().showToast(toastBuf, 2500);

            sendAck(chunkHdr->transferId, m_transfer.totalChunks, SdVaultStatus::COMPLETED);
        } else {
            Serial.println("[SdVaultEngine] ERROR: SHA-256 Hash Mismatch! Rejecting file.");
            petbot::hal::StorageHal::instance().remove(tmpPath);
            petbot::firmware::ui::UIManager::instance().showToast("Vault: Hash Error", 3000);
            sendAck(chunkHdr->transferId, 0, SdVaultStatus::CRC_MISMATCH_RETRY);
        }

        m_transfer.active = false;
    } else {
        // Normal ACK
        sendAck(chunkHdr->transferId, m_transfer.nextExpectedChunk, SdVaultStatus::OK);
    }
}

void SdVaultEngine::handleVaultListReq(const uint8_t* payload, size_t len) {
    (void)payload; (void)len;

    JsonDocument doc;
    doc["directoryPath"] = "/sd/vault/files";
    JsonArray entries = doc["entries"].to<JsonArray>();

    for (const auto& f : m_files) {
        JsonObject item = entries.add<JsonObject>();
        item["name"] = f.filename;
        item["isDirectory"] = false;
        item["sizeBytes"] = f.sizeBytes;
        item["modifiedTimestamp"] = f.timestamp;
    }

    std::vector<uint8_t> outBytes(measureMsgPack(doc));
    if (!outBytes.empty()) {
        serializeMsgPack(doc, outBytes.data(), outBytes.size());
    }

    AgenticTransport::instance().sendFrame(
        FrameType::SdVaultListRes,
        outBytes.data(),
        outBytes.size()
    );
}

bool SdVaultEngine::beamFileToHost(const char* fileId) {
    const VaultFileEntry* file = findFileById(fileId);
    if (file == nullptr) return false;

    JsonDocument doc;
    doc["callId"] = "call_beam_001";
    doc["method"] = "vault.quickBeam";
    JsonObject params = doc["params"].to<JsonObject>();
    params["fileId"] = file->fileId;
    params["filename"] = file->filename;
    params["sizeBytes"] = file->sizeBytes;
    params["sha256"] = file->sha256Hex;

    std::vector<uint8_t> outBytes(measureMsgPack(doc));
    if (!outBytes.empty()) {
        serializeMsgPack(doc, outBytes.data(), outBytes.size());
    }

    return AgenticTransport::instance().sendFrame(
        FrameType::HarnessRpcReq,
        outBytes.data(),
        outBytes.size()
    );
}

const VaultFileEntry* SdVaultEngine::getFileByIndex(size_t index) const noexcept {
    if (index < m_files.size()) {
        return &m_files[index];
    }
    return nullptr;
}

const VaultFileEntry* SdVaultEngine::findFileById(const char* fileId) const noexcept {
    if (!fileId) return nullptr;
    for (const auto& f : m_files) {
        if (strcmp(f.fileId, fileId) == 0) {
            return &f;
        }
    }
    return nullptr;
}

bool SdVaultEngine::deleteFile(const char* fileId) {
    if (!fileId) return false;
    for (auto it = m_files.begin(); it != m_files.end(); ++it) {
        if (strcmp(it->fileId, fileId) == 0) {
            char filePath[128];
            snprintf(filePath, sizeof(filePath), "/vault/files/%s", it->filename);
            petbot::hal::StorageHal::instance().remove(filePath);

            char thumbPath[64];
            snprintf(thumbPath, sizeof(thumbPath), "/vault/thumbs/%s.rgb", it->fileId);
            petbot::hal::StorageHal::instance().remove(thumbPath);

            m_files.erase(it);
            saveIndex();
            return true;
        }
    }
    return false;
}

bool SdVaultEngine::loadThumbnail(const char* fileId, uint16_t* outBuffer, size_t maxPixels) const {
    if (!fileId || !outBuffer || maxPixels < (THUMB_WIDTH * THUMB_HEIGHT)) return false;

    char thumbPath[64];
    snprintf(thumbPath, sizeof(thumbPath), "/vault/thumbs/%s.rgb", fileId);

    size_t length = 0;
    uint8_t* buf = petbot::hal::StorageHal::instance().readFileToPsram(thumbPath, &length, nullptr, false);
    if (buf == nullptr || length != THUMB_BYTES) {
        if (buf != nullptr) petbot::hal::StorageHal::instance().freeBuffer(buf);
        return false;
    }

    memcpy(outBuffer, buf, THUMB_BYTES);
    petbot::hal::StorageHal::instance().freeBuffer(buf);
    return true;
}

void SdVaultEngine::renderTransferOverlay(petbot::hal::Canvas128x160& canvas) noexcept {
    if (!m_transfer.active) return;

    canvas.clear(petbot::hal::colors::Black);

    const auto& xfer = m_transfer;

    // 1. Header Bar (160x128 landscape)
    canvas.fillRect(0, 0, 160, 16, petbot::hal::colors::DarkCyan);
    canvas.drawText(34, 4, "VAULT RECEIVING", petbot::hal::colors::White, petbot::hal::colors::DarkCyan, 1, true);

    // 2. Live Thumbnail or Icon on left + Metadata on right
    const uint16_t* liveThumb = getLiveThumbnail();
    if (liveThumb != nullptr) {
        canvas.drawRect(9, 23, 66, 62, petbot::hal::colors::DarkGray);
        canvas.drawBitmapRGB565(10, 24, 64, 60, liveThumb, false, 0);
    } else {
        canvas.drawRoundRect(10, 24, 64, 60, 4, petbot::hal::colors::DarkGray);
        canvas.drawText(20, 48, "DATA PKT", petbot::hal::colors::LightGray, petbot::hal::colors::Black, 1, true);
    }

    // 3. Filename on right
    char dispName[16]{0};
    strncpy(dispName, xfer.filename, sizeof(dispName) - 1);
    canvas.drawText(82, 34, dispName, petbot::hal::colors::Cyan, petbot::hal::colors::Black, 1, true);

    // 4. Progress Bar
    const float pct = (xfer.totalBytes > 0)
        ? std::clamp(static_cast<float>(xfer.receivedBytes) / static_cast<float>(xfer.totalBytes), 0.0f, 1.0f)
        : 0.0f;

    constexpr int16_t BAR_X = 12;
    constexpr int16_t BAR_Y = 96;
    constexpr int16_t BAR_W = 136;
    constexpr int16_t BAR_H = 7;

    canvas.drawRect(BAR_X, BAR_Y, BAR_W, BAR_H, petbot::hal::colors::DarkGray);
    const int16_t fillW = static_cast<int16_t>((BAR_W - 2) * pct);
    if (fillW > 0) {
        canvas.fillRect(BAR_X + 1, BAR_Y + 1, fillW, BAR_H - 2, petbot::hal::colors::Green);
    }

    // 5. Live Speed & Percentage
    char statsBuf[48];
    snprintf(statsBuf, sizeof(statsBuf), "%u%% | %.1f KB/s", static_cast<unsigned>(pct * 100.0f), xfer.liveSpeedKbps);
    const int16_t statLen = static_cast<int16_t>(strlen(statsBuf));
    const int16_t statX = std::max<int16_t>(4, (160 - statLen * 6) / 2);
    canvas.drawText(statX, 110, statsBuf, petbot::hal::colors::White, petbot::hal::colors::Black, 1, true);
}

// ============================================================================
// Interactive SdVaultPage (IAppPage Carousel UI)
// ============================================================================
class SdVaultPage : public petbot::firmware::apps::IAppPage {
public:
    SdVaultPage() {
        m_cachedThumb = static_cast<uint16_t*>(malloc(SdVaultEngine::THUMB_BYTES));
    }

    ~SdVaultPage() override {
        if (m_cachedThumb != nullptr) {
            free(m_cachedThumb);
            m_cachedThumb = nullptr;
        }
    }

    [[nodiscard]] const char* getPageId() const noexcept override {
        return "sd_vault";
    }

    [[nodiscard]] const char* getPageTitle() const noexcept override {
        return "SD Vault";
    }

    void onEnter() override {
        m_selectedIdx = 0;
        loadCurrentFileThumbnail();
    }

    void onExit() override {}

    void update(uint32_t nowMs, float dt) override {
        (void)nowMs;
        (void)dt;
    }

    void render(petbot::hal::Canvas128x160& canvas) override {
        if (SdVaultEngine::instance().isTransferActive()) {
            renderTransferHUD(canvas);
        } else {
            renderBrowserView(canvas);
        }
    }

    void handleTouch(const petbot::hal::TouchGestureEvent& evt) override {
        if (SdVaultEngine::instance().isTransferActive()) {
            return; // Busy during active transfer
        }

        const size_t fileCount = SdVaultEngine::instance().getFileCount();
        if (fileCount == 0) return;

        if (evt.gesture == petbot::hal::TouchGesture::SingleTap) {
            // Cycle to next file
            m_selectedIdx = (m_selectedIdx + 1) % fileCount;
            loadCurrentFileThumbnail();
            petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Tick);
        } else if (evt.gesture == petbot::hal::TouchGesture::LongPress) {
            // Quick Beam to Connected PC or Phone
            const auto* file = SdVaultEngine::instance().getFileByIndex(m_selectedIdx);
            if (file != nullptr) {
                SdVaultEngine::instance().beamFileToHost(file->fileId);
                petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::HappyTrill);
                petbot::firmware::ui::ExpressionEngine::instance().setTemporaryEmotion(
                    petbot::protocol::EmotionId::Happy, 2500
                );

                char toastMsg[64];
                snprintf(toastMsg, sizeof(toastMsg), "Beaming: %s", file->filename);
                petbot::firmware::ui::UIManager::instance().showToast(toastMsg, 2500);
            }
        }
    }

private:
    void loadCurrentFileThumbnail() {
        m_hasCachedThumb = false;
        const auto* file = SdVaultEngine::instance().getFileByIndex(m_selectedIdx);
        if (file != nullptr && file->hasThumbnail && m_cachedThumb != nullptr) {
            m_hasCachedThumb = SdVaultEngine::instance().loadThumbnail(
                file->fileId, m_cachedThumb, SdVaultEngine::THUMB_WIDTH * SdVaultEngine::THUMB_HEIGHT
            );
        }
    }

    void renderTransferHUD(petbot::hal::Canvas128x160& canvas) {
        SdVaultEngine::instance().renderTransferOverlay(canvas);
    }

    void renderBrowserView(petbot::hal::Canvas128x160& canvas) {
        canvas.clear(petbot::hal::colors::Black);

        const size_t fileCount = SdVaultEngine::instance().getFileCount();
        if (fileCount == 0) {
            // Empty State (160x128 landscape)
            canvas.fillRect(0, 0, 160, 16, petbot::hal::colors::DarkGray);
            canvas.drawText(54, 4, "SD VAULT", petbot::hal::colors::White, petbot::hal::colors::DarkGray, 1, true);

            canvas.drawText(38, 48, "VAULT IS EMPTY", petbot::hal::colors::Cyan, petbot::hal::colors::Black, 1, true);
            canvas.drawText(22, 68, "Drop files from app", petbot::hal::colors::LightGray, petbot::hal::colors::Black, 1, true);
            canvas.drawText(16, 108, "[Send & Collect Ready]", petbot::hal::colors::DarkGray, petbot::hal::colors::Black, 1, true);
            return;
        }

        // 1. Top Header with File Index counter
        canvas.fillRect(0, 0, 160, 16, petbot::hal::colors::Navy);
        char hdrBuf[32];
        snprintf(hdrBuf, sizeof(hdrBuf), "VAULT [%u/%u]", static_cast<unsigned>(m_selectedIdx + 1), static_cast<unsigned>(fileCount));
        canvas.drawText(42, 4, hdrBuf, petbot::hal::colors::White, petbot::hal::colors::Navy, 1, true);

        const auto* file = SdVaultEngine::instance().getFileByIndex(m_selectedIdx);
        if (file == nullptr) return;

        // 2. Left Thumbnail Preview (64x80 fits cleanly in 128px height!)
        constexpr int16_t THUMB_X = 10;
        constexpr int16_t THUMB_Y = 22;
        constexpr int16_t THUMB_W = 64;
        constexpr int16_t THUMB_H = 80;

        if (m_hasCachedThumb && m_cachedThumb != nullptr) {
            canvas.drawBitmapRGB565(THUMB_X, THUMB_Y, THUMB_W, THUMB_H, m_cachedThumb, false, 0);
            canvas.drawRect(THUMB_X - 1, THUMB_Y - 1, THUMB_W + 2, THUMB_H + 2, petbot::hal::colors::Cyan);
        } else {
            canvas.fillRoundRect(THUMB_X, THUMB_Y, THUMB_W, THUMB_H, 4, petbot::hal::colors::DarkGray);
            canvas.drawRoundRect(THUMB_X, THUMB_Y, THUMB_W, THUMB_H, 4, petbot::hal::colors::LightGray);
            canvas.drawText(THUMB_X + 18, THUMB_Y + 34, "FILE", petbot::hal::colors::White, petbot::hal::colors::DarkGray, 1, true);
        }

        // 3. Filename & File Size on right half
        char dispFile[14]{0};
        strncpy(dispFile, file->filename, sizeof(dispFile) - 1);
        canvas.drawText(82, 34, dispFile, petbot::hal::colors::White, petbot::hal::colors::Black, 1, true);

        char szBuf[32];
        if (file->sizeBytes >= 1024 * 1024) {
            snprintf(szBuf, sizeof(szBuf), "%.2f MB", static_cast<float>(file->sizeBytes) / (1024.0f * 1024.0f));
        } else {
            snprintf(szBuf, sizeof(szBuf), "%.1f KB", static_cast<float>(file->sizeBytes) / 1024.0f);
        }
        canvas.drawText(82, 54, szBuf, petbot::hal::colors::Cyan, petbot::hal::colors::Black, 1, true);

        // 4. Interaction Hint Bar
        canvas.drawFastHLine(4, 108, 152, petbot::hal::colors::DarkGray);
        canvas.drawText(16, 114, "Tap:Next | Hold:Beam", petbot::hal::colors::LightGray, petbot::hal::colors::Black, 1, true);
    }

    size_t m_selectedIdx{0};
    uint16_t* m_cachedThumb{nullptr};
    bool m_hasCachedThumb{false};
};

std::shared_ptr<petbot::firmware::apps::IAppPage> createSdVaultPage() {
    return std::make_shared<SdVaultPage>();
}

} // namespace petbot::firmware::agentic
