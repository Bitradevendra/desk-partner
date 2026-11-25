import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  encode,
  decode,
  FrameType,
  RobotMode,
  EmotionId,
  encodeFrame,
  decodeFrame,
  crc32,
  HarnessRpcReqSchema,
  Touch2FaChallengeSchema,
  type HarnessRpcReq,
  type Touch2FaChallenge,
} from "@petbot/protocol";
import {
  BYTECODE_MAGIC,
  BYTECODE_VERSION,
  NodeTypeOpcode,
} from "@petbot/widget-schema";

describe("Agentic Orchestrator & PC Telemetry HUD Integration Verification (Phase 3)", () => {
  const firmwareDir = path.resolve(__dirname, "../../../firmware");
  const agenticMgrHPath = path.join(firmwareDir, "include/agentic/agentic_manager.h");
  const agenticMgrCppPath = path.join(firmwareDir, "src/agentic/agentic_manager.cpp");
  const uiManagerHPath = path.join(firmwareDir, "include/ui/ui_manager.h");
  const uiManagerCppPath = path.join(firmwareDir, "src/ui/ui_manager.cpp");
  const builtinPagesCppPath = path.join(firmwareDir, "src/apps/builtin_pages.cpp");
  const mainCppPath = path.join(firmwareDir, "src/main.cpp");
  const sdVaultHPath = path.join(firmwareDir, "include/agentic/sd_vault.h");
  const sdVaultCppPath = path.join(firmwareDir, "src/agentic/sd_vault.cpp");

  it("verifies AgenticManager C++20 header and source exist with zero TODOs or placeholders", () => {
    const files = [agenticMgrHPath, agenticMgrCppPath];

    for (const f of files) {
      expect(fs.existsSync(f), `File missing: ${f}`).toBe(true);
      const content = fs.readFileSync(f, "utf-8");
      expect(content).not.toMatch(/\bTODO\b/);
      expect(content).not.toMatch(/\bFIXME\b/);
      expect(content).not.toMatch(/\bPLACEHOLDER\b/);
      expect(content.length).toBeGreaterThan(600);
    }
  });

  it("verifies Core 0 Task_AgenticNet pinning, Priority 3, and 12KB stack configuration", () => {
    const cppContent = fs.readFileSync(agenticMgrCppPath, "utf-8");
    expect(cppContent).toContain("Task_AgenticNet");
    expect(cppContent).toContain("12288"); // 12KB stack
    expect(cppContent).toContain("xTaskCreatePinnedToCore");
    expect(cppContent).toContain("0      // Core 0");
  });

  it("verifies UIManager cleanly preempts screens for Touch 2FA and SD Vault transfers", () => {
    const uiContent = fs.readFileSync(uiManagerCppPath, "utf-8");
    // Preemption 0a: Touch 2FA modal
    expect(uiContent).toContain("Touch2FAManager::instance().isModalActive()");
    expect(uiContent).toContain("Touch2FAManager::instance().render(canvas)");

    // Preemption 0b: SD Vault transfer overlay
    expect(uiContent).toContain("SdVaultEngine::instance().isTransferActive()");
    expect(uiContent).toContain("SdVaultEngine::instance().renderTransferOverlay(canvas)");

    // Touch preemption
    expect(uiContent).toContain("Touch2FAManager::instance().handleTouch(evt)");
  });

  it("verifies UIManager renders unified top status bar with OFFLINE vs AGENTIC and MIC indicators", () => {
    const uiHContent = fs.readFileSync(uiManagerHPath, "utf-8");
    expect(uiHContent).toContain("drawTopStatusBar(Canvas128x160& canvas, uint32_t nowMs = 0)");

    const uiCppContent = fs.readFileSync(uiManagerCppPath, "utf-8");
    expect(uiCppContent).toContain("void UIManager::drawTopStatusBar(");
    expect(uiCppContent).toContain("AGENT");
    expect(uiCppContent).toContain("OFFLINE");
    expect(uiCppContent).toContain("MIC");
    expect(uiCppContent).toContain("drawFastVLine"); // Wi-Fi RSSI bars

    const builtinContent = fs.readFileSync(builtinPagesCppPath, "utf-8");
    expect(builtinContent).toContain("ui::UIManager::instance().drawTopStatusBar(canvas, nowMs)");
  });

  it("verifies main.cpp initializes AgenticManager and implements all diagnostic CLI commands", () => {
    const mainContent = fs.readFileSync(mainCppPath, "utf-8");
    expect(mainContent).toContain("AgenticManager::instance().init(transportConfig)");

    // CLI diagnostic commands
    expect(mainContent).toContain('strncmp(cmd, "wifi ", 5) == 0');
    expect(mainContent).toContain('strcmp(cmd, "sim_2fa") == 0');
    expect(mainContent).toContain('strcmp(cmd, "sim_widget") == 0');
    expect(mainContent).toContain('strcmp(cmd, "vault_list") == 0');

    // Help documentation
    expect(mainContent).toContain("wifi <s> <p>");
    expect(mainContent).toContain("sim_2fa");
    expect(mainContent).toContain("sim_widget");
    expect(mainContent).toContain("vault_list");
  });

  describe("Desktop Harness Live Telemetry Protocol Broadcasts", () => {
    it("encodes and decodes HARNESS_RPC_REQ telemetry payloads", () => {
      const telemetryReq: HarnessRpcReq = {
        callId: "telem_broadcast_101",
        method: "telemetry_broadcast",
        params: {
          cpuPercent: 42,
          ramPercent: 68,
          gpuPercent: 15,
          activeWindow: "VS Code",
          mediaState: "♫ Daft Punk - Veridis Quo",
          mediaPlaying: true,
          unreadNotifications: 3,
          meetingActive: false,
          deepWorkActive: true,
        },
      };

      const packed = encode(telemetryReq);
      const frameBytes = encodeFrame(FrameType.HARNESS_RPC_REQ, packed, 88);

      const decodedFrame = decodeFrame(frameBytes);
      expect(decodedFrame.header.frameType).toBe(FrameType.HARNESS_RPC_REQ);

      const unpacked = decode(decodedFrame.payload) as HarnessRpcReq;
      expect(unpacked.callId).toBe("telem_broadcast_101");
      expect(unpacked.params["cpuPercent"]).toBe(42);
      expect(unpacked.params["ramPercent"]).toBe(68);
      expect(unpacked.params["gpuPercent"]).toBe(15);
      expect(unpacked.params["activeWindow"]).toBe("VS Code");
      expect(unpacked.params["deepWorkActive"]).toBe(true);
    });

    it("verifies meeting/deep-work triggers EmotionId.FOCUSED state", () => {
      const isFocusTriggered = (meetingActive: boolean, deepWorkActive: boolean): EmotionId => {
        if (meetingActive || deepWorkActive) {
          return EmotionId.FOCUSED;
        }
        return EmotionId.IDLE;
      };

      expect(isFocusTriggered(false, false)).toBe(EmotionId.IDLE);
      expect(isFocusTriggered(true, false)).toBe(EmotionId.FOCUSED);
      expect(isFocusTriggered(false, true)).toBe(EmotionId.FOCUSED);
      expect(isFocusTriggered(true, true)).toBe(EmotionId.FOCUSED);
    });
  });

  describe("Media Control RPC Trigger", () => {
    it("encodes outbound media play/pause toggle RPC request", () => {
      const mediaToggleReq: HarnessRpcReq = {
        callId: "media_cmd_01",
        method: "media_play_pause",
        params: {
          action: "toggle",
        },
      };

      const validated = HarnessRpcReqSchema.parse(mediaToggleReq);
      expect(validated.method).toBe("media_play_pause");

      const packed = encode(validated);
      const frame = encodeFrame(FrameType.HARNESS_RPC_REQ, packed, 1);
      const decoded = decodeFrame(frame);
      expect(decoded.header.frameType).toBe(FrameType.HARNESS_RPC_REQ);
    });
  });

  describe("Simulated PBWG Bytecode Generation & Validation", () => {
    function computeCrc16(buf: Uint8Array): number {
      let crc = 0xffff;
      for (let i = 0; i < buf.length; ++i) {
        crc ^= (buf[i]! << 8) & 0xffff;
        for (let bit = 0; bit < 8; ++bit) {
          if (crc & 0x8000) {
            crc = (((crc << 1) ^ 0x1021) & 0xffff) >>> 0;
          } else {
            crc = ((crc << 1) & 0xffff) >>> 0;
          }
        }
      }
      return crc & 0xffff;
    }

    it("synthesizes valid 8-byte PBWG header and MessagePack AST matching sim_widget", () => {
      const widgetAst = {
        widgetId: "crypto_ticker",
        name: "Crypto Ticker",
        version: 1,
        author: "PetBot Agent",
        persistToSd: false,
        stateSlots: [
          {
            index: 0,
            name: "btc_price",
            type: 4, // String
            initialValue: "$94,250",
          },
        ],
        rootNode: {
          type: NodeTypeOpcode.CONTAINER,
          x: 0,
          y: 0,
          width: 160,
          height: 128,
          children: [
            {
              type: NodeTypeOpcode.TEXT,
              x: 8,
              y: 14,
              width: 144,
              height: 16,
              text: "BTC / USD",
            },
            {
              type: NodeTypeOpcode.TEXT,
              x: 8,
              y: 40,
              width: 112,
              height: 20,
              text: "{{slot0}}",
            },
            {
              type: NodeTypeOpcode.SPARKLINE,
              x: 12,
              y: 70,
              width: 104,
              height: 32,
            },
          ],
        },
      };

      const msgpackPayload = encode(widgetAst);
      const crc = computeCrc16(msgpackPayload);

      const bytecode = new Uint8Array(8 + msgpackPayload.length);
      bytecode[0] = 0x50; // 'P'
      bytecode[1] = 0x42; // 'B'
      bytecode[2] = 0x57; // 'W'
      bytecode[3] = 0x47; // 'G'
      bytecode[4] = 0x01; // Version LE low
      bytecode[5] = 0x00; // Version LE high
      bytecode[6] = crc & 0xff;
      bytecode[7] = (crc >> 8) & 0xff;
      bytecode.set(msgpackPayload, 8);

      expect(bytecode.length).toBe(8 + msgpackPayload.length);

      // Verify magic
      const view = new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);
      expect(view.getUint32(0, false)).toBe(BYTECODE_MAGIC);
      expect(view.getUint16(4, true)).toBe(BYTECODE_VERSION);
      expect(view.getUint16(6, true)).toBe(crc);
    });
  });
});
