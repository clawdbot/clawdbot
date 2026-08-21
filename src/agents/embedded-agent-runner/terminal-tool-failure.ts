import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
/** Projects a safe Code Mode catalog miss into terminal metadata for operator diagnostics. */
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "../code-mode-control-tools.js";
import type { ToolErrorSummary } from "../tool-error-summary.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import type { EmbeddedRunTerminalToolFailure } from "./types.js";

// Only persist the catalog-miss form emitted by the Code Mode bridge. Tool
// error text otherwise can contain command output, private paths, or values
// that known-secret redaction cannot establish as safe for durable history.
// The bridge surfaces the miss to exec/wait as a thrown error, so the recorded
// text is `Error: <formatter line>` plus a controller stack frame; recovery
// phrasing is `tools.*` from the exec bridge and `openclaw.tools.*` from the
// gated tool-search surface. Match the exact formatter line on the first line.
const SAFE_MCP_CATALOG_MISS =
  /^(?:Error: )?Unknown tool id: MCP\.[A-Za-z0-9][A-Za-z0-9._-]*\. (?:Did you mean: [^\r\n]+\? )?Use (?:openclaw\.tools\.search to find a tool, openclaw\.tools\.describe to inspect it, then openclaw\.tools\.call|tools\.search to find a tool, tools\.describe to inspect it, then tools\.call) with the exact id or name\.$/;
export const CODE_MODE_MCP_CATALOG_MISS_MESSAGE =
  "Code Mode could not resolve a configured MCP tool.";

/** Validates the only terminal tool failure fact safe to persist in cron history. */
export function isEmbeddedRunTerminalToolFailure(
  value: unknown,
): value is EmbeddedRunTerminalToolFailure {
  const failure = asOptionalObjectRecord(value);
  return (
    failure?.source === "tool" &&
    (failure.toolName === CODE_MODE_EXEC_TOOL_NAME ||
      failure.toolName === CODE_MODE_WAIT_TOOL_NAME) &&
    failure.code === "UNKNOWN_TOOL_ID"
  );
}

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
  const normalizedToolName = normalizeToolPolicyName(failure?.toolName ?? "");
  if (
    params.trigger !== "cron" ||
    params.codeModeEngaged !== true ||
    !failure ||
    (normalizedToolName !== CODE_MODE_EXEC_TOOL_NAME &&
      normalizedToolName !== CODE_MODE_WAIT_TOOL_NAME)
  ) {
    return undefined;
  }
  const failureFirstLine =
    typeof failure.error === "string" ? failure.error.split(/\r?\n/, 1)[0] : undefined;
  const match = failureFirstLine ? SAFE_MCP_CATALOG_MISS.exec(failureFirstLine) : null;
  if (!match) {
    return undefined;
  }
  return {
    source: "tool",
    toolName: normalizedToolName,
    code: "UNKNOWN_TOOL_ID",
  };
}
