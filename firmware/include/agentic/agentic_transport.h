#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include <functional>
#include <unordered_map>
#include <memory>
#include <vector>

#include <WiFi.h>
#include <ESPmDNS.h>
#include <NimBLEDevice.h>
#include <WebSocketsServer.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

#include "petbot_protocol.h"
#include "agentic/psram_ring_buffer.h"

namespace petbot::firmware::agentic {

using petbot::protocol::PetBotFrameHeader;
using petbot::protocol::BleAdvBeaconPayload;
using petbot::protocol::FrameType;
using petbot::protocol::RobotMode;
using petbot::protocol::petbot_crc32;

/**
 * Transport Configuration Options
 */
struct TransportConfig {
    uint16_t wsPort{PETBOT_DEFAULT_WS_PORT};
    const char* mdnsHostname{"petbot"};
    const char* bleDeviceName{"PetBot-Agent"};
    const char* bleServiceUuid{PETBOT_BLE_SERVICE_UUID};
    const char* bleCharRxUuid{PETBOT_BLE_CHAR_RX_UUID};
    const char* bleCharTxUuid{PETBOT_BLE_CHAR_TX_UUID};
    size_t ringBufferBytes{256 * 1024}; // 256KB Octal PSRAM ring buffer
    uint32_t heartbeatIntervalMs{3000}; // Send heartbeat every 3000ms
    uint32_t heartbeatTimeoutMs{6000};  // Host drop timeout: 6 seconds
    uint8_t initialBatteryPct{100};
    bool autoReconnectWifi{true};
};

/**
 * Registered Frame Callback Handler
 */
using FrameHandler = std::function<void(const PetBotFrameHeader& header, const uint8_t* payload, size_t payloadLen)>;

/**
 * Robot Mode Change Observer
 */
using ModeChangeCallback = std::function<void(RobotMode oldMode, RobotMode newMode)>;

/**
 * Wi-Fi Provisioned Callback (received from BLE GATT write)
 */
using WifiProvisionedCallback = std::function<void(const char* ssid, const char* password, const char* pairingKey)>;

/**
 * Agentic Transport Subsystem
 *
 * Coordinates:
 * 1. NimBLE Advertising Beacon & GATT Provisioning (sub-50ms fast discovery)
 * 2. mDNS Service Announcement (_petbot._tcp.local @ port 8443)
 * 3. Dual-Role Binary WebSocket Transport (Server + Outbound Client)
 * 4. 256KB Octal PSRAM Zero-Copy Ring-Buffer Frame Dispatcher
 * 5. Automatic Mode Switching State Machine (NORMAL_OFFLINE <-> AGENTIC_CONNECTED)
 *
 * PINNED STRICTLY TO CORE 0 to ensure Core 1's 60FPS UI loop never stutters.
 */
class AgenticTransport {
public:
    static AgenticTransport& instance() {
        static AgenticTransport s_instance;
        return s_instance;
    }

    AgenticTransport(const AgenticTransport&) = delete;
    AgenticTransport& operator=(const AgenticTransport&) = delete;

    /**
     * Initialize all networking, BLE, mDNS, WebSockets, and launch Core 0 task.
     */
    bool begin(const TransportConfig& config = {});

    /**
     * Stop transport services and terminate Core 0 task.
     */
    void stop();

    [[nodiscard]] bool isRunning() const noexcept {
        return m_running;
    }

    /**
     * Current operating mode of the robot.
     */
    [[nodiscard]] RobotMode getRobotMode() const noexcept {
        return m_currentMode;
    }

    /**
     * Explicitly set robot mode (triggers state machine transitions).
     */
    void setRobotMode(RobotMode mode);

    /**
     * Update live battery telemetry and refresh BLE beacon.
     */
    void setBatteryPercentage(uint8_t percent, bool isCharging = false);

    /**
     * Register application-level frame handlers for custom FrameType routing.
     */
    void registerFrameHandler(FrameType type, FrameHandler handler);

    /**
     * Register callbacks for mode transitions and BLE Wi-Fi provisioning.
     */
    void setModeChangeCallback(ModeChangeCallback callback) {
        m_modeChangeCallback = std::move(callback);
    }

    void setWifiProvisionedCallback(WifiProvisionedCallback callback) {
        m_wifiProvisionedCallback = std::move(callback);
    }

    /**
     * Send binary frame to the connected host or cloud gateway.
     */
    bool sendFrame(FrameType type, const uint8_t* payload, size_t payloadLen, uint8_t flags = 0, uint16_t seqId = 0);

    /**
     * Send binary frame to a specific WebSocket client ID (Server mode).
     */
    bool sendFrameToClient(uint8_t clientId, FrameType type, const uint8_t* payload, size_t payloadLen, uint8_t flags = 0, uint16_t seqId = 0);

    /**
     * Connect outbound to Cloud Voice Gateway or discovered Desktop Harness.
     */
    bool connectOutbound(const char* host, uint16_t port, const char* path = "/ws");
    void disconnectOutbound();

    [[nodiscard]] bool isOutboundConnected() const noexcept {
        return m_outboundConnected;
    }

    [[nodiscard]] bool isClientConnected() const noexcept {
        return m_hasConnectedClient;
    }

    [[nodiscard]] bool hasActiveLink() const noexcept {
        return m_bleClientConnected || m_hasConnectedClient || m_outboundConnected;
    }

    /**
     * Connect to Wi-Fi network.
     */
    void connectWifi(const char* ssid, const char* password);
    [[nodiscard]] bool isWifiConnected() const;
    [[nodiscard]] IPAddress getLocalIp() const;

    /**
     * Direct access to PSRAM Ring Buffer for performance auditing.
     */
    [[nodiscard]] PsramRingBuffer* getRxRingBuffer() const noexcept {
        return m_rxRingBuffer.get();
    }

    [[nodiscard]] PsramRingBuffer* getTxRingBuffer() const noexcept {
        return m_txRingBuffer.get();
    }

    /**
     * BLE GATT Internal Callbacks (invoked by NimBLE)
     */
    void handleBleRxWrite(const uint8_t* data, size_t len);
    void handleBleClientConnected();
    void handleBleClientDisconnected();

private:
    AgenticTransport();
    ~AgenticTransport();

    // Core 0 FreeRTOS Worker Task
    static void taskEntry(void* param);
    void taskLoop();

    // Internal Subsystem Initializers
    bool initPsramRingBuffers();
    bool initBle();
    bool initMdns();
    bool initWebSocketServer();
    bool initWebSocketClient();

    // BLE Beacon & GATT helpers
    void updateBleBeacon();
    void notifyBleTxStatus(const char* jsonStatus);

    // Frame Parsing & Dispatching
    bool dispatchIncomingRawPacket(const uint8_t* data, size_t length, uint8_t clientId, bool isOutbound);
    void handleInternalFrame(const PetBotFrameHeader& header, const uint8_t* payload, size_t payloadLen);

    // State Machine & Protocol Handlers
    void sendHandshakeResponse(uint16_t reqSeqId);
    void sendHeartbeatPing();
    void sendHeartbeatPong(uint16_t reqSeqId);
    void transitionToMode(RobotMode newMode);
    void tickHeartbeatWatchdog();

    // Wi-Fi Status Maintenance
    void checkWifiStatus();

    TransportConfig m_config{};
    bool m_running{false};
    TaskHandle_t m_taskHandle{nullptr};

    // State Machine
    RobotMode m_currentMode{RobotMode::NormalOffline};
    uint32_t m_lastHeartbeatReceivedMs{0};
    uint32_t m_lastHeartbeatSentMs{0};
    uint16_t m_sequenceCounter{0};
    uint8_t m_batteryPercent{100};
    bool m_isCharging{false};
    uint32_t m_deviceIdHash{0};
    std::string m_deviceIdStr{};
    std::string m_publicKeyHex{};

    // BLE GATT & Advertising
    NimBLEServer* m_bleServer{nullptr};
    NimBLECharacteristic* m_bleRxChar{nullptr};
    NimBLECharacteristic* m_bleTxChar{nullptr};
    NimBLEAdvertising* m_bleAdvertising{nullptr};
    BleAdvBeaconPayload m_beaconPayload{};
    bool m_bleClientConnected{false};
    std::vector<uint8_t> m_bleRxAccumulator{};

    // WebSockets Server & Client
    std::unique_ptr<WebSocketsServer> m_wsServer{nullptr};
    std::unique_ptr<WebSocketsClient> m_wsClient{nullptr};
    uint8_t m_activeClientId{0};
    bool m_hasConnectedClient{false};
    bool m_outboundConnected{false};
    bool m_isOutboundActive{false};

    // PSRAM Ring Buffers
    std::unique_ptr<PsramRingBuffer> m_rxRingBuffer{nullptr};
    std::unique_ptr<PsramRingBuffer> m_txRingBuffer{nullptr};

    // Frame Handler Registry & Callbacks
    std::unordered_map<FrameType, FrameHandler> m_frameHandlers{};
    ModeChangeCallback m_modeChangeCallback{nullptr};
    WifiProvisionedCallback m_wifiProvisionedCallback{nullptr};

    // Wi-Fi Connection State
    bool m_wifiConnectedLast{false};
    uint32_t m_lastWifiCheckMs{0};
};

} // namespace petbot::firmware::agentic
