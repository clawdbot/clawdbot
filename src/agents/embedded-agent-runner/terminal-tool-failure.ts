/** Projects a safe Code Mode catalog miss into terminal metadata for operator diagnostics. */
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "../code-mode-control-tools.js";
import type { ToolErrorSummary } from "../tool-error-summary.js";
import { normalizeToolName } from "../tool-policy.js";
import type { EmbeddedRunTerminalToolFailure } from "./types.js";

// Only persist the catalog-miss form emitted by the Code Mode bridge. Tool
// error text otherwise can contain command output, private paths, or values
// that known-secret redaction cannot establish as safe for durable history.
const SAFE_MCP_CATALOG_MISS = /^Unknown tool id: (MCP\.[A-Za-z0-9][A-Za-z0-9._-]*)$/;

/**
 * Preserves one strictly allowlisted Code Mode catalog-miss fact for cron
 * history. All other tool errors stay on the existing generic presentation
 * path.
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
  const match =
    typeof failure.error === "string" ? SAFE_MCP_CATALOG_MISS.exec(failure.error) : null;
  if (!match) {
    return undefined;
  }
  return {
    source: "tool",
    toolName: normalizedToolName,
    code: "UNKNOWN_TOOL_ID",
    message: `Unknown tool id: ${match[1]}`,
  };
}
