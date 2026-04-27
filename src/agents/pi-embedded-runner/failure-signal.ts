import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { isExecLikeToolName, type ToolErrorSummary } from "../tool-error-summary.js";
import type { EmbeddedRunFailureSignal } from "./types.js";

const FAILURE_SIGNAL_CODES = ["SYSTEM_RUN_DENIED", "INVALID_REQUEST"] as const;

function resolveFailureSignalCode(message: string): EmbeddedRunFailureSignal["code"] | undefined {
  for (const code of FAILURE_SIGNAL_CODES) {
    if (message.includes(code)) {
      return code;
    }
  }
  if (message.toLowerCase().includes("approval cannot safely bind")) {
    return "SYSTEM_RUN_DENIED";
  }
  return undefined;
}

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
  const message = normalizeOptionalString(lastToolError.error);
  if (!message) {
    return undefined;
  }
  const code = resolveFailureSignalCode(message);
  if (!code) {
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
