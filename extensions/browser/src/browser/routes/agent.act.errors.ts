/**
 * Shared browser action error codes and messages.
 *
 * Keeps route responses stable for browser-tool callers that branch on `code`
 * rather than parsing human-readable errors.
 */
import type { BrowserResponse } from "./types.js";

/** Stable machine-readable codes returned by browser action routes. */
export const ACT_ERROR_CODES = {
  kindRequired: "ACT_KIND_REQUIRED",
  invalidRequest: "ACT_INVALID_REQUEST",
  selectorUnsupported: "ACT_SELECTOR_UNSUPPORTED",
  evaluateDisabled: "ACT_EVALUATE_DISABLED",
  unsupportedForExistingSession: "ACT_EXISTING_SESSION_UNSUPPORTED",
  targetIdMismatch: "ACT_TARGET_ID_MISMATCH",
} as const;

type ActErrorCode = (typeof ACT_ERROR_CODES)[keyof typeof ACT_ERROR_CODES];

/** Send a browser action JSON error with a stable action error code. */
export function jsonActError(
  res: BrowserResponse,
  status: number,
  code: ActErrorCode,
  message: string,
) {
  res.status(status).json({ error: message, code });
}

/** Build the config-disabled message for JavaScript evaluation actions. */
export function browserEvaluateDisabledMessage(action: "wait" | "evaluate"): string {
  return [
    action === "wait"
      ? "wait --fn is disabled by config (browser.evaluateEnabled=false)."
      : "act:evaluate is disabled by config (browser.evaluateEnabled=false).",
    "Docs: /gateway/configuration#browser-openclaw-managed-browser",
  ].join("\n");
}
