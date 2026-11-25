#include "hal/display_hal.h"
#include <Arduino.h>

#ifdef ESP32
#include <esp_timer.h>
#endif

namespace petbot::hal {

// ============================================================================
// Singleton Access
// ============================================================================
DisplayHal& DisplayHal::instance() noexcept {
    static DisplayHal s_instance;
    return s_instance;
}

DisplayHal::DisplayHal() noexcept = default;

DisplayHal::~DisplayHal() noexcept {
#ifdef ESP32
    if (dmaTaskHandle_) {
        vTaskDelete(dmaTaskHandle_);
        dmaTaskHandle_ = nullptr;
    }
    if (flushDoneSem_) {
        vSemaphoreDelete(flushDoneSem_);
        flushDoneSem_ = nullptr;
    }
    if (spiDevice_) {
        spi_bus_remove_device(spiDevice_);
        spiDevice_ = nullptr;
    }
#endif
}

// ============================================================================
// Initialization Sequence
// ============================================================================
bool DisplayHal::init(const DisplayConfig& config) noexcept {
    if (isInitialized_) return true;
    config_ = config;

    // 1. Allocate dual 40,960-byte framebuffers in Octal PSRAM
    if (!bufferA_.allocate() || !bufferB_.allocate()) {
        Serial.println("[DisplayHal] ERROR: Failed to allocate dual PSRAM framebuffers!");
        return false;
    }

    frontBuffer_ = bufferA_.pixels();
    backBuffer_  = bufferB_.pixels();
    frontCanvas_.setTargetBuffer(frontBuffer_);
    backCanvas_.setTargetBuffer(backBuffer_);

    // 2. Allocate internal SRAM DMA ping-pong slice bounce buffers
    if (!dmaBuffers_.allocate()) {
        Serial.println("[DisplayHal] ERROR: Failed to allocate internal SRAM DMA bounce buffers!");
        return false;
    }

#ifdef ESP32
    // 3. Configure Control GPIOs
    gpio_config_t io_conf{};
    io_conf.intr_type = GPIO_INTR_DISABLE;
    io_conf.mode = GPIO_MODE_OUTPUT;
    io_conf.pin_bit_mask = (1ULL << config_.pinDc) | (1ULL << config_.pinRst) | (1ULL << config_.pinCs);
    io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
    io_conf.pull_up_en = GPIO_PULLUP_ENABLE;
    gpio_config(&io_conf);

    gpio_set_level(static_cast<gpio_num_t>(config_.pinCs), 1);
    gpio_set_level(static_cast<gpio_num_t>(config_.pinDc), 1);
    gpio_set_level(static_cast<gpio_num_t>(config_.pinRst), 1);

    // 4. Configure LEDC PWM Backlight Control
    ledc_timer_config_t ledc_timer{};
    ledc_timer.speed_mode       = LEDC_LOW_SPEED_MODE;
    ledc_timer.duty_resolution  = static_cast<ledc_timer_bit_t>(petbot::hal::pins::TFT_BL_LEDC_RES_BITS);
    ledc_timer.timer_num        = static_cast<ledc_timer_t>(petbot::hal::pins::TFT_BL_LEDC_TIMER);
    ledc_timer.freq_hz          = petbot::hal::pins::TFT_BL_LEDC_FREQ_HZ;
    ledc_timer.clk_cfg          = LEDC_AUTO_CLK;
    ledc_timer_config(&ledc_timer);

    ledc_channel_config_t ledc_channel{};
    ledc_channel.speed_mode     = LEDC_LOW_SPEED_MODE;
    ledc_channel.channel        = static_cast<ledc_channel_t>(petbot::hal::pins::TFT_BL_LEDC_CHANNEL);
    ledc_channel.timer_sel      = static_cast<ledc_timer_t>(petbot::hal::pins::TFT_BL_LEDC_TIMER);
    ledc_channel.intr_type      = LEDC_INTR_DISABLE;
    ledc_channel.gpio_num       = config_.pinBl;
    ledc_channel.duty           = 255; // Default full brightness
    ledc_channel.hpoint         = 0;
    ledc_channel_config(&ledc_channel);

    // 5. Initialize SPI Master Bus with DMA on SPI2_HOST (FSPI)
    spi_bus_config_t buscfg{};
    buscfg.mosi_io_num     = config_.pinMosi;
    buscfg.miso_io_num     = -1;
    buscfg.sclk_io_num     = config_.pinSclk;
    buscfg.quadwp_io_num   = -1;
    buscfg.quadhd_io_num   = -1;
    buscfg.max_transfer_sz = static_cast<int>(DMA_SLICE_BYTES + 32);

    esp_err_t ret = spi_bus_initialize(SPI2_HOST, &buscfg, SPI_DMA_CH_AUTO);
    if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE) {
        Serial.printf("[DisplayHal] ERROR: spi_bus_initialize failed: 0x%x\n", ret);
        return false;
    }

    // 6. Register ST7735 device on SPI bus (40 MHz)
    spi_device_interface_config_t devcfg{};
    devcfg.clock_speed_hz = static_cast<int>(config_.spiSpeedHz);
    devcfg.mode           = 0; // SPI Mode 0 (CPOL=0, CPHA=0)
    devcfg.spics_io_num   = -1; // Manual CS toggling for bulk bursts
    devcfg.queue_size     = 4;  // Ping-Pong queue depth
    devcfg.flags          = SPI_DEVICE_NO_DUMMY;

    ret = spi_bus_add_device(SPI2_HOST, &devcfg, &spiDevice_);
    if (ret != ESP_OK) {
        Serial.printf("[DisplayHal] ERROR: spi_bus_add_device failed: 0x%x\n", ret);
        return false;
    }

    // 7. Synchronization primitives and background DMA task
    flushDoneSem_ = xSemaphoreCreateBinary();
    xSemaphoreGive(flushDoneSem_);

    BaseType_t taskRet = xTaskCreatePinnedToCore(
        &DisplayHal::dmaWorkerTask,
        "tft_dma",
        4096,
        this,
        configMAX_PRIORITIES - 2, // High priority for smooth 60FPS
        &dmaTaskHandle_,
        0 // Pinned to Core 0 (Audio/Display Core)
    );

    if (taskRet != pdPASS) {
        Serial.println("[DisplayHal] ERROR: Failed to create background DMA flush task!");
        return false;
    }
#endif

    // 8. Hardware Reset and ST7735 controller initialization
    hardwareReset();
    executeInitSequence();
    setRotation(config_.rotation);
    setBacklightPct(100);

    // Initial clear
    backCanvas_.clear(colors::Black);
    frontCanvas_.clear(colors::Black);
    swapAndFlushDMA(true);
    waitForFlushDone(100);

    isInitialized_ = true;
    Serial.println("[DisplayHal] ST7735 128x160 60FPS DMA Display Driver Initialized at 40MHz.");
    return true;
}

// ============================================================================
// Low-Level SPI Transmission Helpers
// ============================================================================
void DisplayHal::hardwareReset() noexcept {
#ifdef ESP32
    gpio_set_level(static_cast<gpio_num_t>(config_.pinRst), 0);
    delay(20);
    gpio_set_level(static_cast<gpio_num_t>(config_.pinRst), 1);
    delay(120);
#endif
}

void DisplayHal::sendCommand(uint8_t cmd) noexcept {
#ifdef ESP32
    gpio_set_level(static_cast<gpio_num_t>(config_.pinDc), 0); // DC = 0 (Command)
    gpio_set_level(static_cast<gpio_num_t>(config_.pinCs), 0); // CS = 0 (Active)

    spi_transaction_t t{};
    t.length    = 8;
    t.tx_buffer = &cmd;
    spi_device_polling_transmit(spiDevice_, &t);

    gpio_set_level(static_cast<gpio_num_t>(config_.pinCs), 1); // CS = 1 (Idle)
#else
    (void)cmd;
#endif
}

void DisplayHal::sendData(const uint8_t* data, size_t length) noexcept {
#ifdef ESP32
    if (!data || length == 0) return;
    gpio_set_level(static_cast<gpio_num_t>(config_.pinDc), 1); // DC = 1 (Data)
    gpio_set_level(static_cast<gpio_num_t>(config_.pinCs), 0); // CS = 0 (Active)

    spi_transaction_t t{};
    t.length    = length * 8;
    t.tx_buffer = data;
    spi_device_polling_transmit(spiDevice_, &t);

    gpio_set_level(static_cast<gpio_num_t>(config_.pinCs), 1); // CS = 1 (Idle)
#else
    (void)data;
    (void)length;
#endif
}

void DisplayHal::sendDataByte(uint8_t byte) noexcept {
    sendData(&byte, 1);
}

void DisplayHal::setAddrWindow(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1) noexcept {
#ifdef ESP32
    const uint16_t adjX0 = x0 + config_.colOffset;
    const uint16_t adjX1 = x1 + config_.colOffset;
    const uint16_t adjY0 = y0 + config_.rowOffset;
    const uint16_t adjY1 = y1 + config_.rowOffset;

    sendCommand(st7735_cmd::CASET);
    const uint8_t colData[4] = {
        static_cast<uint8_t>(adjX0 >> 8), static_cast<uint8_t>(adjX0 & 0xFF),
        static_cast<uint8_t>(adjX1 >> 8), static_cast<uint8_t>(adjX1 & 0xFF)
    };
    sendData(colData, sizeof(colData));

    sendCommand(st7735_cmd::RASET);
    const uint8_t rowData[4] = {
        static_cast<uint8_t>(adjY0 >> 8), static_cast<uint8_t>(adjY0 & 0xFF),
        static_cast<uint8_t>(adjY1 >> 8), static_cast<uint8_t>(adjY1 & 0xFF)
    };
    sendData(rowData, sizeof(rowData));

    sendCommand(st7735_cmd::RAMWR);
#else
    (void)x0; (void)y0; (void)x1; (void)y1;
#endif
}

// ============================================================================
// ST7735 Controller Command Sequence
// ============================================================================
void DisplayHal::executeInitSequence() noexcept {
    sendCommand(st7735_cmd::SWRESET);
    delay(150);

    sendCommand(st7735_cmd::SLPOUT);
    delay(200);

    // Frame rate control in normal mode (FRMCTR1)
    sendCommand(st7735_cmd::FRMCTR1);
    const uint8_t frmctr1[] = {0x01, 0x2C, 0x2D};
    sendData(frmctr1, sizeof(frmctr1));

    // Frame rate control in idle mode (FRMCTR2)
    sendCommand(st7735_cmd::FRMCTR2);
    const uint8_t frmctr2[] = {0x01, 0x2C, 0x2D};
    sendData(frmctr2, sizeof(frmctr2));

    // Frame rate control in partial mode (FRMCTR3)
    sendCommand(st7735_cmd::FRMCTR3);
    const uint8_t frmctr3[] = {0x01, 0x2C, 0x2D, 0x01, 0x2C, 0x2D};
    sendData(frmctr3, sizeof(frmctr3));

    // Display inversion control (INVCTR) - Dot inversion
    sendCommand(st7735_cmd::INVCTR);
    sendDataByte(0x07);

    // Power sequence (PWCTR1 - PWCTR5)
    sendCommand(st7735_cmd::PWCTR1);
    const uint8_t pwctr1[] = {0xA2, 0x02, 0x84};
    sendData(pwctr1, sizeof(pwctr1));

    sendCommand(st7735_cmd::PWCTR2);
    sendDataByte(0xC5);

    sendCommand(st7735_cmd::PWCTR3);
    const uint8_t pwctr3[] = {0x0A, 0x00};
    sendData(pwctr3, sizeof(pwctr3));

    sendCommand(st7735_cmd::PWCTR4);
    const uint8_t pwctr4[] = {0x8A, 0x2A};
    sendData(pwctr4, sizeof(pwctr4));

    sendCommand(st7735_cmd::PWCTR5);
    const uint8_t pwctr5[] = {0x8A, 0xEE};
    sendData(pwctr5, sizeof(pwctr5));

    // VCOM control (VMCTR1)
    sendCommand(st7735_cmd::VMCTR1);
    sendDataByte(0x0E);

    // Color format: 16 bits/pixel (RGB565)
    sendCommand(st7735_cmd::COLMOD);
    sendDataByte(0x05);

    // Positive Gamma Correction (GMCTRP1)
    sendCommand(st7735_cmd::GMCTRP1);
    const uint8_t gmctrp1[] = {
        0x02, 0x1C, 0x07, 0x12, 0x37, 0x32, 0x29, 0x2D,
        0x29, 0x25, 0x2B, 0x39, 0x00, 0x01, 0x03, 0x10
    };
    sendData(gmctrp1, sizeof(gmctrp1));

    // Negative Gamma Correction (GMCTRN1)
    sendCommand(st7735_cmd::GMCTRN1);
    const uint8_t gmctrn1[] = {
        0x03, 0x1D, 0x07, 0x06, 0x2E, 0x2C, 0x29, 0x2D,
        0x2E, 0x2E, 0x37, 0x3F, 0x00, 0x00, 0x02, 0x10
    };
    sendData(gmctrn1, sizeof(gmctrn1));

    // Normal display on
    sendCommand(st7735_cmd::NORON);
    delay(10);

    // Main screen turn on
    sendCommand(st7735_cmd::DISPON);
    delay(100);
}

void DisplayHal::updateMadctl() noexcept {
    sendCommand(st7735_cmd::MADCTL);
    uint8_t madctl = config_.bgrMode ? st7735_cmd::MADCTL_BGR : st7735_cmd::MADCTL_RGB;

    switch (config_.rotation & 0x03) {
        case 0: // Portrait
            madctl |= (st7735_cmd::MADCTL_MX | st7735_cmd::MADCTL_MY);
            break;
        case 1: // Landscape
            madctl |= (st7735_cmd::MADCTL_MY | st7735_cmd::MADCTL_MV);
            break;
        case 2: // Inverted Portrait
            break;
        case 3: // Inverted Landscape
            madctl |= (st7735_cmd::MADCTL_MX | st7735_cmd::MADCTL_MV);
            break;
    }

    sendDataByte(madctl);
}

// ============================================================================
// Controls: Backlight, Rotation, Sleep, Inversion
// ============================================================================
void DisplayHal::setBacklightPct(uint8_t pct) noexcept {
    if (pct > 100) pct = 100;
    backlightPct_ = pct;
#ifdef ESP32
    const uint32_t duty = (static_cast<uint32_t>(pct) * 255U) / 100U;
    ledc_set_duty(
        LEDC_LOW_SPEED_MODE,
        static_cast<ledc_channel_t>(petbot::hal::pins::TFT_BL_LEDC_CHANNEL),
        duty
    );
    ledc_update_duty(
        LEDC_LOW_SPEED_MODE,
        static_cast<ledc_channel_t>(petbot::hal::pins::TFT_BL_LEDC_CHANNEL)
    );
#endif
}

void DisplayHal::setRotation(uint8_t rotation) noexcept {
    config_.rotation = rotation;
    updateMadctl();
}

void DisplayHal::invertDisplay(bool invert) noexcept {
    config_.invertColors = invert;
    sendCommand(invert ? st7735_cmd::INVON : st7735_cmd::INVOFF);
}

void DisplayHal::sleepDisplay(bool sleep) noexcept {
    sendCommand(sleep ? st7735_cmd::SLPIN : st7735_cmd::SLPOUT);
    delay(sleep ? 5 : 120);
}

void DisplayHal::setOffsets(uint8_t colOffset, uint8_t rowOffset) noexcept {
    config_.colOffset = colOffset;
    config_.rowOffset = rowOffset;
}

// ============================================================================
// Asynchronous SPI DMA Flush Engine
// ============================================================================
void DisplayHal::swapAndFlushDMA(bool waitPrevious) noexcept {
    if (waitPrevious) {
        waitForFlushDone(100);
    }

    // Atomically swap front and back buffer pointers
    uint16_t* const temp = frontBuffer_;
    frontBuffer_ = backBuffer_;
    backBuffer_  = temp;

    // Update canvas references: caller immediately renders to new backBuffer_
    frontCanvas_.setTargetBuffer(frontBuffer_);
    backCanvas_.setTargetBuffer(backBuffer_);

#ifdef ESP32
    if (dmaTaskHandle_) {
        isFlushing_.store(true, std::memory_order_release);
        xTaskNotifyGive(dmaTaskHandle_);
    }
#else
    isFlushing_.store(false, std::memory_order_relaxed);
#endif
}

bool DisplayHal::waitForFlushDone(uint32_t timeoutMs) noexcept {
    if (!isFlushing_.load(std::memory_order_acquire)) {
        return true;
    }

#ifdef ESP32
    if (flushDoneSem_) {
        const BaseType_t res = xSemaphoreTake(flushDoneSem_, pdMS_TO_TICKS(timeoutMs));
        if (res == pdTRUE) {
            xSemaphoreGive(flushDoneSem_);
            return true;
        }
        return false;
    }
#endif
    return true;
}

void DisplayHal::dmaWorkerTask(void* param) noexcept {
    auto* self = static_cast<DisplayHal*>(param);
    while (true) {
#ifdef ESP32
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        self->runDmaFlushPipeline();
#endif
    }
}

void DisplayHal::runDmaFlushPipeline() noexcept {
#ifdef ESP32
    const int64_t startUs = esp_timer_get_time();

    // 1. Prepare display address window for full 160x128 landscape frame
    setAddrWindow(0, 0, LCD_WIDTH - 1, LCD_HEIGHT - 1);

    // 2. Drive DC high (Data Mode) and CS low (Active) for high-speed burst
    gpio_set_level(static_cast<gpio_num_t>(config_.pinDc), 1);
    gpio_set_level(static_cast<gpio_num_t>(config_.pinCs), 0);

    // Slices: 4 slices * 32 lines = 128 lines
    // Pre-configured transaction descriptors
    dmaTransactions_[0] = spi_transaction_t{};
    dmaTransactions_[0].length = DMA_SLICE_BYTES * 8; // length in bits
    dmaTransactions_[0].tx_buffer = dmaBuffers_.ping();

    dmaTransactions_[1] = spi_transaction_t{};
    dmaTransactions_[1].length = DMA_SLICE_BYTES * 8;
    dmaTransactions_[1].tx_buffer = dmaBuffers_.pong();

    const uint16_t* srcPixels = frontBuffer_;

    // ========================================================================
    // Slice 0: Copy to Ping buffer, dispatch DMA transmission
    // ========================================================================
    uint16_t* const ping = dmaBuffers_.ping();
    uint16_t* const pong = dmaBuffers_.pong();

    for (size_t i = 0; i < DMA_SLICE_PIXELS; ++i) {
        ping[i] = __builtin_bswap16(srcPixels[i]);
    }
    srcPixels += DMA_SLICE_PIXELS;

    spi_device_queue_trans(spiDevice_, &dmaTransactions_[0], portMAX_DELAY);

    // ========================================================================
    // Slice 1: Copy to Pong buffer while Slice 0 transmits, wait Slice 0, dispatch Pong
    // ========================================================================
    for (size_t i = 0; i < DMA_SLICE_PIXELS; ++i) {
        pong[i] = __builtin_bswap16(srcPixels[i]);
    }
    srcPixels += DMA_SLICE_PIXELS;

    spi_transaction_t* retTrans = nullptr;
    spi_device_get_trans_result(spiDevice_, &retTrans, portMAX_DELAY);

    spi_device_queue_trans(spiDevice_, &dmaTransactions_[1], portMAX_DELAY);

    // ========================================================================
    // Slice 2: Copy to Ping buffer while Slice 1 transmits, wait Slice 1, dispatch Ping
    // ========================================================================
    for (size_t i = 0; i < DMA_SLICE_PIXELS; ++i) {
        ping[i] = __builtin_bswap16(srcPixels[i]);
    }
    srcPixels += DMA_SLICE_PIXELS;

    spi_device_get_trans_result(spiDevice_, &retTrans, portMAX_DELAY);

    spi_device_queue_trans(spiDevice_, &dmaTransactions_[0], portMAX_DELAY);

    // ========================================================================
    // Slice 3: Copy to Pong buffer while Slice 2 transmits, wait Slice 2, dispatch Pong, wait finish
    // ========================================================================
    for (size_t i = 0; i < DMA_SLICE_PIXELS; ++i) {
        pong[i] = __builtin_bswap16(srcPixels[i]);
    }

    spi_device_get_trans_result(spiDevice_, &retTrans, portMAX_DELAY);

    spi_device_queue_trans(spiDevice_, &dmaTransactions_[1], portMAX_DELAY);

    spi_device_get_trans_result(spiDevice_, &retTrans, portMAX_DELAY);

    // 3. De-assert CS
    gpio_set_level(static_cast<gpio_num_t>(config_.pinCs), 1);

    // 4. Calculate timing and rolling FPS
    const int64_t endUs = esp_timer_get_time();
    lastFlushDurationUs_ = static_cast<uint32_t>(endUs - startUs);

    frameCount_.fetch_add(1, std::memory_order_relaxed);
    fpsFrameCounter_++;

    const uint32_t nowMs = millis();
    if (nowMs - fpsTimestampMs_ >= 1000) {
        measuredFps_ = static_cast<float>(fpsFrameCounter_ * 1000.0f) / static_cast<float>(nowMs - fpsTimestampMs_);
        fpsFrameCounter_ = 0;
        fpsTimestampMs_ = nowMs;
    }

    // 5. Signal completion to any awaiting synchronous threads
    isFlushing_.store(false, std::memory_order_release);
    if (flushDoneSem_) {
        xSemaphoreGive(flushDoneSem_);
    }
#endif
}

} // namespace petbot::hal
