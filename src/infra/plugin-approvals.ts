import type { InteractiveButtonStyle } from "../interactive/payload.js";
import type { ExecApprovalDecision } from "./exec-approvals.js";

export type PluginApprovalActionKind = "decision" | "command";
export type PluginApprovalActionStyle = InteractiveButtonStyle;

export type PluginApprovalDecisionActionTemplate = {
  kind: "decision";
  label: string;
  style: PluginApprovalActionStyle;
  decision: ExecApprovalDecision;
  commandTemplate: string;
};

export type PluginApprovalCommandActionTemplate = {
  kind: "command";
  label: string;
  style: PluginApprovalActionStyle;
  commandTemplate: string;
};

export type PluginApprovalActionTemplate =
  | PluginApprovalDecisionActionTemplate
  | PluginApprovalCommandActionTemplate;

export type PluginApprovalDecisionActionDescriptor = Omit<
  PluginApprovalDecisionActionTemplate,
  "commandTemplate"
> & {
  command: string;
};

export type PluginApprovalCommandActionDescriptor = Omit<
  PluginApprovalCommandActionTemplate,
  "commandTemplate"
> & {
  command: string;
};

export type PluginApprovalActionDescriptor =
  | PluginApprovalDecisionActionDescriptor
  | PluginApprovalCommandActionDescriptor;

type PluginApprovalActionBase = {
  kind: PluginApprovalActionKind;
  label: string;
  style: PluginApprovalActionStyle;
};

type NormalizedPluginApprovalActionTemplate =
  | (PluginApprovalActionBase & {
      kind: "decision";
      decision: ExecApprovalDecision;
      commandTemplate: string;
    })
  | (PluginApprovalActionBase & {
      kind: "command";
      commandTemplate: string;
    });

function isApprovalDecision(value: unknown): value is ExecApprovalDecision {
  return value === "allow-once" || value === "allow-always" || value === "deny";
}

export function validatePluginApprovalActionTemplates(
  actions: readonly PluginApprovalActionTemplate[],
): string | null {
  for (const [index, action] of actions.entries()) {
    const decision = (action as { decision?: unknown }).decision;
    if (action.kind === "command" && decision !== undefined) {
      return `actions[${index}] command actions must not include decision`;
    }
    if (action.kind === "decision" && !isApprovalDecision(decision)) {
      return `actions[${index}] decision actions must include a valid decision`;
    }
  }
  return null;
}

function normalizePluginApprovalActionTemplate(
  action: PluginApprovalActionTemplate,
): NormalizedPluginApprovalActionTemplate | null {
  const decision = (action as { decision?: unknown }).decision;
  if (action.kind === "command" && decision !== undefined) {
    return null;
  }
  if (action.kind === "command") {
    return {
      kind: "command",
      label: action.label,
      style: action.style,
      commandTemplate: action.commandTemplate,
    };
  }
  if (action.kind === "decision" && isApprovalDecision(decision)) {
    return {
      kind: "decision",
      label: action.label,
      style: action.style,
      decision,
      commandTemplate: action.commandTemplate,
    };
  }
  return null;
}

export type PluginApprovalRequestPayload = {
  pluginId?: string | null;
  title: string;
  description: string;
  severity?: "info" | "warning" | "critical" | null;
  toolName?: string | null;
  toolCallId?: string | null;
  allowedDecisions?: readonly ExecApprovalDecision[] | null;
  actions?: readonly PluginApprovalActionDescriptor[] | null;
  agentId?: string | null;
  sessionKey?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

export type PluginApprovalRequest = {
  id: string;
  request: PluginApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

export type PluginApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: PluginApprovalRequestPayload;
};

export const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600_000;
export const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;
export const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 256;
export const PLUGIN_APPROVAL_ACTION_LABEL_MAX_LENGTH = 40;
export const PLUGIN_APPROVAL_ACTION_COMMAND_TEMPLATE_MAX_LENGTH = 200;
export const MAX_PLUGIN_APPROVAL_ACTIONS = 6;
export const DEFAULT_PLUGIN_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];

export function approvalDecisionLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "allowed always";
  }
  return "denied";
}

export function resolvePluginApprovalRequestAllowedDecisions(params?: {
  allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[] {
  const explicit: ExecApprovalDecision[] = [];
  if (Array.isArray(params?.allowedDecisions)) {
    for (const decision of params.allowedDecisions) {
      if (
        (decision === "allow-once" || decision === "allow-always" || decision === "deny") &&
        !explicit.includes(decision)
      ) {
        explicit.push(decision);
      }
    }
  }
  return explicit.length > 0 ? explicit : DEFAULT_PLUGIN_APPROVAL_DECISIONS;
}

export function expandPluginApprovalActionTemplates(params: {
  approvalId: string;
  actions?: readonly PluginApprovalActionTemplate[] | null;
}): readonly PluginApprovalActionDescriptor[] | undefined {
  if (!Array.isArray(params.actions) || params.actions.length === 0) {
    return undefined;
  }

  const expanded: PluginApprovalActionDescriptor[] = [];
  for (const rawAction of params.actions) {
    const action = normalizePluginApprovalActionTemplate(rawAction);
    if (!action) {
      continue;
    }
    const label = action.label.trim();
    const command = action.commandTemplate.replaceAll("{id}", params.approvalId).trim();
    if (!label || !command) {
      continue;
    }
    if (action.kind === "decision") {
      expanded.push({
        kind: "decision",
        label,
        style: action.style,
        decision: action.decision,
        command,
      });
      continue;
    }
    expanded.push({
      kind: "command",
      label,
      style: action.style,
      command,
    });
  }
  return expanded.length > 0 ? expanded : undefined;
}

export function buildPluginApprovalRequestMessage(
  request: PluginApprovalRequest,
  nowMsValue: number,
): string {
  const lines: string[] = [];
  const severity = request.request.severity ?? "warning";
  const icon = severity === "critical" ? "🚨" : severity === "info" ? "ℹ️" : "🛡️";
  lines.push(`${icon} Plugin approval required`);
  lines.push(`Title: ${request.request.title}`);
  lines.push(`Description: ${request.request.description}`);
  if (request.request.toolName) {
    lines.push(`Tool: ${request.request.toolName}`);
  }
  if (request.request.pluginId) {
    lines.push(`Plugin: ${request.request.pluginId}`);
  }
  if (request.request.agentId) {
    lines.push(`Agent: ${request.request.agentId}`);
  }
  lines.push(`ID: ${request.id}`);
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMsValue) / 1000));
  lines.push(`Expires in: ${expiresIn}s`);
  const actionCommands = request.request.actions
    ?.map((action) => action.command.trim())
    .filter((command) => command.length > 0);
  if (actionCommands && actionCommands.length > 0) {
    lines.push("Reply with one of:");
    lines.push(actionCommands.join("\n"));
  } else {
    lines.push(
      `Reply with: /approve <id> ${resolvePluginApprovalRequestAllowedDecisions(
        request.request,
      ).join("|")}`,
    );
  }
  return lines.join("\n");
}

export function buildPluginApprovalResolvedMessage(resolved: PluginApprovalResolved): string {
  const base = `✅ Plugin approval ${approvalDecisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

export function buildPluginApprovalExpiredMessage(request: PluginApprovalRequest): string {
  return `⏱️ Plugin approval expired. ID: ${request.id}`;
}
