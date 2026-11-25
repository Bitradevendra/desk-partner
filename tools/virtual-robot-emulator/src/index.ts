import { VirtualEsp32S3Robot } from "./virtual-hardware.js";

export * from "./virtual-hardware.js";
export * from "./emulator-server.js";
export * from "./ota-packager.js";

// Backward-compatible alias for existing tests and consumers
export { VirtualEsp32S3Robot as VirtualRobotEmulator };
export default VirtualEsp32S3Robot;
