import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import {
  exceedsApprovalTextLimit,
  sanitizeExecApprovalWarningTextWithStatus,
} from "../../infra/exec-approval-text-sanitize.js";
import type { ExecAsk, ExecSecurity } from "../../infra/exec-approvals.js";
import {
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
  PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
  truncatePluginApprovalDetail,
} from "../../infra/plugin-approvals.js";
import {
  prepareSystemRunMutableFileBinding,
  revalidateSystemRunMutableFileBinding,
  type SystemRunMutableFileBinding,
} from "../../infra/system-run-approval-binding.js";
import { sliceUtf16Safe, truncateUtf16Safe } from "../../utils.js";
import { callGatewayTool } from "../tools/gateway.js";

type CliNativeToolApprovalPlan = "allow" | "deny" | "prompt";
type CliNativeToolApprovalDecision = "allow-once" | "allow-always" | "deny";
type CliNativeToolApprovalOutcome =
  | { kind: "allow"; grantAlways: boolean }
  | {
      kind: "deny";
      reason: "operand-binding" | "policy-oversized" | "user" | "unavailable";
      message?: string;
    };

const CLI_NATIVE_TOOL_DESCRIPTION_HEAD_CHARS = 300;
const CLI_NATIVE_TOOL_DESCRIPTION_TAIL_CHARS = 80;
const CLI_NATIVE_TOOL_DESCRIPTION_MAX_CHARS =
  CLI_NATIVE_TOOL_DESCRIPTION_HEAD_CHARS + CLI_NATIVE_TOOL_DESCRIPTION_TAIL_CHARS;
const CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS = 10_000;
const CLI_NATIVE_TOOL_ALLOWED_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly CliNativeToolApprovalDecision[];
// A standing grant must never be minted from a partially displayed input, so
// oversized inputs offer one-shot decisions only.
const CLI_NATIVE_TOOL_TRUNCATED_DECISIONS = [
  "allow-once",
  "deny",
] as const satisfies readonly CliNativeToolApprovalDecision[];
// Bash is arbitrary shell execution, so a name-wide grant is unrestricted.
// Bash fails closed when even the reviewer-only detail cannot show the complete input.
const CLI_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL = "Bash";

export function resolveCliNativeToolApprovalPlan(execPermission: {
  security: ExecSecurity;
  ask: ExecAsk;
}): CliNativeToolApprovalPlan {
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

type CliNativeToolDescription = { compact: string; text: string; truncated: boolean };

/**
 * The gateway caps approval descriptions (PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH),
 * so full inputs cannot ride this channel. Head+tail display defeats padded
 * prefixes hiding an executable tail, and the quantified marker makes a partial
 * view an explicit operator decision. Accepted tradeoff: the middle stays
 * unreviewable; oversized inputs therefore never earn allow-always.
 */
function formatCliNativeToolDescription(
  toolInput: Record<string, unknown>,
): CliNativeToolDescription {
  const compact = JSON.stringify(toolInput) ?? "{}";
  if (compact.length <= CLI_NATIVE_TOOL_DESCRIPTION_MAX_CHARS) {
    return { compact, text: compact, truncated: false };
  }
  const head = truncateUtf16Safe(compact, CLI_NATIVE_TOOL_DESCRIPTION_HEAD_CHARS);
  const tail = sliceUtf16Safe(compact, compact.length - CLI_NATIVE_TOOL_DESCRIPTION_TAIL_CHARS);
  const hiddenChars = compact.length - head.length - tail.length;
  return {
    compact,
    text: `${head} …[+${hiddenChars} chars hidden]… ${tail}`,
    truncated: true,
  };
}

function formatCliNativeToolTitle(pluginId: string, toolName: string): string {
  return truncateUtf16Safe(
    `${pluginId} native tool: ${toolName}`,
    PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
  );
}

function resolveCliNativeToolAllowedDecisions(params: {
  ask: ExecAsk;
  toolName: string;
  descriptionTruncated: boolean;
}): readonly CliNativeToolApprovalDecision[] {
  return params.ask === "always" ||
    params.toolName === CLI_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL ||
    params.descriptionTruncated
    ? CLI_NATIVE_TOOL_TRUNCATED_DECISIONS
    : CLI_NATIVE_TOOL_ALLOWED_DECISIONS;
}

function toAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("CLI native tool approval aborted");
}

async function raceCliNativeToolApprovalAbort<T>(
  promise: Promise<T>,
  abortSignal: AbortSignal | undefined,
): Promise<T> {
  if (!abortSignal) {
    return promise;
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (abortSignal.aborted) {
      reject(toAbortError(abortSignal.reason));
      return;
    }
    onAbort = () => reject(toAbortError(abortSignal.reason));
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    if (onAbort) {
      abortSignal.removeEventListener("abort", onAbort);
    }
  }
}

function waitForCliNativeToolApproval(params: {
  id: string;
  gatewayTimeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<{ id?: string; decision?: unknown }> {
  return raceCliNativeToolApprovalAbort(
    callGatewayTool(
      "plugin.approval.waitDecision",
      { timeoutMs: params.gatewayTimeoutMs },
      { id: params.id },
      // Abort must reach the RPC too, or the gateway keeps the approval prompt
      // live for its full timeout after the admitted CLI run already ended.
      { signal: params.abortSignal },
    ),
    params.abortSignal,
  );
}

export async function requestCliNativeToolApproval(params: {
  toolName: string;
  toolInput: Record<string, unknown>;
  pluginId: string;
  sessionKey?: string;
  agentId?: string;
  toolCallId?: string;
  cwd?: string;
  abortSignal?: AbortSignal;
  ask: ExecAsk;
}): Promise<CliNativeToolApprovalOutcome> {
  try {
    const timeoutMs = DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;
    const gatewayTimeoutMs =
      addTimerTimeoutGraceMs(timeoutMs, CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS) ??
      timeoutMs + CLI_NATIVE_TOOL_APPROVAL_GATEWAY_GRACE_MS;
    const description = formatCliNativeToolDescription(params.toolInput);
    const detail = truncatePluginApprovalDetail(description.compact);
    const detailSanitization =
      params.toolName === CLI_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL
        ? sanitizeExecApprovalWarningTextWithStatus(description.compact)
        : null;
    // Sanitization escapes control/bidi characters into longer visible
    // sequences, so a short raw command can still overflow the 512-char
    // description bound after sanitization and get truncated at render time.
    const summarySanitization =
      params.toolName === CLI_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL
        ? sanitizeExecApprovalWarningTextWithStatus(description.text)
        : null;
    // Approvals resolve from summary-only surfaces (channel text, push), which
    // never carry the reviewer detail. Bash therefore fails closed whenever any
    // resolving surface could see less than the complete command: a truncated
    // description, sanitization-altered display, or post-sanitization overflow.
    if (
      params.toolName === CLI_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL &&
      (description.truncated ||
        detailSanitization?.truncated === true ||
        detailSanitization?.oversized === true ||
        summarySanitization?.truncated === true ||
        summarySanitization?.oversized === true ||
        (summarySanitization &&
          exceedsApprovalTextLimit(
            summarySanitization.text,
            PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
          )))
    ) {
      return { kind: "deny", reason: "policy-oversized" };
    }
    const bashCommand =
      params.toolName === CLI_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL &&
      typeof params.toolInput.command === "string"
        ? params.toolInput.command
        : undefined;
    let mutableFileBinding: SystemRunMutableFileBinding | undefined;
    if (params.toolName === CLI_NATIVE_TOOL_ARBITRARY_EXECUTION_TOOL) {
      // Bind script bytes before the out-of-band approval wait. Text-identical
      // Bash input can otherwise execute a rewritten file after approval.
      const prepared = await prepareSystemRunMutableFileBinding({
        command: { kind: "shell", text: bashCommand ?? "" },
        cwd: params.cwd,
      });
      if (!prepared.ok) {
        return { kind: "deny", reason: "operand-binding", message: prepared.message };
      }
      mutableFileBinding = prepared.binding.operands.length > 0 ? prepared.binding : undefined;
    }
    const allowedDecisions = resolveCliNativeToolAllowedDecisions({
      ask: params.ask,
      toolName: params.toolName,
      descriptionTruncated: description.truncated,
    });
    const requestResult: {
      id?: string;
      decision?: unknown;
    } = await raceCliNativeToolApprovalAbort(
      callGatewayTool(
        "plugin.approval.request",
        { timeoutMs: gatewayTimeoutMs },
        {
          pluginId: params.pluginId,
          toolName: params.toolName,
          toolCallId: params.toolCallId,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          title: formatCliNativeToolTitle(params.pluginId, params.toolName),
          description: description.text,
          detail,
          severity: "warning",
          allowedDecisions,
          timeoutMs,
          twoPhase: true,
        },
        { expectFinal: false, signal: params.abortSignal },
      ),
      params.abortSignal,
    );
    const id = typeof requestResult?.id === "string" ? requestResult.id : "";
    if (!id) {
      return { kind: "deny", reason: "unavailable" };
    }
    let decision: unknown;
    if (Object.hasOwn(requestResult ?? {}, "decision")) {
      decision = requestResult.decision;
    } else {
      const waitResult = await waitForCliNativeToolApproval({
        id,
        gatewayTimeoutMs,
        abortSignal: params.abortSignal,
      });
      decision = waitResult?.id === id ? waitResult.decision : undefined;
    }
    if (params.abortSignal?.aborted) {
      return { kind: "deny", reason: "unavailable" };
    }
    if ((decision === "allow-once" || decision === "allow-always") && mutableFileBinding) {
      // This control response is OpenClaw's last boundary before the CLI owns
      // spawn, so reject bytes that changed during the approval wait.
      const binding = await revalidateSystemRunMutableFileBinding({
        binding: mutableFileBinding,
        cwd: params.cwd,
      });
      if (!binding.ok) {
        return { kind: "deny", reason: "operand-binding", message: binding.message };
      }
    }
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
