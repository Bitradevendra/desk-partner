#include "agentic/agentic_manager.h"
#include "agentic/automation_host.h"
#include "agentic/voice_streamer.h"
#include "apps/builtin_pages.h"
#include "ui/ui_manager.h"
#include "ui/expression_engine.h"
#include "hal/audio_hal.h"
#include "hal/display_hal.h"
#include "hal/storage_hal.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#ifdef ESP32
#include <Preferences.h>
#endif
#include "hal/board_pins.h"
#include <cstring>
#include <algorithm>
#include <vector>

namespace petbot::firmware::agentic {

namespace colors = petbot::hal::colors;
namespace hal = ::petbot::hal;

// ============================================================================
// PcTelemetryHudPage Implementation
// ============================================================================

void PcTelemetryHudPage::onEnter() {
    Serial.println("[PcTelemetryHudPage] Switched to PC Monitor HUD.");
}

void PcTelemetryHudPage::onExit() {
    // No-op clean teardown
}

void PcTelemetryHudPage::handleTouch(const TouchGestureEvent& evt) {
    if (evt.gesture == petbot::hal::TouchGesture::SingleTap) {
        // Trigger media play/pause on connected PC via Desktop Harness RPC
        AgenticManager::instance().triggerMediaPlayPause();
    }
}

void PcTelemetryHudPage::update(uint32_t nowMs, float dt) {
    (void)nowMs;
    (void)dt;
}

void PcTelemetryHudPage::render(Canvas128x160& canvas) {
    canvas.clear(colors::Black);

    const PcTelemetryData telem = AgenticManager::instance().getTelemetrySnapshot();

    // 1. Top Header Bar (160px landscape)
    canvas.fillRect(0, 0, 160, 16, colors::Navy);
    canvas.drawFastHLine(0, 16, 160, colors::Cyan);

    if (telem.meetingActive) {
        canvas.fillRoundRect(3, 2, 54, 12, 2, colors::Red);
        canvas.drawText(6, 4, "MEETING", colors::White, colors::Red, 1, true);
    } else if (telem.deepWorkActive) {
        canvas.fillRoundRect(3, 2, 46, 12, 2, colors::Magenta);
        canvas.drawText(6, 4, "FOCUS", colors::White, colors::Magenta, 1, true);
    } else {
        canvas.drawText(4, 4, "PC MONITOR", colors::Cyan, colors::Navy, 1, true);
    }

    if (std::strlen(telem.activeApp) > 0) {
        char appBuf[14]{0};
        std::strncpy(appBuf, telem.activeApp, sizeof(appBuf) - 1);
        canvas.drawText(72, 4, appBuf, colors::White, colors::Navy, 1, true);
    }

    // 2. CPU Metric & Sparkline
    char cpuBuf[20];
    std::snprintf(cpuBuf, sizeof(cpuBuf), "CPU %2u%%", telem.cpuPercent);
    canvas.drawText(6, 20, cpuBuf, colors::Cyan, colors::Black, 1, true);
    drawSparkline(canvas, 62, 19, 90, 14, telem.cpuHistory, telem.historyCount, colors::Cyan);

    // 3. RAM Metric & Sparkline
    char ramBuf[20];
    std::snprintf(ramBuf, sizeof(ramBuf), "RAM %2u%%", telem.ramPercent);
    canvas.drawText(6, 38, ramBuf, colors::Green, colors::Black, 1, true);
    drawSparkline(canvas, 62, 37, 90, 14, telem.ramHistory, telem.historyCount, colors::Green);

    // 4. GPU Metric & Sparkline
    char gpuBuf[20];
    std::snprintf(gpuBuf, sizeof(gpuBuf), "GPU %2u%%", telem.gpuPercent);
    canvas.drawText(6, 56, gpuBuf, colors::Yellow, colors::Black, 1, true);
    drawSparkline(canvas, 62, 55, 90, 14, telem.gpuHistory, telem.historyCount, colors::Yellow);

    canvas.drawFastHLine(6, 73, 148, colors::DarkGray);

    // 5. Unread Notifications Bar
    if (telem.unreadCount > 0) {
        char notifBuf[28];
        std::snprintf(notifBuf, sizeof(notifBuf), "Bell: %u unread", telem.unreadCount);
        canvas.drawText(8, 77, notifBuf, colors::Orange, colors::Black, 1, true);
    } else {
        canvas.drawText(8, 77, "Notifications: 0", colors::LightGray, colors::Black, 1, true);
    }

    // 6. Media Control Card (y = 89..124)
    canvas.fillRoundRect(6, 89, 148, 35, 4, colors::DarkGray);
    canvas.drawRoundRect(6, 89, 148, 35, 4, colors::Cyan);

    char trackBuf[22]{0};
    if (std::strlen(telem.mediaTrack) > 0) {
        std::strncpy(trackBuf, telem.mediaTrack, sizeof(trackBuf) - 1);
    } else {
        std::strncpy(trackBuf, "No Track", sizeof(trackBuf) - 1);
    }
    canvas.drawText(12, 93, trackBuf, colors::White, colors::DarkGray, 1, true);

    const char* actionStr = telem.mediaPlaying ? "PAUSE (TAP)" : "PLAY (TAP)";
    const uint16_t btnCol = telem.mediaPlaying ? colors::Yellow : colors::Cyan;
    canvas.fillRoundRect(14, 105, 132, 15, 3, btnCol);
    canvas.drawText(42, 108, actionStr, colors::Black, btnCol, 1, true);
}

void PcTelemetryHudPage::drawSparkline(
    Canvas128x160& canvas,
    int16_t x, int16_t y,
    int16_t w, int16_t h,
    const uint8_t* history,
    uint8_t count,
    uint16_t color
) noexcept {
    // Outer boundary box
    canvas.drawRect(x, y, w, h, colors::DarkGray);

    if (count == 0 || history == nullptr) return;

    const float stepX = static_cast<float>(w - 2) / static_cast<float>(SPARKLINE_POINTS - 1);
    const int16_t baseY = y + h - 1;

    for (size_t i = 1; i < SPARKLINE_POINTS; ++i) {
        const int16_t x1 = x + 1 + static_cast<int16_t>((i - 1) * stepX);
        const int16_t y1 = baseY - static_cast<int16_t>((history[i - 1] * (h - 2)) / 100);
        const int16_t x2 = x + 1 + static_cast<int16_t>(i * stepX);
        const int16_t y2 = baseY - static_cast<int16_t>((history[i] * (h - 2)) / 100);

        canvas.drawLine(
            x1, std::clamp<int16_t>(y1, y + 1, baseY),
            x2, std::clamp<int16_t>(y2, y + 1, baseY),
            color
        );
    }
}

// ============================================================================
// AgenticManager Implementation
// ============================================================================

AgenticManager::AgenticManager() {
#ifdef ESP32
    m_mutex = xSemaphoreCreateMutex();
#endif
}

AgenticManager::~AgenticManager() {
    stop();
#ifdef ESP32
    if (m_mutex != nullptr) {
        vSemaphoreDelete(m_mutex);
        m_mutex = nullptr;
    }
#endif
}

bool AgenticManager::init(const TransportConfig& config) {
    if (m_running) return true;

    Serial.println("\n==================================================");
    Serial.println("  Initializing Central Agentic Orchestrator");
    Serial.println("==================================================");

#ifdef ESP32
    if (m_mutex == nullptr) {
        m_mutex = xSemaphoreCreateMutex();
    }
#endif

    // 1. Initialize AgenticTransport (BLE Beacon, GATT Provisioning, mDNS, WebSockets)
    if (!AgenticTransport::instance().begin(config)) {
        Serial.println("[AgenticManager] ERROR: AgenticTransport initialization failed!");
        return false;
    }

    // 2. Initialize Declarative Widget Registry
    WidgetRegistry::instance().init();

    // 3. Initialize "Send & Collect" SD Card Vault Engine & Page
    SdVaultEngine::instance().init();
    ui::UIManager::instance().registerWidgetPage(createSdVaultPage());

    // 4. Initialize Bi-Directional Voice AI Streaming Pipeline
    VoiceStreamer::instance().init();

    // 5. Initialize Cryptographic Hardware 2FA Consent Manager
    Touch2FAManager::instance().init();

    // 6. Initialize Zero-Code Automation Host
    AutomationHost::instance().init();

    // 7. Register built-in Live PC Telemetry HUD Page
    m_hudPage = std::make_shared<PcTelemetryHudPage>();
    ui::UIManager::instance().registerWidgetPage(m_hudPage);

    // 7. Wire FrameType::HarnessRpcReq telemetry broadcast dispatcher
    AgenticTransport::instance().registerFrameHandler(
        FrameType::HarnessRpcReq,
        [this](const PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
            (void)header;
            this->handleHarnessRpcReq(payload, len);
        }
    );

    // 8. Spawn dedicated Core 0 Task_AgenticNet (Priority 3, 12KB stack)
#ifdef ESP32
    m_running = true;
    const BaseType_t res = xTaskCreatePinnedToCore(
        taskEntry,
        "Task_AgenticNet",
        12288, // 12KB stack
        this,
        3,     // Priority 3
        &m_taskHandle,
        0      // Core 0 (Strict segregation from Core 1 UI)
    );

    if (res != pdPASS) {
        Serial.println("[AgenticManager] CRITICAL: Failed to spawn Task_AgenticNet on Core 0!");
        m_running = false;
        return false;
    }

    Serial.println("[AgenticManager] Task_AgenticNet active on Core 0. All agentic systems online.");
#else
    m_running = true;
    Serial.println("[AgenticManager] Host emulation mode: Agentic subsystems online.");
#endif

    return true;
}

void AgenticManager::stop() {
    if (!m_running) return;

    m_running = false;

#ifdef ESP32
    if (m_taskHandle != nullptr) {
        vTaskDelete(m_taskHandle);
        m_taskHandle = nullptr;
    }
#endif

    AgenticTransport::instance().stop();
    Serial.println("[AgenticManager] Agentic Subsystems stopped.");
}

void AgenticManager::handleHarnessRpcReq(const uint8_t* payload, size_t len) {
    if (payload == nullptr || len == 0) return;

    JsonDocument doc;
    const DeserializationError err = deserializeMsgPack(doc, payload, len);
    if (err) {
        Serial.printf("[AgenticManager] RPC unpack error: %s\n", err.c_str());
        return;
    }

    JsonObject params = doc["params"].is<JsonObject>() ? doc["params"].as<JsonObject>() : doc.as<JsonObject>();
    const char* method = doc["method"] | "";

    // Intercept hardware & companion control RPCs cleanly
    if (std::strcmp(method, "robot.setHardwareSettings") == 0) {
        if (params["volumePct"].is<int>()) {
            // Always keep speaker volume at maximum
            hal::AudioHal::instance().setVolumePct(100);
        }
        if (params["brightnessPct"].is<int>()) {
            const uint8_t bl = static_cast<uint8_t>(std::clamp(params["brightnessPct"].as<int>(), 10, 100));
            hal::DisplayHal::instance().setBacklightPct(bl);
        }
        if (params["vadSensitivity"].is<int>()) {
            const uint16_t vad = static_cast<uint16_t>(std::clamp(params["vadSensitivity"].as<int>(), 100, 4000));
            hal::AudioHal::instance().setVadThreshold(vad);
        }
        if (params["wakeWordEnabled"].is<bool>()) {
            VoiceStreamer::instance().setWakeWordEnabled(params["wakeWordEnabled"].as<bool>());
        }
        if (params["wakeWordPhrase"].is<const char*>()) {
            VoiceStreamer::instance().setWakeWordPhrase(params["wakeWordPhrase"].as<const char*>());
        }
        if (params["silenceReturnSec"].is<int>()) {
            const uint32_t sec = static_cast<uint32_t>(std::clamp(params["silenceReturnSec"].as<int>(), 5, 120));
            VoiceStreamer::instance().setSilenceReturnMs(sec * 1000);
        }
        if (params["sideDoubleTapAction"].is<const char*>()) {
            const char* act = params["sideDoubleTapAction"].as<const char*>();
            if (std::strcmp(act, "MEDIA_PLAY_PAUSE") == 0) {
                m_sideDoubleTapAction = SideDoubleTapAction::MediaPlayPause;
            } else if (std::strcmp(act, "NEXT_WIDGET") == 0) {
                m_sideDoubleTapAction = SideDoubleTapAction::NextWidget;
            } else {
                m_sideDoubleTapAction = SideDoubleTapAction::AiBriefing;
            }
        }
        hal::AudioHal::instance().playProceduralSound(hal::SoundId::Tick);
        ui::UIManager::instance().showToast("Settings Synced", 1200);
        Serial.println("[AgenticManager] Applied robot.setHardwareSettings RPC from Companion.");
        return;
    }

    if (std::strcmp(method, "robot.provisionWifi") == 0) {
        const char* ssid = params["ssid"] | "";
        const char* pass = params["password"] | "";
        const char* host = params["host"] | "";
        const uint16_t port = params["port"] | PETBOT_DEFAULT_WS_PORT;
#ifdef ESP32
        Preferences provPrefs;
        if (provPrefs.begin("petbot_prov", false)) {
            if (std::strlen(ssid) > 0) provPrefs.putString("ssid", ssid);
            if (std::strlen(pass) > 0) provPrefs.putString("password", pass);
            if (std::strlen(host) > 0) provPrefs.putString("host", host);
            if (port > 0) provPrefs.putUShort("port", port);
            provPrefs.end();
        }
#endif
        if (std::strlen(ssid) > 0) {
            AgenticTransport::instance().connectWifi(ssid, pass);
        }
        if (std::strlen(host) > 0) {
            AgenticTransport::instance().connectOutbound(host, port, "/ws");
        }
        hal::AudioHal::instance().playProceduralSound(hal::SoundId::HappyTrill);
        ui::UIManager::instance().showToast("Wi-Fi Provisioned!", 2000);
        Serial.printf("[AgenticManager] Applied robot.provisionWifi RPC (SSID: %s).\n", ssid);
        return;
    }

    if (std::strcmp(method, "robot.setTelemetryOverlay") == 0) {
        const bool enabled = params["enabled"] | false;
        ui::UIManager::instance().setTelemetryEnabled(enabled);
        hal::AudioHal::instance().playProceduralSound(hal::SoundId::Tick);
        ui::UIManager::instance().showToast(enabled ? "Diagnostics ON" : "Diagnostics OFF", 1200);
        return;
    }

    if (std::strcmp(method, "robot.setPinOverride") == 0) {
        const char* pinName = params["name"] | "";
        const int gpio = params["gpio"] | -1;
        if (std::strcmp(pinName, "reset") == 0) {
            petbot::hal::pins::resetPinOverrides();
            ui::UIManager::instance().showToast("Pins Reset", 1500);
        } else if (std::strlen(pinName) > 0 && gpio >= 0 && gpio <= 48) {
            petbot::hal::pins::setPinOverride(pinName, gpio);
            ui::UIManager::instance().showToast("Pin Remapped", 1500);
        }
        return;
    }

    // =========================================================================
    // Cross-Widget Voice & App RPC Handlers (Navigation, Pomodoro, Notes, Habits)
    // =========================================================================

    if (std::strcmp(method, "navigate_widget") == 0 || std::strcmp(method, "robot.navigateWidget") == 0) {
        const char* pageId = params["pageId"] | params["widgetId"] | "home";
        VoiceStreamer::instance().clearSavedWidgetReturn();
        const bool ok = ui::UIManager::instance().navigateToPage(pageId, true);
        if (params["clockMode"].is<const char*>() || params["clockMode"].is<int>()) {
            auto clockPage = std::static_pointer_cast<apps::ClockWeatherPage>(
                ui::UIManager::instance().getPageById("clock")
            );
            if (clockPage) {
                if (params["clockMode"].is<const char*>()) {
                    const char* modeStr = params["clockMode"] | "digital";
                    clockPage->setClockMode(std::strcmp(modeStr, "analog") == 0 ? 1 : 0);
                } else {
                    clockPage->setClockMode(static_cast<uint8_t>(params["clockMode"].as<int>()));
                }
            }
        }
        hal::AudioHal::instance().playProceduralSound(ok ? hal::SoundId::Chirp : hal::SoundId::Tick);
        Serial.printf("[AgenticManager] Navigated to widget page '%s' (ok=%s).\n", pageId, ok ? "YES" : "NO");
        return;
    }

    if (std::strcmp(method, "start_timer") == 0 ||
        std::strcmp(method, "pomodoro_control") == 0 ||
        std::strcmp(method, "robot_start_timer") == 0) {
        const char* action = params["action"] | "start";
        const uint16_t minutes = static_cast<uint16_t>(params["minutes"] | 25);
        const bool shouldNavigate = params["navigate"] | true;

        auto pomoPage = std::static_pointer_cast<apps::PomodoroPage>(
            ui::UIManager::instance().getPageById("pomodoro")
        );
        if (pomoPage) {
            if (std::strcmp(action, "pause") == 0) {
                pomoPage->pauseFocus();
                ui::UIManager::instance().showToast("Timer Paused", 1500);
                hal::AudioHal::instance().playProceduralSound(hal::SoundId::Tick);
            } else if (std::strcmp(action, "resume") == 0) {
                pomoPage->startFocus();
                ui::UIManager::instance().showToast("Timer Resumed", 1500);
                hal::AudioHal::instance().playProceduralSound(hal::SoundId::Chirp);
            } else if (std::strcmp(action, "break") == 0 || std::strcmp(action, "short_break") == 0) {
                pomoPage->startBreak(false);
                ui::ExpressionEngine::instance().setEmotion(EmotionId::Happy);
                ui::UIManager::instance().showToast("5m Break Started!", 2000);
                hal::AudioHal::instance().playProceduralSound(hal::SoundId::HappyTrill);
            } else if (std::strcmp(action, "long_break") == 0) {
                pomoPage->startBreak(true);
                ui::ExpressionEngine::instance().setEmotion(EmotionId::Happy);
                ui::UIManager::instance().showToast("15m Rest Started!", 2000);
                hal::AudioHal::instance().playProceduralSound(hal::SoundId::HappyTrill);
            } else if (std::strcmp(action, "reset") == 0) {
                pomoPage->resetFocus();
                ui::UIManager::instance().showToast("Timer Reset", 1500);
                hal::AudioHal::instance().playProceduralSound(hal::SoundId::Tick);
            } else {
                pomoPage->startCustomFocus(minutes);
                ui::ExpressionEngine::instance().setEmotion(EmotionId::Focused);
                char toastBuf[40];
                std::snprintf(toastBuf, sizeof(toastBuf), "Focus: %um ON", static_cast<unsigned>(minutes));
                ui::UIManager::instance().showToast(toastBuf, 2000);
                hal::AudioHal::instance().playProceduralSound(hal::SoundId::HappyTrill);
            }
            if (shouldNavigate) {
                VoiceStreamer::instance().clearSavedWidgetReturn();
                ui::UIManager::instance().navigateToPage("pomodoro", true);
            }
        }
        return;
    }

    if (std::strcmp(method, "save_note") == 0 || std::strcmp(method, "note_manage") == 0) {
        const char* action = params["action"] | "add";
        const char* title = params["title"] | "Voice Note";
        const char* body = params["text"] | params["body"] | "";
        const bool pinned = params["pinned"] | false;
        const bool shouldNavigate = params["navigate"] | false;

        auto notesPage = std::static_pointer_cast<apps::QuickNotesPage>(
            ui::UIManager::instance().getPageById("notes")
        );
        if (notesPage) {
            if (std::strcmp(action, "delete") == 0 || std::strcmp(action, "remove") == 0) {
                notesPage->deleteNoteByTitle(title[0] != '\0' ? title : body);
                ui::UIManager::instance().showToast("Note Deleted", 1500);
                hal::AudioHal::instance().playProceduralSound(hal::SoundId::Tick);
            } else if (std::strcmp(action, "pin") == 0) {
                notesPage->setNotePinnedByTitle(title[0] != '\0' ? title : body, true);
                ui::UIManager::instance().showToast("Note Pinned!", 1500);
                hal::AudioHal::instance().playProceduralSound(hal::SoundId::Chirp);
            } else if (std::strcmp(action, "unpin") == 0) {
                notesPage->setNotePinnedByTitle(title[0] != '\0' ? title : body, false);
                ui::UIManager::instance().showToast("Note Unpinned", 1500);
                hal::AudioHal::instance().playProceduralSound(hal::SoundId::Tick);
            } else {
                const char* finalTitle = (params["title"].is<const char*>() && std::strlen(title) > 0)
                                             ? title
                                             : "Voice Note";
                notesPage->addOrUpdateNote(finalTitle, body, pinned);
                ui::ExpressionEngine::instance().setEmotion(EmotionId::Happy);
                ui::UIManager::instance().showToast("Note Saved!", 1800);
                hal::AudioHal::instance().playProceduralSound(hal::SoundId::HappyTrill);
            }
            if (shouldNavigate) {
                VoiceStreamer::instance().clearSavedWidgetReturn();
                ui::UIManager::instance().navigateToPage("notes", true);
            }
        }
        return;
    }

    if (std::strcmp(method, "habit_manage") == 0 ||
        std::strcmp(method, "add_habit") == 0 ||
        std::strcmp(method, "complete_habit") == 0) {
        const char* action = params["action"] |
                             (std::strcmp(method, "complete_habit") == 0 ? "complete" : "add");
        const char* query = params["title"] | params["query"] | params["habit"] | "";
        const bool shouldNavigate = params["navigate"] | true;

        auto habitsPage = std::static_pointer_cast<apps::HabitTrackerPage>(
            ui::UIManager::instance().getPageById("habits")
        );
        if (habitsPage) {
            if (std::strcmp(action, "complete") == 0 || std::strcmp(action, "tick") == 0) {
                if (habitsPage->setHabitCompletedByName(query, true)) {
                    ui::ExpressionEngine::instance().setTemporaryEmotion(EmotionId::Happy, 2500);
                    ui::UIManager::instance().showToast("Habit Ticked! +1", 2000);
                } else {
                    ui::UIManager::instance().showToast("Habit Not Found", 1500);
                }
            } else if (std::strcmp(action, "uncomplete") == 0 || std::strcmp(action, "untick") == 0) {
                habitsPage->setHabitCompletedByName(query, false);
                ui::UIManager::instance().showToast("Habit Unchecked", 1500);
            } else if (std::strcmp(action, "remove") == 0 || std::strcmp(action, "delete") == 0) {
                habitsPage->removeHabitByName(query);
                ui::UIManager::instance().showToast("Habit Removed", 1500);
            } else {
                if (habitsPage->addHabit(query)) {
                    ui::ExpressionEngine::instance().setEmotion(EmotionId::Happy);
                    ui::UIManager::instance().showToast("Added to Habits!", 2000);
                }
            }
            if (shouldNavigate) {
                VoiceStreamer::instance().clearSavedWidgetReturn();
                ui::UIManager::instance().navigateToPage("habits", true);
            }
        }
        return;
    }

    if (std::strcmp(method, "clock_sync") == 0) {
        auto clockPage = std::static_pointer_cast<apps::ClockWeatherPage>(
            ui::UIManager::instance().getPageById("clock")
        );
        if (clockPage) {
            if (params["unixSec"].is<uint32_t>() || params["unixTimeSec"].is<uint32_t>()) {
                const uint32_t sec = params["unixSec"] | params["unixTimeSec"] | 0u;
                const int32_t tz = params["tzOffsetSec"] | 0;
                const char* dateLabel = params["dateLabel"] | nullptr;
                clockPage->syncTime(sec, tz, dateLabel);
            }
            if (params["clockMode"].is<const char*>()) {
                const char* modeStr = params["clockMode"] | "digital";
                clockPage->setClockMode(std::strcmp(modeStr, "analog") == 0 ? 1 : 0);
            }
            if (params["temperatureC"].is<int>()) {
                const int8_t temp = static_cast<int8_t>(params["temperatureC"].as<int>());
                const uint8_t hum = static_cast<uint8_t>(params["humidityPct"] | 50);
                const char* city = params["city"] | "Home";
                clockPage->updateWeather(temp, hum, apps::WeatherCondition::Sunny, city);
            }
        }
        return;
    }

    if (std::strcmp(method, "set_expression") == 0) {
        const char* exprStr = params["emotion"] | "IDLE";
        EmotionId emo = EmotionId::Idle;
        if (strcasecmp(exprStr, "HAPPY") == 0) emo = EmotionId::Happy;
        else if (strcasecmp(exprStr, "CURIOUS") == 0) emo = EmotionId::Curious;
        else if (strcasecmp(exprStr, "SLEEPY") == 0) emo = EmotionId::Sleepy;
        else if (strcasecmp(exprStr, "FOCUSED") == 0) emo = EmotionId::Focused;
        else if (strcasecmp(exprStr, "SPEAKING") == 0) emo = EmotionId::Speaking;
        else if (strcasecmp(exprStr, "LISTENING") == 0) emo = EmotionId::Listening;
        else if (strcasecmp(exprStr, "ALERT") == 0) emo = EmotionId::Alert;

        VoiceStreamer::instance().clearSavedWidgetReturn();
        ui::UIManager::instance().navigateToPage("home", true);
        ui::ExpressionEngine::instance().setEmotion(emo);
        return;
    }

    if (std::strcmp(method, "run_automation") == 0 || std::strcmp(method, "trigger_automation") == 0) {
        const char* autoId = params["automationId"] | "";
        const char* title = params["name"] | params["scriptName"] | "Automation";
        if (std::strlen(autoId) > 0 && AutomationHost::instance().findById(autoId) != nullptr) {
            AutomationHost::instance().executeAutomation(autoId);
        } else {
            ui::ExpressionEngine::instance().setEmotion(EmotionId::Focused);
            hal::AudioHal::instance().playProceduralSound(hal::SoundId::HappyTrill);
            ui::UIManager::instance().showToast(title, 2000);
        }
        return;
    }

    // Extract telemetry metrics
    const uint8_t cpu = params["cpuPercent"] | doc["cpuPercent"] | 0;
    const uint8_t ram = params["ramPercent"] | doc["ramPercent"] | 0;
    const uint8_t gpu = params["gpuPercent"] | doc["gpuPercent"] | 0;
    const char* appName = params["activeWindow"] | params["activeApp"] | doc["activeWindow"] | "Desktop";
    const char* media = params["mediaState"] | params["mediaTrack"] | doc["mediaState"] | "";
    const bool mediaPlaying = params["mediaPlaying"] | doc["mediaPlaying"] | false;
    const uint16_t unread = params["unreadNotifications"] | params["unreadCount"] | doc["unreadNotifications"] | 0;
    const bool meeting = params["meetingActive"] | params["zoomActive"] | doc["meetingActive"] | false;
    const bool deepWork = params["deepWorkActive"] | params["focusActive"] | doc["deepWorkActive"] | false;

    // Mutex-protected state update
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(20)) == pdTRUE)
#endif
    {
        m_telemetry.cpuPercent = std::min<uint8_t>(100, cpu);
        m_telemetry.ramPercent = std::min<uint8_t>(100, ram);
        m_telemetry.gpuPercent = std::min<uint8_t>(100, gpu);

        std::strncpy(m_telemetry.activeApp, appName, sizeof(m_telemetry.activeApp) - 1);
        m_telemetry.activeApp[sizeof(m_telemetry.activeApp) - 1] = '\0';

        if (media != nullptr && std::strlen(media) > 0) {
            std::strncpy(m_telemetry.mediaTrack, media, sizeof(m_telemetry.mediaTrack) - 1);
            m_telemetry.mediaTrack[sizeof(m_telemetry.mediaTrack) - 1] = '\0';
        }

        m_telemetry.mediaPlaying = mediaPlaying;
        m_telemetry.unreadCount = unread;
        m_telemetry.meetingActive = meeting;
        m_telemetry.deepWorkActive = deepWork;
        m_telemetry.lastBroadcastMs = millis();
        m_telemetry.isConnected = true;

        // Shift sparklines
        for (size_t i = 0; i < SPARKLINE_POINTS - 1; ++i) {
            m_telemetry.cpuHistory[i] = m_telemetry.cpuHistory[i + 1];
            m_telemetry.ramHistory[i] = m_telemetry.ramHistory[i + 1];
            m_telemetry.gpuHistory[i] = m_telemetry.gpuHistory[i + 1];
        }
        m_telemetry.cpuHistory[SPARKLINE_POINTS - 1] = m_telemetry.cpuPercent;
        m_telemetry.ramHistory[SPARKLINE_POINTS - 1] = m_telemetry.ramPercent;
        m_telemetry.gpuHistory[SPARKLINE_POINTS - 1] = m_telemetry.gpuPercent;
        if (m_telemetry.historyCount < SPARKLINE_POINTS) {
            m_telemetry.historyCount++;
        }

#ifdef ESP32
        if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    }

    // Reaction: If meeting/deep-work is active, transition pet's expression to EmotionId::Focused
    const bool shouldBeFocused = meeting || deepWork;
    if (shouldBeFocused != m_wasMeetingActive) {
        m_wasMeetingActive = shouldBeFocused;
        if (shouldBeFocused) {
            ui::ExpressionEngine::instance().setEmotion(EmotionId::Focused);
            ui::UIManager::instance().showToast("Deep Work Focus", 2000);
            Serial.println("[AgenticManager] Desktop entered Meeting/Deep-Work -> Pet switched to Focused.");
        } else {
            ui::ExpressionEngine::instance().setEmotion(EmotionId::Idle);
            Serial.println("[AgenticManager] Meeting ended -> Pet restored to Idle.");
        }
    }
}

PcTelemetryData AgenticManager::getTelemetrySnapshot() const noexcept {
    PcTelemetryData copy{};
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(10)) == pdTRUE) {
        copy = m_telemetry;
        xSemaphoreGive(m_mutex);
    } else {
        copy = m_telemetry;
    }
#else
    copy = m_telemetry;
#endif
    return copy;
}

bool AgenticManager::triggerMediaPlayPause() {
    JsonDocument doc;
    doc["callId"] = "media_toggle_cmd";
    doc["method"] = "media_play_pause";
    doc["params"]["action"] = "toggle";

    std::vector<uint8_t> outBytes(measureMsgPack(doc));
    if (!outBytes.empty()) {
        serializeMsgPack(doc, outBytes.data(), outBytes.size());
    }

    const bool sent = AgenticTransport::instance().sendFrame(
        FrameType::HarnessRpcReq,
        outBytes.data(),
        outBytes.size()
    );

    // Audio & Toast UI feedback
    hal::AudioHal::instance().playProceduralSound(hal::SoundId::Tick);
    ui::UIManager::instance().showToast("Media Toggled", 1200);

    Serial.println("[AgenticManager] Sent media play/pause toggle RPC to Desktop Harness.");
    return sent;
}

bool AgenticManager::triggerQuickBriefing() {
    JsonDocument doc;
    doc["callId"] = "quick_briefing_cmd";
    doc["method"] = "ai_quick_briefing";
    doc["params"]["source"] = "side_double_tap";

    std::vector<uint8_t> outBytes(measureMsgPack(doc));
    if (!outBytes.empty()) {
        serializeMsgPack(doc, outBytes.data(), outBytes.size());
    }

    const bool sent = AgenticTransport::instance().sendFrame(
        FrameType::HarnessRpcReq,
        outBytes.data(),
        outBytes.size()
    );

    ui::ExpressionEngine::instance().setEmotion(EmotionId::Curious);
    hal::AudioHal::instance().playProceduralSound(hal::SoundId::CuriousBeep);
    ui::UIManager::instance().showToast("AI Briefing...", 1800);

    Serial.println("[AgenticManager] Sent AI Quick Briefing RPC via Side Double-Tap.");
    return sent;
}

void AgenticManager::taskEntry(void* param) {
    auto* self = static_cast<AgenticManager*>(param);
    self->taskLoop();
#ifdef ESP32
    vTaskDelete(nullptr);
#endif
}

void AgenticManager::taskLoop() {
#ifdef ESP32
    Serial.printf("[AgenticManager] Task_AgenticNet loop running on Core %d\n", xPortGetCoreID());
#endif

    while (m_running) {
        const uint32_t nowMs = millis();

        // 1. Service VoiceStreamer audio uplink pipeline (mic sampling, VAD, uplink dispatch) strictly on Core 0
        VoiceStreamer::instance().update(nowMs);

        // 2. Telemetry watchdog: if no broadcast for > 10,000ms, mark disconnected
        if (m_telemetry.isConnected && (nowMs - m_telemetry.lastBroadcastMs > 10000)) {
#ifdef ESP32
            if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(10)) == pdTRUE) {
                m_telemetry.isConnected = false;
                xSemaphoreGive(m_mutex);
            }
#else
            m_telemetry.isConnected = false;
#endif
        }

        // 3. Cadence delay on Core 0 (10ms allows smooth 20ms mic frame delivery)
#ifdef ESP32
        vTaskDelay(pdMS_TO_TICKS(10));
#endif
    }
}

std::shared_ptr<IAppPage> createPcTelemetryHudPage() {
    return std::make_shared<PcTelemetryHudPage>();
}

} // namespace petbot::firmware::agentic
