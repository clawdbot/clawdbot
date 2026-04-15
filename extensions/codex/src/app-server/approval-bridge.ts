import {
  callGatewayTool,
  type AgentApprovalEventData,
  type EmbeddedRunAttemptParams,
  type ExecApprovalDecision,
} from "openclaw/plugin-sdk/agent-harness";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

const DEFAULT_CODEX_APPROVAL_TIMEOUT_MS = 120_000;

export type AppServerApprovalOutcome =
  | "approved-once"
  | "approved-session"
  | "denied"
  | "unavailable"
  | "cancelled";

type ApprovalRequestResult = {
  id?: string;
  status?: string;
  decision?: ExecApprovalDecision | null;
};

type ApprovalWaitResult = {
  id?: string;
  decision?: ExecApprovalDecision | null;
};

export async function handleCodexAppServerApprovalRequest(params: {
  method: string;
  requestParams: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  const requestParams = isJsonObject(params.requestParams) ? params.requestParams : undefined;
  if (!matchesCurrentTurn(requestParams, params.threadId, params.turnId)) {
    return undefined;
  }

  const context = buildApprovalContext({
    method: params.method,
    requestParams,
    paramsForRun: params.paramsForRun,
  });

  try {
    const timeoutMs = DEFAULT_CODEX_APPROVAL_TIMEOUT_MS;
    const requestResult: ApprovalRequestResult | undefined = await callGatewayTool(
      "plugin.approval.request",
      { timeoutMs: timeoutMs + 10_000 },
      {
        pluginId: "openclaw-codex-app-server",
        title: context.title,
        description: context.description,
        severity: context.severity,
        toolName: context.kind === "exec" ? "codex_command_approval" : "codex_file_approval",
        toolCallId: context.itemId,
        agentId: params.paramsForRun.agentId,
        sessionKey: params.paramsForRun.sessionKey,
        turnSourceChannel:
          params.paramsForRun.messageChannel ?? params.paramsForRun.messageProvider,
        turnSourceTo: params.paramsForRun.currentChannelId,
        turnSourceAccountId: params.paramsForRun.agentAccountId,
        turnSourceThreadId: params.paramsForRun.currentThreadTs,
        timeoutMs,
        twoPhase: true,
      },
      { expectFinal: false },
    );

    const approvalId = requestResult?.id;
    if (!approvalId) {
      emitApprovalEvent(params.paramsForRun, {
        phase: "resolved",
        kind: context.kind,
        status: "unavailable",
        title: context.title,
        ...context.eventDetails,
        message: "Codex app-server approval route unavailable.",
      });
      return buildApprovalResponse(params.method, context.requestParams, "denied");
    }

    emitApprovalEvent(params.paramsForRun, {
      phase: "requested",
      kind: context.kind,
      status: "pending",
      title: context.title,
      approvalId,
      approvalSlug: approvalId,
      ...context.eventDetails,
      message: "Codex app-server approval requested.",
    });

    const decision = Object.prototype.hasOwnProperty.call(requestResult, "decision")
      ? requestResult.decision
      : await waitForApprovalDecision({
          approvalId,
          timeoutMs,
          signal: params.signal,
        });
    const outcome = mapExecDecisionToOutcome(decision);

    emitApprovalEvent(params.paramsForRun, {
      phase: "resolved",
      kind: context.kind,
      status:
        outcome === "denied"
          ? "denied"
          : outcome === "unavailable"
            ? "unavailable"
            : outcome === "cancelled"
              ? "failed"
              : "approved",
      title: context.title,
      approvalId,
      approvalSlug: approvalId,
      ...context.eventDetails,
      message: approvalResolutionMessage(outcome),
    });
    return buildApprovalResponse(params.method, context.requestParams, outcome);
  } catch (error) {
    const cancelled = params.signal?.aborted === true;
    emitApprovalEvent(params.paramsForRun, {
      phase: "resolved",
      kind: context.kind,
      status: cancelled ? "failed" : "unavailable",
      title: context.title,
      ...context.eventDetails,
      message: cancelled
        ? "Codex app-server approval cancelled because the run stopped."
        : `Codex app-server approval route failed: ${formatErrorMessage(error)}`,
    });
    return buildApprovalResponse(
      params.method,
      context.requestParams,
      cancelled ? "cancelled" : "denied",
    );
  }
}

export function buildApprovalResponse(
  method: string,
  requestParams: JsonObject | undefined,
  outcome: AppServerApprovalOutcome,
): JsonValue {
  if (method === "item/commandExecution/requestApproval") {
    return { decision: commandApprovalDecision(requestParams, outcome) };
  }
  if (method === "item/fileChange/requestApproval") {
    return { decision: fileChangeApprovalDecision(outcome) };
  }
  if (method === "item/permissions/requestApproval") {
    if (outcome === "approved-session" || outcome === "approved-once") {
      return {
        permissions: requestedPermissions(requestParams),
        scope: outcome === "approved-session" ? "session" : "turn",
      };
    }
    return { permissions: {}, scope: "turn" };
  }
  return {
    decision: outcome === "approved-once" || outcome === "approved-session" ? "accept" : "decline",
  };
}

function matchesCurrentTurn(
  requestParams: JsonObject | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!requestParams) {
    return true;
  }
  const requestThreadId =
    readString(requestParams, "threadId") ?? readString(requestParams, "conversationId");
  const requestTurnId = readString(requestParams, "turnId");
  if (requestThreadId && requestThreadId !== threadId) {
    return false;
  }
  if (requestTurnId && requestTurnId !== turnId) {
    return false;
  }
  return true;
}

function buildApprovalContext(params: {
  method: string;
  requestParams: JsonObject | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
}) {
  const itemId =
    readString(params.requestParams, "itemId") ??
    readString(params.requestParams, "callId") ??
    readString(params.requestParams, "approvalId");
  const command = readCommand(params.requestParams);
  const reason = readString(params.requestParams, "reason");
  const kind = approvalKindForMethod(params.method);
  const title =
    kind === "exec"
      ? "Codex app-server command approval"
      : kind === "plugin"
        ? "Codex app-server file approval"
        : "Codex app-server approval";
  const subject = command
    ? `Command: ${truncate(command, 180)}`
    : reason
      ? `Reason: ${truncate(reason, 180)}`
      : `Request method: ${params.method}`;
  const description = [
    subject,
    params.paramsForRun.sessionKey && `Session: ${params.paramsForRun.sessionKey}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    kind,
    title,
    description,
    severity: kind === "exec" ? ("warning" as const) : ("info" as const),
    itemId,
    requestParams: params.requestParams,
    eventDetails: {
      ...(itemId ? { itemId } : {}),
      ...(command ? { command } : {}),
      ...(reason ? { reason } : {}),
    },
  };
}

async function waitForApprovalDecision(params: {
  approvalId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ExecApprovalDecision | null | undefined> {
  const waitPromise: Promise<ApprovalWaitResult | undefined> = callGatewayTool(
    "plugin.approval.waitDecision",
    { timeoutMs: params.timeoutMs + 10_000 },
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

function commandApprovalDecision(
  requestParams: JsonObject | undefined,
  outcome: AppServerApprovalOutcome,
): JsonValue {
  if (outcome === "cancelled") {
    return "cancel";
  }
  if (outcome === "denied" || outcome === "unavailable") {
    return "decline";
  }
  if (outcome === "approved-session" && hasAvailableDecision(requestParams, "acceptForSession")) {
    return "acceptForSession";
  }
  return "accept";
}

function fileChangeApprovalDecision(outcome: AppServerApprovalOutcome): JsonValue {
  if (outcome === "cancelled") {
    return "cancel";
  }
  if (outcome === "denied" || outcome === "unavailable") {
    return "decline";
  }
  return outcome === "approved-session" ? "acceptForSession" : "accept";
}

function requestedPermissions(requestParams: JsonObject | undefined): JsonObject {
  const permissions = isJsonObject(requestParams?.permissions) ? requestParams.permissions : {};
  const granted: JsonObject = {};
  if (isJsonObject(permissions.network)) {
    granted.network = permissions.network;
  }
  if (isJsonObject(permissions.fileSystem)) {
    granted.fileSystem = permissions.fileSystem;
  }
  return granted;
}

function hasAvailableDecision(requestParams: JsonObject | undefined, decision: string): boolean {
  const available = requestParams?.availableDecisions;
  if (!Array.isArray(available)) {
    return true;
  }
  return available.includes(decision);
}

function mapExecDecisionToOutcome(
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

function approvalResolutionMessage(outcome: AppServerApprovalOutcome): string {
  if (outcome === "approved-session") {
    return "Codex app-server approval granted for the session.";
  }
  if (outcome === "approved-once") {
    return "Codex app-server approval granted once.";
  }
  if (outcome === "cancelled") {
    return "Codex app-server approval cancelled.";
  }
  if (outcome === "unavailable") {
    return "Codex app-server approval unavailable.";
  }
  return "Codex app-server approval denied.";
}

function approvalKindForMethod(method: string): AgentApprovalEventData["kind"] {
  if (method.includes("commandExecution") || method.includes("execCommand")) {
    return "exec";
  }
  if (method.includes("fileChange") || method.includes("Patch") || method.includes("permissions")) {
    return "plugin";
  }
  return "unknown";
}

function emitApprovalEvent(params: EmbeddedRunAttemptParams, data: AgentApprovalEventData): void {
  params.onAgentEvent?.({ stream: "approval", data: data as unknown as Record<string, unknown> });
}

function readCommand(record: JsonObject | undefined): string | undefined {
  const command = record?.command;
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    return command.join(" ");
  }
  return undefined;
}

function readString(record: JsonObject | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
