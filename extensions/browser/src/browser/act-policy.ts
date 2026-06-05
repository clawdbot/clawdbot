/**
 * Browser action limits and timeout normalization.
 *
 * Shared by the tool schema and runtime action handlers so model-facing limits
 * and browser-control enforcement stay aligned.
 */
/** Maximum number of actions accepted in a batched browser action request. */
export const ACT_MAX_BATCH_ACTIONS = 100;
/** Maximum nested action depth accepted by recursive browser actions. */
export const ACT_MAX_BATCH_DEPTH = 5;
/** Maximum click delay accepted from model/tool input. */
export const ACT_MAX_CLICK_DELAY_MS = 5_000;
/** Maximum explicit wait duration accepted from model/tool input. */
export const ACT_MAX_WAIT_TIME_MS = 30_000;
/** Maximum viewport side length accepted by resize actions. */
export const ACT_MAX_VIEWPORT_DIMENSION = 8192;

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

/** Clamp interaction actions to the supported browser-control timeout window. */
export function resolveActInteractionTimeoutMs(timeoutMs?: number): number {
  const normalized =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.floor(timeoutMs)
      : ACT_DEFAULT_INTERACTION_TIMEOUT_MS;
  return Math.max(ACT_MIN_TIMEOUT_MS, Math.min(ACT_MAX_INTERACTION_TIMEOUT_MS, normalized));
}

/** Clamp wait actions to their wider supported browser-control timeout window. */
export function resolveActWaitTimeoutMs(timeoutMs?: number): number {
  const normalized =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.floor(timeoutMs)
      : ACT_DEFAULT_WAIT_TIMEOUT_MS;
  return Math.max(ACT_MIN_TIMEOUT_MS, Math.min(ACT_MAX_WAIT_TIMEOUT_MS, normalized));
}
