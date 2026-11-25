/**
 * Hardware Abstraction Layer - Capacitive Touch Sensor & Gesture State Machine
 * 
 * Features:
 * - Hardware GPIO Interrupt on PIN_TOUCH_SENSOR (TTP223 Digital / ESP32 Touch)
 * - 200Hz software debounce filter (DEBOUNCE_MS = 20)
 * - Deterministic Gesture Recognition State Machine:
 *   - SINGLE_TAP: Press duration 25ms..350ms, followed by 240ms quiet window
 *   - DOUBLE_TAP: Two taps separated by < 240ms
 *   - LONG_PRESS: Continuous hold >= 650ms
 *   - PETTING_RAPID: >= 4 taps within 1400ms OR continuous rubbing pattern
 * - Instant Haptic-like Audio Cues (TICK for taps/press, PURR for petting)
 * - Thread-safe Central UI Event Queue & Callback Dispatcher
 * - Dedicated FreeRTOS Task (Task_TouchGesture, Priority 6, Core 1)
 */
#pragma once

#include <cstdint>
#include <cstddef>
#include <atomic>
#include <functional>

#include "hal/board_pins.h"
#include "hal/audio_hal.h"

#ifdef ESP32
#include <driver/gpio.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#endif

namespace petbot::hal {

// ============================================================================
// Gesture Timing Parameters
// ============================================================================
inline constexpr uint32_t TOUCH_DEBOUNCE_MS         = 20;   // 200Hz debounce filter (20ms)
inline constexpr uint32_t TOUCH_TAP_MIN_MS          = 25;   // Minimum tap duration
inline constexpr uint32_t TOUCH_TAP_MAX_MS          = 350;  // Maximum tap duration
inline constexpr uint32_t TOUCH_DOUBLE_TAP_GAP_MS   = 240;  // Quiet window / maximum double-tap gap
inline constexpr uint32_t TOUCH_LONG_PRESS_MS       = 650;  // Continuous hold threshold
inline constexpr uint32_t TOUCH_PETTING_WINDOW_MS   = 1400; // Rolling window for petting detection
inline constexpr uint8_t  TOUCH_PETTING_MIN_TAPS    = 4;    // Taps required within petting window
inline constexpr uint32_t TOUCH_SWIPE_MAX_GAP_MS    = 320;  // Max delta between Left & Right for directional swipe
inline constexpr uint32_t TOUCH_DUAL_CHORD_WINDOW_MS = 140; // Max delta to qualify as simultaneous dual tap

// ============================================================================
// Gesture Classifications (Single, Directional, and Dual-Touch Chords)
// ============================================================================
enum class TouchGesture : uint8_t {
    None             = 0,
    // Legacy single sensor aliases
    SingleTap        = 1,
    DoubleTap        = 2,
    LongPress        = 3,
    PettingRapid     = 4,

    // Left Head Sensor Gestures
    LeftTap          = 5,
    LeftDoubleTap    = 6,
    LeftLongPress    = 7,
    LeftPetting      = 8,

    // Right Head Sensor Gestures
    RightTap         = 9,
    RightDoubleTap   = 10,
    RightLongPress   = 11,
    RightPetting     = 12,

    // Spatial & Directional Swipes across Head
    SwipeLeftToRight = 13, // Left touched then Right touched within 50..320ms
    SwipeRightToLeft = 14, // Right touched then Left touched within 50..320ms

    // Dual-Touch Chords (Simultaneous Touch)
    DualTap          = 15, // Both touched simultaneously (< 350ms)
    DualLongPress    = 16, // Both touched simultaneously and held (>= 650ms)
    DualPetting      = 17, // Rapid alternating or mutual petting on both sides

    // Side Sensor Gestures (Right Flank / Grip on GPIO 3)
    SideTap          = 18,
    SideDoubleTap    = 19,
    SideLongPress    = 20,
    SidePetting      = 21,

    // Two-Point Multi-Sensor Chords & Swipes
    RightPinchTap       = 22, // Top-Right + Side-Right simultaneous tap (< 350ms)
    RightPinchLongPress = 23, // Top-Right + Side-Right held together (>= 650ms)
    CrossChordTap       = 24, // Top-Left + Side-Right simultaneous tap (< 350ms)
    CrossChordLongPress = 25, // Top-Left + Side-Right held together (>= 650ms)
    SwipeTopToSide      = 26, // Top-Right released then Side-Right touched within 50..320ms (downward swipe)
    SwipeSideToTop      = 27, // Side-Right released then Top-Right touched within 50..320ms (upward swipe)

    // Tri-Touch Gestures (All 3 Sensors on Left + Right + Side)
    TripleTap                  = 28, // All 3 touched simultaneously (Instant Emergency E-Stop)
    TripleLongPress            = 29, // All 3 held together (Hardware Diagnostics / SoftAP Reset)
    FullBodyGrooming           = 30, // Rapid petting across all 3 sensors
    TripleRollClockwise        = 31, // Top-Left -> Top-Right -> Side-Right circular gesture
    TripleRollCounterClockwise = 32, // Side-Right -> Top-Right -> Top-Left circular gesture

    // Uppercase Convenience Aliases
    SINGLE_TAP          = SingleTap,
    DOUBLE_TAP          = DoubleTap,
    LONG_PRESS          = LongPress,
    PETTING_RAPID       = PettingRapid,

    LEFT_TAP            = LeftTap,
    LEFT_DOUBLE_TAP     = LeftDoubleTap,
    LEFT_LONG_PRESS     = LeftLongPress,
    LEFT_PETTING        = LeftPetting,

    RIGHT_TAP           = RightTap,
    RIGHT_DOUBLE_TAP    = RightDoubleTap,
    RIGHT_LONG_PRESS    = RightLongPress,
    RIGHT_PETTING       = RightPetting,

    SIDE_TAP            = SideTap,
    SIDE_DOUBLE_TAP     = SideDoubleTap,
    SIDE_LONG_PRESS     = SideLongPress,
    SIDE_PETTING        = SidePetting,

    SWIPE_LEFT_TO_RIGHT = SwipeLeftToRight,
    SWIPE_RIGHT_TO_LEFT = SwipeRightToLeft,
    SWIPE_TOP_TO_SIDE   = SwipeTopToSide,
    SWIPE_SIDE_TO_TOP   = SwipeSideToTop,

    DUAL_TAP            = DualTap,
    DUAL_LONG_PRESS     = DualLongPress,
    DUAL_PETTING        = DualPetting,

    RIGHT_PINCH_TAP         = RightPinchTap,
    RIGHT_PINCH_LONG_PRESS  = RightPinchLongPress,
    CROSS_CHORD_TAP         = CrossChordTap,
    CROSS_CHORD_LONG_PRESS  = CrossChordLongPress,

    TRIPLE_TAP              = TripleTap,
    TRIPLE_LONG_PRESS       = TripleLongPress,
    FULL_BODY_GROOMING      = FullBodyGrooming,
    TRIPLE_ROLL_CW          = TripleRollClockwise,
    TRIPLE_ROLL_CCW         = TripleRollCounterClockwise
};

struct TouchGestureEvent {
    TouchGesture gesture{TouchGesture::None};
    uint32_t     timestampMs{0};
    uint16_t     durationMs{0};
    uint8_t      tapCount{0};
    bool         isLeft{false};
    bool         isRight{false};
    bool         isSide{false};
};

using TouchCallback = void (*)(const TouchGestureEvent&);

// Helper classification query utilities
inline constexpr bool isLeftGesture(TouchGesture g) noexcept {
    return (g == TouchGesture::LeftTap || g == TouchGesture::LeftDoubleTap ||
            g == TouchGesture::LeftLongPress || g == TouchGesture::LeftPetting ||
            g == TouchGesture::SwipeLeftToRight || g == TouchGesture::DualTap ||
            g == TouchGesture::DualLongPress || g == TouchGesture::DualPetting ||
            g == TouchGesture::CrossChordTap || g == TouchGesture::CrossChordLongPress ||
            g == TouchGesture::TripleTap || g == TouchGesture::TripleLongPress ||
            g == TouchGesture::FullBodyGrooming);
}

inline constexpr bool isRightGesture(TouchGesture g) noexcept {
    return (g == TouchGesture::RightTap || g == TouchGesture::RightDoubleTap ||
            g == TouchGesture::RightLongPress || g == TouchGesture::RightPetting ||
            g == TouchGesture::SwipeRightToLeft || g == TouchGesture::DualTap ||
            g == TouchGesture::DualLongPress || g == TouchGesture::DualPetting ||
            g == TouchGesture::RightPinchTap || g == TouchGesture::RightPinchLongPress ||
            g == TouchGesture::SwipeTopToSide || g == TouchGesture::SwipeSideToTop ||
            g == TouchGesture::TripleTap || g == TouchGesture::TripleLongPress ||
            g == TouchGesture::FullBodyGrooming);
}

inline constexpr bool isSideGesture(TouchGesture g) noexcept {
    return (g == TouchGesture::SideTap || g == TouchGesture::SideDoubleTap ||
            g == TouchGesture::SideLongPress || g == TouchGesture::SidePetting ||
            g == TouchGesture::RightPinchTap || g == TouchGesture::RightPinchLongPress ||
            g == TouchGesture::CrossChordTap || g == TouchGesture::CrossChordLongPress ||
            g == TouchGesture::SwipeTopToSide || g == TouchGesture::SwipeSideToTop ||
            g == TouchGesture::TripleTap || g == TouchGesture::TripleLongPress ||
            g == TouchGesture::FullBodyGrooming);
}

inline constexpr bool isSwipeGesture(TouchGesture g) noexcept {
    return (g == TouchGesture::SwipeLeftToRight || g == TouchGesture::SwipeRightToLeft ||
            g == TouchGesture::SwipeTopToSide || g == TouchGesture::SwipeSideToTop);
}

inline constexpr bool isDualGesture(TouchGesture g) noexcept {
    return (g == TouchGesture::DualTap || g == TouchGesture::DualLongPress ||
            g == TouchGesture::DualPetting || g == TouchGesture::RightPinchTap ||
            g == TouchGesture::RightPinchLongPress || g == TouchGesture::CrossChordTap ||
            g == TouchGesture::CrossChordLongPress);
}

inline constexpr bool isPinchGesture(TouchGesture g) noexcept {
    return (g == TouchGesture::RightPinchTap || g == TouchGesture::RightPinchLongPress ||
            g == TouchGesture::SwipeTopToSide || g == TouchGesture::SwipeSideToTop);
}

inline constexpr bool isTripleGesture(TouchGesture g) noexcept {
    return (g == TouchGesture::TripleTap || g == TouchGesture::TripleLongPress ||
            g == TouchGesture::FullBodyGrooming || g == TouchGesture::TripleRollClockwise ||
            g == TouchGesture::TripleRollCounterClockwise);
}

inline constexpr bool isPettingGesture(TouchGesture g) noexcept {
    return (g == TouchGesture::PettingRapid || g == TouchGesture::LeftPetting ||
            g == TouchGesture::RightPetting || g == TouchGesture::SidePetting ||
            g == TouchGesture::DualPetting || g == TouchGesture::FullBodyGrooming);
}

// ============================================================================
// Touch HAL Singleton Controller (Dual-Touch Engine)
// ============================================================================
class TouchHal {
public:
    static TouchHal& instance() noexcept;

    TouchHal(const TouchHal&) = delete;
    TouchHal& operator=(const TouchHal&) = delete;
    TouchHal(TouchHal&&) = delete;
    TouchHal& operator=(TouchHal&&) = delete;

    /**
     * Attach hardware GPIO interrupts to PIN_TOUCH_LEFT, PIN_TOUCH_RIGHT, and PIN_TOUCH_SIDE,
     * configure debouncing, create event queues, and spawn Task_TouchGesture.
     * @return true on successful initialization.
     */
    [[nodiscard]] bool init() noexcept;

    /**
     * Retrieve next gesture event from central UI Event Queue.
     * Non-blocking if timeoutMs is 0.
     * @param outEvent Reference to receive gesture event.
     * @param timeoutMs Timeout in milliseconds.
     * @return true if an event was dequeued.
     */
    bool getNextEvent(TouchGestureEvent& outEvent, uint32_t timeoutMs = 0) noexcept;

    /**
     * Register a callback listener for immediate gesture notifications.
     */
    void registerCallback(TouchCallback cb) noexcept;

    /**
     * Immediate raw sensor queries across all 3 sensors.
     */
    [[nodiscard]] bool isPressed() const noexcept {
        return isPressedLeftRaw_.load(std::memory_order_relaxed) ||
               isPressedRightRaw_.load(std::memory_order_relaxed) ||
               isPressedSideRaw_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] bool isPressedLeft() const noexcept {
        return isPressedLeftRaw_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] bool isPressedRight() const noexcept {
        return isPressedRightRaw_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] bool isPressedSide() const noexcept {
        return isPressedSideRaw_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] bool isBothPressed() const noexcept {
        return isPressedLeftRaw_.load(std::memory_order_relaxed) &&
               isPressedRightRaw_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] bool isRightPinchPressed() const noexcept {
        return isPressedRightRaw_.load(std::memory_order_relaxed) &&
               isPressedSideRaw_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] bool isTriplePressed() const noexcept {
        return isPressedLeftRaw_.load(std::memory_order_relaxed) &&
               isPressedRightRaw_.load(std::memory_order_relaxed) &&
               isPressedSideRaw_.load(std::memory_order_relaxed);
    }

    [[nodiscard]] uint32_t getCurrentHoldDurationMs(uint32_t nowMs) const noexcept;
    [[nodiscard]] TouchGesture getLastGesture() const noexcept { return lastGesture_; }

    /**
     * Deterministic State Machine evaluation step for all 3 sensors (called by task or host test harness).
     * @param nowMs Current monotonic millisecond timestamp.
     * @param rawPressedLeft State of left touch sensor pin (Left Ear).
     * @param rawPressedRight State of right touch sensor pin (Right Ear).
     * @param rawPressedSide State of side touch sensor pin (Right Flank).
     */
    void processStateMachine(uint32_t nowMs, bool rawPressedLeft, bool rawPressedRight, bool rawPressedSide) noexcept;

    /**
     * Backward-compatible dual-sensor overload.
     */
    void processStateMachine(uint32_t nowMs, bool rawPressedLeft, bool rawPressedRight) noexcept {
        processStateMachine(nowMs, rawPressedLeft, rawPressedRight, false);
    }

    /**
     * Backward-compatible overload for single-sensor tests.
     */
    void processStateMachine(uint32_t nowMs, bool rawPressed) noexcept {
        processStateMachine(nowMs, rawPressed, false, false);
    }

private:
    TouchHal() noexcept;
    ~TouchHal() noexcept;

    enum class SensorFsmState : uint8_t {
        Idle,
        Holding,
        LongPressTriggered,
        AwaitingSecondTap
    };

    struct RawEdge {
        uint32_t timestampMs;
        uint8_t  sensorId; // 0 = Left, 1 = Right, 2 = Side
        bool     pressed;
    };

    // ISR handlers
    static void IRAM_ATTR gpioIsrHandlerLeft(void* arg);
    static void IRAM_ATTR gpioIsrHandlerRight(void* arg);
    static void IRAM_ATTR gpioIsrHandlerSide(void* arg);

    // FreeRTOS task
    static void touchTask(void* param) noexcept;
    void runTouchEngine() noexcept;

    void emitGesture(
        TouchGesture gesture,
        uint32_t nowMs,
        uint16_t durationMs,
        uint8_t tapCount,
        bool isLeft = false,
        bool isRight = false,
        bool isSide = false
    ) noexcept;

    bool isInitialized_{false};
    std::atomic<bool> isPressedLeftRaw_{false};
    std::atomic<bool> isPressedRightRaw_{false};
    std::atomic<bool> isPressedSideRaw_{false};
    TouchGesture lastGesture_{TouchGesture::None};
    TouchCallback callback_{nullptr};

    // Tri-State Machine Internal Variables
    SensorFsmState leftFsmState_{SensorFsmState::Idle};
    SensorFsmState rightFsmState_{SensorFsmState::Idle};
    SensorFsmState sideFsmState_{SensorFsmState::Idle};

    uint32_t lastDebounceTimeLeftMs_{0};
    uint32_t lastDebounceTimeRightMs_{0};
    uint32_t lastDebounceTimeSideMs_{0};
    bool debouncedLeftPressed_{false};
    bool debouncedRightPressed_{false};
    bool debouncedSidePressed_{false};

    uint32_t pressStartTimeLeftMs_{0};
    uint32_t pressStartTimeRightMs_{0};
    uint32_t pressStartTimeSideMs_{0};
    uint32_t releaseTimeLeftMs_{0};
    uint32_t releaseTimeRightMs_{0};
    uint32_t releaseTimeSideMs_{0};
    uint16_t lastTapDurationLeftMs_{0};
    uint16_t lastTapDurationRightMs_{0};
    uint16_t lastTapDurationSideMs_{0};

    // Multi-Touch Chord & Long Press Tracking
    bool dualLongPressTriggered_{false};
    bool rightPinchLongPressTriggered_{false};
    bool crossChordLongPressTriggered_{false};
    bool tripleLongPressTriggered_{false};
    uint32_t lastSwipeLeftTriggerMs_{0};
    uint32_t lastSwipeRightTriggerMs_{0};
    uint32_t lastSwipeSideTriggerMs_{0};

    // Rolling tap history for Petting detection (circular buffers)
    static constexpr size_t TAP_HISTORY_SIZE = 16;
    uint32_t leftTapHistory_[TAP_HISTORY_SIZE]{0};
    size_t   leftTapHistoryCount_{0};
    uint32_t rightTapHistory_[TAP_HISTORY_SIZE]{0};
    size_t   rightTapHistoryCount_{0};
    uint32_t sideTapHistory_[TAP_HISTORY_SIZE]{0};
    size_t   sideTapHistoryCount_{0};

#ifdef ESP32
    QueueHandle_t rawEdgeQueue_{nullptr};
    QueueHandle_t eventQueue_{nullptr};
    TaskHandle_t  touchTaskHandle_{nullptr};
#endif
};

} // namespace petbot::hal
