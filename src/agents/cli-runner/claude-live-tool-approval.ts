import { sanitizeExecApprovalWarningTextWithStatus } from "../../infra/exec-approval-command-display.js";
import type { ExecAsk, ExecSecurity } from "../../infra/exec-approvals.js";
import {
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
  PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
  truncatePluginApprovalDetail,
} from "../../infra/plugin-approvals.js";
import { sliceUtf16Safe, truncateUtf16Safe } from "../../utils.js";
import type { AgentRunApprovalHost } from "../agent-run-approval.js";

type ClaudeNativeToolApprovalPlan = "allow" | "deny" | "prompt";
type ClaudeNativeToolApprovalDecision = "allow-once" | "allow-always" | "deny";
type ClaudeNativeToolApprovalOutcome =
  | { kind: "allow"; grantAlways: boolean }
  | { kind: "deny"; reason: "policy-oversized" | "user" | "unavailable" };

const CLAUDE_NATIVE_TOOL_DESCRIPTION_HEAD_CHARS = 300;
const CLAUDE_NATIVE_TOOL_DESCRIPTION_TAIL_CHARS = 80;
const CLAUDE_NATIVE_TOOL_DESCRIPTION_MAX_CHARS =
  CLAUDE_NATIVE_TOOL_DESCRIPTION_HEAD_CHARS + CLAUDE_NATIVE_TOOL_DESCRIPTION_TAIL_CHARS;
const CLAUDE_NATIVE_TOOL_ALLOWED_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ClaudeNativeToolApprovalDecision[];
// A standing grant must never be minted from a partially displayed input, so
// oversized inputs offer one-shot decisions only.
const CLAUDE_NATIVE_TOOL_TRUNCATED_DECISIONS = [
  "allow-once",
  "deny",
] as const satisfies readonly ClaudeNativeToolApprovalDecision[];
// Claude Code's Bash tool is arbitrary shell execution, so a name-wide grant is unrestricted.
// Bash fails closed when even the reviewer-only detail cannot show the complete input.
const CLAUDE_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL = "Bash";

export function resolveClaudeNativeToolApprovalPlan(execPermission: {
  security: ExecSecurity;
  ask: ExecAsk;
}): ClaudeNativeToolApprovalPlan {
  if (execPermission.security === "deny") {
    return "deny";
  }
  // ask "off" means never prompt (exec mode "allowlist" relies on this): full
  // security auto-allows, anything stricter denies without an approval request.
  if (execPermission.ask === "off") {
    return execPermission.security === "full" ? "allow" : "deny";
  }
  return "prompt";
}

type ClaudeNativeToolDescription = { compact: string; text: string; truncated: boolean };

/**
 * The gateway caps approval descriptions (PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH),
 * so full inputs cannot ride this channel. Head+tail display defeats padded
 * prefixes hiding an executable tail, and the quantified marker makes a partial
 * view an explicit operator decision. Accepted tradeoff: the middle stays
 * unreviewable; oversized inputs therefore never earn allow-always.
 */
function formatClaudeNativeToolDescription(
  toolInput: Record<string, unknown>,
): ClaudeNativeToolDescription {
  const compact = JSON.stringify(toolInput) ?? "{}";
  if (compact.length <= CLAUDE_NATIVE_TOOL_DESCRIPTION_MAX_CHARS) {
    return { compact, text: compact, truncated: false };
  }
  const head = truncateUtf16Safe(compact, CLAUDE_NATIVE_TOOL_DESCRIPTION_HEAD_CHARS);
  const tail = sliceUtf16Safe(compact, compact.length - CLAUDE_NATIVE_TOOL_DESCRIPTION_TAIL_CHARS);
  const hiddenChars = compact.length - head.length - tail.length;
  return {
    compact,
    text: `${head} …[+${hiddenChars} chars hidden]… ${tail}`,
    truncated: true,
  };
}

function formatClaudeNativeToolTitle(toolName: string): string {
  return truncateUtf16Safe(`Claude native tool: ${toolName}`, PLUGIN_APPROVAL_TITLE_MAX_LENGTH);
}

function resolveClaudeNativeToolAllowedDecisions(params: {
  ask: ExecAsk;
  toolName: string;
  descriptionTruncated: boolean;
}): readonly ClaudeNativeToolApprovalDecision[] {
  return params.ask === "always" ||
    params.toolName === CLAUDE_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL ||
    params.descriptionTruncated
    ? CLAUDE_NATIVE_TOOL_TRUNCATED_DECISIONS
    : CLAUDE_NATIVE_TOOL_ALLOWED_DECISIONS;
}

export async function requestClaudeNativeToolApproval(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  pluginId: string;
  sessionKey?: string;
  agentId?: string;
  toolCallId?: string;
  approvalHost?: AgentRunApprovalHost;
  abortSignal?: AbortSignal;
  ask: ExecAsk;
}): Promise<ClaudeNativeToolApprovalOutcome> {
  try {
    const timeoutMs = DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;
    const description = formatClaudeNativeToolDescription(params.toolInput);
    const detail = truncatePluginApprovalDetail(description.compact);
    const detailSanitization =
      params.toolName === CLAUDE_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL
        ? sanitizeExecApprovalWarningTextWithStatus(description.compact)
        : null;
    // Sanitization escapes control/bidi characters into longer visible
    // sequences, so a short raw command can still overflow the 512-char
    // description bound after sanitization and get truncated at render time.
    const summarySanitization =
      params.toolName === CLAUDE_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL
        ? sanitizeExecApprovalWarningTextWithStatus(description.text)
        : null;
    // Approvals resolve from summary-only surfaces (channel text, push), which
    // never carry the reviewer detail. Bash therefore fails closed whenever any
    // resolving surface could see less than the complete command: a truncated
    // description, sanitization-altered display, or post-sanitization overflow.
    if (
      params.toolName === CLAUDE_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL &&
      (description.truncated ||
        detailSanitization?.truncated === true ||
        detailSanitization?.oversized === true ||
        summarySanitization?.truncated === true ||
        summarySanitization?.oversized === true ||
        (summarySanitization &&
          Array.from(summarySanitization.text).length > PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH))
    ) {
      return { kind: "deny", reason: "policy-oversized" };
    }
    const allowedDecisions = resolveClaudeNativeToolAllowedDecisions({
      ask: params.ask,
      toolName: params.toolName,
      descriptionTruncated: description.truncated,
    });
    const approvalHost = params.approvalHost?.plugin;
    if (!approvalHost) {
      return { kind: "deny", reason: "unavailable" };
    }
    const result = await approvalHost.request({
      request: {
        pluginId: params.pluginId,
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        title: formatClaudeNativeToolTitle(params.toolName),
        description: description.text,
        detail,
        severity: "warning",
        allowedDecisions,
      },
      timeoutMs,
      signal: params.abortSignal,
    });
    if (result.outcome !== "resolved") {
      return { kind: "deny", reason: "unavailable" };
    }
    if (params.abortSignal?.aborted) {
      return { kind: "deny", reason: "unavailable" };
    }
    const decision = result.decision;
    if (decision === "allow-once") {
      return { kind: "allow", grantAlways: false };
    }
    if (decision === "allow-always" && allowedDecisions.includes(decision)) {
      return { kind: "allow", grantAlways: true };
    }
    if (decision === "deny") {
      return { kind: "deny", reason: "user" };
    }
    return { kind: "deny", reason: "unavailable" };
  } catch {
    return { kind: "deny", reason: "unavailable" };
  }
}
