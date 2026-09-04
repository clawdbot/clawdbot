// Resolves sanitized command/preview text for exec approval prompts.
import { sanitizeExecApprovalDisplayText } from "./exec-approval-text-sanitize.js";
import type { ExecApprovalRequestPayload } from "./exec-approvals.js";

function normalizePreview(commandText: string, commandPreview?: string | null): string | null {
  const previewRaw = commandPreview?.trim() ?? "";
  if (!previewRaw) {
    return null;
  }
  const preview = sanitizeExecApprovalDisplayText(previewRaw);
  if (preview === commandText) {
    return null;
  }
  return preview;
}

/** Resolves sanitized command and preview text for exec approval prompts. */
export function resolveExecApprovalCommandDisplay(request: ExecApprovalRequestPayload): {
  /** Primary command text rendered in the approval prompt. */
  commandText: string;
  /** Optional shorter preview, omitted when it would duplicate the primary command text. */
  commandPreview: string | null;
} {
  const commandTextSource =
    request.command ||
    (request.host === "node" && request.systemRunPlan ? request.systemRunPlan.commandText : "");
  const commandText = sanitizeExecApprovalDisplayText(commandTextSource);
  const previewSource =
    request.commandPreview ??
    (request.host === "node" ? (request.systemRunPlan?.commandPreview ?? null) : null);
  return {
    commandText,
    commandPreview: normalizePreview(commandText, previewSource),
  };
}

/**
 * Resolves cwd display values for exec approval prompts. The canonical cwd is
 * taken as-is (sanitized at record creation); the requested cwd is sanitized
 * here because it travels inside the approval plan, and is only surfaced when
 * it differs from the canonical path so approvers see both.
 */
export function resolveExecApprovalCwdDisplay(request: ExecApprovalRequestPayload): {
  cwd: string | null;
  requestedCwd: string | null;
} {
  const cwd = request.cwd ?? null;
  const planRequestedCwd = request.systemRunPlan?.requestedCwd;
  if (!planRequestedCwd || planRequestedCwd === cwd) {
    return { cwd, requestedCwd: null };
  }
  return { cwd, requestedCwd: sanitizeExecApprovalDisplayText(planRequestedCwd) };
}
