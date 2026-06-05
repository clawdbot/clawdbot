/**
 * Routes Codex app-server plugin approval prompts through OpenClaw's gateway
 * approval tool and maps gateway decisions back to Codex outcomes.
 */
import {
  callGatewayTool,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexGatewayTimeoutWithGraceMs } from "./attempt-timeouts.js";

const DEFAULT_CODEX_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_PLUGIN_APPROVAL_TITLE_LENGTH = 80;
const MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH = 256;

type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";

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

type ApprovalWaitResult = {
  id?: string;
  decision?: ExecApprovalDecision | null;
};

/** Starts a two-phase plugin approval request through the OpenClaw gateway. */
export async function requestPluginApproval(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  title: string;
  description: string;
  severity: "info" | "warning";
  toolName: string;
  toolCallId?: string;
}): Promise<ApprovalRequestResult | undefined> {
  const timeoutMs = DEFAULT_CODEX_APPROVAL_TIMEOUT_MS;
  return callGatewayTool(
    "plugin.approval.request",
    { timeoutMs: resolveCodexGatewayTimeoutWithGraceMs(timeoutMs) },
    {
      pluginId: "openclaw-codex-app-server",
      title: truncateForGateway(params.title, MAX_PLUGIN_APPROVAL_TITLE_LENGTH),
      description: truncateForGateway(params.description, MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH),
      severity: params.severity,
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      agentId: params.paramsForRun.agentId,
      sessionKey: params.paramsForRun.sessionKey,
      turnSourceChannel: params.paramsForRun.messageChannel ?? params.paramsForRun.messageProvider,
      turnSourceTo: params.paramsForRun.currentChannelId,
      turnSourceAccountId: params.paramsForRun.agentAccountId,
      turnSourceThreadId: params.paramsForRun.currentThreadTs,
      timeoutMs,
      twoPhase: true,
    },
    { expectFinal: false },
  ) as Promise<ApprovalRequestResult | undefined>;
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
  approvalId: string;
  signal?: AbortSignal;
}): Promise<ExecApprovalDecision | null | undefined> {
  const timeoutMs = DEFAULT_CODEX_APPROVAL_TIMEOUT_MS;
  const waitPromise: Promise<ApprovalWaitResult | undefined> = callGatewayTool(
    "plugin.approval.waitDecision",
    { timeoutMs: resolveCodexGatewayTimeoutWithGraceMs(timeoutMs) },
    { id: params.approvalId },
  );
  if (!params.signal) {
    return (await waitPromise)?.decision;
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (params.signal!.aborted) {
      reject(toLintErrorObject(params.signal!.reason, "Non-Error rejection"));
      return;
    }
    onAbort = () => reject(toLintErrorObject(params.signal!.reason, "Non-Error rejection"));
    params.signal!.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return (await Promise.race([waitPromise, abortPromise]))?.decision;
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
  if (decision === "allow-once") {
    return "approved-once";
  }
  if (decision === "allow-always") {
    return "approved-session";
  }
  if (decision === null || decision === undefined) {
    return "unavailable";
  }
  return "denied";
}

function truncateForGateway(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
