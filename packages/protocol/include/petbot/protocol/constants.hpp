#pragma once

#include <cstdint>
#include <cstddef>
#include <string_view>

namespace petbot::protocol::constants {

inline constexpr std::uint16_t DISPLAY_WIDTH = 160;
inline constexpr std::uint16_t DISPLAY_HEIGHT = 128;
inline constexpr std::uint8_t  DISPLAY_BPP = 16;
inline constexpr std::size_t   DISPLAY_BUFFER_BYTES = 40960;

inline constexpr std::uint32_t AUDIO_SAMPLE_RATE_HZ = 16000;
inline constexpr std::uint32_t AUDIO_FRAME_DURATION_MS = 20;
inline constexpr std::uint32_t AUDIO_SAMPLES_PER_FRAME = 320;
inline constexpr std::size_t   AUDIO_BYTES_PER_SAMPLE = 2;
inline constexpr std::size_t   AUDIO_CHANNELS = 1;
inline constexpr std::size_t   AUDIO_FRAME_BYTES = 640;

inline constexpr std::size_t   MAX_WS_PAYLOAD_BYTES = 65536;
inline constexpr std::size_t   SD_CHUNK_SIZE_BYTES = 16384;
inline constexpr std::size_t   OTA_CHUNK_SIZE_BYTES = 16384;
inline constexpr std::size_t   OTA_CHUNK_HEADER_SIZE = 12;
inline constexpr std::size_t   OTA_ACK_PAYLOAD_SIZE = 10;
inline constexpr std::size_t   BLE_MTU_SAFE_BYTES = 244;
inline constexpr std::uint16_t DEFAULT_WS_PORT = 8443;
inline constexpr std::string_view MDNS_SERVICE_NAME = "_petbot._tcp.local";

inline constexpr std::uint16_t FRAME_MAGIC = 0x4250;
inline constexpr std::uint8_t  FRAME_VERSION = 1;
inline constexpr std::size_t   FRAME_HEADER_SIZE = 12;
inline constexpr std::size_t   FRAME_TRAILER_SIZE = 4;
inline constexpr std::size_t   FRAME_OVERHEAD_SIZE = 16;

} // namespace petbot::protocol::constants
