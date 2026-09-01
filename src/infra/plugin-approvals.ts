// Defines plugin approval request/resolution payloads and actions.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { PluginExternalResolution } from "../plugins/external-verification-approval-types.js";
import { summarizeApprovalScope, type ApprovalScope } from "./approval-scope.js";
import { sanitizeExecApprovalDisplayText } from "./exec-approval-text-sanitize.js";
import type { ExecApprovalDecision } from "./exec-approvals.js";

// Plugin approval types and renderers mirror exec approval decisions while
// keeping plugin-facing request text and action metadata separate.
/** Button/action metadata shown with a plugin approval request. */
export type PluginApprovalActionView = {
  kind?: "command" | "decision";
  label: string;
  command: string;
  decision?: ExecApprovalDecision;
  style?: "primary" | "secondary" | "success" | "danger";
};

/** Request payload supplied by plugin approval callers. */
export type PluginApprovalRequestPayload = {
  pluginId?: string | null;
  title: string;
  description: string;
  detail?: string | null;
  severity?: "info" | "warning" | "critical" | null;
  /** Owner-declared blast-radius facts; display-only, never authorization. */
  scope?: ApprovalScope | null;
  toolName?: string | null;
  toolCallId?: string | null;
  allowedDecisions?: readonly ExecApprovalDecision[] | null;
  /** Trusted in-process metadata; public Gateway callers cannot submit this field. */
  externalResolution?: PluginExternalResolution | null;
  actions?: readonly PluginApprovalActionView[] | null;
  agentId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  /** Host-derived source run; never accepted from plugin approval RPC params. */
  runId?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

/** Timed plugin approval request persisted while awaiting a decision. */
export type PluginApprovalRequest = {
  /** Descriptive wire metadata; readers derive it from the payload when absent. */
  approvalKind?: "plugin";
  id: string;
  request: PluginApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

/** Resolved plugin approval decision plus optional request snapshot. */
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
export const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 512;
export const PLUGIN_APPROVAL_DETAIL_MAX_LENGTH = 16_384;
const PLUGIN_EXTERNAL_RESOLUTION_LABEL_MAX_LENGTH = 80;
const PLUGIN_APPROVAL_DETAIL_TRUNCATION_SUFFIX = "…[truncated]";
export const DEFAULT_PLUGIN_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];

/** Caps reviewer-only plugin detail by Unicode code point without splitting surrogate pairs. */
export function truncatePluginApprovalDetail(value: string): string {
  if (value.length <= PLUGIN_APPROVAL_DETAIL_MAX_LENGTH) {
    return value;
  }
  const contentLimit =
    PLUGIN_APPROVAL_DETAIL_MAX_LENGTH - Array.from(PLUGIN_APPROVAL_DETAIL_TRUNCATION_SUFFIX).length;
  let codePointCount = 0;
  let contentCodeUnitLength = 0;
  for (const char of value) {
    codePointCount += 1;
    if (codePointCount <= contentLimit) {
      contentCodeUnitLength += char.length;
    }
    if (codePointCount > PLUGIN_APPROVAL_DETAIL_MAX_LENGTH) {
      return `${truncateUtf16Safe(value, contentCodeUnitLength)}${PLUGIN_APPROVAL_DETAIL_TRUNCATION_SUFFIX}`;
    }
  }
  return value;
}

/** Clamp a plugin approval timeout to the supported runtime bounds. */
export function resolvePluginApprovalTimeoutMs(value: unknown): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;
  return Math.min(MAX_PLUGIN_APPROVAL_TIMEOUT_MS, Math.max(1, Math.floor(candidate)));
}

/** Format an approval decision for user-facing messages. */
export function approvalDecisionLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "allowed always";
  }
  return "denied";
}

/** Resolve explicit plugin approval decisions or fall back to defaults. */
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

/** Normalize the bounded external route shared by creation and presentation paths. */
export function normalizePluginExternalResolution(
  value: PluginExternalResolution | null | undefined,
): PluginExternalResolution | null {
  if (!value) {
    return null;
  }
  const rawLabel = value.label?.trim();
  const label = rawLabel ? sanitizeExecApprovalDisplayText(rawLabel) : "";
  if (!label || Array.from(label).length > PLUGIN_EXTERNAL_RESOLUTION_LABEL_MAX_LENGTH) {
    throw new Error("invalid external approval label");
  }
  const decisions = value.decisions ?? ["allow-once"];
  if (
    decisions.length < 1 ||
    decisions.length > 2 ||
    decisions.some((decision) => decision !== "allow-once" && decision !== "allow-always") ||
    new Set(decisions).size !== decisions.length
  ) {
    throw new Error("external decisions must be unique allow-once/allow-always values");
  }
  return { label, decisions: [...decisions] };
}

/** Build the pending plugin approval message. */
export function buildPluginApprovalRequestMessage(
  request: PluginApprovalRequest,
  nowMsValue: number,
): string {
  const lines: string[] = [];
  const severity = request.request.severity ?? "warning";
  const icon = severity === "critical" ? "🚨" : severity === "info" ? "ℹ️" : "🛡️";
  lines.push(`${icon} Plugin approval required`);
  lines.push(`Title: ${request.request.title}`);
  // Reviewer-only detail stays off channel messages; channels receive the bounded description.
  lines.push(`Description: ${request.request.description}`);
  if (request.request.scope) {
    lines.push(`Scope: ${summarizeApprovalScope(request.request.scope)}`);
  }
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
  const externalResolution = normalizePluginExternalResolution(request.request.externalResolution);
  if (externalResolution) {
    lines.push(externalResolution.label);
    if (externalResolution.decisions?.includes("allow-once")) {
      lines.push(`Verify once: /approve ${request.id} external allow-once`);
    }
    if (externalResolution.decisions?.includes("allow-always")) {
      lines.push(`Verify and trust for session: /approve ${request.id} external allow-always`);
    }
    lines.push(`Deny: /approve ${request.id} deny`);
    return lines.join("\n");
  }
  lines.push(
    `Reply with: /approve ${request.id} ${resolvePluginApprovalRequestAllowedDecisions(
      request.request,
    ).join("|")}`,
  );
  return lines.join("\n");
}

/** Build the plugin approval resolution message. */
export function buildPluginApprovalResolvedMessage(resolved: PluginApprovalResolved): string {
  const base = `✅ Plugin approval ${approvalDecisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

/** Build the plugin approval expiration message. */
export function buildPluginApprovalExpiredMessage(request: PluginApprovalRequest): string {
  return `⏱️ Plugin approval expired. ID: ${request.id}`;
}
