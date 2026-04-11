import type { ChannelApprovalKind } from "./approval-types.js";
import { resolveExecApprovalCommandDisplay } from "./exec-approval-command-display.js";
import {
  buildExecApprovalActionDescriptors,
  type ExecApprovalActionDescriptor,
} from "./exec-approval-reply.js";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalDecision,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
} from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;
type ApprovalPhase = "pending" | "resolved" | "expired";

export type ApprovalActionView = ExecApprovalActionDescriptor;

export type ApprovalMetadataView = {
  label: string;
  value: string;
};

type ApprovalViewBase = {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  phase: "pending" | "resolved" | "expired";
  title: string;
  description?: string | null;
  metadata: ApprovalMetadataView[];
};

type ExecApprovalViewBase = ApprovalViewBase & {
  approvalKind: "exec";
  ask?: string | null;
  agentId?: string | null;
  commandText: string;
  commandPreview?: string | null;
  cwd?: string | null;
  envKeys?: readonly string[];
  host?: string | null;
  nodeId?: string | null;
  sessionKey?: string | null;
};

export type ExecApprovalPendingView = ExecApprovalViewBase & {
  phase: "pending";
  actions: ApprovalActionView[];
  expiresAtMs: number;
};

export type ExecApprovalResolvedView = ExecApprovalViewBase & {
  phase: "resolved";
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
};

export type ExecApprovalExpiredView = ExecApprovalViewBase & {
  phase: "expired";
};

type PluginApprovalViewBase = ApprovalViewBase & {
  approvalKind: "plugin";
  agentId?: string | null;
  pluginId?: string | null;
  toolName?: string | null;
  severity: "info" | "warning" | "critical";
};

export type PluginApprovalPendingView = PluginApprovalViewBase & {
  phase: "pending";
  actions: ApprovalActionView[];
  expiresAtMs: number;
};

export type PluginApprovalResolvedView = PluginApprovalViewBase & {
  phase: "resolved";
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
};

export type PluginApprovalExpiredView = PluginApprovalViewBase & {
  phase: "expired";
};

export type PendingApprovalView = ExecApprovalPendingView | PluginApprovalPendingView;
export type ResolvedApprovalView = ExecApprovalResolvedView | PluginApprovalResolvedView;
export type ExpiredApprovalView = ExecApprovalExpiredView | PluginApprovalExpiredView;
export type ApprovalViewModel = PendingApprovalView | ResolvedApprovalView | ExpiredApprovalView;

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
    commandText,
    commandPreview,
    cwd: request.request.cwd ?? null,
    envKeys: request.request.envKeys ?? undefined,
    host: request.request.host ?? null,
    nodeId: request.request.nodeId ?? null,
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
    toolName: request.request.toolName ?? null,
    severity: request.request.severity ?? "warning",
  };
}

export function buildPendingApprovalView(request: ApprovalRequest): PendingApprovalView {
  if (request.id.startsWith("plugin:")) {
    const pluginRequest = request as PluginApprovalRequest;
    return {
      ...buildPluginViewBase(pluginRequest, "pending"),
      actions: buildExecApprovalActionDescriptors({
        approvalCommandId: pluginRequest.id,
      }),
      expiresAtMs: pluginRequest.expiresAtMs,
    };
  }
  const execRequest = request as ExecApprovalRequest;
  return {
    ...buildExecViewBase(execRequest, "pending"),
    actions: buildExecApprovalActionDescriptors({
      approvalCommandId: execRequest.id,
      ask: execRequest.request.ask,
      allowedDecisions: resolveExecApprovalRequestAllowedDecisions(execRequest.request),
    }),
    expiresAtMs: execRequest.expiresAtMs,
  };
}

export function buildResolvedApprovalView(
  request: ApprovalRequest,
  resolved: ApprovalResolved,
): ResolvedApprovalView {
  if (request.id.startsWith("plugin:")) {
    const pluginRequest = request as PluginApprovalRequest;
    return {
      ...buildPluginViewBase(pluginRequest, "resolved"),
      decision: resolved.decision,
      resolvedBy: resolved.resolvedBy,
    };
  }
  const execRequest = request as ExecApprovalRequest;
  return {
    ...buildExecViewBase(execRequest, "resolved"),
    decision: resolved.decision,
    resolvedBy: resolved.resolvedBy,
  };
}

export function buildExpiredApprovalView(request: ApprovalRequest): ExpiredApprovalView {
  if (request.id.startsWith("plugin:")) {
    return buildPluginViewBase(request as PluginApprovalRequest, "expired");
  }
  return buildExecViewBase(request as ExecApprovalRequest, "expired");
}
