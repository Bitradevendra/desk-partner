#pragma once

#include <cstdint>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>
#include <memory>
#if defined(__has_include) && __has_include(<span>) && __cplusplus >= 202002L
#include <span>
#endif

#include "petbot_protocol.h"
#include "petbot_widget_bytecode.h"
#include "apps/app_page.h"
#include "hal/psram_allocator.h"
#include "hal/touch_hal.h"
#include "hal/audio_hal.h"

namespace petbot::firmware::agentic {

using petbot::widget::bytecode::NodeType;
using petbot::widget::bytecode::EventType;
using petbot::widget::bytecode::ActionType;
using petbot::widget::bytecode::EmotionType;
using petbot::widget::bytecode::OperatorType;
using petbot::widget::bytecode::StateVarType;
using petbot::widget::bytecode::FontSize;
using petbot::widget::bytecode::TextAlign;
using petbot::widget::bytecode::Orientation;
using petbot::widget::bytecode::RiskTier;
using petbot::widget::bytecode::SoundId;
using petbot::widget::bytecode::MutateOp;
using petbot::widget::bytecode::WidgetBytecodeHeader;

using petbot::hal::Canvas128x160;
using petbot::hal::TouchGestureEvent;

/**
 * 128KB Pre-allocated Octal PSRAM Arena dedicated to a single active Widget runtime.
 * Guarantees zero internal SRAM heap fragmentation during widget hot-reloads.
 */
class PsramWidgetArena {
public:
    static constexpr size_t ARENA_SIZE = 128 * 1024; // 128 KB

    PsramWidgetArena() noexcept;
    ~PsramWidgetArena() noexcept;

    PsramWidgetArena(const PsramWidgetArena&) = delete;
    PsramWidgetArena& operator=(const PsramWidgetArena&) = delete;

    bool allocate() noexcept;
    void reset() noexcept;
    void release() noexcept;

    [[nodiscard]] void* alloc(size_t bytes, size_t align = 4) noexcept;
    [[nodiscard]] char* strdup(const char* str) noexcept;

    [[nodiscard]] uint8_t* rawBuffer() noexcept { return m_buffer; }
    [[nodiscard]] size_t getCapacity() const noexcept { return ARENA_SIZE; }
    [[nodiscard]] size_t getUsed() const noexcept { return m_offset; }
    [[nodiscard]] bool isValid() const noexcept { return m_buffer != nullptr; }

private:
    uint8_t* m_buffer{nullptr};
    size_t m_offset{0};
    bool m_isPsram{false};
};

/**
 * Metadata header parsed from Widget bytecode manifest block.
 */
struct WidgetManifest {
    char id[32]{0};
    char name[32]{0};
    char version[16]{0};
    char author[32]{0};
    uint16_t iconId{0};
    uint32_t refreshIntervalMs{1000};
    bool requiresAgenticMode{false};
};

/**
 * Deterministic O(1) State Slot Table entry.
 */
struct StateSlot {
    uint8_t slotIdx{0};
    char key[32]{0};
    StateVarType type{StateVarType::Int32};

    int32_t valInt{0};
    float valFloat{0.0f};
    bool valBool{false};
    char valStr[64]{0};

    bool persistToSd{false};
    bool dirty{false};

    // Rolling 32-point telemetry history for sparkline charts
    float sparklineHistory[32]{0.0f};
    uint8_t sparklineCount{0};

    void pushSparkline(float val) noexcept {
        if (sparklineCount < 32) {
            sparklineHistory[sparklineCount++] = val;
        } else {
            for (size_t i = 0; i < 31; ++i) {
                sparklineHistory[i] = sparklineHistory[i + 1];
            }
            sparklineHistory[31] = val;
        }
    }
};

/**
 * Decoded UI AST Node inside PSRAM arena.
 */
struct UiNode {
    NodeType type{NodeType::Container};
    int16_t x{0}, y{0}, w{0}, h{0};
    int8_t visibleSlot{-1}; // -1 = always true, -2 = always false, >=0 = slotIdx

    // Container
    uint16_t bg{0};
    int16_t r{0};
    uint16_t bc{0};
    bool hasBorder{false};
    int16_t pad{0};
    UiNode** children{nullptr};
    uint8_t childCount{0};

    // Text
    char text[64]{0};
    FontSize fontSize{FontSize::Sm};
    uint16_t textColor{0xFFFF};
    TextAlign align{TextAlign::Left};
    uint8_t slotIndices[8]{0};
    uint8_t slotCount{0};

    // ProgressBar
    uint8_t valSlot{0};
    float minVal{0.0f};
    float maxVal{100.0f};
    uint16_t fgColor{0xFFFF};
    Orientation orientation{Orientation::Horizontal};

    // Sparkline
    uint8_t dataSlot{0};
    uint8_t lineWidth{1};

    // Icon
    uint16_t iconId{0};
    float scale{1.0f};

    // PetExpression
    EmotionType emotion{EmotionType::Idle};
    uint8_t expressionSize{64};

    // List
    uint8_t itemSlot{0};
    uint8_t rowHeight{16};
    uint16_t activeItemColor{0xFFFF};
    int16_t selectedIndex{0};
};

/**
 * Decoded Condition Expression.
 */
struct TriggerCondition {
    uint8_t slotIdx{0};
    OperatorType op{OperatorType::Eq};
    int32_t compareInt{0};
    float compareFloat{0.0f};
    bool compareBool{false};
    char compareStr[64]{0};
    StateVarType compareType{StateVarType::Int32};
    bool hasCondition{false};
};

/**
 * Decoded Sequential Action.
 */
struct TriggerAction {
    ActionType type{ActionType::MutateState};

    // MutateState
    uint8_t targetSlot{0};
    MutateOp mutOp{MutateOp::Set};
    int32_t mutInt{0};
    float mutFloat{0.0f};
    bool mutBool{false};
    char mutStr[64]{0};
    StateVarType mutValType{StateVarType::Int32};

    // PlaySound
    SoundId soundId{SoundId::Chirp};
    uint16_t soundFreqHz{1000};
    uint16_t soundDurationMs{150};

    // SetExpression
    EmotionType emotion{EmotionType::Idle};
    uint32_t expressionDurationMs{2000};

    // EmitHarnessRpc
    char rpcActionId[32]{0};
    RiskTier rpcRiskTier{RiskTier::Tier1Safe};
    char rpcPayloadJson[128]{0};

    // NavigatePage
    char navigatePageId[32]{0};
};

/**
 * Decoded Automation Trigger Rule.
 */
struct TriggerRule {
    EventType event{EventType::OnTouchTap};
    TriggerCondition condition{};
    TriggerAction* actions{nullptr};
    uint8_t actionCount{0};
};

/**
 * Declarative Widget Virtual Machine & Automation Runtime.
 * Executes PBWG bytecode at 60 FPS directly from Octal PSRAM.
 * Seamlessly implements petbot::firmware::apps::IAppPage.
 */
class WidgetVM : public petbot::firmware::apps::IAppPage {
public:
    WidgetVM();
    ~WidgetVM() override;

    WidgetVM(const WidgetVM&) = delete;
    WidgetVM& operator=(const WidgetVM&) = delete;

    /**
     * Load, validate checksums, and instantiate bytecode from memory buffer.
     * @param data Bytecode binary buffer.
     * @param len Buffer length in bytes.
     * @return true on valid header, CRC16 match, and successful AST unpack.
     */
    bool loadBytecode(const uint8_t* data, size_t len);

    /**
     * IAppPage Interface Implementation
     */
    [[nodiscard]] const char* getPageId() const noexcept override {
        return m_manifest.id;
    }
    [[nodiscard]] const char* getPageTitle() const noexcept override {
        return m_manifest.name;
    }

    void onEnter() override;
    void onExit() override;
    void update(uint32_t nowMs) override;
    void update(uint32_t nowMs, float dt) override { (void)dt; update(nowMs); }
    void render(Canvas128x160& canvas) override;
    void handleTouch(const TouchGestureEvent& evt) override;

    /**
     * Dispatch an event to matching automation trigger rules.
     */
    void dispatchEvent(EventType evt);

    /**
     * Direct State Slot Accessors (O(1) indexing)
     */
    [[nodiscard]] const StateSlot* getStateSlots() const noexcept { return m_slots; }
    [[nodiscard]] size_t getStateSlotCount() const noexcept { return m_slotCount; }
    [[nodiscard]] const StateSlot* findSlotByKey(std::string_view key) const noexcept;
    bool setSlotInt(uint8_t slotIdx, int32_t val);
    bool setSlotFloat(uint8_t slotIdx, float val);
    bool setSlotBool(uint8_t slotIdx, bool val);
    bool setSlotString(uint8_t slotIdx, const char* val);

    /**
     * Zero-allocation string interpolation replacing {{slotIdx}} or {{key}} with live slot values.
     */
    void interpolateText(const char* templateStr, char* outBuf, size_t maxLen) const noexcept;

    /**
     * Persist dirty state slots marked persistToSd to /sd/state/widget_<id>.state
     */
    bool persistDirtySlotsToStorage();

    /**
     * Load persisted state slots from /sd/state/widget_<id>.state
     */
    bool loadPersistedSlotsFromStorage();

    [[nodiscard]] const WidgetManifest& getManifest() const noexcept { return m_manifest; }
    [[nodiscard]] bool isLoaded() const noexcept { return m_loaded; }

    static uint16_t computeCrc16(const uint8_t* buf, size_t len) noexcept;

private:
    void renderNode(Canvas128x160& canvas, const UiNode* node);
    bool isNodeVisible(const UiNode* node) const noexcept;
    bool evaluateCondition(const TriggerCondition& cond) const noexcept;
    void executeAction(const TriggerAction& act);

    PsramWidgetArena m_arena;
    WidgetManifest m_manifest{};
    StateSlot m_slots[petbot::widget::bytecode::MAX_STATE_SLOTS]{};
    size_t m_slotCount{0};

    UiNode* m_rootNode{nullptr};
    TriggerRule* m_triggers{nullptr};
    uint8_t m_triggerCount{0};

    bool m_loaded{false};
    uint32_t m_lastTimerTickMs{0};
};

} // namespace petbot::firmware::agentic
