/**
 * Routes Codex app-server plugin approval prompts through OpenClaw's gateway
 * approval tool and maps gateway decisions back to Codex outcomes.
 */
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isApprovalNotFoundError, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveCodexGatewayTimeoutWithGraceMs } from "./attempt-timeouts.js";

type AgentHarnessHostCapabilities = EmbeddedRunAttemptParams["hostCapabilities"];

const DEFAULT_CODEX_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_PLUGIN_APPROVAL_TITLE_LENGTH = 80;
// Matches the gateway protocol's PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH; the card
// must fit the MCP server line, the operator remedy, and the tool parameters.
const MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH = 512;
const ANSI_OSC_SEQUENCE_RE = new RegExp(
  String.raw`(?:\u001b]|\u009d)[^\u001b\u009c\u0007]*(?:\u0007|\u001b\\|\u009c)`,
  "g",
);
const ANSI_CONTROL_SEQUENCE_RE = new RegExp(
  String.raw`(?:\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_])`,
  "g",
);
const CONTROL_CHARACTER_RE = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f]+`, "g");
const INVISIBLE_FORMATTING_CONTROL_RE = new RegExp(
  String.raw`[\u00ad\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufe00-\ufe0f\u{e0100}-\u{e01ef}]`,
  "gu",
);
const DANGLING_TERMINAL_SEQUENCE_SUFFIX_RE = new RegExp(
  String.raw`(?:\u001b\][^\u001b\u009c\u0007]*|\u009d[^\u001b\u009c\u0007]*|\u001b\[[0-?]*[ -/]*|\u009b[0-?]*[ -/]*|\u001b)$`,
);

export type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";

export type CodexApprovalKind = "command" | "file-change" | "permissions" | "other";
const CODEX_APPROVAL_TIMEOUT_SUBJECTS: Record<CodexApprovalKind, string> = {
  command: "Command approval",
  "file-change": "File change approval",
  permissions: "Permission approval",
  other: "Approval",
};

export function codexApprovalTimeoutText(kind: CodexApprovalKind): string {
  return `${CODEX_APPROVAL_TIMEOUT_SUBJECTS[kind]} timed out before an operator responded.`;
}

/** Normalized Codex app-server approval outcome after a gateway decision. */
export type AppServerApprovalOutcome =
  | "approved-once"
  | "approved-session"
  | "denied"
  | "unavailable"
  | "cancelled";

type ApprovalRequestResult = {
  id?: string;
  decision?: ExecApprovalDecision | null;
};

/** Starts a two-phase plugin approval request through the OpenClaw gateway. */
export async function requestPluginApproval(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  signal?: AbortSignal;
  title: string;
  description: string;
  severity: "info" | "warning";
  toolName: string;
  toolCallId?: string;
  allowedDecisions?: ExecApprovalDecision[];
  mcpTool?: { server: string; tool: string };
  isMcpToolApprovalActive?: () => boolean;
}): Promise<ApprovalRequestResult | undefined> {
  const timeoutMs = DEFAULT_CODEX_APPROVAL_TIMEOUT_MS;
  return params.hostCapabilities.requestApproval({
    signal: params.signal,
    title: truncateCodexApprovalDisplayText(params.title, MAX_PLUGIN_APPROVAL_TITLE_LENGTH),
    description: truncateCodexApprovalDisplayText(
      params.description,
      MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH,
    ),
    severity: params.severity,
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    ...(params.mcpTool
      ? { mcpTool: params.mcpTool, isMcpToolApprovalActive: params.isMcpToolApprovalActive }
      : {}),
    timeoutMs,
    transportTimeoutMs: resolveCodexGatewayTimeoutWithGraceMs(timeoutMs),
    ...(params.allowedDecisions ? { allowedDecisions: params.allowedDecisions } : {}),
  }) as Promise<ApprovalRequestResult | undefined>;
}

/** Detects the gateway's explicit null-decision marker for unavailable approvals. */
export function approvalRequestExplicitlyUnavailable(result: unknown): boolean {
  if (result === null || result === undefined || typeof result !== "object") {
    return false;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(result, "decision");
  } catch {
    return false;
  }
  return descriptor !== undefined && "value" in descriptor && descriptor.value === null;
}

/** Waits for the gateway's final approval decision, respecting turn aborts. */
export async function waitForPluginApprovalDecision(params: {
  hostCapabilities: AgentHarnessHostCapabilities;
  approvalId: string;
  signal?: AbortSignal;
}): ReturnType<AgentHarnessHostCapabilities["waitForApproval"]> {
  const timeoutMs = DEFAULT_CODEX_APPROVAL_TIMEOUT_MS;
  const waitPromise = params.hostCapabilities
    .waitForApproval({
      approvalId: params.approvalId,
      timeoutMs,
      transportTimeoutMs: resolveCodexGatewayTimeoutWithGraceMs(timeoutMs),
      signal: params.signal,
    })
    .catch((error: unknown) => {
      if (isApprovalNotFoundError(error)) {
        return undefined;
      }
      throw error;
    });
  if (!params.signal) {
    return await waitPromise;
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (params.signal!.aborted) {
      reject(toErrorObject(params.signal!.reason, "Non-Error rejection"));
      return;
    }
    onAbort = () => reject(toErrorObject(params.signal!.reason, "Non-Error rejection"));
    params.signal!.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([waitPromise, abortPromise]);
  } finally {
    if (onAbort) {
      params.signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Converts a gateway exec approval decision into the app-server approval outcome enum. */
export function mapExecDecisionToOutcome(
  decision: ExecApprovalDecision | null | undefined,
): AppServerApprovalOutcome {
  switch (decision) {
    case "allow-once":
      return "approved-once";
    case "allow-always":
      return "approved-session";
    case "deny":
      return "denied";
    default:
      return "unavailable";
  }
}

export function truncateCodexApprovalDisplayText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${truncateUtf16Safe(value, maxLength - 3)}...`;
}

export function stripDanglingCodexApprovalTerminalSequence(value: string): string {
  return value.replace(DANGLING_TERMINAL_SEQUENCE_SUFFIX_RE, "");
}

export function sanitizeCodexApprovalVisibleText(
  value: string,
  options: { stripDanglingTerminalSequence?: boolean } = {},
): string {
  const terminalSafe = value
    .replace(ANSI_OSC_SEQUENCE_RE, "")
    .replace(ANSI_CONTROL_SEQUENCE_RE, "");
  const visible = options.stripDanglingTerminalSequence
    ? stripDanglingCodexApprovalTerminalSequence(terminalSafe)
    : terminalSafe;
  return visible
    .replace(INVISIBLE_FORMATTING_CONTROL_RE, " ")
    .replace(CONTROL_CHARACTER_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}
