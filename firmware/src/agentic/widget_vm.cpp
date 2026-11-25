#include "agentic/widget_vm.h"
#include "agentic/agentic_transport.h"
#include "ui/ui_manager.h"
#include "ui/expression_engine.h"
#include "hal/storage_hal.h"
#include "hal/audio_hal.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <algorithm>
#include <cmath>
#include <cstring>

#ifdef ESP32
#include <esp_heap_caps.h>
#endif

namespace petbot::firmware::agentic {

// ============================================================================
// PsramWidgetArena Implementation
// ============================================================================
PsramWidgetArena::PsramWidgetArena() noexcept = default;

PsramWidgetArena::~PsramWidgetArena() noexcept {
    release();
}

bool PsramWidgetArena::allocate() noexcept {
    if (m_buffer != nullptr) {
        reset();
        return true;
    }

#if defined(ESP32) && defined(BOARD_HAS_PSRAM)
    m_buffer = static_cast<uint8_t*>(heap_caps_malloc(ARENA_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (m_buffer != nullptr) {
        m_isPsram = true;
    } else {
        m_buffer = static_cast<uint8_t*>(malloc(ARENA_SIZE));
        m_isPsram = false;
    }
#else
    m_buffer = static_cast<uint8_t*>(malloc(ARENA_SIZE));
    m_isPsram = false;
#endif

    m_offset = 0;
    return m_buffer != nullptr;
}

void PsramWidgetArena::reset() noexcept {
    m_offset = 0;
}

void PsramWidgetArena::release() noexcept {
    if (m_buffer != nullptr) {
        free(m_buffer);
        m_buffer = nullptr;
    }
    m_offset = 0;
    m_isPsram = false;
}

void* PsramWidgetArena::alloc(size_t bytes, size_t align) noexcept {
    if (m_buffer == nullptr) {
        if (!allocate()) return nullptr;
    }

    const size_t currentAddr = reinterpret_cast<size_t>(m_buffer + m_offset);
    const size_t alignedAddr = (currentAddr + align - 1) & ~(align - 1);
    const size_t padding = alignedAddr - currentAddr;

    if (m_offset + padding + bytes > ARENA_SIZE) {
        Serial.printf("[PsramWidgetArena] Arena overflow! Requested: %u, Used: %u, Cap: %u\n",
                      static_cast<unsigned>(bytes), static_cast<unsigned>(m_offset), static_cast<unsigned>(ARENA_SIZE));
        return nullptr;
    }

    m_offset += padding;
    void* result = m_buffer + m_offset;
    m_offset += bytes;
    std::memset(result, 0, bytes);
    return result;
}

char* PsramWidgetArena::strdup(const char* str) noexcept {
    if (str == nullptr) return nullptr;
    const size_t len = std::strlen(str) + 1;
    char* copy = static_cast<char*>(alloc(len, 1));
    if (copy != nullptr) {
        std::memcpy(copy, str, len);
    }
    return copy;
}

// ============================================================================
// WidgetVM Implementation
// ============================================================================
WidgetVM::WidgetVM() = default;

WidgetVM::~WidgetVM() {
    if (m_loaded) {
        persistDirtySlotsToStorage();
    }
    m_arena.release();
}

uint16_t WidgetVM::computeCrc16(const uint8_t* buf, size_t len) noexcept {
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; ++i) {
        crc ^= static_cast<uint16_t>(buf[i]) << 8;
        for (uint8_t bit = 0; bit < 8; ++bit) {
            if (crc & 0x8000) {
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
        }
    }
    return crc & 0xFFFF;
}

bool WidgetVM::loadBytecode(const uint8_t* data, size_t len) {
    if (data == nullptr || len < petbot::widget::bytecode::BYTECODE_HEADER_SIZE) {
        Serial.println("[WidgetVM] Invalid bytecode: buffer too small");
        return false;
    }

    // 1. Validate 8-byte PBWG Header
    const auto* header = reinterpret_cast<const WidgetBytecodeHeader*>(data);
    if (!header->is_valid()) {
        Serial.printf("[WidgetVM] Invalid PBWG Header: magic=0x%02X%02X%02X%02X ver=%u\n",
                      data[0], data[1], data[2], data[3], header->version);
        return false;
    }

    // 2. Validate CRC16-CCITT Checksum over MessagePack payload
    const size_t payloadLen = len - petbot::widget::bytecode::BYTECODE_HEADER_SIZE;
    const uint8_t* payloadData = data + petbot::widget::bytecode::BYTECODE_HEADER_SIZE;
    const uint16_t calculatedCrc = computeCrc16(payloadData, payloadLen);

    if (calculatedCrc != header->crc16) {
        Serial.printf("[WidgetVM] CRC16 mismatch: expected=0x%04X, calculated=0x%04X\n",
                      header->crc16, calculatedCrc);
        return false;
    }

    // 3. Allocate PSRAM Arena
    if (!m_arena.allocate()) {
        Serial.println("[WidgetVM] Failed to allocate 128KB PSRAM Arena");
        return false;
    }
    m_arena.reset();

    // 4. Unpack MessagePack Payload via ArduinoJson
    JsonDocument doc;
    const DeserializationError err = deserializeMsgPack(doc, payloadData, payloadLen);
    if (err) {
        Serial.printf("[WidgetVM] MsgPack unpack error: %s\n", err.c_str());
        return false;
    }

    // 5. Unpack Manifest Metadata ("m")
    JsonObject mObj = doc["m"].as<JsonObject>();
    if (!mObj.isNull()) {
        strncpy(m_manifest.id, mObj["id"] | "com.petbot.custom", sizeof(m_manifest.id) - 1);
        strncpy(m_manifest.name, mObj["name"] | "Custom App", sizeof(m_manifest.name) - 1);
        strncpy(m_manifest.version, mObj["ver"] | "1.0.0", sizeof(m_manifest.version) - 1);
        strncpy(m_manifest.author, mObj["auth"] | "Author", sizeof(m_manifest.author) - 1);
        m_manifest.iconId = mObj["icon"] | 1;
        m_manifest.refreshIntervalMs = mObj["rate"] | 1000;
        m_manifest.requiresAgenticMode = (mObj["agent"] | 0) != 0;
    }

    // 6. Unpack State Slot Table ("slots")
    std::memset(m_slots, 0, sizeof(m_slots));
    m_slotCount = 0;

    JsonArray slotsArr = doc["slots"].as<JsonArray>();
    for (JsonVariant slotEntry : slotsArr) {
        if (!slotEntry.is<JsonArray>()) continue;
        JsonArray s = slotEntry.as<JsonArray>();
        if (s.size() < 5) continue;

        const uint8_t slotIdx = s[0].as<uint8_t>();
        if (slotIdx >= petbot::widget::bytecode::MAX_STATE_SLOTS) continue;

        StateSlot& slot = m_slots[slotIdx];
        slot.slotIdx = slotIdx;
        const char* keyStr = s[1].as<const char*>();
        if (keyStr != nullptr) {
            strncpy(slot.key, keyStr, sizeof(slot.key) - 1);
        }

        slot.type = static_cast<StateVarType>(s[2].as<uint8_t>());
        JsonVariant initVal = s[3];
        slot.persistToSd = (s[4].as<int>() != 0);
        slot.dirty = false;
        slot.sparklineCount = 0;

        switch (slot.type) {
            case StateVarType::Int32:
                slot.valInt = initVal.as<int32_t>();
                slot.valFloat = static_cast<float>(slot.valInt);
                slot.valBool = (slot.valInt != 0);
                snprintf(slot.valStr, sizeof(slot.valStr), "%ld", static_cast<long>(slot.valInt));
                slot.pushSparkline(slot.valFloat);
                break;
            case StateVarType::Float:
                slot.valFloat = initVal.as<float>();
                slot.valInt = static_cast<int32_t>(slot.valFloat);
                slot.valBool = (std::fabs(slot.valFloat) > 0.0001f);
                snprintf(slot.valStr, sizeof(slot.valStr), "%.1f", slot.valFloat);
                slot.pushSparkline(slot.valFloat);
                break;
            case StateVarType::Bool:
                slot.valBool = initVal.as<bool>();
                slot.valInt = slot.valBool ? 1 : 0;
                slot.valFloat = slot.valBool ? 1.0f : 0.0f;
                strncpy(slot.valStr, slot.valBool ? "true" : "false", sizeof(slot.valStr) - 1);
                slot.pushSparkline(slot.valFloat);
                break;
            case StateVarType::String:
                slot.valBool = false;
                slot.valInt = 0;
                slot.valFloat = 0.0f;
                if (initVal.is<const char*>()) {
                    strncpy(slot.valStr, initVal.as<const char*>(), sizeof(slot.valStr) - 1);
                }
                break;
        }

        if (slotIdx >= m_slotCount) {
            m_slotCount = slotIdx + 1;
        }
    }

    // 7. Load Persisted State Slots from /sd/state/widget_<id>.state if available
    loadPersistedSlotsFromStorage();

    // 8. Recursive Node Tree Parser
    auto parseNode = [this](auto& self, JsonObject nObj) -> UiNode* {
        if (nObj.isNull()) return nullptr;
        auto* node = static_cast<UiNode*>(m_arena.alloc(sizeof(UiNode)));
        if (node == nullptr) return nullptr;

        node->type = static_cast<NodeType>(nObj["t"] | 1);
        JsonArray b = nObj["b"].as<JsonArray>();
        if (b.size() >= 4) {
            node->x = b[0].as<int16_t>();
            node->y = b[1].as<int16_t>();
            node->w = b[2].as<int16_t>();
            node->h = b[3].as<int16_t>();
        }

        // Visibility
        if (nObj.containsKey("v")) {
            if (nObj["v"].is<bool>()) {
                node->visibleSlot = nObj["v"].as<bool>() ? -1 : -2;
            } else {
                node->visibleSlot = nObj["v"].as<int8_t>();
            }
        } else {
            node->visibleSlot = -1; // Default visible
        }

        switch (node->type) {
            case NodeType::Container: {
                node->bg = nObj["bg"] | 0;
                node->r = nObj["r"] | 0;
                if (nObj.containsKey("bc")) {
                    node->bc = nObj["bc"].as<uint16_t>();
                    node->hasBorder = true;
                }
                node->pad = nObj["pad"] | 0;

                JsonArray chArr = nObj["ch"].as<JsonArray>();
                if (!chArr.isNull() && chArr.size() > 0) {
                    node->childCount = chArr.size();
                    node->children = static_cast<UiNode**>(m_arena.alloc(sizeof(UiNode*) * node->childCount));
                    for (uint8_t i = 0; i < node->childCount; ++i) {
                        node->children[i] = self(self, chArr[i].as<JsonObject>());
                    }
                }
                break;
            }
            case NodeType::Text: {
                const char* txt = nObj["txt"] | "";
                strncpy(node->text, txt, sizeof(node->text) - 1);
                node->fontSize = static_cast<FontSize>(nObj["sz"] | 1);
                node->textColor = nObj["c"] | 0xFFFF;
                node->align = static_cast<TextAlign>(nObj["al"] | 1);

                JsonArray slotsArr = nObj["slots"].as<JsonArray>();
                if (!slotsArr.isNull()) {
                    node->slotCount = std::min<uint8_t>(slotsArr.size(), 8);
                    for (uint8_t i = 0; i < node->slotCount; ++i) {
                        node->slotIndices[i] = slotsArr[i].as<uint8_t>();
                    }
                }
                break;
            }
            case NodeType::ProgressBar: {
                node->valSlot = nObj["valSlot"] | 0;
                node->minVal = nObj["min"] | 0.0f;
                node->maxVal = nObj["max"] | 100.0f;
                node->fgColor = nObj["fg"] | 0xFFFF;
                node->bg = nObj["bg"] | 0;
                node->orientation = static_cast<Orientation>(nObj["ori"] | 1);
                break;
            }
            case NodeType::Sparkline: {
                node->dataSlot = nObj["dataSlot"] | 0;
                node->textColor = nObj["c"] | 0xFFFF;
                node->lineWidth = nObj["w"] | 1;
                node->minVal = nObj["min"] | 0.0f;
                node->maxVal = nObj["max"] | 100.0f;
                break;
            }
            case NodeType::Icon: {
                node->iconId = nObj["icon"] | 1;
                node->textColor = nObj["c"] | 0xFFFF;
                node->scale = nObj["scale"] | 1.0f;
                break;
            }
            case NodeType::PetExpression: {
                node->emotion = static_cast<EmotionType>(nObj["emo"] | 0);
                node->expressionSize = nObj["sz"] | 64;
                break;
            }
            case NodeType::List: {
                node->itemSlot = nObj["itemSlot"] | 0;
                node->rowHeight = nObj["rowH"] | 16;
                node->activeItemColor = nObj["actColor"] | 0xFFFF;
                node->selectedIndex = 0;
                break;
            }
        }
        return node;
    };

    m_rootNode = parseNode(parseNode, doc["ui"].as<JsonObject>());

    // 9. Parse Triggers & Automations ("trig")
    JsonArray trigArr = doc["trig"].as<JsonArray>();
    if (!trigArr.isNull() && trigArr.size() > 0) {
        m_triggerCount = trigArr.size();
        m_triggers = static_cast<TriggerRule*>(m_arena.alloc(sizeof(TriggerRule) * m_triggerCount));

        for (uint8_t i = 0; i < m_triggerCount; ++i) {
            JsonObject tObj = trigArr[i].as<JsonObject>();
            TriggerRule& rule = m_triggers[i];
            rule.event = static_cast<EventType>(tObj["ev"] | 1);

            // Condition
            if (tObj.containsKey("cond")) {
                JsonArray cArr = tObj["cond"].as<JsonArray>();
                if (cArr.size() >= 3) {
                    rule.condition.hasCondition = true;
                    rule.condition.slotIdx = cArr[0].as<uint8_t>();
                    rule.condition.op = static_cast<OperatorType>(cArr[1].as<uint8_t>());
                    JsonVariant cv = cArr[2];

                    if (cv.is<bool>()) {
                        rule.condition.compareType = StateVarType::Bool;
                        rule.condition.compareBool = cv.as<bool>();
                    } else if (cv.is<int32_t>()) {
                        rule.condition.compareType = StateVarType::Int32;
                        rule.condition.compareInt = cv.as<int32_t>();
                        rule.condition.compareFloat = static_cast<float>(rule.condition.compareInt);
                    } else if (cv.is<float>()) {
                        rule.condition.compareType = StateVarType::Float;
                        rule.condition.compareFloat = cv.as<float>();
                        rule.condition.compareInt = static_cast<int32_t>(rule.condition.compareFloat);
                    } else if (cv.is<const char*>()) {
                        rule.condition.compareType = StateVarType::String;
                        strncpy(rule.condition.compareStr, cv.as<const char*>(), sizeof(rule.condition.compareStr) - 1);
                    }
                }
            }

            // Actions
            JsonArray actsArr = tObj["acts"].as<JsonArray>();
            if (!actsArr.isNull() && actsArr.size() > 0) {
                rule.actionCount = actsArr.size();
                rule.actions = static_cast<TriggerAction*>(m_arena.alloc(sizeof(TriggerAction) * rule.actionCount));

                for (uint8_t a = 0; a < rule.actionCount; ++a) {
                    JsonArray aItem = actsArr[a].as<JsonArray>();
                    TriggerAction& act = rule.actions[a];
                    act.type = static_cast<ActionType>(aItem[0].as<uint8_t>());

                    switch (act.type) {
                        case ActionType::MutateState:
                            act.targetSlot = aItem[1].as<uint8_t>();
                            act.mutOp = static_cast<MutateOp>(aItem[2].as<uint8_t>());
                            if (aItem.size() >= 4) {
                                JsonVariant mv = aItem[3];
                                if (mv.is<bool>()) {
                                    act.mutValType = StateVarType::Bool;
                                    act.mutBool = mv.as<bool>();
                                    act.mutInt = act.mutBool ? 1 : 0;
                                } else if (mv.is<int32_t>()) {
                                    act.mutValType = StateVarType::Int32;
                                    act.mutInt = mv.as<int32_t>();
                                    act.mutFloat = static_cast<float>(act.mutInt);
                                } else if (mv.is<float>()) {
                                    act.mutValType = StateVarType::Float;
                                    act.mutFloat = mv.as<float>();
                                    act.mutInt = static_cast<int32_t>(act.mutFloat);
                                } else if (mv.is<const char*>()) {
                                    act.mutValType = StateVarType::String;
                                    strncpy(act.mutStr, mv.as<const char*>(), sizeof(act.mutStr) - 1);
                                }
                            }
                            break;

                        case ActionType::PlaySound:
                            act.soundId = static_cast<SoundId>(aItem[1].as<uint8_t>());
                            act.soundFreqHz = aItem[2] | 1000;
                            act.soundDurationMs = aItem[3] | 150;
                            break;

                        case ActionType::SetExpression:
                            act.emotion = static_cast<EmotionType>(aItem[1].as<uint8_t>());
                            act.expressionDurationMs = aItem[2] | 2000;
                            break;

                        case ActionType::EmitHarnessRpc: {
                            const char* actId = aItem[1].as<const char*>();
                            if (actId != nullptr) {
                                strncpy(act.rpcActionId, actId, sizeof(act.rpcActionId) - 1);
                            }
                            act.rpcRiskTier = static_cast<RiskTier>(aItem[2].as<uint8_t>());
                            if (aItem.size() >= 4) {
                                serializeJson(aItem[3], act.rpcPayloadJson, sizeof(act.rpcPayloadJson));
                            }
                            break;
                        }

                        case ActionType::NavigatePage: {
                            const char* navId = aItem[1].as<const char*>();
                            if (navId != nullptr) {
                                strncpy(act.navigatePageId, navId, sizeof(act.navigatePageId) - 1);
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    m_loaded = true;
    m_lastTimerTickMs = millis();
    Serial.printf("[WidgetVM] Successfully loaded widget: %s (\"%s\") into PSRAM arena (Used: %u bytes)\n",
                  m_manifest.id, m_manifest.name, static_cast<unsigned>(m_arena.getUsed()));

    // Fire ON_LOAD trigger
    dispatchEvent(EventType::OnLoad);
    return true;
}

const StateSlot* WidgetVM::findSlotByKey(std::string_view key) const noexcept {
    for (size_t i = 0; i < m_slotCount; ++i) {
        if (key == m_slots[i].key) {
            return &m_slots[i];
        }
    }
    return nullptr;
}

bool WidgetVM::setSlotInt(uint8_t slotIdx, int32_t val) {
    if (slotIdx >= petbot::widget::bytecode::MAX_STATE_SLOTS) return false;
    StateSlot& slot = m_slots[slotIdx];
    slot.valInt = val;
    slot.valFloat = static_cast<float>(val);
    slot.valBool = (val != 0);
    snprintf(slot.valStr, sizeof(slot.valStr), "%ld", static_cast<long>(val));
    slot.pushSparkline(slot.valFloat);
    slot.dirty = true;
    return true;
}

bool WidgetVM::setSlotFloat(uint8_t slotIdx, float val) {
    if (slotIdx >= petbot::widget::bytecode::MAX_STATE_SLOTS) return false;
    StateSlot& slot = m_slots[slotIdx];
    slot.valFloat = val;
    slot.valInt = static_cast<int32_t>(val);
    slot.valBool = (std::fabs(val) > 0.0001f);
    snprintf(slot.valStr, sizeof(slot.valStr), "%.1f", val);
    slot.pushSparkline(val);
    slot.dirty = true;
    return true;
}

bool WidgetVM::setSlotBool(uint8_t slotIdx, bool val) {
    if (slotIdx >= petbot::widget::bytecode::MAX_STATE_SLOTS) return false;
    StateSlot& slot = m_slots[slotIdx];
    slot.valBool = val;
    slot.valInt = val ? 1 : 0;
    slot.valFloat = val ? 1.0f : 0.0f;
    strncpy(slot.valStr, val ? "true" : "false", sizeof(slot.valStr) - 1);
    slot.pushSparkline(slot.valFloat);
    slot.dirty = true;
    return true;
}

bool WidgetVM::setSlotString(uint8_t slotIdx, const char* val) {
    if (slotIdx >= petbot::widget::bytecode::MAX_STATE_SLOTS || val == nullptr) return false;
    StateSlot& slot = m_slots[slotIdx];
    strncpy(slot.valStr, val, sizeof(slot.valStr) - 1);
    slot.dirty = true;
    return true;
}

void WidgetVM::interpolateText(const char* templateStr, char* outBuf, size_t maxLen) const noexcept {
    if (templateStr == nullptr || outBuf == nullptr || maxLen == 0) return;

    size_t inIdx = 0;
    size_t outIdx = 0;
    const size_t inLen = std::strlen(templateStr);

    while (inIdx < inLen && outIdx < maxLen - 1) {
        if (templateStr[inIdx] == '{' && (inIdx + 1 < inLen) && templateStr[inIdx + 1] == '{') {
            // Find closing '}}'
            const char* closing = std::strstr(templateStr + inIdx + 2, "}}");
            if (closing != nullptr) {
                const size_t tokenLen = closing - (templateStr + inIdx + 2);
                char token[32]{0};
                if (tokenLen < sizeof(token)) {
                    std::memcpy(token, templateStr + inIdx + 2, tokenLen);
                    token[tokenLen] = '\0';

                    // Resolve token either as slot index or key
                    const StateSlot* targetSlot = nullptr;
                    bool isDigits = true;
                    for (size_t d = 0; d < tokenLen; ++d) {
                        if (token[d] < '0' || token[d] > '9') {
                            isDigits = false;
                            break;
                        }
                    }

                    if (isDigits) {
                        const int idx = std::atoi(token);
                        if (idx >= 0 && idx < static_cast<int>(petbot::widget::bytecode::MAX_STATE_SLOTS)) {
                            targetSlot = &m_slots[idx];
                        }
                    } else {
                        targetSlot = findSlotByKey(token);
                    }

                    if (targetSlot != nullptr) {
                        char valBuf[64]{0};
                        switch (targetSlot->type) {
                            case StateVarType::Int32:
                                snprintf(valBuf, sizeof(valBuf), "%ld", static_cast<long>(targetSlot->valInt));
                                break;
                            case StateVarType::Float:
                                snprintf(valBuf, sizeof(valBuf), "%.1f", targetSlot->valFloat);
                                break;
                            case StateVarType::Bool:
                                strncpy(valBuf, targetSlot->valBool ? "true" : "false", sizeof(valBuf) - 1);
                                break;
                            case StateVarType::String:
                                strncpy(valBuf, targetSlot->valStr, sizeof(valBuf) - 1);
                                break;
                        }

                        const size_t valLen = std::strlen(valBuf);
                        for (size_t v = 0; v < valLen && outIdx < maxLen - 1; ++v) {
                            outBuf[outIdx++] = valBuf[v];
                        }
                    }
                }
                inIdx = (closing + 2) - templateStr;
                continue;
            }
        }
        outBuf[outIdx++] = templateStr[inIdx++];
    }
    outBuf[outIdx] = '\0';
}

bool WidgetVM::persistDirtySlotsToStorage() {
    if (!m_loaded || std::strlen(m_manifest.id) == 0) return false;

    bool hasDirty = false;
    for (size_t i = 0; i < m_slotCount; ++i) {
        if (m_slots[i].persistToSd && m_slots[i].dirty) {
            hasDirty = true;
            break;
        }
    }
    if (!hasDirty) return true; // Nothing to persist

    JsonDocument doc;
    JsonArray slotsArr = doc["slots"].to<JsonArray>();

    for (size_t i = 0; i < m_slotCount; ++i) {
        if (m_slots[i].persistToSd) {
            JsonObject s = slotsArr.add<JsonObject>();
            s["idx"] = m_slots[i].slotIdx;
            s["key"] = m_slots[i].key;
            s["t"] = static_cast<uint8_t>(m_slots[i].type);
            switch (m_slots[i].type) {
                case StateVarType::Int32:
                    s["v"] = m_slots[i].valInt;
                    break;
                case StateVarType::Float:
                    s["v"] = m_slots[i].valFloat;
                    break;
                case StateVarType::Bool:
                    s["v"] = m_slots[i].valBool;
                    break;
                case StateVarType::String:
                    s["v"] = m_slots[i].valStr;
                    break;
            }
            m_slots[i].dirty = false;
        }
    }

    std::string jsonStr;
    serializeJson(doc, jsonStr);

    char statePath[64];
    snprintf(statePath, sizeof(statePath), "/state/widget_%s.state", m_manifest.id);

    return petbot::hal::StorageHal::instance().writeFileAtomic(
        statePath, reinterpret_cast<const uint8_t*>(jsonStr.data()), jsonStr.length(), true
    );
}

bool WidgetVM::loadPersistedSlotsFromStorage() {
    if (std::strlen(m_manifest.id) == 0) return false;

    char statePath[64];
    snprintf(statePath, sizeof(statePath), "/state/widget_%s.state", m_manifest.id);

    if (!petbot::hal::StorageHal::instance().exists(statePath)) {
        return false;
    }

    size_t length = 0;
    uint8_t* buf = petbot::hal::StorageHal::instance().readFileToPsram(statePath, &length, nullptr, true);
    if (buf == nullptr || length == 0) {
        return false;
    }

    JsonDocument doc;
    const DeserializationError err = deserializeJson(doc, buf, length);
    petbot::hal::StorageHal::instance().freeBuffer(buf);

    if (err) {
        return false;
    }

    JsonArray slotsArr = doc["slots"].as<JsonArray>();
    for (JsonObject s : slotsArr) {
        const uint8_t idx = s["idx"] | 255;
        if (idx < petbot::widget::bytecode::MAX_STATE_SLOTS && idx < m_slotCount) {
            StateSlot& slot = m_slots[idx];
            if (!slot.persistToSd) continue;

            JsonVariant val = s["v"];
            switch (slot.type) {
                case StateVarType::Int32:
                    slot.valInt = val.as<int32_t>();
                    slot.valFloat = static_cast<float>(slot.valInt);
                    slot.valBool = (slot.valInt != 0);
                    snprintf(slot.valStr, sizeof(slot.valStr), "%ld", static_cast<long>(slot.valInt));
                    slot.pushSparkline(slot.valFloat);
                    break;
                case StateVarType::Float:
                    slot.valFloat = val.as<float>();
                    slot.valInt = static_cast<int32_t>(slot.valFloat);
                    slot.valBool = (std::fabs(slot.valFloat) > 0.0001f);
                    snprintf(slot.valStr, sizeof(slot.valStr), "%.1f", slot.valFloat);
                    slot.pushSparkline(slot.valFloat);
                    break;
                case StateVarType::Bool:
                    slot.valBool = val.as<bool>();
                    slot.valInt = slot.valBool ? 1 : 0;
                    slot.valFloat = slot.valBool ? 1.0f : 0.0f;
                    strncpy(slot.valStr, slot.valBool ? "true" : "false", sizeof(slot.valStr) - 1);
                    slot.pushSparkline(slot.valFloat);
                    break;
                case StateVarType::String:
                    if (val.is<const char*>()) {
                        strncpy(slot.valStr, val.as<const char*>(), sizeof(slot.valStr) - 1);
                    }
                    break;
            }
        }
    }
    return true;
}

void WidgetVM::onEnter() {
    dispatchEvent(EventType::OnLoad);
}

void WidgetVM::onExit() {
    persistDirtySlotsToStorage();
}

void WidgetVM::update(uint32_t nowMs) {
    if (!m_loaded) return;

    if (m_manifest.refreshIntervalMs > 0) {
        if (nowMs - m_lastTimerTickMs >= m_manifest.refreshIntervalMs) {
            m_lastTimerTickMs = nowMs;
            dispatchEvent(EventType::OnTimerTick);
        }
    }
}

void WidgetVM::handleTouch(const TouchGestureEvent& evt) {
    switch (evt.gesture) {
        case petbot::hal::TouchGesture::SingleTap:
            dispatchEvent(EventType::OnTouchTap);
            break;
        case petbot::hal::TouchGesture::DoubleTap:
            dispatchEvent(EventType::OnTouchDoubleTap);
            break;
        case petbot::hal::TouchGesture::LongPress:
            dispatchEvent(EventType::OnTouchLongPress);
            break;
        case petbot::hal::TouchGesture::PettingRapid:
            dispatchEvent(EventType::OnTouchPetting);
            break;
        case petbot::hal::TouchGesture::LeftTap:
            dispatchEvent(EventType::OnTouchLeftTap);
            dispatchEvent(EventType::OnTouchTap); // backward compatibility fallback
            break;
        case petbot::hal::TouchGesture::RightTap:
            dispatchEvent(EventType::OnTouchRightTap);
            dispatchEvent(EventType::OnTouchTap); // backward compatibility fallback
            break;
        case petbot::hal::TouchGesture::LeftDoubleTap:
            dispatchEvent(EventType::OnTouchLeftDoubleTap);
            dispatchEvent(EventType::OnTouchDoubleTap);
            break;
        case petbot::hal::TouchGesture::RightDoubleTap:
            dispatchEvent(EventType::OnTouchRightDoubleTap);
            dispatchEvent(EventType::OnTouchDoubleTap);
            break;
        case petbot::hal::TouchGesture::SwipeLeftToRight:
            dispatchEvent(EventType::OnTouchSwipeL2R);
            break;
        case petbot::hal::TouchGesture::SwipeRightToLeft:
            dispatchEvent(EventType::OnTouchSwipeR2L);
            break;
        case petbot::hal::TouchGesture::DualTap:
            dispatchEvent(EventType::OnTouchDualTap);
            break;
        case petbot::hal::TouchGesture::DualLongPress:
            dispatchEvent(EventType::OnTouchDualLongPress);
            break;
        case petbot::hal::TouchGesture::DualPetting:
            dispatchEvent(EventType::OnTouchDualPetting);
            dispatchEvent(EventType::OnTouchPetting);
            break;
        case petbot::hal::TouchGesture::SideTap:
            dispatchEvent(EventType::OnTouchSideTap);
            break;
        case petbot::hal::TouchGesture::SideDoubleTap:
            dispatchEvent(EventType::OnTouchSideDoubleTap);
            break;
        case petbot::hal::TouchGesture::SideLongPress:
            dispatchEvent(EventType::OnTouchSideLongPress);
            break;
        case petbot::hal::TouchGesture::SidePetting:
            dispatchEvent(EventType::OnTouchSidePetting);
            break;
        case petbot::hal::TouchGesture::RightPinchTap:
        case petbot::hal::TouchGesture::RightPinchLongPress:
            dispatchEvent(EventType::OnTouchRightPinch);
            break;
        case petbot::hal::TouchGesture::CrossChordTap:
        case petbot::hal::TouchGesture::CrossChordLongPress:
            dispatchEvent(EventType::OnTouchCrossChord);
            break;
        case petbot::hal::TouchGesture::SwipeTopToSide:
            dispatchEvent(EventType::OnTouchSwipeTopToSide);
            break;
        case petbot::hal::TouchGesture::SwipeSideToTop:
            dispatchEvent(EventType::OnTouchSwipeSideToTop);
            break;
        case petbot::hal::TouchGesture::TripleTap:
            dispatchEvent(EventType::OnTouchTripleTap);
            break;
        case petbot::hal::TouchGesture::TripleLongPress:
            dispatchEvent(EventType::OnTouchTripleLongPress);
            break;
        case petbot::hal::TouchGesture::FullBodyGrooming:
            dispatchEvent(EventType::OnTouchFullBodyGroom);
            break;
        case petbot::hal::TouchGesture::LeftLongPress:
            dispatchEvent(EventType::OnTouchLeftLongPress);
            break;
        case petbot::hal::TouchGesture::RightLongPress:
            dispatchEvent(EventType::OnTouchRightLongPress);
            break;
        default:
            break;
    }
}

bool WidgetVM::isNodeVisible(const UiNode* node) const noexcept {
    if (node == nullptr) return false;
    if (node->visibleSlot == -1) return true;
    if (node->visibleSlot == -2) return false;
    if (node->visibleSlot >= 0 && node->visibleSlot < static_cast<int8_t>(petbot::widget::bytecode::MAX_STATE_SLOTS)) {
        return m_slots[node->visibleSlot].valBool;
    }
    return true;
}

void WidgetVM::render(Canvas128x160& canvas) {
    if (!m_loaded || m_rootNode == nullptr) {
        canvas.clear(petbot::hal::colors::Black);
        return;
    }
    renderNode(canvas, m_rootNode);
}

void WidgetVM::renderNode(Canvas128x160& canvas, const UiNode* node) {
    if (node == nullptr || !isNodeVisible(node)) return;

    switch (node->type) {
        case NodeType::Container: {
            if (node->bg != 0 || node->r > 0) {
                canvas.fillRoundRect(node->x, node->y, node->w, node->h, node->r, node->bg);
            }
            if (node->hasBorder) {
                canvas.drawRoundRect(node->x, node->y, node->w, node->h, node->r, node->bc);
            }
            if (node->children != nullptr) {
                for (uint8_t i = 0; i < node->childCount; ++i) {
                    renderNode(canvas, node->children[i]);
                }
            }
            break;
        }

        case NodeType::Text: {
            char interpolated[128]{0};
            interpolateText(node->text, interpolated, sizeof(interpolated));

            const uint8_t scale = static_cast<uint8_t>(node->fontSize);
            const size_t textLen = std::strlen(interpolated);
            const int16_t textW = static_cast<int16_t>(textLen * (scale * 6));
            const int16_t textH = static_cast<int16_t>(scale * 8);

            int16_t tx = node->x + node->pad;
            if (node->align == TextAlign::Center) {
                tx = node->x + (node->w - textW) / 2;
            } else if (node->align == TextAlign::Right) {
                tx = node->x + node->w - textW - node->pad;
            }

            int16_t ty = node->y + (node->h - textH) / 2;
            if (ty < node->y) ty = node->y;

            canvas.drawText(tx, ty, interpolated, node->textColor, node->bg, scale, true);
            break;
        }

        case NodeType::ProgressBar: {
            const float minV = node->minVal;
            const float maxV = node->maxVal;
            float curV = 0.0f;
            if (node->valSlot < petbot::widget::bytecode::MAX_STATE_SLOTS) {
                curV = m_slots[node->valSlot].valFloat;
            }

            const float range = (maxV > minV) ? (maxV - minV) : 1.0f;
            const float norm = std::clamp((curV - minV) / range, 0.0f, 1.0f);

            // Background
            canvas.fillRect(node->x, node->y, node->w, node->h, node->bg);

            if (node->orientation == Orientation::Horizontal) {
                const int16_t fillW = static_cast<int16_t>(node->w * norm);
                if (fillW > 0) {
                    canvas.fillRect(node->x, node->y, fillW, node->h, node->fgColor);
                }
            } else {
                const int16_t fillH = static_cast<int16_t>(node->h * norm);
                if (fillH > 0) {
                    canvas.fillRect(node->x, node->y + node->h - fillH, node->w, fillH, node->fgColor);
                }
            }
            break;
        }

        case NodeType::Sparkline: {
            if (node->dataSlot >= petbot::widget::bytecode::MAX_STATE_SLOTS) break;
            const StateSlot& slot = m_slots[node->dataSlot];
            if (slot.sparklineCount < 2) break;

            const float minV = node->minVal;
            const float maxV = node->maxVal;
            const float range = (maxV > minV) ? (maxV - minV) : 1.0f;

            const uint8_t count = slot.sparklineCount;
            for (uint8_t i = 0; i < count - 1; ++i) {
                const int16_t x0 = node->x + static_cast<int16_t>((i * (node->w - 1)) / (count - 1));
                const int16_t x1 = node->x + static_cast<int16_t>(((i + 1) * (node->w - 1)) / (count - 1));

                const float norm0 = std::clamp((slot.sparklineHistory[i] - minV) / range, 0.0f, 1.0f);
                const float norm1 = std::clamp((slot.sparklineHistory[i + 1] - minV) / range, 0.0f, 1.0f);

                const int16_t y0 = node->y + node->h - 1 - static_cast<int16_t>(norm0 * (node->h - 1));
                const int16_t y1 = node->y + node->h - 1 - static_cast<int16_t>(norm1 * (node->h - 1));

                canvas.drawLine(x0, y0, x1, y1, node->textColor);
            }
            break;
        }

        case NodeType::Icon: {
            // Builtin Procedural Vector Glyphs
            const int16_t cx = node->x + (node->w / 2);
            const int16_t cy = node->y + (node->h / 2);
            const uint16_t col = node->textColor;

            switch (node->iconId) {
                case 1: // Heart
                    canvas.fillCircle(cx - 3, cy - 2, 3, col);
                    canvas.fillCircle(cx + 3, cy - 2, 3, col);
                    canvas.drawLine(cx - 6, cy - 1, cx, cy + 6, col);
                    canvas.drawLine(cx + 6, cy - 1, cx, cy + 6, col);
                    break;
                case 2: // Star
                    canvas.drawFastVLine(cx, cy - 6, 12, col);
                    canvas.drawFastHLine(cx - 6, cy, 12, col);
                    canvas.drawLine(cx - 4, cy - 4, cx + 4, cy + 4, col);
                    canvas.drawLine(cx - 4, cy + 4, cx + 4, cy - 4, col);
                    break;
                case 3: // Checkmark
                    canvas.drawLine(cx - 5, cy, cx - 1, cy + 4, col);
                    canvas.drawLine(cx - 1, cy + 4, cx + 6, cy - 4, col);
                    break;
                default: // Bell / Gear dot
                    canvas.fillCircle(cx, cy, 4, col);
                    break;
            }
            break;
        }

        case NodeType::PetExpression: {
            petbot::firmware::ui::ExpressionEngine::instance().render(
                canvas, node->x, node->y, node->w, node->h, node->emotion
            );
            break;
        }

        case NodeType::List: {
            if (node->itemSlot >= petbot::widget::bytecode::MAX_STATE_SLOTS) break;
            const StateSlot& slot = m_slots[node->itemSlot];

            // Render rows delimited by '\n' or ','
            const char* str = slot.valStr;
            int16_t curY = node->y;
            int16_t rowIdx = 0;
            char lineBuf[32]{0};
            size_t lIdx = 0;

            for (size_t i = 0; str[i] != '\0' && curY + node->rowHeight <= node->y + node->h; ++i) {
                if (str[i] == '\n' || str[i] == ',') {
                    lineBuf[lIdx] = '\0';
                    if (rowIdx == node->selectedIndex) {
                        canvas.fillRect(node->x, curY, node->w, node->rowHeight, node->activeItemColor);
                        canvas.drawText(node->x + 2, curY + 2, lineBuf, petbot::hal::colors::Black, node->activeItemColor, 1, true);
                    } else {
                        canvas.drawText(node->x + 2, curY + 2, lineBuf, petbot::hal::colors::White, petbot::hal::colors::Black, 1, true);
                    }
                    curY += node->rowHeight;
                    lIdx = 0;
                    rowIdx++;
                } else if (lIdx < sizeof(lineBuf) - 1) {
                    lineBuf[lIdx++] = str[i];
                }
            }
            if (lIdx > 0 && curY + node->rowHeight <= node->y + node->h) {
                lineBuf[lIdx] = '\0';
                if (rowIdx == node->selectedIndex) {
                    canvas.fillRect(node->x, curY, node->w, node->rowHeight, node->activeItemColor);
                    canvas.drawText(node->x + 2, curY + 2, lineBuf, petbot::hal::colors::Black, node->activeItemColor, 1, true);
                } else {
                    canvas.drawText(node->x + 2, curY + 2, lineBuf, petbot::hal::colors::White, petbot::hal::colors::Black, 1, true);
                }
            }
            break;
        }
    }
}

bool WidgetVM::evaluateCondition(const TriggerCondition& cond) const noexcept {
    if (!cond.hasCondition) return true;
    if (cond.slotIdx >= petbot::widget::bytecode::MAX_STATE_SLOTS) return false;

    const StateSlot& slot = m_slots[cond.slotIdx];
    switch (cond.compareType) {
        case StateVarType::Int32: {
            switch (cond.op) {
                case OperatorType::Eq:  return slot.valInt == cond.compareInt;
                case OperatorType::Neq: return slot.valInt != cond.compareInt;
                case OperatorType::Gt:  return slot.valInt >  cond.compareInt;
                case OperatorType::Lt:  return slot.valInt <  cond.compareInt;
                case OperatorType::Gte: return slot.valInt >= cond.compareInt;
                case OperatorType::Lte: return slot.valInt <= cond.compareInt;
            }
            break;
        }
        case StateVarType::Float: {
            constexpr float kFloatEpsilon = 0.0001f;
            switch (cond.op) {
                case OperatorType::Eq:  return std::fabs(slot.valFloat - cond.compareFloat) < kFloatEpsilon;
                case OperatorType::Neq: return std::fabs(slot.valFloat - cond.compareFloat) >= kFloatEpsilon;
                case OperatorType::Gt:  return slot.valFloat >  cond.compareFloat;
                case OperatorType::Lt:  return slot.valFloat <  cond.compareFloat;
                case OperatorType::Gte: return slot.valFloat >= cond.compareFloat;
                case OperatorType::Lte: return slot.valFloat <= cond.compareFloat;
            }
            break;
        }
        case StateVarType::Bool: {
            if (cond.op == OperatorType::Eq)  return slot.valBool == cond.compareBool;
            if (cond.op == OperatorType::Neq) return slot.valBool != cond.compareBool;
            break;
        }
        case StateVarType::String: {
            const int cmp = std::strcmp(slot.valStr, cond.compareStr);
            if (cond.op == OperatorType::Eq)  return cmp == 0;
            if (cond.op == OperatorType::Neq) return cmp != 0;
            break;
        }
    }
    return false;
}

void WidgetVM::executeAction(const TriggerAction& act) {
    switch (act.type) {
        case ActionType::MutateState: {
            if (act.targetSlot >= petbot::widget::bytecode::MAX_STATE_SLOTS) break;
            StateSlot& slot = m_slots[act.targetSlot];

            switch (act.mutOp) {
                case MutateOp::Set:
                    if (act.mutValType == StateVarType::Int32) {
                        setSlotInt(act.targetSlot, act.mutInt);
                    } else if (act.mutValType == StateVarType::Float) {
                        setSlotFloat(act.targetSlot, act.mutFloat);
                    } else if (act.mutValType == StateVarType::Bool) {
                        setSlotBool(act.targetSlot, act.mutBool);
                    } else if (act.mutValType == StateVarType::String) {
                        setSlotString(act.targetSlot, act.mutStr);
                    }
                    break;

                case MutateOp::Increment: {
                    const int32_t delta = (act.mutInt != 0) ? act.mutInt : 1;
                    if (slot.type == StateVarType::Float) {
                        const float fDelta = (std::fabs(act.mutFloat) > 0.0001f) ? act.mutFloat : static_cast<float>(delta);
                        setSlotFloat(act.targetSlot, slot.valFloat + fDelta);
                    } else {
                        setSlotInt(act.targetSlot, slot.valInt + delta);
                    }
                    break;
                }

                case MutateOp::Decrement: {
                    const int32_t delta = (act.mutInt != 0) ? act.mutInt : 1;
                    if (slot.type == StateVarType::Float) {
                        const float fDelta = (std::fabs(act.mutFloat) > 0.0001f) ? act.mutFloat : static_cast<float>(delta);
                        setSlotFloat(act.targetSlot, slot.valFloat - fDelta);
                    } else {
                        setSlotInt(act.targetSlot, slot.valInt - delta);
                    }
                    break;
                }

                case MutateOp::Toggle:
                    setSlotBool(act.targetSlot, !slot.valBool);
                    break;
            }
            break;
        }

        case ActionType::PlaySound: {
            petbot::hal::AudioHal::instance().playProceduralSound(act.soundId);
            break;
        }

        case ActionType::SetExpression: {
            petbot::firmware::ui::ExpressionEngine::instance().setTemporaryEmotion(
                act.emotion, act.expressionDurationMs
            );
            break;
        }

        case ActionType::EmitHarnessRpc: {
            // Serialize FrameType::HarnessRpcReq and dispatch over AgenticTransport
            JsonDocument doc;
            doc["actionId"] = act.rpcActionId;
            doc["riskTier"] = static_cast<uint8_t>(act.rpcRiskTier);
            if (std::strlen(act.rpcPayloadJson) > 0) {
                JsonDocument pDoc;
                if (!deserializeJson(pDoc, act.rpcPayloadJson)) {
                    doc["payload"] = pDoc;
                }
            }

            std::string frameJson;
            serializeJson(doc, frameJson);

            petbot::firmware::agentic::AgenticTransport::instance().sendFrame(
                petbot::protocol::FrameType::HarnessRpcReq,
                reinterpret_cast<const uint8_t*>(frameJson.data()),
                frameJson.length()
            );
            break;
        }

        case ActionType::NavigatePage: {
            if (std::strlen(act.navigatePageId) > 0) {
                petbot::firmware::ui::UIManager::instance().navigateToPage(act.navigatePageId);
            }
            break;
        }
    }
}

void WidgetVM::dispatchEvent(EventType evt) {
    if (!m_loaded || m_triggers == nullptr) return;

    for (uint8_t i = 0; i < m_triggerCount; ++i) {
        const TriggerRule& rule = m_triggers[i];
        if (rule.event == evt) {
            if (evaluateCondition(rule.condition)) {
                for (uint8_t a = 0; a < rule.actionCount; ++a) {
                    executeAction(rule.actions[a]);
                }
            }
        }
    }
}

} // namespace petbot::firmware::agentic
