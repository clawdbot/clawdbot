import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

type ExecApprovalResult =
  | {
      kind: "denied";
      raw: string;
      metadata: string;
      body: string;
    }
  | {
      kind: "finished";
      raw: string;
      metadata: string;
      body: string;
    }
  | {
      kind: "completed";
      raw: string;
      body: string;
    }
  | {
      kind: "other";
      raw: string;
    };

const EXEC_DENIED_RE = /^exec denied \(([^)]*)\):(?:\s*([\s\S]*))?$/i;
const EXEC_FINISHED_RE = /^exec finished \(([^)]*)\)(?:\n([\s\S]*))?$/i;
const EXEC_COMPLETED_RE = /^exec completed:\s*([\s\S]*)$/i;

export function parseExecApprovalResultText(resultText: string): ExecApprovalResult {
  const raw = resultText.trim();
  if (!raw) {
    return { kind: "other", raw };
  }

  const deniedMatch = EXEC_DENIED_RE.exec(raw);
  if (deniedMatch) {
    return {
      kind: "denied",
      raw,
      metadata: deniedMatch[1]?.trim() ?? "",
      body: deniedMatch[2]?.trim() ?? "",
    };
  }

  const finishedMatch = EXEC_FINISHED_RE.exec(raw);
  if (finishedMatch) {
    return {
      kind: "finished",
      raw,
      metadata: finishedMatch[1]?.trim() ?? "",
      body: finishedMatch[2]?.trim() ?? "",
    };
  }

  const completedMatch = EXEC_COMPLETED_RE.exec(raw);
  if (completedMatch) {
    return {
      kind: "completed",
      raw,
      body: completedMatch[1]?.trim() ?? "",
    };
  }

  return { kind: "other", raw };
}

export function isExecDeniedResultText(resultText: string): boolean {
  return parseExecApprovalResultText(resultText).kind === "denied";
}

export function formatExecDeniedUserMessage(resultText: string): string | null {
  const parsed = parseExecApprovalResultText(resultText);
  if (parsed.kind !== "denied") {
    return null;
  }

  const metadata = normalizeLowercaseStringOrEmpty(parsed.metadata);
  if (metadata.includes("approval-timeout")) {
    return "Command did not run: approval timed out.";
  }
  if (metadata.includes("user-denied")) {
    return "Command did not run: approval was denied.";
  }
  if (metadata.includes("allowlist-miss")) {
    return "Command did not run: approval is required.";
  }
  if (metadata.includes("approval-request-failed")) {
    return "Command did not run: approval request failed.";
  }
  if (metadata.includes("spawn-failed") || metadata.includes("invoke-failed")) {
    return "Command did not run.";
  }
  return "Command did not run.";
}
