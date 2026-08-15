// Telegram plugin module renders terminal operator approval receipts.
import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type {
  ExpiredApprovalView,
  ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const TELEGRAM_APPROVAL_DETAIL_MAX_CHARS = 2_800;
const TELEGRAM_APPROVAL_ID_MAX_CHARS = 512;
const TELEGRAM_APPROVAL_TERMINAL_MAX_CHARS = 4_000;

function formatApprovalDecision(decision: string | undefined): string {
  if (decision === "allow-always") {
    return "Allowed always";
  }
  if (decision === "allow-once") {
    return "Allowed once";
  }
  return decision === "deny" ? "Denied" : "Resolved";
}

function formatCanonicalResult(approval: ApprovalResolveResult["approval"]): string {
  if (approval.status === "allowed" || approval.status === "denied") {
    return formatApprovalDecision(approval.decision);
  }
  return approval.status === "expired" ? "Expired" : "Cancelled";
}

function truncateDetail(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= TELEGRAM_APPROVAL_DETAIL_MAX_CHARS) {
    return trimmed;
  }
  return `${truncateUtf16Safe(trimmed, TELEGRAM_APPROVAL_DETAIL_MAX_CHARS - 1).trimEnd()}…`;
}

function truncateApprovalId(value: string): string {
  // Approval ids may contain path-safe Unicode that is still unsafe as a chat line.
  // JSON escaping keeps the receipt single-line without changing ordinary ids.
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped.length <= TELEGRAM_APPROVAL_ID_MAX_CHARS) {
    return escaped;
  }
  return `${truncateUtf16Safe(escaped, TELEGRAM_APPROVAL_ID_MAX_CHARS - 1)}…`;
}

function formatResolvedBy(value: string): string {
  return truncateDetail(value.replace(/\s+/gu, " "));
}

function finalizeTerminalText(lines: string[]): string {
  const text = lines.join("\n");
  if (text.length <= TELEGRAM_APPROVAL_TERMINAL_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, TELEGRAM_APPROVAL_TERMINAL_MAX_CHARS - 1).trimEnd()}…`;
}

function appendCanonicalSubject(
  lines: string[],
  presentation: ApprovalResolveResult["approval"]["presentation"],
): void {
  if (presentation.kind === "exec") {
    lines.push(
      "",
      "Command:",
      truncateDetail(presentation.commandPreview ?? presentation.commandText),
    );
    return;
  }
  lines.push("", "Request:", truncateDetail(presentation.title));
  const description = presentation.description.trim();
  if (description) {
    lines.push(truncateDetail(description));
  }
}

/** Render the canonical first-answer result returned to a Telegram callback surface. */
export function buildTelegramCanonicalApprovalTerminalText(params: {
  result: ApprovalResolveResult;
  fallbackApprovalId: string;
}): string {
  const approval = params.result.approval;
  const approvalId = approval.id || params.fallbackApprovalId;
  const lines = [
    params.result.applied ? "✅ Approval resolved here" : "ℹ️ Approval already resolved",
    `Canonical result: ${formatCanonicalResult(approval)}`,
    `ID: ${truncateApprovalId(approvalId)}`,
  ];
  if (approval.presentation) {
    appendCanonicalSubject(lines, approval.presentation);
  }
  return finalizeTerminalText(lines);
}

/** Render a truthful receipt for a legacy callback without a canonical snapshot. */
export function buildTelegramLegacyApprovalTerminalText(params: {
  approvalId: string;
  decision?: "allow-once" | "allow-always" | "deny";
  outcome: "resolved-here" | "no-longer-pending" | "not-actionable";
}): string {
  const lines =
    params.outcome === "resolved-here"
      ? ["✅ Approval resolved here", `Result: ${formatApprovalDecision(params.decision)}`]
      : params.outcome === "no-longer-pending"
        ? [
            "ℹ️ Approval no longer pending",
            "It was already resolved or expired; the canonical decision is unavailable here.",
          ]
        : [
            "ℹ️ Approval is no longer actionable from this button",
            "It may have been resolved, expired, or require a different authorized approval surface.",
          ];
  lines.push(`ID: ${truncateApprovalId(params.approvalId)}`);
  return finalizeTerminalText(lines);
}

/** Render a neutral terminal receipt for malformed callbacks in the reserved namespace. */
export function buildTelegramInvalidApprovalTerminalText(): string {
  return "ℹ️ Approval action unavailable\nThis button is invalid or no longer actionable.";
}

function appendViewSubject(
  lines: string[],
  view: ResolvedApprovalView | ExpiredApprovalView,
): void {
  if (view.approvalKind === "exec") {
    lines.push("", "Command:", truncateDetail(view.commandPreview ?? view.commandText));
    return;
  }
  lines.push("", "Request:", truncateDetail(view.title));
  const description = view.description?.trim();
  if (description) {
    lines.push(truncateDetail(description));
  }
}

/** Render a canonical native resolved event while retaining safe request context. */
export function buildTelegramNativeResolvedApprovalText(view: ResolvedApprovalView): string {
  const label = view.approvalKind === "exec" ? "Exec" : "Plugin";
  const lines = [
    `✅ ${label} approval resolved`,
    `Canonical result: ${formatApprovalDecision(view.decision)}`,
  ];
  if (view.resolvedBy?.trim()) {
    lines.push(`Resolved by: ${formatResolvedBy(view.resolvedBy)}`);
  }
  lines.push(`ID: ${truncateApprovalId(view.approvalId)}`);
  appendViewSubject(lines, view);
  return finalizeTerminalText(lines);
}

/** Render a canonical native expiration event while retaining safe request context. */
export function buildTelegramNativeExpiredApprovalText(view: ExpiredApprovalView): string {
  const label = view.approvalKind === "exec" ? "Exec" : "Plugin";
  const lines = [
    `⏱️ ${label} approval expired`,
    "Canonical result: Expired",
    `ID: ${truncateApprovalId(view.approvalId)}`,
  ];
  appendViewSubject(lines, view);
  return finalizeTerminalText(lines);
}
