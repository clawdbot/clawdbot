/**
 * Shared validation and normalization helpers for Playwright-backed browser
 * tool implementations.
 */
import { parseFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatErrorMessage } from "../infra/errors.js";
import { parseRoleRef } from "./pw-role-snapshot.js";

let nextUploadArmId = 0;
let nextDownloadArmId = 0;

/** Returns a new monotonic id for the currently armed file upload waiter. */
export function bumpUploadArmId(): number {
  nextUploadArmId += 1;
  return nextUploadArmId;
}

/** Returns a new monotonic id for the currently armed download waiter. */
export function bumpDownloadArmId(): number {
  nextDownloadArmId += 1;
  return nextDownloadArmId;
}

/** Normalizes role refs and raw element refs into the locator id format. */
export function requireRef(value: unknown): string {
  const raw = normalizeOptionalString(value) ?? "";
  const roleRef = raw ? parseRoleRef(raw) : null;
  const ref = roleRef ?? (raw.startsWith("@") ? raw.slice(1) : raw);
  if (!ref) {
    throw new Error("ref is required");
  }
  return ref;
}

/** Requires either a role ref or CSS selector and returns the trimmed selector mode. */
export function requireRefOrSelector(
  ref: string | undefined,
  selector: string | undefined,
): { ref?: string; selector?: string } {
  const trimmedRef = normalizeOptionalString(ref) ?? "";
  const trimmedSelector = normalizeOptionalString(selector) ?? "";
  if (!trimmedRef && !trimmedSelector) {
    throw new Error("ref or selector is required");
  }
  return {
    ref: trimmedRef || undefined,
    selector: trimmedSelector || undefined,
  };
}

/** Bounds user-facing timeout options to Playwright-safe limits. */
export function normalizeTimeoutMs(timeoutMs: number | undefined, fallback: number): number {
  const parsed = parseFiniteNumber(timeoutMs);
  return Math.max(500, Math.min(120_000, Math.floor(parsed ?? fallback)));
}

/** Converts common Playwright locator failures into model-actionable messages. */
export function toAIFriendlyError(error: unknown, selector: string): Error {
  const message = formatErrorMessage(error);

  if (message.includes("strict mode violation")) {
    const countMatch = message.match(/resolved to (\d+) elements/);
    const count = countMatch ? countMatch[1] : "multiple";
    return new Error(
      `Selector "${selector}" matched ${count} elements. ` +
        `Run a new snapshot to get updated refs, or use a different ref.`,
    );
  }

  if (
    (message.includes("Timeout") || message.includes("waiting for")) &&
    (message.includes("to be visible") ||
      message.includes("not visible") ||
      message.includes("waiting for locator("))
  ) {
    return new Error(
      `Element "${selector}" not found or not visible. ` +
        `Run a new snapshot to see current page elements.`,
    );
  }

  if (
    message.includes("intercepts pointer events") ||
    message.includes("not visible") ||
    message.includes("not receive pointer events")
  ) {
    return new Error(
      `Element "${selector}" is not interactable (hidden or covered). ` +
        `Try scrolling it into view, closing overlays, or re-snapshotting.`,
    );
  }

  return error instanceof Error ? error : new Error(message);
}
