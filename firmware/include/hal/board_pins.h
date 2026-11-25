/**
 * Hardware Abstraction Layer - Board Pin Definitions & Dynamic Runtime Overrides
 * ESP32-S3-WROOM-1 / ESP32-S3-DevKitC-1 N16R8 (16MB Flash, 8MB Octal PSRAM)
 *
 * Supports runtime and NVS-persisted GPIO pin overrides (NVS namespace "pins")
 * so any wire on the physical breadboard/PCB can be remapped over USB Serial
 * ("setpin <name> <gpio>") without recompiling C++.
 */
#pragma once

#include <cstdint>
#include <cstring>
#include <cctype>

#ifdef ESP32
#include <Preferences.h>
#include <driver/gpio.h>
#include <driver/spi_master.h>
#include <driver/i2s.h>
#include <driver/ledc.h>
#endif

namespace petbot::hal::pins {

// ============================================================================
// Default Compile-Time Pin Definitions (ESP32-S3 DevKitC-1 N16R8)
// ============================================================================

// 1.8" ST7735 SPI TFT Display (128x160 RGB565)
inline constexpr int DEFAULT_PIN_TFT_MOSI = 11;
inline constexpr int DEFAULT_PIN_TFT_SCLK = 12;
inline constexpr int DEFAULT_PIN_TFT_CS   = 10;
inline constexpr int DEFAULT_PIN_TFT_DC   = 9;
inline constexpr int DEFAULT_PIN_TFT_RST  = 14;
inline constexpr int DEFAULT_PIN_TFT_BL   = 21; // Hardware LEDC PWM Backlight Control

// TFT Backlight LEDC PWM Configuration
inline constexpr uint32_t TFT_BL_LEDC_FREQ_HZ   = 5000; // 5 kHz PWM frequency (avoids acoustic buzz)
inline constexpr uint8_t  TFT_BL_LEDC_RES_BITS  = 8;    // 8-bit resolution (0 - 255)
inline constexpr uint8_t  TFT_BL_LEDC_CHANNEL   = 0;    // LEDC Channel 0
inline constexpr uint8_t  TFT_BL_LEDC_TIMER     = 0;    // LEDC Timer 0

// MicroSD Card (Dedicated SPI Host / FSPI)
inline constexpr int DEFAULT_PIN_SD_CS   = 38;
inline constexpr int DEFAULT_PIN_SD_MOSI = 39;
inline constexpr int DEFAULT_PIN_SD_MISO = 40;
inline constexpr int DEFAULT_PIN_SD_SCLK = 41;

// I2S MEMS Microphone (INMP441 / ICS-43434) - Assigned to I2S_NUM_0
inline constexpr int DEFAULT_PIN_MIC_BCLK = 4;
inline constexpr int DEFAULT_PIN_MIC_WS   = 5;
inline constexpr int DEFAULT_PIN_MIC_DIN  = 6;

// I2S Class-D Speaker Amplifier (MAX98357A) - Assigned to I2S_NUM_1
inline constexpr int DEFAULT_PIN_SPK_BCLK    = 15;
inline constexpr int DEFAULT_PIN_SPK_LRCK    = 16;
inline constexpr int DEFAULT_PIN_SPK_DOUT    = 7;
inline constexpr int DEFAULT_PIN_SPK_SD_MODE = 17; // Shutdown mode (active low powerdown / mute)

// Capacitive Touch Sensors (2-Sensor Configuration: Left Ear GPIO 1 & Right Ear GPIO 2)
inline constexpr int DEFAULT_PIN_TOUCH_LEFT   = 1;  // Left Touch Sensor
inline constexpr int DEFAULT_PIN_TOUCH_RIGHT  = 2;  // Right Touch Sensor
inline constexpr int DEFAULT_PIN_TOUCH_SIDE   = -1; // Disabled (2-sensor hardware build)
inline constexpr int DEFAULT_PIN_TOUCH_SENSOR = 1;  // Backward compatibility alias

// ============================================================================
// Active Runtime Pin Variables (Mutable, loaded from NVS namespace "pins")
// ============================================================================
inline int PIN_TFT_MOSI = DEFAULT_PIN_TFT_MOSI;
inline int PIN_TFT_SCLK = DEFAULT_PIN_TFT_SCLK;
inline int PIN_TFT_CS   = DEFAULT_PIN_TFT_CS;
inline int PIN_TFT_DC   = DEFAULT_PIN_TFT_DC;
inline int PIN_TFT_RST  = DEFAULT_PIN_TFT_RST;
inline int PIN_TFT_BL   = DEFAULT_PIN_TFT_BL;

inline int PIN_SD_CS   = DEFAULT_PIN_SD_CS;
inline int PIN_SD_MOSI = DEFAULT_PIN_SD_MOSI;
inline int PIN_SD_MISO = DEFAULT_PIN_SD_MISO;
inline int PIN_SD_SCLK = DEFAULT_PIN_SD_SCLK;

inline int PIN_MIC_BCLK = DEFAULT_PIN_MIC_BCLK;
inline int PIN_MIC_WS   = DEFAULT_PIN_MIC_WS;
inline int PIN_MIC_DIN  = DEFAULT_PIN_MIC_DIN;

inline int PIN_SPK_BCLK    = DEFAULT_PIN_SPK_BCLK;
inline int PIN_SPK_LRCK    = DEFAULT_PIN_SPK_LRCK;
inline int PIN_SPK_DOUT    = DEFAULT_PIN_SPK_DOUT;
inline int PIN_SPK_SD_MODE = DEFAULT_PIN_SPK_SD_MODE;

inline int PIN_TOUCH_LEFT   = DEFAULT_PIN_TOUCH_LEFT;
inline int PIN_TOUCH_RIGHT  = DEFAULT_PIN_TOUCH_RIGHT;
inline int PIN_TOUCH_SIDE   = DEFAULT_PIN_TOUCH_SIDE;
inline int PIN_TOUCH_SENSOR = 1;

// ============================================================================
// NVS Pin Persistence & Management Functions (Namespace: "pins")
// ============================================================================

/**
 * Load persisted pin overrides from ESP32 NVS namespace "pins".
 * Invoked during early boot in setup() before HAL subsystems initialize.
 */
inline void loadPinOverrides() {
#ifdef ESP32
    Preferences prefs;
    if (prefs.begin("pins", true)) { // Read-only
        PIN_TFT_MOSI = prefs.getInt("tft_mosi", DEFAULT_PIN_TFT_MOSI);
        PIN_TFT_SCLK = prefs.getInt("tft_sclk", DEFAULT_PIN_TFT_SCLK);
        PIN_TFT_CS   = prefs.getInt("tft_cs", DEFAULT_PIN_TFT_CS);
        PIN_TFT_DC   = prefs.getInt("tft_dc", DEFAULT_PIN_TFT_DC);
        PIN_TFT_RST  = prefs.getInt("tft_rst", DEFAULT_PIN_TFT_RST);
        PIN_TFT_BL   = prefs.getInt("tft_bl", DEFAULT_PIN_TFT_BL);

        PIN_SD_CS    = prefs.getInt("sd_cs", DEFAULT_PIN_SD_CS);
        PIN_SD_MOSI  = prefs.getInt("sd_mosi", DEFAULT_PIN_SD_MOSI);
        PIN_SD_MISO  = prefs.getInt("sd_miso", DEFAULT_PIN_SD_MISO);
        PIN_SD_SCLK  = prefs.getInt("sd_sclk", DEFAULT_PIN_SD_SCLK);

        PIN_MIC_BCLK = prefs.getInt("mic_bclk", DEFAULT_PIN_MIC_BCLK);
        PIN_MIC_WS   = prefs.getInt("mic_ws", DEFAULT_PIN_MIC_WS);
        PIN_MIC_DIN  = prefs.getInt("mic_din", DEFAULT_PIN_MIC_DIN);

        PIN_SPK_BCLK    = prefs.getInt("spk_bclk", DEFAULT_PIN_SPK_BCLK);
        PIN_SPK_LRCK    = prefs.getInt("spk_lrck", DEFAULT_PIN_SPK_LRCK);
        PIN_SPK_DOUT    = prefs.getInt("spk_dout", DEFAULT_PIN_SPK_DOUT);
        PIN_SPK_SD_MODE = prefs.getInt("spk_sd_mode", DEFAULT_PIN_SPK_SD_MODE);

        PIN_TOUCH_LEFT  = prefs.getInt("touch_left", prefs.getInt("touch", DEFAULT_PIN_TOUCH_LEFT));
        PIN_TOUCH_RIGHT = prefs.getInt("touch_right", DEFAULT_PIN_TOUCH_RIGHT);
        PIN_TOUCH_SIDE  = prefs.getInt("touch_side", DEFAULT_PIN_TOUCH_SIDE);
        prefs.end();
    }
#endif
}

/**
 * Set and persist a GPIO pin override into NVS namespace "pins".
 * @param name Pin name (e.g., "tft_mosi", "touch", "mic_din", "sd_cs")
 * @param gpio Target GPIO number (0 - 48)
 * @return true if pin name was recognized and override stored
 */
inline bool setPinOverride(const char* name, int gpio) {
    if (!name || *name == '\0') return false;

    char key[32]{0};
    size_t i = 0;
    while (name[i] && i < sizeof(key) - 1) {
        key[i] = static_cast<char>(tolower(name[i]));
        i++;
    }
    key[i] = '\0';

    const char* nvsKey = nullptr;
    int* targetVar = nullptr;

    if (strcmp(key, "tft_mosi") == 0 || strcmp(key, "mosi") == 0) {
        nvsKey = "tft_mosi"; targetVar = &PIN_TFT_MOSI;
    } else if (strcmp(key, "tft_sclk") == 0 || strcmp(key, "sclk") == 0) {
        nvsKey = "tft_sclk"; targetVar = &PIN_TFT_SCLK;
    } else if (strcmp(key, "tft_cs") == 0 || strcmp(key, "cs") == 0) {
        nvsKey = "tft_cs"; targetVar = &PIN_TFT_CS;
    } else if (strcmp(key, "tft_dc") == 0 || strcmp(key, "dc") == 0) {
        nvsKey = "tft_dc"; targetVar = &PIN_TFT_DC;
    } else if (strcmp(key, "tft_rst") == 0 || strcmp(key, "rst") == 0) {
        nvsKey = "tft_rst"; targetVar = &PIN_TFT_RST;
    } else if (strcmp(key, "tft_bl") == 0 || strcmp(key, "bl") == 0) {
        nvsKey = "tft_bl"; targetVar = &PIN_TFT_BL;
    } else if (strcmp(key, "sd_cs") == 0) {
        nvsKey = "sd_cs"; targetVar = &PIN_SD_CS;
    } else if (strcmp(key, "sd_mosi") == 0) {
        nvsKey = "sd_mosi"; targetVar = &PIN_SD_MOSI;
    } else if (strcmp(key, "sd_miso") == 0) {
        nvsKey = "sd_miso"; targetVar = &PIN_SD_MISO;
    } else if (strcmp(key, "sd_sclk") == 0) {
        nvsKey = "sd_sclk"; targetVar = &PIN_SD_SCLK;
    } else if (strcmp(key, "mic_bclk") == 0) {
        nvsKey = "mic_bclk"; targetVar = &PIN_MIC_BCLK;
    } else if (strcmp(key, "mic_ws") == 0) {
        nvsKey = "mic_ws"; targetVar = &PIN_MIC_WS;
    } else if (strcmp(key, "mic_din") == 0) {
        nvsKey = "mic_din"; targetVar = &PIN_MIC_DIN;
    } else if (strcmp(key, "spk_bclk") == 0) {
        nvsKey = "spk_bclk"; targetVar = &PIN_SPK_BCLK;
    } else if (strcmp(key, "spk_lrck") == 0) {
        nvsKey = "spk_lrck"; targetVar = &PIN_SPK_LRCK;
    } else if (strcmp(key, "spk_dout") == 0) {
        nvsKey = "spk_dout"; targetVar = &PIN_SPK_DOUT;
    } else if (strcmp(key, "spk_sd_mode") == 0 || strcmp(key, "spk_sd") == 0) {
        nvsKey = "spk_sd_mode"; targetVar = &PIN_SPK_SD_MODE;
    } else if (strcmp(key, "touch_left") == 0 || strcmp(key, "touch_l") == 0) {
        nvsKey = "touch_left"; targetVar = &PIN_TOUCH_LEFT;
    } else if (strcmp(key, "touch_right") == 0 || strcmp(key, "touch_r") == 0) {
        nvsKey = "touch_right"; targetVar = &PIN_TOUCH_RIGHT;
    } else if (strcmp(key, "touch_side") == 0 || strcmp(key, "touch_s") == 0 || strcmp(key, "side") == 0) {
        nvsKey = "touch_side"; targetVar = &PIN_TOUCH_SIDE;
    } else if (strcmp(key, "touch") == 0 || strcmp(key, "touch_sensor") == 0 || strcmp(key, "pin_touch_sensor") == 0) {
        nvsKey = "touch_left"; targetVar = &PIN_TOUCH_LEFT;
    } else {
        return false;
    }

    *targetVar = gpio;

#ifdef ESP32
    Preferences prefs;
    if (prefs.begin("pins", false)) { // Read-write
        prefs.putInt(nvsKey, gpio);
        prefs.end();
    }
#endif
    return true;
}

/**
 * Reset all pin overrides stored in NVS namespace "pins" back to hardware defaults.
 */
inline void resetPinOverrides() {
    PIN_TFT_MOSI = DEFAULT_PIN_TFT_MOSI;
    PIN_TFT_SCLK = DEFAULT_PIN_TFT_SCLK;
    PIN_TFT_CS   = DEFAULT_PIN_TFT_CS;
    PIN_TFT_DC   = DEFAULT_PIN_TFT_DC;
    PIN_TFT_RST  = DEFAULT_PIN_TFT_RST;
    PIN_TFT_BL   = DEFAULT_PIN_TFT_BL;

    PIN_SD_CS   = DEFAULT_PIN_SD_CS;
    PIN_SD_MOSI = DEFAULT_PIN_SD_MOSI;
    PIN_SD_MISO = DEFAULT_PIN_SD_MISO;
    PIN_SD_SCLK = DEFAULT_PIN_SD_SCLK;

    PIN_MIC_BCLK = DEFAULT_PIN_MIC_BCLK;
    PIN_MIC_WS   = DEFAULT_PIN_MIC_WS;
    PIN_MIC_DIN  = DEFAULT_PIN_MIC_DIN;

    PIN_SPK_BCLK    = DEFAULT_PIN_SPK_BCLK;
    PIN_SPK_LRCK    = DEFAULT_PIN_SPK_LRCK;
    PIN_SPK_DOUT    = DEFAULT_PIN_SPK_DOUT;
    PIN_SPK_SD_MODE = DEFAULT_PIN_SPK_SD_MODE;

    PIN_TOUCH_LEFT  = DEFAULT_PIN_TOUCH_LEFT;
    PIN_TOUCH_RIGHT = DEFAULT_PIN_TOUCH_RIGHT;
    PIN_TOUCH_SIDE  = DEFAULT_PIN_TOUCH_SIDE;

#ifdef ESP32
    Preferences prefs;
    if (prefs.begin("pins", false)) {
        prefs.clear();
        prefs.end();
    }
#endif
}

} // namespace petbot::hal::pins

// Direct global convenience references for backward compatibility
inline int& PIN_TFT_MOSI = petbot::hal::pins::PIN_TFT_MOSI;
inline int& PIN_TFT_SCLK = petbot::hal::pins::PIN_TFT_SCLK;
inline int& PIN_TFT_CS   = petbot::hal::pins::PIN_TFT_CS;
inline int& PIN_TFT_DC   = petbot::hal::pins::PIN_TFT_DC;
inline int& PIN_TFT_RST  = petbot::hal::pins::PIN_TFT_RST;
inline int& PIN_TFT_BL   = petbot::hal::pins::PIN_TFT_BL;

inline int& PIN_SD_CS    = petbot::hal::pins::PIN_SD_CS;
inline int& PIN_SD_MOSI  = petbot::hal::pins::PIN_SD_MOSI;
inline int& PIN_SD_MISO  = petbot::hal::pins::PIN_SD_MISO;
inline int& PIN_SD_SCLK  = petbot::hal::pins::PIN_SD_SCLK;

inline int& PIN_MIC_BCLK = petbot::hal::pins::PIN_MIC_BCLK;
inline int& PIN_MIC_WS   = petbot::hal::pins::PIN_MIC_WS;
inline int& PIN_MIC_DIN  = petbot::hal::pins::PIN_MIC_DIN;

inline int& PIN_SPK_BCLK    = petbot::hal::pins::PIN_SPK_BCLK;
inline int& PIN_SPK_LRCK    = petbot::hal::pins::PIN_SPK_LRCK;
inline int& PIN_SPK_DOUT    = petbot::hal::pins::PIN_SPK_DOUT;
inline int& PIN_SPK_SD_MODE = petbot::hal::pins::PIN_SPK_SD_MODE;

inline int& PIN_TOUCH_LEFT   = petbot::hal::pins::PIN_TOUCH_LEFT;
inline int& PIN_TOUCH_RIGHT  = petbot::hal::pins::PIN_TOUCH_RIGHT;
inline int& PIN_TOUCH_SIDE   = petbot::hal::pins::PIN_TOUCH_SIDE;
inline int& PIN_TOUCH_SENSOR = petbot::hal::pins::PIN_TOUCH_LEFT;

namespace petbot::firmware::hal {
    using namespace petbot::hal::pins;
}
