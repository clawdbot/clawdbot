import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { markReplyConfigRuntimeMode } from "./reply-config-runtime-mode.js";

export function markCompleteReplyConfig<T extends OpenClawConfig>(
  config: T,
  options?: { runtimeMode?: "fast" | "full" },
): T {
  return markReplyConfigRuntimeMode(config, options?.runtimeMode ?? "fast");
}

export function withFastReplyConfig<T extends OpenClawConfig>(config: T): T {
  return markCompleteReplyConfig(config);
}
