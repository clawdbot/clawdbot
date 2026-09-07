/**
 * Approval transport for before_tool_call policy decisions.
 * Owns request/wait routing, embedded approval bridging, deferred approvals,
 * timeout classification, and owner-provided approval outcomes.
 */
import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import { getRuntimeConfig } from "../config/config.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { sanitizeApprovalScope } from "../infra/approval-scope.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { getEmbeddedPluginApprovalBroker } from "../infra/embedded-plugin-approval-broker.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  describeNativePluginApprovalClientSetup,
  resolveApprovalInitiatingSurfaceState,
} from "../infra/exec-approval-surface.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "../infra/plugin-approval-canonical-decisions.js";
import {
  DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS,
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
} from "../infra/plugin-approvals.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { cloneHookIsolationValue } from "../plugins/hook-isolation.js";
import {
  PluginApprovalResolutions,
  type PluginApprovalResolution,
  type PluginHookBeforeToolCallResult,
} from "../plugins/types.js";
import { resolveSkillWorkshopToolApproval } from "../skills/workshop/policy.js";
import { isPlainObject } from "../utils.js";
import { resolveToolErrorDiagnostic } from "./agent-tools.before-tool-call.diagnostics.js";
import type {
  DeferredPluginToolApproval,
  HookContext,
  HookOutcome,
} from "./agent-tools.before-tool-call.types.js";
import { withGatewayToolApprovalOwner } from "./tools/gateway-caller-context.js";
import { callGatewayTool } from "./tools/gateway.js";

type PluginApprovalRequest = NonNullable<PluginHookBeforeToolCallResult["requireApproval"]>;
const log = createSubsystemLogger("agents/tools");

function pluginApprovalDeniedOutcome(baseParams: unknown): HookOutcome {
  return {
    blocked: true,
    kind: "failure",
    disposition: "blocked",
    deniedReason: "plugin-approval",
    reason: [
      "Denied by user. The tool call did not run.",
      "This denial is final: the approval request is closed. Do not mention /approve or any other approval command to the user.",
      "Do not run the tool call again or ask the user to approve it again.",
      "If the user still wants the action, explain that a new tool call will trigger a fresh approval request.",
    ].join("\n"),
    params: baseParams,
  };
}

function resolvePluginToolApprovalTimeoutMs(approval: PluginApprovalRequest): number {
  if (
    typeof approval.timeoutMs !== "number" ||
    !Number.isFinite(approval.timeoutMs) ||
    approval.timeoutMs <= 0
  ) {
    return DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;
  }
  return Math.min(Math.floor(approval.timeoutMs), MAX_PLUGIN_APPROVAL_TIMEOUT_MS);
}

function resolvePluginToolApprovalGatewayTimeoutMs(timeoutMs: number): number {
  return addTimerTimeoutGraceMs(timeoutMs, 10_000) ?? DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000;
}

export function mergeParamsWithApprovalOverrides(
  originalParams: unknown,
  approvalParams?: unknown,
): unknown {
  if (approvalParams && isPlainObject(approvalParams)) {
    if (isPlainObject(originalParams)) {
      return { ...originalParams, ...approvalParams };
    }
    return approvalParams;
  }
  return originalParams;
}

const warnedDeprecatedTimeoutBehaviorPluginIds = new Set<string>();

function warnDeprecatedApprovalTimeoutBehavior(approval: PluginApprovalRequest): void {
  if (approval.timeoutBehavior !== "allow") {
    return;
  }
  const pluginId = approval.pluginId ?? "unknown-plugin";
  if (warnedDeprecatedTimeoutBehaviorPluginIds.has(pluginId)) {
    return;
  }
  warnedDeprecatedTimeoutBehaviorPluginIds.add(pluginId);
  log.warn(
    `plugin '${pluginId}' sets deprecated requireApproval.timeoutBehavior:"allow"; the field is ignored and approvals fail closed on timeout (see docs/plugins/plugin-permission-requests.md)`,
  );
}

function notifyPluginApprovalResolution(
  approval: PluginApprovalRequest,
  resolution: PluginApprovalResolution,
): void {
  const onResolution = approval.onResolution;
  if (typeof onResolution !== "function") {
    return;
  }
  try {
    void Promise.resolve(onResolution(resolution)).catch((err: unknown) => {
      log.warn(`plugin onResolution callback failed: ${String(err)}`);
    });
  } catch (err) {
    log.warn(`plugin onResolution callback failed: ${String(err)}`);
  }
}

function resolvePermittedPluginApprovalResolution(
  decision: unknown,
  allowedDecisions: readonly string[],
): PluginApprovalResolution {
  if (
    (decision === PluginApprovalResolutions.ALLOW_ONCE ||
      decision === PluginApprovalResolutions.ALLOW_ALWAYS ||
      decision === PluginApprovalResolutions.DENY) &&
    allowedDecisions.includes(decision)
  ) {
    return decision;
  }
  return PluginApprovalResolutions.TIMEOUT;
}

function buildPluginApprovalFailureReason(params: {
  fallbackReason: string;
  ctx?: HookContext;
}): string {
  const turnSourceChannel = params.ctx?.turnSourceChannel;
  if (!turnSourceChannel?.trim()) {
    return params.fallbackReason;
  }
  const nativePluginSurface = resolveApprovalInitiatingSurfaceState({
    channel: turnSourceChannel,
    accountId: params.ctx?.turnSourceAccountId,
    cfg: params.ctx?.config,
    approvalKind: "plugin",
  });
  const setupText = describeNativePluginApprovalClientSetup({
    channel: nativePluginSurface.channel,
    channelLabel: nativePluginSurface.channelLabel,
    accountId: nativePluginSurface.accountId,
  });
  if (!setupText) {
    return params.fallbackReason;
  }
  const nativeDeliverySurface =
    nativePluginSurface.kind === "disabled"
      ? nativePluginSurface
      : resolveApprovalInitiatingSurfaceState({
          channel: turnSourceChannel,
          accountId: params.ctx?.turnSourceAccountId,
          cfg: params.ctx?.config,
          approvalKind: "exec",
        });
  if (nativeDeliverySurface.kind !== "disabled") {
    return params.fallbackReason;
  }
  return `${params.fallbackReason}\n\n${setupText}`;
}

function resolveUnavailablePluginApprovalSurfaceReason(ctx?: HookContext): string | undefined {
  const trigger = ctx?.trigger?.trim();
  // Legacy/internal callers without run provenance still rely on the Gateway's
  // live-client check. Embedded agent runs always carry an explicit trigger.
  if (!trigger) {
    return undefined;
  }
  const initiatingSurface = resolveApprovalInitiatingSurfaceState({
    channel: ctx?.turnSourceChannel,
    accountId: ctx?.turnSourceAccountId,
    cfg: ctx?.config,
    approvalKind: "plugin",
  });
  if (trigger !== "user") {
    return `Plugin approval unavailable: ${trigger} runs have no approval-capable initiating surface.`;
  }
  if (!ctx?.turnSourceChannel?.trim() && !ctx?.approvalReviewerDeviceId?.trim()) {
    return "Plugin approval unavailable: non-interactive CLI runs have no approval-capable initiating surface.";
  }
  if (initiatingSurface.kind === "disabled") {
    return `Plugin approval unavailable: the ${initiatingSurface.channelLabel} initiating surface is disabled.`;
  }
  if (initiatingSurface.kind === "unsupported") {
    return `Plugin approval unavailable: the ${initiatingSurface.channelLabel} initiating surface does not support approvals.`;
  }
  return undefined;
}

async function requestPluginToolApproval(params: {
  approval: PluginApprovalRequest;
  toolName: string;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
  baseParams: unknown;
  overrideParams?: unknown;
}): Promise<HookOutcome> {
  const approval = params.approval;
  const timeoutMs = resolvePluginToolApprovalTimeoutMs(approval);
  const gatewayTimeoutMs = resolvePluginToolApprovalGatewayTimeoutMs(timeoutMs);
  const allowedDecisions = resolveCanonicalPluginApprovalRequestAllowedDecisions(approval);
  let gatewayApprovalPhase: "none" | "request" | "wait" = "none";
  try {
    const embeddedApprovalBroker = isEmbeddedMode() ? getEmbeddedPluginApprovalBroker() : null;
    if (embeddedApprovalBroker) {
      const result = await embeddedApprovalBroker.request({
        request: {
          pluginId: approval.pluginId,
          title: approval.title,
          description: approval.description,
          ...(approval.scope ? { scope: sanitizeApprovalScope(approval.scope) } : {}),
          severity: approval.severity,
          allowedDecisions: approval.allowedDecisions,
          toolName: params.toolName,
          toolCallId: params.toolCallId,
          agentId: params.ctx?.agentId,
          sessionKey: params.ctx?.sessionKey,
          turnSourceChannel: params.ctx?.turnSourceChannel,
          turnSourceTo: params.ctx?.turnSourceTo,
          turnSourceAccountId: params.ctx?.turnSourceAccountId,
          turnSourceThreadId: params.ctx?.turnSourceThreadId,
        },
        timeoutMs,
        signal: params.signal,
      });
      const decision = result.decision;
      const resolution = resolvePermittedPluginApprovalResolution(decision, allowedDecisions);
      notifyPluginApprovalResolution(approval, resolution);
      if (
        resolution === PluginApprovalResolutions.ALLOW_ONCE ||
        resolution === PluginApprovalResolutions.ALLOW_ALWAYS
      ) {
        return {
          blocked: false,
          params: mergeParamsWithApprovalOverrides(params.baseParams, params.overrideParams),
          approvalResolution: resolution,
        };
      }
      if (resolution === PluginApprovalResolutions.DENY) {
        return pluginApprovalDeniedOutcome(params.baseParams);
      }
      // Veto carries the plugin-supplied reason; plain timeouts record a
      // timed_out failure disposition for the audit ledger.
      return approval.timeoutReason
        ? {
            blocked: true,
            kind: "veto",
            deniedReason: "plugin-approval",
            reason: approval.timeoutReason,
            params: params.baseParams,
          }
        : {
            blocked: true,
            kind: "failure",
            disposition: "timed_out",
            deniedReason: "plugin-approval",
            reason: "Approval timed out",
            params: params.baseParams,
          };
    }

    const unavailableSurfaceReason = resolveUnavailablePluginApprovalSurfaceReason(params.ctx);
    if (unavailableSurfaceReason) {
      notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
      return {
        blocked: true,
        kind: "failure",
        disposition: "failed",
        deniedReason: "plugin-approval-unavailable",
        reason: unavailableSurfaceReason,
        params: params.baseParams,
      };
    }

    gatewayApprovalPhase = "request";
    const requestResult: {
      id?: string;
      status?: string;
      decision?: unknown;
      deliveryRoute?: string;
    } = await withGatewayToolApprovalOwner(
      approval.pluginId,
      async () =>
        await callGatewayTool(
          "plugin.approval.request",
          // Buffer beyond the approval timeout so the gateway can clean up
          // and respond before the client-side RPC timeout fires.
          { timeoutMs: gatewayTimeoutMs },
          {
            title: approval.title,
            description: approval.description,
            ...(approval.scope ? { scope: approval.scope } : {}),
            severity: approval.severity,
            allowedDecisions: approval.allowedDecisions,
            toolName: params.toolName,
            toolCallId: params.toolCallId,
            agentId: params.ctx?.agentId,
            sessionKey: params.ctx?.sessionKey,
            ...(params.ctx?.approvalReviewerDeviceId
              ? { approvalReviewerDeviceIds: [params.ctx.approvalReviewerDeviceId] }
              : {}),
            turnSourceChannel: params.ctx?.turnSourceChannel,
            turnSourceTo: params.ctx?.turnSourceTo,
            turnSourceAccountId: params.ctx?.turnSourceAccountId,
            turnSourceThreadId: params.ctx?.turnSourceThreadId,
            timeoutMs,
            twoPhase: true,
          },
          { expectFinal: false, signal: params.signal },
        ),
    );
    gatewayApprovalPhase = "none";
    const id = requestResult?.id;
    if (!id) {
      notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
      return {
        blocked: true,
        kind: "failure",
        disposition: "failed",
        deniedReason: "plugin-approval",
        reason: approval.description || "Plugin approval request failed",
        params: params.baseParams,
      };
    }
    const hasImmediateDecision = Object.hasOwn(requestResult ?? {}, "decision");
    let decision: unknown;
    if (hasImmediateDecision) {
      decision = requestResult?.decision;
      if (decision === null) {
        notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
        return {
          blocked: true,
          kind: "failure",
          disposition: "failed",
          deniedReason: "plugin-approval",
          reason: buildPluginApprovalFailureReason({
            fallbackReason: "Plugin approval unavailable (no approval route)",
            ctx: params.ctx,
          }),
          params: params.baseParams,
        };
      }
    } else {
      // Wait for the decision, but abort early if the agent run is cancelled
      // so the user isn't blocked for the full approval timeout.
      gatewayApprovalPhase = "wait";
      const waitResult: {
        id?: string;
        decision?: unknown;
      } = await callGatewayTool(
        "plugin.approval.waitDecision",
        // Buffer beyond the approval timeout so the gateway can clean up
        // and respond before the client-side RPC timeout fires.
        { timeoutMs: gatewayTimeoutMs },
        { id },
        { signal: params.signal },
      );
      // Bind the verdict to the request that parked this call. A stale or
      // misrouted reply must never release a different tool gate.
      decision = waitResult?.id === id ? waitResult.decision : undefined;
    }
    const resolution = resolvePermittedPluginApprovalResolution(decision, allowedDecisions);
    notifyPluginApprovalResolution(approval, resolution);
    if (
      resolution === PluginApprovalResolutions.ALLOW_ONCE ||
      resolution === PluginApprovalResolutions.ALLOW_ALWAYS
    ) {
      return {
        blocked: false,
        params: mergeParamsWithApprovalOverrides(params.baseParams, params.overrideParams),
        approvalResolution: resolution,
      };
    }
    if (resolution === PluginApprovalResolutions.DENY) {
      return pluginApprovalDeniedOutcome(params.baseParams);
    }
    const fallbackTimeoutReason = approval.timeoutReason ?? "Approval timed out";
    const timeoutReason =
      requestResult?.deliveryRoute === "turn-source"
        ? buildPluginApprovalFailureReason({
            fallbackReason: fallbackTimeoutReason,
            ctx: params.ctx,
          })
        : fallbackTimeoutReason;
    return {
      blocked: true,
      kind: approval.timeoutReason ? "veto" : "failure",
      disposition: "timed_out",
      deniedReason: "plugin-approval",
      reason: timeoutReason,
      params: params.baseParams,
    };
  } catch (err) {
    notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
    const signal = params.signal;
    const abortCancelled =
      signal?.aborted === true &&
      (err === signal.reason ||
        (err instanceof Error &&
          (err.name === "AbortError" || ("cause" in err && err.cause === signal.reason))));
    if (abortCancelled) {
      log.warn(`plugin approval wait cancelled by run abort: ${String(err)}`);
      return {
        blocked: true,
        kind: "failure",
        disposition: resolveToolErrorDiagnostic(err, signal).terminalReason,
        deniedReason: "plugin-approval",
        reason: "Approval cancelled (run aborted)",
        params: params.baseParams,
      };
    }
    // INVALID_REQUEST means different things before and after registration.
    const invalidRequest =
      err instanceof GatewayClientRequestError && err.gatewayCode === "INVALID_REQUEST";
    const reason =
      invalidRequest && gatewayApprovalPhase === "request"
        ? `Plugin approval request rejected: ${formatErrorMessage(err)}`
        : invalidRequest && gatewayApprovalPhase === "wait"
          ? `Plugin approval no longer available: ${formatErrorMessage(err)}`
          : "Plugin approval required (gateway unavailable)";
    log.warn(`plugin approval gateway request failed; blocking tool call: ${String(err)}`);
    return {
      blocked: true,
      kind: "failure",
      disposition: resolveToolErrorDiagnostic(err, signal).terminalReason,
      deniedReason: "plugin-approval",
      reason,
      params: params.baseParams,
    };
  }
}

/** Resolve a deferred plugin approval request at the later execution boundary. */
export async function requestDeferredPluginToolApproval(params: {
  deferredApproval: DeferredPluginToolApproval;
  signal?: AbortSignal;
}): Promise<HookOutcome> {
  const deferred = params.deferredApproval;
  return requestPluginToolApproval({
    approval: deferred.approval,
    toolName: deferred.toolName,
    ...(deferred.toolCallId ? { toolCallId: deferred.toolCallId } : {}),
    ...(deferred.ctx ? { ctx: deferred.ctx } : {}),
    signal: params.signal,
    baseParams: deferred.baseParams,
    overrideParams: deferred.overrideParams,
  });
}

/** Notify plugin approval callbacks that a deferred approval was cancelled. */
export function cancelDeferredPluginToolApproval(
  deferredApproval: DeferredPluginToolApproval,
): void {
  notifyPluginApprovalResolution(deferredApproval.approval, PluginApprovalResolutions.CANCELLED);
}

export async function resolveBeforeToolCallApprovalOutcome(params: {
  result: PluginHookBeforeToolCallResult | undefined;
  approvalMode?: "request" | "report" | "deny" | "defer";
  toolName: string;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
  baseParams: unknown;
}): Promise<HookOutcome | undefined> {
  const approval = params.result?.requireApproval;
  if (!approval) {
    return undefined;
  }
  // Detach the approval payload from plugin- and caller-owned objects before
  // the request can outlive this policy pass.
  const baseParamsSnapshot = cloneHookIsolationValue("before_tool_call", params.baseParams);
  const overrideParamsSnapshot =
    params.result?.params === undefined
      ? undefined
      : cloneHookIsolationValue("before_tool_call", params.result.params);
  warnDeprecatedApprovalTimeoutBehavior(approval);
  if (params.approvalMode === "defer") {
    return {
      blocked: false,
      params: cloneHookIsolationValue("before_tool_call", baseParamsSnapshot),
      deferredApproval: {
        approval,
        toolName: params.toolName,
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
        ...(params.ctx ? { ctx: params.ctx } : {}),
        baseParams: baseParamsSnapshot,
        overrideParams: overrideParamsSnapshot,
      },
    };
  }
  if (params.approvalMode === "report") {
    notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
    return {
      blocked: true,
      kind: "failure",
      disposition: "blocked",
      deniedReason: "plugin-approval",
      reason: approval.description || approval.title || "Plugin approval required",
      params: baseParamsSnapshot,
    };
  }
  if (params.approvalMode === "deny") {
    notifyPluginApprovalResolution(approval, PluginApprovalResolutions.DENY);
    return {
      blocked: true,
      kind: "veto",
      deniedReason: "plugin-approval",
      reason: "approval_required",
      params: baseParamsSnapshot,
    };
  }
  return await requestPluginToolApproval({
    approval,
    toolName: params.toolName,
    ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    ...(params.ctx ? { ctx: params.ctx } : {}),
    signal: params.signal,
    baseParams: baseParamsSnapshot,
    overrideParams: overrideParamsSnapshot,
  });
}

export async function resolveSkillWorkshopApprovalForFinalParams(params: {
  toolName: string;
  params: unknown;
  approvalMode?: "request" | "report" | "deny" | "defer";
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
}): Promise<HookOutcome | undefined> {
  if (params.toolName !== "skill_workshop") {
    return undefined;
  }
  const result = await resolveSkillWorkshopToolApproval({
    toolName: params.toolName,
    toolParams: isPlainObject(params.params) ? params.params : {},
    config: params.ctx?.config ?? getRuntimeConfig(),
    ...(params.ctx?.agentId ? { agentId: params.ctx.agentId } : {}),
    ...(params.ctx?.workspaceDir ? { workspaceDir: params.ctx.workspaceDir } : {}),
  });
  return await resolveBeforeToolCallApprovalOutcome({
    result,
    approvalMode: params.approvalMode,
    toolName: params.toolName,
    ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    ...(params.ctx ? { ctx: params.ctx } : {}),
    signal: params.signal,
    baseParams: params.params,
  });
}
