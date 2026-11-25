import { pathToFileURL } from "node:url";
import { DesktopHarnessDaemon, type DaemonOptions } from "./daemon.js";

export * from "./security/crypto-vault.js";
export * from "./transport/harness-server.js";
export * from "./telemetry/system-telemetry.js";
export * from "./os/index.js";
export * from "./sandbox/index.js";
export * from "./workflows/index.js";
export * from "./integrations/oss-loader.js";
export * from "./partner/headless-tool-bus.js";
export * from "./partner/robot-live-hud-bridge.js";
export * from "./partner/autonomous-partner-agent.js";
export * from "./automations/index.js";
export * from "./harness.js";
export * from "./daemon.js";

/**
 * Factory helper to spin up an isolated, configured Desktop Harness instance.
 * Ideal for unit, integration, and CI tests running on ephemeral ports.
 */
export async function createDesktopHarnessInstance(
  config?: DaemonOptions
): Promise<DesktopHarnessDaemon> {
  const daemon = new DesktopHarnessDaemon(config);
  await daemon.start();
  return daemon;
}

// Auto-run daemon if launched directly via CLI / tsx
const isDirectEntry =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (pathToFileURL(process.argv[1]).href === import.meta.url ||
    process.argv[1].endsWith("index.ts") ||
    process.argv[1].endsWith("index.js"));

if (isDirectEntry) {
  const args = process.argv.slice(2);
  let port = process.env["HARNESS_PORT"]
    ? parseInt(process.env["HARNESS_PORT"], 10)
    : process.env["PORT"]
      ? parseInt(process.env["PORT"], 10)
      : undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1]!, 10);
      i++;
    }
  }

  const daemon = new DesktopHarnessDaemon({
    ...(port ? { port } : {}),
    allowPairingMode: true,
  });

  daemon
    .start()
    .then(() => {
      console.log("[DesktopHarness] Daemon running. Press Ctrl+C to terminate.");
    })
    .catch((err) => {
      console.error("[DesktopHarness] Fatal error starting daemon:", err);
      process.exit(1);
    });

  const shutdown = async () => {
    console.log("\n[DesktopHarness] Shutting down cleanly...");
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
