/**
 * Built-In Offline Applications for 128x160 Display Carousel
 * 
 * Includes:
 * 1. PetHomePage: Animated expression engine face with status overlay & micro-interactions
 * 2. ClockWeatherPage: High-contrast digital/analog clock with cached weather card & peeking pet
 * 3. PomodoroPage: Arc progress timer, focus/break phases, and pet avatar
 * 4. QuickNotesPage: Paginated word-wrapped notes viewer with persistence & pin toggling
 * 5. HabitTrackerPage: Daily habit checklist with streak counters, completion persistence, & celebrations
 */
#pragma once

#include <cstdint>
#include <cstddef>
#include <string_view>
#include <memory>

#include "apps/app_page.h"
#include "hal/psram_allocator.h"
#include "hal/storage_hal.h"
#include "hal/audio_hal.h"
#include "hal/touch_hal.h"
#include "ui/expression_engine.h"

namespace petbot::firmware::apps {

using petbot::hal::Canvas128x160;
namespace colors = petbot::hal::colors;
using petbot::hal::TouchGesture;
using petbot::hal::TouchGestureEvent;
using petbot::hal::StorageHal;
using petbot::hal::AudioHal;
using petbot::hal::SoundId;
using petbot::firmware::ui::ExpressionEngine;
using petbot::protocol::EmotionId;

// ============================================================================
// Page 1: PetHomePage
// ============================================================================

class PetHomePage : public IAppPage {
public:
    PetHomePage() noexcept = default;
    ~PetHomePage() override = default;

    [[nodiscard]] const char* getPageId() const noexcept override { return "home"; }
    [[nodiscard]] const char* getPageTitle() const noexcept override { return "Pet"; }

    void onEnter() override;
    void onExit() override;

    void onTouchGesture(TouchGestureType gesture) override;
    void update(uint32_t nowMs, float dt) override;
    void render(Canvas128x160& canvas) override;

private:
    void renderTopStatusBar(Canvas128x160& canvas, uint32_t nowMs) noexcept;
    void renderStatusSummaryOverlay(Canvas128x160& canvas, uint32_t nowMs) noexcept;

    bool showStatusOverlay_{false};
    uint32_t statusOverlayStartMs_{0};
    uint8_t microInteractionIndex_{0};
    uint32_t winkExpiresMs_{0};
};

// ============================================================================
// Page 2: ClockWeatherPage
// ============================================================================

enum class WeatherCondition : uint8_t {
    Sunny  = 0,
    Cloudy = 1,
    Rain   = 2,
    Night  = 3
};

struct WeatherCache {
    uint32_t magic{0x57544852}; // 'WTHR'
    int8_t   temperatureC{23};
    uint8_t  humidityPct{48};
    WeatherCondition condition{WeatherCondition::Sunny};
    char     city[16]{"Home"};
};

class ClockWeatherPage : public IAppPage {
public:
    ClockWeatherPage() noexcept;
    ~ClockWeatherPage() override = default;

    [[nodiscard]] const char* getPageId() const noexcept override { return "clock"; }
    [[nodiscard]] const char* getPageTitle() const noexcept override { return "Clock"; }

    void onEnter() override;
    void onExit() override;

    void onTouchGesture(TouchGestureType gesture) override;
    void update(uint32_t nowMs, float dt) override;
    void render(Canvas128x160& canvas) override;

    void updateWeather(int8_t tempC, uint8_t humidity, WeatherCondition cond, const char* city) noexcept;
    void setClockMode(uint8_t mode) noexcept;
    void syncTime(uint32_t unixSec, int32_t tzOffsetSec = 0, const char* dateLabel = nullptr) noexcept;

private:
    void renderDigitalClock(Canvas128x160& canvas, uint32_t nowMs) noexcept;
    void renderAnalogClock(Canvas128x160& canvas, uint32_t nowMs) noexcept;
    void renderWeatherCard(Canvas128x160& canvas, int16_t y) noexcept;
    void renderWeatherIcon(Canvas128x160& canvas, int16_t cx, int16_t cy, WeatherCondition cond) noexcept;
    void renderPeekingPetEyes(Canvas128x160& canvas, uint32_t nowMs) noexcept;

    void loadWeatherState() noexcept;
    void saveWeatherState() noexcept;

    uint8_t clockMode_{0}; // 0 = Digital Cyberpunk, 1 = Analog Watch
    WeatherCache weather_{};
    uint32_t epochOffsetSec_{0};
    int32_t tzOffsetSec_{0};
    char dateLabel_[20]{"SUN 15 NOV 2026"};
    uint32_t nextBlinkMs_{3500};
    bool peekingBlinkClosed_{false};
    uint32_t blinkEndMs_{0};
};

// ============================================================================
// Page 3: PomodoroPage
// ============================================================================

enum class PomodoroPhase : uint8_t {
    Focus      = 0,
    ShortBreak = 1,
    LongBreak  = 2
};

struct PomodoroStats {
    uint32_t magic{0x504F4D4F}; // 'POMO'
    uint32_t totalFocusMinutesToday{0};
    uint16_t completedSessionsTotal{0};
    uint16_t currentPhase{0};
};

class PomodoroPage : public IAppPage {
public:
    PomodoroPage() noexcept;
    ~PomodoroPage() override = default;

    [[nodiscard]] const char* getPageId() const noexcept override { return "pomodoro"; }
    [[nodiscard]] const char* getPageTitle() const noexcept override { return "Pomo"; }

    void onEnter() override;
    void onExit() override;

    void onTouchGesture(TouchGestureType gesture) override;
    void update(uint32_t nowMs, float dt) override;
    void render(Canvas128x160& canvas) override;

    [[nodiscard]] PomodoroPhase getPhase() const noexcept { return phase_; }
    [[nodiscard]] uint16_t getRemainingSeconds() const noexcept { return remainingSeconds_; }
    [[nodiscard]] bool isRunning() const noexcept { return isRunning_; }
    [[nodiscard]] uint32_t getTotalFocusMinutes() const noexcept { return stats_.totalFocusMinutesToday; }

    void startFocus() noexcept;
    void startCustomFocus(uint16_t minutes) noexcept;
    void startBreak(bool longBreak = false) noexcept;
    void pauseFocus() noexcept;
    void toggleFocus() noexcept;
    void resetFocus() noexcept;

private:
    void advancePhase() noexcept;
    void resetCurrentPhase() noexcept;
    void loadStats() noexcept;
    void saveStats() noexcept;

    void renderArcProgressGauge(Canvas128x160& canvas, int16_t cx, int16_t cy, int16_t r, float progress) noexcept;
    void renderMiniPetAvatar(Canvas128x160& canvas, int16_t cx, int16_t cy, bool isFocus) noexcept;
    void renderCelebrationOverlay(Canvas128x160& canvas, uint32_t nowMs) noexcept;

    PomodoroPhase phase_{PomodoroPhase::Focus};
    uint16_t remainingSeconds_{25 * 60};
    uint16_t totalPhaseSeconds_{25 * 60};
    bool isRunning_{false};
    uint8_t completedSessionsInSet_{0};
    uint32_t lastSecondTickMs_{0};
    bool showCelebration_{false};
    uint32_t celebrationExpiresMs_{0};

    PomodoroStats stats_{};
};

// ============================================================================
// Page 4: QuickNotesPage
// ============================================================================

struct NoteItem {
    char title[32]{0};
    char body[160]{0};
    bool pinned{false};
};

struct NotesFile {
    uint32_t magic{0x4E4F5445}; // 'NOTE'
    uint8_t  count{3};
    NoteItem items[8]{};
};

class QuickNotesPage : public IAppPage {
public:
    QuickNotesPage() noexcept;
    ~QuickNotesPage() override = default;

    [[nodiscard]] const char* getPageId() const noexcept override { return "notes"; }
    [[nodiscard]] const char* getPageTitle() const noexcept override { return "Notes"; }

    void onEnter() override;
    void onExit() override;

    void onTouchGesture(TouchGestureType gesture) override;
    void update(uint32_t nowMs, float dt) override;
    void render(Canvas128x160& canvas) override;

    void addOrUpdateNote(const char* title, const char* body, bool pinned) noexcept;
    bool setNotePinnedByTitle(const char* query, bool pinned) noexcept;
    bool deleteNoteByTitle(const char* query) noexcept;
    [[nodiscard]] const NotesFile& getNotes() const noexcept { return notes_; }
    [[nodiscard]] uint8_t getActiveNoteIndex() const noexcept { return activeNoteIndex_; }

private:
    void loadNotes() noexcept;
    void saveNotes() noexcept;
    void seedStarterNotes() noexcept;
    void renderWordWrappedBody(Canvas128x160& canvas, const char* text, int16_t startX, int16_t startY, int16_t maxW) noexcept;

    NotesFile notes_{};
    uint8_t activeNoteIndex_{0};
};

// ============================================================================
// Page 5: HabitTrackerPage
// ============================================================================

struct HabitItem {
    char     title[32]{0};
    uint16_t streakDays{0};
    bool     completedToday{false};
};

struct HabitsFile {
    uint32_t  magic{0x48414254}; // 'HABT'
    uint8_t   count{4};
    HabitItem items[8]{};
};

class HabitTrackerPage : public IAppPage {
public:
    HabitTrackerPage() noexcept;
    ~HabitTrackerPage() override = default;

    [[nodiscard]] const char* getPageId() const noexcept override { return "habits"; }
    [[nodiscard]] const char* getPageTitle() const noexcept override { return "Habits"; }

    void onEnter() override;
    void onExit() override;

    void onTouchGesture(TouchGestureType gesture) override;
    void update(uint32_t nowMs, float dt) override;
    void render(Canvas128x160& canvas) override;

    bool addHabit(const char* title) noexcept;
    bool setHabitCompletedByName(const char* query, bool completed = true) noexcept;
    bool removeHabitByName(const char* query) noexcept;
    [[nodiscard]] const HabitsFile& getHabits() const noexcept { return habits_; }
    [[nodiscard]] uint8_t getSelectedIndex() const noexcept { return selectedIndex_; }

private:
    void loadHabits() noexcept;
    void saveHabits() noexcept;
    void seedDefaultHabits() noexcept;
    void renderCelebrationOverlay(Canvas128x160& canvas, uint32_t nowMs) noexcept;

    HabitsFile habits_{};
    uint8_t selectedIndex_{0};
    bool showCelebration_{false};
    uint32_t celebrationExpiresMs_{0};
};

} // namespace petbot::firmware::apps
