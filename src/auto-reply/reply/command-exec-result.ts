import type { ExecToolDetails } from "../../agents/bash-tools.js";

export function formatCommandExecText(text: string): string {
  return text.trim() || "(no exec output)";
}

export function formatCommandExecResult(
  result: {
    content?: Array<{ type: string; text?: string }>;
    details?: ExecToolDetails;
  },
  runningLabel: string,
): string {
  const text = result.content
    ?.map((chunk) => (chunk.type === "text" && typeof chunk.text === "string" ? chunk.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (text) {
    return text;
  }
  const details = result.details;
  if (details?.status === "approval-pending") {
    const decisions = details.allowedDecisions?.join(", ") || "allow-once, deny";
    return formatCommandExecText(
      `Exec approval pending (${details.approvalSlug}). Allowed decisions: ${decisions}.`,
    );
  }
  if (details?.status === "running") {
    return formatCommandExecText(`${runningLabel} is running (exec session ${details.sessionId}).`);
  }
  if (details?.status === "completed" || details?.status === "failed") {
    return formatCommandExecText(details.aggregated);
  }
  return "(no exec details returned)";
}
