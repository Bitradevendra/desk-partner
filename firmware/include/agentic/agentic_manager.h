#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include <memory>
#include <vector>

#include "petbot_protocol.h"
#include "apps/app_page.h"
#include "agentic/agentic_transport.h"
#include "agentic/widget_registry.h"
#include "agentic/sd_vault.h"
#include "agentic/voice_streamer.h"
#include "agentic/touch_2fa.h"
#include "agentic/automation_host.h"

#ifdef ESP32
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#endif

namespace petbot::firmware::agentic {

using petbot::protocol::PetBotFrameHeader;
using petbot::protocol::FrameType;
using petbot::protocol::RobotMode;
using petbot::protocol::EmotionId;
using petbot::firmware::apps::IAppPage;
using petbot::hal::Canvas128x160;
using petbot::hal::TouchGestureEvent;

/**
 * 32-point rolling telemetry sparkline buffer
 */
constexpr size_t SPARKLINE_POINTS = 32;

/**
 * Thread-safe live PC Desktop Telemetry snapshot
 */
struct PcTelemetryData {
    uint8_t cpuPercent{0};
    uint8_t ramPercent{0};
    uint8_t gpuPercent{0};
    char activeApp[48]{"Desktop"};
    char mediaTrack[48]{"No Track"};
    bool mediaPlaying{false};
    uint16_t unreadCount{0};
    bool meetingActive{false};
    bool deepWorkActive{false};
    uint32_t lastBroadcastMs{0};
    bool isConnected{false};

    // Rolling 32-point history buffers for real-time graphs
    uint8_t cpuHistory[SPARKLINE_POINTS]{0};
    uint8_t ramHistory[SPARKLINE_POINTS]{0};
    uint8_t gpuHistory[SPARKLINE_POINTS]{0};
    uint8_t historyCount{0};
};

/**
 * Built-in Live PC Telemetry HUD Page
 * Displays live CPU/RAM/GPU sparklines, active app/meeting focus, and media play/pause triggers.
 */
class PcTelemetryHudPage : public IAppPage {
public:
    PcTelemetryHudPage() = default;
    ~PcTelemetryHudPage() override = default;

    [[nodiscard]] const char* getPageId() const noexcept override {
        return "pc_telemetry";
    }

    [[nodiscard]] const char* getPageTitle() const noexcept override {
        return "PC Monitor";
    }

    void onEnter() override;
    void onExit() override;
    void handleTouch(const TouchGestureEvent& evt) override;
    void update(uint32_t nowMs, float dt) override;
    void render(Canvas128x160& canvas) override;

private:
    void drawSparkline(Canvas128x160& canvas, int16_t x, int16_t y, int16_t w, int16_t h,
                       const uint8_t* history, uint8_t count, uint16_t color) noexcept;
};

enum class SideDoubleTapAction : uint8_t {
    AiBriefing = 0,
    MediaPlayPause = 1,
    NextWidget = 2
};

/**
 * Central Agentic Subsystem Manager (AgenticManager)
 *
 * Coordinates:
 * 1. AgenticTransport (BLE Beacon, mDNS, WebSockets)
 * 2. WidgetRegistry (.pbwg Declarative Runtime)
 * 3. SdVaultEngine (128KB PSRAM Chunked Storage)
 * 4. VoiceStreamer (Real-time Audio Pipeline & Visemes)
 * 5. Touch2FAManager (Cryptographic Hardware Security Key)
 * 6. Dedicated Core 0 FreeRTOS Task (Task_AgenticNet, Priority 3, 12KB stack)
 * 7. Live PC Telemetry Broadcast Handler (HARNESS_RPC_REQ -> PcTelemetryHudPage)
 */
class AgenticManager {
public:
    static AgenticManager& instance() {
        static AgenticManager s_instance;
        return s_instance;
    }

    AgenticManager(const AgenticManager&) = delete;
    AgenticManager& operator=(const AgenticManager&) = delete;

    /**
     * Initialize all agentic subsystems and spawn Core 0 Task_AgenticNet.
     */
    bool init(const TransportConfig& config = {});

    /**
     * Stop all agentic services and terminate Core 0 task.
     */
    void stop();

    [[nodiscard]] bool isRunning() const noexcept {
        return m_running;
    }

    /**
     * Dispatch FrameType::HarnessRpcReq incoming telemetry packets from Desktop Harness.
     */
    void handleHarnessRpcReq(const uint8_t* payload, size_t len);

    /**
     * Thread-safe query of current Desktop Telemetry snapshot.
     */
    [[nodiscard]] PcTelemetryData getTelemetrySnapshot() const noexcept;

    /**
     * Send Media Play/Pause toggle RPC to Desktop Harness.
     */
    bool triggerMediaPlayPause();

    /**
     * Send Quick AI Daily Briefing / Smart Assist RPC to Companion/Harness.
     */
    bool triggerQuickBriefing();

    void setSideDoubleTapAction(SideDoubleTapAction action) noexcept { m_sideDoubleTapAction = action; }
    [[nodiscard]] SideDoubleTapAction getSideDoubleTapAction() const noexcept { return m_sideDoubleTapAction; }

    /**
     * Query Core 0 Task Handle for diagnostics.
     */
#ifdef ESP32
    [[nodiscard]] TaskHandle_t getTaskHandle() const noexcept {
        return m_taskHandle;
    }
#endif

private:
    AgenticManager();
    ~AgenticManager();

    static void taskEntry(void* param);
    void taskLoop();

    bool m_running{false};
#ifdef ESP32
    TaskHandle_t m_taskHandle{nullptr};
    mutable SemaphoreHandle_t m_mutex{nullptr};
#endif
    PcTelemetryData m_telemetry{};
    std::shared_ptr<PcTelemetryHudPage> m_hudPage{nullptr};
    bool m_wasMeetingActive{false};
    SideDoubleTapAction m_sideDoubleTapAction{SideDoubleTapAction::AiBriefing};
};

/**
 * Factory function creating PcTelemetryHudPage implementing IAppPage.
 */
std::shared_ptr<IAppPage> createPcTelemetryHudPage();

} // namespace petbot::firmware::agentic
