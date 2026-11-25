/**
 * Hardware Abstraction Layer - Octal PSRAM Memory Manager & 2D Graphics Canvas
 * 
 * Provides deterministic PSRAM allocation, internal SRAM DMA ping-pong buffers,
 * and high-performance RGB565 drawing primitives for the 128x160 ST7735 display.
 */
#pragma once

#include <cstdint>
#include <cstddef>
#include <cstring>
#include <algorithm>
#if defined(__has_include) && __has_include(<span>) && __cplusplus >= 202002L
#include <span>
#endif
#include <string_view>

#include "petbot_protocol.h"
#include "petbot_widget_bytecode.h"

#ifdef ESP32
#include <esp_heap_caps.h>
#include <esp_system.h>
#endif

namespace petbot::hal {

// ============================================================================
// Display & Buffer Architectural Constants
// ============================================================================
inline constexpr uint16_t LCD_WIDTH  = 160;
inline constexpr uint16_t LCD_HEIGHT = 128;
inline constexpr uint32_t LCD_PIXELS = LCD_WIDTH * LCD_HEIGHT;           // 20,480 pixels
inline constexpr uint32_t LCD_FRAME_BYTES = 40960;                        // 160 * 128 * 2 = 40,960 bytes

// DMA Ping-Pong Slice Geometry (4 slices of 32 lines each = 128 lines)
inline constexpr uint16_t DMA_SLICE_HEIGHT = 32;
inline constexpr uint16_t DMA_SLICE_PIXELS = LCD_WIDTH * DMA_SLICE_HEIGHT;          // 5,120 pixels
inline constexpr uint32_t DMA_SLICE_BYTES  = 10240;                                 // 160 * 32 * 2 = 10,240 bytes
inline constexpr uint8_t  DMA_SLICE_COUNT  = LCD_HEIGHT / DMA_SLICE_HEIGHT;         // 4 slices

// Standard RGB565 Color Palette
namespace colors {
inline constexpr uint16_t Black       = 0x0000;
inline constexpr uint16_t White       = 0xFFFF;
inline constexpr uint16_t Red         = 0xF800;
inline constexpr uint16_t Green       = 0x07E0;
inline constexpr uint16_t Blue        = 0x001F;
inline constexpr uint16_t Yellow      = 0xFFE0;
inline constexpr uint16_t Cyan        = 0x07FF;
inline constexpr uint16_t Magenta     = 0xF81F;
inline constexpr uint16_t Orange      = 0xFD20;
inline constexpr uint16_t Gray        = 0x8410;
inline constexpr uint16_t DarkGray    = 0x4208;
inline constexpr uint16_t LightGray   = 0xC618;
inline constexpr uint16_t Navy        = 0x000F;
inline constexpr uint16_t DarkGreen   = 0x03E0;
inline constexpr uint16_t DarkCyan    = 0x03EF;
inline constexpr uint16_t Maroon      = 0x7800;
inline constexpr uint16_t Purple      = 0x780F;
inline constexpr uint16_t Olive       = 0x7BE0;
} // namespace colors

// ============================================================================
// Octal PSRAM Memory Management Utility Functions
// ============================================================================
class PsramMemoryManager {
public:
    PsramMemoryManager() = delete;

    /**
     * Allocate memory inside 8MB Octal PSRAM (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT).
     * @param sizeBytes Bytes to allocate.
     * @param alignment Byte alignment requirement (default 4 bytes).
     * @return Pointer to allocated PSRAM block or nullptr on failure.
     */
    [[nodiscard]] static void* allocatePsram(size_t sizeBytes, size_t alignment = 4) noexcept;

    /**
     * Free memory allocated in PSRAM.
     */
    static void freePsram(void* ptr) noexcept;

    /**
     * Allocate memory inside Internal SRAM with DMA capability (MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL).
     * Strictly used for SPI / I2S DMA bounce buffers.
     * @param sizeBytes Bytes to allocate.
     * @param alignment Byte alignment requirement (default 4 bytes).
     * @return Pointer to DMA-capable internal memory or nullptr.
     */
    [[nodiscard]] static void* allocateDmaInternal(size_t sizeBytes, size_t alignment = 4) noexcept;

    /**
     * Free memory allocated via allocateDmaInternal.
     */
    static void freeDmaInternal(void* ptr) noexcept;

    /**
     * Total available PSRAM in bytes.
     */
    [[nodiscard]] static size_t getTotalPsram() noexcept;

    /**
     * Free PSRAM remaining in bytes.
     */
    [[nodiscard]] static size_t getFreePsram() noexcept;

    /**
     * Free DMA-capable Internal SRAM in bytes.
     */
    [[nodiscard]] static size_t getFreeDmaHeap() noexcept;

    /**
     * Verify whether PSRAM is initialized and operating.
     */
    [[nodiscard]] static bool isPsramAvailable() noexcept;
};

// ============================================================================
// RAII Managed PSRAM Frame Buffer (40,960 Bytes for 128x160 RGB565)
// ============================================================================
class PsramFrameBuffer {
public:
    PsramFrameBuffer() noexcept;
    ~PsramFrameBuffer() noexcept;

    // Move semantics enabled, copy semantics strictly deleted
    PsramFrameBuffer(const PsramFrameBuffer&) = delete;
    PsramFrameBuffer& operator=(const PsramFrameBuffer&) = delete;
    PsramFrameBuffer(PsramFrameBuffer&& other) noexcept;
    PsramFrameBuffer& operator=(PsramFrameBuffer&& other) noexcept;

    [[nodiscard]] bool allocate() noexcept;
    void release() noexcept;

    [[nodiscard]] inline bool isValid() const noexcept { return buffer_ != nullptr; }
    [[nodiscard]] inline uint16_t* pixels() noexcept { return buffer_; }
    [[nodiscard]] inline const uint16_t* pixels() const noexcept { return buffer_; }
    [[nodiscard]] inline uint8_t* rawBytes() noexcept { return reinterpret_cast<uint8_t*>(buffer_); }
    [[nodiscard]] inline const uint8_t* rawBytes() const noexcept { return reinterpret_cast<const uint8_t*>(buffer_); }
    [[nodiscard]] inline size_t sizeBytes() const noexcept { return LCD_FRAME_BYTES; }
    [[nodiscard]] inline size_t pixelCount() const noexcept { return LCD_PIXELS; }

    void clear(uint16_t color = colors::Black) noexcept;

private:
    uint16_t* buffer_{nullptr};
};

// ============================================================================
// Internal SRAM DMA Ping-Pong Bounce Buffers (10,240 Bytes x 2)
// ============================================================================
class DmaPingPongBuffers {
public:
    DmaPingPongBuffers() noexcept;
    ~DmaPingPongBuffers() noexcept;

    DmaPingPongBuffers(const DmaPingPongBuffers&) = delete;
    DmaPingPongBuffers& operator=(const DmaPingPongBuffers&) = delete;
    DmaPingPongBuffers(DmaPingPongBuffers&& other) noexcept;
    DmaPingPongBuffers& operator=(DmaPingPongBuffers&& other) noexcept;

    [[nodiscard]] bool allocate() noexcept;
    void release() noexcept;

    [[nodiscard]] inline bool isReady() const noexcept { return pingBuffer_ != nullptr && pongBuffer_ != nullptr; }
    [[nodiscard]] inline uint16_t* ping() noexcept { return pingBuffer_; }
    [[nodiscard]] inline const uint16_t* ping() const noexcept { return pingBuffer_; }
    [[nodiscard]] inline uint16_t* pong() noexcept { return pongBuffer_; }
    [[nodiscard]] inline const uint16_t* pong() const noexcept { return pongBuffer_; }
    [[nodiscard]] inline uint16_t* getBuffer(uint8_t index) noexcept { return (index == 0) ? pingBuffer_ : pongBuffer_; }

    static constexpr size_t SLICE_LINES  = DMA_SLICE_HEIGHT;
    static constexpr size_t SLICE_PIXELS = DMA_SLICE_PIXELS;
    static constexpr size_t SLICE_BYTES  = DMA_SLICE_BYTES;
    static constexpr size_t SLICE_COUNT  = DMA_SLICE_COUNT;

private:
    uint16_t* pingBuffer_{nullptr};
    uint16_t* pongBuffer_{nullptr};
};

// ============================================================================
// Fast 2D Drawing Canvas for 128x160 RGB565 Framebuffers
// ============================================================================
class Canvas128x160 {
public:
    explicit Canvas128x160(uint16_t* targetBuffer = nullptr) noexcept;

    void setTargetBuffer(uint16_t* targetBuffer) noexcept { buffer_ = targetBuffer; }
    [[nodiscard]] inline uint16_t* getTargetBuffer() noexcept { return buffer_; }
    [[nodiscard]] inline const uint16_t* getTargetBuffer() const noexcept { return buffer_; }

    // Screen Dimensions
    [[nodiscard]] static constexpr int16_t width() noexcept { return LCD_WIDTH; }
    [[nodiscard]] static constexpr int16_t height() noexcept { return LCD_HEIGHT; }

    // Fast Color Construction and Alpha Blending
    [[nodiscard]] static constexpr uint16_t colorRGB(uint8_t r, uint8_t g, uint8_t b) noexcept {
        return RGB565(r, g, b);
    }

    [[nodiscard]] static inline uint16_t blendAlpha(uint16_t fg, uint16_t bg, uint8_t alpha) noexcept {
        if (alpha == 255) return fg;
        if (alpha == 0)   return bg;

        const uint32_t fgR = (fg >> 11) & 0x1F;
        const uint32_t fgG = (fg >> 5)  & 0x3F;
        const uint32_t fgB = fg & 0x1F;

        const uint32_t bgR = (bg >> 11) & 0x1F;
        const uint32_t bgG = (bg >> 5)  & 0x3F;
        const uint32_t bgB = bg & 0x1F;

        const uint32_t invAlpha = 255 - alpha;
        const uint32_t r = (fgR * alpha + bgR * invAlpha + 128) / 255;
        const uint32_t g = (fgG * alpha + bgG * invAlpha + 128) / 255;
        const uint32_t b = (fgB * alpha + bgB * invAlpha + 128) / 255;

        return static_cast<uint16_t>((r << 11) | (g << 5) | b);
    }

    // 2D Drawing Primitives
    void clear(uint16_t color = colors::Black) noexcept;
    void drawPixel(int16_t x, int16_t y, uint16_t color) noexcept;
    void blendPixel(int16_t x, int16_t y, uint16_t color, uint8_t alpha) noexcept;
    [[nodiscard]] uint16_t getPixel(int16_t x, int16_t y) const noexcept;

    void drawFastHLine(int16_t x, int16_t y, int16_t w, uint16_t color) noexcept;
    void drawFastVLine(int16_t x, int16_t y, int16_t h, uint16_t color) noexcept;
    void drawLine(int16_t x0, int16_t y0, int16_t x1, int16_t y1, uint16_t color) noexcept;

    void drawRect(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t color) noexcept;
    void fillRect(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t color) noexcept;
    void drawRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r, uint16_t color) noexcept;
    void fillRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r, uint16_t color) noexcept;

    void drawCircle(int16_t x0, int16_t y0, int16_t r, uint16_t color) noexcept;
    void fillCircle(int16_t x0, int16_t y0, int16_t r, uint16_t color) noexcept;

    void drawBitmapRGB565(
        int16_t x, 
        int16_t y, 
        int16_t w, 
        int16_t h, 
        const uint16_t* bitmap, 
        bool transparentKey = false, 
        uint16_t keyColor = 0
    ) noexcept;

    void drawChar(
        int16_t x, 
        int16_t y, 
        char c, 
        uint16_t color, 
        uint16_t bg = colors::Black, 
        uint8_t size = 1, 
        bool transparentBg = true
    ) noexcept;

    void drawText(
        int16_t x, 
        int16_t y, 
        const char* str, 
        uint16_t color, 
        uint16_t bg = colors::Black, 
        uint8_t size = 1, 
        bool transparentBg = true
    ) noexcept;

private:
    uint16_t* buffer_{nullptr};
};

} // namespace petbot::hal
