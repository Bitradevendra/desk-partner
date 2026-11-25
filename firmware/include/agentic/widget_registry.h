#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <memory>
#include <unordered_map>
#include <vector>

#include "agentic/widget_vm.h"
#include "petbot_protocol.h"

namespace petbot::firmware::agentic {

/**
 * Central Widget Registry & Deployment Coordinator.
 * Manages installed .pbwg widget packages on MicroSD / Flash storage,
 * handles live FrameType::WidgetDeploy OTA frames (<15ms hot-reload),
 * and syncs active apps with UIManager's page carousel.
 */
class WidgetRegistry {
public:
    static WidgetRegistry& instance() {
        static WidgetRegistry s_instance;
        return s_instance;
    }

    WidgetRegistry(const WidgetRegistry&) = delete;
    WidgetRegistry& operator=(const WidgetRegistry&) = delete;

    /**
     * Initialize registry subsystem:
     * - Wire FrameType::WidgetDeploy frame handler into AgenticTransport
     * - Scan /sd/widgets/ for installed .pbwg packages
     * @return true on success
     */
    bool init();

    /**
     * Scan /sd/widgets/ (or /widgets/ fallback) and load all installed widgets into UIManager.
     * @return Number of widgets loaded.
     */
    size_t scanAndLoadInstalledWidgets();

    /**
     * Load a single widget from a .pbwg file on storage.
     */
    std::shared_ptr<WidgetVM> loadWidgetFromFile(const char* filePath);

    /**
     * Handle live FrameType::WidgetDeploy frame:
     * 1. Validate bytecode header and CRC16 checksum
     * 2. Instant hot-reload in PSRAM (<15ms)
     * 3. Atomically persist to /sd/widgets/<id>.pbwg
     * 4. Register with UIManager and trigger slide animation
     * @return true on successful deployment
     */
    bool handleWidgetDeployFrame(const uint8_t* payload, size_t length);

    /**
     * Remove an installed widget from memory and storage.
     */
    bool removeWidget(const char* widgetId);

    /**
     * Query registered widget instance by ID.
     */
    [[nodiscard]] std::shared_ptr<WidgetVM> getWidget(const char* widgetId) const;

    /**
     * Get count of active registered widgets.
     */
    [[nodiscard]] size_t getWidgetCount() const;

private:
    WidgetRegistry() = default;
    ~WidgetRegistry() = default;

    std::unordered_map<std::string, std::shared_ptr<WidgetVM>> m_widgets;
};

} // namespace petbot::firmware::agentic
