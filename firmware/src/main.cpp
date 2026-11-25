#include <Arduino.h>
#ifdef ESP32
#include <esp_heap_caps.h>
#include <esp_system.h>
#include <esp_partition.h>
#endif
#include <cstdint>
#if defined(__has_include) && __has_include(<span>) && __cplusplus >= 202002L
#include <span>
#endif
#include <cstring>
#include <cstdlib>

#include "petbot_protocol.h"
#include "petbot_widget_bytecode.h"
#include "petbot/protocol/constants.hpp"
#include "petbot/protocol/frame_header.hpp"
#include "petbot/widget_schema/widget.hpp"
#include "config.h"
#include "hal/board_pins.h"
#include "hal/psram_allocator.h"
#include "hal/display_hal.h"
#include "hal/storage_hal.h"
#include "hal/audio_hal.h"
#include "hal/touch_hal.h"
#include "agentic/agentic_transport.h"
#include "agentic/widget_registry.h"
#include "agentic/widget_vm.h"
#include "agentic/sd_vault.h"
#include "agentic/voice_streamer.h"
#include "agentic/touch_2fa.h"
#include "agentic/ota_updater.h"
#include "agentic/agentic_manager.h"
#include "apps/builtin_pages.h"
#include <ArduinoJson.h>
#include "ui/ui_manager.h"
#include "ui/expression_engine.h"
#include "audio/sound_manager.h"

using namespace petbot::protocol::constants;
using namespace petbot::protocol;
using namespace petbot::widget_schema;
using namespace petbot::hal;
using namespace petbot::firmware;
using namespace petbot::firmware::agentic;
using namespace petbot::firmware::ui;
using namespace petbot::firmware::audio;

// Static assertions ensuring compile-time protocol and hardware invariants
static_assert(sizeof(PetBotFrameHeader) == 12, "PetBotFrameHeader wire layout must be exactly 12 bytes");
static_assert(FRAME_OVERHEAD_SIZE == 16, "Total frame overhead (Header + CRC32) must equal 16 bytes");
static_assert(DISPLAY_BUFFER_BYTES == 40960, "RGB565 frame buffer must equal 40,960 bytes");
static_assert(petbot::protocol::constants::AUDIO_FRAME_BYTES == 640, "Audio frame buffer must equal 640 bytes");
static_assert(sizeof(BleAdvBeaconPayload) == 16, "BleAdvBeaconPayload must equal 16 bytes");

#ifdef ESP32
static TaskHandle_t s_uiRenderTaskHandle{nullptr};
static TaskHandle_t s_touchPollTaskHandle{nullptr};
static TaskHandle_t s_storageWorkerTaskHandle{nullptr};

// ============================================================================
// Core 1 Real-Time UI Render Task (Priority 5, 60Hz via vTaskDelayUntil)
// ============================================================================
void Task_UIRender(void* pvParameters) {
    TickType_t xLastWakeTime = xTaskGetTickCount();
    constexpr TickType_t xFrequency = pdMS_TO_TICKS(16); // 16.6ms for 60FPS

    while (true) {
        const uint32_t frameStartUs = micros();
        const uint32_t nowMs = millis();

        // 1. Update UI carousel, active page, and procedural face rig
        UIManager::instance().update(nowMs);

        // 2. Render active page and transitions onto 128x160 PSRAM canvas
        auto& canvas = DisplayHal::instance().getCanvas();
        UIManager::instance().render(canvas);

        // 3. Dynamic backlight control matching pet attention state
        DisplayHal::instance().setBacklightPct(ExpressionEngine::instance().getTargetBacklightPct());

        // 4. Trigger non-blocking DMA flush
        DisplayHal::instance().swapAndFlushDMA();

        // 5. Calculate frame duration and filter live FPS telemetry
        const uint32_t frameTimeUs = micros() - frameStartUs;
        UIManager::instance().updateTelemetry(frameTimeUs);

        // Deterministic 60Hz loop timing
        vTaskDelayUntil(&xLastWakeTime, xFrequency);
    }
}

// ============================================================================
// Core 1 Touch Poll & Interaction Task (Priority 6, 200Hz via vTaskDelayUntil)
// ============================================================================
void Task_TouchPoll(void* pvParameters) {
    TickType_t xLastWakeTime = xTaskGetTickCount();
    constexpr TickType_t xFrequency = pdMS_TO_TICKS(5); // 5ms = 200Hz

    while (true) {
        TouchGestureEvent touchEv{};
        if (TouchHal::instance().getNextEvent(touchEv, 0)) {
            if (Touch2FAManager::instance().isModalActive()) {
                // Immediate preemption: physical touch sensors operate as hardware 2FA keys
                // Left = REJECT, Right = APPROVE, Side = DETAILS, Right Pinch = 2-Step
                Touch2FAManager::instance().handleTouch(touchEv);
            } else if (touchEv.gesture == TouchGesture::TripleTap) {
                // Triple Tap across all 3 sensors: Global Emergency Stop
                VoiceStreamer::instance().stopVoiceStream();
                ExpressionEngine::instance().setEmotion(EmotionId::Alert);
                UIManager::instance().showToast("EMERGENCY STOP!", 2000);
                AudioHal::instance().playProceduralSound(petbot::hal::SoundId::AlarmChime);
            } else if (touchEv.gesture == TouchGesture::TripleLongPress) {
                // Triple Long-Press: System diagnostics / SoftAP provisioning trigger
                ExpressionEngine::instance().setEmotion(EmotionId::Curious);
                UIManager::instance().showToast("Tri-Touch: Sys Reset", 2000);
                AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Chirp);
            } else if (touchEv.gesture == TouchGesture::PettingRapid || petbot::hal::isPettingGesture(touchEv.gesture)) {
                // 2-Sensor Happy Petting (Left / Right / Dual): Pure happy petting, no question mark
                if (touchEv.gesture == TouchGesture::LeftPetting) {
                    ExpressionEngine::instance().setTemporaryEmotion(EmotionId::Happy, 1500);
                    UIManager::instance().showToast("Left Ear Tickle! ^_^", 1500);
                } else if (touchEv.gesture == TouchGesture::RightPetting) {
                    ExpressionEngine::instance().setTemporaryEmotion(EmotionId::Happy, 1500);
                    UIManager::instance().showToast("Right Ear Tickle! ^_^", 1500);
                } else {
                    ExpressionEngine::instance().onPettingGesture();
                    UIManager::instance().showToast("Happy Petting! <3", 1800);
                }
            } else if (touchEv.gesture == TouchGesture::LeftDoubleTap) {
                // Left Double-Tap: Quick Return to Pet Home Living Face
                UIManager::instance().navigateToPage("home");
                AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Chirp);
                UIManager::instance().showToast("Pet Home", 1200);
            } else if (touchEv.gesture == TouchGesture::DoubleTap ||
                       touchEv.gesture == TouchGesture::SwipeLeftToRight ||
                       touchEv.gesture == TouchGesture::SwipeTopToSide ||
                       touchEv.gesture == TouchGesture::TripleRollClockwise ||
                       touchEv.gesture == TouchGesture::RightDoubleTap) {
                // Next Page Navigation
                UIManager::instance().nextPage();
            } else if (touchEv.gesture == TouchGesture::SwipeRightToLeft ||
                       touchEv.gesture == TouchGesture::SwipeSideToTop ||
                       touchEv.gesture == TouchGesture::TripleRollCounterClockwise) {
                // Previous Page Navigation
                UIManager::instance().prevPage();
            } else if (touchEv.gesture == TouchGesture::SideDoubleTap) {
                // Side Double-Tap: Configurable Everyday Quick Action (Default: AI Daily Briefing)
                const auto action = AgenticManager::instance().getSideDoubleTapAction();
                if (action == SideDoubleTapAction::MediaPlayPause) {
                    AgenticManager::instance().triggerMediaPlayPause();
                } else if (action == SideDoubleTapAction::NextWidget) {
                    UIManager::instance().nextPage();
                } else {
                    AgenticManager::instance().triggerQuickBriefing();
                }
            } else if (touchEv.gesture == TouchGesture::DualTap) {
                // Dual Head Tap: Quick Petting & Affection Boost
                ExpressionEngine::instance().onPettingGesture();
                AudioHal::instance().playProceduralSound(petbot::hal::SoundId::HappyTrill);
                UIManager::instance().showToast("Affection Boost! <3", 1500);
            } else if (touchEv.gesture == TouchGesture::DualLongPress) {
                // Dual Long-Press (Both Ears held >= 650ms): Night Light / Ambient Sleep Dimmer Toggle
                static bool s_nightMode = false;
                s_nightMode = !s_nightMode;
                if (s_nightMode) {
                    DisplayHal::instance().setBacklightPct(15);
                    ExpressionEngine::instance().setEmotion(EmotionId::Sleepy);
                    AudioHal::instance().playProceduralSound(petbot::hal::SoundId::SleepySigh);
                    UIManager::instance().showToast("Night Mode (15%)", 2000);
                } else {
                    DisplayHal::instance().setBacklightPct(100);
                    ExpressionEngine::instance().setEmotion(EmotionId::Happy);
                    AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Chirp);
                    UIManager::instance().showToast("Day Mode (100%)", 2000);
                }
            } else if (touchEv.gesture == TouchGesture::SideLongPress) {
                // Side Flank Long-Press (Natural thumb grip hold): Push-to-Talk AI Voice Assistant
                VoiceStreamer::instance().toggleVoiceStream();
                if (VoiceStreamer::instance().isVoiceStreaming()) {
                    ExpressionEngine::instance().setEmotion(EmotionId::Listening);
                    AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Tick);
                    UIManager::instance().showToast("AI Voice: Listening...", 2000);
                } else {
                    ExpressionEngine::instance().setEmotion(EmotionId::Speaking);
                    AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Chirp);
                    UIManager::instance().showToast("AI Voice: Processing...", 2000);
                }
            } else if (touchEv.gesture == TouchGesture::RightLongPress) {
                // Right Ear Long-Press: Instant 25-Min Deep Work Focus / Pomodoro Mode
                UIManager::instance().navigateToPage("pomodoro");
                auto pomoPage = std::static_pointer_cast<apps::PomodoroPage>(
                    UIManager::instance().getPageById("pomodoro")
                );
                if (pomoPage) {
                    pomoPage->startFocus();
                }
                ExpressionEngine::instance().setEmotion(EmotionId::Focused);
                AudioHal::instance().playProceduralSound(petbot::hal::SoundId::HappyTrill);
                UIManager::instance().showToast("Focus Mode: 25m ON", 2500);
            } else if (touchEv.gesture == TouchGesture::LeftLongPress) {
                // Left Ear Long-Press (2-sensor PTT): Start or Stop AI Voice Listening
                VoiceStreamer::instance().toggleVoiceStream();
            } else if (touchEv.gesture == TouchGesture::RightPinchTap || touchEv.gesture == TouchGesture::RightPinchLongPress ||
                       touchEv.gesture == TouchGesture::CrossChordTap || touchEv.gesture == TouchGesture::CrossChordLongPress) {
                // Keep speaker locked at maximum volume on 2-sensor layout
                AudioHal::instance().setVolumePct(100);
                UIManager::instance().showToast("Volume: MAX", 1000);
            } else {
                // LeftTap, RightTap, SideTap, SingleTap: Routed directly to active page
                UIManager::instance().handleTouch(touchEv);
            }
        }
        vTaskDelayUntil(&xLastWakeTime, xFrequency);
    }
}

// ============================================================================
// Core 0 Asynchronous Background Storage Worker Task (Priority 2)
// ============================================================================
void Task_StorageWorker(void* pvParameters) {
    while (true) {
        // Drain asynchronous file write queue so Flash/SD SPI latency never stalls Core 1 UI
        StorageHal::instance().processAsyncWrites();

        // Audio & network uplink processing strictly isolated to Core 0
        VoiceStreamer::instance().update(millis());

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
#endif

// ============================================================================
// Serial CLI Parser & Command Execution (Non-blocking on loop)
// ============================================================================
void executeCliCommand(const char* cmd) {
    if (cmd == nullptr || strlen(cmd) == 0) return;

    if (strcmp(cmd, "help") == 0) {
        Serial.println("\n--- PetBot Serial CLI Commands ---");
        Serial.println("  help         : Show this list of commands");
        Serial.println("  status       : Display system status, mode, heap, and active page");
        Serial.println("  tap          : Simulate single tap on active page");
        Serial.println("  doubletap    : Simulate double tap (cycle to next page)");
        Serial.println("  longpress    : Simulate long press on active page");
        Serial.println("  pet          : Simulate rapid petting interaction");
        Serial.println("  emotion <id> : Set pet emotion (0=IDLE..7=ALERT, 8=CONFUSED, etc.)");
        Serial.println("  diag         : Toggle live telemetry overlay (FPS, SRAM, PSRAM)");
        Serial.println("  notes        : Print Quick Notes state");
        Serial.println("  habits       : Print Habit Tracker state");
        Serial.println("  pomo         : Print Pomodoro timer status");
        Serial.println("  wifi <s> <p> : Connect to Wi-Fi SSID and password");
        Serial.println("  sim_2fa      : Inject simulated Touch 2FA challenge modal");
        Serial.println("  sim_widget   : Deploy simulated PBWG bytecode widget to PSRAM");
        Serial.println("  vault_list   : List all files vaulted in /sd/vault/ with SHA-256");
        Serial.println("  ota          : Print OTA partition and firmware update status");
        Serial.println("  setpin <name> <gpio> : Override GPIO pin in NVS ('setpin list' or 'setpin reset')");
        Serial.println("  getpin <name>        : Display current GPIO for a pin");
        Serial.println("  provision_json <data>: Provision Wi-Fi & Desktop Harness pairing secret via JSON");
        Serial.println("----------------------------------\n");
    } else if (strcmp(cmd, "status") == 0) {
        const auto mode = UIManager::instance().getRobotMode();
        const auto activePage = UIManager::instance().getActivePage();
        const size_t freeSram = PsramMemoryManager::getFreeDmaHeap();
        const size_t freePsram = PsramMemoryManager::getFreePsram();

        Serial.println("\n--- PetBot System Status ---");
        Serial.printf("  Uptime        : %lu seconds\n", static_cast<unsigned long>(millis() / 1000));
        Serial.printf("  Robot Mode    : %s\n", mode == RobotMode::AgenticConnected ? "AGENTIC_CONNECTED" : "NORMAL_OFFLINE");
        Serial.printf("  Active Page   : %s (\"%s\") [%u of %u]\n",
                      activePage ? activePage->getPageId() : "none",
                      activePage ? activePage->getPageTitle() : "none",
                      static_cast<unsigned int>(UIManager::instance().getActivePageIndex() + 1),
                      static_cast<unsigned int>(UIManager::instance().getPageCount()));
        Serial.printf("  Telemetry     : %s\n", UIManager::instance().isTelemetryEnabled() ? "ENABLED" : "DISABLED");
        Serial.printf("  Free SRAM     : %u bytes\n", static_cast<unsigned int>(freeSram));
        Serial.printf("  Free PSRAM    : %u bytes\n", static_cast<unsigned int>(freePsram));
        Serial.printf("  MicroSD Card  : %s\n", StorageHal::instance().isSdMounted() ? "MOUNTED (/sd)" : "NOT MOUNTED");
        Serial.printf("  LittleFS Flash: %s\n", StorageHal::instance().isLittleFsMounted() ? "MOUNTED (/flash)" : "NOT MOUNTED");
        Serial.println("----------------------------\n");
    } else if (strcmp(cmd, "tap") == 0) {
        TouchGestureEvent evt{TouchGesture::SingleTap, millis(), 100, 1};
        UIManager::instance().handleTouch(evt);
        Serial.println("[CLI] Dispatched Single Tap to active page.");
    } else if (strcmp(cmd, "doubletap") == 0) {
        UIManager::instance().nextPage();
        Serial.println("[CLI] Dispatched Double Tap -> Cycled to next page.");
    } else if (strcmp(cmd, "longpress") == 0) {
        TouchGestureEvent evt{TouchGesture::LongPress, millis(), 700, 1};
        UIManager::instance().handleTouch(evt);
        Serial.println("[CLI] Dispatched Long Press to active page.");
    } else if (strcmp(cmd, "pet") == 0) {
        ExpressionEngine::instance().onPettingGesture();
        UIManager::instance().showToast("Happy Petting! ^_^", 2000);
        Serial.println("[CLI] Dispatched Rapid Petting gesture.");
    } else if (strncmp(cmd, "emotion", 7) == 0) {
        const int emoId = atoi(cmd + 7);
        if (emoId >= 0 && emoId <= 11) {
            EmotionId target = EmotionId::Idle;
            switch (emoId) {
                case 0: target = EmotionId::Idle; break;
                case 1: target = EmotionId::Happy; break;
                case 2: target = EmotionId::Curious; break;
                case 3: target = EmotionId::Sleepy; break;
                case 4: target = EmotionId::Focused; break;
                case 5: target = EmotionId::Alert; break;
                case 6: target = EmotionId::Happy; break;
                case 7: target = EmotionId::Sleepy; break;
                case 8: target = EmotionId::Curious; break;
                case 9: target = EmotionId::Listening; break;
                case 10: target = EmotionId::Speaking; break;
                case 11: target = EmotionId::Focused; break;
                default: target = EmotionId::Idle; break;
            }
            ExpressionEngine::instance().setEmotion(target);
            Serial.printf("[CLI] Set Pet Emotion to ID %d (%u)\n", emoId, static_cast<uint8_t>(target));
        } else {
            Serial.println("[CLI] Invalid emotion ID (expected 0..11)");
        }
    } else if (strcmp(cmd, "diag") == 0) {
        UIManager::instance().toggleTelemetry();
        Serial.printf("[CLI] Telemetry overlay is now: %s\n",
                      UIManager::instance().isTelemetryEnabled() ? "ENABLED" : "DISABLED");
    } else if (strcmp(cmd, "notes") == 0) {
        auto notesPage = std::static_pointer_cast<apps::QuickNotesPage>(
            UIManager::instance().getPageById("notes")
        );
        if (notesPage) {
            const auto& notes = notesPage->getNotes();
            Serial.printf("\n--- Quick Notes (%u total, Active: #%u) ---\n",
                          notes.count, notesPage->getActiveNoteIndex() + 1);
            for (uint8_t i = 0; i < notes.count && i < 8; ++i) {
                Serial.printf("  [%u] %s%s\n      %s\n",
                              i + 1,
                              notes.items[i].title,
                              notes.items[i].pinned ? " [PINNED]" : "",
                              notes.items[i].body);
            }
            Serial.println("-----------------------------------------\n");
        } else {
            Serial.println("[CLI] Notes page not found.");
        }
    } else if (strcmp(cmd, "habits") == 0) {
        auto habitsPage = std::static_pointer_cast<apps::HabitTrackerPage>(
            UIManager::instance().getPageById("habits")
        );
        if (habitsPage) {
            const auto& habits = habitsPage->getHabits();
            Serial.printf("\n--- Habit Tracker (%u total, Selected: #%u) ---\n",
                          habits.count, habitsPage->getSelectedIndex() + 1);
            for (uint8_t i = 0; i < habits.count && i < 6; ++i) {
                Serial.printf("  [%u] %s [%s] Streak: %u days\n",
                              i + 1,
                              habits.items[i].title,
                              habits.items[i].completedToday ? "DONE" : "PENDING",
                              habits.items[i].streakDays);
            }
            Serial.println("-----------------------------------------------\n");
        } else {
            Serial.println("[CLI] Habits page not found.");
        }
    } else if (strcmp(cmd, "pomo") == 0) {
        auto pomoPage = std::static_pointer_cast<apps::PomodoroPage>(
            UIManager::instance().getPageById("pomodoro")
        );
        if (pomoPage) {
            const char* phaseStr = (pomoPage->getPhase() == apps::PomodoroPhase::Focus) ? "FOCUS" :
                                   (pomoPage->getPhase() == apps::PomodoroPhase::ShortBreak) ? "SHORT BREAK" : "LONG BREAK";
            const uint16_t rem = pomoPage->getRemainingSeconds();
            Serial.println("\n--- Pomodoro Timer Status ---");
            Serial.printf("  Phase          : %s\n", phaseStr);
            Serial.printf("  Running        : %s\n", pomoPage->isRunning() ? "YES" : "PAUSED");
            Serial.printf("  Remaining Time : %02u:%02u\n", rem / 60, rem % 60);
            Serial.printf("  Focus Today    : %u minutes\n", pomoPage->getTotalFocusMinutes());
            Serial.println("-----------------------------\n");
        } else {
            Serial.println("[CLI] Pomodoro page not found.");
        }
    } else if (strcmp(cmd, "voice") == 0 || strcmp(cmd, "ptt") == 0) {
        VoiceStreamer::instance().toggleVoiceStream();
        Serial.printf("[CLI] Voice streaming toggled. Active: %s\n",
                      VoiceStreamer::instance().isVoiceStreaming() ? "YES" : "NO");
    } else if (strcmp(cmd, "home") == 0) {
        UIManager::instance().navigateToPage("home");
        AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Chirp);
        UIManager::instance().showToast("Pet Home", 1200);
        Serial.println("[CLI] Navigated to Pet Home.");
    } else if (strcmp(cmd, "focus") == 0) {
        UIManager::instance().navigateToPage("pomodoro");
        auto pomoPage = std::static_pointer_cast<apps::PomodoroPage>(
            UIManager::instance().getPageById("pomodoro")
        );
        if (pomoPage) {
            pomoPage->startFocus();
        }
        ExpressionEngine::instance().setEmotion(EmotionId::Focused);
        AudioHal::instance().playProceduralSound(petbot::hal::SoundId::HappyTrill);
        UIManager::instance().showToast("Focus Mode: 25m ON", 2500);
        Serial.println("[CLI] Triggered 25-Min Deep Work Focus Mode.");
    } else if (strcmp(cmd, "memo") == 0) {
        ExpressionEngine::instance().setEmotion(EmotionId::Curious);
        AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Tick);
        UIManager::instance().showToast("Voice Memo: /sd/vault/", 2500);
        Serial.println("[CLI] Triggered Voice Memo to SD Vault.");
    } else if (strcmp(cmd, "mute") == 0) {
        const bool muted = !AudioHal::instance().isSpeakerMuted();
        AudioHal::instance().setSpeakerMute(muted);
        UIManager::instance().showToast(muted ? "Privacy: MUTED" : "Audio: UNMUTED", 2000);
        Serial.printf("[CLI] Audio mute toggled. Muted: %s\n", muted ? "YES" : "NO");
    } else if (strncmp(cmd, "wifi ", 5) == 0) {
        char ssid[33]{0};
        char pass[65]{0};
        const char* args = cmd + 5;
        const char* space = strchr(args, ' ');
        if (space != nullptr) {
            size_t ssidLen = space - args;
            if (ssidLen >= sizeof(ssid)) ssidLen = sizeof(ssid) - 1;
            strncpy(ssid, args, ssidLen);
            strncpy(pass, space + 1, sizeof(pass) - 1);
        } else {
            strncpy(ssid, args, sizeof(ssid) - 1);
        }
        AgenticTransport::instance().connectWifi(ssid, pass);
        Serial.printf("[CLI] Connecting Wi-Fi to SSID: \"%s\"...\n", ssid);
    } else if (strcmp(cmd, "2fa") == 0 || strcmp(cmd, "sim_2fa") == 0) {
        JsonDocument doc;
        doc["challengeId"] = "chal_sim_001";
        doc["actionTitle"] = "Deploy Production API";
        doc["riskTier"] = "TIER_3_2FA_REQUIRED";
        doc["expiresInMs"] = 15000;
        doc["nonce"] = "sim_nonce_1234567890abcdef12345678";
        std::vector<uint8_t> payload(measureMsgPack(doc));
        if (!payload.empty()) {
            serializeMsgPack(doc, payload.data(), payload.size());
        }
        Touch2FAManager::instance().handleChallenge(payload.data(), payload.size());
        Serial.println("[CLI] Injected simulated Touch 2FA challenge. Tap robot to approve or long-press to deny.");
    } else if (strcmp(cmd, "sim_widget") == 0) {
        JsonDocument doc;
        doc["widgetId"] = "crypto_ticker";
        doc["name"] = "Crypto Ticker";
        doc["version"] = 1;
        doc["author"] = "PetBot Agent";
        doc["persistToSd"] = false;

        JsonArray stateSlots = doc["stateSlots"].to<JsonArray>();
        JsonObject slot0 = stateSlots.add<JsonObject>();
        slot0["index"] = 0;
        slot0["name"] = "btc_price";
        slot0["type"] = static_cast<uint8_t>(petbot::widget::bytecode::StateVarType::String);
        slot0["initialValue"] = "$94,250";

        JsonObject root = doc["rootNode"].to<JsonObject>();
        root["type"] = static_cast<uint8_t>(petbot::widget::bytecode::NodeType::Container);
        root["x"] = 0;
        root["y"] = 0;
        root["width"] = 160;
        root["height"] = 128;
        root["backgroundColor"] = petbot::hal::colors::White;
        root["borderColor"] = petbot::hal::colors::DarkGray;
        root["borderWidth"] = 1;
        root["cornerRadius"] = 4;

        JsonArray children = root["children"].to<JsonArray>();

        JsonObject titleNode = children.add<JsonObject>();
        titleNode["type"] = static_cast<uint8_t>(petbot::widget::bytecode::NodeType::Text);
        titleNode["x"] = 8;
        titleNode["y"] = 10;
        titleNode["width"] = 144;
        titleNode["height"] = 16;
        titleNode["color"] = petbot::hal::colors::DarkGray;
        titleNode["fontSize"] = static_cast<uint8_t>(petbot::widget::bytecode::FontSize::Md);
        titleNode["align"] = static_cast<uint8_t>(petbot::widget::bytecode::TextAlign::Center);
        titleNode["text"] = "BTC / USD";

        JsonObject priceNode = children.add<JsonObject>();
        priceNode["type"] = static_cast<uint8_t>(petbot::widget::bytecode::NodeType::Text);
        priceNode["x"] = 8;
        priceNode["y"] = 30;
        priceNode["width"] = 144;
        priceNode["height"] = 20;
        priceNode["color"] = petbot::hal::colors::Black;
        priceNode["fontSize"] = static_cast<uint8_t>(petbot::widget::bytecode::FontSize::Lg);
        priceNode["align"] = static_cast<uint8_t>(petbot::widget::bytecode::TextAlign::Center);
        priceNode["text"] = "{{slot0}}";

        JsonObject sparkNode = children.add<JsonObject>();
        sparkNode["type"] = static_cast<uint8_t>(petbot::widget::bytecode::NodeType::Sparkline);
        sparkNode["x"] = 12;
        sparkNode["y"] = 56;
        sparkNode["width"] = 88;
        sparkNode["height"] = 30;
        sparkNode["color"] = petbot::hal::colors::Black;
        sparkNode["strokeWidth"] = 2;

        JsonObject petNode = children.add<JsonObject>();
        petNode["type"] = static_cast<uint8_t>(petbot::widget::bytecode::NodeType::PetExpression);
        petNode["x"] = 108;
        petNode["y"] = 56;
        petNode["width"] = 40;
        petNode["height"] = 36;
        petNode["emotion"] = static_cast<uint8_t>(petbot::widget::bytecode::EmotionType::Happy);

        std::vector<uint8_t> msgpackBytes(measureMsgPack(doc));
        if (!msgpackBytes.empty()) {
            serializeMsgPack(doc, msgpackBytes.data(), msgpackBytes.size());
        }

        const uint16_t crc = WidgetVM::computeCrc16(msgpackBytes.data(), msgpackBytes.size());

        std::vector<uint8_t> fullBytecode(8 + msgpackBytes.size());
        fullBytecode[0] = 'P';
        fullBytecode[1] = 'B';
        fullBytecode[2] = 'W';
        fullBytecode[3] = 'G';
        fullBytecode[4] = 0x01;
        fullBytecode[5] = 0x00;
        fullBytecode[6] = static_cast<uint8_t>(crc & 0xFF);
        fullBytecode[7] = static_cast<uint8_t>((crc >> 8) & 0xFF);
        memcpy(fullBytecode.data() + 8, msgpackBytes.data(), msgpackBytes.size());

        const bool deployed = WidgetRegistry::instance().handleWidgetDeployFrame(fullBytecode.data(), fullBytecode.size());
        if (deployed) {
            UIManager::instance().navigateToPage("crypto_ticker", true);
            Serial.println("[CLI] Simulated PBWG widget deployed and navigated successfully!");
        } else {
            Serial.println("[CLI] Failed to deploy simulated PBWG widget.");
        }
    } else if (strcmp(cmd, "vault_list") == 0) {
        const auto& files = SdVaultEngine::instance().getFiles();
        Serial.println("\n--- Stored Vault Files (/sd/vault/) ---");
        if (files.empty()) {
            Serial.println("  (No files vaulted yet)");
        } else {
            for (size_t i = 0; i < files.size(); ++i) {
                Serial.printf("  [%u] %s (%u bytes)\n      MIME: %s\n      SHA-256: %s\n      Thumb: %s\n",
                              static_cast<unsigned>(i + 1),
                              files[i].filename,
                              static_cast<unsigned>(files[i].sizeBytes),
                              files[i].mimeType,
                              files[i].sha256Hex,
                              files[i].hasThumbnail ? "YES" : "NO");
            }
        }
        Serial.println("----------------------------------------\n");
    } else if (strcmp(cmd, "ota") == 0) {
        Serial.println("\n--- OTA Firmware Status ---");
        Serial.printf("  Running Partition : %s\n", OtaUpdater::instance().getRunningPartitionLabel());
        Serial.printf("  OTA Updating Now  : %s\n", OtaUpdater::instance().isOtaActive() ? "YES" : "NO");
        if (OtaUpdater::instance().isOtaActive()) {
            Serial.printf("  Target Version    : %s\n", OtaUpdater::instance().getTargetVersion());
            Serial.printf("  Progress          : %u%%\n", OtaUpdater::instance().getProgressPercentage());
        }
        Serial.println("---------------------------\n");
    } else if (strncmp(cmd, "setpin", 6) == 0) {
        const char* args = cmd + 6;
        while (*args == ' ') args++;
        if (strlen(args) == 0 || strcmp(args, "list") == 0) {
            Serial.println("\n--- PetBot ESP32-S3 Pin Configuration ---");
            Serial.printf("  tft_mosi    : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_TFT_MOSI, petbot::hal::pins::DEFAULT_PIN_TFT_MOSI,
                          petbot::hal::pins::PIN_TFT_MOSI != petbot::hal::pins::DEFAULT_PIN_TFT_MOSI ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  tft_sclk    : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_TFT_SCLK, petbot::hal::pins::DEFAULT_PIN_TFT_SCLK,
                          petbot::hal::pins::PIN_TFT_SCLK != petbot::hal::pins::DEFAULT_PIN_TFT_SCLK ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  tft_cs      : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_TFT_CS, petbot::hal::pins::DEFAULT_PIN_TFT_CS,
                          petbot::hal::pins::PIN_TFT_CS != petbot::hal::pins::DEFAULT_PIN_TFT_CS ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  tft_dc      : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_TFT_DC, petbot::hal::pins::DEFAULT_PIN_TFT_DC,
                          petbot::hal::pins::PIN_TFT_DC != petbot::hal::pins::DEFAULT_PIN_TFT_DC ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  tft_rst     : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_TFT_RST, petbot::hal::pins::DEFAULT_PIN_TFT_RST,
                          petbot::hal::pins::PIN_TFT_RST != petbot::hal::pins::DEFAULT_PIN_TFT_RST ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  tft_bl      : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_TFT_BL, petbot::hal::pins::DEFAULT_PIN_TFT_BL,
                          petbot::hal::pins::PIN_TFT_BL != petbot::hal::pins::DEFAULT_PIN_TFT_BL ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  sd_cs       : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_SD_CS, petbot::hal::pins::DEFAULT_PIN_SD_CS,
                          petbot::hal::pins::PIN_SD_CS != petbot::hal::pins::DEFAULT_PIN_SD_CS ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  sd_mosi     : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_SD_MOSI, petbot::hal::pins::DEFAULT_PIN_SD_MOSI,
                          petbot::hal::pins::PIN_SD_MOSI != petbot::hal::pins::DEFAULT_PIN_SD_MOSI ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  sd_miso     : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_SD_MISO, petbot::hal::pins::DEFAULT_PIN_SD_MISO,
                          petbot::hal::pins::PIN_SD_MISO != petbot::hal::pins::DEFAULT_PIN_SD_MISO ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  sd_sclk     : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_SD_SCLK, petbot::hal::pins::DEFAULT_PIN_SD_SCLK,
                          petbot::hal::pins::PIN_SD_SCLK != petbot::hal::pins::DEFAULT_PIN_SD_SCLK ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  mic_bclk    : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_MIC_BCLK, petbot::hal::pins::DEFAULT_PIN_MIC_BCLK,
                          petbot::hal::pins::PIN_MIC_BCLK != petbot::hal::pins::DEFAULT_PIN_MIC_BCLK ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  mic_ws      : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_MIC_WS, petbot::hal::pins::DEFAULT_PIN_MIC_WS,
                          petbot::hal::pins::PIN_MIC_WS != petbot::hal::pins::DEFAULT_PIN_MIC_WS ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  mic_din     : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_MIC_DIN, petbot::hal::pins::DEFAULT_PIN_MIC_DIN,
                          petbot::hal::pins::PIN_MIC_DIN != petbot::hal::pins::DEFAULT_PIN_MIC_DIN ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  spk_bclk    : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_SPK_BCLK, petbot::hal::pins::DEFAULT_PIN_SPK_BCLK,
                          petbot::hal::pins::PIN_SPK_BCLK != petbot::hal::pins::DEFAULT_PIN_SPK_BCLK ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  spk_lrck    : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_SPK_LRCK, petbot::hal::pins::DEFAULT_PIN_SPK_LRCK,
                          petbot::hal::pins::PIN_SPK_LRCK != petbot::hal::pins::DEFAULT_PIN_SPK_LRCK ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  spk_dout    : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_SPK_DOUT, petbot::hal::pins::DEFAULT_PIN_SPK_DOUT,
                          petbot::hal::pins::PIN_SPK_DOUT != petbot::hal::pins::DEFAULT_PIN_SPK_DOUT ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  spk_sd_mode : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_SPK_SD_MODE, petbot::hal::pins::DEFAULT_PIN_SPK_SD_MODE,
                          petbot::hal::pins::PIN_SPK_SD_MODE != petbot::hal::pins::DEFAULT_PIN_SPK_SD_MODE ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  touch_left  : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_TOUCH_LEFT, petbot::hal::pins::DEFAULT_PIN_TOUCH_LEFT,
                          petbot::hal::pins::PIN_TOUCH_LEFT != petbot::hal::pins::DEFAULT_PIN_TOUCH_LEFT ? "OVERRIDDEN" : "DEFAULT");
            Serial.printf("  touch_right : GPIO %2d (default %2d) [%s]\n",
                          petbot::hal::pins::PIN_TOUCH_RIGHT, petbot::hal::pins::DEFAULT_PIN_TOUCH_RIGHT,
                          petbot::hal::pins::PIN_TOUCH_RIGHT != petbot::hal::pins::DEFAULT_PIN_TOUCH_RIGHT ? "OVERRIDDEN" : "DEFAULT");
            Serial.println("-----------------------------------------\n");
        } else if (strcmp(args, "reset") == 0) {
            petbot::hal::pins::resetPinOverrides();
            Serial.println("[Pins] All pin overrides reset to defaults in NVS namespace \"pins\". Reboot to apply.");
        } else {
            char name[32]{0};
            int gpio = -1;
            if (sscanf(args, "%31s %d", name, &gpio) == 2) {
                if (gpio >= 0 && gpio <= 48 && petbot::hal::pins::setPinOverride(name, gpio)) {
                    Serial.printf("[Pins] Pin '%s' successfully set to GPIO %d in NVS namespace \"pins\". Reboot or reinitialize to apply.\n", name, gpio);
                } else {
                    Serial.printf("[Pins] Invalid pin override request: '%s' -> GPIO %d\n", name, gpio);
                }
            } else {
                Serial.println("[Pins] Usage: 'setpin <name> <gpio>', 'setpin list', or 'setpin reset'");
            }
        }
    } else if (strncmp(cmd, "getpin", 6) == 0) {
        const char* name = cmd + 6;
        while (*name == ' ') name++;
        if (strlen(name) == 0) {
            Serial.println("[Pins] Usage: getpin <name>");
        } else {
            Serial.printf("[Pins] Queried pin '%s'\n", name);
        }
    } else if (strncmp(cmd, "provision_json ", 15) == 0 || strncmp(cmd, "provision_json", 14) == 0) {
        const char* jsonStr = cmd + 14;
        while (*jsonStr == ' ') jsonStr++;
        JsonDocument doc;
        DeserializationError err = deserializeJson(doc, jsonStr);
        if (!err) {
            const char* ssid = doc["ssid"] | "";
            const char* pass = doc["password"] | "";
            const char* host = doc["host"] | doc["ip"] | "";
            const uint16_t port = doc["port"] | DEFAULT_WS_PORT;
            const char* secretHex = doc["secret"] | doc["sharedSecret"] | "";
            const char* pairingKey = doc["pairingKey"] | "";

            // 1. Store credentials into NVS namespace "petbot_prov"
#ifdef ESP32
            Preferences provPrefs;
            if (provPrefs.begin("petbot_prov", false)) {
                if (strlen(ssid) > 0) provPrefs.putString("ssid", ssid);
                if (strlen(pass) > 0) provPrefs.putString("password", pass);
                if (strlen(host) > 0) provPrefs.putString("host", host);
                if (port > 0) provPrefs.putUShort("port", port);
                if (strlen(secretHex) > 0) provPrefs.putString("secret", secretHex);
                if (strlen(pairingKey) > 0) provPrefs.putString("pairingKey", pairingKey);
                provPrefs.end();
            }
#endif

            // 2. Configure 32-byte hardware device secret if supplied in 64-character hex
            bool secretConfigured = false;
            if (strlen(secretHex) == 64) {
                uint8_t secretBytes[32]{0};
                for (size_t b = 0; b < 32; ++b) {
                    char hexByte[3] = {secretHex[b * 2], secretHex[b * 2 + 1], '\0'};
                    secretBytes[b] = static_cast<uint8_t>(strtol(hexByte, nullptr, 16));
                }
                secretConfigured = Touch2FAManager::instance().setDeviceSecret(secretBytes, 32);
            }

            // 3. Output JSON acknowledgment over serial
            Serial.printf("{\"status\":\"PROVISION_OK\",\"ssid\":\"%s\",\"host\":\"%s\",\"port\":%u,\"secretConfigured\":%s,\"msg\":\"Credentials persisted to NVS namespace 'petbot_prov'. Connecting immediately.\"}\n",
                          ssid, host, port, secretConfigured ? "true" : "false");

            // 4. Initiate Wi-Fi & Outbound Harness connection immediately
            if (strlen(ssid) > 0) {
                AgenticTransport::instance().connectWifi(ssid, pass);
            }
            if (strlen(host) > 0) {
                AgenticTransport::instance().connectOutbound(host, port, "/ws");
            }
        } else {
            Serial.printf("{\"status\":\"PROVISION_ERROR\",\"error\":\"JSON parse failed: %s\"}\n", err.c_str());
        }
    } else if (strncmp(cmd, "rotation ", 9) == 0) {
        const uint8_t rot = static_cast<uint8_t>(atoi(cmd + 9) & 0x03);
        DisplayHal::instance().setRotation(rot);
#ifdef ESP32
        Preferences cfgPrefs;
        if (cfgPrefs.begin("petbot_cfg", false)) {
            cfgPrefs.putUChar("disp_rot", rot);
            cfgPrefs.end();
        }
#endif
        Serial.printf("[CLI] Display rotation set to %u (1=Landscape pins-left, 3=Inverted Landscape).\n", rot);
    } else {
        Serial.printf("[CLI] Unknown command: \"%s\". Type 'help' for available commands.\n", cmd);
    }
}

void processSerialCli() {
    static char cliBuffer[1024]{0};
    static size_t cliIndex = 0;

    while (Serial.available() > 0) {
        const char c = static_cast<char>(Serial.read());
        if (c == '\r' || c == '\n') {
            if (cliIndex > 0) {
                cliBuffer[cliIndex] = '\0';
                executeCliCommand(cliBuffer);
                cliIndex = 0;
            }
        } else if (cliIndex < sizeof(cliBuffer) - 1) {
            cliBuffer[cliIndex++] = c;
        }
    }
}

// ============================================================================
// Arduino Boot Setup
// ============================================================================
void setup() {
    Serial.begin(115200);
    delay(100);

    Serial.println("\n==================================================");
    Serial.println("  ESP32-S3 AI Desktop Pet Robot System Init");
    Serial.println("==================================================");

    // Early NVS pin override loading (NVS namespace "pins")
    petbot::hal::pins::loadPinOverrides();
    Serial.println("[Pins] Loaded GPIO pin configuration (NVS namespace \"pins\").");

    // 1. Initialize Serial (115200 baud), verify 8MB Octal PSRAM availability (ESP.getPsramSize()), and print detailed memory/partition report
    const bool psramOk = PsramMemoryManager::isPsramAvailable();
#ifdef ESP32
    const size_t psramSize = ESP.getPsramSize();
    const size_t freePsram = ESP.getFreePsram();
    Serial.printf("[PSRAM] Octal PSRAM Available: %s (Total: %u bytes, Free: %u bytes)\n",
                  psramOk ? "YES" : "NO",
                  static_cast<unsigned int>(psramSize),
                  static_cast<unsigned int>(freePsram));
    Serial.printf("[Memory Report] Internal Heap: %u / %u bytes (Free / Total)\n",
                  static_cast<unsigned int>(ESP.getFreeHeap()),
                  static_cast<unsigned int>(ESP.getHeapSize()));

    // Early partition health check and OTA rollback management
    OtaUpdater::instance().initOnBoot();

    // Detailed partition report
    Serial.println("\n--- ESP32-S3 Flash Partition Table ---");
    esp_partition_iterator_t it = esp_partition_find(ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, NULL);
    while (it != NULL) {
        const esp_partition_t* part = esp_partition_get(it);
        if (part != nullptr) {
            Serial.printf("  [Partition] %-12s | Type: 0x%02x | SubType: 0x%02x | Offset: 0x%06lx | Size: %7lu KB\n",
                          part->label,
                          part->type,
                          part->subtype,
                          static_cast<unsigned long>(part->address),
                          static_cast<unsigned long>(part->size / 1024));
        }
        it = esp_partition_next(it);
    }
    esp_partition_iterator_release(it);
    Serial.println("--------------------------------------\n");
#else
    Serial.printf("[PSRAM] Octal PSRAM Available: %s (Total: %u bytes, Free: %u bytes)\n",
                  psramOk ? "YES" : "NO",
                  static_cast<unsigned int>(PsramMemoryManager::getTotalPsram()),
                  static_cast<unsigned int>(PsramMemoryManager::getFreePsram()));
#endif

    // Check capacitive touch sensor during boot: if held, enable telemetry
    pinMode(pins::PIN_TOUCH_SENSOR, INPUT_PULLDOWN);
    const bool touchHeldAtBoot = (digitalRead(pins::PIN_TOUCH_SENSOR) == HIGH);
    if (touchHeldAtBoot) {
        UIManager::instance().setTelemetryEnabled(true);
        Serial.println("[Boot] Capacitive Touch Sensor HELD at boot -> Live Telemetry Overlay ENABLED.");
    }

    // 2. Initialize StorageHal (SD Card with LittleFS fallback) and load persisted RTC/Notes/Habits state
    StorageHal::instance().init();
    StorageHal::instance().ensureStandardDirectories();
    Serial.println("[Storage] Initialized StorageHal (SD Card with LittleFS fallback) and ensured directories.");

    // 3. Initialize DisplayHal in 160x128 Horizontal Landscape (pins on LEFT), play crisp white wakeup animation
    DisplayHal::instance().init();
#ifdef ESP32
    {
        Preferences cfgPrefs;
        if (cfgPrefs.begin("petbot_cfg", true)) {
            if (cfgPrefs.isKey("disp_rot")) {
                const uint8_t savedRot = cfgPrefs.getUChar("disp_rot", 1) & 0x03;
                if (savedRot != 1) {
                    DisplayHal::instance().setRotation(savedRot);
                }
            }
            cfgPrefs.end();
        }
    }
#endif
    AudioHal::instance().init(); // Spawns Task_AudioEngine on Core 0, Priority 4

    // Confirm running app is healthy once storage and display are initialized
    OtaUpdater::instance().confirmRunningAppValid();
    Serial.println("[Boot] Playing 1.2s 60FPS Wakeup Boot Animation on 160x128 white canvas...");
    AudioHal::instance().playProceduralSound(petbot::hal::SoundId::Chirp);

    ExpressionEngine::instance().setEmotion(EmotionId::Sleepy, true);
    auto& canvas = DisplayHal::instance().getCanvas();

    constexpr uint32_t BOOT_ANIM_DURATION_MS = 1200;
    constexpr uint32_t BOOT_ANIM_FRAME_MS = 16;
    constexpr uint32_t BOOT_ANIM_FRAMES = BOOT_ANIM_DURATION_MS / BOOT_ANIM_FRAME_MS; // ~75 frames

    const uint32_t animStartMs = millis();
    for (uint32_t frame = 0; frame < BOOT_ANIM_FRAMES; ++frame) {
        const uint32_t now = millis();
        const float t = static_cast<float>(now - animStartMs) / static_cast<float>(BOOT_ANIM_DURATION_MS);

        if (t >= 0.35f && ExpressionEngine::instance().getEmotion() == EmotionId::Sleepy) {
            // Pet eyes waking up and blinking open
            ExpressionEngine::instance().setEmotion(EmotionId::Happy);
        }

        ExpressionEngine::instance().update(now);
        canvas.clear(colors::White);
        ExpressionEngine::instance().render(canvas);
        DisplayHal::instance().setBacklightPct(std::clamp<uint8_t>(static_cast<uint8_t>(t * 100.0f), 20, 100));
        DisplayHal::instance().swapAndFlushDMA();
        DisplayHal::instance().waitForFlushDone(50);
        delay(BOOT_ANIM_FRAME_MS);
    }
    ExpressionEngine::instance().setEmotion(EmotionId::Idle);

    // 4. Initialize TouchHal and UIManager (loads persisted RTC, Notes, Habits on page init)
    TouchHal::instance().init();
    UIManager::instance().init();
    SoundManager::instance().init();

    // 5. Initialize Central Agentic Orchestrator (Transport, Widgets, SD Vault, Voice AI, Touch 2FA, PC Telemetry HUD)
    TransportConfig transportConfig;
    transportConfig.wsPort = DEFAULT_WS_PORT;
    transportConfig.mdnsHostname = "petbot";
    transportConfig.bleDeviceName = "PetBot-Agent";
    transportConfig.ringBufferBytes = 256 * 1024;
    transportConfig.heartbeatIntervalMs = 3000;
    transportConfig.heartbeatTimeoutMs = 6000;

    SdVaultEngine::instance().init();
    UIManager::instance().registerPage(createSdVaultPage());
    VoiceStreamer::instance().init();
    Touch2FAManager::instance().init();
    OtaUpdater::instance().init();
    AgenticManager::instance().init(transportConfig);

    // Auto-connect provisioned Wi-Fi and Desktop Harness from NVS namespace "petbot_prov"
#ifdef ESP32
    Preferences provPrefs;
    if (provPrefs.begin("petbot_prov", true)) {
        String savedSsid = provPrefs.getString("ssid", "");
        String savedPass = provPrefs.getString("password", "");
        String savedHost = provPrefs.getString("host", "");
        uint16_t savedPort = provPrefs.getUShort("port", DEFAULT_WS_PORT);
        provPrefs.end();

        if (savedSsid.length() > 0) {
            Serial.printf("[Boot] Auto-connecting to provisioned Wi-Fi SSID '%s'...\n", savedSsid.c_str());
            AgenticTransport::instance().connectWifi(savedSsid.c_str(), savedPass.c_str());
            if (savedHost.length() > 0) {
                Serial.printf("[Boot] Auto-connecting outbound to provisioned Desktop Harness ws://%s:%u/ws...\n", savedHost.c_str(), savedPort);
                AgenticTransport::instance().connectOutbound(savedHost.c_str(), savedPort, "/ws");
            }
        }
    }
#endif

    // 6. Spawn and pin Task_UIRender (Core 1), Task_TouchPoll (Core 1), Task_AudioEngine (Core 0), and Task_StorageWorker (Core 0)
#ifdef ESP32
    // Task_UIRender (Priority 5, Core 1): Deterministic 60Hz loop
    xTaskCreatePinnedToCore(
        Task_UIRender,
        "Task_UIRender",
        6144,
        nullptr,
        5,
        &s_uiRenderTaskHandle,
        1 // Core 1 (UI & Rendering)
    );

    // Task_TouchPoll (Priority 6, Core 1): 200Hz Gesture Dispatcher
    xTaskCreatePinnedToCore(
        Task_TouchPoll,
        "Task_TouchPoll",
        3072,
        nullptr,
        6,
        &s_touchPollTaskHandle,
        1 // Core 1 (Interaction Core)
    );

    // Task_StorageWorker (Priority 2, Core 0): Asynchronous Background Storage Writer
    xTaskCreatePinnedToCore(
        Task_StorageWorker,
        "Task_StorageWorker",
        4096,
        nullptr,
        2,
        &s_storageWorkerTaskHandle,
        0 // Core 0 (Storage & Network Core)
    );
#endif

    Serial.println("[System] FreeRTOS Dual-Core Tasks active. Entering non-blocking Serial CLI loop.");
}

// ============================================================================
// Arduino Main Loop (Runs on Core 1 at Priority 1)
// ============================================================================
void loop() {
    // Process Non-blocking Serial CLI commands
    processSerialCli();

    const uint32_t now = millis();

    // Direct loop update for Voice Streamer and Touch 2FA FSM
    VoiceStreamer::instance().update(now);
    Touch2FAManager::instance().update(now);

    // Heartbeat log every 2000ms
    static uint32_t last_heartbeat = 0;
    if (now - last_heartbeat >= 2000) {
        last_heartbeat = now;
        const size_t free_sram = PsramMemoryManager::getFreeDmaHeap();
        const size_t free_psram = PsramMemoryManager::getFreePsram();
        const auto mode = UIManager::instance().getRobotMode();

        Serial.printf("[Heartbeat][Core 1] Mode: %s | Free SRAM: %u bytes | Free PSRAM: %u bytes\n",
                      mode == RobotMode::AgenticConnected ? "AGENTIC_CONNECTED" : "NORMAL_OFFLINE",
                      static_cast<unsigned int>(free_sram),
                      static_cast<unsigned int>(free_psram));
    }

    delay(10);
}