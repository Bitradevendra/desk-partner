#include "hal/touch_hal.h"
#include <Arduino.h>
#include <cmath>
#include <cstdlib>

namespace petbot::hal {

// ============================================================================
// Singleton Access
// ============================================================================
TouchHal& TouchHal::instance() noexcept {
    static TouchHal s_instance;
    return s_instance;
}

TouchHal::TouchHal() noexcept = default;

TouchHal::~TouchHal() noexcept {
#ifdef ESP32
    if (touchTaskHandle_) {
        vTaskDelete(touchTaskHandle_);
        touchTaskHandle_ = nullptr;
    }
    if (rawEdgeQueue_) {
        vQueueDelete(rawEdgeQueue_);
        rawEdgeQueue_ = nullptr;
    }
    if (eventQueue_) {
        vQueueDelete(eventQueue_);
        eventQueue_ = nullptr;
    }
    gpio_isr_handler_remove(static_cast<gpio_num_t>(petbot::hal::pins::PIN_TOUCH_LEFT));
    gpio_isr_handler_remove(static_cast<gpio_num_t>(petbot::hal::pins::PIN_TOUCH_RIGHT));
    if (petbot::hal::pins::PIN_TOUCH_SIDE >= 0) {
        gpio_isr_handler_remove(static_cast<gpio_num_t>(petbot::hal::pins::PIN_TOUCH_SIDE));
    }
#endif
}

// ============================================================================
// Hardware GPIO Interrupt Service Routines (Left, Right & Side Sensors)
// ============================================================================
#ifdef ESP32
void IRAM_ATTR TouchHal::gpioIsrHandlerLeft(void* arg) {
    auto* self = static_cast<TouchHal*>(arg);
    const int level = gpio_get_level(static_cast<gpio_num_t>(petbot::hal::pins::PIN_TOUCH_LEFT));
    const uint32_t nowMs = static_cast<uint32_t>(esp_timer_get_time() / 1000ULL);

    RawEdge edge{nowMs, 0, level != 0};
    self->isPressedLeftRaw_.store(edge.pressed, std::memory_order_relaxed);

    if (self->rawEdgeQueue_) {
        BaseType_t higherPriorityTaskWoken = pdFALSE;
        xQueueSendFromISR(self->rawEdgeQueue_, &edge, &higherPriorityTaskWoken);
        if (higherPriorityTaskWoken == pdTRUE) {
            portYIELD_FROM_ISR();
        }
    }
}

void IRAM_ATTR TouchHal::gpioIsrHandlerRight(void* arg) {
    auto* self = static_cast<TouchHal*>(arg);
    const int level = gpio_get_level(static_cast<gpio_num_t>(petbot::hal::pins::PIN_TOUCH_RIGHT));
    const uint32_t nowMs = static_cast<uint32_t>(esp_timer_get_time() / 1000ULL);

    RawEdge edge{nowMs, 1, level != 0};
    self->isPressedRightRaw_.store(edge.pressed, std::memory_order_relaxed);

    if (self->rawEdgeQueue_) {
        BaseType_t higherPriorityTaskWoken = pdFALSE;
        xQueueSendFromISR(self->rawEdgeQueue_, &edge, &higherPriorityTaskWoken);
        if (higherPriorityTaskWoken == pdTRUE) {
            portYIELD_FROM_ISR();
        }
    }
}

void IRAM_ATTR TouchHal::gpioIsrHandlerSide(void* arg) {
    auto* self = static_cast<TouchHal*>(arg);
    const int level = gpio_get_level(static_cast<gpio_num_t>(petbot::hal::pins::PIN_TOUCH_SIDE));
    const uint32_t nowMs = static_cast<uint32_t>(esp_timer_get_time() / 1000ULL);

    RawEdge edge{nowMs, 2, level != 0};
    self->isPressedSideRaw_.store(edge.pressed, std::memory_order_relaxed);

    if (self->rawEdgeQueue_) {
        BaseType_t higherPriorityTaskWoken = pdFALSE;
        xQueueSendFromISR(self->rawEdgeQueue_, &edge, &higherPriorityTaskWoken);
        if (higherPriorityTaskWoken == pdTRUE) {
            portYIELD_FROM_ISR();
        }
    }
}
#endif

// ============================================================================
// Hardware Initialization
// ============================================================================
bool TouchHal::init() noexcept {
    if (isInitialized_) return true;

#ifdef ESP32
    rawEdgeQueue_ = xQueueCreate(32, sizeof(RawEdge));
    eventQueue_   = xQueueCreate(16, sizeof(TouchGestureEvent));

    if (!rawEdgeQueue_ || !eventQueue_) {
        Serial.println("[TouchHal] ERROR: Failed to create FreeRTOS queues!");
        return false;
    }

    // 1. Configure Dual-Touch Sensor GPIOs: Left (GPIO 1) & Right (GPIO 2), Side optional (>= 0)
    gpio_config_t io_conf{};
    io_conf.intr_type = GPIO_INTR_ANYEDGE;
    io_conf.mode = GPIO_MODE_INPUT;
    uint64_t pinMask = (1ULL << petbot::hal::pins::PIN_TOUCH_LEFT) |
                       (1ULL << petbot::hal::pins::PIN_TOUCH_RIGHT);
    if (petbot::hal::pins::PIN_TOUCH_SIDE >= 0) {
        pinMask |= (1ULL << petbot::hal::pins::PIN_TOUCH_SIDE);
    }
    io_conf.pin_bit_mask = pinMask;
    io_conf.pull_down_en = GPIO_PULLDOWN_ENABLE;
    io_conf.pull_up_en   = GPIO_PULLUP_DISABLE;
    gpio_config(&io_conf);

    // 2. Ensure GPIO ISR service is installed, then attach Left, Right (and optional Side) interrupts
    const esp_err_t isrSvcErr = gpio_install_isr_service(0);
    if (isrSvcErr != ESP_OK && isrSvcErr != ESP_ERR_INVALID_STATE) {
        Serial.printf("[TouchHal] WARNING: gpio_install_isr_service returned 0x%x\n", isrSvcErr);
    }

    esp_err_t errLeft = gpio_isr_handler_add(
        static_cast<gpio_num_t>(petbot::hal::pins::PIN_TOUCH_LEFT),
        &TouchHal::gpioIsrHandlerLeft,
        this
    );
    esp_err_t errRight = gpio_isr_handler_add(
        static_cast<gpio_num_t>(petbot::hal::pins::PIN_TOUCH_RIGHT),
        &TouchHal::gpioIsrHandlerRight,
        this
    );
    esp_err_t errSide = ESP_OK;
    if (petbot::hal::pins::PIN_TOUCH_SIDE >= 0) {
        errSide = gpio_isr_handler_add(
            static_cast<gpio_num_t>(petbot::hal::pins::PIN_TOUCH_SIDE),
            &TouchHal::gpioIsrHandlerSide,
            this
        );
    }

    if (errLeft != ESP_OK || errRight != ESP_OK || errSide != ESP_OK) {
        Serial.printf("[TouchHal] ERROR: gpio_isr_handler_add failed (Left: 0x%x, Right: 0x%x, Side: 0x%x)\n",
                      errLeft, errRight, errSide);
        return false;
    }

    // Read initial raw pin levels
    const int initLeft  = gpio_get_level(static_cast<gpio_num_t>(petbot::hal::pins::PIN_TOUCH_LEFT));
    const int initRight = gpio_get_level(static_cast<gpio_num_t>(petbot::hal::pins::PIN_TOUCH_RIGHT));
    const int initSide  = (petbot::hal::pins::PIN_TOUCH_SIDE >= 0)
        ? gpio_get_level(static_cast<gpio_num_t>(petbot::hal::pins::PIN_TOUCH_SIDE))
        : 0;

    isPressedLeftRaw_.store(initLeft != 0, std::memory_order_relaxed);
    isPressedRightRaw_.store(initRight != 0, std::memory_order_relaxed);
    isPressedSideRaw_.store(initSide != 0, std::memory_order_relaxed);
    debouncedLeftPressed_  = (initLeft != 0);
    debouncedRightPressed_ = (initRight != 0);
    debouncedSidePressed_  = (initSide != 0);

    // 3. Spawn High-Priority Touch Engine Task on Core 1 (Interaction Core)
    BaseType_t ret = xTaskCreatePinnedToCore(
        &TouchHal::touchTask,
        "Task_TouchGesture",
        3072,
        this,
        6, // High priority 6
        &touchTaskHandle_,
        1  // Core 1 (Interaction Core)
    );

    if (ret != pdPASS) {
        Serial.println("[TouchHal] ERROR: Failed to spawn Task_TouchGesture!");
        return false;
    }
#endif

    isInitialized_ = true;
    Serial.printf("[TouchHal] Tri-Touch Sensors Active: Left=GPIO %d, Right=GPIO %d, Side=GPIO %d\n",
                  petbot::hal::pins::PIN_TOUCH_LEFT, petbot::hal::pins::PIN_TOUCH_RIGHT, petbot::hal::pins::PIN_TOUCH_SIDE);
    return true;
}

// ============================================================================
// Gesture Emission & Queueing
// ============================================================================
void TouchHal::emitGesture(
    TouchGesture gesture, 
    uint32_t nowMs, 
    uint16_t durationMs, 
    uint8_t tapCount,
    bool isLeft,
    bool isRight,
    bool isSide
) noexcept {
    lastGesture_ = gesture;

    TouchGestureEvent ev{};
    ev.gesture     = gesture;
    ev.timestampMs = nowMs;
    ev.durationMs  = durationMs;
    ev.tapCount    = tapCount;
    ev.isLeft      = isLeft;
    ev.isRight     = isRight;
    ev.isSide      = isSide;

#ifdef ESP32
    if (eventQueue_) {
        xQueueSend(eventQueue_, &ev, 0);
    }
#endif

    if (callback_) {
        callback_(ev);
    }

    const char* gestureName = "UNKNOWN";
    switch (gesture) {
        case TouchGesture::SingleTap:              gestureName = "SINGLE_TAP"; break;
        case TouchGesture::DoubleTap:              gestureName = "DOUBLE_TAP"; break;
        case TouchGesture::LongPress:              gestureName = "LONG_PRESS"; break;
        case TouchGesture::PettingRapid:           gestureName = "PETTING_RAPID"; break;
        case TouchGesture::LeftTap:                gestureName = "LEFT_TAP"; break;
        case TouchGesture::LeftDoubleTap:          gestureName = "LEFT_DOUBLE_TAP"; break;
        case TouchGesture::LeftLongPress:          gestureName = "LEFT_LONG_PRESS"; break;
        case TouchGesture::LeftPetting:            gestureName = "LEFT_PETTING"; break;
        case TouchGesture::RightTap:               gestureName = "RIGHT_TAP"; break;
        case TouchGesture::RightDoubleTap:         gestureName = "RIGHT_DOUBLE_TAP"; break;
        case TouchGesture::RightLongPress:         gestureName = "RIGHT_LONG_PRESS"; break;
        case TouchGesture::RightPetting:           gestureName = "RIGHT_PETTING"; break;
        case TouchGesture::SideTap:                gestureName = "SIDE_TAP"; break;
        case TouchGesture::SideDoubleTap:          gestureName = "SIDE_DOUBLE_TAP"; break;
        case TouchGesture::SideLongPress:          gestureName = "SIDE_LONG_PRESS"; break;
        case TouchGesture::SidePetting:            gestureName = "SIDE_PETTING"; break;
        case TouchGesture::SwipeLeftToRight:       gestureName = "SWIPE_LEFT_TO_RIGHT"; break;
        case TouchGesture::SwipeRightToLeft:       gestureName = "SWIPE_RIGHT_TO_LEFT"; break;
        case TouchGesture::SwipeTopToSide:         gestureName = "SWIPE_TOP_TO_SIDE"; break;
        case TouchGesture::SwipeSideToTop:         gestureName = "SWIPE_SIDE_TO_TOP"; break;
        case TouchGesture::DualTap:                gestureName = "DUAL_TAP"; break;
        case TouchGesture::DualLongPress:          gestureName = "DUAL_LONG_PRESS"; break;
        case TouchGesture::DualPetting:            gestureName = "DUAL_PETTING"; break;
        case TouchGesture::RightPinchTap:          gestureName = "RIGHT_PINCH_TAP"; break;
        case TouchGesture::RightPinchLongPress:    gestureName = "RIGHT_PINCH_LONG_PRESS"; break;
        case TouchGesture::CrossChordTap:          gestureName = "CROSS_CHORD_TAP"; break;
        case TouchGesture::CrossChordLongPress:    gestureName = "CROSS_CHORD_LONG_PRESS"; break;
        case TouchGesture::TripleTap:              gestureName = "TRIPLE_TAP"; break;
        case TouchGesture::TripleLongPress:        gestureName = "TRIPLE_LONG_PRESS"; break;
        case TouchGesture::FullBodyGrooming:       gestureName = "FULL_BODY_GROOMING"; break;
        case TouchGesture::TripleRollClockwise:    gestureName = "TRIPLE_ROLL_CW"; break;
        case TouchGesture::TripleRollCounterClockwise: gestureName = "TRIPLE_ROLL_CCW"; break;
        default: break;
    }
    Serial.printf("[TouchHal] Gesture: %s (Duration: %ums, Taps: %u, L:%d R:%d S:%d)\n", 
                  gestureName, durationMs, tapCount, isLeft ? 1 : 0, isRight ? 1 : 0, isSide ? 1 : 0);
}

// ============================================================================
// Deterministic Tri-Channel Gesture Recognition State Machine
// ============================================================================
void TouchHal::processStateMachine(uint32_t nowMs, bool rawPressedLeft, bool rawPressedRight, bool rawPressedSide) noexcept {
    // ------------------------------------------------------------------------
    // 1. Debounce Filter for Left Sensor (Left Ear - GPIO 1)
    // ------------------------------------------------------------------------
    if (rawPressedLeft != debouncedLeftPressed_) {
        if ((nowMs - lastDebounceTimeLeftMs_) >= TOUCH_DEBOUNCE_MS) {
            debouncedLeftPressed_ = rawPressedLeft;
            lastDebounceTimeLeftMs_ = nowMs;

            if (debouncedLeftPressed_) {
                pressStartTimeLeftMs_ = nowMs;
                leftFsmState_ = SensorFsmState::Holding;
            } else {
                releaseTimeLeftMs_ = nowMs;
                const uint32_t tapDuration = nowMs - pressStartTimeLeftMs_;
                lastTapDurationLeftMs_ = static_cast<uint16_t>(tapDuration);

                if (leftFsmState_ == SensorFsmState::LongPressTriggered) {
                    leftFsmState_ = SensorFsmState::Idle;
                    dualLongPressTriggered_ = false;
                    tripleLongPressTriggered_ = false;
                    crossChordLongPressTriggered_ = false;
                } else if (tapDuration >= TOUCH_TAP_MIN_MS && tapDuration <= TOUCH_TAP_MAX_MS) {
                    // Check Triple Tap: All 3 released together within chord window
                    if (releaseTimeRightMs_ > 0 && (nowMs - releaseTimeRightMs_) <= TOUCH_DUAL_CHORD_WINDOW_MS &&
                        releaseTimeSideMs_  > 0 && (nowMs - releaseTimeSideMs_)  <= TOUCH_DUAL_CHORD_WINDOW_MS) {
                        emitGesture(TouchGesture::TripleTap, nowMs, lastTapDurationLeftMs_, 1, true, true, true);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        releaseTimeRightMs_ = 0;
                        releaseTimeSideMs_  = 0;
                        leftFsmState_ = SensorFsmState::Idle;
                        rightFsmState_ = SensorFsmState::Idle;
                        sideFsmState_  = SensorFsmState::Idle;
                        return;
                    }

                    // Check Cross-Chord Tap (Left Ear + Right Side Flank)
                    if (releaseTimeSideMs_ > 0 && (nowMs - releaseTimeSideMs_) <= TOUCH_DUAL_CHORD_WINDOW_MS) {
                        emitGesture(TouchGesture::CrossChordTap, nowMs, lastTapDurationLeftMs_, 1, true, false, true);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        releaseTimeSideMs_ = 0;
                        leftFsmState_ = SensorFsmState::Idle;
                        sideFsmState_ = SensorFsmState::Idle;
                        return;
                    }

                    // Check Directional Swipe: Right was released recently within swipe window
                    if (releaseTimeRightMs_ > 0 && (nowMs - releaseTimeRightMs_) <= TOUCH_SWIPE_MAX_GAP_MS) {
                        // Check if Side was also touched before Right -> Triple Roll Counter-Clockwise (Side -> Right -> Left)
                        if (lastSwipeSideTriggerMs_ > 0 && (nowMs - lastSwipeSideTriggerMs_) <= (TOUCH_SWIPE_MAX_GAP_MS * 2)) {
                            emitGesture(TouchGesture::TripleRollCounterClockwise, nowMs, lastTapDurationLeftMs_, 1, true, true, true);
                            AudioHal::instance().playProceduralSound(SoundId::Chirp);
                            lastSwipeSideTriggerMs_ = 0;
                        } else {
                            emitGesture(TouchGesture::SwipeRightToLeft, nowMs, lastTapDurationLeftMs_, 1, true, true, false);
                            AudioHal::instance().playProceduralSound(SoundId::Tick);
                        }
                        releaseTimeRightMs_ = 0;
                        leftFsmState_ = SensorFsmState::Idle;
                        rightFsmState_ = SensorFsmState::Idle;
                        return;
                    }

                    // Check Simultaneous Dual Tap (Left + Right released close together)
                    if (releaseTimeRightMs_ > 0 && (nowMs - releaseTimeRightMs_) <= TOUCH_DUAL_CHORD_WINDOW_MS) {
                        emitGesture(TouchGesture::DualTap, nowMs, lastTapDurationLeftMs_, 1, true, true, false);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        releaseTimeRightMs_ = 0;
                        leftFsmState_ = SensorFsmState::Idle;
                        rightFsmState_ = SensorFsmState::Idle;
                        return;
                    }

                    // Record in Left tap history
                    leftTapHistory_[leftTapHistoryCount_ % TAP_HISTORY_SIZE] = nowMs;
                    leftTapHistoryCount_++;

                    // Check Petting
                    uint8_t recentLeftTaps = 0;
                    for (size_t i = 0; i < TAP_HISTORY_SIZE && i < leftTapHistoryCount_; ++i) {
                        const uint32_t t = leftTapHistory_[(leftTapHistoryCount_ - 1 - i) % TAP_HISTORY_SIZE];
                        if (nowMs >= t && (nowMs - t) <= TOUCH_PETTING_WINDOW_MS) {
                            recentLeftTaps++;
                        }
                    }

                    if (recentLeftTaps >= TOUCH_PETTING_MIN_TAPS) {
                        emitGesture(TouchGesture::LeftPetting, nowMs, lastTapDurationLeftMs_, recentLeftTaps, true, false, false);
                        AudioHal::instance().playProceduralSound(SoundId::Purr);
                        leftTapHistoryCount_ = 0;
                        leftFsmState_ = SensorFsmState::Idle;
                        return;
                    }

                    // Check Double Tap
                    if (recentLeftTaps >= 2) {
                        emitGesture(TouchGesture::LeftDoubleTap, nowMs, lastTapDurationLeftMs_, 2, true, false, false);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        leftFsmState_ = SensorFsmState::Idle;
                        return;
                    }

                    leftFsmState_ = SensorFsmState::AwaitingSecondTap;
                } else {
                    leftFsmState_ = SensorFsmState::Idle;
                }
            }
        }
    }

    // ------------------------------------------------------------------------
    // 2. Debounce Filter for Right Sensor (Right Ear - GPIO 2)
    // ------------------------------------------------------------------------
    if (rawPressedRight != debouncedRightPressed_) {
        if ((nowMs - lastDebounceTimeRightMs_) >= TOUCH_DEBOUNCE_MS) {
            debouncedRightPressed_ = rawPressedRight;
            lastDebounceTimeRightMs_ = nowMs;

            if (debouncedRightPressed_) {
                pressStartTimeRightMs_ = nowMs;
                rightFsmState_ = SensorFsmState::Holding;
            } else {
                releaseTimeRightMs_ = nowMs;
                const uint32_t tapDuration = nowMs - pressStartTimeRightMs_;
                lastTapDurationRightMs_ = static_cast<uint16_t>(tapDuration);

                if (rightFsmState_ == SensorFsmState::LongPressTriggered) {
                    rightFsmState_ = SensorFsmState::Idle;
                    dualLongPressTriggered_ = false;
                    tripleLongPressTriggered_ = false;
                    rightPinchLongPressTriggered_ = false;
                } else if (tapDuration >= TOUCH_TAP_MIN_MS && tapDuration <= TOUCH_TAP_MAX_MS) {
                    // Check Triple Tap
                    if (releaseTimeLeftMs_ > 0 && (nowMs - releaseTimeLeftMs_) <= TOUCH_DUAL_CHORD_WINDOW_MS &&
                        releaseTimeSideMs_ > 0 && (nowMs - releaseTimeSideMs_) <= TOUCH_DUAL_CHORD_WINDOW_MS) {
                        emitGesture(TouchGesture::TripleTap, nowMs, lastTapDurationRightMs_, 1, true, true, true);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        releaseTimeLeftMs_ = 0;
                        releaseTimeSideMs_ = 0;
                        leftFsmState_  = SensorFsmState::Idle;
                        rightFsmState_ = SensorFsmState::Idle;
                        sideFsmState_  = SensorFsmState::Idle;
                        return;
                    }

                    // Check Right Pinch Tap (Right Ear + Right Side Flank)
                    if (releaseTimeSideMs_ > 0 && (nowMs - releaseTimeSideMs_) <= TOUCH_DUAL_CHORD_WINDOW_MS) {
                        emitGesture(TouchGesture::RightPinchTap, nowMs, lastTapDurationRightMs_, 1, false, true, true);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        releaseTimeSideMs_ = 0;
                        rightFsmState_ = SensorFsmState::Idle;
                        sideFsmState_  = SensorFsmState::Idle;
                        return;
                    }

                    // Check Directional Swipe (Side was released recently -> Swipe Upwards Side to Top)
                    if (releaseTimeSideMs_ > 0 && (nowMs - releaseTimeSideMs_) <= TOUCH_SWIPE_MAX_GAP_MS) {
                        emitGesture(TouchGesture::SwipeSideToTop, nowMs, lastTapDurationRightMs_, 1, false, true, true);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        releaseTimeSideMs_ = 0;
                        rightFsmState_ = SensorFsmState::Idle;
                        sideFsmState_  = SensorFsmState::Idle;
                        return;
                    }

                    // Check Directional Swipe (Left was released recently -> Swipe Left to Right across Head)
                    if (releaseTimeLeftMs_ > 0 && (nowMs - releaseTimeLeftMs_) <= TOUCH_SWIPE_MAX_GAP_MS) {
                        lastSwipeRightTriggerMs_ = nowMs;
                        emitGesture(TouchGesture::SwipeLeftToRight, nowMs, lastTapDurationRightMs_, 1, true, true, false);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        releaseTimeLeftMs_ = 0;
                        leftFsmState_  = SensorFsmState::Idle;
                        rightFsmState_ = SensorFsmState::Idle;
                        return;
                    }

                    // Check Simultaneous Dual Tap (Both ears released close together)
                    if (releaseTimeLeftMs_ > 0 && (nowMs - releaseTimeLeftMs_) <= TOUCH_DUAL_CHORD_WINDOW_MS) {
                        emitGesture(TouchGesture::DualTap, nowMs, lastTapDurationRightMs_, 1, true, true, false);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        releaseTimeLeftMs_ = 0;
                        leftFsmState_  = SensorFsmState::Idle;
                        rightFsmState_ = SensorFsmState::Idle;
                        return;
                    }

                    // Record in Right tap history
                    rightTapHistory_[rightTapHistoryCount_ % TAP_HISTORY_SIZE] = nowMs;
                    rightTapHistoryCount_++;

                    // Check Petting
                    uint8_t recentRightTaps = 0;
                    for (size_t i = 0; i < TAP_HISTORY_SIZE && i < rightTapHistoryCount_; ++i) {
                        const uint32_t t = rightTapHistory_[(rightTapHistoryCount_ - 1 - i) % TAP_HISTORY_SIZE];
                        if (nowMs >= t && (nowMs - t) <= TOUCH_PETTING_WINDOW_MS) {
                            recentRightTaps++;
                        }
                    }

                    if (recentRightTaps >= TOUCH_PETTING_MIN_TAPS) {
                        emitGesture(TouchGesture::RightPetting, nowMs, lastTapDurationRightMs_, recentRightTaps, false, true, false);
                        AudioHal::instance().playProceduralSound(SoundId::Purr);
                        rightTapHistoryCount_ = 0;
                        rightFsmState_ = SensorFsmState::Idle;
                        return;
                    }

                    // Check Double Tap
                    if (recentRightTaps >= 2) {
                        emitGesture(TouchGesture::RightDoubleTap, nowMs, lastTapDurationRightMs_, 2, false, true, false);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        rightFsmState_ = SensorFsmState::Idle;
                        return;
                    }

                    rightFsmState_ = SensorFsmState::AwaitingSecondTap;
                } else {
                    rightFsmState_ = SensorFsmState::Idle;
                }
            }
        }
    }

    // ------------------------------------------------------------------------
    // 3. Debounce Filter for Side Sensor (Right Flank / Grip - GPIO 3)
    // ------------------------------------------------------------------------
    if (rawPressedSide != debouncedSidePressed_) {
        if ((nowMs - lastDebounceTimeSideMs_) >= TOUCH_DEBOUNCE_MS) {
            debouncedSidePressed_ = rawPressedSide;
            lastDebounceTimeSideMs_ = nowMs;

            if (debouncedSidePressed_) {
                pressStartTimeSideMs_ = nowMs;
                sideFsmState_ = SensorFsmState::Holding;
            } else {
                releaseTimeSideMs_ = nowMs;
                const uint32_t tapDuration = nowMs - pressStartTimeSideMs_;
                lastTapDurationSideMs_ = static_cast<uint16_t>(tapDuration);

                if (sideFsmState_ == SensorFsmState::LongPressTriggered) {
                    sideFsmState_ = SensorFsmState::Idle;
                    tripleLongPressTriggered_ = false;
                    rightPinchLongPressTriggered_ = false;
                    crossChordLongPressTriggered_ = false;
                } else if (tapDuration >= TOUCH_TAP_MIN_MS && tapDuration <= TOUCH_TAP_MAX_MS) {
                    // Check Triple Tap
                    if (releaseTimeLeftMs_  > 0 && (nowMs - releaseTimeLeftMs_)  <= TOUCH_DUAL_CHORD_WINDOW_MS &&
                        releaseTimeRightMs_ > 0 && (nowMs - releaseTimeRightMs_) <= TOUCH_DUAL_CHORD_WINDOW_MS) {
                        emitGesture(TouchGesture::TripleTap, nowMs, lastTapDurationSideMs_, 1, true, true, true);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        releaseTimeLeftMs_  = 0;
                        releaseTimeRightMs_ = 0;
                        leftFsmState_  = SensorFsmState::Idle;
                        rightFsmState_ = SensorFsmState::Idle;
                        sideFsmState_  = SensorFsmState::Idle;
                        return;
                    }

                    // Check Right Pinch Tap
                    if (releaseTimeRightMs_ > 0 && (nowMs - releaseTimeRightMs_) <= TOUCH_DUAL_CHORD_WINDOW_MS) {
                        emitGesture(TouchGesture::RightPinchTap, nowMs, lastTapDurationSideMs_, 1, false, true, true);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        releaseTimeRightMs_ = 0;
                        rightFsmState_ = SensorFsmState::Idle;
                        sideFsmState_  = SensorFsmState::Idle;
                        return;
                    }

                    // Check Cross-Chord Tap (Left Ear + Side)
                    if (releaseTimeLeftMs_ > 0 && (nowMs - releaseTimeLeftMs_) <= TOUCH_DUAL_CHORD_WINDOW_MS) {
                        emitGesture(TouchGesture::CrossChordTap, nowMs, lastTapDurationSideMs_, 1, true, false, true);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        releaseTimeLeftMs_ = 0;
                        leftFsmState_ = SensorFsmState::Idle;
                        sideFsmState_ = SensorFsmState::Idle;
                        return;
                    }

                    // Check Directional Swipe (Top-Right released recently -> Swipe Downward Top to Side)
                    if (releaseTimeRightMs_ > 0 && (nowMs - releaseTimeRightMs_) <= TOUCH_SWIPE_MAX_GAP_MS) {
                        // Check if Left was touched prior -> Triple Roll Clockwise (Left -> Right -> Side)
                        if (lastSwipeRightTriggerMs_ > 0 && (nowMs - lastSwipeRightTriggerMs_) <= (TOUCH_SWIPE_MAX_GAP_MS * 2)) {
                            emitGesture(TouchGesture::TripleRollClockwise, nowMs, lastTapDurationSideMs_, 1, true, true, true);
                            AudioHal::instance().playProceduralSound(SoundId::Chirp);
                            lastSwipeRightTriggerMs_ = 0;
                        } else {
                            emitGesture(TouchGesture::SwipeTopToSide, nowMs, lastTapDurationSideMs_, 1, false, true, true);
                            AudioHal::instance().playProceduralSound(SoundId::Tick);
                        }
                        releaseTimeRightMs_ = 0;
                        rightFsmState_ = SensorFsmState::Idle;
                        sideFsmState_  = SensorFsmState::Idle;
                        return;
                    }

                    lastSwipeSideTriggerMs_ = nowMs;

                    // Record in Side tap history
                    sideTapHistory_[sideTapHistoryCount_ % TAP_HISTORY_SIZE] = nowMs;
                    sideTapHistoryCount_++;

                    // Check Petting
                    uint8_t recentSideTaps = 0;
                    for (size_t i = 0; i < TAP_HISTORY_SIZE && i < sideTapHistoryCount_; ++i) {
                        const uint32_t t = sideTapHistory_[(sideTapHistoryCount_ - 1 - i) % TAP_HISTORY_SIZE];
                        if (nowMs >= t && (nowMs - t) <= TOUCH_PETTING_WINDOW_MS) {
                            recentSideTaps++;
                        }
                    }

                    if (recentSideTaps >= TOUCH_PETTING_MIN_TAPS) {
                        emitGesture(TouchGesture::SidePetting, nowMs, lastTapDurationSideMs_, recentSideTaps, false, false, true);
                        AudioHal::instance().playProceduralSound(SoundId::Purr);
                        sideTapHistoryCount_ = 0;
                        sideFsmState_ = SensorFsmState::Idle;
                        return;
                    }

                    // Check Double Tap
                    if (recentSideTaps >= 2) {
                        emitGesture(TouchGesture::SideDoubleTap, nowMs, lastTapDurationSideMs_, 2, false, false, true);
                        AudioHal::instance().playProceduralSound(SoundId::Tick);
                        sideFsmState_ = SensorFsmState::Idle;
                        return;
                    }

                    sideFsmState_ = SensorFsmState::AwaitingSecondTap;
                } else {
                    sideFsmState_ = SensorFsmState::Idle;
                }
            }
        }
    }

    // ------------------------------------------------------------------------
    // 4. Multi-Sensor Simultaneous Long-Press Detections (>= 650ms)
    // ------------------------------------------------------------------------
    // A. Triple Long-Press Hold Detection (All 3 held simultaneously)
    if (debouncedLeftPressed_ && debouncedRightPressed_ && debouncedSidePressed_ && !tripleLongPressTriggered_) {
        const uint32_t leftHold  = nowMs - pressStartTimeLeftMs_;
        const uint32_t rightHold = nowMs - pressStartTimeRightMs_;
        const uint32_t sideHold  = nowMs - pressStartTimeSideMs_;
        if (leftHold >= TOUCH_LONG_PRESS_MS && rightHold >= TOUCH_LONG_PRESS_MS && sideHold >= TOUCH_LONG_PRESS_MS) {
            tripleLongPressTriggered_ = true;
            leftFsmState_  = SensorFsmState::LongPressTriggered;
            rightFsmState_ = SensorFsmState::LongPressTriggered;
            sideFsmState_  = SensorFsmState::LongPressTriggered;
            emitGesture(TouchGesture::TripleLongPress, nowMs, static_cast<uint16_t>(leftHold), 1, true, true, true);
            AudioHal::instance().playProceduralSound(SoundId::Chirp);
            return;
        }
    }

    // B. Dual Long-Press Hold Detection (Both ears held simultaneously)
    if (debouncedLeftPressed_ && debouncedRightPressed_ && !debouncedSidePressed_ && !dualLongPressTriggered_) {
        const uint32_t leftHold  = nowMs - pressStartTimeLeftMs_;
        const uint32_t rightHold = nowMs - pressStartTimeRightMs_;
        if (leftHold >= TOUCH_LONG_PRESS_MS && rightHold >= TOUCH_LONG_PRESS_MS) {
            dualLongPressTriggered_ = true;
            leftFsmState_  = SensorFsmState::LongPressTriggered;
            rightFsmState_ = SensorFsmState::LongPressTriggered;
            emitGesture(TouchGesture::DualLongPress, nowMs, static_cast<uint16_t>(leftHold), 1, true, true, false);
            AudioHal::instance().playProceduralSound(SoundId::Purr);
            return;
        }
    }

    // C. Right Pinch Long-Press (Right Ear + Right Side Flank held together)
    if (debouncedRightPressed_ && debouncedSidePressed_ && !debouncedLeftPressed_ && !rightPinchLongPressTriggered_) {
        const uint32_t rightHold = nowMs - pressStartTimeRightMs_;
        const uint32_t sideHold  = nowMs - pressStartTimeSideMs_;
        if (rightHold >= TOUCH_LONG_PRESS_MS && sideHold >= TOUCH_LONG_PRESS_MS) {
            rightPinchLongPressTriggered_ = true;
            rightFsmState_ = SensorFsmState::LongPressTriggered;
            sideFsmState_  = SensorFsmState::LongPressTriggered;
            emitGesture(TouchGesture::RightPinchLongPress, nowMs, static_cast<uint16_t>(rightHold), 1, false, true, true);
            AudioHal::instance().playProceduralSound(SoundId::Tick);
            return;
        }
    }

    // D. Cross-Chord Long-Press (Left Ear + Right Side Flank held together)
    if (debouncedLeftPressed_ && debouncedSidePressed_ && !debouncedRightPressed_ && !crossChordLongPressTriggered_) {
        const uint32_t leftHold = nowMs - pressStartTimeLeftMs_;
        const uint32_t sideHold = nowMs - pressStartTimeSideMs_;
        if (leftHold >= TOUCH_LONG_PRESS_MS && sideHold >= TOUCH_LONG_PRESS_MS) {
            crossChordLongPressTriggered_ = true;
            leftFsmState_ = SensorFsmState::LongPressTriggered;
            sideFsmState_ = SensorFsmState::LongPressTriggered;
            emitGesture(TouchGesture::CrossChordLongPress, nowMs, static_cast<uint16_t>(leftHold), 1, true, false, true);
            AudioHal::instance().playProceduralSound(SoundId::Tick);
            return;
        }
    }

    // ------------------------------------------------------------------------
    // 5. Single Long-Press Hold Detections
    // ------------------------------------------------------------------------
    if (debouncedLeftPressed_ && !debouncedRightPressed_ && !debouncedSidePressed_ && leftFsmState_ == SensorFsmState::Holding) {
        const uint32_t holdDuration = nowMs - pressStartTimeLeftMs_;
        if (holdDuration >= TOUCH_LONG_PRESS_MS) {
            leftFsmState_ = SensorFsmState::LongPressTriggered;
            emitGesture(TouchGesture::LeftLongPress, nowMs, static_cast<uint16_t>(holdDuration), 1, true, false, false);
            AudioHal::instance().playProceduralSound(SoundId::Tick);
        }
    }

    if (debouncedRightPressed_ && !debouncedLeftPressed_ && !debouncedSidePressed_ && rightFsmState_ == SensorFsmState::Holding) {
        const uint32_t holdDuration = nowMs - pressStartTimeRightMs_;
        if (holdDuration >= TOUCH_LONG_PRESS_MS) {
            rightFsmState_ = SensorFsmState::LongPressTriggered;
            emitGesture(TouchGesture::RightLongPress, nowMs, static_cast<uint16_t>(holdDuration), 1, false, true, false);
            AudioHal::instance().playProceduralSound(SoundId::Tick);
        }
    }

    if (debouncedSidePressed_ && !debouncedLeftPressed_ && !debouncedRightPressed_ && sideFsmState_ == SensorFsmState::Holding) {
        const uint32_t holdDuration = nowMs - pressStartTimeSideMs_;
        if (holdDuration >= TOUCH_LONG_PRESS_MS) {
            sideFsmState_ = SensorFsmState::LongPressTriggered;
            emitGesture(TouchGesture::SideLongPress, nowMs, static_cast<uint16_t>(holdDuration), 1, false, false, true);
            AudioHal::instance().playProceduralSound(SoundId::Tick);
        }
    }

    // ------------------------------------------------------------------------
    // 6. Quiet Window Expiries for Single Taps
    // ------------------------------------------------------------------------
    if (!debouncedLeftPressed_ && leftFsmState_ == SensorFsmState::AwaitingSecondTap) {
        if ((nowMs - releaseTimeLeftMs_) >= TOUCH_DOUBLE_TAP_GAP_MS) {
            emitGesture(TouchGesture::LeftTap, nowMs, lastTapDurationLeftMs_, 1, true, false, false);
            AudioHal::instance().playProceduralSound(SoundId::Tick);
            leftFsmState_ = SensorFsmState::Idle;
        }
    }

    if (!debouncedRightPressed_ && rightFsmState_ == SensorFsmState::AwaitingSecondTap) {
        if ((nowMs - releaseTimeRightMs_) >= TOUCH_DOUBLE_TAP_GAP_MS) {
            emitGesture(TouchGesture::RightTap, nowMs, lastTapDurationRightMs_, 1, false, true, false);
            AudioHal::instance().playProceduralSound(SoundId::Tick);
            rightFsmState_ = SensorFsmState::Idle;
        }
    }

    if (!debouncedSidePressed_ && sideFsmState_ == SensorFsmState::AwaitingSecondTap) {
        if ((nowMs - releaseTimeSideMs_) >= TOUCH_DOUBLE_TAP_GAP_MS) {
            emitGesture(TouchGesture::SideTap, nowMs, lastTapDurationSideMs_, 1, false, false, true);
            AudioHal::instance().playProceduralSound(SoundId::Tick);
            sideFsmState_ = SensorFsmState::Idle;
        }
    }
}

// ============================================================================
// FreeRTOS Background Touch Task
// ============================================================================
void TouchHal::touchTask(void* param) noexcept {
    auto* self = static_cast<TouchHal*>(param);
    self->runTouchEngine();
}

void TouchHal::runTouchEngine() noexcept {
#ifdef ESP32
    while (true) {
        RawEdge edge{};
        if (xQueueReceive(rawEdgeQueue_, &edge, pdMS_TO_TICKS(5)) == pdTRUE) {
            if (edge.sensorId == 0) {
                isPressedLeftRaw_.store(edge.pressed, std::memory_order_relaxed);
            } else if (edge.sensorId == 1) {
                isPressedRightRaw_.store(edge.pressed, std::memory_order_relaxed);
            } else if (edge.sensorId == 2) {
                isPressedSideRaw_.store(edge.pressed, std::memory_order_relaxed);
            }
        }

        const uint32_t nowMs = static_cast<uint32_t>(esp_timer_get_time() / 1000ULL);
        const bool pressedL = isPressedLeftRaw_.load(std::memory_order_relaxed);
        const bool pressedR = isPressedRightRaw_.load(std::memory_order_relaxed);
        const bool pressedS = (petbot::hal::pins::PIN_TOUCH_SIDE >= 0)
            ? isPressedSideRaw_.load(std::memory_order_relaxed)
            : false;
        processStateMachine(nowMs, pressedL, pressedR, pressedS);
    }
#endif
}

// ============================================================================
// Public Queries & Event Retrieval
// ============================================================================
bool TouchHal::getNextEvent(TouchGestureEvent& outEvent, uint32_t timeoutMs) noexcept {
#ifdef ESP32
    if (!eventQueue_) return false;
    return (xQueueReceive(eventQueue_, &outEvent, pdMS_TO_TICKS(timeoutMs)) == pdTRUE);
#else
    (void)timeoutMs;
    if (lastGesture_ != TouchGesture::None) {
        outEvent.gesture = lastGesture_;
        lastGesture_ = TouchGesture::None;
        return true;
    }
    return false;
#endif
}

void TouchHal::registerCallback(TouchCallback cb) noexcept {
    callback_ = cb;
}

uint32_t TouchHal::getCurrentHoldDurationMs(uint32_t nowMs) const noexcept {
    if (debouncedLeftPressed_) {
        return (nowMs >= pressStartTimeLeftMs_) ? (nowMs - pressStartTimeLeftMs_) : 0;
    }
    if (debouncedRightPressed_) {
        return (nowMs >= pressStartTimeRightMs_) ? (nowMs - pressStartTimeRightMs_) : 0;
    }
    if (debouncedSidePressed_) {
        return (nowMs >= pressStartTimeSideMs_) ? (nowMs - pressStartTimeSideMs_) : 0;
    }
    return 0;
}

} // namespace petbot::hal
