#include "hal/audio_hal.h"
#include "audio/aha_wav.h"
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
        6144,
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
        // Dual-slot stereo output ensures MAX98357A receives full audio whether SD_MODE selects L (3.3V), R, or (L+R)/2
        .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
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

    const esp_err_t drvErr = i2s_driver_install(I2S_NUM_1, &i2sSpkConfig, 0, nullptr);
    if (drvErr != ESP_OK) {
        Serial.printf("[AudioHal] ERROR: i2s_driver_install(I2S_NUM_1) failed: 0x%x\n", drvErr);
        return false;
    }
    const esp_err_t pinErr = i2s_set_pin(I2S_NUM_1, &pinSpkConfig);
    if (pinErr != ESP_OK) {
        Serial.printf("[AudioHal] ERROR: i2s_set_pin(I2S_NUM_1) failed: 0x%x\n", pinErr);
        return false;
    }
    i2s_zero_dma_buffer(I2S_NUM_1);

    // Reset & cleanly drive speaker SD_MODE HIGH (INPUT_OUTPUT allows pin readback verification)
    if (petbot::firmware::hal::PIN_SPK_SD_MODE >= 0) {
        const auto sdPin = static_cast<gpio_num_t>(petbot::firmware::hal::PIN_SPK_SD_MODE);
        gpio_reset_pin(sdPin);
        gpio_set_direction(sdPin, GPIO_MODE_INPUT_OUTPUT);
        gpio_set_level(sdPin, 1);
    }
    isMuted_ = false;
    Serial.printf("[AudioHal] Speaker MAX98357A I2S Stereo Active (BCLK=%d, LRCK=%d, DOUT=%d, SD=%d)\n",
                  petbot::firmware::hal::PIN_SPK_BCLK,
                  petbot::firmware::hal::PIN_SPK_LRCK,
                  petbot::firmware::hal::PIN_SPK_DOUT,
                  petbot::firmware::hal::PIN_SPK_SD_MODE);
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
    size_t bytesRead = 0;
    const esp_err_t err = i2s_read(
        I2S_NUM_0,
        micRawBuffer_,
        sizeof(micRawBuffer_),
        &bytesRead,
        pdMS_TO_TICKS(AUDIO_FRAME_MS * 2)
    );

    if (err != ESP_OK || bytesRead < sizeof(micRawBuffer_)) {
        micFramesFail_++;
        return false;
    }
    micFramesOk_++;

    int64_t meanSum = 0;
    for (size_t i = 0; i < AUDIO_FRAME_SAMPLES; ++i) {
        // INMP441 24-bit I2S shifted cleanly into int16 range (in-place to save task stack)
        const int32_t s = micRawBuffer_[i] >> 15;
        micRawBuffer_[i] = s;
        meanSum += s;
    }

    // Subtract frame DC offset so constant MEMS/electrical bias never triggers false VAD
    const int32_t dcMean = static_cast<int32_t>(meanSum / static_cast<int64_t>(AUDIO_FRAME_SAMPLES));
    uint64_t sumSquares = 0;
    for (size_t i = 0; i < AUDIO_FRAME_SAMPLES; ++i) {
        const int32_t ac = std::clamp<int32_t>(micRawBuffer_[i] - dcMean, -32767, 32767);
        const int16_t s16 = static_cast<int16_t>(ac);
        outSamples[i] = s16;
        sumSquares += static_cast<uint64_t>(ac * ac);
    }

    outRms = static_cast<uint16_t>(std::sqrt(sumSquares / AUDIO_FRAME_SAMPLES));
    lastMicRms_ = outRms;

    // Adaptive ambient noise floor: rapid calibration on first ~2.5s (125 frames), slow track when quiet
    if (micWarmupFrames_ < 125) {
        noiseFloorRms_ = (micWarmupFrames_ == 0)
            ? static_cast<float>(outRms)
            : (noiseFloorRms_ * 0.85f + static_cast<float>(outRms) * 0.15f);
        micWarmupFrames_++;
        outVad = false;
        return true;
    }

    if (static_cast<float>(outRms) < (noiseFloorRms_ * 2.2f + 250.0f)) {
        noiseFloorRms_ = noiseFloorRms_ * 0.985f + static_cast<float>(outRms) * 0.015f;
    }

    const uint16_t dynamicThreshold = static_cast<uint16_t>(
        std::min<float>(12000.0f, noiseFloorRms_ * 2.8f + 380.0f)
    );
    const uint16_t effectiveThreshold = std::max<uint16_t>(vadThreshold_, dynamicThreshold);
    outVad = (outRms >= effectiveThreshold);
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
    while (true) {
        // Check for new procedural sound requests in queue
        SoundId queuedId;
        if (xQueueReceive(soundQueue_, &queuedId, 0) == pdTRUE) {
            activeSound_.store(queuedId);
            soundSampleIndex_.store(0);
            soundTotalSamples_.store(getProceduralSoundLength(queuedId));
        }

        std::memset(spkMixBuffer_, 0, sizeof(spkMixBuffer_));

        const SoundId currentSound = activeSound_.load();
        if (currentSound != SoundId::None) {
            bool finished = false;
            renderProceduralSamples(
                currentSound,
                soundSampleIndex_.load(),
                spkMixBuffer_,
                AUDIO_FRAME_SAMPLES,
                finished
            );

            soundSampleIndex_.fetch_add(AUDIO_FRAME_SAMPLES);
            if (finished || soundSampleIndex_.load() >= soundTotalSamples_.load()) {
                activeSound_.store(SoundId::None);
            }
        } else if (downlinkBuffer_.available() > 0) {
            // Mix downlink voice stream if no procedural sound active
            downlinkBuffer_.read(spkMixBuffer_, AUDIO_FRAME_SAMPLES);
        }

        // Apply full maximum speaker gain and mirror mono frame onto both Left & Right I2S slots
        const bool isVoiceDownlink = (currentSound == SoundId::None);
        const float gain = isVoiceDownlink ? 1.5f : 1.15f;
        for (size_t i = 0; i < AUDIO_FRAME_SAMPLES; ++i) {
            const int32_t scaled = static_cast<int32_t>(static_cast<float>(spkMixBuffer_[i]) * gain);
            const int16_t s = static_cast<int16_t>(std::clamp<int32_t>(scaled, -32767, 32767));
            spkStereoBuffer_[i * 2]     = s;
            spkStereoBuffer_[i * 2 + 1] = s;
        }

        // Push stereo frame to I2S_NUM_1 DMA
        size_t bytesWritten = 0;
        const esp_err_t writeErr = i2s_write(
            I2S_NUM_1,
            spkStereoBuffer_,
            sizeof(spkStereoBuffer_),
            &bytesWritten,
            portMAX_DELAY
        );
        if (writeErr == ESP_OK && bytesWritten > 0) {
            spkFramesWritten_++;
        } else {
            spkI2sErrors_++;
        }
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
        case SoundId::AhaVoice:
            return petbot::hal::assets::AHA_PCM_SAMPLE_COUNT; // Pre-recorded 16kHz PCM WAV saved in ESP32 flash
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

    if (id == SoundId::AhaVoice) {
        for (size_t i = 0; i < sampleCount; ++i) {
            const size_t globalSample = sampleOffset + i;
            if (globalSample >= totalSamples) {
                outFinished = true;
                outBuffer[i] = 0;
                continue;
            }
            const size_t byteIdx = petbot::hal::assets::AHA_WAV_HEADER_BYTES + (globalSample * 2);
            const uint16_t raw = static_cast<uint16_t>(petbot::hal::assets::AHA_WAV_DATA[byteIdx]) |
                                 (static_cast<uint16_t>(petbot::hal::assets::AHA_WAV_DATA[byteIdx + 1]) << 8);
            outBuffer[i] = static_cast<int16_t>(raw);
        }
        return;
    }

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
