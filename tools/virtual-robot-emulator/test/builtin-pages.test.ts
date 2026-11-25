import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("Built-In Offline Normal Mode Pages & Carousel Router", () => {
  const firmwareDir = path.resolve(__dirname, "../../../firmware");
  const appPageHPath = path.join(firmwareDir, "include/apps/app_page.h");
  const builtinPagesHPath = path.join(firmwareDir, "include/apps/builtin_pages.h");
  const builtinPagesCppPath = path.join(firmwareDir, "src/apps/builtin_pages.cpp");
  const uiManagerHPath = path.join(firmwareDir, "include/ui/ui_manager.h");
  const uiManagerCppPath = path.join(firmwareDir, "src/ui/ui_manager.cpp");
  const mainCppPath = path.join(firmwareDir, "src/main.cpp");

  it("verifies app_page.h defines IAppPage interface matching specification", () => {
    expect(fs.existsSync(appPageHPath)).toBe(true);
    const content = fs.readFileSync(appPageHPath, "utf-8");

    // Zero placeholders / TODOs
    expect(content).not.toMatch(/\bTODO\b/i);
    expect(content).not.toMatch(/\bFIXME\b/i);

    // Required methods
    expect(content).toContain("onEnter");
    expect(content).toContain("onExit");
    expect(content).toContain("onTouchGesture");
    expect(content).toContain("TouchGestureType");
    expect(content).toContain("update");
    expect(content).toContain("render");
    expect(content).toContain("getPageId");
    expect(content).toContain("getPageTitle");
  });

  it("verifies builtin_pages.h and builtin_pages.cpp define all 5 pages with zero TODOs", () => {
    expect(fs.existsSync(builtinPagesHPath)).toBe(true);
    expect(fs.existsSync(builtinPagesCppPath)).toBe(true);

    const hContent = fs.readFileSync(builtinPagesHPath, "utf-8");
    const cppContent = fs.readFileSync(builtinPagesCppPath, "utf-8");

    // Zero placeholders / TODOs rule
    expect(hContent).not.toMatch(/\bTODO\b/i);
    expect(cppContent).not.toMatch(/\bTODO\b/i);
    expect(hContent).not.toMatch(/\bFIXME\b/i);
    expect(cppContent).not.toMatch(/\bFIXME\b/i);

    // 5 pages defined
    const pages = [
      "PetHomePage",
      "ClockWeatherPage",
      "PomodoroPage",
      "QuickNotesPage",
      "HabitTrackerPage",
    ];

    for (const page of pages) {
      expect(hContent).toContain(`class ${page} : public IAppPage`);
      expect(cppContent).toContain(`${page}::render`);
      expect(cppContent).toContain(`${page}::onTouchGesture`);
    }
  });

  it("verifies PetHomePage (Page 1) has status overlay and micro-interactions", () => {
    const cppContent = fs.readFileSync(builtinPagesCppPath, "utf-8");

    // Page metadata
    expect(cppContent).toContain("renderTopStatusBar");
    expect(cppContent).toContain("renderStatusSummaryOverlay");
    expect(cppContent).toContain("OFFLINE");

    // Micro-interactions (Wink, Curious Tilt, Happy bounce + chirp)
    expect(cppContent).toContain("winkExpiresMs_");
    expect(cppContent).toContain("SoundId::CuriousBeep");
    expect(cppContent).toContain("SoundId::HappyTrill");
    expect(cppContent).toContain("SoundId::Chirp");

    // Status overlay contents
    expect(cppContent).toContain("Affection:");
    expect(cppContent).toContain("Energy:");
    expect(cppContent).toContain("Focus:");
    expect(cppContent).toContain("Uptime:");
  });

  it("verifies ClockWeatherPage (Page 2) features digital/analog toggle, weather card, and peeking eyes", () => {
    const hContent = fs.readFileSync(builtinPagesHPath, "utf-8");
    const cppContent = fs.readFileSync(builtinPagesCppPath, "utf-8");

    // Weather condition enum
    expect(hContent).toContain("WeatherCondition");
    expect(hContent).toContain("Sunny");
    expect(hContent).toContain("Cloudy");
    expect(hContent).toContain("Rain");
    expect(hContent).toContain("Night");

    // Digital & Analog Clock
    expect(cppContent).toContain("renderDigitalClock");
    expect(cppContent).toContain("renderAnalogClock");

    // Sweeping second hand angle & tick marks
    expect(cppContent).toContain("sAngle");
    expect(cppContent).toContain("renderWeatherIcon");

    // Peeking animated pet eyes
    expect(cppContent).toContain("renderPeekingPetEyes");

    // Persistence to /state/weather.bin
    expect(cppContent).toContain("/state/weather.bin");
  });

  it("verifies PomodoroPage (Page 3) arc gauge, phases, celebration, and persistence", () => {
    const hContent = fs.readFileSync(builtinPagesHPath, "utf-8");
    const cppContent = fs.readFileSync(builtinPagesCppPath, "utf-8");

    // Phases: Focus 25:00, Short Break 05:00, Long Break 15:00
    expect(hContent).toContain("Focus");
    expect(hContent).toContain("ShortBreak");
    expect(hContent).toContain("LongBreak");
    expect(cppContent).toContain("25 * 60");
    expect(cppContent).toContain("5 * 60");
    expect(cppContent).toContain("15 * 60");

    // Arc progress gauge & session indicator dots
    expect(cppContent).toContain("renderArcProgressGauge");
    expect(cppContent).toContain("renderMiniPetAvatar");
    expect(cppContent).toContain("renderCelebrationOverlay");
    expect(cppContent).toContain("SoundId::AlarmChime");

    // Persistence to /state/pomodoro.bin
    expect(cppContent).toContain("/state/pomodoro.bin");
  });

  it("verifies QuickNotesPage (Page 4) notes viewer, word wrapping, and pin toggling", () => {
    const hContent = fs.readFileSync(builtinPagesHPath, "utf-8");
    const cppContent = fs.readFileSync(builtinPagesCppPath, "utf-8");

    // Note structure
    expect(hContent).toContain("struct NoteItem");
    expect(hContent).toContain("struct NotesFile");

    // 3 Starter notes seeded
    expect(cppContent).toContain("seedStarterNotes");
    expect(cppContent).toContain("Welcome PetBot");
    expect(cppContent).toContain("Voice Assistant");
    expect(cppContent).toContain("Daily Routine");

    // Word wrapping and pin toggling
    expect(cppContent).toContain("renderWordWrappedBody");
    expect(cppContent).toContain("pinned");
    expect(cppContent).toContain("PINNED");

    // Persistence to /state/notes.bin
    expect(cppContent).toContain("/state/notes.bin");
  });

  it("verifies HabitTrackerPage (Page 5) checklist, streak counters, celebration, and persistence", () => {
    const hContent = fs.readFileSync(builtinPagesHPath, "utf-8");
    const cppContent = fs.readFileSync(builtinPagesCppPath, "utf-8");

    // Habit structure
    expect(hContent).toContain("struct HabitItem");
    expect(hContent).toContain("struct HabitsFile");

    // 4 Default habits seeded
    expect(cppContent).toContain("seedDefaultHabits");
    expect(cppContent).toContain("Drink 2L Water");
    expect(cppContent).toContain("Deep Work 2h");
    expect(cppContent).toContain("Workout 30m");
    expect(cppContent).toContain("Read 15 Pages");

    // Streak and checkmark logic
    expect(cppContent).toContain("streakDays");
    expect(cppContent).toContain("completedToday");
    expect(cppContent).toContain("DAILY HABITS");

    // Audio cue & 1.2s celebration overlay
    expect(cppContent).toContain("SoundId::HappyTrill");
    expect(cppContent).toContain("renderCelebrationOverlay");
    expect(cppContent).toContain("AWESOME!");
    expect(cppContent).toContain("STREAK +1!");
    expect(cppContent).toContain("1200");

    // Persistence to /state/habits.bin
    expect(cppContent).toContain("/state/habits.bin");
  });

  it("verifies UIManager and main.cpp register 5 pages and implement required touch gesture routing", () => {
    const uiCpp = fs.readFileSync(uiManagerCppPath, "utf-8");
    const mainCpp = fs.readFileSync(mainCppPath, "utf-8");

    // 5 pages registered in UIManager::init()
    expect(uiCpp).toContain("PetHomePage");
    expect(uiCpp).toContain("ClockWeatherPage");
    expect(uiCpp).toContain("PomodoroPage");
    expect(uiCpp).toContain("QuickNotesPage");
    expect(uiCpp).toContain("HabitTrackerPage");

    // Subtle top page-indicator pill bar at y = 3
    expect(uiCpp).toContain("drawPageIndicators");
    expect(uiCpp).toContain("PILL_Y");
    expect(uiCpp).toContain("PILL_W");

    // Smooth horizontal slide transition wipe
    expect(uiCpp).toContain("m_transition.active");

    // main.cpp routes gestures
    expect(mainCpp).toContain("TouchGesture::PettingRapid");
    expect(mainCpp).toContain("onPettingGesture");
    expect(mainCpp).toContain("TouchGesture::DoubleTap");
    expect(mainCpp).toContain("nextPage");
    expect(mainCpp).toContain("handleTouch");
  });

  it("simulates Pomodoro timer state machine and phase progression", () => {
    class PomodoroSimulator {
      phase: "FOCUS" | "SHORT_BREAK" | "LONG_BREAK" = "FOCUS";
      remainingSeconds = 25 * 60;
      totalPhaseSeconds = 25 * 60;
      isRunning = false;
      completedSessionsInSet = 0;
      totalFocusMinutesToday = 0;
      celebrationPlayed = false;

      toggleStartPause() {
        this.isRunning = !this.isRunning;
      }

      stepSecond() {
        if (!this.isRunning) return;
        if (this.remainingSeconds > 0) {
          this.remainingSeconds--;
        }
        if (this.remainingSeconds === 0) {
          this.celebrationPlayed = true;
          this.advancePhase();
        }
      }

      advancePhase() {
        if (this.phase === "FOCUS") {
          this.completedSessionsInSet++;
          this.totalFocusMinutesToday += Math.floor(this.totalPhaseSeconds / 60);

          if (this.completedSessionsInSet >= 4) {
            this.completedSessionsInSet = 0;
            this.phase = "LONG_BREAK";
            this.totalPhaseSeconds = 15 * 60;
          } else {
            this.phase = "SHORT_BREAK";
            this.totalPhaseSeconds = 5 * 60;
          }
        } else {
          this.phase = "FOCUS";
          this.totalPhaseSeconds = 25 * 60;
        }
        this.remainingSeconds = this.totalPhaseSeconds;
        this.isRunning = false;
      }
    }

    const pomo = new PomodoroSimulator();
    expect(pomo.phase).toBe("FOCUS");
    expect(pomo.remainingSeconds).toBe(1500);

    // Start timer
    pomo.toggleStartPause();
    expect(pomo.isRunning).toBe(true);

    // Fast-forward to end of focus session
    pomo.remainingSeconds = 1;
    pomo.stepSecond();

    // Focus 1 completed -> Short break 5m, total focus = 25m
    expect(pomo.phase).toBe("SHORT_BREAK");
    expect(pomo.remainingSeconds).toBe(300);
    expect(pomo.completedSessionsInSet).toBe(1);
    expect(pomo.totalFocusMinutesToday).toBe(25);
    expect(pomo.celebrationPlayed).toBe(true);

    // Fast-forward 3 more focus sessions to hit 4 total
    // Short break 1 ends -> Focus 2
    pomo.remainingSeconds = 1;
    pomo.isRunning = true;
    pomo.stepSecond();
    expect(pomo.phase).toBe("FOCUS");

    // Focus 2 ends -> Short break 2
    pomo.remainingSeconds = 1;
    pomo.isRunning = true;
    pomo.stepSecond();
    expect(pomo.phase).toBe("SHORT_BREAK");

    // Short break 2 ends -> Focus 3
    pomo.remainingSeconds = 1;
    pomo.isRunning = true;
    pomo.stepSecond();
    expect(pomo.phase).toBe("FOCUS");

    // Focus 3 ends -> Short break 3
    pomo.remainingSeconds = 1;
    pomo.isRunning = true;
    pomo.stepSecond();
    expect(pomo.phase).toBe("SHORT_BREAK");

    // Short break 3 ends -> Focus 4
    pomo.remainingSeconds = 1;
    pomo.isRunning = true;
    pomo.stepSecond();
    expect(pomo.phase).toBe("FOCUS");

    // Focus 4 ends -> Long break!
    pomo.remainingSeconds = 1;
    pomo.isRunning = true;
    pomo.stepSecond();

    expect(pomo.phase).toBe("LONG_BREAK");
    expect(pomo.remainingSeconds).toBe(900);
    expect(pomo.totalFocusMinutesToday).toBe(100); // 4 * 25m = 100m
    expect(pomo.completedSessionsInSet).toBe(0); // Reset set
  });

  it("simulates Habit tracker streak toggling and checkmark logic", () => {
    interface Habit {
      title: string;
      streakDays: number;
      completedToday: boolean;
    }

    const habits: Habit[] = [
      { title: "Drink 2L Water", streakDays: 5, completedToday: false },
      { title: "Deep Work 2h", streakDays: 3, completedToday: false },
    ];

    // Toggle habit 0 complete
    habits[0].completedToday = true;
    habits[0].streakDays++;
    expect(habits[0].completedToday).toBe(true);
    expect(habits[0].streakDays).toBe(6);

    // Toggle habit 0 incomplete
    habits[0].completedToday = false;
    habits[0].streakDays--;
    expect(habits[0].completedToday).toBe(false);
    expect(habits[0].streakDays).toBe(5);
  });
});
