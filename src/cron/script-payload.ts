import type { CronPayload } from "./types.js";

export const DEFAULT_CRON_SCRIPT_TIMEOUT_SECONDS = 300;
export const MAX_CRON_SCRIPT_TIMEOUT_SECONDS = 900;
export const DEFAULT_CRON_SCRIPT_TOOL_BUDGET = 50;
export const MAX_CRON_SCRIPT_TOOL_BUDGET = 200;

function clampPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

/** Applies the persisted defaults and hard caps for unattended script payloads. */
export function normalizeCronScriptPayload(
  payload: Extract<CronPayload, { kind: "script" }>,
): Extract<CronPayload, { kind: "script" }> {
  return {
    ...payload,
    script: payload.script.trim(),
    timeoutSeconds: clampPositiveInteger(
      payload.timeoutSeconds,
      DEFAULT_CRON_SCRIPT_TIMEOUT_SECONDS,
      MAX_CRON_SCRIPT_TIMEOUT_SECONDS,
    ),
    toolBudget: clampPositiveInteger(
      payload.toolBudget,
      DEFAULT_CRON_SCRIPT_TOOL_BUDGET,
      MAX_CRON_SCRIPT_TOOL_BUDGET,
    ),
  };
}
