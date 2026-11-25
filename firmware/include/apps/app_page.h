#pragma once

#include <cstdint>
#include <string_view>
#include "hal/psram_allocator.h"
#include "hal/touch_hal.h"

namespace petbot::firmware::apps {

using TouchGestureType = petbot::hal::TouchGesture;

/**
 * Interface for all UI Pages displayed in the 128x160 60FPS Carousel.
 * Both built-in firmware pages and dynamic PSRAM WidgetVM apps implement this interface.
 */
class IAppPage {
public:
    virtual ~IAppPage() = default;

    [[nodiscard]] virtual const char* getPageId() const noexcept = 0;
    [[nodiscard]] virtual const char* getPageTitle() const noexcept = 0;

    virtual void onEnter() {}
    virtual void onExit() {}

    virtual void onTouchGesture(TouchGestureType gesture) { (void)gesture; }
    virtual void handleTouch(const petbot::hal::TouchGestureEvent& evt) {
        onTouchGesture(evt.gesture);
    }

    virtual void update(uint32_t nowMs, float dt) = 0;
    virtual void update(uint32_t nowMs) {
        update(nowMs, 0.0166f);
    }

    virtual void render(petbot::hal::Canvas128x160& canvas) = 0;
};

} // namespace petbot::firmware::apps
