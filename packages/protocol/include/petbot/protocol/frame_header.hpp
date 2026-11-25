#pragma once

#include "constants.hpp"
#include "../../petbot_protocol.h"
#include <cstddef>
#include <cstdint>
#if defined(__has_include) && __has_include(<span>) && __cplusplus >= 202002L
#include <span>
#endif

namespace petbot::protocol {

struct DecodedBinaryFrame {
    const PetBotFrameHeader& header;
#if defined(__cpp_lib_span) && __cpp_lib_span >= 202002L
    std::span<const uint8_t> payload;
#else
    struct ByteSpan {
        const uint8_t* ptr{nullptr};
        std::size_t len{0};
        constexpr const uint8_t* data() const noexcept { return ptr; }
        constexpr std::size_t size() const noexcept { return len; }
    } payload;
#endif
    uint32_t crc32;
};

} // namespace petbot::protocol
