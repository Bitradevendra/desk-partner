#include "agentic/automation_host.h"
#include "agentic/agentic_transport.h"
#include "agentic/touch_2fa.h"
#include "ui/ui_manager.h"
#include "ui/expression_engine.h"
#include "hal/audio_hal.h"
#include "hal/storage_hal.h"
#include "hal/display_hal.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <cstring>
#include <algorithm>

namespace petbot::firmware::agentic {

namespace colors = petbot::hal::colors;
namespace hal = ::petbot::hal;

AutomationHost& AutomationHost::instance() noexcept {
    static AutomationHost s_instance;
    return s_instance;
}

AutomationHost::AutomationHost() {
#ifdef ESP32
    m_mutex = xSemaphoreCreateMutex();
#endif
}

bool AutomationHost::init() {
    if (m_initialized) {
        return true;
    }

    Serial.println("[AutomationHost] Initializing Zero-Code Automation Host...");

    // Try to restore saved automations from SD Vault or Flash
    bool loaded = loadFromStorage();

    // If no hosted automations found, register default presets
    if (!loaded || m_automations.empty()) {
        HostedAutomationRecord vipBriefing;
        vipBriefing.id = "auto_morning_vip";
        vipBriefing.name = "Morning VIP Briefing";
        vipBriefing.description = "Summarize VIP WhatsApp and day's priorities at 8:30 AM";
        vipBriefing.triggerType = AutomationTriggerType::ScheduleCron;
        vipBriefing.cronHour = 8;
        vipBriefing.cronMinute = 30;
        vipBriefing.cronDaysMask = 0x3E; // Mon-Fri
        vipBriefing.runOfflineOnRtc = true;
        vipBriefing.humanSchedule = "Weekdays at 8:30 AM";
        vipBriefing.headerBadge = "VIP BRIEF";
        vipBriefing.cardTitle = "Morning VIP";
        vipBriefing.cardSubtitle = "3 priorities ready";
        vipBriefing.accentColorRgb565 = colors::Green;
        vipBriefing.emotion = EmotionId::Happy;
        vipBriefing.soundId = hal::SoundId::HappyTrill;
        vipBriefing.requires2Fa = false;
        vipBriefing.offlineVaultPath = "/sd/vault/automations/vip_briefings.log";

        HostedAutomationRecord focusMode;
        focusMode.id = "auto_focus_pomodoro";
        focusMode.name = "Focus Mode Deep Work";
        focusMode.description = "Double-tap robot to close distracting tabs, silence phone & focus";
        focusMode.triggerType = AutomationTriggerType::RobotTouchGesture;
        focusMode.touchGesture = TouchGesture::DoubleTap;
        focusMode.headerBadge = "FOCUS";
        focusMode.cardTitle = "Deep Work";
        focusMode.cardSubtitle = "45m Pomodoro";
        focusMode.accentColorRgb565 = colors::Cyan;
        focusMode.emotion = EmotionId::Focused;
        focusMode.soundId = hal::SoundId::Chirp;
        focusMode.requires2Fa = false;
        focusMode.offlineVaultPath = "/sd/vault/automations/focus.log";

        m_automations.push_back(std::move(vipBriefing));
        m_automations.push_back(std::move(focusMode));
    }

    m_initialized = true;
    Serial.printf("[AutomationHost] Ready with %u hosted automations.\n", (unsigned)m_automations.size());
    return true;
}

bool AutomationHost::registerAutomation(HostedAutomationRecord record) {
#ifdef ESP32
    if (m_mutex && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) == pdTRUE)
#endif
    {
        // Check if automation already exists, replace if so
        auto it = std::find_if(m_automations.begin(), m_automations.end(),
                               [&](const HostedAutomationRecord& a) { return a.id == record.id; });

        if (it != m_automations.end()) {
            *it = std::move(record);
            Serial.printf("[AutomationHost] Updated automation: %s\n", it->id.c_str());
        } else {
            m_automations.push_back(std::move(record));
            Serial.printf("[AutomationHost] Registered new automation: %s\n", m_automations.back().id.c_str());
        }

#ifdef ESP32
        if (m_mutex) xSemaphoreGive(m_mutex);
#endif
        saveToStorage();
        return true;
    }
    return false;
}

bool AutomationHost::unregisterAutomation(std::string_view id) {
#ifdef ESP32
    if (m_mutex && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) == pdTRUE)
#endif
    {
        auto it = std::find_if(m_automations.begin(), m_automations.end(),
                               [&](const HostedAutomationRecord& a) { return a.id == id; });

        if (it != m_automations.end()) {
            m_automations.erase(it);
#ifdef ESP32
            if (m_mutex) xSemaphoreGive(m_mutex);
#endif
            saveToStorage();
            return true;
        }

#ifdef ESP32
        if (m_mutex) xSemaphoreGive(m_mutex);
#endif
    }
    return false;
}

const HostedAutomationRecord* AutomationHost::findById(std::string_view id) const {
    for (const auto& a : m_automations) {
        if (a.id == id) {
            return &a;
        }
    }
    return nullptr;
}

bool AutomationHost::handleTouchGesture(TouchGesture gesture) {
    if (gesture == TouchGesture::None) return false;

    // Check if 2FA modal is currently active; if so, don't trigger automations
    if (Touch2FAManager::instance().isModalActive()) {
        return false;
    }

    for (auto& a : m_automations) {
        if (a.triggerType == AutomationTriggerType::RobotTouchGesture &&
            a.touchGesture == gesture) {
            Serial.printf("[AutomationHost] Touch gesture %u matched automation: %s\n",
                          (unsigned)gesture, a.name.c_str());
            executeAutomation(a);
            return true;
        }
    }
    return false;
}

bool AutomationHost::checkRtcSchedule(uint8_t hour, uint8_t minute, uint8_t dayOfWeek) {
    bool executedAny = false;

    for (auto& a : m_automations) {
        if (a.triggerType == AutomationTriggerType::ScheduleCron && a.runOfflineOnRtc) {
            const bool dayMatches = (a.cronDaysMask & (1 << dayOfWeek)) != 0;
            if (dayMatches && a.cronHour == hour && a.cronMinute == minute) {
                // Avoid double-firing within the same minute
                const uint32_t now = millis();
                if (now - a.lastTriggeredMs > 65000) {
                    Serial.printf("[AutomationHost] RTC cron trigger matched automation: %s (%02u:%02u)\n",
                                  a.name.c_str(), hour, minute);
                    executeAutomation(a);
                    executedAny = true;
                }
            }
        }
    }
    return executedAny;
}

AutomationExecutionResult AutomationHost::executeAutomation(std::string_view id) {
    auto* rec = const_cast<HostedAutomationRecord*>(findById(id));
    if (!rec) {
        AutomationExecutionResult res;
        res.success = false;
        std::snprintf(res.message, sizeof(res.message), "Automation not found");
        return res;
    }
    return executeAutomation(*rec);
}

AutomationExecutionResult AutomationHost::executeAutomation(HostedAutomationRecord& record) {
    AutomationExecutionResult res;
    record.lastTriggeredMs = millis();
    record.executionCount++;

    const bool isConnected = AgenticTransport::instance().getRobotMode() == RobotMode::AgenticConnected;

    // 1. ONLINE EXECUTION: Forward to Desktop or Mobile Harness over WebSocket
    if (isConnected) {
        Serial.printf("[AutomationHost] Online mode: Forwarding automation %s to Harness RPC...\n", record.id.c_str());

        JsonDocument doc;
        doc["method"] = "trigger_automation";
        JsonObject params = doc["params"].to<JsonObject>();
        params["automationId"] = record.id;
        params["name"] = record.name;
        params["source"] = "ESP32_PHYSICAL_TOUCH";

        uint8_t payloadBuf[256];
        const size_t payloadLen = serializeMsgPack(doc, payloadBuf, sizeof(payloadBuf));

        if (payloadLen > 0) {
            AgenticTransport::instance().sendFrame(
                FrameType::HarnessRpcReq,
                payloadBuf,
                payloadLen
            );
            res.executedOnline = true;
            res.success = true;
            std::snprintf(res.message, sizeof(res.message), "Dispatched to Harness");
        }

        // Procedural feedback tone & screen toast
        hal::AudioHal::instance().playProceduralSound(hal::SoundId::Chirp);
        ui::UIManager::instance().showToast(record.name.c_str(), 1800);
        return res;
    }

    // 2. OFFLINE EXECUTION: Autonomous on-device actions
    Serial.printf("[AutomationHost] Offline autonomous execution: %s\n", record.name.c_str());
    res.executedOffline = true;

    // Check physical 2FA gating
    if (record.requires2Fa) {
        res.requires2FaTriggered = true;
        Serial.println("[AutomationHost] Requires physical 2FA touch confirmation.");
    }

    // Render 128x160 Card on ST7735S display
    auto& canvas = hal::DisplayHal::instance().getCanvas();
    renderAutomationCard(canvas, record);
    hal::DisplayHal::instance().swapAndFlushDMA();

    // Procedural sound
    hal::AudioHal::instance().playProceduralSound(record.soundId);

    // Set pet emotion expression
    ui::ExpressionEngine::instance().setEmotion(record.emotion);

    // Log to MicroSD Vault if mounted
    if (hal::StorageHal::instance().isSdMounted()) {
        char logLine[128];
        std::snprintf(logLine, sizeof(logLine), "[%lu] Executed: %s (Count: %u)\n",
                      (unsigned long)record.lastTriggeredMs, record.name.c_str(), record.executionCount);
        hal::StorageHal::instance().appendFile(record.offlineVaultPath.c_str(),
                                              reinterpret_cast<const uint8_t*>(logLine),
                                              std::strlen(logLine));
    }

    res.success = true;
    std::snprintf(res.message, sizeof(res.message), "Executed offline");
    return res;
}

void AutomationHost::renderAutomationCard(Canvas128x160& canvas, const HostedAutomationRecord& record) {
    canvas.clear(colors::Black);

    // 1. Header Banner with Accent Color (160x128 landscape)
    canvas.fillRect(0, 0, 160, 18, record.accentColorRgb565);
    canvas.drawFastHLine(0, 18, 160, colors::White);
    canvas.drawText(6, 5, record.headerBadge.c_str(), colors::Black, record.accentColorRgb565, 1, true);

    // 2. Title & Subtitle Card Container
    canvas.fillRoundRect(6, 22, 148, 42, 4, colors::Navy);
    canvas.drawRoundRect(6, 22, 148, 42, 4, record.accentColorRgb565);

    canvas.drawText(12, 28, record.cardTitle.c_str(), colors::White, colors::Navy, 1, true);
    canvas.drawText(12, 44, record.cardSubtitle.c_str(), colors::Cyan, colors::Navy, 1, false);

    // 3. Central Emotion indicator
    canvas.fillRoundRect(20, 68, 120, 36, 6, colors::DarkGray);
    canvas.drawRoundRect(20, 68, 120, 36, 6, colors::Cyan);
    canvas.fillCircle(58, 86, 7, record.accentColorRgb565);
    canvas.fillCircle(102, 86, 7, record.accentColorRgb565);
    canvas.fillCircle(60, 84, 2, colors::White);
    canvas.fillCircle(104, 84, 2, colors::White);

    // 4. Bottom Footer Status Bar
    canvas.fillRect(0, 110, 160, 18, colors::Navy);
    canvas.drawFastHLine(0, 110, 160, record.accentColorRgb565);

    char footerBuf[32];
    std::snprintf(footerBuf, sizeof(footerBuf), "RUN #%u | READY", record.executionCount);
    canvas.drawText(12, 115, footerBuf, colors::White, colors::Navy, 1, true);
}

bool AutomationHost::saveToStorage() {
    if (!hal::StorageHal::instance().isSdMounted() && !hal::StorageHal::instance().isLittleFsMounted()) {
        return false;
    }

    JsonDocument doc;
    JsonArray arr = doc["automations"].to<JsonArray>();

    for (const auto& a : m_automations) {
        JsonObject obj = arr.add<JsonObject>();
        obj["id"] = a.id;
        obj["name"] = a.name;
        obj["description"] = a.description;
        obj["triggerType"] = static_cast<uint8_t>(a.triggerType);
        obj["touchGesture"] = static_cast<uint8_t>(a.touchGesture);
        obj["cronHour"] = a.cronHour;
        obj["cronMinute"] = a.cronMinute;
        obj["cronDaysMask"] = a.cronDaysMask;
        obj["runOfflineOnRtc"] = a.runOfflineOnRtc;
        obj["humanSchedule"] = a.humanSchedule;
        obj["headerBadge"] = a.headerBadge;
        obj["cardTitle"] = a.cardTitle;
        obj["cardSubtitle"] = a.cardSubtitle;
        obj["accentColor"] = a.accentColorRgb565;
        obj["emotion"] = static_cast<uint8_t>(a.emotion);
        obj["soundId"] = static_cast<uint8_t>(a.soundId);
        obj["requires2Fa"] = a.requires2Fa;
        obj["offlineVaultPath"] = a.offlineVaultPath;
    }

    char jsonBuf[2048];
    const size_t len = serializeJson(doc, jsonBuf, sizeof(jsonBuf));
    if (len == 0) return false;

    hal::StorageHal::instance().mkdir("/sd/vault/automations");
    return hal::StorageHal::instance().writeFileAtomic(
        "/sd/vault/automations/registry.json",
        reinterpret_cast<const uint8_t*>(jsonBuf),
        len,
        false
    );
}

bool AutomationHost::loadFromStorage() {
    if (!hal::StorageHal::instance().isSdMounted() && !hal::StorageHal::instance().isLittleFsMounted()) {
        return false;
    }

    size_t readLen = 0;
    uint8_t* rawBuf = hal::StorageHal::instance().readFileToPsram(
        "/sd/vault/automations/registry.json", &readLen, nullptr, false
    );
    if (rawBuf == nullptr || readLen == 0) {
        if (rawBuf != nullptr) hal::StorageHal::instance().freeBuffer(rawBuf);
        return false;
    }

    JsonDocument doc;
    const DeserializationError err = deserializeJson(doc, rawBuf, readLen);
    hal::StorageHal::instance().freeBuffer(rawBuf);
    if (err) {
        Serial.printf("[AutomationHost] JSON parse error: %s\n", err.c_str());
        return false;
    }

    JsonArray arr = doc["automations"].as<JsonArray>();
    if (arr.isNull() || arr.size() == 0) {
        return false;
    }

    m_automations.clear();
    for (JsonObject obj : arr) {
        HostedAutomationRecord rec;
        rec.id = obj["id"] | "";
        rec.name = obj["name"] | "";
        rec.description = obj["description"] | "";
        rec.triggerType = static_cast<AutomationTriggerType>(obj["triggerType"] | 0);
        rec.touchGesture = static_cast<TouchGesture>(obj["touchGesture"] | 1);
        rec.cronHour = obj["cronHour"] | 8;
        rec.cronMinute = obj["cronMinute"] | 30;
        rec.cronDaysMask = obj["cronDaysMask"] | 0x3E;
        rec.runOfflineOnRtc = obj["runOfflineOnRtc"] | true;
        rec.humanSchedule = obj["humanSchedule"] | "";
        rec.headerBadge = obj["headerBadge"] | "AUTO";
        rec.cardTitle = obj["cardTitle"] | "Automation";
        rec.cardSubtitle = obj["cardSubtitle"] | "Ready";
        rec.accentColorRgb565 = obj["accentColor"] | colors::Green;
        rec.emotion = static_cast<EmotionId>(obj["emotion"] | 1);
        rec.soundId = static_cast<hal::SoundId>(obj["soundId"] | 2);
        rec.requires2Fa = obj["requires2Fa"] | false;
        rec.offlineVaultPath = obj["offlineVaultPath"] | "/sd/vault/automations/history.log";

        m_automations.push_back(std::move(rec));
    }

    Serial.printf("[AutomationHost] Loaded %u automations from storage.\n", (unsigned)m_automations.size());
    return true;
}

} // namespace petbot::firmware::agentic
