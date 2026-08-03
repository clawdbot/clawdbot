/**
 * Browser action limits and timeout normalization.
 *
 * Shared by the tool schema and runtime action handlers so model-facing limits
 * and browser-control enforcement stay aligned.
 */
import {
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
  MAX_TIMER_TIMEOUT_MS,
  parseStrictInteger,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { BrowserActRequest } from "./client-actions.types.js";
import { DEFAULT_BROWSER_ACTION_TIMEOUT_MS } from "./constants.js";

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

/** Grace between the runtime's action budget and an outer transport watchdog. */
export const BROWSER_ACTION_TRANSPORT_SLACK_MS = 5_000;
/** Post-action window that keeps navigation policy interception active. */
export const BROWSER_ACTION_NAVIGATION_GRACE_MS = 250;

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

function parseTimerInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : parseStrictInteger(value);
}

function resolveNonNegativeTimerMs(value: unknown): number {
  const parsed = parseTimerInteger(value);
  return parsed !== undefined && parsed >= 0 ? resolveTimerTimeoutMs(parsed, 0, 0) : 0;
}

function addExecutionBudgetMs(totalMs: number, nextMs: number): number {
  return Math.min(MAX_TIMER_TIMEOUT_MS, totalMs + nextMs);
}

function multiplyExecutionBudgetMs(durationMs: number, count: number): number {
  return Math.min(MAX_TIMER_TIMEOUT_MS, durationMs * count);
}

function resolveInteractionTimeoutMs(request: BrowserActRequest): number {
  return resolveActInteractionTimeoutMs(
    parseTimerInteger("timeoutMs" in request ? request.timeoutMs : undefined),
  );
}

function addNavigationGraceMs(durationMs: number, count = 1): number {
  return addExecutionBudgetMs(
    durationMs,
    multiplyExecutionBudgetMs(BROWSER_ACTION_NAVIGATION_GRACE_MS, count),
  );
}

function isActionObject(value: unknown): value is BrowserActRequest {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveLeafExecutionBudgetMs(
  request: Exclude<BrowserActRequest, { kind: "batch" | "wait" }>,
): number {
  switch (request.kind) {
    case "click": {
      const timeoutMs = resolveInteractionTimeoutMs(request);
      const delayMs = Math.min(ACT_MAX_CLICK_DELAY_MS, resolveNonNegativeTimerMs(request.delayMs));
      const actionMs = delayMs > 0 ? addExecutionBudgetMs(timeoutMs * 2, delayMs) : timeoutMs;
      return addNavigationGraceMs(actionMs);
    }
    case "clickCoords": {
      const delayMs = Math.min(ACT_MAX_CLICK_DELAY_MS, resolveNonNegativeTimerMs(request.delayMs));
      const explicitTimeoutMs =
        clampPositiveTimerTimeoutMs(parseTimerInteger(request.timeoutMs)) ?? 0;
      return addNavigationGraceMs(
        addExecutionBudgetMs(
          explicitTimeoutMs,
          multiplyExecutionBudgetMs(delayMs, request.doubleClick ? 3 : 1),
        ),
      );
    }
    case "type": {
      const phaseCount = (request.slowly ? 2 : 1) + (request.submit ? 1 : 0);
      return addNavigationGraceMs(
        multiplyExecutionBudgetMs(resolveInteractionTimeoutMs(request), phaseCount),
      );
    }
    case "press":
      return addNavigationGraceMs(resolveNonNegativeTimerMs(request.delayMs));
    case "fill": {
      const fields = Array.isArray(request.fields) ? request.fields : [];
      const fieldCount = fields.filter(
        (field) =>
          Boolean(field) &&
          typeof field === "object" &&
          typeof field.ref === "string" &&
          Boolean(field.ref.trim()),
      ).length;
      return addNavigationGraceMs(
        multiplyExecutionBudgetMs(resolveInteractionTimeoutMs(request), fieldCount),
        fieldCount,
      );
    }
    case "evaluate":
      return addNavigationGraceMs(resolveActWaitTimeoutMs(parseTimerInteger(request.timeoutMs)));
    case "scrollIntoView":
      return addNavigationGraceMs(resolveActWaitTimeoutMs(parseTimerInteger(request.timeoutMs)));
    case "hover":
    case "drag":
    case "select":
      return addNavigationGraceMs(resolveInteractionTimeoutMs(request));
    case "resize":
    case "close":
      return 0;
  }
  return 0;
}

function resolveExecutionBudgetMs(request: BrowserActRequest): number {
  if (request.kind === "batch") {
    // Model-facing schemas keep child actions permissive for provider compatibility.
    // Budget valid entries only; the browser route remains the validation owner.
    const actions = Array.isArray(request.actions) ? request.actions.filter(isActionObject) : [];
    return actions.reduce(
      (totalMs, action) => addExecutionBudgetMs(totalMs, resolveExecutionBudgetMs(action)),
      0,
    );
  }
  if (request.kind !== "wait") {
    return resolveLeafExecutionBudgetMs(request);
  }
  // Text locators accept whitespace as content; selector, URL, and function
  // waits normalize it away. Keep this in lockstep with waitForViaPlaywright.
  const conditionCount = [
    Boolean(request.text),
    Boolean(request.textGone),
    typeof request.selector === "string" && Boolean(request.selector.trim()),
    typeof request.url === "string" && Boolean(request.url.trim()),
    Boolean(request.loadState),
    typeof request.fn === "string" && Boolean(request.fn.trim()),
  ].filter(Boolean).length;
  const timeoutMs = resolveActWaitTimeoutMs(parseTimerInteger(request.timeoutMs));
  return addExecutionBudgetMs(
    resolveNonNegativeTimerMs(request.timeMs),
    multiplyExecutionBudgetMs(timeoutMs, conditionCount),
  );
}

/**
 * Resolve the runtime budget before an outer transport watchdog is armed.
 * Wait phases and batch children execute serially, so maxima would abort valid work midway.
 */
export function resolveBrowserActExecutionBudgetMs(request: BrowserActRequest): number {
  const executionBudgetMs = resolveExecutionBudgetMs(request);
  if (request.kind === "wait") {
    return executionBudgetMs;
  }
  const explicitTimeoutMs =
    request.kind === "batch"
      ? undefined
      : clampPositiveTimerTimeoutMs(
          parseTimerInteger("timeoutMs" in request ? request.timeoutMs : undefined),
        );
  return explicitTimeoutMs === undefined
    ? Math.max(DEFAULT_BROWSER_ACTION_TIMEOUT_MS, executionBudgetMs)
    : executionBudgetMs;
}

/** Add action transport slack once after the full sequential runtime budget is known. */
export function resolveBrowserActRequestTimeoutMs(request: BrowserActRequest): number {
  return (
    addTimerTimeoutGraceMs(
      resolveBrowserActExecutionBudgetMs(request),
      BROWSER_ACTION_TRANSPORT_SLACK_MS,
    ) ?? 1
  );
}
