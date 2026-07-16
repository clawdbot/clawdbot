import type { BrowserResponse } from "./types.js";

export const ACT_ERROR_CODES = {
  kindRequired: "ACT_KIND_REQUIRED",
  invalidRequest: "ACT_INVALID_REQUEST",
  selectorUnsupported: "ACT_SELECTOR_UNSUPPORTED",
  evaluateDisabled: "ACT_EVALUATE_DISABLED",
  unsupportedForExistingSession: "ACT_EXISTING_SESSION_UNSUPPORTED",
  targetIdMismatch: "ACT_TARGET_ID_MISMATCH",
} as const;

export type ActErrorCode = (typeof ACT_ERROR_CODES)[keyof typeof ACT_ERROR_CODES];

export function jsonActError(
  res: BrowserResponse,
  status: number,
  code: ActErrorCode,
  message: string,
) {
  res.status(status).json({ error: message, code });
}

export function browserEvaluateDisabledMessage(action: "wait" | "evaluate"): string {
  return [
    action === "wait"
      ? "wait --fn is disabled by config (browser.evaluateEnabled=false)."
      : "act:evaluate is disabled by config (browser.evaluateEnabled=false).",
    "Docs: /gateway/configuration#browser-openclaw-managed-browser",
  ].join("\n");
}
