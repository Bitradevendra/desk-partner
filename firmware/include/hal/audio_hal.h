/**
 * Hardware Abstraction Layer - Non-Blocking I2S Audio Driver & Procedural Synthesizer
 * 
 * Features:
 * - Dual I2S Architecture:
 *   - I2S_NUM_1: MAX98357A Class-D Speaker Amplifier (16kHz 16-bit Mono, DMA buffers)
 *   - I2S_NUM_0: INMP441 / ICS-43434 MEMS Microphone (16kHz, downsampled 16-bit Mono, DMA buffers)
 * - Real-Time Procedural Pet Synthesizer:
 *   - CHIRP (Rising sweep 800Hz->2200Hz with ADSR)
 *   - HAPPY_TRILL (C6->E6->G6->C7 harmonic arpeggio)
 *   - PURR (110Hz carrier + 24Hz LFO amplitude modulation)
 *   - CURIOUS_BEEP (1200Hz->950Hz->1650Hz pitch contour)
 *   - SLEEPY_SIGH (900Hz->380Hz descending warm glide)
 *   - TICK (8ms 1800Hz micro-click for UI haptics)
 *   - ALARM_CHIME (Harmonic Pomodoro completion chime)
 * - Dedicated FreeRTOS Audio Task (Task_AudioEngine, Core 0, Priority 4)
 * - Thread-safe, lock-free FreeRTOS sound dispatch queue (xQueueSendFromISR safe)
 * - Seamless Downlink Voice Streaming (pushPcmDownlinkFrame) and Uplink Mic (readMicUplinkFrame with RMS & VAD)
 */
#pragma once

#include <cstdint>
#include <cstddef>
#include <atomic>
#if defined(__has_include) && __has_include(<span>) && __cplusplus >= 202002L
#include <span>
#endif

#include "petbot_protocol.h"
#include "petbot_widget_bytecode.h"
#include "hal/board_pins.h"

#ifdef ESP32
#include <driver/i2s.h>
#include <driver/gpio.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <freertos/semphr.h>
#endif

namespace petbot::hal {

// ============================================================================
// Audio Architectural Constants
// ============================================================================
inline constexpr uint32_t AUDIO_SAMPLE_RATE     = 16000; // 16,000 Hz sample rate
inline constexpr uint32_t AUDIO_FRAME_MS        = 20;    // 20ms frame period
inline constexpr size_t   AUDIO_FRAME_SAMPLES   = 320;   // 16000 * 0.020 = 320 samples
inline constexpr size_t   AUDIO_FRAME_BYTES     = AUDIO_FRAME_SAMPLES * sizeof(int16_t); // 640 bytes
inline constexpr size_t   I2S_DMA_BUF_COUNT     = 6;     // 6 DMA buffers = 120ms total DMA depth
inline constexpr size_t   I2S_DMA_BUF_LEN       = AUDIO_FRAME_SAMPLES; // 320 samples per buffer

// Downlink voice streaming ring buffer capacity in samples (8 seconds @ 16kHz in Octal PSRAM)
inline constexpr size_t   DOWNLINK_RING_SAMPLES = 128000;

// Voice Activity Detection default RMS threshold
inline constexpr uint16_t DEFAULT_VAD_THRESHOLD = 650;

// ============================================================================
// Procedural Sound Identifiers
// ============================================================================
enum class SoundId : uint8_t {
    None        = 0,
    Chirp       = 1,
    HappyTrill  = 2,
    Purr        = 3,
    CuriousBeep = 4,
    SleepySigh  = 5,
    Tick        = 6,
    AlarmChime  = 7,

    // Uppercase Convenience Aliases
    CHIRP        = Chirp,
    HAPPY_TRILL  = HappyTrill,
    PURR         = Purr,
    CURIOUS_BEEP = CuriousBeep,
    SLEEPY_SIGH  = SleepySigh,
    TICK         = Tick,
    ALARM_CHIME  = AlarmChime
};

// ============================================================================
// Audio HAL Singleton Controller
// ============================================================================
class AudioHal {
public:
    static AudioHal& instance() noexcept;

    AudioHal(const AudioHal&) = delete;
    AudioHal& operator=(const AudioHal&) = delete;
    AudioHal(AudioHal&&) = delete;
    AudioHal& operator=(AudioHal&&) = delete;

    /**
     * Initialize I2S_NUM_1 for MAX98357A Speaker Amp and I2S_NUM_0 for MEMS Mic,
     * create audio queues and downlink ring buffer, and spawn Task_AudioEngine on Core 0.
     * @return true on successful hardware and RTOS initialization.
     */
    [[nodiscard]] bool init() noexcept;

    /**
     * Non-blocking trigger of procedural pet sound effect.
     * Safe to invoke from any task or ISR context (xQueueSendFromISR safe).
     * @param id Sound identifier.
     * @return true if queued successfully.
     */
    bool playProceduralSound(SoundId id) noexcept;

    /**
     * Overload for compatibility with petbot::widget::bytecode::SoundId.
     */
    bool playProceduralSound(petbot::widget::bytecode::SoundId id) noexcept;

    /**
     * Push raw 16kHz 16-bit mono PCM downlink audio frames into the streaming ring buffer.
     * Thread-safe and non-blocking. Used by Phase 3 Agentic Mode voice output.
     * @param samples Pointer to PCM samples.
     * @param count Number of samples.
     * @return Number of samples successfully accepted into ring buffer.
     */
    size_t pushPcmDownlinkFrame(const int16_t* samples, size_t count) noexcept;

    /**
     * Read one 20ms frame (320 samples) from I2S MEMS Microphone.
     * Computes RMS energy and determines Voice Activity Detection (VAD) state.
     * @param outSamples Buffer to receive 320 samples of 16-bit mono PCM (must be >= 320 elements).
     * @param outRms Reference to receive IEEE RMS audio energy (0 - 65535).
     * @param outVad Reference to receive VAD boolean flag.
     * @return true if 320 samples read successfully.
     */
    bool readMicUplinkFrame(int16_t* outSamples, uint16_t& outRms, bool& outVad) noexcept;

    /**
     * Set master speaker playback volume percentage (0 - 100%).
     */
    void setVolumePct(uint8_t volumePct) noexcept;
    [[nodiscard]] uint8_t getVolumePct() const noexcept { return volumePct_; }

    /**
     * Set or mute speaker amplifier shutdown pin (PIN_SPK_SD_MODE).
     */
    void setSpeakerMute(bool mute) noexcept;
    [[nodiscard]] bool isSpeakerMuted() const noexcept { return isMuted_; }

    /**
     * Set Voice Activity Detection RMS sensitivity threshold.
     */
    void setVadThreshold(uint16_t threshold) noexcept { vadThreshold_ = threshold; }
    [[nodiscard]] uint16_t getVadThreshold() const noexcept { return vadThreshold_; }

    /**
     * Check if a procedural sound or downlink voice stream is currently rendering.
     */
    [[nodiscard]] bool isPlaying() const noexcept;

    /**
     * Stop active procedural sound playback immediately.
     */
    void stopProceduralSound() noexcept;

    // Direct synthesizer simulation helper (used for host unit tests & DSP verification)
    static void renderProceduralSamples(
        SoundId id, 
        size_t sampleOffset, 
        int16_t* outBuffer, 
        size_t sampleCount, 
        bool& outFinished
    ) noexcept;

    // Total duration in samples for a given procedural sound
    static size_t getProceduralSoundLength(SoundId id) noexcept;

private:
    AudioHal() noexcept;
    ~AudioHal() noexcept;

    // Hardware init helpers
    bool initSpeakerI2S() noexcept;
    bool initMicI2S() noexcept;

    // Dedicated FreeRTOS Audio Task
    static void audioEngineTask(void* param) noexcept;
    void runAudioEngine() noexcept;

    // Internal Ring Buffer for Downlink Audio
    class DownlinkRingBuffer {
    public:
        DownlinkRingBuffer() noexcept = default;
        ~DownlinkRingBuffer() noexcept;
        bool allocate(size_t capacity) noexcept;
        void free() noexcept;
        size_t write(const int16_t* samples, size_t count) noexcept;
        size_t read(int16_t* dest, size_t count) noexcept;
        [[nodiscard]] size_t available() const noexcept;
        void clear() noexcept;

    private:
        int16_t* buffer_{nullptr};
        size_t capacity_{0};
        size_t head_{0};
        size_t tail_{0};
        size_t count_{0};
#ifdef ESP32
        portMUX_TYPE spinlock_ = portMUX_INITIALIZER_UNLOCKED;
#endif
    };

    bool isInitialized_{false};
    uint8_t volumePct_{100};
    bool isMuted_{false};
    uint16_t vadThreshold_{DEFAULT_VAD_THRESHOLD};

    DownlinkRingBuffer downlinkBuffer_{};

    // Active Procedural Sound State
    std::atomic<SoundId> activeSound_{SoundId::None};
    std::atomic<size_t>  soundSampleIndex_{0};
    std::atomic<size_t>  soundTotalSamples_{0};

#ifdef ESP32
    QueueHandle_t soundQueue_{nullptr};
    TaskHandle_t  audioTaskHandle_{nullptr};
#endif
};

} // namespace petbot::hal
