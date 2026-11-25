#pragma once

#include <cstdint>
#include <functional>
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

namespace petbot::firmware::audio {

enum class SoundEffect : uint8_t {
    HAPPY_TRILL     = 1,
    CHIRP           = 2,
    SAD_SIGH        = 3,
    CONNECTED_CHIME = 4,
    DISCONNECT_TONE = 5
};

class SoundManager {
public:
    static SoundManager& instance() {
        static SoundManager s_instance;
        return s_instance;
    }

    SoundManager(const SoundManager&) = delete;
    SoundManager& operator=(const SoundManager&) = delete;

    void init();

    /**
     * Non-blocking trigger of procedural or synthesized sound effect.
     * Safe to invoke from Core 0 network callbacks.
     */
    void triggerSound(SoundEffect effect);
    void triggerHappyTrill() {
        triggerSound(SoundEffect::HAPPY_TRILL);
    }

    using SoundDispatchHook = std::function<void(SoundEffect)>;
    void setDispatchHook(SoundDispatchHook hook) {
        m_hook = std::move(hook);
    }

    /**
     * Called by audio task to process queued sound requests.
     */
    void processQueuedSounds();

private:
    SoundManager();
    ~SoundManager();

    QueueHandle_t m_soundQueue{nullptr};
    SoundDispatchHook m_hook{nullptr};
};

} // namespace petbot::firmware::audio
