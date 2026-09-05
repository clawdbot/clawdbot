import type { HumanDelayConfig } from "../../config/types.js";
import { generateSecureInt } from "../../infra/secure-random.js";

const DEFAULT_RANGE = { min: 800, max: 2500 };

function resolveHumanDelayRange(config: HumanDelayConfig | undefined) {
  if (!config?.mode || config.mode === "off") {
    return undefined;
  }
  return config.mode === "custom"
    ? { min: config.minMs ?? DEFAULT_RANGE.min, max: config.maxMs ?? DEFAULT_RANGE.max }
    : DEFAULT_RANGE;
}

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
