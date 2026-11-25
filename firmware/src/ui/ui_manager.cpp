#include "ui/ui_manager.h"
#include "apps/builtin_pages.h"
#include "agentic/agentic_transport.h"
#include "agentic/touch_2fa.h"
#include "agentic/voice_streamer.h"
#include "agentic/sd_vault.h"
#include <Arduino.h>
#include <cstring>
#include <algorithm>

namespace petbot::firmware::ui {

UIManager::UIManager() {
#ifdef ESP32
    m_mutex = xSemaphoreCreateMutex();
#endif
}

UIManager::~UIManager() {
    if (m_transitionScratchBuffer != nullptr) {
        petbot::hal::PsramMemoryManager::freePsram(m_transitionScratchBuffer);
        m_transitionScratchBuffer = nullptr;
    }
#ifdef ESP32
    if (m_mutex != nullptr) {
        vSemaphoreDelete(m_mutex);
        m_mutex = nullptr;
    }
#endif
}

void UIManager::init() {
#ifdef ESP32
    if (m_mutex == nullptr) {
        m_mutex = xSemaphoreCreateMutex();
    }
#endif

    // Pre-allocate 40,960 Bytes PSRAM scratch buffer for 2-page transition composition
    if (m_transitionScratchBuffer == nullptr) {
        m_transitionScratchBuffer = static_cast<uint16_t*>(
            petbot::hal::PsramMemoryManager::allocatePsram(petbot::hal::LCD_FRAME_BYTES, 16)
        );
        if (m_transitionScratchBuffer != nullptr) {
            m_transitionCanvas.setTargetBuffer(m_transitionScratchBuffer);
            Serial.printf("[UIManager] Allocated %u bytes PSRAM scratch buffer for 60FPS slide transitions.\n",
                          petbot::hal::LCD_FRAME_BYTES);
        } else {
            Serial.println("[UIManager] WARNING: Failed to allocate PSRAM transition scratch buffer!");
        }
    }

    ExpressionEngine::instance().init();

    // Register the 5 built-in carousel pages
    registerPage(std::make_shared<apps::PetHomePage>());
    registerPage(std::make_shared<apps::ClockWeatherPage>());
    registerPage(std::make_shared<apps::PomodoroPage>());
    registerPage(std::make_shared<apps::QuickNotesPage>());
    registerPage(std::make_shared<apps::HabitTrackerPage>());

    Serial.println("[UIManager] UI Subsystem initialized for Core 1 60FPS loop with 5 built-in pages.");
}

void UIManager::showToast(const char* message, uint32_t durationMs) {
    if (message == nullptr) return;

#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return;
    }
#endif

    strncpy(m_toast.message, message, sizeof(m_toast.message) - 1);
    m_toast.message[sizeof(m_toast.message) - 1] = '\0';
    m_toast.showTimestampMs = millis();
    m_toast.durationMs = durationMs;
    m_toast.active = true;
    m_toast.opacity = 0.0f;

#ifdef ESP32
    if (m_mutex != nullptr) {
        xSemaphoreGive(m_mutex);
    }
#endif

    Serial.printf("[UIManager] Toast queued: \"%s\" (duration: %u ms)\n", message, durationMs);
}

bool UIManager::getActiveToast(char* outBuffer, size_t maxLen, float* outOpacity) {
    if (outBuffer == nullptr || maxLen == 0) return false;

    bool hasToast = false;
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(10)) == pdTRUE)
#endif
    {
        if (m_toast.active) {
            strncpy(outBuffer, m_toast.message, maxLen - 1);
            outBuffer[maxLen - 1] = '\0';
            if (outOpacity != nullptr) {
                *outOpacity = m_toast.opacity;
            }
            hasToast = true;
        }
#ifdef ESP32
        if (m_mutex != nullptr) {
            xSemaphoreGive(m_mutex);
        }
#endif
    }
    return hasToast;
}

void UIManager::setRobotMode(RobotMode mode) {
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return;
    }
#endif

    m_currentMode = mode;

#ifdef ESP32
    if (m_mutex != nullptr) {
        xSemaphoreGive(m_mutex);
    }
#endif
    Serial.printf("[UIManager] Robot Mode set to: %s\n",
                  mode == RobotMode::AgenticConnected ? "AGENTIC_CONNECTED" : "NORMAL_OFFLINE");
}

RobotMode UIManager::getRobotMode() const {
    RobotMode mode = RobotMode::NormalOffline;
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(10)) == pdTRUE)
#endif
    {
        mode = m_currentMode;
#ifdef ESP32
        if (m_mutex != nullptr) {
            xSemaphoreGive(m_mutex);
        }
#endif
    }
    return mode;
}

bool UIManager::registerPage(std::shared_ptr<IAppPage> page) {
    if (!page) return false;

#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return false;
    }
#endif

    const char* newId = page->getPageId();

    // Check for existing page with same ID
    for (size_t i = 0; i < m_pages.size(); ++i) {
        if (strcmp(m_pages[i]->getPageId(), newId) == 0) {
            const bool wasActive = (i == m_activePageIndex);
            if (wasActive) {
                m_pages[i]->onExit();
            }
            m_pages[i] = page;
            if (wasActive) {
                page->onEnter();
            }
#ifdef ESP32
            if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
            Serial.printf("[UIManager] Replaced existing page: %s\n", newId);
            return true;
        }
    }

    // New page
    m_pages.push_back(page);
    if (m_pages.size() == 1) {
        m_activePageIndex = 0;
        page->onEnter();
    }

#ifdef ESP32
    if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    Serial.printf("[UIManager] Registered new page: %s (\"%s\")\n", newId, page->getPageTitle());
    return true;
}

bool UIManager::unregisterPage(const char* pageId) {
    if (pageId == nullptr) return false;

#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return false;
    }
#endif

    for (auto it = m_pages.begin(); it != m_pages.end(); ++it) {
        if (strcmp((*it)->getPageId(), pageId) == 0) {
            const size_t removedIdx = std::distance(m_pages.begin(), it);
            if (removedIdx == m_activePageIndex) {
                (*it)->onExit();
            }
            m_pages.erase(it);

            if (m_pages.empty()) {
                m_activePageIndex = 0;
            } else if (m_activePageIndex >= m_pages.size()) {
                m_activePageIndex = m_pages.size() - 1;
                m_pages[m_activePageIndex]->onEnter();
            }
#ifdef ESP32
            if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
            Serial.printf("[UIManager] Unregistered page: %s\n", pageId);
            return true;
        }
    }

#ifdef ESP32
    if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    return false;
}

bool UIManager::registerWidgetPage(std::shared_ptr<IAppPage> page) {
    if (!page) return false;

#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return false;
    }
#endif

    const char* newId = page->getPageId();

    // Check if already registered in widget slots
    for (size_t i = 0; i < m_widgetSlots.size(); ++i) {
        if (strcmp(m_widgetSlots[i]->getPageId(), newId) == 0) {
            m_widgetSlots[i] = page;
            for (size_t p = 0; p < m_pages.size(); ++p) {
                if (strcmp(m_pages[p]->getPageId(), newId) == 0) {
                    m_pages[p] = page;
                    break;
                }
            }
#ifdef ESP32
            if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
            return true;
        }
    }

    m_widgetSlots.push_back(page);
    m_pages.push_back(page);

#ifdef ESP32
    if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    Serial.printf("[UIManager] Registered dynamic widget page: %s (\"%s\")\n", newId, page->getPageTitle());
    return true;
}

bool UIManager::unregisterWidgetPage(const char* pageId) {
    if (pageId == nullptr) return false;

#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return false;
    }
#endif

    for (auto it = m_widgetSlots.begin(); it != m_widgetSlots.end(); ++it) {
        if (strcmp((*it)->getPageId(), pageId) == 0) {
            m_widgetSlots.erase(it);
            break;
        }
    }

#ifdef ESP32
    if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    return unregisterPage(pageId);
}

size_t UIManager::getBuiltinPageCount() const {
    size_t count = 0;
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(10)) == pdTRUE)
#endif
    {
        const size_t total = m_pages.size();
        const size_t widgets = m_widgetSlots.size();
        count = (total >= widgets) ? (total - widgets) : total;
#ifdef ESP32
        if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    }
    return count;
}

size_t UIManager::getWidgetPageCount() const {
    size_t count = 0;
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(10)) == pdTRUE)
#endif
    {
        count = m_widgetSlots.size();
#ifdef ESP32
        if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    }
    return count;
}

namespace {
inline const char* resolvePageIdAlias(const char* pageId) noexcept {
    if (pageId == nullptr) return nullptr;
    if (strcmp(pageId, "pet_home") == 0 || strcmp(pageId, "pet") == 0) return "home";
    if (strcmp(pageId, "timer") == 0 || strcmp(pageId, "focus") == 0) return "pomodoro";
    if ((pageId[0] == 't' && pageId[1] == 'o' && pageId[2] == 'd' && pageId[3] == 'o' && pageId[4] == '\0') || strcmp(pageId, "note") == 0) return "notes";
    if (strcmp(pageId, "habit") == 0 || strcmp(pageId, "routine") == 0) return "habits";
    if (strcmp(pageId, "pc") == 0 || strcmp(pageId, "monitor") == 0) return "pc_telemetry";
    if (strcmp(pageId, "vault") == 0) return "sd_vault";
    return pageId;
}
} // namespace

std::shared_ptr<IAppPage> UIManager::getPageById(const char* pageId) const {
    const char* resolvedId = resolvePageIdAlias(pageId);
    if (resolvedId == nullptr) return nullptr;

    std::shared_ptr<IAppPage> foundPage{nullptr};
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(10)) == pdTRUE)
#endif
    {
        for (const auto& page : m_pages) {
            if (page && strcmp(page->getPageId(), resolvedId) == 0) {
                foundPage = page;
                break;
            }
        }
#ifdef ESP32
        if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    }
    return foundPage;
}

bool UIManager::navigateToPage(const char* pageId, bool animate) {
    const char* resolvedId = resolvePageIdAlias(pageId);
    if (resolvedId == nullptr) return false;

    const char* targetTitle = nullptr;

#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return false;
    }
#endif

    for (size_t i = 0; i < m_pages.size(); ++i) {
        if (strcmp(m_pages[i]->getPageId(), resolvedId) == 0) {
            if (i == m_activePageIndex) {
#ifdef ESP32
                if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
                return true; // Already on this page
            }

            const size_t oldIdx = m_activePageIndex;
            m_activePageIndex = i;
            targetTitle = m_pages[i]->getPageTitle();

            if (animate) {
                m_transition.active = true;
                m_transition.startMs = millis();
                m_transition.durationMs = 200; // Deterministic 200ms
                m_transition.fromIdx = oldIdx;
                m_transition.toIdx = i;
                m_transition.direction = (i > oldIdx) ? 1 : -1;
            }

            m_pages[oldIdx]->onExit();
            m_pages[i]->onEnter();

            // Set HUD toast for page title
            if (targetTitle != nullptr) {
                strncpy(m_toast.message, targetTitle, sizeof(m_toast.message) - 1);
                m_toast.message[sizeof(m_toast.message) - 1] = '\0';
                m_toast.showTimestampMs = millis();
                m_toast.durationMs = 1500;
                m_toast.active = true;
                m_toast.opacity = 0.0f;
            }

#ifdef ESP32
            if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
            Serial.printf("[UIManager] Navigated to page: %s\n", pageId);
            return true;
        }
    }

#ifdef ESP32
    if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    return false;
}

void UIManager::nextPage() {
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return;
    }
#endif

    if (m_pages.size() > 1) {
        const size_t oldIdx = m_activePageIndex;
        const size_t newIdx = (oldIdx + 1) % m_pages.size();
        m_activePageIndex = newIdx;

        m_transition.active = true;
        m_transition.startMs = millis();
        m_transition.durationMs = 200;
        m_transition.fromIdx = oldIdx;
        m_transition.toIdx = newIdx;
        m_transition.direction = 1;

        m_pages[oldIdx]->onExit();
        m_pages[newIdx]->onEnter();

        // Queue top HUD toast for new page title
        const char* title = m_pages[newIdx]->getPageTitle();
        if (title != nullptr) {
            strncpy(m_toast.message, title, sizeof(m_toast.message) - 1);
            m_toast.message[sizeof(m_toast.message) - 1] = '\0';
            m_toast.showTimestampMs = millis();
            m_toast.durationMs = 1500;
            m_toast.active = true;
            m_toast.opacity = 0.0f;
        }
    }

#ifdef ESP32
    if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
}

void UIManager::prevPage() {
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return;
    }
#endif

    if (m_pages.size() > 1) {
        const size_t oldIdx = m_activePageIndex;
        const size_t newIdx = (oldIdx == 0) ? (m_pages.size() - 1) : (oldIdx - 1);
        m_activePageIndex = newIdx;

        m_transition.active = true;
        m_transition.startMs = millis();
        m_transition.durationMs = 200;
        m_transition.fromIdx = oldIdx;
        m_transition.toIdx = newIdx;
        m_transition.direction = -1;

        m_pages[oldIdx]->onExit();
        m_pages[newIdx]->onEnter();

        // Queue top HUD toast for new page title
        const char* title = m_pages[newIdx]->getPageTitle();
        if (title != nullptr) {
            strncpy(m_toast.message, title, sizeof(m_toast.message) - 1);
            m_toast.message[sizeof(m_toast.message) - 1] = '\0';
            m_toast.showTimestampMs = millis();
            m_toast.durationMs = 1500;
            m_toast.active = true;
            m_toast.opacity = 0.0f;
        }
    }

#ifdef ESP32
    if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
}

std::shared_ptr<IAppPage> UIManager::getActivePage() const {
    std::shared_ptr<IAppPage> page{nullptr};
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(10)) == pdTRUE)
#endif
    {
        if (!m_pages.empty() && m_activePageIndex < m_pages.size()) {
            page = m_pages[m_activePageIndex];
        }
#ifdef ESP32
        if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    }
    return page;
}

size_t UIManager::getPageCount() const {
    size_t count = 0;
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(10)) == pdTRUE)
#endif
    {
        count = m_pages.size();
#ifdef ESP32
        if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    }
    return count;
}

size_t UIManager::getActivePageIndex() const {
    size_t idx = 0;
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(10)) == pdTRUE)
#endif
    {
        idx = m_activePageIndex;
#ifdef ESP32
        if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    }
    return idx;
}

void UIManager::handleTouch(const TouchGestureEvent& evt) {
    if (petbot::firmware::agentic::Touch2FAManager::instance().isModalActive()) {
        if (petbot::firmware::agentic::Touch2FAManager::instance().handleTouch(evt)) {
            return;
        }
    }

    if (petbot::firmware::agentic::VoiceStreamer::instance().isUpsellPromptActive()) {
        if (evt.gesture == petbot::hal::TouchGesture::SingleTap) {
            petbot::firmware::agentic::VoiceStreamer::instance().dismissUpsellPrompt();
            return;
        }
    }

    std::shared_ptr<IAppPage> page{nullptr};
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(10)) == pdTRUE)
#endif
    {
        if (!m_pages.empty() && m_activePageIndex < m_pages.size()) {
            page = m_pages[m_activePageIndex];
        }
#ifdef ESP32
        if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    }

    if (page) {
        page->handleTouch(evt);
    }
}

void UIManager::update(uint32_t nowMs) {
#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, 0) != pdTRUE) {
        return;
    }
#endif

    // Update toast notification
    if (m_toast.active) {
        const uint32_t elapsed = nowMs - m_toast.showTimestampMs;
        constexpr uint32_t FADE_MS = 250;

        if (elapsed < FADE_MS) {
            m_toast.opacity = static_cast<float>(elapsed) / static_cast<float>(FADE_MS);
        } else if (elapsed < m_toast.durationMs - FADE_MS) {
            m_toast.opacity = 1.0f;
        } else if (elapsed < m_toast.durationMs) {
            const uint32_t remaining = m_toast.durationMs - elapsed;
            m_toast.opacity = static_cast<float>(remaining) / static_cast<float>(FADE_MS);
        } else {
            m_toast.active = false;
            m_toast.opacity = 0.0f;
        }
    }

    // Update transition
    if (m_transition.active) {
        const uint32_t elapsed = nowMs - m_transition.startMs;
        if (elapsed >= m_transition.durationMs) {
            m_transition.active = false;
        }
    }

    // Update active page
    std::shared_ptr<IAppPage> page{nullptr};
    if (!m_pages.empty() && m_activePageIndex < m_pages.size()) {
        page = m_pages[m_activePageIndex];
    }

    m_lastUpdateMs = nowMs;

#ifdef ESP32
    if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif

    ExpressionEngine::instance().update(nowMs);
    ExpressionEngine::instance().updatePersonality(nowMs, false, 12);
    petbot::firmware::agentic::Touch2FAManager::instance().update(nowMs);

    if (page) {
        page->update(nowMs);
    }
}

void UIManager::render(Canvas128x160& canvas) {
    // 0a. Preemption: Hardware Touch 2FA Modal Screen
    if (petbot::firmware::agentic::Touch2FAManager::instance().isModalActive()) {
        petbot::firmware::agentic::Touch2FAManager::instance().render(canvas);
        return;
    }

    // 0b. Preemption: SD Card Vault Transfer Overlay
    if (petbot::firmware::agentic::SdVaultEngine::instance().isTransferActive()) {
        petbot::firmware::agentic::SdVaultEngine::instance().renderTransferOverlay(canvas);
        return;
    }

    std::shared_ptr<IAppPage> activePage{nullptr};
    std::shared_ptr<IAppPage> fromPage{nullptr};
    std::shared_ptr<IAppPage> toPage{nullptr};
    bool showToast = false;
    char toastText[64]{0};
    float toastAlpha = 0.0f;
    size_t pageCount = 0;
    SlideTransition transCopy{};

#ifdef ESP32
    if (m_mutex != nullptr && xSemaphoreTake(m_mutex, pdMS_TO_TICKS(16)) == pdTRUE)
#endif
    {
        pageCount = m_pages.size();
        if (!m_pages.empty() && m_activePageIndex < m_pages.size()) {
            activePage = m_pages[m_activePageIndex];
        }

        transCopy = m_transition;
        if (transCopy.active) {
            if (transCopy.fromIdx < m_pages.size()) {
                fromPage = m_pages[transCopy.fromIdx];
            }
            if (transCopy.toIdx < m_pages.size()) {
                toPage = m_pages[transCopy.toIdx];
            }
        }

        if (m_toast.active) {
            showToast = true;
            strncpy(toastText, m_toast.message, sizeof(toastText) - 1);
            toastAlpha = m_toast.opacity;
        }
#ifdef ESP32
        if (m_mutex != nullptr) xSemaphoreGive(m_mutex);
#endif
    }

    // 1. Render active page or 2-page cubicOut slide transition
    if (transCopy.active && fromPage && toPage) {
        const uint32_t now = millis();
        const uint32_t elapsed = now - transCopy.startMs;
        if (elapsed < transCopy.durationMs) {
            const float t = static_cast<float>(elapsed) / static_cast<float>(transCopy.durationMs);
            const float easedT = easeCubicOut(t);
            const int16_t D = std::clamp<int16_t>(
                static_cast<int16_t>(easedT * static_cast<float>(Canvas128x160::width())),
                0,
                Canvas128x160::width()
            );

            if (m_transitionScratchBuffer != nullptr && canvas.getTargetBuffer() != nullptr) {
                // Render outgoing page into PSRAM scratch buffer
                fromPage->render(m_transitionCanvas);
                // Render incoming page into active canvas
                toPage->render(canvas);

                // Horizontally compose both pages row-by-row
                uint16_t rowBuf[Canvas128x160::width()];
                const uint16_t* fromPixels = m_transitionScratchBuffer;
                uint16_t* toPixels = canvas.getTargetBuffer();

                constexpr int16_t W = Canvas128x160::width();
                constexpr int16_t H = Canvas128x160::height();

                for (int16_t y = 0; y < H; ++y) {
                    const uint16_t* fromRow = fromPixels + (y * W);
                    const uint16_t* toRow = toPixels + (y * W);
                    uint16_t* dstRow = toPixels + (y * W);

                    if (transCopy.direction >= 0) { // Slide Left (Next)
                        const int16_t seam = W - D;
                        for (int16_t x = 0; x < seam; ++x) {
                            rowBuf[x] = fromRow[x + D];
                        }
                        for (int16_t x = seam; x < W; ++x) {
                            rowBuf[x] = toRow[x - seam];
                        }
                    } else { // Slide Right (Prev)
                        const int16_t seam = D;
                        for (int16_t x = 0; x < seam; ++x) {
                            rowBuf[x] = toRow[x + (W - D)];
                        }
                        for (int16_t x = seam; x < W; ++x) {
                            rowBuf[x] = fromRow[x - D];
                        }
                    }
                    std::memcpy(dstRow, rowBuf, W * sizeof(uint16_t));
                }

                // Sleek glowing vertical cyan seam line
                const int16_t seamX = (transCopy.direction >= 0) ? (W - D) : D;
                if (seamX >= 0 && seamX < W) {
                    canvas.drawFastVLine(seamX, 0, H, petbot::hal::colors::Cyan);
                }
            } else {
                // Fallback wipe if PSRAM scratch buffer was not fitted
                activePage->render(canvas);
                const int16_t wipeX = static_cast<int16_t>(easedT * static_cast<float>(Canvas128x160::width()));
                canvas.drawFastVLine(wipeX, 0, Canvas128x160::height(), petbot::hal::colors::Cyan);
            }
        } else {
            m_transition.active = false;
            if (activePage) {
                activePage->render(canvas);
            }
        }
    } else {
        if (activePage) {
            activePage->render(canvas);
        } else {
            canvas.clear(petbot::hal::colors::White);
            ExpressionEngine::instance().render(canvas);
        }
    }

    // 2. Render subtle top page-indicator pill bar on utility pages (keep Pet Home pure & uncluttered)
    if (pageCount > 1 && (m_activePageIndex > 0 || m_transition.active)) {
        drawPageIndicators(canvas);
    }

    // 3. Render Top HUD Toast Overlay if active
    if (showToast && toastAlpha > 0.01f) {
        drawToastOverlay(canvas);
    }

    // 4. Render Voice AI Pro Upsell Prompt Modal if active
    if (petbot::firmware::agentic::VoiceStreamer::instance().isUpsellPromptActive()) {
        petbot::firmware::agentic::VoiceStreamer::instance().renderUpsellPrompt(canvas);
    }

    // 5. Render Telemetry & FPS Diagnostic Overlay if enabled
    if (m_telemetryEnabled) {
        renderTelemetryOverlay(canvas);
    }
}

void UIManager::drawPageIndicators(Canvas128x160& canvas) {
    const size_t count = m_pages.size();
    if (count <= 1) return;

    // Subtle top page-indicator pill bar at y = 3
    constexpr int16_t PILL_Y = 3;
    constexpr int16_t PILL_H = 2;
    constexpr int16_t PILL_W = 12;
    constexpr int16_t PILL_GAP = 4;

    const int16_t totalW = static_cast<int16_t>(count * PILL_W + (count - 1) * PILL_GAP);
    const int16_t startX = (Canvas128x160::width() - totalW) / 2;

    for (size_t i = 0; i < count; ++i) {
        const int16_t px = startX + static_cast<int16_t>(i * (PILL_W + PILL_GAP));
        if (i == m_activePageIndex) {
            canvas.fillRect(px, PILL_Y, PILL_W, PILL_H, petbot::hal::colors::Cyan);
        } else {
            canvas.fillRect(px, PILL_Y, PILL_W, PILL_H, petbot::hal::colors::DarkGray);
        }
    }
}

void UIManager::drawToastOverlay(Canvas128x160& canvas) {
    if (!m_toast.active || m_toast.opacity <= 0.0f) return;

    const uint8_t alpha = static_cast<uint8_t>(m_toast.opacity * 255.0f);
    constexpr int16_t TOAST_H = 18;
    constexpr int16_t TOAST_Y = 7; // Top HUD placement
    constexpr int16_t TOAST_X = 6;
    constexpr int16_t TOAST_W = 116;

    // Dark semi-transparent background with glowing border
    const uint16_t toastBg = petbot::hal::Canvas128x160::blendAlpha(
        petbot::hal::colors::DarkGray, petbot::hal::colors::Black, alpha
    );
    const uint16_t toastBorder = petbot::hal::Canvas128x160::blendAlpha(
        petbot::hal::colors::Cyan, petbot::hal::colors::Black, alpha
    );
    const uint16_t toastTextCol = petbot::hal::Canvas128x160::blendAlpha(
        petbot::hal::colors::White, petbot::hal::colors::Black, alpha
    );

    canvas.fillRoundRect(TOAST_X, TOAST_Y, TOAST_W, TOAST_H, 3, toastBg);
    canvas.drawRoundRect(TOAST_X, TOAST_Y, TOAST_W, TOAST_H, 3, toastBorder);

    // Center text inside top HUD toast
    const size_t len = strlen(m_toast.message);
    const int16_t textW = static_cast<int16_t>(len * 6); // 5x7 font = 6px per char
    const int16_t textX = std::max<int16_t>(TOAST_X + 4, TOAST_X + (TOAST_W - textW) / 2);
    const int16_t textY = TOAST_Y + 5;

    canvas.drawText(textX, textY, m_toast.message, toastTextCol, toastBg, 1, true);
}

void UIManager::updateTelemetry(uint32_t frameTimeUs) noexcept {
    m_frameTimeUs = frameTimeUs;
    if (frameTimeUs > 0) {
        const float instantFps = 1000000.0f / static_cast<float>(frameTimeUs);
        m_fpsFiltered = (m_fpsFiltered * 0.9f) + (instantFps * 0.1f);
    }
    m_renderedFramesCount++;
}

void UIManager::renderTelemetryOverlay(Canvas128x160& canvas) noexcept {
    if (!m_telemetryEnabled) return;

    constexpr int16_t HUD_X = 8;
    constexpr int16_t HUD_Y = 86;
    constexpr int16_t HUD_W = 144;
    constexpr int16_t HUD_H = 38;

    // Semi-transparent dark background
    canvas.fillRoundRect(HUD_X, HUD_Y, HUD_W, HUD_H, 3, petbot::hal::colors::Black);
    canvas.drawRoundRect(HUD_X, HUD_Y, HUD_W, HUD_H, 3, petbot::hal::colors::Cyan);

    // Metrics
    const size_t freeSramKb = petbot::hal::PsramMemoryManager::getFreeDmaHeap() / 1024;
    const size_t freePsramKb = petbot::hal::PsramMemoryManager::getFreePsram() / 1024;

    char line1[32];
    snprintf(line1, sizeof(line1), "FPS:%.1f (%luus)", m_fpsFiltered, static_cast<unsigned long>(m_frameTimeUs));
    char line2[32];
    snprintf(line2, sizeof(line2), "SRAM: %lu KB free", static_cast<unsigned long>(freeSramKb));
    char line3[32];
    snprintf(line3, sizeof(line3), "PSRAM: %lu KB free", static_cast<unsigned long>(freePsramKb));

    canvas.drawText(HUD_X + 4, HUD_Y + 4, line1, petbot::hal::colors::Green, petbot::hal::colors::Black, 1, true);
    canvas.drawText(HUD_X + 4, HUD_Y + 14, line2, petbot::hal::colors::Cyan, petbot::hal::colors::Black, 1, true);
    canvas.drawText(HUD_X + 4, HUD_Y + 24, line3, petbot::hal::colors::Yellow, petbot::hal::colors::Black, 1, true);
}

void UIManager::drawTopStatusBar(Canvas128x160& canvas, uint32_t nowMs) {
    if (nowMs == 0) nowMs = millis();

    // Subtle dark background bar at y = 0..11
    canvas.fillRect(0, 0, Canvas128x160::width(), 12,
                    Canvas128x160::blendAlpha(petbot::hal::colors::DarkGray, petbot::hal::colors::Black, 180));

    const RobotMode mode = getRobotMode();
    const bool isAgentic = (mode == RobotMode::AgenticConnected);

    // 1. Left: Mode indicator (OFFLINE vs AGENT)
    if (isAgentic) {
        canvas.fillCircle(5, 6, 2, petbot::hal::colors::Cyan);
        canvas.drawText(9, 2, "AGENT", petbot::hal::colors::Cyan, petbot::hal::colors::Black, 1, true);

        // Wi-Fi RSSI Bars at x = 39..45
        const bool wifiConnected = petbot::firmware::agentic::AgenticTransport::instance().isWifiConnected();
        const int8_t rssi = wifiConnected ? WiFi.RSSI() : -100;

        const uint16_t bar1Col = (wifiConnected && rssi >= -85) ? petbot::hal::colors::Green : petbot::hal::colors::DarkGray;
        const uint16_t bar2Col = (wifiConnected && rssi >= -70) ? petbot::hal::colors::Green : petbot::hal::colors::DarkGray;
        const uint16_t bar3Col = (wifiConnected && rssi >= -55) ? petbot::hal::colors::Green : petbot::hal::colors::DarkGray;

        canvas.drawFastVLine(39, 7, 3, bar1Col);
        canvas.drawFastVLine(41, 5, 5, bar2Col);
        canvas.drawFastVLine(43, 3, 7, bar3Col);
    } else {
        canvas.fillCircle(5, 6, 2, petbot::hal::colors::DarkGray);
        canvas.drawText(9, 2, "OFFLINE", petbot::hal::colors::LightGray, petbot::hal::colors::Black, 1, true);
    }

    // 2. Voice AI Active Mic Indicator
    if (petbot::firmware::agentic::VoiceStreamer::instance().isVoiceStreaming()) {
        const bool pulse = ((nowMs / 300) % 2) == 0;
        const uint16_t micCol = pulse ? petbot::hal::colors::Red : petbot::hal::colors::Yellow;
        canvas.fillCircle(51, 6, 2, micCol);
        canvas.drawText(55, 2, "MIC", micCol, petbot::hal::colors::Black, 1, true);
    }

    // 3. Center: Clock HH:MM (160px landscape layout)
    const uint32_t totalSec = (nowMs / 1000);
    const uint32_t hh = (totalSec / 3600) % 24;
    const uint32_t mm = (totalSec / 60) % 60;
    char timeStr[8]{0};
    snprintf(timeStr, sizeof(timeStr), "%02u:%02u", static_cast<unsigned>(hh), static_cast<unsigned>(mm));
    canvas.drawText(98, 2, timeStr, petbot::hal::colors::White, petbot::hal::colors::Black, 1, true);

    // 4. Right: Battery icon (12x6)
    const int16_t batX = Canvas128x160::width() - 18;
    canvas.drawRect(batX, 3, 12, 6, petbot::hal::colors::LightGray);
    canvas.fillRect(batX + 2, 4, 7, 4, petbot::hal::colors::Green);
    canvas.drawFastVLine(batX + 12, 4, 4, petbot::hal::colors::LightGray);
}

} // namespace petbot::firmware::ui