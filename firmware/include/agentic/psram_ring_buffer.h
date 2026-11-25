#pragma once

#include <cstdint>
#include <cstddef>
#include <cstring>
#include <algorithm>
#include <esp_heap_caps.h>
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

namespace petbot::firmware::agentic {

/**
 * High-performance Thread-safe Circular Ring Buffer allocated in ESP32-S3 Octal PSRAM.
 * Optimized for zero-copy binary network frame queuing and sub-50ms dispatch.
 */
class PsramRingBuffer {
public:
    static constexpr size_t DEFAULT_CAPACITY = 256 * 1024; // 256KB

    explicit PsramRingBuffer(size_t capacity = DEFAULT_CAPACITY)
        : m_capacity(capacity)
        , m_buffer(nullptr)
        , m_head(0)
        , m_tail(0)
        , m_count(0)
        , m_allocatedInPsram(false)
        , m_mutex(nullptr)
    {
    }

    ~PsramRingBuffer() {
        destroy();
    }

    // Non-copyable
    PsramRingBuffer(const PsramRingBuffer&) = delete;
    PsramRingBuffer& operator=(const PsramRingBuffer&) = delete;

    /**
     * Allocate buffer in Octal PSRAM with internal SRAM fallback.
     */
    bool init() {
        if (m_buffer != nullptr) {
            return true;
        }

        m_mutex = xSemaphoreCreateMutex();

        // Attempt allocation in Octal-SPI PSRAM (SPIRAM)
        m_buffer = static_cast<uint8_t*>(
            heap_caps_malloc(m_capacity, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
        );

        if (m_buffer != nullptr) {
            m_allocatedInPsram = true;
        } else {
            // Graceful fallback to internal heap if PSRAM uninitialized
            m_buffer = static_cast<uint8_t*>(malloc(m_capacity));
            m_allocatedInPsram = false;
        }

        if (m_buffer == nullptr) {
            return false;
        }

        m_head = 0;
        m_tail = 0;
        m_count = 0;
        return true;
    }

    void destroy() {
        if (m_buffer != nullptr) {
            if (m_allocatedInPsram) {
                heap_caps_free(m_buffer);
            } else {
                free(m_buffer);
            }
            m_buffer = nullptr;
        }
        if (m_mutex != nullptr) {
            vSemaphoreDelete(m_mutex);
            m_mutex = nullptr;
        }
        m_head = 0;
        m_tail = 0;
        m_count = 0;
    }

    [[nodiscard]] bool isAllocatedInPsram() const noexcept {
        return m_allocatedInPsram;
    }

    [[nodiscard]] size_t capacity() const noexcept {
        return m_capacity;
    }

    [[nodiscard]] size_t available() const noexcept {
        size_t count = 0;
        if (m_mutex && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(10)) == pdTRUE) {
            count = m_count;
            xSemaphoreGive(m_mutex);
        }
        return count;
    }

    [[nodiscard]] size_t freeSpace() const noexcept {
        size_t space = 0;
        if (m_mutex && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(10)) == pdTRUE) {
            space = m_capacity - m_count;
            xSemaphoreGive(m_mutex);
        }
        return space;
    }

    /**
     * Write binary data to ring buffer.
     * Returns actual bytes written.
     */
    size_t write(const uint8_t* data, size_t length) {
        if (m_buffer == nullptr || data == nullptr || length == 0 || m_mutex == nullptr) {
            return 0;
        }

        if (xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
            return 0;
        }

        const size_t bytesToWrite = std::min(length, m_capacity - m_count);
        if (bytesToWrite == 0) {
            xSemaphoreGive(m_mutex);
            return 0;
        }

        const size_t firstChunk = std::min(bytesToWrite, m_capacity - m_head);
        std::memcpy(m_buffer + m_head, data, firstChunk);

        const size_t secondChunk = bytesToWrite - firstChunk;
        if (secondChunk > 0) {
            std::memcpy(m_buffer, data + firstChunk, secondChunk);
        }

        m_head = (m_head + bytesToWrite) % m_capacity;
        m_count += bytesToWrite;

        xSemaphoreGive(m_mutex);
        return bytesToWrite;
    }

    /**
     * Read and consume binary data from ring buffer.
     */
    size_t read(uint8_t* dest, size_t length) {
        if (m_buffer == nullptr || dest == nullptr || length == 0 || m_mutex == nullptr) {
            return 0;
        }

        if (xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
            return 0;
        }

        const size_t bytesToRead = std::min(length, m_count);
        if (bytesToRead == 0) {
            xSemaphoreGive(m_mutex);
            return 0;
        }

        const size_t firstChunk = std::min(bytesToRead, m_capacity - m_tail);
        std::memcpy(dest, m_buffer + m_tail, firstChunk);

        const size_t secondChunk = bytesToRead - firstChunk;
        if (secondChunk > 0) {
            std::memcpy(dest + firstChunk, m_buffer, secondChunk);
        }

        m_tail = (m_tail + bytesToRead) % m_capacity;
        m_count -= bytesToRead;

        xSemaphoreGive(m_mutex);
        return bytesToRead;
    }

    /**
     * Peek binary data without advancing read tail.
     */
    size_t peek(uint8_t* dest, size_t length) const {
        if (m_buffer == nullptr || dest == nullptr || length == 0 || m_mutex == nullptr) {
            return 0;
        }

        if (xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
            return 0;
        }

        const size_t bytesToPeek = std::min(length, m_count);
        if (bytesToPeek == 0) {
            xSemaphoreGive(m_mutex);
            return 0;
        }

        const size_t firstChunk = std::min(bytesToPeek, m_capacity - m_tail);
        std::memcpy(dest, m_buffer + m_tail, firstChunk);

        const size_t secondChunk = bytesToPeek - firstChunk;
        if (secondChunk > 0) {
            std::memcpy(dest + firstChunk, m_buffer, secondChunk);
        }

        xSemaphoreGive(m_mutex);
        return bytesToPeek;
    }

    /**
     * Advance tail pointer to discard consumed bytes.
     */
    void advanceRead(size_t length) {
        if (m_mutex && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) == pdTRUE) {
            const size_t bytesToAdvance = std::min(length, m_count);
            m_tail = (m_tail + bytesToAdvance) % m_capacity;
            m_count -= bytesToAdvance;
            xSemaphoreGive(m_mutex);
        }
    }

    void clear() {
        if (m_mutex && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) == pdTRUE) {
            m_head = 0;
            m_tail = 0;
            m_count = 0;
            xSemaphoreGive(m_mutex);
        }
    }

private:
    size_t m_capacity;
    uint8_t* m_buffer;
    size_t m_head;
    size_t m_tail;
    size_t m_count;
    bool m_allocatedInPsram;
    mutable SemaphoreHandle_t m_mutex;
};

} // namespace petbot::firmware::agentic
