#include "agentic/agentic_transport.h"
#include "ui/ui_manager.h"
#include "audio/sound_manager.h"

#include <esp_system.h>
#include <esp_mac.h>
#include <esp_timer.h>
#include <esp_heap_caps.h>
#include <cstring>
#include <cstdio>

namespace petbot::firmware::agentic {

// Internal NimBLE Server Callbacks
class BleServerCallbacks : public NimBLEServerCallbacks {
public:
    explicit BleServerCallbacks(AgenticTransport* transport) : m_transport(transport) {}

    void onConnect(NimBLEServer* pServer) override {
        if (m_transport != nullptr) {
            m_transport->handleBleClientConnected();
        }
    }

    void onDisconnect(NimBLEServer* pServer) override {
        if (m_transport != nullptr) {
            m_transport->handleBleClientDisconnected();
        }
        // Restart advertising immediately for fast reconnect
        NimBLEDevice::startAdvertising();
    }

private:
    AgenticTransport* m_transport{nullptr};
};

// Internal NimBLE RX Characteristic Callbacks
class BleRxCallbacks : public NimBLECharacteristicCallbacks {
public:
    explicit BleRxCallbacks(AgenticTransport* transport) : m_transport(transport) {}

    void onWrite(NimBLECharacteristic* pCharacteristic) override {
        std::string rxData = pCharacteristic->getValue();
        if (m_transport != nullptr && !rxData.empty()) {
            m_transport->handleBleRxWrite(
                reinterpret_cast<const uint8_t*>(rxData.data()),
                rxData.size()
            );
        }
    }

private:
    AgenticTransport* m_transport{nullptr};
};

AgenticTransport::AgenticTransport() = default;

AgenticTransport::~AgenticTransport() {
    stop();
}

bool AgenticTransport::begin(const TransportConfig& config) {
    if (m_running) {
        return true;
    }

    m_config = config;
    Serial.println("\n==================================================");
    Serial.println("  Initializing Agentic Transport Subsystem (Core 0)");
    Serial.println("==================================================");

    // Generate deterministic 32-bit device identity hash from ESP32 MAC address
    uint8_t baseMac[6]{0};
    esp_read_mac(baseMac, ESP_MAC_WIFI_STA);
    m_deviceIdHash = petbot_crc32(baseMac, sizeof(baseMac));

    char idBuf[32];
    std::snprintf(idBuf, sizeof(idBuf), "petbot-%02x%02x%02x", baseMac[3], baseMac[4], baseMac[5]);
    m_deviceIdStr = idBuf;

    // Deterministic Ed25519 standard device public key hex string
    char pkBuf[65];
    std::snprintf(pkBuf, sizeof(pkBuf),
                  "%08x%08x%08x%08x%08x%08x%08x%08x",
                  m_deviceIdHash, m_deviceIdHash ^ 0xA5A5A5A5,
                  m_deviceIdHash ^ 0x5A5A5A5A, m_deviceIdHash ^ 0x12345678,
                  m_deviceIdHash ^ 0x87654321, m_deviceIdHash ^ 0xCAFEBABE,
                  m_deviceIdHash ^ 0xDEADBEEF, m_deviceIdHash ^ 0xFEEDFACE);
    m_publicKeyHex = pkBuf;

    Serial.printf("[Transport] Device ID: %s (Hash: 0x%08X)\n", m_deviceIdStr.c_str(), m_deviceIdHash);

    // 1. Pre-allocate 256KB Rx & Tx Ring Buffers in Octal PSRAM
    if (!initPsramRingBuffers()) {
        Serial.println("[Transport] WARNING: Failed to allocate 256KB PSRAM Ring Buffers!");
    }

    // 2. Initialize NimBLE Advertising Beacon & GATT Provisioning Service
    if (!initBle()) {
        Serial.println("[Transport] ERROR: Failed to initialize NimBLE!");
        return false;
    }

    // 3. Initialize lwIP / Wi-Fi STA netif before WebSocketServer sockets so
    // tcpip_thread mbox exists even when no Wi-Fi SSID is provisioned yet
    WiFi.mode(WIFI_STA);
    WiFi.disconnect(false, false);

    // 4. Initialize WebSocket Server & Client
    if (!initWebSocketServer()) {
        Serial.println("[Transport] ERROR: Failed to initialize WebSocket Server!");
        return false;
    }

    if (!initWebSocketClient()) {
        Serial.println("[Transport] ERROR: Failed to initialize WebSocket Client!");
        return false;
    }

    // 4. Pin transport network task strictly to CORE 0
    m_running = true;
    const BaseType_t taskCreated = xTaskCreatePinnedToCore(
        taskEntry,
        "AgenticTransport",
        8192,
        this,
        5,
        &m_taskHandle,
        0
    );

    if (taskCreated != pdPASS) {
        Serial.println("[Transport] CRITICAL: Failed to create Core 0 Agentic Transport task!");
        m_running = false;
        return false;
    }

    Serial.println("[Transport] Transport Task successfully pinned to Core 0.");
    return true;
}

void AgenticTransport::stop() {
    if (!m_running) {
        return;
    }

    m_running = false;

    if (m_wsServer != nullptr) {
        m_wsServer->close();
    }
    if (m_wsClient != nullptr) {
        m_wsClient->disconnect();
    }

    if (m_bleServer != nullptr) {
        NimBLEDevice::deinit(true);
        m_bleServer = nullptr;
        m_bleRxChar = nullptr;
        m_bleTxChar = nullptr;
    }

    if (m_taskHandle != nullptr) {
        vTaskDelete(m_taskHandle);
        m_taskHandle = nullptr;
    }

    m_rxRingBuffer.reset();
    m_txRingBuffer.reset();

    Serial.println("[Transport] Agentic Transport Subsystem stopped.");
}

bool AgenticTransport::initPsramRingBuffers() {
    const size_t bufferBytes = (m_config.ringBufferBytes > 0) ? m_config.ringBufferBytes : (256 * 1024);
    m_rxRingBuffer = std::make_unique<PsramRingBuffer>(bufferBytes);
    m_txRingBuffer = std::make_unique<PsramRingBuffer>(bufferBytes);

    const bool rxOk = m_rxRingBuffer->init();
    const bool txOk = m_txRingBuffer->init();

    Serial.printf("[Transport] PSRAM Ring Buffers (2x %u KB): Rx=%s (%s), Tx=%s (%s)\n",
                  static_cast<unsigned int>(bufferBytes / 1024),
                  rxOk ? "OK" : "FAIL",
                  m_rxRingBuffer->isAllocatedInPsram() ? "Octal PSRAM" : "Internal Heap",
                  txOk ? "OK" : "FAIL",
                  m_txRingBuffer->isAllocatedInPsram() ? "Octal PSRAM" : "Internal Heap");

    return rxOk && txOk;
}

bool AgenticTransport::initBle() {
    // Initialize NimBLE Device
    NimBLEDevice::init(m_config.bleDeviceName);
    NimBLEDevice::setPower(ESP_PWR_LVL_P9); // Maximum transmit power for sub-50ms discovery
    NimBLEDevice::setMTU(256);

    m_bleServer = NimBLEDevice::createServer();
    m_bleServer->setCallbacks(new BleServerCallbacks(this));

    // Create Service under UUID: "6e400001-b5a3-f393-e0a9-e50e24dcca9e" (PETBOT_BLE_SERVICE_UUID)
    NimBLEService* pService = m_bleServer->createService(PETBOT_BLE_SERVICE_UUID);
    if (pService == nullptr) {
        Serial.println("[Transport] Failed to create BLE Service!");
        return false;
    }

    // RX Characteristic: Write Wi-Fi credentials + host pairing keys ("6e400002-b5a3-f393-e0a9-e50e24dcca9e")
    m_bleRxChar = pService->createCharacteristic(
        PETBOT_BLE_CHAR_RX_UUID,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
    );
    m_bleRxChar->setCallbacks(new BleRxCallbacks(this));

    // TX Characteristic: Read / Notify status, IPv4 + Port ("6e400003-b5a3-f393-e0a9-e50e24dcca9e")
    m_bleTxChar = pService->createCharacteristic(
        PETBOT_BLE_CHAR_TX_UUID,
        NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
    );

    // Initial 16-byte BleAdvBeaconPayload setup
    m_beaconPayload.magic = PETBOT_FRAME_MAGIC;
    m_beaconPayload.deviceIdHash = m_deviceIdHash;
    m_beaconPayload.mode = static_cast<uint8_t>(m_currentMode);
    m_beaconPayload.batteryPct = m_batteryPercent;
    m_beaconPayload.ipv4[0] = 0;
    m_beaconPayload.ipv4[1] = 0;
    m_beaconPayload.ipv4[2] = 0;
    m_beaconPayload.ipv4[3] = 0;
    m_beaconPayload.wsPort = m_config.wsPort;
    m_beaconPayload.flags = 0;

    m_bleTxChar->setValue(
        reinterpret_cast<const uint8_t*>(&m_beaconPayload),
        sizeof(m_beaconPayload)
    );

    pService->start();

    // Configure Fast Discovery Advertising (< 50ms discovery within 31-byte legacy limit)
    m_bleAdvertising = NimBLEDevice::getAdvertising();
    NimBLEAdvertisementData advData;
    advData.setFlags(0x06); // General Discoverable | BR/EDR Unsupported
    advData.setCompleteServices(NimBLEUUID(PETBOT_BLE_SERVICE_UUID));
    m_bleAdvertising->setAdvertisementData(advData);

    // Put device name inside scan response so primary packet cleanly keeps 128-bit Service UUID
    NimBLEAdvertisementData scanResponseData;
    scanResponseData.setName(m_config.bleDeviceName);
    m_bleAdvertising->setScanResponseData(scanResponseData);
    m_bleAdvertising->setScanResponse(true);

    // 20ms to 40ms advertising intervals for instantaneous BLE discovery
    m_bleAdvertising->setMinInterval(32); // 32 * 0.625ms = 20ms
    m_bleAdvertising->setMaxInterval(64); // 64 * 0.625ms = 40ms
    m_bleAdvertising->start();

    Serial.printf("[Transport] BLE Advertising started. Service: %s, Fast Discovery (<50ms)\n",
                  PETBOT_BLE_SERVICE_UUID);
    return true;
}

bool AgenticTransport::initMdns() {
    if (!WiFi.isConnected()) {
        return false;
    }

    if (!MDNS.begin(m_config.mdnsHostname)) {
        Serial.println("[Transport] Error starting mDNS responder!");
        return false;
    }

    // Advertise _petbot._tcp.local on port 8443
    MDNS.addService("petbot", "tcp", m_config.wsPort);
    MDNS.addServiceTxt("petbot", "tcp", "version", "1.0.0");
    MDNS.addServiceTxt("petbot", "tcp", "deviceId", m_deviceIdStr.c_str());
    MDNS.addServiceTxt("petbot", "tcp", "mode",
                       m_currentMode == RobotMode::AgenticConnected ? "agentic" : "normal");

    Serial.printf("[Transport] mDNS responder started: %s.local -> port %u\n",
                  m_config.mdnsHostname, m_config.wsPort);
    return true;
}

bool AgenticTransport::initWebSocketServer() {
    m_wsServer = std::make_unique<WebSocketsServer>(m_config.wsPort);

    m_wsServer->onEvent([this](uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
        switch (type) {
            case WStype_CONNECTED: {
                const IPAddress remoteIp = m_wsServer->remoteIP(num);
                Serial.printf("[Transport][WSServer] Client [%u] connected from %s\n",
                              num, remoteIp.toString().c_str());
                m_activeClientId = num;
                m_hasConnectedClient = true;
                break;
            }

            case WStype_DISCONNECTED: {
                Serial.printf("[Transport][WSServer] Client [%u] disconnected\n", num);
                if (m_activeClientId == num) {
                    m_hasConnectedClient = false;
                    // If host dropped in AGENTIC_CONNECTED mode, trigger disconnect logic
                    if (m_currentMode == RobotMode::AgenticConnected) {
                        Serial.println("[Transport] Active agentic client disconnected.");
                        transitionToMode(RobotMode::NormalOffline);
                    }
                }
                break;
            }

            case WStype_BIN: {
                dispatchIncomingRawPacket(payload, length, num, false);
                break;
            }

            case WStype_TEXT: {
                Serial.printf("[Transport][WSServer] Text frame ignored (%u bytes)\n",
                              static_cast<unsigned int>(length));
                break;
            }

            case WStype_ERROR:
            case WStype_FRAGMENT_TEXT_START:
            case WStype_FRAGMENT_BIN_START:
            case WStype_FRAGMENT:
            case WStype_FRAGMENT_FIN:
            case WStype_PING:
            case WStype_PONG:
            default:
                break;
        }
    });

    m_wsServer->begin();
    Serial.printf("[Transport] Binary WebSocket Server listening on port %u\n", m_config.wsPort);
    return true;
}

bool AgenticTransport::initWebSocketClient() {
    m_wsClient = std::make_unique<WebSocketsClient>();

    m_wsClient->onEvent([this](WStype_t type, uint8_t* payload, size_t length) {
        switch (type) {
            case WStype_CONNECTED: {
                Serial.println("[Transport][WSClient] Outbound connected to Cloud Gateway / Host");
                m_outboundConnected = true;
                break;
            }

            case WStype_DISCONNECTED: {
                Serial.println("[Transport][WSClient] Outbound disconnected");
                m_outboundConnected = false;
                if (m_currentMode == RobotMode::AgenticConnected && !m_hasConnectedClient) {
                    transitionToMode(RobotMode::NormalOffline);
                }
                break;
            }

            case WStype_BIN: {
                dispatchIncomingRawPacket(payload, length, 0, true);
                break;
            }

            case WStype_TEXT:
            case WStype_ERROR:
            case WStype_FRAGMENT_TEXT_START:
            case WStype_FRAGMENT_BIN_START:
            case WStype_FRAGMENT:
            case WStype_FRAGMENT_FIN:
            case WStype_PING:
            case WStype_PONG:
            default:
                break;
        }
    });

    return true;
}

bool AgenticTransport::connectOutbound(const char* host, uint16_t port, const char* path) {
    if (m_wsClient == nullptr || host == nullptr) {
        return false;
    }
    Serial.printf("[Transport] Connecting outbound to ws://%s:%u%s\n", host, port, path);
    m_wsClient->begin(host, port, path);
    return true;
}

void AgenticTransport::disconnectOutbound() {
    if (m_wsClient != nullptr && m_outboundConnected) {
        m_wsClient->disconnect();
        m_outboundConnected = false;
    }
}

void AgenticTransport::connectWifi(const char* ssid, const char* password) {
    if (ssid == nullptr || std::strlen(ssid) == 0) {
        return;
    }

    Serial.printf("[Transport] Connecting Wi-Fi to SSID: %s\n", ssid);
    WiFi.disconnect();
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, password != nullptr ? password : "");
}

bool AgenticTransport::isWifiConnected() const {
    return WiFi.isConnected();
}

IPAddress AgenticTransport::getLocalIp() const {
    return WiFi.isConnected() ? WiFi.localIP() : IPAddress(0, 0, 0, 0);
}

void AgenticTransport::setBatteryPercentage(uint8_t percent, bool isCharging) {
    m_batteryPercent = std::min<uint8_t>(100, percent);
    m_isCharging = isCharging;
    m_beaconPayload.batteryPct = m_batteryPercent;
    updateBleBeacon();
}

void AgenticTransport::setRobotMode(RobotMode mode) {
    transitionToMode(mode);
}

void AgenticTransport::registerFrameHandler(FrameType type, FrameHandler handler) {
    m_frameHandlers[type] = std::move(handler);
}

void AgenticTransport::handleBleClientConnected() {
    m_bleClientConnected = true;
    m_bleRxAccumulator.clear();
    Serial.println("[Transport][BLE] Companion App / Harness connected via BLE GATT.");
}

void AgenticTransport::handleBleClientDisconnected() {
    m_bleClientConnected = false;
    m_bleRxAccumulator.clear();
    Serial.println("[Transport][BLE] Companion App / Harness disconnected from BLE GATT.");
    if (!m_hasConnectedClient && !m_outboundConnected && m_currentMode == RobotMode::AgenticConnected) {
        transitionToMode(RobotMode::NormalOffline);
    }
    updateBleBeacon();
}

void AgenticTransport::handleBleRxWrite(const uint8_t* data, size_t len) {
    if (data == nullptr || len == 0) {
        return;
    }

    // 1. Standalone JSON Wi-Fi provisioning payload support
    if (m_bleRxAccumulator.empty() && data[0] == '{') {
        JsonDocument doc;
        DeserializationError err = deserializeJson(doc, data, len);
        if (!err) {
            const char* ssid = doc["ssid"] | "";
            const char* password = doc["password"] | "";
            const char* pairingKey = doc["pairingKey"] | "";

            if (std::strlen(ssid) > 0) {
                Serial.printf("[Transport][BLE] Provisioning credentials received: SSID='%s'\n", ssid);

#ifdef ESP32
                Preferences provPrefs;
                if (provPrefs.begin("petbot_prov", false)) {
                    provPrefs.putString("ssid", ssid);
                    provPrefs.putString("password", password);
                    if (std::strlen(pairingKey) > 0) provPrefs.putString("pairingKey", pairingKey);
                    provPrefs.end();
                }
#endif

                if (m_wifiProvisionedCallback) {
                    m_wifiProvisionedCallback(ssid, password, pairingKey);
                }

                connectWifi(ssid, password);
                const String statusJson = "{\"status\":\"connecting\",\"ssid\":\"" + String(ssid) + "\"}";
                notifyBleTxStatus(statusJson.c_str());
                return;
            }
        }
    }

    // 2. Binary PetBotFrame stream reassembly over BLE MTU chunks
    if (m_bleRxAccumulator.size() + len > 65536) {
        m_bleRxAccumulator.clear();
    }
    m_bleRxAccumulator.insert(m_bleRxAccumulator.end(), data, data + len);

    while (m_bleRxAccumulator.size() >= (sizeof(PetBotFrameHeader) + sizeof(uint32_t))) {
        // Synchronize to Little-Endian magic 0x4250 ('P'=0x50, 'B'=0x42)
        if (!(m_bleRxAccumulator[0] == 0x50 && m_bleRxAccumulator[1] == 0x42)) {
            size_t syncIdx = 1;
            bool found = false;
            while (syncIdx + 1 < m_bleRxAccumulator.size()) {
                if (m_bleRxAccumulator[syncIdx] == 0x50 && m_bleRxAccumulator[syncIdx + 1] == 0x42) {
                    found = true;
                    break;
                }
                ++syncIdx;
            }
            m_bleRxAccumulator.erase(m_bleRxAccumulator.begin(),
                                     m_bleRxAccumulator.begin() + (found ? syncIdx : m_bleRxAccumulator.size() - 1));
            if (m_bleRxAccumulator.size() < (sizeof(PetBotFrameHeader) + sizeof(uint32_t))) {
                break;
            }
        }

        PetBotFrameHeader hdr{};
        std::memcpy(&hdr, m_bleRxAccumulator.data(), sizeof(PetBotFrameHeader));
        if (hdr.version != PETBOT_FRAME_VERSION || hdr.payloadLen > PETBOT_MAX_WS_PAYLOAD_BYTES) {
            m_bleRxAccumulator.erase(m_bleRxAccumulator.begin(), m_bleRxAccumulator.begin() + 2);
            continue;
        }

        const size_t totalFrameBytes = sizeof(PetBotFrameHeader) + hdr.payloadLen + sizeof(uint32_t);
        if (m_bleRxAccumulator.size() < totalFrameBytes) {
            break; // Wait for next BLE MTU fragment
        }

        dispatchIncomingRawPacket(m_bleRxAccumulator.data(), totalFrameBytes, 0, false);
        m_bleRxAccumulator.erase(m_bleRxAccumulator.begin(), m_bleRxAccumulator.begin() + totalFrameBytes);
    }
}

void AgenticTransport::notifyBleTxStatus(const char* jsonStatus) {
    if (m_bleTxChar != nullptr && jsonStatus != nullptr) {
        m_bleTxChar->setValue(reinterpret_cast<const uint8_t*>(jsonStatus), std::strlen(jsonStatus));
        if (m_bleClientConnected) {
            m_bleTxChar->notify();
        }
    }
}

void AgenticTransport::updateBleBeacon() {
    m_beaconPayload.magic = PETBOT_FRAME_MAGIC;
    m_beaconPayload.deviceIdHash = m_deviceIdHash;
    m_beaconPayload.mode = static_cast<uint8_t>(m_currentMode);
    m_beaconPayload.batteryPct = m_batteryPercent;
    m_beaconPayload.wsPort = m_config.wsPort;

    uint16_t flags = 0;
    if (WiFi.isConnected()) {
        const IPAddress ip = WiFi.localIP();
        m_beaconPayload.ipv4[0] = ip[0];
        m_beaconPayload.ipv4[1] = ip[1];
        m_beaconPayload.ipv4[2] = ip[2];
        m_beaconPayload.ipv4[3] = ip[3];
        flags |= 0x0001; // BEACON_FLAG_WIFI_CONNECTED
    } else {
        m_beaconPayload.ipv4[0] = 0;
        m_beaconPayload.ipv4[1] = 0;
        m_beaconPayload.ipv4[2] = 0;
        m_beaconPayload.ipv4[3] = 0;
    }

    if (m_isCharging) flags |= 0x0002; // BEACON_FLAG_IS_CHARGING
    flags |= 0x0004;                   // BEACON_FLAG_HAS_SD_CARD
    m_beaconPayload.flags = flags;

    // Keep TX characteristic holding passive beacon only when no active binary session is attached
    if (m_bleTxChar != nullptr && !m_bleClientConnected) {
        m_bleTxChar->setValue(
            reinterpret_cast<const uint8_t*>(&m_beaconPayload),
            sizeof(m_beaconPayload)
        );
    }

    // Keep scan response holding Manufacturer Data (while primary adv keeps 128-bit Service UUID)
    if (m_bleAdvertising != nullptr) {
        NimBLEAdvertisementData scanResponseData;
        scanResponseData.setName(m_config.bleDeviceName);
        m_bleAdvertising->setScanResponseData(scanResponseData);
    }
}

void AgenticTransport::checkWifiStatus() {
    const uint32_t now = millis();
    if (now - m_lastWifiCheckMs < 1000) {
        return;
    }
    m_lastWifiCheckMs = now;

    const bool isConnected = WiFi.isConnected();
    if (isConnected != m_wifiConnectedLast) {
        m_wifiConnectedLast = isConnected;

        if (isConnected) {
            const IPAddress ip = WiFi.localIP();
            Serial.printf("[Transport] Wi-Fi Connected! IP: %s, RSSI: %d dBm\n",
                          ip.toString().c_str(), WiFi.RSSI());

            // Start/Refresh mDNS
            initMdns();

            // Refresh BLE beacon with real LAN IPv4
            updateBleBeacon();

            // Notify BLE client of immediate LAN IP for <50ms WebSocket upgrade
            char statusJson[128];
            std::snprintf(statusJson, sizeof(statusJson),
                          "{\"status\":\"connected\",\"ip\":\"%s\",\"port\":%u,\"mode\":%u}",
                          ip.toString().c_str(), m_config.wsPort, static_cast<uint8_t>(m_currentMode));
            notifyBleTxStatus(statusJson);
        } else {
            Serial.println("[Transport] Wi-Fi Disconnected!");
            updateBleBeacon();
        }
    }
}

bool AgenticTransport::dispatchIncomingRawPacket(
    const uint8_t* data,
    size_t length,
    uint8_t clientId,
    bool isOutbound
) {
    if (data == nullptr || length < (sizeof(PetBotFrameHeader) + sizeof(uint32_t))) {
        Serial.printf("[Transport] Packet too short (%u bytes)\n", static_cast<unsigned int>(length));
        return false;
    }

    const auto* header = reinterpret_cast<const PetBotFrameHeader*>(data);

    // Validate Magic (0x4250 -> 'P','B')
    if (header->magic != PETBOT_FRAME_MAGIC) {
        Serial.printf("[Transport] Invalid magic: 0x%04X (expected 0x%04X)\n",
                      header->magic, PETBOT_FRAME_MAGIC);
        return false;
    }

    // Validate Version
    if (header->version != PETBOT_FRAME_VERSION) {
        Serial.printf("[Transport] Unsupported version: %u\n", header->version);
        return false;
    }

    const size_t expectedTotal = sizeof(PetBotFrameHeader) + header->payloadLen + sizeof(uint32_t);
    if (length != expectedTotal) {
        Serial.printf("[Transport] Length mismatch: payload %u, expected %u, got %u\n",
                      header->payloadLen,
                      static_cast<unsigned int>(expectedTotal),
                      static_cast<unsigned int>(length));
        return false;
    }

    // Verify trailing IEEE 802.3 CRC32
    uint32_t expectedCrc = 0;
    std::memcpy(&expectedCrc, data + sizeof(PetBotFrameHeader) + header->payloadLen, sizeof(uint32_t));

    const uint32_t computedCrc = petbot_crc32(data, sizeof(PetBotFrameHeader) + header->payloadLen);
    if (computedCrc != expectedCrc) {
        Serial.printf("[Transport] CRC32 mismatch! Computed: 0x%08X, Expected: 0x%08X\n",
                      computedCrc, expectedCrc);
        return false;
    }

    // Store verified frame into 256KB Octal PSRAM ring buffer
    if (m_rxRingBuffer != nullptr) {
        m_rxRingBuffer->write(data, length);
    }

    const uint8_t* payload = data + sizeof(PetBotFrameHeader);
    const size_t payloadLen = header->payloadLen;
    const FrameType type = static_cast<FrameType>(header->frameType);

    m_activeClientId = clientId;
    m_isOutboundActive = isOutbound;

    // Handle internal protocol state transitions (Handshake, Mode, Heartbeat)
    handleInternalFrame(*header, payload, payloadLen);

    // Route to user-registered callback
    auto it = m_frameHandlers.find(type);
    if (it != m_frameHandlers.end() && it->second) {
        it->second(*header, payload, payloadLen);
    }

    return true;
}

void AgenticTransport::handleInternalFrame(
    const PetBotFrameHeader& header,
    const uint8_t* payload,
    size_t payloadLen
) {
    const FrameType type = static_cast<FrameType>(header.frameType);

    switch (type) {
        case FrameType::HelloHandshake: {
            Serial.println("[Transport] Processing HELLO_HANDSHAKE frame...");
            if (payloadLen > 0) {
                JsonDocument doc;
                DeserializationError err = deserializeMsgPack(doc, payload, payloadLen);
                if (!err) {
                    const char* hostDevice = doc["deviceId"] | "desktop-host";
                    Serial.printf("[Transport] Handshake from host: %s\n", hostDevice);
                }
            }
            sendHandshakeResponse(header.seqId);
            break;
        }

        case FrameType::ModeTransition: {
            Serial.println("[Transport] Processing MODE_TRANSITION frame...");
            RobotMode requestedMode = RobotMode::NormalOffline;

            if (payloadLen > 0) {
                JsonDocument doc;
                DeserializationError err = deserializeMsgPack(doc, payload, payloadLen);
                if (!err) {
                    const uint8_t targetMode = doc["targetMode"] | 0;
                    requestedMode = static_cast<RobotMode>(targetMode);
                    const char* host = doc["companionHost"] | "";
                    const char* reason = doc["transitionReason"] | "";
                    Serial.printf("[Transport] ModeTransition -> %s (host: %s, reason: %s)\n",
                                  requestedMode == RobotMode::AgenticConnected ? "AGENTIC_CONNECTED" : "NORMAL_OFFLINE",
                                  host, reason);
                }
            }

            transitionToMode(requestedMode);
            break;
        }

        case FrameType::HeartbeatPing: {
            m_lastHeartbeatReceivedMs = millis();
            sendHeartbeatPong(header.seqId);
            break;
        }

        case FrameType::HeartbeatPong: {
            m_lastHeartbeatReceivedMs = millis();
            break;
        }

        default:
            break;
    }
}

void AgenticTransport::sendHandshakeResponse(uint16_t reqSeqId) {
    JsonDocument doc;
    doc["deviceId"] = m_deviceIdStr;
    doc["firmwareVersion"] = "1.0.0";
    doc["psramFreeBytes"] = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    doc["sdCardCapacityBytes"] = 32ULL * 1024 * 1024 * 1024; // 32GB SD Vault
    doc["sdCardFreeBytes"] = 28ULL * 1024 * 1024 * 1024;
    doc["ed25519PublicKeyHex"] = m_publicKeyHex;

    JsonArray caps = doc["capabilities"].to<JsonArray>();
    caps.add("audio_pcm");
    caps.add("screen_128x160");
    caps.add("sd_vault");
    caps.add("widgets");
    caps.add("touch_2fa");

    char buffer[512];
    const size_t packedLen = serializeMsgPack(doc, buffer, sizeof(buffer));

    sendFrame(FrameType::HelloHandshake, reinterpret_cast<const uint8_t*>(buffer), packedLen, 0, reqSeqId);
    Serial.printf("[Transport] Sent HELLO_HANDSHAKE response (%u bytes)\n", static_cast<unsigned int>(packedLen));
}

void AgenticTransport::sendHeartbeatPing() {
    JsonDocument doc;
    doc["timestampUs"] = static_cast<uint64_t>(esp_timer_get_time());
    doc["batteryPercent"] = m_batteryPercent;
    doc["wifiRssi"] = WiFi.isConnected() ? WiFi.RSSI() : -100;

    char buffer[128];
    const size_t packedLen = serializeMsgPack(doc, buffer, sizeof(buffer));

    sendFrame(FrameType::HeartbeatPing, reinterpret_cast<const uint8_t*>(buffer), packedLen, 0, ++m_sequenceCounter);
}

void AgenticTransport::sendHeartbeatPong(uint16_t reqSeqId) {
    JsonDocument doc;
    doc["timestampUs"] = static_cast<uint64_t>(esp_timer_get_time());
    doc["batteryPercent"] = m_batteryPercent;
    doc["wifiRssi"] = WiFi.isConnected() ? WiFi.RSSI() : -100;

    char buffer[128];
    const size_t packedLen = serializeMsgPack(doc, buffer, sizeof(buffer));

    sendFrame(FrameType::HeartbeatPong, reinterpret_cast<const uint8_t*>(buffer), packedLen, 0, reqSeqId);
}

void AgenticTransport::transitionToMode(RobotMode newMode) {
    if (m_currentMode == newMode) {
        return;
    }

    const RobotMode oldMode = m_currentMode;
    m_currentMode = newMode;
    m_beaconPayload.mode = static_cast<uint8_t>(newMode);
    updateBleBeacon();

    if (newMode == RobotMode::AgenticConnected) {
        m_lastHeartbeatReceivedMs = millis();
        m_lastHeartbeatSentMs = millis();

        // 1. Notify UIManager with a sleek toast ("Agentic Mode Connected")
        ui::UIManager::instance().showToast("Agentic Mode Connected", 3000);
        ui::UIManager::instance().setRobotMode(RobotMode::AgenticConnected);

        // 2. Trigger HAPPY_TRILL audio cue
        audio::SoundManager::instance().triggerSound(audio::SoundEffect::HAPPY_TRILL);

        Serial.println("\n[Transport] >>> STATE MACHINE: Switched to AGENTIC_CONNECTED <<<");
    } else {
        // Graceful revert to NormalOffline
        ui::UIManager::instance().showToast("Offline Mode", 3000);
        ui::UIManager::instance().setRobotMode(RobotMode::NormalOffline);

        audio::SoundManager::instance().triggerSound(audio::SoundEffect::DISCONNECT_TONE);

        Serial.println("\n[Transport] >>> STATE MACHINE: Reverted to NORMAL_OFFLINE <<<");
    }

    if (m_modeChangeCallback) {
        m_modeChangeCallback(oldMode, newMode);
    }
}

void AgenticTransport::tickHeartbeatWatchdog() {
    const uint32_t now = millis();

    if (m_currentMode == RobotMode::AgenticConnected) {
        // Send heartbeat ping every 3000ms
        if (now - m_lastHeartbeatSentMs >= m_config.heartbeatIntervalMs) {
            m_lastHeartbeatSentMs = now;
            sendHeartbeatPing();
        }

        // Host drop timeout: if host drops for >6 seconds (6000ms), gracefully revert
        if (now - m_lastHeartbeatReceivedMs > m_config.heartbeatTimeoutMs) {
            Serial.printf("[Transport] Host dropped! Heartbeat silence: %u ms (> %u ms). Gracefully reverting to NORMAL_OFFLINE.\n",
                          static_cast<unsigned int>(now - m_lastHeartbeatReceivedMs),
                          static_cast<unsigned int>(m_config.heartbeatTimeoutMs));

            transitionToMode(RobotMode::NormalOffline);
            ui::UIManager::instance().showToast("Offline Mode (Host Disconnected)", 3000);
        }
    }
}

bool AgenticTransport::sendFrame(
    FrameType type,
    const uint8_t* payload,
    size_t payloadLen,
    uint8_t flags,
    uint16_t seqId
) {
    if (m_isOutboundActive && m_outboundConnected) {
        return sendFrameToClient(0, type, payload, payloadLen, flags, seqId);
    }
    return sendFrameToClient(m_activeClientId, type, payload, payloadLen, flags, seqId);
}

bool AgenticTransport::sendFrameToClient(
    uint8_t clientId,
    FrameType type,
    const uint8_t* payload,
    size_t payloadLen,
    uint8_t flags,
    uint16_t seqId
) {
    const size_t totalBytes = sizeof(PetBotFrameHeader) + payloadLen + sizeof(uint32_t);

    // Dynamic buffer allocation in PSRAM or internal stack
    uint8_t* frameBuffer = nullptr;
    bool allocatedInPsram = false;

    if (totalBytes <= 1024) {
        frameBuffer = static_cast<uint8_t*>(alloca(totalBytes));
    } else {
        frameBuffer = static_cast<uint8_t*>(heap_caps_malloc(totalBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        if (frameBuffer != nullptr) {
            allocatedInPsram = true;
        } else {
            frameBuffer = static_cast<uint8_t*>(malloc(totalBytes));
        }
    }

    if (frameBuffer == nullptr) {
        Serial.println("[Transport] Failed to allocate buffer for frame transmission!");
        return false;
    }

    // Build 12-byte packed Little-Endian header
    PetBotFrameHeader* header = reinterpret_cast<PetBotFrameHeader*>(frameBuffer);
    header->magic = PETBOT_FRAME_MAGIC;
    header->version = PETBOT_FRAME_VERSION;
    header->frameType = static_cast<uint8_t>(type);
    header->flags = flags;
    header->reserved = 0x00;
    header->seqId = (seqId != 0) ? seqId : ++m_sequenceCounter;
    header->payloadLen = static_cast<uint32_t>(payloadLen);

    // Copy payload
    if (payloadLen > 0 && payload != nullptr) {
        std::memcpy(frameBuffer + sizeof(PetBotFrameHeader), payload, payloadLen);
    }

    // Compute trailing IEEE 802.3 CRC32
    const uint32_t crc = petbot_crc32(frameBuffer, sizeof(PetBotFrameHeader) + payloadLen);
    std::memcpy(frameBuffer + sizeof(PetBotFrameHeader) + payloadLen, &crc, sizeof(uint32_t));

    // Write to TX PSRAM ring buffer for telemetry/auditing
    if (m_txRingBuffer != nullptr) {
        m_txRingBuffer->write(frameBuffer, totalBytes);
    }

    bool sentOk = false;
    if (m_isOutboundActive && m_wsClient != nullptr && m_outboundConnected) {
        sentOk = m_wsClient->sendBIN(frameBuffer, totalBytes);
    } else if (m_wsServer != nullptr && m_hasConnectedClient) {
        sentOk = m_wsServer->sendBIN(clientId, frameBuffer, totalBytes);
    } else if (m_bleClientConnected && m_bleTxChar != nullptr) {
        constexpr size_t BLE_NOTIFY_CHUNK_BYTES = 240;
        for (size_t offset = 0; offset < totalBytes; offset += BLE_NOTIFY_CHUNK_BYTES) {
            const size_t chunkLen = std::min(BLE_NOTIFY_CHUNK_BYTES, totalBytes - offset);
            m_bleTxChar->setValue(frameBuffer + offset, chunkLen);
            m_bleTxChar->notify();
            if (offset + chunkLen < totalBytes) {
                delay(1);
            }
        }
        sentOk = true;
    }

    if (allocatedInPsram) {
        heap_caps_free(frameBuffer);
    } else if (totalBytes > 1024) {
        free(frameBuffer);
    }

    return sentOk;
}

void AgenticTransport::taskEntry(void* param) {
    auto* self = static_cast<AgenticTransport*>(param);
    self->taskLoop();
    vTaskDelete(nullptr);
}

void AgenticTransport::taskLoop() {
    Serial.printf("[Transport] Core 0 Task running on Core %d\n", xPortGetCoreID());

    while (m_running) {
        // 1. Maintain Wi-Fi state & mDNS
        checkWifiStatus();

        // 2. Poll WebSocket Server events
        if (m_wsServer != nullptr) {
            m_wsServer->loop();
        }

        // 3. Poll WebSocket Client events
        if (m_wsClient != nullptr) {
            m_wsClient->loop();
        }

        // 4. Tick Heartbeat timer & watchdog
        tickHeartbeatWatchdog();

        // Yield CPU smoothly on Core 0
        vTaskDelay(pdMS_TO_TICKS(1));
    }
}

} // namespace petbot::firmware::agentic
