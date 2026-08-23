// Voice Call plugin module implements call status behavior.
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { EndReason } from "../../types.js";

// Shared provider status normalization and terminal-state mapping.

const TERMINAL_PROVIDER_STATUS_TO_END_REASON: Record<string, EndReason> = {
  completed: "completed",
  failed: "failed",
  busy: "busy",
  "no-answer": "no-answer",
  canceled: "hangup-bot",
};

/** Normalize provider status text, falling back to "unknown". */
export function normalizeProviderStatus(status: string | null | undefined): string {
  const normalized = normalizeOptionalLowercaseString(status);
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

/** Map terminal provider status strings to OpenClaw end reasons. */
export function mapProviderStatusToEndReason(status: string | null | undefined): EndReason | null {
  const normalized = normalizeProviderStatus(status);
  return TERMINAL_PROVIDER_STATUS_TO_END_REASON[normalized] ?? null;
}

/** Return true when a provider status is terminal. */
export function isProviderStatusTerminal(status: string | null | undefined): boolean {
  return mapProviderStatusToEndReason(status) !== null;
}
