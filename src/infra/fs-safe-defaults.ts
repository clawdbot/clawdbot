// Applies OpenClaw's default fs-safe runtime configuration.
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

// OpenClaw does not rely on native helpers for normal filesystem safety. Tests
// and operators can still opt in with fs-safe's documented env override.
const hasNativeModeOverride =
  process.env.FS_SAFE_NATIVE_MODE != null || process.env.OPENCLAW_FS_SAFE_NATIVE_MODE != null;

if (!hasNativeModeOverride) {
  configureFsSafeNative({ mode: "off" });
}
