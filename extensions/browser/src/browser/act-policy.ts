export const ACT_MAX_BATCH_ACTIONS = 100;
export const ACT_MAX_BATCH_DEPTH = 5;
export const ACT_MAX_CLICK_DELAY_MS = 5_000;
export const ACT_MAX_WAIT_TIME_MS = 30_000;

const ACT_MIN_TIMEOUT_MS = 500;
const ACT_MAX_INTERACTION_TIMEOUT_MS = 60_000;
const ACT_MAX_WAIT_TIMEOUT_MS = 120_000;
const ACT_DEFAULT_INTERACTION_TIMEOUT_MS = 8_000;
const ACT_DEFAULT_WAIT_TIMEOUT_MS = 20_000;

export function normalizeActBoundedNonNegativeMs(
  value: number | undefined,
  fieldName: string,
  maxMs: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be >= 0`);
  }
  const normalized = Math.floor(value);
  if (normalized > maxMs) {
    throw new Error(`${fieldName} exceeds maximum of ${maxMs}ms`);
  }
  return normalized;
}

export function resolveActInteractionTimeoutMs(timeoutMs?: number): number {
  const normalized =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.floor(timeoutMs)
      : ACT_DEFAULT_INTERACTION_TIMEOUT_MS;
  return Math.max(ACT_MIN_TIMEOUT_MS, Math.min(ACT_MAX_INTERACTION_TIMEOUT_MS, normalized));
}

export function resolveActWaitTimeoutMs(timeoutMs?: number): number {
  const normalized =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.floor(timeoutMs)
      : ACT_DEFAULT_WAIT_TIMEOUT_MS;
  return Math.max(ACT_MIN_TIMEOUT_MS, Math.min(ACT_MAX_WAIT_TIMEOUT_MS, normalized));
}
