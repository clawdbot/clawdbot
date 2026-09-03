/**
 * Agent run timeout resolver.
 *
 * Converts config and per-run overrides into timer-safe millisecond deadlines.
 */
import {
  clampTimerTimeoutMs,
  MAX_TIMER_TIMEOUT_MS,
  resolveOptionalIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 48 * 60 * 60;
export const DEFAULT_AGENT_TIMEOUT_MS = DEFAULT_AGENT_TIMEOUT_SECONDS * 1000;
const NO_TIMEOUT_MS = MAX_TIMER_TIMEOUT_MS;

export function resolveAgentTimeoutMs(opts: {
  cfg?: OpenClawConfig;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
}): number {
  const minMs = Math.max(resolveOptionalIntegerOption(opts.minMs) ?? 1, 1);
  const clampTimeoutMs = (valueMs: number) => clampTimerTimeoutMs(valueMs, minMs) ?? minMs;
  const seconds =
    resolveOptionalIntegerOption(opts.cfg?.agents?.defaults?.timeoutSeconds) ??
    DEFAULT_AGENT_TIMEOUT_SECONDS;
  // Config and per-run zero share the exact timer-safe unlimited sentinel.
  const defaultMs = seconds === 0 ? NO_TIMEOUT_MS : clampTimeoutMs(Math.max(seconds, 1) * 1000);
  const overrideMs = resolveOptionalIntegerOption(opts.overrideMs);
  if (overrideMs !== undefined) {
    if (overrideMs === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideMs < 0) {
      return defaultMs;
    }
    return clampTimeoutMs(overrideMs);
  }
  const overrideSeconds = resolveOptionalIntegerOption(opts.overrideSeconds);
  if (overrideSeconds !== undefined) {
    if (overrideSeconds === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideSeconds < 0) {
      return defaultMs;
    }
    return clampTimeoutMs(overrideSeconds * 1000);
  }
  return defaultMs;
}
