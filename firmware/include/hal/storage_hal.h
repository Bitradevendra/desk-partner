/**
 * Hardware Abstraction Layer - Unified Storage Manager (LittleFS & MicroSD)
 * 
 * Features:
 * - Mounts LittleFS at /flash (6MB partition "storage")
 * - Mounts MicroSD Card at /sd via dedicated SPI bus
 * - Automatic transparent fallback to /flash if SD is absent
 * - Automatic initialization of standard directories:
 *   /vault, /widgets, /state, /notes, /habits
 * - Atomic write pipeline (temp write -> CRC32 -> flush -> atomic rename)
 * - Zero-copy reading directly into Octal PSRAM buffers
 * - Directory traversal and file metadata enumeration
 * - IEEE 802.3 CRC32 verification using petbot::protocol::petbot_crc32
 */
#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

#include "petbot_protocol.h"
#include "hal/board_pins.h"
#include "hal/psram_allocator.h"

#ifdef ESP32
#include <FS.h>
#include <LittleFS.h>
#include <SD.h>
#include <SPI.h>
#endif

namespace petbot::hal {

// ============================================================================
// Storage Types & Structures
// ============================================================================
enum class StorageDevice : uint8_t {
    Auto    = 0, // Primary active (SD if mounted, else Flash)
    Flash   = 1, // LittleFS internal flash
    MicroSD = 2  // External MicroSD SPI
};

struct FileEntry {
    std::string name;       // Base filename
    std::string fullPath;   // Full mounted path
    size_t      sizeBytes{0};
    bool        isDirectory{false};
    uint32_t    crc32{0};
};

struct StorageStats {
    size_t totalBytes{0};
    size_t usedBytes{0};
    size_t freeBytes{0};
    bool   isMounted{false};
};

// ============================================================================
// Storage Hardware Abstraction Layer
// ============================================================================
class StorageHal {
public:
    static StorageHal& instance() noexcept;

    StorageHal(const StorageHal&) = delete;
    StorageHal& operator=(const StorageHal&) = delete;
    StorageHal(StorageHal&&) = delete;
    StorageHal& operator=(StorageHal&&) = delete;

    /**
     * Initialize storage subsystems:
     * 1. Mount LittleFS at /flash (partition "storage")
     * 2. Initialize MicroSD on SPI bus at /sd
     * 3. Fallback to /flash if MicroSD is absent
     * 4. Ensure standard directories exist (/vault, /widgets, /state, /notes, /habits)
     * @return true if at least one filesystem is ready.
     */
    [[nodiscard]] bool init() noexcept;

    // Status queries
    [[nodiscard]] bool isSdMounted() const noexcept { return isSdMounted_; }
    [[nodiscard]] bool isLittleFsMounted() const noexcept { return isLittleFsMounted_; }
    [[nodiscard]] const char* getPrimaryMount() const noexcept;

    /**
     * Resolves a virtual or relative path (e.g. "/vault/key.bin" or "widgets/app.pbwg")
     * into an absolute mounted filesystem path according to active storage hierarchy.
     */
    [[nodiscard]] std::string resolvePath(std::string_view virtualPath) const;

    /**
     * Ensure standard directory structure exists on active storage:
     * /vault, /widgets, /state, /notes, /habits
     */
    bool ensureStandardDirectories() noexcept;

    /**
     * Atomically write a buffer to storage with IEEE 802.3 CRC32 verification.
     * Writes to a temporary file, flushes, verifies, and renames atomically.
     * @param path Target file path (virtual or mounted).
     * @param data Byte payload to write.
     * @param length Number of bytes.
     * @param appendCrc32Trailer If true, appends 4-byte CRC32 trailer for verification.
     * @return true on success.
     */
    bool writeFileAtomic(
        const char* path, 
        const uint8_t* data, 
        size_t length, 
        bool appendCrc32Trailer = true
    ) noexcept;

    /**
     * Read an entire file into a newly allocated Octal PSRAM buffer.
     * Never touches internal SRAM heap for payloads, preserving SRAM for DMA.
     * @param path Target file path.
     * @param outLength Pointer to receive read byte count (excluding trailer if verified).
     * @param outCrc32 Optional pointer to receive computed IEEE 802.3 CRC32.
     * @param verifyTrailingCrc If true, verifies trailing 4-byte CRC32 and strips it.
     * @return Pointer to buffer in PSRAM (null-terminated for string safety) or nullptr on failure.
     * Caller MUST release with freeBuffer() or PsramMemoryManager::freePsram().
     */
    [[nodiscard]] uint8_t* readFileToPsram(
        const char* path, 
        size_t* outLength, 
        uint32_t* outCrc32 = nullptr, 
        bool verifyTrailingCrc = false
    ) noexcept;

    /**
     * Release a buffer previously allocated by readFileToPsram.
     */
    void freeBuffer(void* ptr) noexcept;

    /**
     * Enumerate files and subdirectories within a directory.
     * @param dirPath Directory path to list.
     * @param outEntries Vector populated with file metadata.
     * @return true if directory opened and enumerated successfully.
     */
    bool listDirectory(const char* dirPath, std::vector<FileEntry>& outEntries) noexcept;

    /**
     * Check if a file or directory exists.
     */
    [[nodiscard]] bool exists(const char* path) noexcept;

    /**
     * Remove a file.
     */
    bool remove(const char* path) noexcept;

    /**
     * Rename or move a file.
     */
    bool rename(const char* fromPath, const char* toPath) noexcept;

    /**
     * Append binary data to an existing or new file.
     */
    bool appendFile(const char* path, const uint8_t* data, size_t length) noexcept;

    /**
     * Create directory (including intermediate parents).
     */
    bool mkdir(const char* path) noexcept;

    /**
     * Get file size in bytes.
     */
    [[nodiscard]] size_t getFileSize(const char* path) noexcept;

    /**
     * Retrieve storage partition statistics.
     */
    [[nodiscard]] StorageStats getStats(StorageDevice device = StorageDevice::Auto) const noexcept;

    /**
     * Enqueue an asynchronous atomic file write for background processing by Task_StorageWorker on Core 0.
     * Prevents Flash/SD SPI latency from stalling 60FPS UI rendering on Core 1.
     * @param path Target file path (virtual or mounted).
     * @param data Byte payload to write.
     * @param length Number of bytes (up to 512 bytes per async chunk).
     * @param appendCrc32Trailer If true, appends 4-byte CRC32 trailer.
     * @return true if successfully queued.
     */
    bool queueAsyncWrite(
        const char* path,
        const uint8_t* data,
        size_t length,
        bool appendCrc32Trailer = true
    ) noexcept;

    /**
     * Process pending asynchronous file writes on Core 0. Called continuously by Task_StorageWorker.
     */
    void processAsyncWrites() noexcept;

    [[nodiscard]] size_t getPendingAsyncWriteCount() const noexcept;

private:
    StorageHal() = default;
    ~StorageHal() = default;

    struct AsyncWriteItem {
        char path[64]{0};
        uint8_t payload[512]{0};
        size_t length{0};
        bool appendCrc{true};
        bool pending{false};
    };
    static constexpr size_t ASYNC_WRITE_QUEUE_CAPACITY = 8;
    AsyncWriteItem asyncQueue_[ASYNC_WRITE_QUEUE_CAPACITY]{};

#ifdef ESP32
    fs::FS& getFsForPath(const std::string& path) const noexcept;
    SPIClass sdSpi_{FSPI};
#endif

    bool isSdMounted_{false};
    bool isLittleFsMounted_{false};
};

} // namespace petbot::hal
