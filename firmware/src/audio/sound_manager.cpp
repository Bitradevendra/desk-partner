#include "audio/sound_manager.h"
#include "hal/audio_hal.h"
#include <Arduino.h>

namespace petbot::firmware::audio {

SoundManager::SoundManager() {
    m_soundQueue = xQueueCreate(8, sizeof(SoundEffect));
}

SoundManager::~SoundManager() {
    if (m_soundQueue != nullptr) {
        vQueueDelete(m_soundQueue);
        m_soundQueue = nullptr;
    }
}

void SoundManager::init() {
    if (m_soundQueue == nullptr) {
        m_soundQueue = xQueueCreate(8, sizeof(SoundEffect));
    }
    // Initialize Audio HAL driver
    petbot::hal::AudioHal::instance().init();
    Serial.println("[SoundManager] Audio subsystem initialized for Core 1 sound playback.");
}

void SoundManager::triggerSound(SoundEffect effect) {
    if (m_soundQueue == nullptr) return;

    // Post to lock-free FreeRTOS queue with zero block time
    if (xQueueSend(m_soundQueue, &effect, 0) != pdTRUE) {
        Serial.println("[SoundManager] Warning: Sound queue full, dropping effect.");
    } else {
        Serial.printf("[SoundManager] Sound triggered: 0x%02X\n", static_cast<uint8_t>(effect));
    }
}

void SoundManager::processQueuedSounds() {
    if (m_soundQueue == nullptr) return;

    SoundEffect effect;
    while (xQueueReceive(m_soundQueue, &effect, 0) == pdTRUE) {
        switch (effect) {
            case SoundEffect::HAPPY_TRILL:
                Serial.println("[SoundManager] Playing: >>> HAPPY_TRILL <<< (Harmonic arpeggio)");
                petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::HAPPY_TRILL);
                break;
            case SoundEffect::CHIRP:
                Serial.println("[SoundManager] Playing: Chirp");
                petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::CHIRP);
                break;
            case SoundEffect::SAD_SIGH:
                Serial.println("[SoundManager] Playing: Sad Sigh");
                petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::SLEEPY_SIGH);
                break;
            case SoundEffect::CONNECTED_CHIME:
                Serial.println("[SoundManager] Playing: Connected Chime");
                petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::ALARM_CHIME);
                break;
            case SoundEffect::DISCONNECT_TONE:
                Serial.println("[SoundManager] Playing: Disconnect Tone");
                petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::SLEEPY_SIGH);
                break;
            default:
                break;
        }

        if (m_hook) {
            m_hook(effect);
        }
    }
}

} // namespace petbot::firmware::audio
