/**
 * Converts embedded run failures into provider failover signals.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isExecLikeToolName, type ToolErrorSummary } from "../tool-error-summary.js";
import type { EmbeddedRunFailureSignal } from "./types.js";

/**
 * Converts terminal tool errors from unattended embedded runs into failure signals.
 *
 * Cron runs need fatal execution-denied signals so schedulers do not treat blocked shell access as
 * a normal silent completion.
 *
 * Opaque denylist hard-denies (`denylist_unanalyzable`, typically trailing `2>&1` / pipes) are
 * recoverable model mistakes under yolo mode — the agent can retry an analyzable form. Do not mark
 * those fatal for cron or a later successful digest/heartbeat announce is replaced by the first
 * denied command string.
 */
const FAILURE_SIGNAL_CODES = ["SYSTEM_RUN_DENIED", "INVALID_REQUEST"] as const;

function resolveFailureSignalCode(
  value: string | undefined,
): EmbeddedRunFailureSignal["code"] | undefined {
  for (const code of FAILURE_SIGNAL_CODES) {
    if (value === code) {
      return code;
    }
  }
  return undefined;
}

/** True when the denial is an opaque-shell denylist hard-deny the model can self-correct. */
export function isRecoverableOpaqueDenylistDenial(error: string | undefined): boolean {
  const normalized = normalizeOptionalString(error)?.toLowerCase() ?? "";
  return (
    normalized.includes("could not be analyzed for denylist") ||
    normalized.includes("denylist screening") ||
    normalized.includes("denylist_unanalyzable") ||
    normalized.includes("denylist-unanalyzable")
  );
}

/** Resolves fatal cron failure metadata from the last exec-like tool error, if applicable. */
export function resolveEmbeddedRunFailureSignal(params: {
  trigger?: string | undefined;
  lastToolError?: ToolErrorSummary | undefined;
}): EmbeddedRunFailureSignal | undefined {
  if (params.trigger !== "cron") {
    return undefined;
  }
  const lastToolError = params.lastToolError;
  if (!lastToolError || !isExecLikeToolName(lastToolError.toolName)) {
    return undefined;
  }
  const code = resolveFailureSignalCode(normalizeOptionalString(lastToolError.errorCode));
  if (!code) {
    return undefined;
  }
  const message = normalizeOptionalString(lastToolError.error) ?? code;
  // Opaque denylist refusals are retryable; approval-required / real STOP hits stay fatal.
  if (code === "SYSTEM_RUN_DENIED" && isRecoverableOpaqueDenylistDenial(message)) {
    return undefined;
  }
  return {
    kind: "execution_denied",
    source: "tool",
    ...(lastToolError.toolName ? { toolName: lastToolError.toolName } : {}),
    code,
    message,
    fatalForCron: true,
  };
}
