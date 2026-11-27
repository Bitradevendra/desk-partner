#pragma once

#include <cstdint>
#include <cstddef>

namespace petbot::firmware::config {

// GPIO Pin mappings for ESP32-S3-DevKitC-1 with ST7735S / ST7789 SPI LCD
inline constexpr int PIN_LCD_MOSI = 11;
inline constexpr int PIN_LCD_SCLK = 12;
inline constexpr int PIN_LCD_CS   = 10;
inline constexpr int PIN_LCD_DC   = 9;
inline constexpr int PIN_LCD_RST  = 14;
inline constexpr int PIN_LCD_BL   = 13;

// I2S Microphone (INMP441)
inline constexpr int PIN_I2S_MIC_SCK = 4;
inline constexpr int PIN_I2S_MIC_WS  = 5;
inline constexpr int PIN_I2S_MIC_SD  = 6;

// I2S Speaker / DAC (MAX98357A)
inline constexpr int PIN_I2S_SPK_BCLK = 15;
inline constexpr int PIN_I2S_SPK_LRC  = 16;
inline constexpr int PIN_I2S_SPK_DOUT = 17;

// Zero-Config Discovery & Transport Configuration
inline constexpr uint16_t    DEFAULT_WS_PORT         = 8443;
inline constexpr const char* DEFAULT_MDNS_HOST       = "petbot";
inline constexpr const char* DEFAULT_BLE_DEVICE_NAME = "PetBot-Agent";
inline constexpr const char* DEFAULT_WIFI_SSID       = "lobo";
inline constexpr const char* DEFAULT_WIFI_PASS       = "lobo1234";
inline constexpr size_t      PSRAM_RING_BUFFER_BYTES = 256 * 1024; // 256KB Ring Buffer in Octal PSRAM
inline constexpr uint32_t    HEARTBEAT_INTERVAL_MS   = 3000;       // Ping every 3000ms
inline constexpr uint32_t    HEARTBEAT_TIMEOUT_MS    = 6000;       // Drop timeout after 6 seconds

} // namespace petbot::firmware::config
