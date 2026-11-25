#include "hal/audio_hal.h"
#include <cmath>
#include <cstring>
#include <algorithm>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace petbot::hal {

// ============================================================================
// Downlink Ring Buffer Implementation
// ============================================================================

AudioHal::DownlinkRingBuffer::~DownlinkRingBuffer() noexcept {
    free();
}

bool AudioHal::DownlinkRingBuffer::allocate(size_t capacity) noexcept {
    free();
    capacity_ = capacity;
#ifdef ESP32
    buffer_ = static_cast<int16_t*>(
        heap_caps_malloc(capacity * sizeof(int16_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
    );
    if (!buffer_) {
        buffer_ = static_cast<int16_t*>(malloc(capacity * sizeof(int16_t)));
    }
#else
    buffer_ = new (std::nothrow) int16_t[capacity];
#endif
    head_ = 0;
    tail_ = 0;
    count_ = 0;
    return buffer_ != nullptr;
}

void AudioHal::DownlinkRingBuffer::free() noexcept {
    if (buffer_) {
#ifdef ESP32
        heap_caps_free(buffer_);
#else
        delete[] buffer_;
#endif
        buffer_ = nullptr;
    }
    capacity_ = 0;
    head_ = 0;
    tail_ = 0;
    count_ = 0;
}

size_t AudioHal::DownlinkRingBuffer::write(const int16_t* samples, size_t count) noexcept {
    if (!buffer_ || !samples || count == 0) return 0;

#ifdef ESP32
    portENTER_CRITICAL(&spinlock_);
#endif
    const size_t toWrite = std::min(count, capacity_ - count_);
    if (toWrite == 0) {
#ifdef ESP32
        portEXIT_CRITICAL(&spinlock_);
#endif
        return 0;
    }

    const size_t firstPart = std::min(toWrite, capacity_ - head_);
    std::memcpy(buffer_ + head_, samples, firstPart * sizeof(int16_t));

    const size_t secondPart = toWrite - firstPart;
    if (secondPart > 0) {
        std::memcpy(buffer_, samples + firstPart, secondPart * sizeof(int16_t));
    }

    head_ = (head_ + toWrite) % capacity_;
    count_ += toWrite;

#ifdef ESP32
    portEXIT_CRITICAL(&spinlock_);
#endif
    return toWrite;
}

size_t AudioHal::DownlinkRingBuffer::read(int16_t* dest, size_t count) noexcept {
    if (!buffer_ || !dest || count == 0) return 0;

#ifdef ESP32
    portENTER_CRITICAL(&spinlock_);
#endif
    const size_t toRead = std::min(count, count_);
    if (toRead == 0) {
#ifdef ESP32
        portEXIT_CRITICAL(&spinlock_);
#endif
        return 0;
    }

    const size_t firstPart = std::min(toRead, capacity_ - tail_);
    std::memcpy(dest, buffer_ + tail_, firstPart * sizeof(int16_t));

    const size_t secondPart = toRead - firstPart;
    if (secondPart > 0) {
        std::memcpy(dest + firstPart, buffer_, secondPart * sizeof(int16_t));
    }

    tail_ = (tail_ + toRead) % capacity_;
    count_ -= toRead;

#ifdef ESP32
    portEXIT_CRITICAL(&spinlock_);
#endif
    return toRead;
}

size_t AudioHal::DownlinkRingBuffer::available() const noexcept {
    return count_;
}

void AudioHal::DownlinkRingBuffer::clear() noexcept {
#ifdef ESP32
    portENTER_CRITICAL(&spinlock_);
#endif
    head_ = 0;
    tail_ = 0;
    count_ = 0;
#ifdef ESP32
    portEXIT_CRITICAL(&spinlock_);
#endif
}

// ============================================================================
// Audio HAL Core Controller
// ============================================================================

AudioHal& AudioHal::instance() noexcept {
    static AudioHal s_instance;
    return s_instance;
}

AudioHal::AudioHal() noexcept = default;

AudioHal::~AudioHal() noexcept {
#ifdef ESP32
    if (audioTaskHandle_) {
        vTaskDelete(audioTaskHandle_);
        audioTaskHandle_ = nullptr;
    }
    if (soundQueue_) {
        vQueueDelete(soundQueue_);
        soundQueue_ = nullptr;
    }
#endif
    downlinkBuffer_.free();
}

bool AudioHal::init() noexcept {
    if (isInitialized_) return true;

    if (!downlinkBuffer_.allocate(DOWNLINK_RING_SAMPLES)) {
        return false;
    }

#ifdef ESP32
    soundQueue_ = xQueueCreate(16, sizeof(SoundId));
    if (!soundQueue_) {
        downlinkBuffer_.free();
        return false;
    }

    if (!initSpeakerI2S() || !initMicI2S()) {
        downlinkBuffer_.free();
        vQueueDelete(soundQueue_);
        soundQueue_ = nullptr;
        return false;
    }

    const BaseType_t taskCreated = xTaskCreatePinnedToCore(
        audioEngineTask,
        "Task_AudioEngine",
        4096,
        this,
        4, // Priority 4
        &audioTaskHandle_,
        0  // Pin strictly to Core 0 (Audio DMA feeding)
    );

    if (taskCreated != pdPASS) {
        downlinkBuffer_.free();
        vQueueDelete(soundQueue_);
        soundQueue_ = nullptr;
        return false;
    }
#endif

    isInitialized_ = true;
    return true;
}

bool AudioHal::initSpeakerI2S() noexcept {
#ifdef ESP32
    i2s_config_t i2sSpkConfig = {
        .mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_TX),
        .sample_rate = AUDIO_SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_ONLY_RIGHT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = static_cast<int>(I2S_DMA_BUF_COUNT),
        .dma_buf_len = static_cast<int>(I2S_DMA_BUF_LEN),
        .use_apll = false,
        .tx_desc_auto_clear = true,
        .fixed_mclk = 0
    };

    i2s_pin_config_t pinSpkConfig = {
        .mck_io_num = I2S_PIN_NO_CHANGE,
        .bck_io_num = petbot::firmware::hal::PIN_SPK_BCLK,
        .ws_io_num = petbot::firmware::hal::PIN_SPK_LRCK,
        .data_out_num = petbot::firmware::hal::PIN_SPK_DOUT,
        .data_in_num = I2S_PIN_NO_CHANGE
    };

    if (i2s_driver_install(I2S_NUM_1, &i2sSpkConfig, 0, nullptr) != ESP_OK) {
        return false;
    }
    if (i2s_set_pin(I2S_NUM_1, &pinSpkConfig) != ESP_OK) {
        return false;
    }

    // Unmute speaker amplifier
    gpio_set_direction(static_cast<gpio_num_t>(petbot::firmware::hal::PIN_SPK_SD_MODE), GPIO_MODE_OUTPUT);
    gpio_set_level(static_cast<gpio_num_t>(petbot::firmware::hal::PIN_SPK_SD_MODE), 1);
    isMuted_ = false;
#endif
    return true;
}

bool AudioHal::initMicI2S() noexcept {
#ifdef ESP32
    i2s_config_t i2sMicConfig = {
        .mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate = AUDIO_SAMPLE_RATE,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT, // INMP441 uses 32-bit I2S slot
        .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = static_cast<int>(I2S_DMA_BUF_COUNT),
        .dma_buf_len = static_cast<int>(I2S_DMA_BUF_LEN),
        .use_apll = false,
        .tx_desc_auto_clear = false,
        .fixed_mclk = 0
    };

    i2s_pin_config_t pinMicConfig = {
        .mck_io_num = I2S_PIN_NO_CHANGE,
        .bck_io_num = petbot::firmware::hal::PIN_MIC_BCLK,
        .ws_io_num = petbot::firmware::hal::PIN_MIC_WS,
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num = petbot::firmware::hal::PIN_MIC_DIN
    };

    if (i2s_driver_install(I2S_NUM_0, &i2sMicConfig, 0, nullptr) != ESP_OK) {
        return false;
    }
    if (i2s_set_pin(I2S_NUM_0, &pinMicConfig) != ESP_OK) {
        return false;
    }
#endif
    return true;
}

bool AudioHal::playProceduralSound(SoundId id) noexcept {
    if (id == SoundId::None) {
        stopProceduralSound();
        return true;
    }

#ifdef ESP32
    if (!soundQueue_) return false;
    return xQueueSend(soundQueue_, &id, 0) == pdTRUE;
#else
    activeSound_.store(id);
    soundSampleIndex_.store(0);
    soundTotalSamples_.store(getProceduralSoundLength(id));
    return true;
#endif
}

bool AudioHal::playProceduralSound(petbot::widget::bytecode::SoundId id) noexcept {
    return playProceduralSound(static_cast<SoundId>(id));
}

size_t AudioHal::pushPcmDownlinkFrame(const int16_t* samples, size_t count) noexcept {
    return downlinkBuffer_.write(samples, count);
}

bool AudioHal::readMicUplinkFrame(int16_t* outSamples, uint16_t& outRms, bool& outVad) noexcept {
    if (!outSamples) return false;

#ifdef ESP32
    int32_t raw32[AUDIO_FRAME_SAMPLES];
    size_t bytesRead = 0;
    const esp_err_t err = i2s_read(
        I2S_NUM_0,
        raw32,
        sizeof(raw32),
        &bytesRead,
        pdMS_TO_TICKS(AUDIO_FRAME_MS * 2)
    );

    if (err != ESP_OK || bytesRead < sizeof(raw32)) {
        return false;
    }

    uint64_t sumSquares = 0;
    for (size_t i = 0; i < AUDIO_FRAME_SAMPLES; ++i) {
        // INMP441 MSB 24-bit shifted into high 16 bits
        const int16_t sample16 = static_cast<int16_t>(raw32[i] >> 14);
        outSamples[i] = sample16;
        sumSquares += static_cast<uint64_t>(sample16) * static_cast<uint64_t>(sample16);
    }

    outRms = static_cast<uint16_t>(std::sqrt(sumSquares / AUDIO_FRAME_SAMPLES));
    outVad = (outRms >= vadThreshold_);
    return true;
#else
    std::memset(outSamples, 0, AUDIO_FRAME_BYTES);
    outRms = 0;
    outVad = false;
    return true;
#endif
}

void AudioHal::setVolumePct(uint8_t volumePct) noexcept {
    (void)volumePct;
    volumePct_ = 100; // Always keep speaker volume at maximum
}

void AudioHal::setSpeakerMute(bool mute) noexcept {
    isMuted_ = mute;
#ifdef ESP32
    gpio_set_level(
        static_cast<gpio_num_t>(petbot::firmware::hal::PIN_SPK_SD_MODE),
        mute ? 0 : 1
    );
#endif
}

bool AudioHal::isPlaying() const noexcept {
    return (activeSound_.load() != SoundId::None) || (downlinkBuffer_.available() > 0);
}

void AudioHal::stopProceduralSound() noexcept {
    activeSound_.store(SoundId::None);
    soundSampleIndex_.store(0);
    soundTotalSamples_.store(0);
}

// ============================================================================
// FreeRTOS Task and Procedural Synthesis Engine
// ============================================================================

void AudioHal::audioEngineTask(void* param) noexcept {
    auto* self = static_cast<AudioHal*>(param);
    self->runAudioEngine();
#ifdef ESP32
    vTaskDelete(nullptr);
#endif
}

void AudioHal::runAudioEngine() noexcept {
#ifdef ESP32
    int16_t mixBuffer[AUDIO_FRAME_SAMPLES];

    while (true) {
        // Check for new procedural sound requests in queue
        SoundId queuedId;
        if (xQueueReceive(soundQueue_, &queuedId, 0) == pdTRUE) {
            activeSound_.store(queuedId);
            soundSampleIndex_.store(0);
            soundTotalSamples_.store(getProceduralSoundLength(queuedId));
        }

        std::memset(mixBuffer, 0, sizeof(mixBuffer));

        const SoundId currentSound = activeSound_.load();
        if (currentSound != SoundId::None) {
            bool finished = false;
            renderProceduralSamples(
                currentSound,
                soundSampleIndex_.load(),
                mixBuffer,
                AUDIO_FRAME_SAMPLES,
                finished
            );

            soundSampleIndex_.fetch_add(AUDIO_FRAME_SAMPLES);
            if (finished || soundSampleIndex_.load() >= soundTotalSamples_.load()) {
                activeSound_.store(SoundId::None);
            }
        } else if (downlinkBuffer_.available() > 0) {
            // Mix downlink voice stream if no procedural sound active
            downlinkBuffer_.read(mixBuffer, AUDIO_FRAME_SAMPLES);
        }

        // Apply full maximum speaker gain (1.5x clean boost on speech, clamped to int16)
        const bool isVoiceDownlink = (currentSound == SoundId::None);
        const float gain = isVoiceDownlink ? 1.5f : 1.0f;
        for (size_t i = 0; i < AUDIO_FRAME_SAMPLES; ++i) {
            const int32_t scaled = static_cast<int32_t>(static_cast<float>(mixBuffer[i]) * gain);
            mixBuffer[i] = static_cast<int16_t>(std::clamp<int32_t>(scaled, -32767, 32767));
        }

        // Push frame to I2S_NUM_1 DMA
        size_t bytesWritten = 0;
        i2s_write(I2S_NUM_1, mixBuffer, sizeof(mixBuffer), &bytesWritten, portMAX_DELAY);
    }
#endif
}

size_t AudioHal::getProceduralSoundLength(SoundId id) noexcept {
    switch (id) {
        case SoundId::Chirp:
            return 2400; // 150ms @ 16kHz
        case SoundId::HappyTrill:
            return 4800; // 300ms @ 16kHz (4 notes x 75ms)
        case SoundId::Purr:
            return 8000; // 500ms @ 16kHz
        case SoundId::CuriousBeep:
            return 3200; // 200ms @ 16kHz
        case SoundId::SleepySigh:
            return 6400; // 400ms @ 16kHz
        case SoundId::Tick:
            return 128;  // 8ms @ 16kHz
        case SoundId::AlarmChime:
            return 9600; // 600ms @ 16kHz
        default:
            return 0;
    }
}

void AudioHal::renderProceduralSamples(
    SoundId id,
    size_t sampleOffset,
    int16_t* outBuffer,
    size_t sampleCount,
    bool& outFinished
) noexcept {
    const size_t totalSamples = getProceduralSoundLength(id);
    if (sampleOffset >= totalSamples) {
        outFinished = true;
        std::memset(outBuffer, 0, sampleCount * sizeof(int16_t));
        return;
    }

    outFinished = false;

    for (size_t i = 0; i < sampleCount; ++i) {
        const size_t globalSample = sampleOffset + i;
        if (globalSample >= totalSamples) {
            outFinished = true;
            outBuffer[i] = 0;
            continue;
        }

        const float t = static_cast<float>(globalSample) / static_cast<float>(AUDIO_SAMPLE_RATE);
        float sampleVal = 0.0f;

        switch (id) {
            case SoundId::HappyTrill: {
                // Harmonic arpeggio: C6 (1046.5Hz) -> E6 (1318.5Hz) -> G6 (1568.0Hz) -> C7 (2093.0Hz)
                constexpr float notes[4] = { 1046.5f, 1318.5f, 1568.0f, 2093.0f };
                const size_t noteIndex = std::min<size_t>(3, (globalSample * 4) / totalSamples);
                const float freq = notes[noteIndex];

                // Envelope per note
                const size_t noteSamples = totalSamples / 4;
                const size_t noteOffset = globalSample % noteSamples;
                const float noteT = static_cast<float>(noteOffset) / static_cast<float>(noteSamples);
                const float noteEnv = std::sin(noteT * static_cast<float>(M_PI));

                // Warm fundamental + subtle 2nd harmonic
                sampleVal = (std::sin(2.0f * static_cast<float>(M_PI) * freq * t) +
                             0.3f * std::sin(4.0f * static_cast<float>(M_PI) * freq * t)) * noteEnv;
                break;
            }

            case SoundId::Chirp: {
                // Rising frequency sweep: 800Hz -> 2200Hz
                const float progress = static_cast<float>(globalSample) / static_cast<float>(totalSamples);
                const float freq = 800.0f + (1400.0f * progress * progress);
                const float env = std::sin(progress * static_cast<float>(M_PI));
                sampleVal = std::sin(2.0f * static_cast<float>(M_PI) * freq * t) * env;
                break;
            }

            case SoundId::Purr: {
                // 110Hz carrier + 24Hz LFO amplitude modulation
                const float carrier = std::sin(2.0f * static_cast<float>(M_PI) * 110.0f * t);
                const float lfo = 0.6f + 0.4f * std::sin(2.0f * static_cast<float>(M_PI) * 24.0f * t);
                sampleVal = carrier * lfo * 0.8f;
                break;
            }

            case SoundId::CuriousBeep: {
                // Pitch contour: 1200Hz -> 950Hz -> 1650Hz
                const float p = static_cast<float>(globalSample) / static_cast<float>(totalSamples);
                float freq = 1200.0f;
                if (p < 0.5f) {
                    freq = 1200.0f - (250.0f * (p * 2.0f));
                } else {
                    freq = 950.0f + (700.0f * ((p - 0.5f) * 2.0f));
                }
                const float env = std::sin(p * static_cast<float>(M_PI));
                sampleVal = std::sin(2.0f * static_cast<float>(M_PI) * freq * t) * env;
                break;
            }

            case SoundId::SleepySigh: {
                // Descending warm glide: 900Hz -> 380Hz
                const float p = static_cast<float>(globalSample) / static_cast<float>(totalSamples);
                const float freq = 900.0f - (520.0f * p);
                const float env = (1.0f - p) * std::sin(p * static_cast<float>(M_PI));
                sampleVal = std::sin(2.0f * static_cast<float>(M_PI) * freq * t) * env * 0.7f;
                break;
            }

            case SoundId::Tick: {
                // 8ms 1800Hz micro-click
                const float p = static_cast<float>(globalSample) / static_cast<float>(totalSamples);
                const float env = (1.0f - p);
                sampleVal = std::sin(2.0f * static_cast<float>(M_PI) * 1800.0f * t) * env;
                break;
            }

            case SoundId::AlarmChime: {
                // Pomodoro completion chime (Dual chime 880Hz + 1760Hz)
                const float p = static_cast<float>(globalSample) / static_cast<float>(totalSamples);
                const float env = std::exp(-4.0f * p);
                sampleVal = (std::sin(2.0f * static_cast<float>(M_PI) * 880.0f * t) +
                             0.5f * std::sin(2.0f * static_cast<float>(M_PI) * 1760.0f * t)) * env;
                break;
            }

            default:
                sampleVal = 0.0f;
                break;
        }

        // Clamp to 16-bit PCM dynamic range (-32767 to +32767)
        const float clamped = std::max(-1.0f, std::min(1.0f, sampleVal));
        outBuffer[i] = static_cast<int16_t>(clamped * 28000.0f);
    }
}

} // namespace petbot::hal
