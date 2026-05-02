import {
  callGatewayTool,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";

const DEFAULT_CODEX_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_PLUGIN_APPROVAL_TITLE_LENGTH = 80;
const MAX_PLUGIN_APPROVAL_DESCRIPTION_LENGTH = 256;

type ExecApprovalDecision = "allow-once" | "allow-always" | "deny";

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
    { timeoutMs: timeoutMs + 10_000 },
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

export async function waitForPluginApprovalDecision(params: {
  approvalId: string;
  signal?: AbortSignal;
}): Promise<ExecApprovalDecision | null | undefined> {
  const timeoutMs = DEFAULT_CODEX_APPROVAL_TIMEOUT_MS;
  const waitPromise: Promise<ApprovalWaitResult | undefined> = callGatewayTool(
    "plugin.approval.waitDecision",
    { timeoutMs: timeoutMs + 10_000 },
    { id: params.approvalId },
  );
  if (!params.signal) {
    return (await waitPromise)?.decision;
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (params.signal!.aborted) {
      reject(params.signal!.reason);
      return;
    }
    onAbort = () => reject(params.signal!.reason);
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
