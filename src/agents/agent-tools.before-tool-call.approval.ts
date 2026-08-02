/**
 * Approval policy for before_tool_call decisions.
 * Applies host-provided decisions to hook policy, deferred approvals, timeout
 * classification, and owner-provided approval outcomes.
 */
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

type PluginApprovalRequest = NonNullable<PluginHookBeforeToolCallResult["requireApproval"]>;
const log = createSubsystemLogger("agents/tools");

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
  if (!ctx?.turnSourceChannel?.trim() && !ctx?.approvalHost?.plugin) {
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
  const allowedDecisions = resolveCanonicalPluginApprovalRequestAllowedDecisions(approval);
  try {
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
    const approvalHost = params.ctx?.approvalHost?.plugin;
    if (!approvalHost) {
      notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
      return {
        blocked: true,
        kind: "failure",
        disposition: "failed",
        deniedReason: "plugin-approval-unavailable",
        reason: "Plugin approval unavailable: this run has no approval host.",
        params: params.baseParams,
      };
    }
    const hostResult = await approvalHost.request({
      request: {
        pluginId: approval.pluginId,
        title: approval.title,
        description: approval.description,
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
    if (params.signal?.aborted) {
      throw params.signal.reason ?? new Error("approval request aborted");
    }
    if (hostResult.outcome === "unavailable") {
      notifyPluginApprovalResolution(approval, PluginApprovalResolutions.CANCELLED);
      return {
        blocked: true,
        kind: "failure",
        disposition: "failed",
        deniedReason: "plugin-approval",
        reason: buildPluginApprovalFailureReason({
          fallbackReason: hostResult.reason,
          ctx: params.ctx,
        }),
        params: params.baseParams,
      };
    }

    const decision = hostResult.outcome === "resolved" ? hostResult.decision : undefined;
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
      return {
        blocked: true,
        kind: "failure",
        disposition: "blocked",
        deniedReason: "plugin-approval",
        reason: "Denied by user",
        params: params.baseParams,
      };
    }
    const fallbackTimeoutReason = approval.timeoutReason ?? "Approval timed out";
    const timeoutReason =
      hostResult.outcome === "timed-out" && hostResult.deliveryRoute === "turn-source"
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
    log.warn(`plugin approval host request failed; blocking tool call: ${String(err)}`);
    return {
      blocked: true,
      kind: "failure",
      disposition: resolveToolErrorDiagnostic(err, signal).terminalReason,
      deniedReason: "plugin-approval",
      reason: "Plugin approval required (approval host unavailable)",
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
  const result = await resolveSkillWorkshopToolApproval({
    toolName: params.toolName,
    toolParams: isPlainObject(params.params) ? params.params : {},
    ...(params.ctx?.config ? { config: params.ctx.config } : {}),
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
