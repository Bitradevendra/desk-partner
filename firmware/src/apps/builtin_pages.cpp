/**
 * Built-In Offline Applications for 128x160 Display Carousel
 * 
 * 100% complete C++20 implementation of:
 * - PetHomePage
 * - ClockWeatherPage
 * - PomodoroPage
 * - QuickNotesPage
 * - HabitTrackerPage
 */
#include "apps/builtin_pages.h"
#include "ui/ui_manager.h"
#include <cstdio>
#include <cstring>
#include <cctype>
#include <cmath>
#include <algorithm>

#ifdef ESP32
#include <Arduino.h>
#else
#include <ctime>
inline uint32_t millis() { return 0; }
#endif

namespace petbot::firmware::apps {

// ============================================================================
// Helper Utilities
// ============================================================================

namespace {

inline void formatTimeDigits(uint32_t totalSec, char* outBuffer, size_t maxLen) noexcept {
    const uint32_t m = totalSec / 60;
    const uint32_t s = totalSec % 60;
    snprintf(outBuffer, maxLen, "%02u:%02u", static_cast<unsigned>(m), static_cast<unsigned>(s));
}

inline bool containsIgnoreCase(const char* haystack, const char* needle) noexcept {
    if (haystack == nullptr || needle == nullptr || needle[0] == '\0') return false;
    const size_t hLen = std::strlen(haystack);
    const size_t nLen = std::strlen(needle);
    if (nLen > hLen) return false;

    for (size_t i = 0; i <= hLen - nLen; ++i) {
        size_t j = 0;
        while (j < nLen &&
               std::tolower(static_cast<unsigned char>(haystack[i + j])) ==
               std::tolower(static_cast<unsigned char>(needle[j]))) {
            ++j;
        }
        if (j == nLen) return true;
    }
    return false;
}

inline bool equalsIgnoreCase(const char* a, const char* b) noexcept {
    if (a == nullptr || b == nullptr) return false;
    while (*a && *b) {
        if (std::tolower(static_cast<unsigned char>(*a)) != std::tolower(static_cast<unsigned char>(*b))) {
            return false;
        }
        ++a;
        ++b;
    }
    return *a == *b;
}

} // namespace

// ============================================================================
// Page 1: PetHomePage Implementation
// ============================================================================

void PetHomePage::onEnter() {
    showStatusOverlay_ = false;
    winkExpiresMs_ = 0;
    ExpressionEngine::instance().setEmotion(EmotionId::Idle);
}

void PetHomePage::onExit() {
    showStatusOverlay_ = false;
    winkExpiresMs_ = 0;
}

void PetHomePage::onTouchGesture(TouchGestureType gesture) {
    if (showStatusOverlay_) {
        // Any tap closes the status overlay
        showStatusOverlay_ = false;
        AudioHal::instance().playProceduralSound(SoundId::Tick);
        return;
    }

    if (gesture == TouchGesture::LeftTap) {
        // Left Ear Tap: Playful left wink
        winkExpiresMs_ = millis() + 320;
        AudioHal::instance().playProceduralSound(SoundId::Tick);
    } else if (gesture == TouchGesture::RightTap) {
        // Right Ear Tap: Curious head tilt and beep
        ExpressionEngine::instance().setEmotion(EmotionId::Curious);
        AudioHal::instance().playProceduralSound(SoundId::CuriousBeep);
    } else if (gesture == TouchGesture::SideTap) {
        // Side Flank Tap: Toggle mood summary card
        showStatusOverlay_ = true;
        statusOverlayStartMs_ = millis();
        AudioHal::instance().playProceduralSound(SoundId::Tick);
    } else if (gesture == TouchGesture::SideLongPress) {
        // Side Flank Hold: Toggle Sleep mode
        if (ExpressionEngine::instance().getEmotion() == EmotionId::Sleepy) {
            ExpressionEngine::instance().setEmotion(EmotionId::Happy);
        } else {
            ExpressionEngine::instance().setEmotion(EmotionId::Sleepy);
        }
        AudioHal::instance().playProceduralSound(SoundId::Chirp);
    } else if (gesture == TouchGesture::RightPinchTap) {
        // Right Pinch (Ear + Flank): Playful petting chuckling
        ExpressionEngine::instance().onPettingGesture();
        AudioHal::instance().playProceduralSound(SoundId::Purr);
    } else if (gesture == TouchGesture::SingleTap) {
        // Cycle playful micro-interactions
        microInteractionIndex_ = (microInteractionIndex_ + 1) % 3;

        switch (microInteractionIndex_) {
            case 0: {
                // Playful wink: close left eyelid briefly, smile warmly
                winkExpiresMs_ = millis() + 320;
                AudioHal::instance().playProceduralSound(SoundId::Tick);
                break;
            }
            case 1: {
                // Curious tilt: head tilt and inquisitive beep
                ExpressionEngine::instance().setEmotion(EmotionId::Curious);
                AudioHal::instance().playProceduralSound(SoundId::CuriousBeep);
                break;
            }
            case 2:
            default: {
                // Happy bounce + chirp
                ExpressionEngine::instance().setEmotion(EmotionId::Happy);
                AudioHal::instance().playProceduralSound(SoundId::HappyTrill);
                AudioHal::instance().playProceduralSound(SoundId::Chirp);
                break;
            }
        }
    } else if (gesture == TouchGesture::LongPress ||
               gesture == TouchGesture::LeftLongPress ||
               gesture == TouchGesture::RightLongPress) {
        // Open quick OFFLINE status/mood summary overlay (long-press only; clean Pet Face on startup)
        showStatusOverlay_ = true;
        statusOverlayStartMs_ = millis();
        AudioHal::instance().playProceduralSound(SoundId::Tick);
    }
}

void PetHomePage::update(uint32_t nowMs, float dt) {
    (void)dt;

    if (winkExpiresMs_ > 0 && nowMs >= winkExpiresMs_) {
        winkExpiresMs_ = 0;
        ExpressionEngine::instance().setEmotion(EmotionId::Idle);
    }

    if (showStatusOverlay_ && (nowMs - statusOverlayStartMs_ >= 5000)) {
        showStatusOverlay_ = false;
    }
}

void PetHomePage::render(Canvas128x160& canvas) {
    // 1. Clean full-screen living expression engine face (White background, black eyes/mouth, pink blush)
    canvas.clear(colors::White);
    ExpressionEngine::instance().render(canvas);

    // Apply active playful wink if active
    if (winkExpiresMs_ > 0) {
        // Wink left eye: erase eye with white and draw crisp black horizontal slit
        constexpr int16_t lx = 52;
        constexpr int16_t ly = 56;
        canvas.fillRect(lx - 15, ly - 17, 30, 34, colors::White);
        canvas.drawFastHLine(lx - 11, ly, 22, colors::Black);
        canvas.drawFastHLine(lx - 9, ly + 1, 18, colors::Black);
    }

    // 2. Quick status/mood summary card only if explicitly triggered via Side Tap / Long Press
    if (showStatusOverlay_) {
        renderStatusSummaryOverlay(canvas, millis());
    }
}

void PetHomePage::renderTopStatusBar(Canvas128x160& canvas, uint32_t nowMs) noexcept {
    // Preserved helper (intentionally not drawn on PetHomePage so face stays clean)
    ui::UIManager::instance().drawTopStatusBar(canvas, nowMs);
}

void PetHomePage::renderStatusSummaryOverlay(Canvas128x160& canvas, uint32_t nowMs) noexcept {
    (void)nowMs;
    constexpr int16_t CARD_X = 20;
    constexpr int16_t CARD_Y = 14;
    constexpr int16_t CARD_W = 120;
    constexpr int16_t CARD_H = 100;

    // Classic crisp white modal card with black border
    canvas.fillRoundRect(CARD_X, CARD_Y, CARD_W, CARD_H, 6, colors::White);
    canvas.drawRoundRect(CARD_X, CARD_Y, CARD_W, CARD_H, 6, colors::Black);

    // Card Header
    canvas.drawText(CARD_X + 26, CARD_Y + 8, "LOBO MOOD", colors::Black, colors::White, 1, true);
    canvas.drawFastHLine(CARD_X + 8, CARD_Y + 18, CARD_W - 16, colors::LightGray);

    // 1. Affection Metric
    const uint8_t aff = ExpressionEngine::instance().getAffectionLevel();
    char affStr[24]{0};
    snprintf(affStr, sizeof(affStr), "Affection: %u%%", aff);
    canvas.drawText(CARD_X + 10, CARD_Y + 24, affStr, colors::Black, colors::White, 1, true);
    // Gauge bar
    canvas.drawRect(CARD_X + 10, CARD_Y + 34, 100, 5, colors::LightGray);
    canvas.fillRect(CARD_X + 11, CARD_Y + 35, static_cast<int16_t>((aff * 98) / 100), 3, Canvas128x160::colorRGB(255, 118, 168));

    // 2. Energy Metric
    const uint8_t nrg = ExpressionEngine::instance().getEnergyLevel();
    char nrgStr[24]{0};
    snprintf(nrgStr, sizeof(nrgStr), "Energy:    %u%%", nrg);
    canvas.drawText(CARD_X + 10, CARD_Y + 44, nrgStr, colors::Black, colors::White, 1, true);
    canvas.drawRect(CARD_X + 10, CARD_Y + 54, 100, 5, colors::LightGray);
    canvas.fillRect(CARD_X + 11, CARD_Y + 55, static_cast<int16_t>((nrg * 98) / 100), 3, colors::Black);

    // 3. Uptime & Focus State
    const uint32_t uptimeM = millis() / 60000;
    char upStr[24]{0};
    snprintf(upStr, sizeof(upStr), "Uptime:    %u min", static_cast<unsigned>(uptimeM));
    canvas.drawText(CARD_X + 10, CARD_Y + 61, upStr, colors::DarkGray, colors::White, 1, true);
    canvas.drawText(CARD_X + 10, CARD_Y + 72, "Focus:     Ready", colors::DarkGray, colors::White, 1, true);

    // Dismiss footer
    canvas.drawText(CARD_X + 20, CARD_Y + 87, "[ Tap: Close ]", colors::Gray, colors::White, 1, true);
}

// ============================================================================
// Page 2: ClockWeatherPage Implementation
// ============================================================================

ClockWeatherPage::ClockWeatherPage() noexcept {
    loadWeatherState();
}

void ClockWeatherPage::onEnter() {
    peekingBlinkClosed_ = false;
    nextBlinkMs_ = millis() + 3000;
}

void ClockWeatherPage::onExit() {
    peekingBlinkClosed_ = false;
}

void ClockWeatherPage::onTouchGesture(TouchGestureType gesture) {
    if (gesture == TouchGesture::SingleTap || gesture == TouchGesture::SideTap) {
        // Toggle Digital Cyberpunk Clock vs Analog Watch Face
        clockMode_ = (clockMode_ == 0) ? 1 : 0;
        AudioHal::instance().playProceduralSound(SoundId::Tick);
    } else if (gesture == TouchGesture::LeftTap) {
        // Left Ear Tap: Refresh clock face
        AudioHal::instance().playProceduralSound(SoundId::Tick);
    } else if (gesture == TouchGesture::RightTap) {
        // Right Ear Tap: Cycle weather conditions
        const uint8_t nextCond = (static_cast<uint8_t>(weather_.condition) + 1) % 4;
        weather_.condition = static_cast<WeatherCondition>(nextCond);
        saveWeatherState();
        AudioHal::instance().playProceduralSound(SoundId::Chirp);
    } else if (gesture == TouchGesture::LongPress || gesture == TouchGesture::SideLongPress) {
        // Cycle weather condition for testing/preview
        const uint8_t nextCond = (static_cast<uint8_t>(weather_.condition) + 1) % 4;
        weather_.condition = static_cast<WeatherCondition>(nextCond);
        saveWeatherState();
        AudioHal::instance().playProceduralSound(SoundId::Chirp);
    }
}

void ClockWeatherPage::update(uint32_t nowMs, float dt) {
    (void)dt;

    // Peeking pet blink timer
    if (peekingBlinkClosed_) {
        if (nowMs >= blinkEndMs_) {
            peekingBlinkClosed_ = false;
            nextBlinkMs_ = nowMs + 3000 + (nowMs % 2000);
        }
    } else {
        if (nowMs >= nextBlinkMs_) {
            peekingBlinkClosed_ = true;
            blinkEndMs_ = nowMs + 140;
        }
    }
}

void ClockWeatherPage::render(Canvas128x160& canvas) {
    canvas.clear(colors::Black);

    if (clockMode_ == 0) {
        renderDigitalClock(canvas, millis());
    } else {
        renderAnalogClock(canvas, millis());
    }

    // Mini animated pet eyes peeking from the bottom edge
    renderPeekingPetEyes(canvas, millis());
}

void ClockWeatherPage::renderDigitalClock(Canvas128x160& canvas, uint32_t nowMs) noexcept {
    const int64_t rawSec = static_cast<int64_t>(nowMs / 1000) + static_cast<int64_t>(epochOffsetSec_) + static_cast<int64_t>(tzOffsetSec_);
    const uint32_t totalSec = static_cast<uint32_t>((rawSec % 86400 + 86400) % 86400);
    const uint32_t hh = (totalSec / 3600) % 24;
    const uint32_t mm = (totalSec / 60) % 60;
    const uint32_t ss = totalSec % 60;

    // Large Digital Clock Typography (160x128 landscape)
    char hmStr[8]{0};
    snprintf(hmStr, sizeof(hmStr), "%02u:%02u", static_cast<unsigned>(hh), static_cast<unsigned>(mm));
    canvas.drawText(26, 14, hmStr, colors::Cyan, colors::Black, 2, true);

    // Seconds (:SS)
    char secStr[6]{0};
    snprintf(secStr, sizeof(secStr), ":%02u", static_cast<unsigned>(ss));
    canvas.drawText(104, 20, secStr, colors::White, colors::Black, 1, true);

    // Day & Date
    canvas.drawText(26, 33, dateLabel_, colors::LightGray, colors::Black, 1, true);

    // Separator line
    canvas.drawFastHLine(12, 44, 136, colors::DarkCyan);

    // Cached Weather Card
    renderWeatherCard(canvas, 49);
}

void ClockWeatherPage::renderAnalogClock(Canvas128x160& canvas, uint32_t nowMs) noexcept {
    constexpr int16_t CX = 52;
    constexpr int16_t CY = 56;
    constexpr int16_t R  = 34;

    // Dial background & rim
    canvas.drawCircle(CX, CY, R, colors::DarkCyan);
    canvas.drawCircle(CX, CY, R - 1, colors::DarkGray);

    // 12 hour tick marks
    for (int h = 0; h < 12; ++h) {
        const float angle = static_cast<float>(h) * (3.14159265f / 6.0f);
        const int16_t x1 = CX + static_cast<int16_t>(cosf(angle) * static_cast<float>(R - 2));
        const int16_t y1 = CY + static_cast<int16_t>(sinf(angle) * static_cast<float>(R - 2));
        const int16_t tickLen = (h % 3 == 0) ? 5 : 2;
        const int16_t x2 = CX + static_cast<int16_t>(cosf(angle) * static_cast<float>(R - 2 - tickLen));
        const int16_t y2 = CY + static_cast<int16_t>(sinf(angle) * static_cast<float>(R - 2 - tickLen));
        canvas.drawLine(x1, y1, x2, y2, (h % 3 == 0) ? colors::Cyan : colors::DarkGray);
    }

    const int64_t rawSec = static_cast<int64_t>(nowMs / 1000) + static_cast<int64_t>(epochOffsetSec_) + static_cast<int64_t>(tzOffsetSec_);
    const uint32_t totalSec = static_cast<uint32_t>((rawSec % 86400 + 86400) % 86400);
    const float secFrac = static_cast<float>(nowMs % 60000) / 1000.0f;
    const float minVal  = static_cast<float>((totalSec / 60) % 60) + secFrac / 60.0f;
    const float hourVal = static_cast<float>((totalSec / 3600) % 12) + minVal / 60.0f;

    // Hour hand (length 16px)
    const float hAngle = (hourVal * (3.14159265f / 6.0f)) - 1.5707963f;
    const int16_t hx = CX + static_cast<int16_t>(cosf(hAngle) * 16.0f);
    const int16_t hy = CY + static_cast<int16_t>(sinf(hAngle) * 16.0f);
    canvas.drawLine(CX, CY, hx, hy, colors::White);

    // Minute hand (length 24px)
    const float mAngle = (minVal * (3.14159265f / 30.0f)) - 1.5707963f;
    const int16_t mx = CX + static_cast<int16_t>(cosf(mAngle) * 24.0f);
    const int16_t my = CY + static_cast<int16_t>(sinf(mAngle) * 24.0f);
    canvas.drawLine(CX, CY, mx, my, colors::Cyan);

    // Sweeping second hand (length 29px)
    const float sAngle = (secFrac * (3.14159265f / 30.0f)) - 1.5707963f;
    const int16_t sx = CX + static_cast<int16_t>(cosf(sAngle) * 29.0f);
    const int16_t sy = CY + static_cast<int16_t>(sinf(sAngle) * 29.0f);
    canvas.drawLine(CX, CY, sx, sy, colors::Orange);

    // Center hub
    canvas.fillCircle(CX, CY, 2, colors::White);

    // Weather brief on right half in landscape
    char wthrBrief[24]{0};
    snprintf(wthrBrief, sizeof(wthrBrief), "%dC", weather_.temperatureC);
    canvas.drawText(98, 42, wthrBrief, colors::White, colors::Black, 2, true);
    canvas.drawText(98, 66, weather_.city, colors::LightGray, colors::Black, 1, true);
}

void ClockWeatherPage::renderWeatherCard(Canvas128x160& canvas, int16_t y) noexcept {
    constexpr int16_t CARD_X = 10;
    constexpr int16_t CARD_W = 140;
    constexpr int16_t CARD_H = 54;

    // Rounded weather card frame
    canvas.fillRoundRect(CARD_X, y, CARD_W, CARD_H, 6, Canvas128x160::blendAlpha(colors::DarkGray, colors::Black, 140));
    canvas.drawRoundRect(CARD_X, y, CARD_W, CARD_H, 6, colors::DarkCyan);

    // Weather icon on left
    renderWeatherIcon(canvas, CARD_X + 26, y + 27, weather_.condition);

    // Temperature text
    char tempStr[12]{0};
    snprintf(tempStr, sizeof(tempStr), "%dC", weather_.temperatureC);
    canvas.drawText(CARD_X + 56, y + 10, tempStr, colors::White, colors::Black, 2, true);

    // Condition description label
    const char* condName = "Sunny";
    switch (weather_.condition) {
        case WeatherCondition::Cloudy: condName = "Cloudy"; break;
        case WeatherCondition::Rain:   condName = "Rainy";  break;
        case WeatherCondition::Night:  condName = "Clear";  break;
        default: break;
    }
    canvas.drawText(CARD_X + 56, y + 29, condName, colors::Cyan, colors::Black, 1, true);

    // Humidity percentage
    char humStr[16]{0};
    snprintf(humStr, sizeof(humStr), "Hum: %u%%", weather_.humidityPct);
    canvas.drawText(CARD_X + 56, y + 41, humStr, colors::LightGray, colors::Black, 1, true);
}

void ClockWeatherPage::renderWeatherIcon(Canvas128x160& canvas, int16_t cx, int16_t cy, WeatherCondition cond) noexcept {
    switch (cond) {
        case WeatherCondition::Sunny: {
            // Sun disc with radiating rays
            canvas.fillCircle(cx, cy, 7, colors::Yellow);
            for (int r = 0; r < 8; ++r) {
                const float a = static_cast<float>(r) * (3.14159265f / 4.0f);
                const int16_t x1 = cx + static_cast<int16_t>(cosf(a) * 9.0f);
                const int16_t y1 = cy + static_cast<int16_t>(sinf(a) * 9.0f);
                const int16_t x2 = cx + static_cast<int16_t>(cosf(a) * 12.0f);
                const int16_t y2 = cy + static_cast<int16_t>(sinf(a) * 12.0f);
                canvas.drawLine(x1, y1, x2, y2, colors::Yellow);
            }
            break;
        }

        case WeatherCondition::Cloudy: {
            // Multi-circle fluffy cloud
            canvas.fillCircle(cx - 6, cy + 2, 5, colors::White);
            canvas.fillCircle(cx, cy - 2, 7, colors::LightGray);
            canvas.fillCircle(cx + 6, cy + 2, 5, colors::White);
            canvas.fillRect(cx - 6, cy + 2, 12, 5, colors::White);
            break;
        }

        case WeatherCondition::Rain: {
            // Cloud top + falling rain droplets
            canvas.fillCircle(cx - 5, cy - 2, 4, colors::LightGray);
            canvas.fillCircle(cx, cy - 5, 6, colors::White);
            canvas.fillCircle(cx + 5, cy - 2, 4, colors::LightGray);
            canvas.fillRect(cx - 5, cy - 2, 10, 4, colors::LightGray);

            // Droplets
            canvas.drawLine(cx - 6, cy + 5, cx - 8, cy + 9, colors::Cyan);
            canvas.drawLine(cx, cy + 6, cx - 2, cy + 10, colors::Cyan);
            canvas.drawLine(cx + 6, cy + 5, cx + 4, cy + 9, colors::Cyan);
            break;
        }

        case WeatherCondition::Night: {
            // Crescent moon & stars
            canvas.fillCircle(cx, cy, 8, colors::Yellow);
            canvas.fillCircle(cx + 4, cy - 2, 7, colors::Black); // Crop to crescent
            // Tiny star
            canvas.drawPixel(cx + 8, cy + 4, colors::White);
            break;
        }
    }
}

void ClockWeatherPage::renderPeekingPetEyes(Canvas128x160& canvas, uint32_t nowMs) noexcept {
    (void)nowMs;
    // Two cute rounded pet eyes peeking up from bottom edge (160x128 landscape)
    constexpr int16_t eyeLeftX  = 58;
    constexpr int16_t eyeRightX = 102;
    constexpr int16_t eyeY      = 118;
    constexpr int16_t eyeW      = 18;
    constexpr int16_t eyeH      = 12;

    if (peekingBlinkClosed_) {
        // Blinking closed eye line
        canvas.drawFastHLine(eyeLeftX - eyeW / 2, eyeY, eyeW, colors::Cyan);
        canvas.drawFastHLine(eyeRightX - eyeW / 2, eyeY, eyeW, colors::Cyan);
    } else {
        // Glowing cyan rounded eyes
        canvas.fillRoundRect(eyeLeftX - eyeW / 2, eyeY - eyeH / 2, eyeW, eyeH, 5, colors::Cyan);
        canvas.fillRoundRect(eyeRightX - eyeW / 2, eyeY - eyeH / 2, eyeW, eyeH, 5, colors::Cyan);

        // Specular glint dots
        canvas.drawPixel(eyeLeftX - 2, eyeY - 2, colors::White);
        canvas.drawPixel(eyeRightX - 2, eyeY - 2, colors::White);
    }
}

void ClockWeatherPage::loadWeatherState() noexcept {
    size_t len = 0;
    uint8_t* buf = StorageHal::instance().readFileToPsram("/state/weather.bin", &len, nullptr, false);
    if (buf != nullptr && len >= sizeof(WeatherCache)) {
        std::memcpy(&weather_, buf, sizeof(WeatherCache));
        StorageHal::instance().freeBuffer(buf);
    } else {
        weather_.temperatureC = 23;
        weather_.humidityPct  = 48;
        weather_.condition    = WeatherCondition::Sunny;
        strncpy(weather_.city, "Home", sizeof(weather_.city) - 1);
        saveWeatherState();
    }
}

void ClockWeatherPage::saveWeatherState() noexcept {
    StorageHal::instance().writeFileAtomic(
        "/state/weather.bin",
        reinterpret_cast<const uint8_t*>(&weather_),
        sizeof(WeatherCache),
        true
    );
}

void ClockWeatherPage::updateWeather(int8_t tempC, uint8_t humidity, WeatherCondition cond, const char* city) noexcept {
    weather_.temperatureC = tempC;
    weather_.humidityPct = humidity;
    weather_.condition = cond;
    if (city != nullptr) {
        strncpy(weather_.city, city, sizeof(weather_.city) - 1);
    }
    saveWeatherState();
}

void ClockWeatherPage::setClockMode(uint8_t mode) noexcept {
    clockMode_ = (mode == 0) ? 0 : 1;
}

void ClockWeatherPage::syncTime(uint32_t unixSec, int32_t tzOffsetSec, const char* dateLabel) noexcept {
    const uint32_t upSec = millis() / 1000;
    epochOffsetSec_ = (unixSec >= upSec) ? (unixSec - upSec) : unixSec;
    tzOffsetSec_ = tzOffsetSec;
    if (dateLabel != nullptr && dateLabel[0] != '\0') {
        strncpy(dateLabel_, dateLabel, sizeof(dateLabel_) - 1);
        dateLabel_[sizeof(dateLabel_) - 1] = '\0';
    }
}

// ============================================================================
// Page 3: PomodoroPage Implementation
// ============================================================================

PomodoroPage::PomodoroPage() noexcept {
    loadStats();
}

void PomodoroPage::onEnter() {
    lastSecondTickMs_ = millis();
}

void PomodoroPage::onExit() {
    // Keep running in background if active
}

void PomodoroPage::startFocus() noexcept {
    phase_ = PomodoroPhase::Focus;
    if (!isRunning_) {
        isRunning_ = true;
        lastSecondTickMs_ = millis();
    }
}

void PomodoroPage::startCustomFocus(uint16_t minutes) noexcept {
    const uint16_t clamped = std::clamp<uint16_t>(minutes, 1, 180);
    phase_ = PomodoroPhase::Focus;
    totalPhaseSeconds_ = clamped * 60;
    remainingSeconds_ = totalPhaseSeconds_;
    isRunning_ = true;
    lastSecondTickMs_ = millis();
    showCelebration_ = false;
    saveStats();
}

void PomodoroPage::startBreak(bool longBreak) noexcept {
    phase_ = longBreak ? PomodoroPhase::LongBreak : PomodoroPhase::ShortBreak;
    totalPhaseSeconds_ = longBreak ? (15 * 60) : (5 * 60);
    remainingSeconds_ = totalPhaseSeconds_;
    isRunning_ = true;
    lastSecondTickMs_ = millis();
    showCelebration_ = false;
    saveStats();
}

void PomodoroPage::pauseFocus() noexcept {
    isRunning_ = false;
}

void PomodoroPage::toggleFocus() noexcept {
    isRunning_ = !isRunning_;
    lastSecondTickMs_ = millis();
}

void PomodoroPage::resetFocus() noexcept {
    resetCurrentPhase();
}

void PomodoroPage::onTouchGesture(TouchGestureType gesture) {
    if (gesture == TouchGesture::RightTap || gesture == TouchGesture::SingleTap) {
        // Right Head Tap: Start or Resume countdown
        isRunning_ = !isRunning_;
        lastSecondTickMs_ = millis();
        AudioHal::instance().playProceduralSound(SoundId::Tick);
    } else if (gesture == TouchGesture::LeftTap) {
        // Left Head Tap: Pause countdown
        isRunning_ = false;
        AudioHal::instance().playProceduralSound(SoundId::Tick);
    } else if (gesture == TouchGesture::SideTap) {
        // Side Flank Tap: Cycle Pomodoro Phase (Focus -> Short Break -> Long Break)
        advancePhase();
        AudioHal::instance().playProceduralSound(SoundId::Chirp);
    } else if (gesture == TouchGesture::LongPress ||
               gesture == TouchGesture::LeftLongPress ||
               gesture == TouchGesture::RightLongPress ||
               gesture == TouchGesture::SideLongPress) {
        // Reset or skip current phase
        resetCurrentPhase();
        AudioHal::instance().playProceduralSound(SoundId::Tick);
    }
}

void PomodoroPage::update(uint32_t nowMs, float dt) {
    (void)dt;

    if (isRunning_) {
        if (nowMs - lastSecondTickMs_ >= 1000) {
            lastSecondTickMs_ = nowMs;
            if (remainingSeconds_ > 0) {
                remainingSeconds_--;
            }

            if (remainingSeconds_ == 0) {
                // Phase completed!
                AudioHal::instance().playProceduralSound(SoundId::AlarmChime);
                showCelebration_ = true;
                celebrationExpiresMs_ = nowMs + 2800;
                advancePhase();
            }
        }
    }

    if (showCelebration_ && nowMs >= celebrationExpiresMs_) {
        showCelebration_ = false;
    }
}

void PomodoroPage::advancePhase() noexcept {
    if (phase_ == PomodoroPhase::Focus) {
        completedSessionsInSet_++;
        stats_.totalFocusMinutesToday += (totalPhaseSeconds_ / 60);
        stats_.completedSessionsTotal++;
        saveStats();

        if (completedSessionsInSet_ >= 4) {
            completedSessionsInSet_ = 0;
            phase_ = PomodoroPhase::LongBreak;
            totalPhaseSeconds_ = 15 * 60; // 15 min long rest
        } else {
            phase_ = PomodoroPhase::ShortBreak;
            totalPhaseSeconds_ = 5 * 60;  // 5 min short break
        }
    } else {
        phase_ = PomodoroPhase::Focus;
        totalPhaseSeconds_ = 25 * 60;     // 25 min focus
    }

    remainingSeconds_ = totalPhaseSeconds_;
    isRunning_ = false; // Require user tap to begin next phase
}

void PomodoroPage::resetCurrentPhase() noexcept {
    isRunning_ = false;
    remainingSeconds_ = totalPhaseSeconds_;
}

void PomodoroPage::loadStats() noexcept {
    size_t len = 0;
    uint8_t* buf = StorageHal::instance().readFileToPsram("/state/pomodoro.bin", &len, nullptr, false);
    if (buf != nullptr && len >= sizeof(PomodoroStats)) {
        std::memcpy(&stats_, buf, sizeof(PomodoroStats));
        StorageHal::instance().freeBuffer(buf);
    } else {
        stats_.totalFocusMinutesToday = 0;
        stats_.completedSessionsTotal = 0;
        stats_.currentPhase = 0;
        saveStats();
    }
}

void PomodoroPage::saveStats() noexcept {
    stats_.currentPhase = static_cast<uint16_t>(phase_);
    StorageHal::instance().writeFileAtomic(
        "/state/pomodoro.bin",
        reinterpret_cast<const uint8_t*>(&stats_),
        sizeof(PomodoroStats),
        true
    );
}

void PomodoroPage::render(Canvas128x160& canvas) {
    canvas.clear(colors::Black);

    constexpr int16_t CX = 80;
    constexpr int16_t CY = 56;
    constexpr int16_t R  = 34;

    const float progress = 1.0f - (static_cast<float>(remainingSeconds_) / static_cast<float>(totalPhaseSeconds_));

    // 1. Circular Arc Progress Gauge
    renderArcProgressGauge(canvas, CX, CY, R, progress);

    // 2. Current Phase Title (dynamic minutes)
    char phaseBuf[20]{0};
    const uint16_t phaseMins = std::max<uint16_t>(1, totalPhaseSeconds_ / 60);
    uint16_t phaseColor = colors::Orange;
    if (phase_ == PomodoroPhase::ShortBreak) {
        snprintf(phaseBuf, sizeof(phaseBuf), "BREAK %02u:00", static_cast<unsigned>(phaseMins));
        phaseColor = colors::Green;
    } else if (phase_ == PomodoroPhase::LongBreak) {
        snprintf(phaseBuf, sizeof(phaseBuf), "REST %02u:00", static_cast<unsigned>(phaseMins));
        phaseColor = colors::Cyan;
    } else {
        snprintf(phaseBuf, sizeof(phaseBuf), "FOCUS %02u:00", static_cast<unsigned>(phaseMins));
    }
    canvas.drawText(CX - static_cast<int16_t>(strlen(phaseBuf) * 3), 10, phaseBuf, phaseColor, colors::Black, 1, true);

    // 3. Large MM:SS Countdown
    char timeStr[12]{0};
    formatTimeDigits(remainingSeconds_, timeStr, sizeof(timeStr));
    canvas.drawText(CX - 28, CY - 10, timeStr, colors::White, colors::Black, 2, true);

    // 4. Running / Paused Status Indicator
    const char* statusStr = isRunning_ ? "ACTIVE" : "PAUSED";
    const uint16_t statusColor = isRunning_ ? colors::Green : colors::DarkGray;
    canvas.drawText(CX - static_cast<int16_t>(strlen(statusStr) * 3), CY + 9, statusStr, statusColor, colors::Black, 1, true);

    // 5. Miniature Pet Avatar inside ring
    renderMiniPetAvatar(canvas, CX, CY + 21, (phase_ == PomodoroPhase::Focus));

    // 6. Completed Session Dots (4 indicator dots)
    constexpr int16_t DOT_Y = 99;
    constexpr int16_t DOT_SPACING = 12;
    constexpr int16_t DOTS_START_X = CX - static_cast<int16_t>(1.5f * DOT_SPACING);

    for (int i = 0; i < 4; ++i) {
        const int16_t dx = DOTS_START_X + i * DOT_SPACING;
        if (i < completedSessionsInSet_) {
            canvas.fillCircle(dx, DOT_Y, 3, colors::Cyan); // Completed session
        } else {
            canvas.drawCircle(dx, DOT_Y, 3, colors::DarkGray); // Pending session
        }
    }

    // 7. Today's total focus minutes label
    char totalStr[24]{0};
    snprintf(totalStr, sizeof(totalStr), "Today: %u min", static_cast<unsigned>(stats_.totalFocusMinutesToday));
    canvas.drawText(CX - static_cast<int16_t>(strlen(totalStr) * 3), 112, totalStr, colors::LightGray, colors::Black, 1, true);

    // 8. Celebration Overlay if phase finished
    if (showCelebration_) {
        renderCelebrationOverlay(canvas, millis());
    }
}

void PomodoroPage::renderArcProgressGauge(Canvas128x160& canvas, int16_t cx, int16_t cy, int16_t r, float progress) noexcept {
    // Background gauge track
    canvas.drawCircle(cx, cy, r, colors::DarkGray);

    // Progress arc
    const int maxDegrees = static_cast<int>(progress * 360.0f);
    const uint16_t arcColor = (phase_ == PomodoroPhase::Focus) ? colors::Orange : colors::Green;

    for (int deg = 0; deg <= maxDegrees; deg += 4) {
        const float rad = (static_cast<float>(deg) - 90.0f) * (3.14159265f / 180.0f);
        const int16_t px = cx + static_cast<int16_t>(cosf(rad) * static_cast<float>(r));
        const int16_t py = cy + static_cast<int16_t>(sinf(rad) * static_cast<float>(r));
        canvas.drawPixel(px, py, arcColor);
        // 2px thick arc
        const int16_t px2 = cx + static_cast<int16_t>(cosf(rad) * static_cast<float>(r - 1));
        const int16_t py2 = cy + static_cast<int16_t>(sinf(rad) * static_cast<float>(r - 1));
        canvas.drawPixel(px2, py2, arcColor);
    }
}

void PomodoroPage::renderMiniPetAvatar(Canvas128x160& canvas, int16_t cx, int16_t cy, bool isFocus) noexcept {
    if (isFocus) {
        // Focused sharp narrow eyes
        canvas.fillRoundRect(cx - 10, cy - 3, 7, 4, 1, colors::Cyan);
        canvas.fillRoundRect(cx + 3,  cy - 3, 7, 4, 1, colors::Cyan);
    } else {
        // Happy crescent smile eyes (^ ^)
        canvas.drawLine(cx - 9, cy, cx - 6, cy - 3, colors::Yellow);
        canvas.drawLine(cx - 6, cy - 3, cx - 3, cy, colors::Yellow);
        canvas.drawLine(cx + 3, cy, cx + 6, cy - 3, colors::Yellow);
        canvas.drawLine(cx + 6, cy - 3, cx + 9, cy, colors::Yellow);
    }
}

void PomodoroPage::renderCelebrationOverlay(Canvas128x160& canvas, uint32_t nowMs) noexcept {
    (void)nowMs;
    constexpr int16_t CARD_X = 14;
    constexpr int16_t CARD_Y = 46;
    constexpr int16_t CARD_W = 100;
    constexpr int16_t CARD_H = 68;

    canvas.fillRoundRect(CARD_X, CARD_Y, CARD_W, CARD_H, 6, Canvas128x160::blendAlpha(colors::DarkCyan, colors::Black, 220));
    canvas.drawRoundRect(CARD_X, CARD_Y, CARD_W, CARD_H, 6, colors::Yellow);

    canvas.drawText(CARD_X + 16, CARD_Y + 12, "PHASE DONE!", colors::Yellow, colors::Black, 1, true);

    // Happy smiling pet eyes
    renderMiniPetAvatar(canvas, CARD_X + 50, CARD_Y + 32, false);

    canvas.drawText(CARD_X + 12, CARD_Y + 48, "[Tap: Continue]", colors::White, colors::Black, 1, true);
}

// ============================================================================
// Page 4: QuickNotesPage Implementation
// ============================================================================

QuickNotesPage::QuickNotesPage() noexcept {
    loadNotes();
}

void QuickNotesPage::onEnter() {
    loadNotes(); // Hot-reload if companion updated notes
}

void QuickNotesPage::onExit() {
}

void QuickNotesPage::onTouchGesture(TouchGestureType gesture) {
    if (gesture == TouchGesture::RightTap || gesture == TouchGesture::SingleTap) {
        // Right Head Tap: Next note (forward scroll)
        if (notes_.count > 0) {
            activeNoteIndex_ = (activeNoteIndex_ + 1) % notes_.count;
        }
        AudioHal::instance().playProceduralSound(SoundId::Tick);
    } else if (gesture == TouchGesture::LeftTap) {
        // Left Head Tap: Previous note (backward scroll)
        if (notes_.count > 0) {
            activeNoteIndex_ = (activeNoteIndex_ == 0) ? (notes_.count - 1) : (activeNoteIndex_ - 1);
        }
        AudioHal::instance().playProceduralSound(SoundId::Tick);
    } else if (gesture == TouchGesture::SideTap) {
        // Side Flank Tap: Toggle Pinned / Starred status
        if (notes_.count > 0 && activeNoteIndex_ < notes_.count) {
            notes_.items[activeNoteIndex_].pinned = !notes_.items[activeNoteIndex_].pinned;
            saveNotes();
            AudioHal::instance().playProceduralSound(SoundId::Chirp);
        }
    } else if (gesture == TouchGesture::LongPress ||
               gesture == TouchGesture::LeftLongPress ||
               gesture == TouchGesture::RightLongPress ||
               gesture == TouchGesture::SideLongPress) {
        // Toggle Pinned / Starred status
        if (notes_.count > 0 && activeNoteIndex_ < notes_.count) {
            notes_.items[activeNoteIndex_].pinned = !notes_.items[activeNoteIndex_].pinned;
            saveNotes();
            AudioHal::instance().playProceduralSound(SoundId::Chirp);
        }
    }
}

void QuickNotesPage::update(uint32_t nowMs, float dt) {
    (void)nowMs;
    (void)dt;
}

void QuickNotesPage::render(Canvas128x160& canvas) {
    canvas.clear(colors::Black);

    constexpr int16_t CARD_X = 8;
    constexpr int16_t CARD_Y = 10;
    constexpr int16_t CARD_W = 144;
    constexpr int16_t CARD_H = 110;

    // Outer Note Card
    canvas.fillRoundRect(CARD_X, CARD_Y, CARD_W, CARD_H, 6, Canvas128x160::blendAlpha(colors::DarkGray, colors::Black, 160));
    canvas.drawRoundRect(CARD_X, CARD_Y, CARD_W, CARD_H, 6, colors::DarkCyan);

    if (notes_.count == 0) {
        canvas.drawText(CARD_X + 34, CARD_Y + 46, "No Notes Yet", colors::LightGray, colors::Black, 1, true);
        return;
    }

    const auto& note = notes_.items[activeNoteIndex_];

    // Card Header: Note counter [1/3] and Pin status
    char counterStr[12]{0};
    snprintf(counterStr, sizeof(counterStr), "[%u/%u]", activeNoteIndex_ + 1, notes_.count);
    canvas.drawText(CARD_X + 8, CARD_Y + 7, counterStr, colors::LightGray, colors::Black, 1, true);

    if (note.pinned) {
        canvas.drawText(CARD_X + 86, CARD_Y + 7, "* PINNED", colors::Yellow, colors::Black, 1, true);
    }

    // Note Title
    canvas.drawText(CARD_X + 8, CARD_Y + 19, note.title, colors::Cyan, colors::Black, 1, true);
    canvas.drawFastHLine(CARD_X + 8, CARD_Y + 30, CARD_W - 16, colors::DarkCyan);

    // Word-wrapped body text
    renderWordWrappedBody(canvas, note.body, CARD_X + 8, CARD_Y + 35, CARD_W - 16);

    // Bottom Navigation Hint
    canvas.drawFastHLine(CARD_X + 8, CARD_Y + 92, CARD_W - 16, colors::DarkGray);
    canvas.drawText(CARD_X + 14, CARD_Y + 97, "Tap: Next | Hold: Pin", colors::Gray, colors::Black, 1, true);
}

void QuickNotesPage::renderWordWrappedBody(
    Canvas128x160& canvas,
    const char* text,
    int16_t startX,
    int16_t startY,
    int16_t maxW
) noexcept {
    if (text == nullptr || maxW < 12) return;

    constexpr int16_t CHAR_W = 6;
    constexpr int16_t LINE_H = 9;
    const int16_t maxCharsPerLine = maxW / CHAR_W;

    int16_t curX = startX;
    int16_t curY = startY;
    const size_t len = strlen(text);
    size_t i = 0;

    char lineBuf[24]{0};
    int lineCharCount = 0;

    while (i < len && curY < startY + 70) {
        // Collect next word
        size_t wordStart = i;
        while (i < len && text[i] != ' ' && text[i] != '\n') {
            i++;
        }
        const size_t wordLen = i - wordStart;

        // Check if word fits on current line
        if (lineCharCount + static_cast<int>(wordLen) + (lineCharCount > 0 ? 1 : 0) <= maxCharsPerLine) {
            if (lineCharCount > 0) {
                lineBuf[lineCharCount++] = ' ';
            }
            std::memcpy(&lineBuf[lineCharCount], &text[wordStart], wordLen);
            lineCharCount += static_cast<int>(wordLen);
            lineBuf[lineCharCount] = '\0';
        } else {
            // Flush current line
            if (lineCharCount > 0) {
                canvas.drawText(curX, curY, lineBuf, colors::White, colors::Black, 1, true);
                curY += LINE_H;
            }
            // Start next line with this word
            lineCharCount = std::min<int>(static_cast<int>(wordLen), maxCharsPerLine);
            std::memcpy(lineBuf, &text[wordStart], static_cast<size_t>(lineCharCount));
            lineBuf[lineCharCount] = '\0';
        }

        if (i < len && text[i] == '\n') {
            canvas.drawText(curX, curY, lineBuf, colors::White, colors::Black, 1, true);
            curY += LINE_H;
            lineCharCount = 0;
            lineBuf[0] = '\0';
        }

        if (i < len && text[i] == ' ') {
            i++;
        }
    }

    if (lineCharCount > 0 && curY < startY + 70) {
        canvas.drawText(curX, curY, lineBuf, colors::White, colors::Black, 1, true);
    }
}

void QuickNotesPage::seedStarterNotes() noexcept {
    notes_.magic = 0x4E4F5445;
    notes_.count = 3;

    strncpy(notes_.items[0].title, "Welcome PetBot", sizeof(notes_.items[0].title) - 1);
    strncpy(notes_.items[0].body,  "Double-tap top sensor to switch between apps and living pet face.", sizeof(notes_.items[0].body) - 1);
    notes_.items[0].pinned = true;

    strncpy(notes_.items[1].title, "Voice Assistant", sizeof(notes_.items[1].title) - 1);
    strncpy(notes_.items[1].body,  "Connect companion app via BLE or WiFi to start real-time speech streaming.", sizeof(notes_.items[1].body) - 1);
    notes_.items[1].pinned = false;

    strncpy(notes_.items[2].title, "Daily Routine", sizeof(notes_.items[2].title) - 1);
    strncpy(notes_.items[2].body,  "Drink 2L water, 2h deep focus work, and 30m exercise every day.", sizeof(notes_.items[2].body) - 1);
    notes_.items[2].pinned = false;
}

void QuickNotesPage::loadNotes() noexcept {
    size_t len = 0;
    uint8_t* buf = StorageHal::instance().readFileToPsram("/state/notes.bin", &len, nullptr, false);
    if (buf != nullptr && len >= sizeof(NotesFile)) {
        std::memcpy(&notes_, buf, sizeof(NotesFile));
        StorageHal::instance().freeBuffer(buf);
    } else {
        seedStarterNotes();
        saveNotes();
    }
}

void QuickNotesPage::saveNotes() noexcept {
    StorageHal::instance().writeFileAtomic(
        "/state/notes.bin",
        reinterpret_cast<const uint8_t*>(&notes_),
        sizeof(NotesFile),
        true
    );
}

void QuickNotesPage::addOrUpdateNote(const char* title, const char* body, bool pinned) noexcept {
    if (title == nullptr || title[0] == '\0') return;

    // 1. Update matching note if same title already exists
    for (uint8_t i = 0; i < notes_.count && i < 8; ++i) {
        if (equalsIgnoreCase(notes_.items[i].title, title)) {
            strncpy(notes_.items[i].body, body != nullptr ? body : "", sizeof(notes_.items[0].body) - 1);
            notes_.items[i].body[sizeof(notes_.items[0].body) - 1] = '\0';
            notes_.items[i].pinned = pinned;
            activeNoteIndex_ = i;
            saveNotes();
            return;
        }
    }

    // 2. Append if space remains; otherwise overwrite oldest non-pinned slot (or index 0)
    if (notes_.count < 8) {
        const uint8_t idx = notes_.count;
        strncpy(notes_.items[idx].title, title, sizeof(notes_.items[0].title) - 1);
        notes_.items[idx].title[sizeof(notes_.items[0].title) - 1] = '\0';
        strncpy(notes_.items[idx].body, body != nullptr ? body : "", sizeof(notes_.items[0].body) - 1);
        notes_.items[idx].body[sizeof(notes_.items[0].body) - 1] = '\0';
        notes_.items[idx].pinned = pinned;
        notes_.count++;
        activeNoteIndex_ = idx;
    } else {
        uint8_t replaceIdx = 0;
        for (uint8_t i = 0; i < 8; ++i) {
            if (!notes_.items[i].pinned) {
                replaceIdx = i;
                break;
            }
        }
        strncpy(notes_.items[replaceIdx].title, title, sizeof(notes_.items[0].title) - 1);
        notes_.items[replaceIdx].title[sizeof(notes_.items[0].title) - 1] = '\0';
        strncpy(notes_.items[replaceIdx].body, body != nullptr ? body : "", sizeof(notes_.items[0].body) - 1);
        notes_.items[replaceIdx].body[sizeof(notes_.items[0].body) - 1] = '\0';
        notes_.items[replaceIdx].pinned = pinned;
        activeNoteIndex_ = replaceIdx;
    }
    saveNotes();
}

bool QuickNotesPage::setNotePinnedByTitle(const char* query, bool pinned) noexcept {
    if (query == nullptr || query[0] == '\0') return false;
    for (uint8_t i = 0; i < notes_.count && i < 8; ++i) {
        if (containsIgnoreCase(notes_.items[i].title, query) || containsIgnoreCase(notes_.items[i].body, query)) {
            notes_.items[i].pinned = pinned;
            activeNoteIndex_ = i;
            saveNotes();
            return true;
        }
    }
    return false;
}

bool QuickNotesPage::deleteNoteByTitle(const char* query) noexcept {
    if (query == nullptr || query[0] == '\0' || notes_.count == 0) return false;
    for (uint8_t i = 0; i < notes_.count && i < 8; ++i) {
        if (containsIgnoreCase(notes_.items[i].title, query) || containsIgnoreCase(notes_.items[i].body, query)) {
            for (uint8_t j = i; j + 1 < notes_.count; ++j) {
                notes_.items[j] = notes_.items[j + 1];
            }
            notes_.count--;
            if (notes_.count > 0 && activeNoteIndex_ >= notes_.count) {
                activeNoteIndex_ = notes_.count - 1;
            } else if (notes_.count == 0) {
                activeNoteIndex_ = 0;
            }
            saveNotes();
            return true;
        }
    }
    return false;
}

// ============================================================================
// Page 5: HabitTrackerPage Implementation
// ============================================================================

HabitTrackerPage::HabitTrackerPage() noexcept {
    loadHabits();
}

void HabitTrackerPage::onEnter() {
    loadHabits();
    showCelebration_ = false;
}

void HabitTrackerPage::onExit() {
    showCelebration_ = false;
}

void HabitTrackerPage::onTouchGesture(TouchGestureType gesture) {
    if (gesture == TouchGesture::RightTap || gesture == TouchGesture::SingleTap) {
        // Right Head Tap: Move selection cursor forward
        if (habits_.count > 0) {
            selectedIndex_ = (selectedIndex_ + 1) % habits_.count;
        }
        AudioHal::instance().playProceduralSound(SoundId::Tick);
    } else if (gesture == TouchGesture::LeftTap) {
        // Left Head Tap: Move selection cursor backward
        if (habits_.count > 0) {
            selectedIndex_ = (selectedIndex_ == 0) ? (habits_.count - 1) : (selectedIndex_ - 1);
        }
        AudioHal::instance().playProceduralSound(SoundId::Tick);
    } else if (gesture == TouchGesture::SideTap ||
               gesture == TouchGesture::LongPress ||
               gesture == TouchGesture::LeftLongPress ||
               gesture == TouchGesture::RightLongPress ||
               gesture == TouchGesture::SideLongPress) {
        // Side Tap or Long Press: Toggle completion checkmark on selected habit
        if (habits_.count > 0 && selectedIndex_ < habits_.count) {
            auto& h = habits_.items[selectedIndex_];
            h.completedToday = !h.completedToday;

            if (h.completedToday) {
                h.streakDays++;
                saveHabits();
                AudioHal::instance().playProceduralSound(SoundId::HappyTrill);
                showCelebration_ = true;
                celebrationExpiresMs_ = millis() + 1200; // 1.2s celebratory overlay
            } else {
                if (h.streakDays > 0) h.streakDays--;
                saveHabits();
                AudioHal::instance().playProceduralSound(SoundId::Tick);
            }
        }
    }
}

void HabitTrackerPage::update(uint32_t nowMs, float dt) {
    (void)dt;

    if (showCelebration_ && nowMs >= celebrationExpiresMs_) {
        showCelebration_ = false;
    }
}

void HabitTrackerPage::render(Canvas128x160& canvas) {
    canvas.clear(colors::Black);

    // 1. Header: "DAILY HABITS" & Progress ratio (160x128 landscape)
    canvas.drawText(8, 10, "DAILY HABITS", colors::Cyan, colors::Black, 1, true);

    uint8_t doneCount = 0;
    for (uint8_t i = 0; i < habits_.count; ++i) {
        if (habits_.items[i].completedToday) doneCount++;
    }

    char ratioStr[12]{0};
    snprintf(ratioStr, sizeof(ratioStr), "%u/%u Done", doneCount, habits_.count);
    canvas.drawText(104, 10, ratioStr, colors::Green, colors::Black, 1, true);
    canvas.drawFastHLine(8, 20, 144, colors::DarkCyan);

    // 2. Habit rows (scrollable 3-row viewport supporting up to 8 habits on 128px height)
    constexpr int16_t ROW_START_Y = 26;
    constexpr int16_t ROW_H = 25;

    uint8_t windowStart = 0;
    if (habits_.count > 3 && selectedIndex_ >= 2) {
        windowStart = std::min<uint8_t>(static_cast<uint8_t>(selectedIndex_ - 1), static_cast<uint8_t>(habits_.count - 3));
    }

    for (uint8_t slot = 0; slot < 3 && (windowStart + slot) < habits_.count; ++slot) {
        const uint8_t i = static_cast<uint8_t>(windowStart + slot);
        const int16_t ry = ROW_START_Y + static_cast<int16_t>(slot * ROW_H);
        const bool isSelected = (i == selectedIndex_);
        const auto& item = habits_.items[i];

        // Selection highlight rectangle
        if (isSelected) {
            canvas.fillRoundRect(6, ry, 148, ROW_H - 2, 4, Canvas128x160::blendAlpha(colors::Navy, colors::Black, 160));
            canvas.drawRoundRect(6, ry, 148, ROW_H - 2, 4, colors::Cyan);
        }

        // Checkbox: [X] or [ ]
        constexpr int16_t BOX_X = 12;
        const int16_t boxY = ry + 4;
        canvas.drawRoundRect(BOX_X, boxY, 14, 14, 2, item.completedToday ? colors::Green : colors::DarkGray);

        if (item.completedToday) {
            canvas.fillRect(BOX_X + 2, boxY + 2, 10, 10, colors::Green);
            // White checkmark lines
            canvas.drawLine(BOX_X + 3, boxY + 7, BOX_X + 6, boxY + 10, colors::White);
            canvas.drawLine(BOX_X + 6, boxY + 10, BOX_X + 11, boxY + 4, colors::White);
        }

        // Habit Title text (fits cleanly on 160px width)
        char dispTitle[16]{0};
        strncpy(dispTitle, item.title, sizeof(dispTitle) - 1);
        const uint16_t textCol = item.completedToday ? colors::LightGray : colors::White;
        canvas.drawText(BOX_X + 18, boxY + 3, dispTitle, textCol, colors::Black, 1, true);

        // Streak Count Badge
        char streakStr[12]{0};
        snprintf(streakStr, sizeof(streakStr), "%ud", item.streakDays);
        canvas.drawText(132, boxY + 3, streakStr, colors::Orange, colors::Black, 1, true);
    }

    // 3. Navigation hint at bottom
    canvas.drawFastHLine(8, 104, 144, colors::DarkGray);
    canvas.drawText(18, 111, "Tap: Next | Hold: Done", colors::Gray, colors::Black, 1, true);

    // 4. 1.2-second Mini Happy Celebration Overlay
    if (showCelebration_) {
        renderCelebrationOverlay(canvas, millis());
    }
}

void HabitTrackerPage::renderCelebrationOverlay(Canvas128x160& canvas, uint32_t nowMs) noexcept {
    (void)nowMs;
    constexpr int16_t CARD_X = 28;
    constexpr int16_t CARD_Y = 26;
    constexpr int16_t CARD_W = 104;
    constexpr int16_t CARD_H = 74;

    // Celebration modal popup
    canvas.fillRoundRect(CARD_X, CARD_Y, CARD_W, CARD_H, 8, Canvas128x160::blendAlpha(colors::Navy, colors::Black, 230));
    canvas.drawRoundRect(CARD_X, CARD_Y, CARD_W, CARD_H, 8, colors::Yellow);

    // Confetti sparkles around modal border
    canvas.drawPixel(CARD_X + 4, CARD_Y + 8, colors::Cyan);
    canvas.drawPixel(CARD_X + CARD_W - 6, CARD_Y + 12, colors::Yellow);
    canvas.drawPixel(CARD_X + 8, CARD_Y + CARD_H - 10, colors::Green);
    canvas.drawPixel(CARD_X + CARD_W - 10, CARD_Y + CARD_H - 8, colors::Orange);

    // Text & Streak Spike
    canvas.drawText(CARD_X + 22, CARD_Y + 12, "AWESOME!", colors::Yellow, colors::Black, 1, true);
    canvas.drawText(CARD_X + 18, CARD_Y + 26, "STREAK +1!", colors::Cyan, colors::Black, 1, true);

    // Mini Happy Smiling Eyes (^ ^)
    constexpr int16_t cx = CARD_X + 50;
    constexpr int16_t cy = CARD_Y + 50;
    canvas.drawLine(cx - 10, cy, cx - 6, cy - 4, colors::Yellow);
    canvas.drawLine(cx - 6, cy - 4, cx - 2, cy, colors::Yellow);
    canvas.drawLine(cx + 2, cy, cx + 6, cy - 4, colors::Yellow);
    canvas.drawLine(cx + 6, cy - 4, cx + 10, cy, colors::Yellow);
}

bool HabitTrackerPage::addHabit(const char* title) noexcept {
    if (title == nullptr || title[0] == '\0') return false;

    // 1. Check for existing habit with same/similar title
    for (uint8_t i = 0; i < habits_.count && i < 8; ++i) {
        if (equalsIgnoreCase(habits_.items[i].title, title)) {
            selectedIndex_ = i;
            return true;
        }
    }

    // 2. Append new habit (up to 8 slots) or replace last completed item if full
    uint8_t targetIdx = habits_.count;
    if (habits_.count < 8) {
        targetIdx = habits_.count;
        habits_.count++;
    } else {
        targetIdx = 7;
        for (uint8_t i = 0; i < 8; ++i) {
            if (habits_.items[i].completedToday) {
                targetIdx = i;
                break;
            }
        }
    }

    strncpy(habits_.items[targetIdx].title, title, sizeof(habits_.items[0].title) - 1);
    habits_.items[targetIdx].title[sizeof(habits_.items[0].title) - 1] = '\0';
    habits_.items[targetIdx].streakDays = 0;
    habits_.items[targetIdx].completedToday = false;
    selectedIndex_ = targetIdx;

    saveHabits();
    AudioHal::instance().playProceduralSound(SoundId::Chirp);
    return true;
}

bool HabitTrackerPage::setHabitCompletedByName(const char* query, bool completed) noexcept {
    if (habits_.count == 0) return false;

    int foundIdx = -1;
    if (query == nullptr || query[0] == '\0') {
        foundIdx = selectedIndex_;
    } else {
        for (uint8_t i = 0; i < habits_.count && i < 8; ++i) {
            if (containsIgnoreCase(habits_.items[i].title, query)) {
                foundIdx = static_cast<int>(i);
                break;
            }
        }
    }

    if (foundIdx < 0 || foundIdx >= static_cast<int>(habits_.count)) {
        return false;
    }

    auto& h = habits_.items[foundIdx];
    selectedIndex_ = static_cast<uint8_t>(foundIdx);

    if (h.completedToday != completed) {
        h.completedToday = completed;
        if (completed) {
            h.streakDays++;
            saveHabits();
            AudioHal::instance().playProceduralSound(SoundId::HappyTrill);
            showCelebration_ = true;
            celebrationExpiresMs_ = millis() + 1800;
        } else {
            if (h.streakDays > 0) h.streakDays--;
            saveHabits();
            AudioHal::instance().playProceduralSound(SoundId::Tick);
        }
    } else if (completed) {
        AudioHal::instance().playProceduralSound(SoundId::Tick);
    }

    return true;
}

bool HabitTrackerPage::removeHabitByName(const char* query) noexcept {
    if (query == nullptr || query[0] == '\0' || habits_.count == 0) return false;

    for (uint8_t i = 0; i < habits_.count && i < 8; ++i) {
        if (containsIgnoreCase(habits_.items[i].title, query)) {
            for (uint8_t j = i; j + 1 < habits_.count; ++j) {
                habits_.items[j] = habits_.items[j + 1];
            }
            habits_.count--;
            if (habits_.count > 0 && selectedIndex_ >= habits_.count) {
                selectedIndex_ = habits_.count - 1;
            } else if (habits_.count == 0) {
                selectedIndex_ = 0;
            }
            saveHabits();
            AudioHal::instance().playProceduralSound(SoundId::Tick);
            return true;
        }
    }
    return false;
}

void HabitTrackerPage::seedDefaultHabits() noexcept {
    habits_.magic = 0x48414254;
    habits_.count = 4;

    strncpy(habits_.items[0].title, "Drink 2L Water", sizeof(habits_.items[0].title) - 1);
    habits_.items[0].streakDays = 5;
    habits_.items[0].completedToday = false;

    strncpy(habits_.items[1].title, "Deep Work 2h", sizeof(habits_.items[1].title) - 1);
    habits_.items[1].streakDays = 3;
    habits_.items[1].completedToday = false;

    strncpy(habits_.items[2].title, "Workout 30m", sizeof(habits_.items[2].title) - 1);
    habits_.items[2].streakDays = 7;
    habits_.items[2].completedToday = false;

    strncpy(habits_.items[3].title, "Read 15 Pages", sizeof(habits_.items[3].title) - 1);
    habits_.items[3].streakDays = 2;
    habits_.items[3].completedToday = false;
}

void HabitTrackerPage::loadHabits() noexcept {
    size_t len = 0;
    uint8_t* buf = StorageHal::instance().readFileToPsram("/state/habits.bin", &len, nullptr, false);
    if (buf != nullptr && len >= sizeof(HabitsFile)) {
        std::memcpy(&habits_, buf, sizeof(HabitsFile));
        StorageHal::instance().freeBuffer(buf);
    } else {
        seedDefaultHabits();
        saveHabits();
    }
}

void HabitTrackerPage::saveHabits() noexcept {
    StorageHal::instance().writeFileAtomic(
        "/state/habits.bin",
        reinterpret_cast<const uint8_t*>(&habits_),
        sizeof(HabitsFile),
        true
    );
}

} // namespace petbot::firmware::apps
