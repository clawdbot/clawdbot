import { randomUUID } from "node:crypto";

import type { MoltbotConfig } from "../config/config.js";
import type { BackoffPolicy } from "../infra/backoff.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";

export type ReconnectPolicy = BackoffPolicy & {
  maxAttempts: number;
};

export const DEFAULT_HEARTBEAT_SECONDS = 60;
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 12,
};

const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));

export function resolveHeartbeatSeconds(cfg: MoltbotConfig, overrideSeconds?: number): number {
  const candidate = overrideSeconds ?? cfg.web?.heartbeatSeconds;
  if (typeof candidate === "number" && candidate > 0) return candidate;
  return DEFAULT_HEARTBEAT_SECONDS;
}

export function resolveReconnectPolicy(
  cfg: MoltbotConfig,
  overrides?: Partial<ReconnectPolicy>,
): ReconnectPolicy {
  const reconnectOverrides = cfg.web?.reconnect ?? {};
  const overrideConfig = overrides ?? {};
  const merged = {
    ...DEFAULT_RECONNECT_POLICY,
    ...reconnectOverrides,
    ...overrideConfig,
  } as ReconnectPolicy;

  merged.initialMs = Math.max(250, merged.initialMs);
  merged.maxMs = Math.max(merged.initialMs, merged.maxMs);
  merged.factor = clamp(merged.factor, 1.1, 10);
  merged.jitter = clamp(merged.jitter, 0, 1);
  merged.maxAttempts = Math.max(0, Math.floor(merged.maxAttempts));
  return merged;
}

export { computeBackoff, sleepWithAbort };

export function newConnectionId() {
  return randomUUID();
}
