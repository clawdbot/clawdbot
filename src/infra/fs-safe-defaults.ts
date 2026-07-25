// Applies OpenClaw's default fs-safe runtime configuration.
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

// OpenClaw does not rely on native helpers for normal filesystem safety. Tests
// and operators can still opt in with fs-safe's documented env override.
const hasModeOverride = [
  "FS_SAFE_NATIVE_MODE",
  "OPENCLAW_FS_SAFE_NATIVE_MODE",
  "FS_SAFE_PYTHON_MODE",
  "OPENCLAW_FS_SAFE_PYTHON_MODE",
  "FS_SAFE_PYTHON",
  "OPENCLAW_FS_SAFE_PYTHON",
  "OPENCLAW_PINNED_PYTHON",
  "OPENCLAW_PINNED_WRITE_PYTHON",
].some((key) => process.env[key] != null);

if (!hasModeOverride) {
  configureFsSafeNative({ mode: "off" });
}
