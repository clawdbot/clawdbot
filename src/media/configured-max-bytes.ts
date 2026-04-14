import type { OpenClawConfig } from "../config/types.openclaw.js";

const MB = 1024 * 1024;

export function resolveConfiguredMediaMaxBytes(cfg?: OpenClawConfig): number | undefined {
  const configured = cfg?.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * MB);
  }
  return undefined;
}
