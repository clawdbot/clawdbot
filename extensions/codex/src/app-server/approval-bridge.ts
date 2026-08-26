/**
 * Bridges Codex app-server approval requests into OpenClaw policy hooks and
 * plugin approval UX.
 */
import {
  type AgentApprovalEventData,
  type BeforeToolCallFailureDisposition,
  formatApprovalDisplayPath,
  hasNativeHookRelayInvocation,
  invokeNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type NativeHookRelayProcessResponse,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  normalizeTrimmedStringList,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { formatCodexDisplayText } from "../command-formatters.js";
import { resolveCodexToolAbortTerminalReason } from "./dynamic-tool-execution.js";
import {
  approvalRequestExplicitlyUnavailable,
  codexApprovalTimeoutText,
  mapExecDecisionToOutcome,
  requestPluginApproval,
  sanitizeCodexApprovalVisibleText,
  stripDanglingCodexApprovalTerminalSequence,
  truncateCodexApprovalDisplayText as truncate,
  type AppServerApprovalOutcome,
  type CodexApprovalKind,
  type ExecApprovalDecision,
  waitForPluginApprovalDecision,
} from "./plugin-approval-roundtrip.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

const PERMISSION_DESCRIPTION_MAX_LENGTH = 700;
const PERMISSION_SAMPLE_LIMIT = 2;
const PERMISSION_VALUE_MAX_LENGTH = 48;
const COMMAND_PREVIEW_WITH_DETAILS_MAX_LENGTH = 80;
const APPROVAL_PREVIEW_SCAN_MAX_LENGTH = 4096;
const APPROVAL_PREVIEW_OMITTED = "[preview truncated or unsafe content omitted]";
// Automatic approval is limited to concrete calls. A before_tool_call allow
// covers the evaluated call, not future scope; new or grant-shaped methods stay human-gated.
const CONCRETE_TOOL_AUTO_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

type ApprovalPreviewSource = {
  value: string;
  clipped: boolean;
};

type SanitizedApprovalPreview = {
  text?: string;
  omitted: boolean;
};

/**
 * Handles one app-server approval request for the active thread/turn, returning
 * the app-server response payload when the request belongs to this run.
 */
export async function handleCodexAppServerApprovalRequest(params: {
  method: string;
  requestParams: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  nativeHookRelay?: Pick<
    NativeHookRelayRegistrationHandle,
    "allowedEvents" | "generation" | "relayId"
  >;
  autoApprove?: boolean;
  signal?: AbortSignal;
  onNativeToolFailureDisposition?: (
    itemId: string,
    disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">,
    approvalKind?: CodexApprovalKind,
  ) => void;
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
  if (params.signal?.aborted) {
    recordNativeToolFailureDisposition(params, context, "cancelled");
    return buildApprovalResponse(params.method, context.requestParams, "cancelled");
  }
  let revalidateMutableFileApproval:
    | (() => Promise<{ ok: true } | { ok: false; message: string }>)
    | undefined;
  let mutableFileApprovalRequiresOneShot = false;
  const resolvePolicyApproval = async (
    outcome: Extract<AppServerApprovalOutcome, "denied" | "approved-once" | "approved-session">,
    message = approvalResolutionMessage(outcome),
    approvalId?: string,
  ): Promise<JsonValue> => {
    let resolvedOutcome = outcome;
    let resolvedMessage = message;
    // This is the last enforceable client boundary before Codex owns spawn.
    // Releasing without this check would approve bytes changed during the wait.
    if (outcome !== "denied" && revalidateMutableFileApproval) {
      const binding = await revalidateMutableFileApproval();
      if (!binding.ok) {
        resolvedOutcome = "denied";
        resolvedMessage = binding.message;
      }
    }
    if (resolvedOutcome === "approved-session" && mutableFileApprovalRequiresOneShot) {
      resolvedOutcome = "approved-once";
      resolvedMessage = "Codex app-server approval granted for this byte-bound command only.";
    }
    emitApprovalEvent(params.paramsForRun, {
      phase: "resolved",
      kind: context.kind,
      status: resolvedOutcome === "denied" ? "denied" : "approved",
      title: context.title,
      ...(approvalId ? { approvalId, approvalSlug: approvalId } : {}),
      ...context.eventDetails,
      ...approvalEventScope(params.method, resolvedOutcome),
      message: resolvedMessage,
    });
    return buildApprovalResponse(params.method, context.requestParams, resolvedOutcome);
  };
  try {
    if (
      params.method === "item/commandExecution/requestApproval" &&
      !readNetworkApprovalContext(requestParams)
    ) {
      const command = readPolicyCommand(requestParams);
      const cwd = readString(requestParams, "cwd") ?? params.paramsForRun.workspaceDir;
      // Snapshot the executable file operands before policy or operator waits;
      // an unbound or unreadable script could otherwise change under the prompt.
      const prepareMutableFileApproval =
        params.paramsForRun.hostCapabilities.prepareMutableFileApproval;
      if (!prepareMutableFileApproval) {
        return await resolvePolicyApproval(
          "denied",
          "SYSTEM_RUN_DENIED: mutable file approval binding is unavailable",
        );
      }
      const prepared = await prepareMutableFileApproval({
        command: command ?? "",
        cwd,
      });
      if (!prepared.ok) {
        return await resolvePolicyApproval("denied", prepared.message);
      }
      mutableFileApprovalRequiresOneShot = prepared.requiresOneShot;
      revalidateMutableFileApproval = prepared.revalidate;
    }
    const policyOutcome = await runOpenClawToolPolicyForApprovalRequest({
      method: params.method,
      requestParams,
      paramsForRun: params.paramsForRun,
      context,
      nativeHookRelay: params.nativeHookRelay,
      autoApprove: params.autoApprove,
      signal: params.signal,
    });
    if (policyOutcome?.outcome === "denied") {
      recordNativeToolFailureDisposition(params, context, policyOutcome.failureDisposition);
      return await resolvePolicyApproval("denied", policyOutcome.reason);
    }
    if (
      policyOutcome?.outcome === "approved-once" ||
      policyOutcome?.outcome === "approved-session"
    ) {
      return await resolvePolicyApproval(policyOutcome.outcome);
    }
    const canAutoApproveConcreteToolCall =
      CONCRETE_TOOL_AUTO_APPROVAL_METHODS.has(params.method) &&
      !readNetworkApprovalContext(requestParams);
    if (canAutoApproveConcreteToolCall && params.autoApprove === true) {
      return await resolvePolicyApproval(
        "approved-session",
        "Codex app-server approval auto-approved by runtime policy.",
      );
    }
    // Codex app-server approval requests do not expose an enforceable resolved
    // executable, so unresolved requests must stay on the human approval route.
    const requestResult = await requestPluginApproval({
      hostCapabilities: params.paramsForRun.hostCapabilities,
      title: context.title,
      description: context.description,
      severity: context.severity,
      toolName: context.toolName,
      toolCallId: context.approvalId,
      allowedDecisions: nativeApprovalAllowedDecisions({
        method: params.method,
        requestParams,
        requiresOneShot: mutableFileApprovalRequiresOneShot,
      }),
    });

    const approvalId = requestResult?.id;
    if (!approvalId) {
      recordNativeToolFailureDisposition(params, context, "failed");
      emitApprovalEvent(params.paramsForRun, {
        phase: "resolved",
        kind: context.kind,
        status: "unavailable",
        title: context.title,
        ...context.eventDetails,
        ...approvalEventScope(params.method, "denied"),
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

    const requestUnavailable = approvalRequestExplicitlyUnavailable(requestResult);
    const approvalResult = requestUnavailable
      ? undefined
      : await waitForPluginApprovalDecision({
          approvalId,
          signal: params.signal,
          hostCapabilities: params.paramsForRun.hostCapabilities,
        });
    const approvalTimedOut =
      !params.signal?.aborted && approvalResult?.terminalReason === "timeout";
    const outcome = params.signal?.aborted
      ? "cancelled"
      : mapExecDecisionToOutcome(approvalResult?.decision);
    if (approvalTimedOut) {
      recordNativeToolFailureDisposition(params, context, "timed_out", context.approvalKind);
    } else if (outcome === "cancelled") {
      recordNativeToolFailureDisposition(
        params,
        context,
        params.signal?.aborted ? resolveCodexToolAbortTerminalReason(params.signal) : "cancelled",
      );
    } else if (outcome === "unavailable") {
      recordNativeToolFailureDisposition(params, context, "failed");
    }

    if (outcome === "approved-once" || outcome === "approved-session") {
      return await resolvePolicyApproval(outcome, approvalResolutionMessage(outcome), approvalId);
    }

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
      ...approvalEventScope(params.method, outcome),
      message: approvalTimedOut
        ? codexApprovalTimeoutText(context.approvalKind)
        : approvalResolutionMessage(outcome),
    });
    return buildApprovalResponse(params.method, context.requestParams, outcome);
  } catch (error) {
    const cancelled = params.signal?.aborted === true;
    recordNativeToolFailureDisposition(
      params,
      context,
      cancelled && params.signal ? resolveCodexToolAbortTerminalReason(params.signal) : "failed",
    );
    emitApprovalEvent(params.paramsForRun, {
      phase: "resolved",
      kind: context.kind,
      status: cancelled ? "failed" : "unavailable",
      title: context.title,
      ...context.eventDetails,
      ...approvalEventScope(params.method, cancelled ? "cancelled" : "denied"),
      message: cancelled
        ? "Codex app-server approval cancelled because the run stopped."
        : `Codex app-server approval route failed: ${formatCodexDisplayText(
            coerceErrorMessage(error),
          )}`,
    });
    return buildApprovalResponse(
      params.method,
      context.requestParams,
      cancelled ? "cancelled" : "denied",
    );
  }
}

function recordNativeToolFailureDisposition(
  params: Pick<
    Parameters<typeof handleCodexAppServerApprovalRequest>[0],
    "onNativeToolFailureDisposition" | "signal"
  >,
  context: Pick<ApprovalContext, "itemId">,
  disposition: Exclude<BeforeToolCallFailureDisposition, "blocked"> | undefined,
  approvalKind?: CodexApprovalKind,
): void {
  if (!context.itemId || !disposition) {
    return;
  }
  try {
    const resolvedDisposition = params.signal?.aborted
      ? resolveCodexToolAbortTerminalReason(params.signal)
      : disposition;
    params.onNativeToolFailureDisposition?.(
      context.itemId,
      resolvedDisposition,
      ...(resolvedDisposition === "timed_out" && approvalKind ? [approvalKind] : []),
    );
  } catch {
    // Audit projection must not alter the approval decision sent to Codex.
  }
}

/** Converts an OpenClaw approval outcome into the app-server method response. */
function buildApprovalResponse(
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
    decision: "decline",
    reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
  };
}

function matchesCurrentTurn(
  requestParams: JsonObject | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!requestParams) {
    return false;
  }
  const requestThreadId = readString(requestParams, "threadId");
  const requestTurnId = readString(requestParams, "turnId");
  return requestThreadId === threadId && requestTurnId === turnId;
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
  // Codex gives every execve callback its own approvalId while retaining the
  // parent itemId. Policy and relay dedupe must use the callback identity.
  const approvalId = readString(params.requestParams, "approvalId") ?? itemId;
  const commandDetailLines =
    params.method === "item/commandExecution/requestApproval"
      ? describeCommandApprovalDetails(params.requestParams)
      : [];
  const commandPreview = sanitizeApprovalPreview(
    readDisplayCommandPreview(params.requestParams),
    commandDetailLines.length > 0 ? COMMAND_PREVIEW_WITH_DETAILS_MAX_LENGTH : 180,
  );
  const reasonPreview = sanitizeApprovalPreview(
    readStringPreview(params.requestParams, "reason"),
    180,
  );
  const command = commandPreview.text;
  const reason = reasonPreview.text;
  const networkApproval =
    params.method === "item/commandExecution/requestApproval"
      ? readNetworkApprovalContext(params.requestParams)
      : undefined;
  const approvalKind: CodexApprovalKind = params.method.includes("commandExecution")
    ? "command"
    : params.method.includes("fileChange")
      ? "file-change"
      : params.method.includes("permissions")
        ? "permissions"
        : "other";
  const kind: AgentApprovalEventData["kind"] =
    approvalKind === "command" ? "exec" : approvalKind === "other" ? "unknown" : "plugin";
  const permissionLines =
    params.method === "item/permissions/requestApproval"
      ? describeRequestedPermissions(params.requestParams)
      : [];
  const title = networkApproval
    ? "Codex app-server network approval"
    : kind === "exec"
      ? "Codex app-server command approval"
      : params.method === "item/permissions/requestApproval"
        ? "Codex app-server permission approval"
        : kind === "plugin"
          ? "Codex app-server file approval"
          : "Codex app-server approval";
  const subject =
    (networkApproval
      ? `Network: ${sanitizePermissionScalar(networkApproval.protocol)}://${sanitizePermissionHostValue(networkApproval.host)}`
      : undefined) ??
    permissionLines[0] ??
    (command
      ? `Command: ${formatApprovalPreviewSubject(command, commandPreview.omitted)}`
      : commandPreview.omitted
        ? `Command: ${APPROVAL_PREVIEW_OMITTED}`
        : reason
          ? `Reason: ${formatApprovalPreviewSubject(reason, reasonPreview.omitted)}`
          : reasonPreview.omitted
            ? `Reason: ${APPROVAL_PREVIEW_OMITTED}`
            : `Request method: ${params.method}`);
  const description =
    permissionLines.length > 0
      ? joinDescriptionLinesWithinLimit(permissionLines, PERMISSION_DESCRIPTION_MAX_LENGTH)
      : [subject, ...commandDetailLines].join("\n");
  return {
    approvalKind,
    kind,
    title,
    description,
    severity: kind === "exec" ? ("warning" as const) : ("info" as const),
    toolName: networkApproval
      ? "codex_network_approval"
      : kind === "exec"
        ? "codex_command_approval"
        : params.method === "item/permissions/requestApproval"
          ? "codex_permission_approval"
          : "codex_file_approval",
    itemId,
    approvalId,
    requestParams: params.requestParams,
    eventDetails: {
      ...(itemId ? { itemId } : {}),
      ...(command ? { command } : {}),
      ...(commandPreview.omitted ? { commandPreviewOmitted: true } : {}),
      ...(reason ? { reason } : {}),
      ...(reasonPreview.omitted ? { reasonPreviewOmitted: true } : {}),
    },
  };
}

type ApprovalContext = ReturnType<typeof buildApprovalContext>;
type ApprovalPolicyOutcome =
  | {
      outcome: "denied";
      reason: string;
      failureDisposition?: Exclude<BeforeToolCallFailureDisposition, "blocked">;
    }
  | { outcome: "approved-once" | "approved-session" }
  | { outcome: "allowed" };

async function runOpenClawToolPolicyForApprovalRequest(params: {
  method: string;
  requestParams: JsonObject | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  context: ApprovalContext;
  nativeHookRelay?: Pick<
    NativeHookRelayRegistrationHandle,
    "allowedEvents" | "generation" | "relayId"
  >;
  autoApprove?: boolean;
  signal?: AbortSignal;
}): Promise<ApprovalPolicyOutcome | undefined> {
  const policyRequest = buildOpenClawToolPolicyRequest(params.method, params.requestParams);
  if (!policyRequest) {
    return undefined;
  }
  const cwd = readString(params.requestParams, "cwd") ?? params.paramsForRun.workspaceDir;
  const nativeRelayOutcome = await runNativeRelayToolPolicyForApprovalRequest({
    method: params.method,
    requestParams: params.requestParams,
    context: params.context,
    policyRequest,
    nativeHookRelay: params.nativeHookRelay,
    autoApprove: params.autoApprove,
    assertActive: params.paramsForRun.hostCapabilities.assertActive,
    cwd,
    signal: params.signal,
  });
  if (nativeRelayOutcome?.blocked) {
    return {
      outcome: "denied",
      reason: nativeRelayOutcome.reason,
      ...(nativeRelayOutcome.failureDisposition
        ? { failureDisposition: nativeRelayOutcome.failureDisposition }
        : {}),
    };
  }
  if (
    nativeRelayOutcome?.outcome === "approved-once" ||
    nativeRelayOutcome?.outcome === "approved-session"
  ) {
    return { outcome: nativeRelayOutcome.outcome };
  }
  if (nativeRelayOutcome?.handled) {
    return { outcome: "allowed" };
  }
  const outcome = await params.paramsForRun.hostCapabilities.runBeforeToolCall({
    toolName: policyRequest.toolName,
    params: policyRequest.params,
    ...(cwd ? { nativeOperation: { cwd } } : {}),
    ...(params.context.approvalId ? { toolCallId: params.context.approvalId } : {}),
    signal: params.signal,
  });
  if (outcome.blocked) {
    return {
      outcome: "denied",
      reason: outcome.reason,
      ...(outcome.kind === "failure" && outcome.disposition !== "blocked"
        ? { failureDisposition: outcome.disposition }
        : {}),
    };
  }
  if ("params" in outcome && toolPolicyParamsWereRewritten(policyRequest.params, outcome.params)) {
    return {
      outcome: "denied",
      reason:
        "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
    };
  }
  if (outcome.approvalResolution) {
    return {
      // Generic plugin approval `allow-always` is plugin-owned durability, not
      // Codex session trust. Keep the app-server request scoped to this item.
      outcome: "approved-once",
    };
  }
  return { outcome: "allowed" };
}

async function runNativeRelayToolPolicyForApprovalRequest(params: {
  method: string;
  requestParams: JsonObject | undefined;
  context: ApprovalContext;
  policyRequest: { toolName: string; params: JsonObject };
  nativeHookRelay?: Pick<
    NativeHookRelayRegistrationHandle,
    "allowedEvents" | "generation" | "relayId"
  >;
  autoApprove?: boolean;
  assertActive: () => void;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<
  | {
      handled: true;
      blocked: true;
      reason: string;
      failureDisposition?: Exclude<BeforeToolCallFailureDisposition, "blocked">;
    }
  | {
      handled: true;
      blocked?: false;
      outcome?: "approved-once" | "approved-session";
    }
  | undefined
> {
  const nativeHookRelay = params.nativeHookRelay;
  // Only command approvals correspond to Codex PreToolUse execution. File-change
  // and permission approvals stay on the app-server approval route below.
  if (
    params.method !== "item/commandExecution/requestApproval" ||
    !nativeHookRelay?.allowedEvents.includes("pre_tool_use")
  ) {
    return undefined;
  }
  const payload = buildNativeRelayPreToolUsePayload({
    requestParams: params.requestParams,
    policyRequest: params.policyRequest,
    context: params.context,
    cwd: params.cwd,
  });
  if (!payload) {
    return undefined;
  }
  const resolveDeferredApproval = async () => {
    const approvalOutcome = await resolveNativeHookRelayDeferredToolApproval({
      relayId: nativeHookRelay.relayId,
      toolUseId: params.context.approvalId,
      signal: params.signal,
    });
    params.assertActive();
    if (approvalOutcome?.outcome === "denied") {
      return {
        handled: true,
        blocked: true,
        reason: approvalOutcome.reason,
        ...(approvalOutcome.failureDisposition
          ? { failureDisposition: approvalOutcome.failureDisposition }
          : {}),
      } as const;
    }
    return approvalOutcome?.outcome === "approved-once"
      ? ({ handled: true, outcome: approvalOutcome.outcome } as const)
      : ({ handled: true } as const);
  };
  if (
    hasNativeHookRelayInvocation({
      relayId: nativeHookRelay.relayId,
      event: "pre_tool_use",
      toolUseId: params.context.approvalId,
    })
  ) {
    return resolveDeferredApproval();
  }
  try {
    const response = await invokeNativeHookRelay({
      provider: "codex",
      relayId: nativeHookRelay.relayId,
      generation: nativeHookRelay.generation,
      event: "pre_tool_use",
      rawPayload: payload,
      requireGeneration: true,
    });
    const decision = readNativeRelayPreToolUseDecision(response);
    if (decision.blocked) {
      return {
        handled: true,
        blocked: true,
        reason: decision.reason,
        ...(decision.failureDisposition ? { failureDisposition: decision.failureDisposition } : {}),
      };
    }
    return await resolveDeferredApproval();
  } catch (error) {
    // Only a relay that failed before invocation is unavailable. Once invoked,
    // handler failures join explicit denials and malformed replies in failing closed.
    if (
      params.autoApprove === true &&
      !hasNativeHookRelayInvocation({
        relayId: nativeHookRelay.relayId,
        event: "pre_tool_use",
        toolUseId: params.context.approvalId,
      })
    ) {
      return undefined;
    }
    return {
      handled: true,
      blocked: true,
      reason: `OpenClaw native hook relay unavailable for Codex app-server approval: ${formatCodexDisplayText(
        coerceErrorMessage(error),
      )}`,
      failureDisposition: "failed",
    };
  }
}

function buildNativeRelayPreToolUsePayload(params: {
  requestParams: JsonObject | undefined;
  policyRequest: { toolName: string; params: JsonObject };
  context: ApprovalContext;
  cwd?: string;
}): JsonObject | undefined {
  const command = readString(params.policyRequest.params, "command");
  if (!command) {
    return undefined;
  }
  const turnId = readString(params.requestParams, "turnId");
  return {
    hook_event_name: "PreToolUse",
    openclaw_approval_mode: "report",
    tool_name: "exec_command",
    ...(params.context.approvalId ? { tool_use_id: params.context.approvalId } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(turnId ? { turn_id: turnId } : {}),
    tool_input: {
      ...params.policyRequest.params,
      command,
      cmd: command,
    },
  };
}

function readNativeRelayPreToolUseDecision(response: NativeHookRelayProcessResponse | undefined):
  | {
      blocked: true;
      reason: string;
      failureDisposition?: Exclude<BeforeToolCallFailureDisposition, "blocked">;
    }
  | { blocked: false } {
  if (!response || response.exitCode !== 0) {
    return {
      blocked: true,
      reason:
        sanitizeRelayDecisionReason(response?.stderr) ||
        sanitizeRelayDecisionReason(response?.stdout) ||
        "OpenClaw native hook relay failed for Codex app-server approval.",
      failureDisposition: response?.failureDisposition ?? "failed",
    };
  }
  const stdout = response.stdout?.trim();
  if (!stdout) {
    return { blocked: false };
  }
  const parsed = parseRelayJsonResponse(stdout);
  const output = isJsonObject(parsed?.hookSpecificOutput) ? parsed.hookSpecificOutput : undefined;
  if (output?.permissionDecision === "deny") {
    return {
      blocked: true,
      reason:
        readString(output, "permissionDecisionReason") ||
        "OpenClaw native hook policy denied Codex app-server approval.",
      ...(response.failureDisposition ? { failureDisposition: response.failureDisposition } : {}),
    };
  }
  // The app-server bridge invokes the relay in report mode, where the relay
  // contract is deny-or-silent. Any other structured decision fails closed.
  return {
    blocked: true,
    reason: output
      ? "OpenClaw native hook relay returned a non-deny Codex app-server approval decision."
      : "OpenClaw native hook relay returned an unreadable Codex app-server approval result.",
    failureDisposition: "failed",
  };
}

function parseRelayJsonResponse(text: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(text) as JsonValue;
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeRelayDecisionReason(value: string | undefined): string | undefined {
  const preview = sanitizeApprovalPreview(value ? { value, clipped: false } : undefined, 240);
  return preview.text;
}

function buildOpenClawToolPolicyRequest(
  method: string,
  requestParams: JsonObject | undefined,
): { toolName: string; params: JsonObject } | undefined {
  if (method === "item/commandExecution/requestApproval") {
    if (readNetworkApprovalContext(requestParams)) {
      return {
        toolName: "codex_network_approval",
        params: { approval: requestParams ?? {} },
      };
    }
    const command = readPolicyCommand(requestParams);
    return {
      toolName: "exec",
      params: {
        ...(command ? { command } : {}),
        ...(readString(requestParams, "cwd") ? { cwd: readString(requestParams, "cwd") } : {}),
        approval: requestParams ?? {},
      },
    };
  }
  if (method === "item/fileChange/requestApproval") {
    return { toolName: "apply_patch", params: requestParams ?? {} };
  }
  if (method === "item/permissions/requestApproval") {
    return { toolName: "codex_permission_approval", params: requestParams ?? {} };
  }
  return undefined;
}

function toolPolicyParamsWereRewritten(original: JsonObject, candidate: unknown): boolean {
  if (candidate === original) {
    return false;
  }
  const originalText = stableJsonText(original);
  const candidateText = stableJsonText(candidate);
  return !candidateText || candidateText !== originalText;
}

function stableJsonText(value: unknown): string | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => stableJsonText(item));
    return items.every((item): item is string => item !== undefined)
      ? `[${items.join(",")}]`
      : undefined;
  }
  if (isJsonObject(value)) {
    const entries = Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => {
        const text = stableJsonText(item);
        return text === undefined ? undefined : `${JSON.stringify(key)}:${text}`;
      });
    return entries.every((entry): entry is string => entry !== undefined)
      ? `{${entries.join(",")}}`
      : undefined;
  }
  return undefined;
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
  const capabilities = commandApprovalCapabilities(requestParams);
  if (outcome === "approved-session" && capabilities.sessionDecision !== undefined) {
    return capabilities.sessionDecision;
  }
  return capabilities.once ? "accept" : "decline";
}

function nativeApprovalAllowedDecisions(params: {
  method: string;
  requestParams: JsonObject | undefined;
  requiresOneShot: boolean;
}): ExecApprovalDecision[] | undefined {
  if (params.method === "item/fileChange/requestApproval") {
    return ["allow-once", "allow-always", "deny"];
  }
  if (params.method !== "item/commandExecution/requestApproval") {
    return undefined;
  }
  const available = params.requestParams?.availableDecisions;
  if (!Array.isArray(available)) {
    return undefined;
  }
  const capabilities = commandApprovalCapabilities(params.requestParams);
  const decisions: ExecApprovalDecision[] = [];
  if (capabilities.once) {
    decisions.push("allow-once");
  }
  if (!params.requiresOneShot && capabilities.sessionDecision !== undefined) {
    decisions.push("allow-always");
  }
  decisions.push("deny");
  return decisions;
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

function describeRequestedPermissions(requestParams: JsonObject | undefined): string[] {
  const permissions = requestedPermissions(requestParams);
  return describePermissionProfile(permissions, "Permissions");
}

function describeCommandApprovalDetails(requestParams: JsonObject | undefined): string[] {
  const lines: string[] = [];
  const additionalPermissions = isJsonObject(requestParams?.additionalPermissions)
    ? requestParams.additionalPermissions
    : undefined;
  if (additionalPermissions) {
    lines.push(...describePermissionProfile(additionalPermissions, "Additional permissions"));
  }
  const execpolicySummary = summarizeStringArray(
    requestParams?.proposedExecpolicyAmendment,
    "Proposed exec policy",
    sanitizePermissionScalar,
  );
  if (execpolicySummary) {
    lines.push(execpolicySummary);
  }
  const networkAmendmentSummary = summarizeNetworkPolicyAmendments(
    requestParams?.proposedNetworkPolicyAmendments,
  );
  if (networkAmendmentSummary) {
    lines.push(networkAmendmentSummary);
  }
  return lines;
}

function describePermissionProfile(permissions: JsonObject, label: string): string[] {
  const lines: string[] = [];
  const kinds: string[] = [];
  const risks = new Set<string>();
  if (isJsonObject(permissions.network)) {
    kinds.push("network");
  }
  if (isJsonObject(permissions.fileSystem)) {
    kinds.push("fileSystem");
  }
  if (kinds.length > 0) {
    lines.push(`${label}: ${kinds.join(", ")}`);
  }
  let networkSummary: string | undefined;
  if (isJsonObject(permissions.network)) {
    const summaries = [
      summarizeNetworkEnabledPermission(permissions.network, risks),
      summarizePermissionRecord(permissions.network, risks, [
        {
          key: "allowHosts",
          label: "allowHosts",
          sanitize: sanitizePermissionHostValue,
          risksFor: permissionHostRisks,
        },
      ]),
    ].filter((summary): summary is string => Boolean(summary));
    networkSummary = summaries.length > 0 ? summaries.join("; ") : undefined;
  }
  let fileSystemSummary: string | undefined;
  if (isJsonObject(permissions.fileSystem)) {
    const summaries = [
      summarizePermissionRecord(permissions.fileSystem, risks, [
        {
          key: "read",
          label: "read",
          sanitize: sanitizePermissionPathValue,
          risksFor: permissionPathRisks,
        },
        {
          key: "write",
          label: "write",
          sanitize: sanitizePermissionPathValue,
          risksFor: permissionPathRisks,
        },
        {
          key: "roots",
          label: "roots",
          sanitize: sanitizePermissionPathValue,
          risksFor: permissionPathRisks,
        },
        {
          key: "readPaths",
          label: "readPaths",
          sanitize: sanitizePermissionPathValue,
          risksFor: permissionPathRisks,
        },
        {
          key: "writePaths",
          label: "writePaths",
          sanitize: sanitizePermissionPathValue,
          risksFor: permissionPathRisks,
        },
      ]),
      summarizeFileSystemEntries(permissions.fileSystem, risks),
    ].filter((summary): summary is string => Boolean(summary));
    fileSystemSummary = summaries.length > 0 ? summaries.join("; ") : undefined;
  }
  if (risks.size > 0) {
    lines.push(`High-risk targets: ${[...risks].join(", ")}`);
  }
  if (networkSummary) {
    lines.push(`Network ${networkSummary}`);
  }
  if (fileSystemSummary) {
    lines.push(`File system ${fileSystemSummary}`);
  }
  return lines;
}

type PermissionArrayDescriptor = {
  key: string;
  label: string;
  sanitize: (value: string) => string;
  risksFor: (value: string) => readonly string[];
};

function summarizeNetworkEnabledPermission(
  permission: JsonObject,
  risks: Set<string>,
): string | undefined {
  const enabled = permission.enabled;
  if (typeof enabled !== "boolean") {
    return undefined;
  }
  if (enabled) {
    risks.add("network access");
  }
  return `enabled: ${enabled}`;
}

function summarizeFileSystemEntries(
  permission: JsonObject,
  risks: Set<string>,
): string | undefined {
  const entries = permission.entries;
  if (!Array.isArray(entries)) {
    return undefined;
  }
  const samples: string[] = [];
  let count = 0;
  for (const entry of entries) {
    const item = isJsonObject(entry) ? entry : undefined;
    const path = typeof item?.path === "string" ? item.path.trim() : "";
    const access = typeof item?.access === "string" ? item.access.trim() : "";
    if (!path || !access) {
      continue;
    }
    count += 1;
    if (access !== "none") {
      for (const risk of permissionPathRisks(path)) {
        risks.add(risk);
      }
    }
    if (samples.length < PERMISSION_SAMPLE_LIMIT) {
      samples.push(`${sanitizePermissionScalar(access)} ${sanitizePermissionPathValue(path)}`);
    }
  }
  if (count === 0) {
    return undefined;
  }
  const remaining = count - samples.length;
  const remainderSuffix = remaining > 0 ? ` (+${remaining} more)` : "";
  return `entries: ${samples.join(", ")}${remainderSuffix}`;
}

function summarizePermissionRecord(
  permission: JsonObject,
  risks: Set<string>,
  descriptors: readonly PermissionArrayDescriptor[],
): string | undefined {
  return (
    descriptors
      .map((descriptor) => summarizePermissionArray(permission, descriptor, risks))
      .filter(Boolean)
      .join("; ") || undefined
  );
}

function summarizePermissionArray(
  record: JsonObject,
  descriptor: PermissionArrayDescriptor,
  risks: Set<string>,
): string | undefined {
  const values = normalizeTrimmedStringList(record[descriptor.key]);
  if (values.length === 0) {
    return undefined;
  }
  for (const value of values) {
    for (const risk of descriptor.risksFor(value)) {
      risks.add(risk);
    }
  }
  const sampleValues = values
    .slice(0, PERMISSION_SAMPLE_LIMIT)
    .map(descriptor.sanitize)
    .filter(Boolean);
  if (sampleValues.length === 0) {
    return `${descriptor.label}: ${values.length}`;
  }
  const remaining = values.length - sampleValues.length;
  const remainderSuffix = remaining > 0 ? ` (+${remaining} more)` : "";
  return `${descriptor.label}: ${sampleValues.join(", ")}${remainderSuffix}`;
}

function summarizeStringArray(
  value: JsonValue | undefined,
  label: string,
  sanitize: (value: string) => string,
): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => sanitize(entry))
    .filter(Boolean);
  if (values.length === 0) {
    return undefined;
  }
  const samples = values.slice(0, PERMISSION_SAMPLE_LIMIT);
  const remaining = values.length - samples.length;
  const remainderSuffix = remaining > 0 ? ` (+${remaining} more)` : "";
  return `${label}: ${samples.join(", ")}${remainderSuffix}`;
}

function summarizeNetworkPolicyAmendments(value: JsonValue | undefined): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const samples: string[] = [];
  let count = 0;
  for (const entry of value) {
    const amendment = isJsonObject(entry) ? entry : undefined;
    const host = typeof amendment?.host === "string" ? amendment.host : "";
    const action = typeof amendment?.action === "string" ? amendment.action : "";
    if (!host || !action) {
      continue;
    }
    count += 1;
    if (samples.length < PERMISSION_SAMPLE_LIMIT) {
      samples.push(`${sanitizePermissionScalar(action)} ${sanitizePermissionHostValue(host)}`);
    }
  }
  if (count === 0) {
    return undefined;
  }
  const remaining = count - samples.length;
  const remainderSuffix = remaining > 0 ? ` (+${remaining} more)` : "";
  return `Proposed network policy: ${samples.join(", ")}${remainderSuffix}`;
}

function sanitizePermissionHostValue(value: string): string {
  const compact = sanitizePermissionScalar(value).toLowerCase();
  const withoutScheme = compact.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? withoutScheme;
  const withoutUserInfo = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  return truncate(withoutUserInfo, PERMISSION_VALUE_MAX_LENGTH);
}

function sanitizePermissionPathValue(value: string): string {
  return truncate(
    formatApprovalDisplayPath(sanitizePermissionScalar(value)),
    PERMISSION_VALUE_MAX_LENGTH,
  );
}

function sanitizePermissionScalar(value: string): string {
  return sanitizeCodexApprovalVisibleText(value);
}

function permissionHostRisks(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  const risks: string[] = [];
  if (normalized.includes("*")) {
    risks.push("wildcard hosts");
    if (isPrivateNetworkHostPattern(normalized)) {
      risks.push("private-network wildcards");
    }
  }
  return risks;
}

function permissionPathRisks(value: string): string[] {
  const normalized = sanitizePermissionScalar(value);
  const risks: string[] = [];
  if (normalized === "/" || normalized === "\\" || /^[A-Za-z]:[\\/]*$/.test(normalized)) {
    risks.push("filesystem root");
  }
  return risks;
}

function isPrivateNetworkHostPattern(value: string): boolean {
  const normalized = value.toLowerCase();
  const wildcardStripped = normalized.replace(/^\*\./, "");
  if (
    wildcardStripped === "localhost" ||
    wildcardStripped === "local" ||
    wildcardStripped === "internal" ||
    wildcardStripped === "lan" ||
    wildcardStripped === "home" ||
    wildcardStripped === "corp" ||
    wildcardStripped === "private" ||
    wildcardStripped.endsWith(".local") ||
    wildcardStripped.endsWith(".internal") ||
    wildcardStripped.endsWith(".lan") ||
    wildcardStripped.endsWith(".home") ||
    wildcardStripped.endsWith(".corp") ||
    wildcardStripped.endsWith(".private")
  ) {
    return true;
  }
  if (
    wildcardStripped.startsWith("10.") ||
    wildcardStripped.startsWith("127.") ||
    wildcardStripped.startsWith("192.168.") ||
    wildcardStripped.startsWith("169.254.")
  ) {
    return true;
  }
  return /^172\.(1[6-9]|2\d|3[0-1])\./.test(wildcardStripped);
}

function commandApprovalCapabilities(requestParams: JsonObject | undefined): {
  once: boolean;
  sessionDecision?: JsonValue;
} {
  const available = requestParams?.availableDecisions;
  if (!Array.isArray(available)) {
    return { once: true, sessionDecision: "acceptForSession" };
  }
  return {
    once: available.includes("accept"),
    ...(available.includes("acceptForSession")
      ? { sessionDecision: "acceptForSession" }
      : { sessionDecision: findAvailableCommandAmendmentDecision(requestParams) }),
  };
}

function findAvailableCommandAmendmentDecision(
  requestParams: JsonObject | undefined,
): JsonValue | undefined {
  const available = requestParams?.availableDecisions;
  if (!Array.isArray(available)) {
    return undefined;
  }
  return available.find(
    (entry): entry is JsonObject =>
      isJsonObject(entry) &&
      (isJsonObject(entry.acceptWithExecpolicyAmendment) ||
        isJsonObject(entry.applyNetworkPolicyAmendment)),
  );
}

function approvalResolutionMessage(outcome: AppServerApprovalOutcome): string {
  return {
    "approved-session": "Codex app-server approval granted for the session.",
    "approved-once": "Codex app-server approval granted for this turn.",
    cancelled: "Codex app-server approval cancelled.",
    unavailable: "Codex app-server approval unavailable.",
    denied: "Codex app-server approval denied.",
  }[outcome];
}

function approvalEventScope(
  method: string,
  outcome: AppServerApprovalOutcome,
): Pick<AgentApprovalEventData, "scope"> {
  return method === "item/permissions/requestApproval"
    ? { scope: outcome === "approved-session" ? "session" : "turn" }
    : {};
}

function emitApprovalEvent(params: EmbeddedRunAttemptParams, data: AgentApprovalEventData): void {
  void params.onAgentEvent?.({
    stream: "approval",
    data: { ...data },
  });
}

function readDisplayCommandPreview(
  record: JsonObject | undefined,
): ApprovalPreviewSource | undefined {
  const actionCommand = readCommandActionsPreview(record);
  if (actionCommand) {
    return actionCommand;
  }
  return readCommandPreview(record);
}

function readPolicyCommand(record: JsonObject | undefined): string | undefined {
  const command = record?.command;
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command) && command.every((part): part is string => typeof part === "string")) {
    return command.join(" ");
  }
  const actionCommands = readCommandActions(record);
  if (actionCommands.length > 0) {
    return actionCommands.join(" && ");
  }
  return undefined;
}

function readNetworkApprovalContext(
  record: JsonObject | undefined,
): { host: string; protocol: string } | undefined {
  const context = isJsonObject(record?.networkApprovalContext)
    ? record.networkApprovalContext
    : undefined;
  const host = readString(context, "host");
  const protocol = readString(context, "protocol");
  return host && protocol ? { host, protocol } : undefined;
}

function readCommandActions(record: JsonObject | undefined): string[] {
  const actions = record?.commandActions;
  if (!Array.isArray(actions)) {
    return [];
  }
  return actions
    .map((action) => (isJsonObject(action) ? readString(action, "command") : undefined))
    .filter((command): command is string => Boolean(command));
}

function readCommandActionsPreview(
  record: JsonObject | undefined,
): ApprovalPreviewSource | undefined {
  let source: ApprovalPreviewSource | undefined;
  for (const command of readCommandActions(record)) {
    source = appendPreviewPart(source, command, " && ");
    if (source.clipped) {
      break;
    }
  }
  return source;
}

function readCommandPreview(record: JsonObject | undefined): ApprovalPreviewSource | undefined {
  const command = record?.command;
  if (typeof command === "string") {
    return previewSource(command);
  }
  if (!Array.isArray(command)) {
    return undefined;
  }
  let source: ApprovalPreviewSource | undefined;
  for (const part of command) {
    if (typeof part !== "string") {
      return undefined;
    }
    source = appendPreviewPart(source, part, " ");
    if (source.clipped) {
      break;
    }
  }
  return source;
}

function readStringPreview(
  record: JsonObject | undefined,
  key: string,
): ApprovalPreviewSource | undefined {
  const value = readString(record, key);
  return value === undefined ? undefined : previewSource(value);
}

function previewSource(value: string): ApprovalPreviewSource {
  return {
    value: sliceUtf16Safe(value, 0, APPROVAL_PREVIEW_SCAN_MAX_LENGTH),
    clipped: value.length > APPROVAL_PREVIEW_SCAN_MAX_LENGTH,
  };
}

function appendPreviewPart(
  source: ApprovalPreviewSource | undefined,
  part: string,
  separator: string,
): ApprovalPreviewSource {
  const prefix = source?.value ? `${source.value}${separator}` : "";
  const value = `${prefix}${part}`;
  const clipped = source?.clipped === true || value.length > APPROVAL_PREVIEW_SCAN_MAX_LENGTH;
  return {
    value: sliceUtf16Safe(value, 0, APPROVAL_PREVIEW_SCAN_MAX_LENGTH),
    clipped,
  };
}

function sanitizeApprovalPreview(
  source: ApprovalPreviewSource | undefined,
  maxLength: number,
): SanitizedApprovalPreview {
  if (!source || !source.value) {
    return { omitted: false };
  }
  const rawPreview = stripDanglingCodexApprovalTerminalSequence(source.value);
  const sanitized = sanitizeCodexApprovalVisibleText(rawPreview);
  if (!sanitized) {
    return { omitted: true };
  }
  return { text: formatCodexDisplayText(truncate(sanitized, maxLength)), omitted: source.clipped };
}

function formatApprovalPreviewSubject(text: string, omitted: boolean): string {
  return omitted ? `${text} ${APPROVAL_PREVIEW_OMITTED}` : text;
}

function joinDescriptionLinesWithinLimit(lines: string[], maxLength: number): string {
  let description = "";
  for (const line of lines) {
    const prefix = description ? "\n" : "";
    const next = `${description}${prefix}${line}`;
    if (next.length <= maxLength) {
      description = next;
      continue;
    }
    const remaining = maxLength - description.length - prefix.length;
    if (remaining < 3) {
      break;
    }
    description += `${prefix}${truncate(line, remaining)}`;
    break;
  }
  return description;
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
