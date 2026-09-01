import { BROWSER_ACT_ERROR_CODES, type BrowserActErrorCode } from "../errors.js";
/**
 * Shared browser action error codes and messages.
 *
 * Keeps route responses stable for browser-tool callers that branch on `code`
 * rather than parsing human-readable errors.
 */
import type { BrowserResponse } from "./types.js";

export const ACT_ERROR_CODES = BROWSER_ACT_ERROR_CODES;

/** Send a browser action JSON error with a stable action error code. */
export function jsonActError(
  res: BrowserResponse,
  status: number,
  code: BrowserActErrorCode,
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
