// Builds approval prompt view models from request and resolution events.
import { summarizeApprovalScope } from "./approval-scope.js";
import { normalizeApprovalRequest } from "./approval-types.js";
import type {
  ApprovalMetadataView,
  ApprovalRequest,
  ApprovalResolved,
  ExecApprovalViewBase,
  ExpiredApprovalView,
  PendingApprovalView,
  PluginApprovalViewBase,
  ResolvedApprovalView,
} from "./approval-view-model.types.js";
import { resolveExecApprovalCommandDisplay } from "./exec-approval-command-display.js";
import { buildTypedApprovalActionDescriptors } from "./exec-approval-reply.js";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequest,
} from "./exec-approvals.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "./plugin-approval-canonical-decisions.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ApprovalPhase = "pending" | "resolved" | "expired";

function buildExecMetadata(request: ExecApprovalRequest): ApprovalMetadataView[] {
  const metadata: ApprovalMetadataView[] = [];
  if (request.request.agentId) {
    metadata.push({ label: "Agent", value: request.request.agentId });
  }
  if (request.request.cwd) {
    metadata.push({ label: "CWD", value: request.request.cwd });
  }
  if (request.request.host) {
    metadata.push({ label: "Host", value: request.request.host });
  }
  if (Array.isArray(request.request.envKeys) && request.request.envKeys.length > 0) {
    metadata.push({ label: "Env Overrides", value: request.request.envKeys.join(", ") });
  }
  if (request.request.scope) {
    metadata.push({ label: "Scope", value: summarizeApprovalScope(request.request.scope) });
  }
  return metadata;
}

function buildPluginMetadata(request: PluginApprovalRequest): ApprovalMetadataView[] {
  const metadata: ApprovalMetadataView[] = [];
  const severity = request.request.severity ?? "warning";
  metadata.push({
    label: "Severity",
    value: severity === "critical" ? "Critical" : severity === "info" ? "Info" : "Warning",
  });
  if (request.request.toolName) {
    metadata.push({ label: "Tool", value: request.request.toolName });
  }
  if (request.request.pluginId) {
    metadata.push({ label: "Plugin", value: request.request.pluginId });
  }
  if (request.request.agentId) {
    metadata.push({ label: "Agent", value: request.request.agentId });
  }
  if (request.request.scope) {
    metadata.push({ label: "Scope", value: summarizeApprovalScope(request.request.scope) });
  }
  return metadata;
}

function buildExecViewBase<TPhase extends ApprovalPhase>(
  request: ExecApprovalRequest,
  phase: TPhase,
): ExecApprovalViewBase & { phase: TPhase } {
  const { commandText, commandPreview } = resolveExecApprovalCommandDisplay(request.request);
  return {
    approvalId: request.id,
    approvalKind: "exec",
    phase,
    title: phase === "pending" ? "Exec Approval Required" : "Exec Approval",
    description: phase === "pending" ? "A command needs your approval." : null,
    metadata: buildExecMetadata(request),
    ask: request.request.ask ?? null,
    agentId: request.request.agentId ?? null,
    warningText: request.request.warningText ?? null,
    commandAnalysis: request.request.commandAnalysis ?? null,
    commandText,
    commandPreview,
    cwd: request.request.cwd ?? null,
    envKeys: request.request.envKeys ?? undefined,
    host: request.request.host ?? null,
    nodeId: request.request.nodeId ?? null,
    ...(request.request.scope ? { scope: request.request.scope } : {}),
    sessionKey: request.request.sessionKey ?? null,
  };
}

function buildPluginViewBase<TPhase extends ApprovalPhase>(
  request: PluginApprovalRequest,
  phase: TPhase,
): PluginApprovalViewBase & { phase: TPhase } {
  return {
    approvalId: request.id,
    approvalKind: "plugin",
    phase,
    title: request.request.title,
    description: request.request.description ?? null,
    metadata: buildPluginMetadata(request),
    agentId: request.request.agentId ?? null,
    pluginId: request.request.pluginId ?? null,
    ...(request.request.scope ? { scope: request.request.scope } : {}),
    toolName: request.request.toolName ?? null,
    severity: request.request.severity ?? "warning",
  };
}

/** Builds the presentation model for an unresolved exec or plugin approval. */
export function buildPendingApprovalView(request: ApprovalRequest): PendingApprovalView {
  const normalizedRequest = normalizeApprovalRequest(request);
  if (normalizedRequest.approvalKind === "plugin") {
    return {
      ...buildPluginViewBase(normalizedRequest, "pending"),
      actions: buildTypedApprovalActionDescriptors({
        approvalCommandId: normalizedRequest.id,
        approvalKind: normalizedRequest.approvalKind,
        allowedDecisions: resolveCanonicalPluginApprovalRequestAllowedDecisions(
          normalizedRequest.request,
        ),
      }),
      expiresAtMs: normalizedRequest.expiresAtMs,
    };
  }
  return {
    ...buildExecViewBase(normalizedRequest, "pending"),
    actions: buildTypedApprovalActionDescriptors({
      approvalCommandId: normalizedRequest.id,
      approvalKind: normalizedRequest.approvalKind,
      ask: normalizedRequest.request.ask,
      allowedDecisions: resolveExecApprovalRequestAllowedDecisions(normalizedRequest.request),
    }),
    expiresAtMs: normalizedRequest.expiresAtMs,
  };
}

/** Builds the presentation model for an approval after a decision was recorded. */
export function buildResolvedApprovalView(
  request: ApprovalRequest,
  resolved: ApprovalResolved,
): ResolvedApprovalView {
  const normalizedRequest = normalizeApprovalRequest(request);
  if (normalizedRequest.approvalKind === "plugin") {
    return {
      ...buildPluginViewBase(normalizedRequest, "resolved"),
      decision: resolved.decision,
      resolvedBy: resolved.resolvedBy,
    };
  }
  return {
    ...buildExecViewBase(normalizedRequest, "resolved"),
    decision: resolved.decision,
    resolvedBy: resolved.resolvedBy,
  };
}

/** Builds the presentation model shown when an approval can no longer be acted on. */
export function buildExpiredApprovalView(request: ApprovalRequest): ExpiredApprovalView {
  const normalizedRequest = normalizeApprovalRequest(request);
  if (normalizedRequest.approvalKind === "plugin") {
    return buildPluginViewBase(normalizedRequest, "expired");
  }
  return buildExecViewBase(normalizedRequest, "expired");
}
