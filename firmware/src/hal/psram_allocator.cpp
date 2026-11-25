#include "hal/psram_allocator.h"
#ifdef ESP32
#include <Arduino.h>
#endif
#include <cstdlib>

namespace petbot::hal {

// ============================================================================
// Complete 5x7 ASCII Font Table (Characters 0x20 ' ' through 0x7E '~')
// 95 glyphs * 5 column bytes per glyph
// ============================================================================
static const uint8_t FONT5X7[] = {
    0x00, 0x00, 0x00, 0x00, 0x00, // 0x20 ' '
    0x00, 0x00, 0x5F, 0x00, 0x00, // 0x21 '!'
    0x00, 0x07, 0x00, 0x07, 0x00, // 0x22 '"'
    0x14, 0x7F, 0x14, 0x7F, 0x14, // 0x23 '#'
    0x24, 0x2A, 0x7F, 0x2A, 0x12, // 0x24 '$'
    0x23, 0x13, 0x08, 0x64, 0x62, // 0x25 '%'
    0x36, 0x49, 0x55, 0x22, 0x50, // 0x26 '&'
    0x00, 0x05, 0x03, 0x00, 0x00, // 0x27 '''
    0x00, 0x1C, 0x22, 0x41, 0x00, // 0x28 '('
    0x00, 0x41, 0x22, 0x1C, 0x00, // 0x29 ')'
    0x08, 0x2A, 0x1C, 0x2A, 0x08, // 0x2A '*'
    0x08, 0x08, 0x3E, 0x08, 0x08, // 0x2B '+'
    0x00, 0x50, 0x30, 0x00, 0x00, // 0x2C ','
    0x08, 0x08, 0x08, 0x08, 0x08, // 0x2D '-'
    0x00, 0x60, 0x60, 0x00, 0x00, // 0x2E '.'
    0x20, 0x10, 0x08, 0x04, 0x02, // 0x2F '/'
    0x3E, 0x51, 0x49, 0x45, 0x3E, // 0x30 '0'
    0x00, 0x42, 0x7F, 0x40, 0x00, // 0x31 '1'
    0x42, 0x61, 0x51, 0x49, 0x46, // 0x32 '2'
    0x21, 0x41, 0x45, 0x4B, 0x31, // 0x33 '3'
    0x18, 0x14, 0x12, 0x7F, 0x10, // 0x34 '4'
    0x27, 0x45, 0x45, 0x45, 0x39, // 0x35 '5'
    0x3C, 0x4A, 0x49, 0x49, 0x30, // 0x36 '6'
    0x01, 0x71, 0x09, 0x05, 0x03, // 0x37 '7'
    0x36, 0x49, 0x49, 0x49, 0x36, // 0x38 '8'
    0x06, 0x49, 0x49, 0x29, 0x1E, // 0x39 '9'
    0x00, 0x36, 0x36, 0x00, 0x00, // 0x3A ':'
    0x00, 0x56, 0x36, 0x00, 0x00, // 0x3B ';'
    0x00, 0x08, 0x14, 0x22, 0x41, // 0x3C '<'
    0x14, 0x14, 0x14, 0x14, 0x14, // 0x3D '='
    0x41, 0x22, 0x14, 0x08, 0x00, // 0x3E '>'
    0x02, 0x01, 0x51, 0x09, 0x06, // 0x3F '?'
    0x32, 0x49, 0x79, 0x41, 0x3E, // 0x40 '@'
    0x7E, 0x11, 0x11, 0x11, 0x7E, // 0x41 'A'
    0x7F, 0x49, 0x49, 0x49, 0x36, // 0x42 'B'
    0x3E, 0x41, 0x41, 0x41, 0x22, // 0x43 'C'
    0x7F, 0x41, 0x41, 0x22, 0x1C, // 0x44 'D'
    0x7F, 0x49, 0x49, 0x49, 0x41, // 0x45 'E'
    0x7F, 0x09, 0x09, 0x01, 0x01, // 0x46 'F'
    0x3E, 0x41, 0x41, 0x51, 0x32, // 0x47 'G'
    0x7F, 0x08, 0x08, 0x08, 0x7F, // 0x48 'H'
    0x00, 0x41, 0x7F, 0x41, 0x00, // 0x49 'I'
    0x20, 0x40, 0x41, 0x3F, 0x01, // 0x4A 'J'
    0x7F, 0x08, 0x14, 0x22, 0x41, // 0x4B 'K'
    0x7F, 0x40, 0x40, 0x40, 0x40, // 0x4C 'L'
    0x7F, 0x02, 0x04, 0x02, 0x7F, // 0x4D 'M'
    0x7F, 0x04, 0x08, 0x10, 0x7F, // 0x4E 'N'
    0x3E, 0x41, 0x41, 0x41, 0x3E, // 0x4F 'O'
    0x7F, 0x09, 0x09, 0x09, 0x06, // 0x50 'P'
    0x3E, 0x41, 0x51, 0x21, 0x5E, // 0x51 'Q'
    0x7F, 0x09, 0x19, 0x29, 0x46, // 0x52 'R'
    0x46, 0x49, 0x49, 0x49, 0x31, // 0x53 'S'
    0x01, 0x01, 0x7F, 0x01, 0x01, // 0x54 'T'
    0x3F, 0x40, 0x40, 0x40, 0x3F, // 0x55 'U'
    0x1F, 0x20, 0x40, 0x20, 0x1F, // 0x56 'V'
    0x7F, 0x20, 0x18, 0x20, 0x7F, // 0x57 'W'
    0x63, 0x14, 0x08, 0x14, 0x63, // 0x58 'X'
    0x03, 0x04, 0x78, 0x04, 0x03, // 0x59 'Y'
    0x61, 0x51, 0x49, 0x45, 0x43, // 0x5A 'Z'
    0x00, 0x00, 0x7F, 0x41, 0x41, // 0x5B '['
    0x02, 0x04, 0x08, 0x10, 0x20, // 0x5C '\'
    0x41, 0x41, 0x7F, 0x00, 0x00, // 0x5D ']'
    0x04, 0x02, 0x01, 0x02, 0x04, // 0x5E '^'
    0x40, 0x40, 0x40, 0x40, 0x40, // 0x5F '_'
    0x00, 0x01, 0x02, 0x04, 0x00, // 0x60 '`'
    0x20, 0x54, 0x54, 0x54, 0x78, // 0x61 'a'
    0x7F, 0x48, 0x44, 0x44, 0x38, // 0x62 'b'
    0x38, 0x44, 0x44, 0x44, 0x20, // 0x63 'c'
    0x38, 0x44, 0x44, 0x48, 0x7F, // 0x64 'd'
    0x38, 0x54, 0x54, 0x54, 0x18, // 0x65 'e'
    0x08, 0x7E, 0x09, 0x01, 0x02, // 0x66 'f'
    0x08, 0x14, 0x54, 0x54, 0x3C, // 0x67 'g'
    0x7F, 0x08, 0x04, 0x04, 0x78, // 0x68 'h'
    0x00, 0x44, 0x7D, 0x40, 0x00, // 0x69 'i'
    0x20, 0x40, 0x44, 0x3D, 0x00, // 0x6A 'j'
    0x00, 0x7F, 0x10, 0x28, 0x44, // 0x6B 'k'
    0x00, 0x41, 0x7F, 0x40, 0x00, // 0x6C 'l'
    0x7C, 0x04, 0x18, 0x04, 0x78, // 0x6D 'm'
    0x7C, 0x08, 0x04, 0x04, 0x78, // 0x6E 'n'
    0x38, 0x44, 0x44, 0x44, 0x38, // 0x6F 'o'
    0x7C, 0x14, 0x14, 0x14, 0x08, // 0x70 'p'
    0x08, 0x14, 0x14, 0x18, 0x7C, // 0x71 'q'
    0x7C, 0x08, 0x04, 0x04, 0x08, // 0x72 'r'
    0x48, 0x54, 0x54, 0x54, 0x20, // 0x73 's'
    0x04, 0x3F, 0x44, 0x40, 0x20, // 0x74 't'
    0x3C, 0x40, 0x40, 0x20, 0x7C, // 0x75 'u'
    0x1C, 0x20, 0x40, 0x20, 0x1C, // 0x76 'v'
    0x3C, 0x40, 0x30, 0x40, 0x3C, // 0x77 'w'
    0x44, 0x28, 0x10, 0x28, 0x44, // 0x78 'x'
    0x0C, 0x50, 0x50, 0x50, 0x3C, // 0x79 'y'
    0x44, 0x64, 0x54, 0x4C, 0x44, // 0x7A 'z'
    0x00, 0x08, 0x36, 0x41, 0x00, // 0x7B '{'
    0x00, 0x00, 0x7F, 0x00, 0x00, // 0x7C '|'
    0x00, 0x41, 0x36, 0x08, 0x00, // 0x7D '}'
    0x08, 0x08, 0x2A, 0x1C, 0x08  // 0x7E '~'
};

// ============================================================================
// PsramMemoryManager Implementation
// ============================================================================
void* PsramMemoryManager::allocatePsram(size_t sizeBytes, size_t alignment) noexcept {
    if (sizeBytes == 0) return nullptr;
#ifdef ESP32
    void* ptr = heap_caps_aligned_alloc(alignment, sizeBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!ptr) {
        ptr = heap_caps_malloc(sizeBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    }
    return ptr;
#else
    (void)alignment;
    return std::malloc(sizeBytes);
#endif
}

void PsramMemoryManager::freePsram(void* ptr) noexcept {
    if (!ptr) return;
#ifdef ESP32
    heap_caps_free(ptr);
#else
    std::free(ptr);
#endif
}

void* PsramMemoryManager::allocateDmaInternal(size_t sizeBytes, size_t alignment) noexcept {
    if (sizeBytes == 0) return nullptr;
#ifdef ESP32
    void* ptr = heap_caps_aligned_alloc(alignment, sizeBytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (!ptr) {
        ptr = heap_caps_malloc(sizeBytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    }
    return ptr;
#else
    (void)alignment;
    return std::malloc(sizeBytes);
#endif
}

void PsramMemoryManager::freeDmaInternal(void* ptr) noexcept {
    if (!ptr) return;
#ifdef ESP32
    heap_caps_free(ptr);
#else
    std::free(ptr);
#endif
}

size_t PsramMemoryManager::getTotalPsram() noexcept {
#ifdef ESP32
    return heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
#else
    return 8 * 1024 * 1024;
#endif
}

size_t PsramMemoryManager::getFreePsram() noexcept {
#ifdef ESP32
    return heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
#else
    return 8 * 1024 * 1024;
#endif
}

size_t PsramMemoryManager::getFreeDmaHeap() noexcept {
#ifdef ESP32
    return heap_caps_get_free_size(MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
#else
    return 256 * 1024;
#endif
}

bool PsramMemoryManager::isPsramAvailable() noexcept {
#ifdef ESP32
    return psramFound() || (heap_caps_get_total_size(MALLOC_CAP_SPIRAM) > 0);
#else
    return true;
#endif
}

// ============================================================================
// PsramFrameBuffer Implementation
// ============================================================================
PsramFrameBuffer::PsramFrameBuffer() noexcept = default;

PsramFrameBuffer::~PsramFrameBuffer() noexcept {
    release();
}

PsramFrameBuffer::PsramFrameBuffer(PsramFrameBuffer&& other) noexcept
    : buffer_(other.buffer_) {
    other.buffer_ = nullptr;
}

PsramFrameBuffer& PsramFrameBuffer::operator=(PsramFrameBuffer&& other) noexcept {
    if (this != &other) {
        release();
        buffer_ = other.buffer_;
        other.buffer_ = nullptr;
    }
    return *this;
}

bool PsramFrameBuffer::allocate() noexcept {
    if (buffer_) return true;
    buffer_ = static_cast<uint16_t*>(
        PsramMemoryManager::allocatePsram(LCD_FRAME_BYTES, 16)
    );
    if (buffer_) {
        clear(colors::Black);
        return true;
    }
    return false;
}

void PsramFrameBuffer::release() noexcept {
    if (buffer_) {
        PsramMemoryManager::freePsram(buffer_);
        buffer_ = nullptr;
    }
}

void PsramFrameBuffer::clear(uint16_t color) noexcept {
    if (!buffer_) return;
    const uint32_t c32 = (static_cast<uint32_t>(color) << 16) | color;
    uint32_t* p32 = reinterpret_cast<uint32_t*>(buffer_);
    constexpr size_t words = LCD_PIXELS / 2;
    for (size_t i = 0; i < words; ++i) {
        p32[i] = c32;
    }
}

// ============================================================================
// DmaPingPongBuffers Implementation
// ============================================================================
DmaPingPongBuffers::DmaPingPongBuffers() noexcept = default;

DmaPingPongBuffers::~DmaPingPongBuffers() noexcept {
    release();
}

DmaPingPongBuffers::DmaPingPongBuffers(DmaPingPongBuffers&& other) noexcept
    : pingBuffer_(other.pingBuffer_), pongBuffer_(other.pongBuffer_) {
    other.pingBuffer_ = nullptr;
    other.pongBuffer_ = nullptr;
}

DmaPingPongBuffers& DmaPingPongBuffers::operator=(DmaPingPongBuffers&& other) noexcept {
    if (this != &other) {
        release();
        pingBuffer_ = other.pingBuffer_;
        pongBuffer_ = other.pongBuffer_;
        other.pingBuffer_ = nullptr;
        other.pongBuffer_ = nullptr;
    }
    return *this;
}

bool DmaPingPongBuffers::allocate() noexcept {
    if (isReady()) return true;

    pingBuffer_ = static_cast<uint16_t*>(
        PsramMemoryManager::allocateDmaInternal(DMA_SLICE_BYTES, 4)
    );
    pongBuffer_ = static_cast<uint16_t*>(
        PsramMemoryManager::allocateDmaInternal(DMA_SLICE_BYTES, 4)
    );

    if (pingBuffer_ && pongBuffer_) {
        std::memset(pingBuffer_, 0, DMA_SLICE_BYTES);
        std::memset(pongBuffer_, 0, DMA_SLICE_BYTES);
        return true;
    }

    release();
    return false;
}

void DmaPingPongBuffers::release() noexcept {
    if (pingBuffer_) {
        PsramMemoryManager::freeDmaInternal(pingBuffer_);
        pingBuffer_ = nullptr;
    }
    if (pongBuffer_) {
        PsramMemoryManager::freeDmaInternal(pongBuffer_);
        pongBuffer_ = nullptr;
    }
}

// ============================================================================
// Canvas128x160 Drawing Implementation
// ============================================================================
Canvas128x160::Canvas128x160(uint16_t* targetBuffer) noexcept
    : buffer_(targetBuffer) {}

void Canvas128x160::clear(uint16_t color) noexcept {
    if (!buffer_) return;
    const uint32_t c32 = (static_cast<uint32_t>(color) << 16) | color;
    uint32_t* p32 = reinterpret_cast<uint32_t*>(buffer_);
    constexpr size_t words = LCD_PIXELS / 2;
    for (size_t i = 0; i < words; ++i) {
        p32[i] = c32;
    }
}

void Canvas128x160::drawPixel(int16_t x, int16_t y, uint16_t color) noexcept {
    if (!buffer_) return;
    if (static_cast<uint16_t>(x) < LCD_WIDTH && static_cast<uint16_t>(y) < LCD_HEIGHT) {
        buffer_[static_cast<size_t>(y) * LCD_WIDTH + static_cast<size_t>(x)] = color;
    }
}

void Canvas128x160::blendPixel(int16_t x, int16_t y, uint16_t color, uint8_t alpha) noexcept {
    if (!buffer_) return;
    if (static_cast<uint16_t>(x) < LCD_WIDTH && static_cast<uint16_t>(y) < LCD_HEIGHT) {
        const size_t index = static_cast<size_t>(y) * LCD_WIDTH + static_cast<size_t>(x);
        buffer_[index] = blendAlpha(color, buffer_[index], alpha);
    }
}

uint16_t Canvas128x160::getPixel(int16_t x, int16_t y) const noexcept {
    if (!buffer_) return colors::Black;
    if (static_cast<uint16_t>(x) < LCD_WIDTH && static_cast<uint16_t>(y) < LCD_HEIGHT) {
        return buffer_[static_cast<size_t>(y) * LCD_WIDTH + static_cast<size_t>(x)];
    }
    return colors::Black;
}

void Canvas128x160::drawFastHLine(int16_t x, int16_t y, int16_t w, uint16_t color) noexcept {
    if (!buffer_ || y < 0 || y >= LCD_HEIGHT || w <= 0) return;

    if (x < 0) {
        w += x;
        x = 0;
    }
    if (x + w > LCD_WIDTH) {
        w = LCD_WIDTH - x;
    }
    if (w <= 0) return;

    uint16_t* row = &buffer_[static_cast<size_t>(y) * LCD_WIDTH + static_cast<size_t>(x)];
    for (int16_t i = 0; i < w; ++i) {
        row[i] = color;
    }
}

void Canvas128x160::drawFastVLine(int16_t x, int16_t y, int16_t h, uint16_t color) noexcept {
    if (!buffer_ || x < 0 || x >= LCD_WIDTH || h <= 0) return;

    if (y < 0) {
        h += y;
        y = 0;
    }
    if (y + h > LCD_HEIGHT) {
        h = LCD_HEIGHT - y;
    }
    if (h <= 0) return;

    uint16_t* ptr = &buffer_[static_cast<size_t>(y) * LCD_WIDTH + static_cast<size_t>(x)];
    for (int16_t i = 0; i < h; ++i) {
        *ptr = color;
        ptr += LCD_WIDTH;
    }
}

void Canvas128x160::drawLine(int16_t x0, int16_t y0, int16_t x1, int16_t y1, uint16_t color) noexcept {
    if (!buffer_) return;

    if (y0 == y1) {
        if (x0 <= x1) drawFastHLine(x0, y0, x1 - x0 + 1, color);
        else          drawFastHLine(x1, y0, x0 - x1 + 1, color);
        return;
    }
    if (x0 == x1) {
        if (y0 <= y1) drawFastVLine(x0, y0, y1 - y0 + 1, color);
        else          drawFastVLine(x0, y1, y0 - y1 + 1, color);
        return;
    }

    const int16_t dx = std::abs(x1 - x0);
    const int16_t dy = -std::abs(y1 - y0);
    const int16_t sx = (x0 < x1) ? 1 : -1;
    const int16_t sy = (y0 < y1) ? 1 : -1;
    int16_t err = dx + dy;

    while (true) {
        drawPixel(x0, y0, color);
        if (x0 == x1 && y0 == y1) break;
        const int32_t e2 = 2 * err;
        if (e2 >= dy) {
            err += dy;
            x0 += sx;
        }
        if (e2 <= dx) {
            err += dx;
            y0 += sy;
        }
    }
}

void Canvas128x160::drawRect(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t color) noexcept {
    if (w <= 0 || h <= 0) return;
    drawFastHLine(x, y, w, color);
    drawFastHLine(x, y + h - 1, w, color);
    drawFastVLine(x, y, h, color);
    drawFastVLine(x + w - 1, y, h, color);
}

void Canvas128x160::fillRect(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t color) noexcept {
    if (!buffer_ || w <= 0 || h <= 0) return;

    if (x < 0) {
        w += x;
        x = 0;
    }
    if (y < 0) {
        h += y;
        y = 0;
    }
    if (x + w > LCD_WIDTH) {
        w = LCD_WIDTH - x;
    }
    if (y + h > LCD_HEIGHT) {
        h = LCD_HEIGHT - y;
    }
    if (w <= 0 || h <= 0) return;

    for (int16_t row = y; row < y + h; ++row) {
        uint16_t* ptr = &buffer_[static_cast<size_t>(row) * LCD_WIDTH + static_cast<size_t>(x)];
        for (int16_t col = 0; col < w; ++col) {
            ptr[col] = color;
        }
    }
}

void Canvas128x160::drawCircle(int16_t x0, int16_t y0, int16_t r, uint16_t color) noexcept {
    if (r <= 0) {
        drawPixel(x0, y0, color);
        return;
    }

    int16_t f = 1 - r;
    int16_t ddF_x = 1;
    int16_t ddF_y = -2 * r;
    int16_t x = 0;
    int16_t y = r;

    drawPixel(x0, y0 + r, color);
    drawPixel(x0, y0 - r, color);
    drawPixel(x0 + r, y0, color);
    drawPixel(x0 - r, y0, color);

    while (x < y) {
        if (f >= 0) {
            y--;
            ddF_y += 2;
            f += ddF_y;
        }
        x++;
        ddF_x += 2;
        f += ddF_x;

        drawPixel(x0 + x, y0 + y, color);
        drawPixel(x0 - x, y0 + y, color);
        drawPixel(x0 + x, y0 - y, color);
        drawPixel(x0 - x, y0 - y, color);
        drawPixel(x0 + y, y0 + x, color);
        drawPixel(x0 - y, y0 + x, color);
        drawPixel(x0 + y, y0 - x, color);
        drawPixel(x0 - y, y0 - x, color);
    }
}

void Canvas128x160::fillCircle(int16_t x0, int16_t y0, int16_t r, uint16_t color) noexcept {
    if (r <= 0) {
        drawPixel(x0, y0, color);
        return;
    }

    drawFastHLine(x0 - r, y0, 2 * r + 1, color);

    int16_t f = 1 - r;
    int16_t ddF_x = 1;
    int16_t ddF_y = -2 * r;
    int16_t x = 0;
    int16_t y = r;

    while (x < y) {
        if (f >= 0) {
            y--;
            ddF_y += 2;
            f += ddF_y;
        }
        x++;
        ddF_x += 2;
        f += ddF_x;

        drawFastHLine(x0 - x, y0 + y, 2 * x + 1, color);
        drawFastHLine(x0 - x, y0 - y, 2 * x + 1, color);
        drawFastHLine(x0 - y, y0 + x, 2 * y + 1, color);
        drawFastHLine(x0 - y, y0 - x, 2 * y + 1, color);
    }
}

void Canvas128x160::drawRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r, uint16_t color) noexcept {
    if (w <= 0 || h <= 0) return;
    const int16_t maxR = std::min(w, h) / 2;
    if (r > maxR) r = maxR;
    if (r <= 0) {
        drawRect(x, y, w, h, color);
        return;
    }

    drawFastHLine(x + r, y, w - 2 * r, color);
    drawFastHLine(x + r, y + h - 1, w - 2 * r, color);
    drawFastVLine(x, y + r, h - 2 * r, color);
    drawFastVLine(x + w - 1, y + r, h - 2 * r, color);

    // Draw 4 rounded corner arcs
    int16_t f = 1 - r;
    int16_t ddF_x = 1;
    int16_t ddF_y = -2 * r;
    int16_t cx = 0;
    int16_t cy = r;

    while (cx < cy) {
        if (f >= 0) {
            cy--;
            ddF_y += 2;
            f += ddF_y;
        }
        cx++;
        ddF_x += 2;
        f += ddF_x;

        drawPixel(x + w - r - 1 + cx, y + r - cy, color);
        drawPixel(x + w - r - 1 + cy, y + r - cx, color);
        drawPixel(x + r - cx, y + r - cy, color);
        drawPixel(x + r - cy, y + r - cx, color);
        drawPixel(x + w - r - 1 + cx, y + h - r - 1 + cy, color);
        drawPixel(x + w - r - 1 + cy, y + h - r - 1 + cx, color);
        drawPixel(x + r - cx, y + h - r - 1 + cy, color);
        drawPixel(x + r - cy, y + h - r - 1 + cx, color);
    }
}

void Canvas128x160::fillRoundRect(int16_t x, int16_t y, int16_t w, int16_t h, int16_t r, uint16_t color) noexcept {
    if (w <= 0 || h <= 0) return;
    const int16_t maxR = std::min(w, h) / 2;
    if (r > maxR) r = maxR;
    if (r <= 0) {
        fillRect(x, y, w, h, color);
        return;
    }

    fillRect(x + r, y, w - 2 * r, h, color);

    // Draw corner slices
    int16_t f = 1 - r;
    int16_t ddF_x = 1;
    int16_t ddF_y = -2 * r;
    int16_t cx = 0;
    int16_t cy = r;

    while (cx < cy) {
        if (f >= 0) {
            cy--;
            ddF_y += 2;
            f += ddF_y;
        }
        cx++;
        ddF_x += 2;
        f += ddF_x;

        drawFastVLine(x + r - cx, y + r - cy, h - 2 * r + 2 * cy, color);
        drawFastVLine(x + w - r - 1 + cx, y + r - cy, h - 2 * r + 2 * cy, color);
        drawFastVLine(x + r - cy, y + r - cx, h - 2 * r + 2 * cx, color);
        drawFastVLine(x + w - r - 1 + cy, y + r - cx, h - 2 * r + 2 * cx, color);
    }
}

void Canvas128x160::drawBitmapRGB565(
    int16_t x, 
    int16_t y, 
    int16_t w, 
    int16_t h, 
    const uint16_t* bitmap, 
    bool transparentKey, 
    uint16_t keyColor
) noexcept {
    if (!buffer_ || !bitmap || w <= 0 || h <= 0) return;

    for (int16_t row = 0; row < h; ++row) {
        const int16_t targetY = y + row;
        if (targetY < 0 || targetY >= LCD_HEIGHT) continue;

        for (int16_t col = 0; col < w; ++col) {
            const int16_t targetX = x + col;
            if (targetX < 0 || targetX >= LCD_WIDTH) continue;

            const uint16_t color = bitmap[row * w + col];
            if (transparentKey && color == keyColor) continue;

            buffer_[static_cast<size_t>(targetY) * LCD_WIDTH + static_cast<size_t>(targetX)] = color;
        }
    }
}

void Canvas128x160::drawChar(
    int16_t x, 
    int16_t y, 
    char c, 
    uint16_t color, 
    uint16_t bg, 
    uint8_t size, 
    bool transparentBg
) noexcept {
    if (c < 0x20 || c > 0x7E) {
        c = '?';
    }

    const uint8_t charIndex = static_cast<uint8_t>(c - 0x20);
    const uint8_t* charData = &FONT5X7[charIndex * 5];

    for (int8_t col = 0; col < 6; ++col) {
        uint8_t line = (col < 5) ? charData[col] : 0x00; // 6th column is spacing
        for (int8_t row = 0; row < 8; ++row) {
            const bool pixelOn = (line & 0x01) != 0;
            line >>= 1;

            if (pixelOn) {
                if (size == 1) {
                    drawPixel(x + col, y + row, color);
                } else {
                    fillRect(x + col * size, y + row * size, size, size, color);
                }
            } else if (!transparentBg) {
                if (size == 1) {
                    drawPixel(x + col, y + row, bg);
                } else {
                    fillRect(x + col * size, y + row * size, size, size, bg);
                }
            }
        }
    }
}

void Canvas128x160::drawText(
    int16_t x, 
    int16_t y, 
    const char* str, 
    uint16_t color, 
    uint16_t bg, 
    uint8_t size, 
    bool transparentBg
) noexcept {
    if (!str || size == 0) return;

    int16_t curX = x;
    int16_t curY = y;
    const int16_t charWidth = 6 * size;
    const int16_t charHeight = 8 * size;

    while (*str) {
        const char c = *str++;
        if (c == '\n') {
            curX = x;
            curY += charHeight;
            continue;
        }
        if (c == '\r') {
            continue;
        }

        // Auto wrap at screen border
        if (curX + charWidth > LCD_WIDTH) {
            curX = x;
            curY += charHeight;
        }

        if (curY >= LCD_HEIGHT) {
            break;
        }

        drawChar(curX, curY, c, color, bg, size, transparentBg);
        curX += charWidth;
    }
}

} // namespace petbot::hal
