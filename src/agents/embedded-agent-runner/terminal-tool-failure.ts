/** Projects a bounded tool failure into terminal metadata for operator diagnostics. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { redactSensitiveText } from "../../logging/redact.js";
import { truncateUtf16Safe } from "../../utils.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "../code-mode-control-tools.js";
import type { ToolErrorSummary } from "../tool-error-summary.js";
import { normalizeToolName } from "../tool-policy.js";
import type { EmbeddedRunTerminalToolFailure } from "./types.js";

const MAX_TERMINAL_TOOL_FAILURE_CHARS = 500;

/**
 * Preserves the already-sanitized outer Code Mode failure for cron history.
 * Ordinary exec stderr stays on the existing generic presentation path.
 */
export function resolveEmbeddedRunTerminalToolFailure(params: {
  trigger?: string | undefined;
  codeModeEngaged?: boolean | undefined;
  lastToolError?: ToolErrorSummary | undefined;
}): EmbeddedRunTerminalToolFailure | undefined {
  const failure = params.lastToolError;
  const normalizedToolName = normalizeToolName(failure?.toolName ?? "");
  if (
    params.trigger !== "cron" ||
    params.codeModeEngaged !== true ||
    !failure ||
    (normalizedToolName !== CODE_MODE_EXEC_TOOL_NAME &&
      normalizedToolName !== CODE_MODE_WAIT_TOOL_NAME)
  ) {
    return undefined;
  }
  if (failure.errorCode === "SYSTEM_RUN_DENIED" || failure.errorCode === "INVALID_REQUEST") {
    return undefined;
  }
  const rawMessage = normalizeOptionalString(failure.error);
  if (!rawMessage) {
    return undefined;
  }
  const singleLineMessage = redactSensitiveText(rawMessage, { mode: "tools" }).replace(/\s+/g, " ");
  const message =
    singleLineMessage.length > MAX_TERMINAL_TOOL_FAILURE_CHARS
      ? `${truncateUtf16Safe(singleLineMessage, MAX_TERMINAL_TOOL_FAILURE_CHARS)}…`
      : singleLineMessage;
  return {
    source: "tool",
    toolName: normalizedToolName,
    ...(failure.errorCode ? { code: failure.errorCode } : {}),
    message,
  };
}
