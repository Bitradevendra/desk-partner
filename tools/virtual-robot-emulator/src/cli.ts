#!/usr/bin/env node
import { VirtualRobotServer } from "./emulator-server.js";

async function main() {
  const args = process.argv.slice(2);
  let wsPort = 8443;
  let httpPort = 8444;
  let advertiseBonjour = true;
  let sdDirectory: string | undefined;
  let harnessUrl: string | undefined;
  let keysFilePath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && args[i + 1]) {
      wsPort = parseInt(args[i + 1]!, 10);
      i++;
    } else if (arg === "--http-port" && args[i + 1]) {
      httpPort = parseInt(args[i + 1]!, 10);
      i++;
    } else if (arg === "--no-mdns") {
      advertiseBonjour = false;
    } else if (arg === "--sd-dir" && args[i + 1]) {
      sdDirectory = args[i + 1];
      i++;
    } else if (arg === "--harness-url" && args[i + 1]) {
      harnessUrl = args[i + 1];
      i++;
    } else if (arg === "--keys-file" && args[i + 1]) {
      keysFilePath = args[i + 1];
      i++;
    }
  }

  const server = new VirtualRobotServer({
    wsPort,
    httpPort,
    advertiseBonjour,
    sdDirectory,
    harnessUrl,
    keysFilePath,
  });

  await server.start();

  console.log(`
================================================================
  🤖 PetBot ESP32-S3 Hardware Twin Emulator Running
================================================================
  Binary Protocol WS : ws://localhost:${wsPort}/ws
  HTTP Inspection UI : http://localhost:${httpPort}
  mDNS Advertising   : ${advertiseBonjour ? "_petbot._tcp.local" : "Disabled"}
----------------------------------------------------------------
  Terminal Hotkeys (Interactive):
    [Space]  Single Tap (Approve 2FA / Trigger Action)
    [D]      Double Tap
    [L]      Long Press (Deny 2FA / Long Press Trigger)
    [P]      Pet Robot (Affection / Warm Purr)
    [V]      Push-to-Talk Synthetic Audio Uplink
    [Q]      Quit Emulator
================================================================
`);

  // Interactive Terminal Keypress Handling
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      process.stdin.on("data", async (key: string) => {
        // Ctrl+C or 'q'
        if (key === "\u0003" || key.toLowerCase() === "q") {
          console.log("\n[Emulator] Shutting down...");
          await server.stop();
          process.exit(0);
        }

        if (key === " ") {
          console.log("[HotKey] -> 👆 Single Tap");
          server.robot.triggerTouchGesture("SINGLE_TAP");
        } else if (key.toLowerCase() === "d") {
          console.log("[HotKey] -> ✌️ Double Tap");
          server.robot.triggerTouchGesture("DOUBLE_TAP");
        } else if (key.toLowerCase() === "l") {
          console.log("[HotKey] -> ⏱️ Long Press");
          server.robot.triggerTouchGesture("LONG_PRESS");
        } else if (key.toLowerCase() === "p") {
          console.log("[HotKey] -> 🐾 Pet Robot");
          server.robot.triggerTouchGesture("PETTING_RAPID");
        } else if (key.toLowerCase() === "v") {
          console.log("[HotKey] -> 🎙️ Injected Voice Sample");
          server.robot.injectSyntheticVoiceUplink();
        }
      });
    } catch {
      // Non-interactive terminal fallback
    }
  }

  // Graceful shutdown on SIGINT/SIGTERM
  const handleExit = async () => {
    console.log("\n[Emulator] Shutting down...");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", handleExit);
  process.on("SIGTERM", handleExit);
}

main().catch((err) => {
  console.error("Fatal error starting emulator:", err);
  process.exit(1);
});
