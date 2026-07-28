import type { OpenClawConfig } from "../../config/types.openclaw.js";

// Reply completeness is process-local metadata. Keep it off config objects so
// frozen runtime snapshots and identity-keyed caches remain valid.
const replyConfigRuntimeModes = new WeakMap<OpenClawConfig, "fast" | "full">();

export function markReplyConfigRuntimeMode<T extends OpenClawConfig>(
  config: T,
  runtimeMode: "fast" | "full",
): T {
  replyConfigRuntimeModes.set(config, runtimeMode);
  return config;
}

export function isCompleteReplyConfig(config: unknown): config is OpenClawConfig {
  return Boolean(
    config && typeof config === "object" && replyConfigRuntimeModes.has(config as OpenClawConfig),
  );
}

export function usesFullReplyRuntime(config: unknown): boolean {
  return Boolean(
    config &&
    typeof config === "object" &&
    replyConfigRuntimeModes.get(config as OpenClawConfig) === "full",
  );
}
