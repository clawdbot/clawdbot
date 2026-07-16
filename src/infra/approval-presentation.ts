// Builds the canonical reviewer-safe projection for durable approvals.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalPresentation,
} from "../../packages/gateway-protocol/src/index.js";
import {
  resolveExecApprovalCommandDisplay,
  sanitizeExecApprovalDisplayText,
  sanitizeExecApprovalWarningText,
} from "./exec-approval-command-display.js";
import type { ExecApprovalRequestPayload } from "./exec-approvals.js";
import {
  PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
  PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
  type PluginApprovalRequestPayload,
} from "./plugin-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "./system-agent-approvals.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDecisionList(decisions: readonly ApprovalDecision[]): ApprovalDecision[] {
  const result: ApprovalDecision[] = [];
  for (const decision of decisions) {
    if (!result.includes(decision)) {
      result.push(decision);
    }
  }
  if (!result.includes("deny")) {
    result.push("deny");
  }
  return result;
}

function isWithinCodePointLimit(value: string, maxLength: number): boolean {
  return Array.from(value).length <= maxLength;
}

function sanitizeOptionalSingleLine(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? sanitizeExecApprovalDisplayText(normalized) : null;
}

function buildExecApprovalPresentation(params: {
  request: unknown;
  allowedDecisions: readonly ApprovalDecision[];
}): ApprovalPresentation | null {
  if (!isRecord(params.request)) {
    return null;
  }
  const request = params.request as ExecApprovalRequestPayload;
  const { commandText, commandPreview } = resolveExecApprovalCommandDisplay(request);
  if (!commandText.trim()) {
    return null;
  }
  const warningText =
    typeof request.warningText === "string" && request.warningText.trim()
      ? sanitizeExecApprovalWarningText(request.warningText)
      : null;
  return {
    kind: "exec",
    commandText,
    commandPreview,
    warningText,
    host: sanitizeOptionalSingleLine(request.host),
    nodeId: sanitizeOptionalSingleLine(request.nodeId),
    agentId: sanitizeOptionalSingleLine(request.agentId),
    allowedDecisions: normalizeDecisionList(params.allowedDecisions),
  };
}

function buildPluginApprovalPresentation(params: {
  request: unknown;
  allowedDecisions: readonly ApprovalDecision[];
}): ApprovalPresentation | null {
  if (!isRecord(params.request)) {
    return null;
  }
  const request = params.request as PluginApprovalRequestPayload;
  const rawTitle = normalizeOptionalString(request.title);
  const rawDescription = normalizeOptionalString(request.description);
  if (!rawTitle || !rawDescription) {
    return null;
  }
  // Plugin text crosses every reviewer surface. Apply the same redaction and
  // spoof-resistant escaping as exec prompts before enforcing wire-size limits.
  const title = sanitizeExecApprovalDisplayText(rawTitle);
  const description = sanitizeExecApprovalWarningText(rawDescription);
  if (
    !isWithinCodePointLimit(title, PLUGIN_APPROVAL_TITLE_MAX_LENGTH) ||
    !isWithinCodePointLimit(description, PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH)
  ) {
    return null;
  }
  const severity =
    request.severity === "info" || request.severity === "warning" || request.severity === "critical"
      ? request.severity
      : "warning";
  return {
    kind: "plugin",
    title,
    description,
    severity,
    pluginId: sanitizeOptionalSingleLine(request.pluginId),
    toolName: sanitizeOptionalSingleLine(request.toolName),
    agentId: sanitizeOptionalSingleLine(request.agentId),
    allowedDecisions: normalizeDecisionList(params.allowedDecisions),
  };
}

function buildSystemAgentApprovalPresentation(params: {
  request: unknown;
  allowedDecisions: readonly ApprovalDecision[];
}): ApprovalPresentation | null {
  if (!isRecord(params.request)) {
    return null;
  }
  const request = params.request as SystemAgentApprovalRequestPayload;
  const title = normalizeOptionalString(request.title);
  const description = normalizeOptionalString(request.description);
  if (!title || !description || !/^[a-f0-9]{64}$/.test(request.proposalHash)) {
    return null;
  }
  return {
    kind: "system-agent",
    title: truncateUtf16Safe(sanitizeExecApprovalDisplayText(title), 80),
    description: truncateUtf16Safe(sanitizeExecApprovalWarningText(description), 512),
    proposalHash: request.proposalHash,
    agentId: sanitizeOptionalSingleLine(request.agentId),
    allowedDecisions: ["allow-once", "deny"],
  };
}

/** Returns the safe cross-surface presentation, or null when no prompt can be rendered. */
export function buildApprovalPresentation(params: {
  kind: ApprovalKind;
  request: unknown;
  allowedDecisions: readonly ApprovalDecision[];
}): ApprovalPresentation | null {
  if (params.kind === "exec") {
    return buildExecApprovalPresentation(params);
  }
  return params.kind === "plugin"
    ? buildPluginApprovalPresentation(params)
    : buildSystemAgentApprovalPresentation(params);
}
