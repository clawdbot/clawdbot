// Builds the canonical reviewer-safe projection for durable approvals.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalPresentation,
} from "../../packages/gateway-protocol/src/index.js";
import { sanitizeApprovalScope } from "./approval-scope.js";
import { resolveExecApprovalCommandDisplay } from "./exec-approval-command-display.js";
import {
  exceedsApprovalTextLimit,
  sanitizeExecApprovalDisplayText,
  sanitizeExecApprovalWarningText,
} from "./exec-approval-text-sanitize.js";
import type { ExecApprovalRequestPayload } from "./exec-approvals.js";
import {
  PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH,
  PLUGIN_APPROVAL_TITLE_MAX_LENGTH,
  truncatePluginApprovalDetail,
  type PluginApprovalRequestPayload,
} from "./plugin-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "./system-agent-approvals.js";

const PLUGIN_EXTERNAL_RESOLUTION_LABEL_MAX_LENGTH = 80;

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

function sanitizeOptionalSingleLine(value: unknown): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? sanitizeExecApprovalDisplayText(normalized) : null;
}

function normalizePluginExternalResolution(
  value: PluginApprovalRequestPayload["externalResolution"],
): NonNullable<PluginApprovalRequestPayload["externalResolution"]> | null {
  if (!value) {
    return null;
  }
  const rawLabel = value.label?.trim();
  const label = rawLabel ? sanitizeExecApprovalDisplayText(rawLabel) : "";
  if (!label || exceedsApprovalTextLimit(label, PLUGIN_EXTERNAL_RESOLUTION_LABEL_MAX_LENGTH)) {
    throw new Error("invalid external approval label");
  }
  const decisions = value.decisions ?? ["allow-once"];
  if (
    decisions.length < 1 ||
    decisions.length > 2 ||
    decisions.some((decision) => decision !== "allow-once" && decision !== "allow-always") ||
    new Set(decisions).size !== decisions.length
  ) {
    throw new Error("invalid external approval decisions");
  }
  return { label, decisions: [...decisions] };
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
  const scope = request.scope ? sanitizeApprovalScope(request.scope) : null;
  return {
    kind: "exec",
    commandText,
    commandPreview,
    warningText,
    host: sanitizeOptionalSingleLine(request.host),
    nodeId: sanitizeOptionalSingleLine(request.nodeId),
    agentId: sanitizeOptionalSingleLine(request.agentId),
    ...(scope ? { scope } : {}),
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
    exceedsApprovalTextLimit(title, PLUGIN_APPROVAL_TITLE_MAX_LENGTH) ||
    exceedsApprovalTextLimit(description, PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH)
  ) {
    return null;
  }
  const severity =
    request.severity === "info" || request.severity === "warning" || request.severity === "critical"
      ? request.severity
      : "warning";
  const rawDetail = normalizeOptionalString(request.detail);
  const detail = rawDetail
    ? truncatePluginApprovalDetail(sanitizeExecApprovalWarningText(rawDetail))
    : null;
  const scope = request.scope ? sanitizeApprovalScope(request.scope) : null;
  let externalResolution: ReturnType<typeof normalizePluginExternalResolution>;
  try {
    externalResolution = normalizePluginExternalResolution(request.externalResolution);
  } catch {
    return null;
  }
  return {
    kind: "plugin",
    title,
    description,
    ...(detail ? { detail } : {}),
    severity,
    pluginId: sanitizeOptionalSingleLine(request.pluginId),
    toolName: sanitizeOptionalSingleLine(request.toolName),
    agentId: sanitizeOptionalSingleLine(request.agentId),
    ...(scope ? { scope } : {}),
    allowedDecisions: normalizeDecisionList(params.allowedDecisions),
    ...(externalResolution
      ? {
          externalResolution: {
            label: externalResolution.label,
            decisions: [...(externalResolution.decisions ?? ["allow-once"])],
          },
        }
      : {}),
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
