#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>
#include <memory>
#include <functional>

#include "petbot_protocol.h"
#include "hal/touch_hal.h"
#include "hal/audio_hal.h"
#include "hal/display_hal.h"
#include "hal/storage_hal.h"

#ifdef ESP32
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#endif

namespace petbot::firmware::agentic {

using petbot::protocol::EmotionId;
using petbot::protocol::FrameType;
using petbot::protocol::RobotMode;
using petbot::hal::TouchGesture;
using petbot::hal::Canvas128x160;

/**
 * Trigger classifications for hosted robot automations.
 */
enum class AutomationTriggerType : uint8_t {
    RobotTouchGesture = 0,
    ScheduleCron      = 1,
    SystemEvent       = 2,
    VoicePhrase       = 3,
};

/**
 * Complete record for an automation hosted on the physical ESP32-S3.
 */
struct HostedAutomationRecord {
    std::string id;
    std::string name;
    std::string description;

    AutomationTriggerType triggerType{AutomationTriggerType::RobotTouchGesture};
    TouchGesture touchGesture{TouchGesture::SingleTap};

    // RTC Schedule fields (offline cron)
    uint8_t cronHour{8};
    uint8_t cronMinute{30};
    uint8_t cronDaysMask{0x3E}; // Mon-Fri (1<<1 to 1<<5)
    bool runOfflineOnRtc{true};
    std::string humanSchedule{"Weekdays 8:30 AM"};

    // ST7735S 128x160 Live Card Presentation
    std::string headerBadge{"AUTO"};
    std::string cardTitle{"Morning VIP"};
    std::string cardSubtitle{"Briefing Ready"};
    uint16_t accentColorRgb565{0x07E0}; // RGB565 Emerald Green
    EmotionId emotion{EmotionId::Happy};
    petbot::hal::SoundId soundId{petbot::hal::SoundId::HappyTrill};

    // Safety and offline vault
    bool requires2Fa{false};
    std::string offlineVaultPath{"/sd/vault/automations/history.log"};

    // Execution metrics
    uint32_t lastTriggeredMs{0};
    uint32_t executionCount{0};
};

/**
 * Execution result output
 */
struct AutomationExecutionResult {
    bool success{false};
    bool executedOnline{false};
    bool executedOffline{false};
    bool requires2FaTriggered{false};
    char message[64]{0};
};

/**
 * AutomationHost:
 * Zero-Code Embedded Automation Host running on ESP32-S3 N16R8.
 * Executes triggers offline (capacitive touch, internal RTC) or forwards to
 * Desktop/Mobile Harness when connected via binary WebSocket frames.
 */
class AutomationHost {
public:
    static AutomationHost& instance() noexcept;

    AutomationHost(const AutomationHost&) = delete;
    AutomationHost& operator=(const AutomationHost&) = delete;
    AutomationHost(AutomationHost&&) = delete;
    AutomationHost& operator=(AutomationHost&&) = delete;

    /**
     * Initialize host engine and register standard built-in automations.
     */
    bool init();

    /**
     * Register or update an automation package.
     */
    bool registerAutomation(HostedAutomationRecord record);

    /**
     * Remove an automation by its unique ID.
     */
    bool unregisterAutomation(std::string_view id);

    /**
     * Find a registered automation by ID.
     */
    [[nodiscard]] const HostedAutomationRecord* findById(std::string_view id) const;

    /**
     * Get all registered automations.
     */
    [[nodiscard]] const std::vector<HostedAutomationRecord>& getAutomations() const noexcept {
        return m_automations;
    }

    [[nodiscard]] size_t getCount() const noexcept {
        return m_automations.size();
    }

    /**
     * Check capacitive touch gesture against all registered ROBOT_TOUCH_GESTURE triggers.
     * @return true if an automation matched and executed.
     */
    bool handleTouchGesture(TouchGesture gesture);

    /**
     * Evaluate RTC timer against all registered SCHEDULE_CRON triggers.
     * @param hour 0-23
     * @param minute 0-59
     * @param dayOfWeek 0=Sunday, 1=Monday, ..., 6=Saturday
     * @return true if one or more automations matched and executed.
     */
    bool checkRtcSchedule(uint8_t hour, uint8_t minute, uint8_t dayOfWeek);

    /**
     * Trigger execution of an automation.
     * Dispatches online via FrameType::HARNESS_RPC_REQ if connected,
     * or executes offline autonomous action on the ESP32-S3.
     */
    AutomationExecutionResult executeAutomation(std::string_view id);
    AutomationExecutionResult executeAutomation(HostedAutomationRecord& record);

    /**
     * Render the ST7735S 128x160 Card for the active automation.
     */
    void renderAutomationCard(Canvas128x160& canvas, const HostedAutomationRecord& record);

    /**
     * Persist and restore automation registry to/from MicroSD card or LittleFS.
     */
    bool saveToStorage();
    bool loadFromStorage();

private:
    AutomationHost();
    ~AutomationHost() = default;

    std::vector<HostedAutomationRecord> m_automations;
    bool m_initialized{false};

#ifdef ESP32
    SemaphoreHandle_t m_mutex{nullptr};
#endif
};

} // namespace petbot::firmware::agentic
