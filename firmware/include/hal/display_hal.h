/**
 * Hardware Abstraction Layer - ST7735 128x160 60FPS SPI DMA Display Driver
 * 
 * Features:
 * - 40MHz Hardware SPI Master with SPI_DMA_CH_AUTO
 * - Dual PSRAM 128x160 RGB565 framebuffers (frontBuffer_ & backBuffer_)
 * - Internal SRAM DMA ping-pong slice bounce buffers (10,240 bytes x 2)
 * - True asynchronous non-blocking swapAndFlushDMA() pinned to FreeRTOS worker
 * - Hardware LEDC PWM backlight dimming (0-100%)
 * - Full ST7735 command sequence with gamma calibration and rotation support
 */
#pragma once

#include <cstdint>
#include <cstddef>
#include <atomic>

#include "hal/board_pins.h"
#include "hal/psram_allocator.h"

#ifdef ESP32
#include <driver/spi_master.h>
#include <driver/gpio.h>
#include <driver/ledc.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#endif

namespace petbot::hal {

// ============================================================================
// ST7735 Controller Commands
// ============================================================================
namespace st7735_cmd {
inline constexpr uint8_t NOP       = 0x00;
inline constexpr uint8_t SWRESET   = 0x01;
inline constexpr uint8_t RDDID     = 0x04;
inline constexpr uint8_t RDDST     = 0x09;
inline constexpr uint8_t SLPIN     = 0x10;
inline constexpr uint8_t SLPOUT    = 0x11;
inline constexpr uint8_t PTLON     = 0x12;
inline constexpr uint8_t NORON     = 0x13;
inline constexpr uint8_t INVOFF    = 0x20;
inline constexpr uint8_t INVON     = 0x21;
inline constexpr uint8_t DISPOFF   = 0x28;
inline constexpr uint8_t DISPON    = 0x29;
inline constexpr uint8_t CASET     = 0x2A;
inline constexpr uint8_t RASET     = 0x2B;
inline constexpr uint8_t RAMWR     = 0x2C;
inline constexpr uint8_t RAMRD     = 0x2E;
inline constexpr uint8_t PTLAR     = 0x30;
inline constexpr uint8_t MADCTL    = 0x36;
inline constexpr uint8_t COLMOD    = 0x3A;
inline constexpr uint8_t FRMCTR1   = 0xB1;
inline constexpr uint8_t FRMCTR2   = 0xB2;
inline constexpr uint8_t FRMCTR3   = 0xB3;
inline constexpr uint8_t INVCTR    = 0xB4;
inline constexpr uint8_t DISSET5   = 0xB6;
inline constexpr uint8_t PWCTR1    = 0xC0;
inline constexpr uint8_t PWCTR2    = 0xC1;
inline constexpr uint8_t PWCTR3    = 0xC2;
inline constexpr uint8_t PWCTR4    = 0xC3;
inline constexpr uint8_t PWCTR5    = 0xC4;
inline constexpr uint8_t VMCTR1    = 0xC5;
inline constexpr uint8_t VMOFCTR   = 0xC7;
inline constexpr uint8_t WRID2     = 0xD1;
inline constexpr uint8_t WRID3     = 0xD2;
inline constexpr uint8_t PWCTR6    = 0xFC;
inline constexpr uint8_t GMCTRP1   = 0xE0;
inline constexpr uint8_t GMCTRN1   = 0xE1;

// MADCTL Orientation Bit Flags
inline constexpr uint8_t MADCTL_MY  = 0x80;
inline constexpr uint8_t MADCTL_MX  = 0x40;
inline constexpr uint8_t MADCTL_MV  = 0x20;
inline constexpr uint8_t MADCTL_ML  = 0x10;
inline constexpr uint8_t MADCTL_RGB = 0x00;
inline constexpr uint8_t MADCTL_BGR = 0x08;
inline constexpr uint8_t MADCTL_MH  = 0x04;
} // namespace st7735_cmd

// ============================================================================
// Display Driver Configuration
// ============================================================================
struct DisplayConfig {
    int pinMosi{petbot::hal::pins::PIN_TFT_MOSI};
    int pinSclk{petbot::hal::pins::PIN_TFT_SCLK};
    int pinCs{petbot::hal::pins::PIN_TFT_CS};
    int pinDc{petbot::hal::pins::PIN_TFT_DC};
    int pinRst{petbot::hal::pins::PIN_TFT_RST};
    int pinBl{petbot::hal::pins::PIN_TFT_BL};

    uint32_t spiSpeedHz{40000000}; // 40 MHz SPI Clock
    uint8_t  colOffset{0};         // Hardware ST7735 panel column offset
    uint8_t  rowOffset{0};         // Hardware ST7735 panel row offset
    uint8_t  rotation{1};          // 1: Horizontal Landscape (160x128, pins on LEFT), 0: Portrait, 2: Inv Portrait, 3: Inv Landscape
    bool     invertColors{false};  // Inversion flag
    bool     bgrMode{true};        // True: BGR color filter, False: RGB
};

// ============================================================================
// ST7735 60FPS SPI DMA Display Driver
// ============================================================================
class DisplayHal {
public:
    static DisplayHal& instance() noexcept;

    DisplayHal(const DisplayHal&) = delete;
    DisplayHal& operator=(const DisplayHal&) = delete;
    DisplayHal(DisplayHal&&) = delete;
    DisplayHal& operator=(DisplayHal&&) = delete;

    /**
     * Initialize ST7735 display hardware, GPIOs, SPI bus with DMA,
     * LEDC backlight PWM, pre-allocate PSRAM buffers and DMA ping-pong bounce buffers,
     * and spawn the asynchronous DMA worker task.
     * @param config Optional custom configuration.
     * @return true on successful initialization.
     */
    [[nodiscard]] bool init(const DisplayConfig& config = DisplayConfig{}) noexcept;

    /**
     * Set display backlight brightness percentage (0 to 100%).
     */
    void setBacklightPct(uint8_t pct) noexcept;
    [[nodiscard]] uint8_t getBacklightPct() const noexcept { return backlightPct_; }

    /**
     * Get active rendering canvas wrapping backBuffer_.
     * Applications draw to this canvas.
     */
    [[nodiscard]] Canvas128x160& getCanvas() noexcept { return backCanvas_; }

    /**
     * Get front canvas wrapping frontBuffer_ (currently displayed or flushing).
     */
    [[nodiscard]] Canvas128x160& getFrontCanvas() noexcept { return frontCanvas_; }

    /**
     * Asynchronously swap front and back buffers and dispatch SPI DMA flush.
     * The back buffer becomes the front buffer and is pushed to the ST7735
     * in the background without blocking the caller.
     * @param waitPrevious If true, ensures any in-flight DMA frame completes before swap.
     */
    void swapAndFlushDMA(bool waitPrevious = true) noexcept;

    /**
     * Synchronously wait for in-flight DMA transfer to complete.
     * @param timeoutMs Timeout in milliseconds.
     * @return true if complete, false if timed out.
     */
    bool waitForFlushDone(uint32_t timeoutMs = 100) noexcept;

    /**
     * Check if a DMA flush operation is currently active.
     */
    [[nodiscard]] bool isFlushing() const noexcept { return isFlushing_.load(std::memory_order_relaxed); }

    /**
     * Configure panel rotation (0: Portrait, 1: Landscape, 2: Inverted Portrait, 3: Inverted Landscape).
     */
    void setRotation(uint8_t rotation) noexcept;

    /**
     * Set display inversion (true: inverted, false: normal).
     */
    void invertDisplay(bool invert) noexcept;

    /**
     * Put display into sleep mode or wake up.
     */
    void sleepDisplay(bool sleep) noexcept;

    /**
     * Set panel hardware column and row offsets (for non-standard glass cuts).
     */
    void setOffsets(uint8_t colOffset, uint8_t rowOffset) noexcept;

    // Telemetry & Profiling
    [[nodiscard]] uint32_t getFrameCount() const noexcept { return frameCount_.load(std::memory_order_relaxed); }
    [[nodiscard]] float getMeasuredFps() const noexcept { return measuredFps_; }
    [[nodiscard]] uint32_t getLastFlushDurationUs() const noexcept { return lastFlushDurationUs_; }

private:
    DisplayHal() noexcept;
    ~DisplayHal() noexcept;

    void hardwareReset() noexcept;
    void sendCommand(uint8_t cmd) noexcept;
    void sendData(const uint8_t* data, size_t length) noexcept;
    void sendDataByte(uint8_t byte) noexcept;
    void setAddrWindow(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1) noexcept;
    void executeInitSequence() noexcept;
    void updateMadctl() noexcept;

    // FreeRTOS background DMA flush worker
    static void dmaWorkerTask(void* param) noexcept;
    void runDmaFlushPipeline() noexcept;

    DisplayConfig config_{};
    bool isInitialized_{false};
    uint8_t backlightPct_{100};

    // Dual 40,960 Byte Framebuffers in Octal PSRAM
    PsramFrameBuffer bufferA_{};
    PsramFrameBuffer bufferB_{};
    uint16_t* frontBuffer_{nullptr};
    uint16_t* backBuffer_{nullptr};

    Canvas128x160 frontCanvas_{};
    Canvas128x160 backCanvas_{};

    // Internal SRAM Ping-Pong DMA Bounce Buffers (10,240 Bytes x 2)
    DmaPingPongBuffers dmaBuffers_{};

#ifdef ESP32
    spi_device_handle_t spiDevice_{nullptr};
    TaskHandle_t dmaTaskHandle_{nullptr};
    SemaphoreHandle_t flushDoneSem_{nullptr};
    spi_transaction_t dmaTransactions_[2]{};
#endif

    std::atomic<bool> isFlushing_{false};
    std::atomic<uint32_t> frameCount_{0};
    float measuredFps_{0.0f};
    uint32_t lastFlushDurationUs_{0};
    uint32_t fpsTimestampMs_{0};
    uint32_t fpsFrameCounter_{0};
};

} // namespace petbot::hal
