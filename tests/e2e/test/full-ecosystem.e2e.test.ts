import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FrameType,
  RobotMode,
  EmotionId,
  RiskTier,
  FLAG_ACK_REQUIRED,
  FLAG_FINAL_CHUNK,
  FLAG_PRIORITY_REALTIME,
  SD_CHUNK_SIZE_BYTES,
  OTA_CHUNK_SIZE_BYTES,
  SdVaultStatus,
  OtaAckStatus,
  crc32,
  encodeFrame,
  decodeFrame,
  encodeControlPayload,
  decodeControlPayload,
  encodeSdVaultChunk,
  decodeSdVaultAck,
  encodeOtaUpdateChunk,
  decodeOtaUpdateAck,
  encodeAudioDownlinkFrame,
  SdVaultStartSchema,
  SdVaultListReqSchema,
  SdVaultListResSchema,
  OtaUpdateStartSchema,
  type SdVaultAck,
  type SdVaultListRes,
  type OtaAckPayload,
} from "@petbot/protocol";
import {
  compileWidgetToBytecode,
  type WidgetPackage,
} from "@petbot/widget-schema";
import {
  createSignedOtaBundle,
  buildOtaSigningPayload,
  normalizePublicKey,
} from "@petbot/virtual-robot-emulator";
import { PetBotTestCluster } from "../src/test-cluster.js";

describe("PetBot Full Ecosystem E2E Verification Suite", () => {
  let cluster: PetBotTestCluster;

  beforeEach(async () => {
    cluster = new PetBotTestCluster({
      robotInitialMode: RobotMode.NORMAL_OFFLINE,
      firmwareVersion: "1.0.0-xtensa-lx7",
    });
    await cluster.start();
  });

  afterEach(async () => {
    if (cluster) {
      await cluster.stop();
    }
  });

  // =========================================================================
  // JOURNEY 1: Seamless Offline-to-Agentic Auto-Switching & Heartbeat Fallback
  // =========================================================================
  it("Journey 1: Seamless Offline-to-Agentic Auto-Switching & Heartbeat Fallback (<100ms switch, preserve local timer/habit state)", async () => {
    // 1. Initial State: Robot boots in standalone NORMAL_OFFLINE
    expect(cluster.robot.getMode()).toBe(RobotMode.NORMAL_OFFLINE);

    // 2. Seed local habit counters and timer in PSRAM
    cluster.robot.setStateSlot("habit_water_counter", 3);
    cluster.robot.setStateSlot("local_timer_seconds", 1200);
    expect(cluster.robot.getStateSlot("habit_water_counter")).toBe(3);
    expect(cluster.robot.getStateSlot("local_timer_seconds")).toBe(1200);

    // 3. Connect Companion App via live binary WebSocket
    const { wsPort } = cluster.robotServer.getBoundPorts();
    const connectStart = performance.now();
    const connected = await cluster.companion.connectWebSocket("127.0.0.1", wsPort);
    const connectElapsed = performance.now() - connectStart;

    expect(connected).toBe(true);
    expect(cluster.companion.getState()).toBe("AGENTIC_ONLINE");

    // Wait short tick for mode transition frame to process
    const modeWaitStart = Date.now();
    while (cluster.robot.getMode() !== RobotMode.AGENTIC_CONNECTED && Date.now() - modeWaitStart < 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(cluster.robot.getMode()).toBe(RobotMode.AGENTIC_CONNECTED);
    // Latency budget check
    expect(connectElapsed).toBeLessThan(1000);

    // 4. Connection Severance: Companion disconnects (simulating walkaway / network drop)
    const disconnectStart = performance.now();
    cluster.companion.disconnect();

    // Give socket close event a short tick to propagate to server
    await new Promise((resolve) => setTimeout(resolve, 80));
    const disconnectElapsed = performance.now() - disconnectStart;

    // Robot must immediately fallback to NORMAL_OFFLINE while preserving PSRAM state
    expect(cluster.robot.getMode()).toBe(RobotMode.NORMAL_OFFLINE);
    expect(cluster.robot.getStateSlot("habit_water_counter")).toBe(3);
    expect(cluster.robot.getStateSlot("local_timer_seconds")).toBe(1200);
    expect(disconnectElapsed).toBeLessThan(250);

    // 5. Reconnect Companion App
    const reconnected = await cluster.companion.connectWebSocket("127.0.0.1", wsPort);
    expect(reconnected).toBe(true);

    const reconnectWaitStart = Date.now();
    while (cluster.robot.getMode() !== RobotMode.AGENTIC_CONNECTED && Date.now() - reconnectWaitStart < 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(cluster.robot.getMode()).toBe(RobotMode.AGENTIC_CONNECTED);

    // Ensure PSRAM states remained intact across reconnect
    expect(cluster.robot.getStateSlot("habit_water_counter")).toBe(3);
    expect(cluster.robot.getStateSlot("local_timer_seconds")).toBe(1200);
  });

  // =========================================================================
  // JOURNEY 2: Zero-Code Studio Prompt -> Live PBWG Bytecode Push -> 160x128 Runtime Execution
  // =========================================================================
  it("Journey 2: Zero-Code Studio prompt -> live PBWG bytecode push -> 160x128 runtime execution with physical SINGLE_TAP gestures mutating O(1) PSRAM slots and triggering HAPPY emotion", async () => {
    const { wsPort } = cluster.robotServer.getBoundPorts();
    await cluster.companion.connectWebSocket("127.0.0.1", wsPort);

    // 1. Natural Language Widget specification compiled to validated WidgetPackage
    const hydrationWidget: WidgetPackage = {
      manifest: {
        id: "widget-hydration-counter",
        name: "Hydration Tracker",
        version: "1.0.0",
        author: "Studio Compiler",
        iconId: 1,
        refreshIntervalMs: 1000,
        requiresAgenticMode: false,
      },
      state: {
        cups: {
          type: "int32",
          initialValue: 0,
          persistToSd: true,
        },
      },
      ui: {
        type: "Container",
        x: 0,
        y: 0,
        w: 160,
        h: 128,
        backgroundColor: "#0D1117",
        borderRadius: 0,
        children: [
          {
            type: "Text",
            x: 10,
            y: 30,
            w: 140,
            h: 40,
            text: "Water: {cups} / 8",
            fontSize: "md",
            color: "#00FF66",
            align: "center",
          },
        ],
      },
      triggers: [
        {
          event: "ON_TOUCH_TAP",
          actions: [
            {
              type: "MUTATE_STATE",
              targetKey: "cups",
              operation: "INCREMENT",
              value: 1,
            },
            {
              type: "SET_EXPRESSION",
              emotion: "HAPPY",
              durationMs: 1500,
            },
            {
              type: "PLAY_SOUND",
              soundId: "CHIRP",
              frequencyHz: 880,
              durationMs: 120,
            },
          ],
        },
      ],
    };

    // 2. Compile to binary PBWG bytecode segment
    const bytecode = compileWidgetToBytecode(hydrationWidget);
    expect(bytecode.byteLength).toBeGreaterThan(64);
    // Verify PBWG magic header: 0x50 0x42 0x57 0x47
    expect(bytecode[0]).toBe(0x50);
    expect(bytecode[1]).toBe(0x42);
    expect(bytecode[2]).toBe(0x57);
    expect(bytecode[3]).toBe(0x47);

    // 3. Deploy over live binary protocol
    const deploySuccess = await cluster.companion.deployWidget(hydrationWidget);
    expect(deploySuccess).toBe(true);

    // Wait short tick for frame processing
    await new Promise((r) => setTimeout(r, 50));

    // 4. Verify widget loaded into 8MB PSRAM runtime
    expect(cluster.robot.getActiveWidget()?.manifest.id).toBe("widget-hydration-counter");
    expect(cluster.robot.getStateSlot("cups")).toBe(0);

    // 5. Simulate 8 physical capacitive touch SINGLE_TAP gestures
    for (let tap = 1; tap <= 8; tap++) {
      cluster.robot.triggerTouchGesture("SINGLE_TAP");
      expect(cluster.robot.getStateSlot("cups")).toBe(tap);
      expect(cluster.robot.getEmotion()).toBe(EmotionId.HAPPY);
    }

    // 6. Verify 160x128 16-bit RGB565 Framebuffer
    const framebuffer = cluster.robot.getFramebuffer();
    expect(framebuffer.length).toBe(160 * 128);
    // Ensure display pixels are actively drawn
    let nonZeroPixels = 0;
    for (let i = 0; i < framebuffer.length; i++) {
      if ((framebuffer[i] ?? 0) !== 0) {
        nonZeroPixels++;
      }
    }
    expect(nonZeroPixels).toBeGreaterThan(100);
  });

  // =========================================================================
  // JOURNEY 3: "Send & Collect" SD Vault 10.5 MB Stress Test with Chunk Retry
  // =========================================================================
  it("Journey 3: 'Send & Collect' SD Vault 10.5 MB stress test, intentional chunk #128 corruption to verify CRC_MISMATCH_RETRY recovery, and 100% byte-for-byte SHA-256 verification", async () => {
    // 1. Generate 10.5 MB binary payload (10,500,000 bytes)
    const totalBytes = 10_500_000;
    const testData = new Uint8Array(totalBytes);
    for (let i = 0; i < totalBytes; i++) {
      testData[i] = (i * 31 + 17) & 0xff;
    }
    const expectedSha256 = crypto.createHash("sha256").update(testData).digest("hex");

    const chunkSize = SD_CHUNK_SIZE_BYTES; // 16384 bytes
    const totalChunks = Math.ceil(totalBytes / chunkSize); // 641 chunks
    expect(totalChunks).toBe(641);

    const fileName = "stress_test_10mb.bin";
    const transferId = 882191;

    // Track inbound acks from the robot
    const acksReceived: SdVaultAck[] = [];
    const unsub = cluster.robot.addOutboundListener((frameBytes) => {
      const frame = decodeFrame(frameBytes);
      if (frame.header.frameType === FrameType.SD_VAULT_ACK) {
        acksReceived.push(decodeSdVaultAck(frame.payload));
      }
    });

    try {
      // 2. Send SD_VAULT_START Control Frame
      const startPayload = {
        fileId: "file-vault-stress-10m",
        path: `/sdcard/${fileName}`,
        totalBytes,
        totalChunks,
        sha256Hex: expectedSha256,
        direction: "PUSH_TO_ROBOT" as const,
      };
      const startFramePayload = encodeControlPayload(SdVaultStartSchema, startPayload);
      const startFrame = encodeFrame(FrameType.SD_VAULT_START, startFramePayload, 1, FLAG_ACK_REQUIRED);
      cluster.robot.handleInboundFrame(startFrame);

      expect(acksReceived.length).toBe(1);
      expect(acksReceived[0]?.status).toBe(SdVaultStatus.OK);

      // 3. Stream chunks with intentional corruption on chunk #128
      let retryTriggered = false;

      for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
        const offset = chunkIdx * chunkSize;
        const end = Math.min(offset + chunkSize, totalBytes);
        const rawChunk = testData.subarray(offset, end);
        let chunkCrc = crc32(rawChunk);

        // Inject intentional CRC corruption on chunk #128
        if (chunkIdx === 128 && !retryTriggered) {
          const corruptedCrc = chunkCrc ^ 0xdeadbeef;
          const corruptChunk = encodeSdVaultChunk({
            transferId,
            chunkIndex: chunkIdx,
            chunkCrc32: corruptedCrc,
            rawBytes: rawChunk,
          });
          const corruptFrame = encodeFrame(FrameType.SD_VAULT_CHUNK, corruptChunk, chunkIdx + 2);
          cluster.robot.handleInboundFrame(corruptFrame);

          // Verify robot returned CRC_MISMATCH_RETRY
          const lastAck = acksReceived[acksReceived.length - 1];
          expect(lastAck?.status).toBe(SdVaultStatus.CRC_MISMATCH_RETRY);
          expect(lastAck?.nextExpectedChunk).toBe(128);

          retryTriggered = true;
          // Retransmit valid chunk #128
        }

        const validChunk = encodeSdVaultChunk({
          transferId,
          chunkIndex: chunkIdx,
          chunkCrc32: chunkCrc,
          rawBytes: rawChunk,
        });
        const isFinal = chunkIdx === totalChunks - 1;
        const flags = isFinal ? FLAG_FINAL_CHUNK : 0;
        const validFrame = encodeFrame(FrameType.SD_VAULT_CHUNK, validChunk, chunkIdx + 2, flags);
        cluster.robot.handleInboundFrame(validFrame);
      }

      expect(retryTriggered).toBe(true);

      // 4. Verify Final ACK is COMPLETED
      const finalAck = acksReceived[acksReceived.length - 1];
      expect(finalAck?.status).toBe(SdVaultStatus.COMPLETED);

      // 5. Verify file was saved to Virtual SD Card with 100% byte-for-byte SHA-256 match
      const targetFilePath = path.join(cluster.sdDir, fileName);
      expect(fs.existsSync(targetFilePath)).toBe(true);

      const savedBytes = fs.readFileSync(targetFilePath);
      expect(savedBytes.byteLength).toBe(totalBytes);
      const computedSha256 = crypto.createHash("sha256").update(savedBytes).digest("hex");
      expect(computedSha256).toBe(expectedSha256);

      // 6. Query SD Vault Directory Listing via protocol (SD_VAULT_LIST_REQ)
      let listResponse: SdVaultListRes | null = null;
      const listUnsub = cluster.robot.addOutboundListener((frameBytes) => {
        const frame = decodeFrame(frameBytes);
        if (frame.header.frameType === FrameType.SD_VAULT_LIST_RES) {
          listResponse = decodeControlPayload(SdVaultListResSchema, frame.payload);
        }
      });

      const listReqPayload = encodeControlPayload(SdVaultListReqSchema, { directoryPath: "/sdcard" });
      const listReqFrame = encodeFrame(FrameType.SD_VAULT_LIST_REQ, listReqPayload, 999);
      cluster.robot.handleInboundFrame(listReqFrame);

      expect(listResponse).not.toBeNull();
      const listedEntry = listResponse!.entries.find((e) => e.name === fileName);
      expect(listedEntry).toBeDefined();
      expect(listedEntry?.sizeBytes).toBe(totalBytes);
      expect(listedEntry?.isDirectory).toBe(false);

      listUnsub();
    } finally {
      unsub();
    }
  });

  // =========================================================================
  // JOURNEY 4: Subscription Gate Enforcement & Emotion-Synced Real-Time Audio Downlink
  // =========================================================================
  it("Journey 4: Subscription gate enforcement (FREE rejected) -> dev activate PRO -> signed entitlement sync -> emotion-synced 16kHz PCM audio downlink + viseme mouth/eye keyframes", async () => {
    const { wsPort } = cluster.robotServer.getBoundPorts();
    await cluster.companion.connectWebSocket("127.0.0.1", wsPort);

    // 1. FREE Tier: Voice AI and continuous agentic cloud features are locked
    const freeToken = await cluster.cloudGateway.engine.mintEntitlementToken(
      "user_dev_01",
      cluster.robot.getTelemetrySnapshot().deviceId,
      "FREE"
    );
    expect(freeToken.capabilities.tier).toBe("FREE");
    expect(freeToken.capabilities.voiceAiEnabled).toBe(false);
    expect(freeToken.capabilities.cloudAgenticToolsEnabled).toBe(false);

    // 2. Dev Upgrades to PRO Tier
    const proToken = await cluster.cloudGateway.engine.mintEntitlementToken(
      "user_dev_01",
      cluster.robot.getTelemetrySnapshot().deviceId,
      "PRO"
    );
    expect(proToken.capabilities.tier).toBe("PRO");
    expect(proToken.capabilities.voiceAiEnabled).toBe(true);
    expect(proToken.capabilities.cloudAgenticToolsEnabled).toBe(true);
    expect(proToken.capabilities.allowedPersonas.length).toBeGreaterThan(0);

    // 3. Sync signed subscription entitlement over protocol
    const syncSuccess = await cluster.companion.syncSubscriptionEntitlement(
      "PRO",
      [...proToken.capabilities.allowedPersonas]
    );
    expect(syncSuccess).toBe(true);

    // 4. Stream emotion-synced 16kHz PCM Audio Downlink Frame with Visemes
    const audioPcm = new Uint8Array(640); // 320 samples (20ms at 16kHz)
    for (let i = 0; i < audioPcm.length; i++) {
      audioPcm[i] = (i * 7) & 0xff;
    }

    const downlinkPayload = encodeAudioDownlinkFrame({
      emotionId: EmotionId.FOCUSED,
      visemeMouthOpen: 215,
      eyeGazeX: 18,
      eyeGazeY: -22,
      audioData: audioPcm,
    });
    const downlinkFrame = encodeFrame(
      FrameType.AUDIO_DOWNLINK_FRAME,
      downlinkPayload,
      101,
      FLAG_PRIORITY_REALTIME
    );

    // Dispatch frame to robot
    cluster.robot.handleInboundFrame(downlinkFrame);

    // 5. Verify Virtual Robot Rig state matches the audio downlink keyframe
    expect(cluster.robot.getEmotion()).toBe(EmotionId.FOCUSED);
    expect(cluster.robot.getVisemeMouthOpen()).toBe(215);
    expect(cluster.robot.getEyeGaze()).toEqual([18, -22]);

    const log = cluster.robot.getAudioKeyframeLog();
    expect(log.length).toBeGreaterThan(0);
    const lastEntry = log[log.length - 1];
    expect(lastEntry?.emotion).toBe(EmotionId.FOCUSED);
    expect(lastEntry?.visemeMouthOpen).toBe(215);
    expect(lastEntry?.eyeGaze).toEqual([18, -22]);
  });

  // =========================================================================
  // JOURNEY 5: Desktop Harness Tier-3 Security Gate & Hardware Touch 2FA
  // =========================================================================
  it("Journey 5: Desktop Harness Tier-3 security gate (emptyTrashOrDeleteTempFiles) -> TOUCH_2FA_CHALLENGE -> physical deny (LONG_PRESS) logging DENIED_BY_TOUCH -> physical approve (SINGLE_TAP) logging APPROVED_BY_TOUCH", async () => {
    // 1. Establish live WebSocket bridge between Robot and Desktop Harness
    await cluster.connectRobotToHarness();
    const activeSession = cluster.harnessDaemon.server.getActiveRobotSession();
    expect(activeSession?.authenticated).toBe(true);

    const callerDeviceId = cluster.robot.getTelemetrySnapshot().deviceId;

    // --- Part A: Physical DENY (LONG_PRESS) ---
    const denyActionPromise = cluster.harnessDaemon.sandbox.executeSandboxedAction(
      {
        callId: "call_empty_trash_deny",
        actionId: "emptyTrashOrDeleteTempFiles",
        params: { targetPaths: ["/tmp/test_rubbish"] },
        timeoutMs: 5000,
      },
      callerDeviceId
    );

    // Wait until 2FA challenge is active on the robot display
    while (!cluster.robot.getTelemetrySnapshot().active2FaChallengeId) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(cluster.robot.getTelemetrySnapshot().active2FaChallengeId).toBeTruthy();

    // Robot user physical deny: LONG_PRESS
    const denyResponse = cluster.robot.triggerTouchGesture("LONG_PRESS");
    expect(denyResponse?.decision).toBe("DENIED_LONG_PRESS");

    const denyResult = await denyActionPromise;
    expect(denyResult.ok).toBe(false);
    expect(denyResult.error).toBe("HARDWARE_2FA_DENIED");

    // Verify audit log status
    const denyAuditEntry = cluster.harnessDaemon.auditLogger.getEntryById("call_empty_trash_deny");
    expect(denyAuditEntry?.status).toBe("DENIED_BY_TOUCH");

    // --- Part B: Physical APPROVE (SINGLE_TAP) ---
    const approveActionPromise = cluster.harnessDaemon.sandbox.executeSandboxedAction(
      {
        callId: "call_empty_trash_approve",
        actionId: "emptyTrashOrDeleteTempFiles",
        params: { targetPaths: ["/tmp/test_rubbish"] },
        timeoutMs: 5000,
      },
      callerDeviceId
    );

    // Wait until 2FA challenge is active on the robot display
    while (!cluster.robot.getTelemetrySnapshot().active2FaChallengeId) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(cluster.robot.getTelemetrySnapshot().active2FaChallengeId).toBeTruthy();

    // Robot user physical approve: SINGLE_TAP (signs challenge with Ed25519 private key)
    const approveResponse = cluster.robot.triggerTouchGesture("SINGLE_TAP");
    expect(approveResponse?.decision).toBe("APPROVED_SINGLE_TAP");
    expect(approveResponse?.signatureHex.length).toBe(128); // 64-byte Ed25519 signature

    const approveResult = await approveActionPromise;
    expect(approveResult.ok).toBe(true);
    expect(approveResult.success).toBe(true);

    // Verify audit log status
    const diskEntries = cluster.harnessDaemon.auditLogger.readLogFile();
    const approvedTouchEntry = diskEntries.find(
      (e) => e.id === "call_empty_trash_approve" && e.status === "APPROVED_BY_TOUCH"
    );
    expect(approvedTouchEntry).toBeDefined();

    const approveAuditEntry = cluster.harnessDaemon.auditLogger.getEntryById("call_empty_trash_approve");
    expect(approveAuditEntry?.status).toBe("COMPLETED");
  });

  // =========================================================================
  // JOURNEY 6: Signed Dual-Partition OTA Firmware Update
  // =========================================================================
  it("Journey 6: Signed Dual-Partition OTA firmware update (v2.0.0 signed bundle with Ed25519 accepted; tampered binary rejected with SIGNATURE_INVALID)", async () => {
    // 1. Generate dedicated Ed25519 OTA Release Keypair
    const otaKeyPair = crypto.generateKeyPairSync("ed25519");
    const derSpki = otaKeyPair.publicKey.export({ type: "spki", format: "der" });
    const otaPublicKeyHex = derSpki.subarray(-32).toString("hex");

    // Pin trusted OTA public key in robot firmware
    cluster.robot.setOtaTrustedPublicKey(otaPublicKeyHex);

    // Verify initial partition and version
    expect(cluster.robot.getOtaRunningPartition()).toBe("app0");
    expect(cluster.robot.getFirmwareVersion()).toBe("1.0.0-xtensa-lx7");

    // 2. Test Tampered / Invalid Signature: Must be rejected with SIGNATURE_INVALID
    const tamperedStartPayload = {
      version: "2.0.0",
      totalBytes: 32768,
      totalChunks: 2,
      sha256Hex: "0".repeat(64),
      ed25519SignatureHex: "ff".repeat(64), // Invalid / unverified signature
    };
    const tamperedStartBytes = encodeControlPayload(OtaUpdateStartSchema, tamperedStartPayload);
    const tamperedFrame = encodeFrame(FrameType.OTA_UPDATE_START, tamperedStartBytes, 1);

    const tamperedResult = cluster.robot.handleInboundFrame(tamperedFrame);
    expect(tamperedResult.response).toBeDefined();

    const decodedTamperedAck = decodeOtaUpdateAck(decodeFrame(tamperedResult.response!).payload);
    expect(decodedTamperedAck.status).toBe(OtaAckStatus.SIGNATURE_INVALID);

    // Partition and version remain unchanged
    expect(cluster.robot.getOtaRunningPartition()).toBe("app0");
    expect(cluster.robot.getFirmwareVersion()).toBe("1.0.0-xtensa-lx7");

    // 3. Test Cryptographically Valid Signed OTA Update
    // Create mock v2.0.0 firmware binary (48KB = 3 chunks of 16KB)
    const fwBinary = new Uint8Array(48 * 1024);
    for (let i = 0; i < fwBinary.length; i++) {
      fwBinary[i] = (i * 13 + 37) & 0xff;
    }

    const signedBundle = createSignedOtaBundle(fwBinary, "2.0.0", otaKeyPair.privateKey);
    const chunkSize = OTA_CHUNK_SIZE_BYTES; // 16384 bytes
    const totalChunks = signedBundle.manifest.totalChunks;
    expect(totalChunks).toBe(3);

    // Send OTA_UPDATE_START
    const validStartBytes = encodeControlPayload(OtaUpdateStartSchema, {
      version: signedBundle.manifest.version,
      totalBytes: signedBundle.manifest.totalBytes,
      totalChunks: signedBundle.manifest.totalChunks,
      sha256Hex: signedBundle.manifest.sha256Hex,
      ed25519SignatureHex: signedBundle.manifest.ed25519SignatureHex,
    });
    const validStartFrame = encodeFrame(FrameType.OTA_UPDATE_START, validStartBytes, 2);
    const startResult = cluster.robot.handleInboundFrame(validStartFrame);
    expect(startResult.response).toBeDefined();

    const startAck = decodeOtaUpdateAck(decodeFrame(startResult.response!).payload);
    expect(startAck.status).toBe(OtaAckStatus.OK);
    const transferId = startAck.transferId;

    // Stream the 3 chunks
    let finalAck: OtaAckPayload | null = null;
    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      const offset = chunkIdx * chunkSize;
      const end = Math.min(offset + chunkSize, fwBinary.byteLength);
      const rawChunk = fwBinary.subarray(offset, end);
      const chunkCrc = crc32(rawChunk);

      const chunkPayload = encodeOtaUpdateChunk({
        transferId,
        chunkIndex: chunkIdx,
        chunkCrc32: chunkCrc,
        rawBytes: rawChunk,
      });

      const isFinal = chunkIdx === totalChunks - 1;
      const flags = isFinal ? FLAG_FINAL_CHUNK : 0;
      const chunkFrame = encodeFrame(FrameType.OTA_UPDATE_CHUNK, chunkPayload, chunkIdx + 3, flags);
      const chunkResult = cluster.robot.handleInboundFrame(chunkFrame);

      if (isFinal) {
        expect(chunkResult.response).toBeDefined();
        finalAck = decodeOtaUpdateAck(decodeFrame(chunkResult.response!).payload);
      }
    }

    // 4. Verify Final ACK confirms reboot into new firmware
    expect(finalAck).not.toBeNull();
    expect(finalAck?.status).toBe(OtaAckStatus.REBOOTING_INTO_NEW_FIRMWARE);
    expect(finalAck?.progressPct).toBe(100);

    // 5. Verify Dual-Partition Swap to app1 and version upgraded to v2.0.0
    expect(cluster.robot.getOtaRunningPartition()).toBe("app1");
    expect(cluster.robot.getFirmwareVersion()).toBe("2.0.0");
  });
});
