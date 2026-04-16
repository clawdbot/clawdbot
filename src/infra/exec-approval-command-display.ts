import { redactSensitiveText } from "../logging/redact.js";
import type { ExecApprovalRequestPayload } from "./exec-approvals.js";

// Escape invisible characters that can spoof approval prompts in common UIs.
const EXEC_APPROVAL_INVISIBLE_CHAR_REGEX = /[\p{Cf}\u115F\u1160\u3164\uFFA0]/gu;

function formatCodePointEscape(char: string): string {
  return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
}

export function sanitizeExecApprovalDisplayText(commandText: string): string {
  const escaped = commandText.replace(EXEC_APPROVAL_INVISIBLE_CHAR_REGEX, formatCodePointEscape);
  return redactSensitiveText(escaped, { mode: "tools" });
}

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

export function resolveExecApprovalCommandDisplay(request: ExecApprovalRequestPayload): {
  commandText: string;
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
