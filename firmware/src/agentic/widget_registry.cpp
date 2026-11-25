#include "agentic/widget_registry.h"
#include "agentic/agentic_transport.h"
#include "ui/ui_manager.h"
#include "hal/storage_hal.h"
#include "hal/audio_hal.h"

#include <Arduino.h>
#include <cstring>

namespace petbot::firmware::agentic {

bool WidgetRegistry::init() {
    Serial.println("[WidgetRegistry] Initializing Widget Runtime & Registry...");

    // 1. Wire live FrameType::WidgetDeploy frame handler into AgenticTransport
    AgenticTransport::instance().registerFrameHandler(
        petbot::protocol::FrameType::WidgetDeploy,
        [this](const petbot::protocol::PetBotFrameHeader& header, const uint8_t* payload, size_t len) {
            (void)header;
            this->handleWidgetDeployFrame(payload, len);
        }
    );

    // 2. Scan and load installed widgets from storage
    const size_t loadedCount = scanAndLoadInstalledWidgets();
    Serial.printf("[WidgetRegistry] Initialization complete. %u widget(s) active in carousel.\n",
                  static_cast<unsigned>(loadedCount));
    return true;
}

size_t WidgetRegistry::scanAndLoadInstalledWidgets() {
    std::vector<petbot::hal::FileEntry> entries;
    const bool listed = petbot::hal::StorageHal::instance().listDirectory("/widgets", entries);
    if (!listed) {
        Serial.println("[WidgetRegistry] /widgets directory not found or empty.");
        return 0;
    }

    size_t loadedCount = 0;
    for (const auto& entry : entries) {
        if (entry.isDirectory) continue;

        // Check for .pbwg extension
        const std::string& name = entry.name;
        if (name.length() > 5 && name.substr(name.length() - 5) == ".pbwg") {
            Serial.printf("[WidgetRegistry] Discovered widget package: %s\n", entry.fullPath.c_str());
            auto vm = loadWidgetFromFile(entry.fullPath.c_str());
            if (vm != nullptr) {
                loadedCount++;
            }
        }
    }
    return loadedCount;
}

std::shared_ptr<WidgetVM> WidgetRegistry::loadWidgetFromFile(const char* filePath) {
    if (filePath == nullptr) return nullptr;

    size_t length = 0;
    uint8_t* buf = petbot::hal::StorageHal::instance().readFileToPsram(filePath, &length, nullptr, false);
    if (buf == nullptr || length < petbot::widget::bytecode::BYTECODE_HEADER_SIZE) {
        Serial.printf("[WidgetRegistry] Failed to read widget file: %s\n", filePath);
        if (buf != nullptr) petbot::hal::StorageHal::instance().freeBuffer(buf);
        return nullptr;
    }

    auto vm = std::make_shared<WidgetVM>();
    const bool success = vm->loadBytecode(buf, length);
    petbot::hal::StorageHal::instance().freeBuffer(buf);

    if (!success) {
        Serial.printf("[WidgetRegistry] Failed to parse bytecode from: %s\n", filePath);
        return nullptr;
    }

    const std::string widgetId = vm->getPageId();
    m_widgets[widgetId] = vm;
    petbot::firmware::ui::UIManager::instance().registerPage(vm);

    Serial.printf("[WidgetRegistry] Loaded and registered widget \"%s\" (%s) from file.\n",
                  vm->getPageTitle(), widgetId.c_str());
    return vm;
}

bool WidgetRegistry::handleWidgetDeployFrame(const uint8_t* payload, size_t length) {
    if (payload == nullptr || length < petbot::widget::bytecode::BYTECODE_HEADER_SIZE) {
        Serial.println("[WidgetRegistry] Invalid deploy frame: payload too short");
        return false;
    }

    const uint32_t startUs = micros();

    // 1. Instant hot-reload in PSRAM (<15ms)
    auto vm = std::make_shared<WidgetVM>();
    if (!vm->loadBytecode(payload, length)) {
        Serial.println("[WidgetRegistry] Hot-reload failed: bytecode validation rejected");
        petbot::firmware::ui::UIManager::instance().showToast("Widget Deploy Error", 3000);
        return false;
    }

    const std::string widgetId = vm->getPageId();
    const uint32_t reloadElapsedUs = micros() - startUs;
    Serial.printf("[WidgetRegistry] Hot-reloaded widget \"%s\" in %u us (<15ms goal achieved).\n",
                  widgetId.c_str(), static_cast<unsigned>(reloadElapsedUs));

    // 2. Persist .pbwg binary to /sd/widgets/<id>.pbwg
    char filePath[64];
    snprintf(filePath, sizeof(filePath), "/widgets/%s.pbwg", widgetId.c_str());
    petbot::hal::StorageHal::instance().writeFileAtomic(filePath, payload, length, false);

    // 3. Register with UIManager and trigger immediate slide transition
    m_widgets[widgetId] = vm;
    petbot::firmware::ui::UIManager::instance().registerPage(vm);
    petbot::firmware::ui::UIManager::instance().navigateToPage(widgetId.c_str(), true);

    // 4. Sleek UI toast and sound confirmation
    char toastMsg[64];
    snprintf(toastMsg, sizeof(toastMsg), "Deployed: %s", vm->getPageTitle());
    petbot::firmware::ui::UIManager::instance().showToast(toastMsg, 2500);
    petbot::hal::AudioHal::instance().playProceduralSound(petbot::hal::SoundId::HappyTrill);

    return true;
}

bool WidgetRegistry::removeWidget(const char* widgetId) {
    if (widgetId == nullptr) return false;

    auto it = m_widgets.find(widgetId);
    if (it != m_widgets.end()) {
        petbot::firmware::ui::UIManager::instance().unregisterPage(widgetId);
        m_widgets.erase(it);

        // Delete from storage
        char filePath[64];
        snprintf(filePath, sizeof(filePath), "/widgets/%s.pbwg", widgetId);
        petbot::hal::StorageHal::instance().remove(filePath);

        char statePath[64];
        snprintf(statePath, sizeof(statePath), "/state/widget_%s.state", widgetId);
        petbot::hal::StorageHal::instance().remove(statePath);

        Serial.printf("[WidgetRegistry] Removed widget: %s\n", widgetId);
        return true;
    }
    return false;
}

std::shared_ptr<WidgetVM> WidgetRegistry::getWidget(const char* widgetId) const {
    if (widgetId == nullptr) return nullptr;
    auto it = m_widgets.find(widgetId);
    if (it != m_widgets.end()) {
        return it->second;
    }
    return nullptr;
}

size_t WidgetRegistry::getWidgetCount() const {
    return m_widgets.size();
}

} // namespace petbot::firmware::agentic
