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

const EXEC_COMPLETED_RE = /^exec completed:\s*([\s\S]*)$/i;

// Approval-system-generated wrappers always start with either `gateway id=` or
// `node=` inside the parenthesized metadata (see bash-tools.exec-host-gateway.ts,
// bash-tools.exec-host-node.ts, and gateway/server-node-events.ts). Untrusted
// command stdout that happens to start with "Exec denied (...)" or
// "Exec finished (...)" should be rejected by the parser to prevent CWE-841
// spoofed approval events from arbitrary tool output.
const APPROVAL_METADATA_SOURCE_RE = /^(?:gateway\s+id=|node=)/i;

function parseExecApprovalResultWithMetadata(
  raw: string,
  prefix: string,
  bodySeparator: ":" | "\n",
): { metadata: string; body: string } | null {
  const normalizedRaw = normalizeLowercaseStringOrEmpty(raw);
  const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
  if (!normalizedRaw.startsWith(normalizedPrefix)) {
    return null;
  }

  const metadataStart = prefix.length;
  let depth = 1;
  let metadataEnd = -1;
  for (let index = metadataStart; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        metadataEnd = index;
        break;
      }
    }
  }

  if (metadataEnd < 0) {
    return null;
  }

  const metadata = raw.slice(metadataStart, metadataEnd).trim();
  if (!APPROVAL_METADATA_SOURCE_RE.test(metadata)) {
    return null;
  }

  const remainder = raw.slice(metadataEnd + 1);
  if (bodySeparator === ":") {
    if (!remainder.startsWith(":")) {
      return null;
    }
    return {
      metadata,
      body: remainder.slice(1).trim(),
    };
  }

  if (remainder && !remainder.startsWith("\n")) {
    return null;
  }

  return {
    metadata,
    body: remainder.startsWith("\n") ? remainder.slice(1).trim() : "",
  };
}

export function parseExecApprovalResultText(resultText: string): ExecApprovalResult {
  const raw = resultText.trim();
  if (!raw) {
    return { kind: "other", raw };
  }

  const deniedResult = parseExecApprovalResultWithMetadata(raw, "Exec denied (", ":");
  if (deniedResult) {
    return {
      kind: "denied",
      raw,
      metadata: deniedResult.metadata,
      body: deniedResult.body,
    };
  }

  const finishedResult = parseExecApprovalResultWithMetadata(raw, "Exec finished (", "\n");
  if (finishedResult) {
    return {
      kind: "finished",
      raw,
      metadata: finishedResult.metadata,
      body: finishedResult.body,
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
