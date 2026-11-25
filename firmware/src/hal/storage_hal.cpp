#include "hal/storage_hal.h"
#include <Arduino.h>

namespace petbot::hal {

// ============================================================================
// Singleton Access
// ============================================================================
StorageHal& StorageHal::instance() noexcept {
    static StorageHal s_instance;
    return s_instance;
}

// ============================================================================
// Filesystem Resolution & Mapping
// ============================================================================
#ifdef ESP32
fs::FS& StorageHal::getFsForPath(const std::string& path) const noexcept {
    if (path.rfind("/sd", 0) == 0 && isSdMounted_) {
        return SD;
    }
    return LittleFS;
}
#endif

const char* StorageHal::getPrimaryMount() const noexcept {
    if (isSdMounted_) {
        return "/sd";
    }
    if (isLittleFsMounted_) {
        return "/flash";
    }
    return "";
}

std::string StorageHal::resolvePath(std::string_view virtualPath) const {
    if (virtualPath.empty()) {
        return getPrimaryMount();
    }

    // Direct /flash access
    if (virtualPath.rfind("/flash", 0) == 0) {
        return std::string(virtualPath);
    }

    // Direct /sd access - if SD unmounted, redirect to /flash
    if (virtualPath.rfind("/sd", 0) == 0) {
        if (isSdMounted_) {
            return std::string(virtualPath);
        }
        // Transparent fallback to flash
        std::string fallback = "/flash";
        fallback += virtualPath.substr(3); // strip "/sd"
        return fallback;
    }

    // Relative or standard top-level directory access
    std::string resolved = getPrimaryMount();
    if (virtualPath.front() != '/') {
        resolved += '/';
    }
    resolved.append(virtualPath.data(), virtualPath.size());
    return resolved;
}

// ============================================================================
// Initialization Sequence
// ============================================================================
bool StorageHal::init() noexcept {
#ifdef ESP32
    Serial.println("[StorageHal] Initializing storage subsystems...");

    // 1. Mount LittleFS internal 6MB storage partition
    if (LittleFS.begin(true, "/flash", 10, "storage")) {
        isLittleFsMounted_ = true;
        const size_t totalBytes = LittleFS.totalBytes();
        const size_t usedBytes  = LittleFS.usedBytes();
        Serial.printf("[StorageHal] LittleFS mounted at /flash (Total: %u bytes, Used: %u bytes)\n",
                      static_cast<unsigned int>(totalBytes), static_cast<unsigned int>(usedBytes));
    } else {
        Serial.println("[StorageHal] ERROR: LittleFS mount failed on partition 'storage'!");
    }

    // 2. Attempt mounting MicroSD Card via SPI
    sdSpi_.begin(
        petbot::hal::pins::PIN_SD_SCLK,
        petbot::hal::pins::PIN_SD_MISO,
        petbot::hal::pins::PIN_SD_MOSI,
        petbot::hal::pins::PIN_SD_CS
    );

    if (SD.begin(petbot::hal::pins::PIN_SD_CS, sdSpi_, 20000000, "/sd")) {
        isSdMounted_ = true;
        const uint64_t sdTotal = SD.totalBytes();
        const uint64_t sdUsed  = SD.usedBytes();
        Serial.printf("[StorageHal] MicroSD Card mounted at /sd (Total: %llu bytes, Used: %llu bytes)\n",
                      sdTotal, sdUsed);
    } else {
        isSdMounted_ = false;
        Serial.println("[StorageHal] WARNING: MicroSD card not detected or mount failed. Falling back to /flash.");
    }
#else
    isLittleFsMounted_ = true;
    isSdMounted_ = false;
#endif

    // 3. Ensure mandatory directory tree
    ensureStandardDirectories();

    return isLittleFsMounted_ || isSdMounted_;
}

// ============================================================================
// Directory Management
// ============================================================================
bool StorageHal::mkdir(const char* path) noexcept {
    if (!path || *path == '\0') return false;

#ifdef ESP32
    const std::string fullPath = resolvePath(path);
    fs::FS& fs = getFsForPath(fullPath);

    if (fs.exists(fullPath.c_str())) {
        return true;
    }

    // Recursively create parent segments
    size_t pos = 1;
    while ((pos = fullPath.find('/', pos)) != std::string::npos) {
        const std::string sub = fullPath.substr(0, pos);
        if (!fs.exists(sub.c_str())) {
            fs.mkdir(sub.c_str());
        }
        pos++;
    }

    return fs.mkdir(fullPath.c_str());
#else
    return true;
#endif
}

bool StorageHal::ensureStandardDirectories() noexcept {
    static const char* const STANDARD_DIRS[] = {
        "/vault",
        "/widgets",
        "/state",
        "/notes",
        "/habits"
    };

    bool allCreated = true;

    // Create on active primary mount
    for (const char* dir : STANDARD_DIRS) {
        const std::string resolved = resolvePath(dir);
        if (!mkdir(resolved.c_str())) {
            allCreated = false;
            Serial.printf("[StorageHal] Warning: failed to create dir %s\n", resolved.c_str());
        }
    }

    // If MicroSD is primary, also mirror directories into LittleFS as offline reserve
    if (isSdMounted_ && isLittleFsMounted_) {
        for (const char* dir : STANDARD_DIRS) {
            const std::string flashDir = std::string("/flash") + dir;
            mkdir(flashDir.c_str());
        }
    }

    return allCreated;
}

// ============================================================================
// Atomic File Write with IEEE 802.3 CRC32 Verification
// ============================================================================
bool StorageHal::writeFileAtomic(
    const char* path, 
    const uint8_t* data, 
    size_t length, 
    bool appendCrc32Trailer
) noexcept {
    if (!path || (!data && length > 0)) return false;

#ifdef ESP32
    const std::string resolved = resolvePath(path);
    fs::FS& fs = getFsForPath(resolved);

    // Ensure parent directory exists
    const size_t slashPos = resolved.find_last_of('/');
    if (slashPos != std::string::npos && slashPos > 0) {
        mkdir(resolved.substr(0, slashPos).c_str());
    }

    // 1. Write to temporary file
    const std::string tmpPath = resolved + ".tmp";
    fs::File tmpFile = fs.open(tmpPath.c_str(), FILE_WRITE);
    if (!tmpFile) {
        Serial.printf("[StorageHal] ERROR: Failed to open temp file for writing: %s\n", tmpPath.c_str());
        return false;
    }

    if (length > 0) {
        const size_t written = tmpFile.write(data, length);
        if (written != length) {
            Serial.printf("[StorageHal] ERROR: Incomplete write: %u / %u bytes\n", 
                          static_cast<unsigned int>(written), static_cast<unsigned int>(length));
            tmpFile.close();
            fs.remove(tmpPath.c_str());
            return false;
        }
    }

    // 2. Append IEEE 802.3 CRC32 trailer (Little-Endian)
    if (appendCrc32Trailer) {
        const uint32_t crc = (length > 0) 
            ? petbot::protocol::petbot_crc32(data, length) 
            : 0xFFFFFFFFU;

        const uint8_t crcBytes[4] = {
            static_cast<uint8_t>(crc & 0xFF),
            static_cast<uint8_t>((crc >> 8) & 0xFF),
            static_cast<uint8_t>((crc >> 16) & 0xFF),
            static_cast<uint8_t>((crc >> 24) & 0xFF)
        };

        if (tmpFile.write(crcBytes, 4) != 4) {
            Serial.println("[StorageHal] ERROR: Failed to append CRC32 trailer!");
            tmpFile.close();
            fs.remove(tmpPath.c_str());
            return false;
        }
    }

    tmpFile.flush();
    tmpFile.close();

    // 3. Verify size on disk
    fs::File verifyFile = fs.open(tmpPath.c_str(), FILE_READ);
    if (!verifyFile) {
        fs.remove(tmpPath.c_str());
        return false;
    }
    const size_t expectedSize = length + (appendCrc32Trailer ? 4 : 0);
    if (verifyFile.size() != expectedSize) {
        Serial.printf("[StorageHal] ERROR: Size mismatch on verify: %u != %u\n",
                      static_cast<unsigned int>(verifyFile.size()), static_cast<unsigned int>(expectedSize));
        verifyFile.close();
        fs.remove(tmpPath.c_str());
        return false;
    }
    verifyFile.close();

    // 4. Atomic Replace: Remove existing target and rename temp
    if (fs.exists(resolved.c_str())) {
        fs.remove(resolved.c_str());
    }

    if (!fs.rename(tmpPath.c_str(), resolved.c_str())) {
        Serial.printf("[StorageHal] ERROR: Atomic rename failed from %s to %s\n", 
                      tmpPath.c_str(), resolved.c_str());
        fs.remove(tmpPath.c_str());
        return false;
    }

    return true;
#else
    (void)path; (void)data; (void)length; (void)appendCrc32Trailer;
    return true;
#endif
}

// ============================================================================
// Direct PSRAM File Ingestion with Integrity Verification
// ============================================================================
uint8_t* StorageHal::readFileToPsram(
    const char* path, 
    size_t* outLength, 
    uint32_t* outCrc32, 
    bool verifyTrailingCrc
) noexcept {
    if (!path || !outLength) return nullptr;
    *outLength = 0;
    if (outCrc32) *outCrc32 = 0;

#ifdef ESP32
    const std::string resolved = resolvePath(path);
    fs::FS& fs = getFsForPath(resolved);

    if (!fs.exists(resolved.c_str())) {
        Serial.printf("[StorageHal] File not found: %s\n", resolved.c_str());
        return nullptr;
    }

    fs::File file = fs.open(resolved.c_str(), FILE_READ);
    if (!file) {
        Serial.printf("[StorageHal] Failed to open file: %s\n", resolved.c_str());
        return nullptr;
    }

    const size_t totalBytes = file.size();
    if (totalBytes == 0) {
        file.close();
        // Allocate 1-byte null-terminated empty buffer in PSRAM
        auto* emptyBuf = static_cast<uint8_t*>(PsramMemoryManager::allocatePsram(1, 4));
        if (emptyBuf) emptyBuf[0] = '\0';
        *outLength = 0;
        return emptyBuf;
    }

    if (verifyTrailingCrc && totalBytes < 4) {
        Serial.printf("[StorageHal] ERROR: File too short for CRC trailer: %u bytes\n", 
                      static_cast<unsigned int>(totalBytes));
        file.close();
        return nullptr;
    }

    // Allocate in 8MB Octal PSRAM (+1 for null-termination)
    auto* buffer = static_cast<uint8_t*>(PsramMemoryManager::allocatePsram(totalBytes + 1, 4));
    if (!buffer) {
        Serial.printf("[StorageHal] ERROR: Failed to allocate %u bytes in PSRAM for file %s\n",
                      static_cast<unsigned int>(totalBytes + 1), resolved.c_str());
        file.close();
        return nullptr;
    }

    const size_t bytesRead = file.read(buffer, totalBytes);
    file.close();

    if (bytesRead != totalBytes) {
        Serial.printf("[StorageHal] ERROR: Read underflow: %u of %u bytes\n",
                      static_cast<unsigned int>(bytesRead), static_cast<unsigned int>(totalBytes));
        PsramMemoryManager::freePsram(buffer);
        return nullptr;
    }

    buffer[totalBytes] = '\0';

    if (verifyTrailingCrc) {
        const size_t payloadLen = totalBytes - 4;
        const uint32_t expectedCrc = 
            static_cast<uint32_t>(buffer[payloadLen]) |
            (static_cast<uint32_t>(buffer[payloadLen + 1]) << 8) |
            (static_cast<uint32_t>(buffer[payloadLen + 2]) << 16) |
            (static_cast<uint32_t>(buffer[payloadLen + 3]) << 24);

        const uint32_t actualCrc = petbot::protocol::petbot_crc32(buffer, payloadLen);

        if (actualCrc != expectedCrc) {
            Serial.printf("[StorageHal] CRC mismatch for %s: expected 0x%08X, calculated 0x%08X\n",
                          resolved.c_str(), expectedCrc, actualCrc);
            PsramMemoryManager::freePsram(buffer);
            return nullptr;
        }

        buffer[payloadLen] = '\0';
        *outLength = payloadLen;
        if (outCrc32) *outCrc32 = actualCrc;
    } else {
        *outLength = totalBytes;
        if (outCrc32) {
            *outCrc32 = petbot::protocol::petbot_crc32(buffer, totalBytes);
        }
    }

    return buffer;
#else
    (void)path; (void)outLength; (void)outCrc32; (void)verifyTrailingCrc;
    return nullptr;
#endif
}

void StorageHal::freeBuffer(void* ptr) noexcept {
    PsramMemoryManager::freePsram(ptr);
}

// ============================================================================
// Directory Enumeration
// ============================================================================
bool StorageHal::listDirectory(const char* dirPath, std::vector<FileEntry>& outEntries) noexcept {
    outEntries.clear();
    if (!dirPath) return false;

#ifdef ESP32
    const std::string resolved = resolvePath(dirPath);
    fs::FS& fs = getFsForPath(resolved);

    fs::File root = fs.open(resolved.c_str());
    if (!root || !root.isDirectory()) {
        Serial.printf("[StorageHal] Cannot open directory: %s\n", resolved.c_str());
        return false;
    }

    fs::File file = root.openNextFile();
    while (file) {
        FileEntry entry{};
        entry.name = file.name();
        entry.fullPath = resolved;
        if (entry.fullPath.back() != '/') {
            entry.fullPath += '/';
        }
        entry.fullPath += entry.name;
        entry.isDirectory = file.isDirectory();
        entry.sizeBytes = file.isDirectory() ? 0 : file.size();
        entry.crc32 = 0; // Quick enumeration leaves crc32 0 until read

        outEntries.push_back(entry);
        file = root.openNextFile();
    }

    return true;
#else
    (void)dirPath; (void)outEntries;
    return true;
#endif
}

// ============================================================================
// File Operations & Queries
// ============================================================================
bool StorageHal::exists(const char* path) noexcept {
    if (!path) return false;
#ifdef ESP32
    const std::string resolved = resolvePath(path);
    return getFsForPath(resolved).exists(resolved.c_str());
#else
    return false;
#endif
}

bool StorageHal::remove(const char* path) noexcept {
    if (!path) return false;
#ifdef ESP32
    const std::string resolved = resolvePath(path);
    return getFsForPath(resolved).remove(resolved.c_str());
#else
    return false;
#endif
}

bool StorageHal::rename(const char* fromPath, const char* toPath) noexcept {
    if (!fromPath || !toPath) return false;
#ifdef ESP32
    const std::string resFrom = resolvePath(fromPath);
    const std::string resTo = resolvePath(toPath);
    fs::FS& fs = getFsForPath(resFrom);
    if (fs.exists(resTo.c_str())) {
        fs.remove(resTo.c_str());
    }
    return fs.rename(resFrom.c_str(), resTo.c_str());
#else
    (void)fromPath; (void)toPath;
    return true;
#endif
}

bool StorageHal::appendFile(const char* path, const uint8_t* data, size_t length) noexcept {
    if (!path || !data || length == 0) return false;
#ifdef ESP32
    const std::string resolved = resolvePath(path);
    fs::FS& fs = getFsForPath(resolved);
    fs::File f = fs.open(resolved.c_str(), FILE_APPEND);
    if (!f) return false;
    const size_t written = f.write(data, length);
    f.flush();
    f.close();
    return (written == length);
#else
    (void)path; (void)data; (void)length;
    return true;
#endif
}

size_t StorageHal::getFileSize(const char* path) noexcept {
    if (!path) return 0;
#ifdef ESP32
    const std::string resolved = resolvePath(path);
    fs::FS& fs = getFsForPath(resolved);
    if (!fs.exists(resolved.c_str())) return 0;

    fs::File file = fs.open(resolved.c_str(), FILE_READ);
    if (!file) return 0;
    const size_t sz = file.size();
    file.close();
    return sz;
#else
    return 0;
#endif
}

StorageStats StorageHal::getStats(StorageDevice device) const noexcept {
    StorageStats stats{};
#ifdef ESP32
    if (device == StorageDevice::Flash || (device == StorageDevice::Auto && !isSdMounted_)) {
        if (isLittleFsMounted_) {
            stats.totalBytes = LittleFS.totalBytes();
            stats.usedBytes  = LittleFS.usedBytes();
            stats.freeBytes  = (stats.totalBytes >= stats.usedBytes) ? (stats.totalBytes - stats.usedBytes) : 0;
            stats.isMounted  = true;
        }
    } else if (device == StorageDevice::MicroSD || (device == StorageDevice::Auto && isSdMounted_)) {
        if (isSdMounted_) {
            stats.totalBytes = static_cast<size_t>(SD.totalBytes());
            stats.usedBytes  = static_cast<size_t>(SD.usedBytes());
            stats.freeBytes  = (stats.totalBytes >= stats.usedBytes) ? (stats.totalBytes - stats.usedBytes) : 0;
            stats.isMounted  = true;
        }
    }
#else
    (void)device;
#endif
    return stats;
}

bool StorageHal::queueAsyncWrite(
    const char* path,
    const uint8_t* data,
    size_t length,
    bool appendCrc32Trailer
) noexcept {
    if (!path || !data || length == 0 || length > 512) {
        return false;
    }

    for (size_t i = 0; i < ASYNC_WRITE_QUEUE_CAPACITY; ++i) {
        if (!asyncQueue_[i].pending) {
            strncpy(asyncQueue_[i].path, path, sizeof(asyncQueue_[i].path) - 1);
            asyncQueue_[i].path[sizeof(asyncQueue_[i].path) - 1] = '\0';
            std::memcpy(asyncQueue_[i].payload, data, length);
            asyncQueue_[i].length = length;
            asyncQueue_[i].appendCrc = appendCrc32Trailer;
            asyncQueue_[i].pending = true;
            return true;
        }
    }

    // Queue full: execute synchronously as fallback to prevent data loss
    return writeFileAtomic(path, data, length, appendCrc32Trailer);
}

void StorageHal::processAsyncWrites() noexcept {
    for (size_t i = 0; i < ASYNC_WRITE_QUEUE_CAPACITY; ++i) {
        if (asyncQueue_[i].pending) {
            writeFileAtomic(
                asyncQueue_[i].path,
                asyncQueue_[i].payload,
                asyncQueue_[i].length,
                asyncQueue_[i].appendCrc
            );
            asyncQueue_[i].pending = false;
        }
    }
}

size_t StorageHal::getPendingAsyncWriteCount() const noexcept {
    size_t count = 0;
    for (size_t i = 0; i < ASYNC_WRITE_QUEUE_CAPACITY; ++i) {
        if (asyncQueue_[i].pending) count++;
    }
    return count;
}

} // namespace petbot::hal
