/**
 * UI Subsystem - Multi-Page App Carousel & UI Orchestration Engine
 * 
 * Features:
 * - Manages built-in IAppPage instances plus extensible dynamic WidgetVM slots
 * - Smooth 200ms horizontal eased slide transitions (cubicOut)
 * - Composes both outgoing and incoming pages onto 128x160 PSRAM canvas during transitions
 * - Subtle auto-hiding top HUD toast for page switches, habit streaks, and Pomodoro alarms
 * - Subtle top page-indicator pill bar (2px high at y = 3)
 * - Optional live FPS, microsecond frame time, SRAM, and Octal PSRAM telemetry overlay
 * - Thread-safe operations across Core 0 and Core 1
 * - Zero dynamic heap allocations in 60FPS render loop
 */
#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>
#include <memory>

#include "petbot_protocol.h"
#include "apps/app_page.h"
#include "hal/psram_allocator.h"
#include "hal/touch_hal.h"
#include "ui/expression_engine.h"

#ifdef ESP32
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#endif

namespace petbot::firmware::ui {

using petbot::protocol::RobotMode;
using petbot::firmware::apps::IAppPage;
using petbot::hal::Canvas128x160;
using petbot::hal::TouchGestureEvent;

/**
 * Toast Notification State
 */
struct ToastNotification {
    char message[64]{0};
    uint32_t showTimestampMs{0};
    uint32_t durationMs{2500};
    bool active{false};
    float opacity{0.0f}; // 0.0 to 1.0 for smooth alpha blending
};

/**
 * Slide Transition Animation State
 */
struct SlideTransition {
    bool active{false};
    uint32_t startMs{0};
    uint32_t durationMs{200}; // Exact 200ms transition duration
    size_t fromIdx{0};
    size_t toIdx{0};
    int8_t direction{1};      // +1 = slide left (next), -1 = slide right (prev)
};

/**
 * Cubic Out Easing Function: f(t) = 1 - (1 - t)^3
 */
inline float easeCubicOut(float t) noexcept {
    const float f = 1.0f - std::clamp(t, 0.0f, 1.0f);
    return 1.0f - (f * f * f);
}

/**
 * Thread-safe UI Manager coordinating Core 1 60FPS UI rendering with Core 0 notifications
 * and 128x160 multi-page app carousel.
 */
class UIManager {
public:
    static UIManager& instance() {
        static UIManager s_instance;
        return s_instance;
    }

    UIManager(const UIManager&) = delete;
    UIManager& operator=(const UIManager&) = delete;

    void init();

    /**
     * Display a sleek popup toast notification. Thread-safe across cores.
     */
    void showToast(const char* message, uint32_t durationMs = 2500);
    void showToast(const std::string& message, uint32_t durationMs = 2500) {
        showToast(message.c_str(), durationMs);
    }

    /**
     * Check if a toast is currently active and get its contents.
     */
    bool getActiveToast(char* outBuffer, size_t maxLen, float* outOpacity = nullptr);

    /**
     * Update current robot mode (reflected in UI HUD).
     */
    void setRobotMode(RobotMode mode);
    [[nodiscard]] RobotMode getRobotMode() const;

    // --- Page Carousel & Navigation ---
    /**
     * Register a built-in page in the carousel.
     */
    bool registerPage(std::shared_ptr<IAppPage> page);
    bool unregisterPage(const char* pageId);

    /**
     * Register an extensible dynamic widget page slot for Phase 3.
     */
    bool registerWidgetPage(std::shared_ptr<IAppPage> page);
    bool unregisterWidgetPage(const char* pageId);

    /**
     * Navigate immediately or with smooth cubicOut slide animation to a page by pageId.
     */
    bool navigateToPage(const char* pageId, bool animate = true);

    /**
     * Cycle carousel to next / previous page with 200ms cubicOut slide transition.
     */
    void nextPage();
    void prevPage();

    [[nodiscard]] std::shared_ptr<IAppPage> getActivePage() const;
    [[nodiscard]] std::shared_ptr<IAppPage> getPageById(const char* pageId) const;
    [[nodiscard]] size_t getPageCount() const;
    [[nodiscard]] size_t getActivePageIndex() const;

    [[nodiscard]] size_t getBuiltinPageCount() const;
    [[nodiscard]] size_t getWidgetPageCount() const;
    [[nodiscard]] size_t getTotalPageCount() const { return getPageCount(); }

    /**
     * Route touch event to active page.
     */
    void handleTouch(const TouchGestureEvent& evt);

    /**
     * Core 1 UI frame update (called at 60 FPS).
     */
    void update(uint32_t nowMs);

    /**
     * Core 1 60FPS UI frame render on 128x160 canvas.
     */
    void render(Canvas128x160& canvas);

    /**
     * Render the unified top status bar (OFFLINE vs AGENTIC, Wi-Fi RSSI bars, Voice AI mic indicator, clock, battery).
     */
    void drawTopStatusBar(Canvas128x160& canvas, uint32_t nowMs = 0);

    // --- Telemetry & Diagnostics ---
    void setTelemetryEnabled(bool enabled) noexcept { m_telemetryEnabled = enabled; }
    [[nodiscard]] bool isTelemetryEnabled() const noexcept { return m_telemetryEnabled; }
    void toggleTelemetry() noexcept { m_telemetryEnabled = !m_telemetryEnabled; }

    void updateTelemetry(uint32_t frameTimeUs) noexcept;
    void renderTelemetryOverlay(Canvas128x160& canvas) noexcept;

private:
    UIManager();
    ~UIManager();

    void drawToastOverlay(Canvas128x160& canvas);
    void drawPageIndicators(Canvas128x160& canvas);

#ifdef ESP32
    mutable SemaphoreHandle_t m_mutex{nullptr};
#endif

    ToastNotification m_toast{};
    RobotMode m_currentMode{RobotMode::NormalOffline};
    uint32_t m_lastUpdateMs{0};

    std::vector<std::shared_ptr<IAppPage>> m_pages;
    std::vector<std::shared_ptr<IAppPage>> m_widgetSlots;
    size_t m_activePageIndex{0};
    SlideTransition m_transition{};

    // Pre-allocated PSRAM scratch buffer for 2-page transition composition (40,960 Bytes)
    uint16_t* m_transitionScratchBuffer{nullptr};
    Canvas128x160 m_transitionCanvas{};

    // Telemetry & FPS metrics
    bool m_telemetryEnabled{false};
    float m_fpsFiltered{60.0f};
    uint32_t m_frameTimeUs{0};
    uint32_t m_lastFpsCalcMs{0};
    uint32_t m_renderedFramesCount{0};
};

} // namespace petbot::firmware::ui
