#pragma once

#include "petbot_widget_bytecode.h"
#include <cstdint>
#include <string_view>

namespace petbot::widget_schema {

enum class EmotionState : std::uint8_t {
    Neutral = 0,
    Happy = 1,
    Sad = 2,
    Angry = 3,
    Surprised = 4,
    Sleeping = 5,
    Processing = 6,
    Winking = 7,
    Confused = 8
};

enum class UrgencyLevel : std::uint8_t {
    Low = 0,
    Normal = 1,
    High = 2,
    Critical = 3
};

#pragma pack(push, 1)

/**
 * Eye rendering parameters for real-time procedural rendering on ESP32-S3.
 */
struct EyeRenderParams {
    EmotionState emotion;
    float eyelid_openness;  // 0.0f (closed) to 1.0f (fully open)
    float pupil_size;       // 0.1f to 2.0f
    float look_offset_x;    // -1.0f to +1.0f
    float look_offset_y;    // -1.0f to +1.0f
    std::uint16_t iris_color_rgb565;
    std::uint8_t  saccade_jitter; // Boolean (0 or 1)
};

/**
 * Compact binary status packet for battery HUD.
 */
struct BatteryGaugePacket {
    std::uint8_t  percentage;
    std::uint8_t  is_charging;
    std::uint16_t voltage_mv;
    std::uint16_t x;
    std::uint16_t y;
};

/**
 * Binary representation of procedural face widget state.
 */
struct EyeFacePacket {
    EyeRenderParams left_eye;
    EyeRenderParams right_eye;
    std::uint32_t   render_tick;
};

#pragma pack(pop)

static_assert(sizeof(BatteryGaugePacket) == 8, "BatteryGaugePacket must be exactly 8 bytes");

} // namespace petbot::widget_schema
