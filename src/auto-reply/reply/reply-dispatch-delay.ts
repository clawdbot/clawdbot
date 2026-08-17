import type { HumanDelayConfig } from "../../config/types.js";
import { generateSecureInt } from "../../infra/secure-random.js";

const DEFAULT_HUMAN_DELAY_MIN_MS = 800;
const DEFAULT_HUMAN_DELAY_MAX_MS = 2500;

function resolveHumanDelayRange(config: HumanDelayConfig | undefined) {
  const mode = config?.mode ?? "off";
  if (mode === "off") {
    return undefined;
  }
  return {
    min:
      mode === "custom"
        ? (config?.minMs ?? DEFAULT_HUMAN_DELAY_MIN_MS)
        : DEFAULT_HUMAN_DELAY_MIN_MS,
    max:
      mode === "custom"
        ? (config?.maxMs ?? DEFAULT_HUMAN_DELAY_MAX_MS)
        : DEFAULT_HUMAN_DELAY_MAX_MS,
  };
}

/** Generate a random delay within the configured range. */
export function getHumanDelay(config: HumanDelayConfig | undefined): number {
  const range = resolveHumanDelayRange(config);
  if (!range || range.max <= range.min) {
    return range?.min ?? 0;
  }
  return range.min + generateSecureInt(range.max - range.min + 1);
}

export function getHumanDelayMax(config: HumanDelayConfig | undefined): number {
  const range = resolveHumanDelayRange(config);
  return range ? Math.max(range.min, range.max) : 0;
}
