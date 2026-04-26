import fs from "node:fs/promises";
import path from "node:path";
import { STREAM_ERROR_FALLBACK_TEXT } from "./stream-message-shared.js";

type RepairReport = {
  repaired: boolean;
  droppedLines: number;
  rewrittenAssistantMessages?: number;
  backupPath?: string;
  reason?: string;
};

// Persisted assistant entries with `content: []` (written by older builds when
// a stream/provider error fired before any block was produced) are valid JSON
// but not valid for AWS Bedrock Converse replay; rewriting them on disk lets a
// poisoned session recover across gateway restarts instead of needing a fresh
// session. The sentinel text is shared with stream-message-shared.ts and
// replay-history.ts so a session repaired offline reads byte-identically to a
// live stream-error turn — that byte-identity is what makes the repair pass
// idempotent (a healed entry is then indistinguishable from a fresh one).

type SessionMessageEntry = {
  type: "message";
  message: { role: "assistant"; content: unknown[] } & Record<string, unknown>;
} & Record<string, unknown>;

function isSessionHeader(entry: unknown): entry is { type: string; id: string } {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; id?: unknown };
  return record.type === "session" && typeof record.id === "string" && record.id.length > 0;
}

function isAssistantEntryWithEmptyContent(entry: unknown): entry is SessionMessageEntry {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { type?: unknown; message?: unknown };
  if (record.type !== "message" || !record.message || typeof record.message !== "object") {
    return false;
  }
  const message = record.message as {
    role?: unknown;
    content?: unknown;
    stopReason?: unknown;
  };
  if (message.role !== "assistant") {
    return false;
  }
  if (!Array.isArray(message.content) || message.content.length !== 0) {
    return false;
  }
  // Only error turns are eligible for on-disk rewrite. A clean stop with
  // empty content (silent-reply / NO_REPLY path documented in
  // run.empty-error-retry.test.ts) is a valid historical assistant turn —
  // mutating it into a synthetic failure message would permanently corrupt
  // the transcript and replay fabricated failure text on future requests.
  return message.stopReason === "error";
}

function rewriteAssistantEntryWithEmptyContent(entry: SessionMessageEntry): SessionMessageEntry {
  return {
    ...entry,
    message: {
      ...entry.message,
      content: [{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }],
    },
  };
}

function buildRepairSummaryParts(droppedLines: number, rewrittenAssistantMessages: number): string {
  const parts: string[] = [];
  if (droppedLines > 0) {
    parts.push(`dropped ${droppedLines} malformed line(s)`);
  }
  if (rewrittenAssistantMessages > 0) {
    parts.push(`rewrote ${rewrittenAssistantMessages} assistant message(s)`);
  }
  // Caller only invokes this once at least one counter is non-zero, so the
  // empty-array branch is unreachable in production. Kept for defensive output.
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

export async function repairSessionFileIfNeeded(params: {
  sessionFile: string;
  warn?: (message: string) => void;
}): Promise<RepairReport> {
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    return { repaired: false, droppedLines: 0, reason: "missing session file" };
  }

  let content: string;
  try {
    content = await fs.readFile(sessionFile, "utf-8");
  } catch (err) {
    const code = (err as { code?: unknown } | undefined)?.code;
    if (code === "ENOENT") {
      return { repaired: false, droppedLines: 0, reason: "missing session file" };
    }
    const reason = `failed to read session file: ${err instanceof Error ? err.message : "unknown error"}`;
    params.warn?.(`session file repair skipped: ${reason} (${path.basename(sessionFile)})`);
    return { repaired: false, droppedLines: 0, reason };
  }

  const lines = content.split(/\r?\n/);
  const entries: unknown[] = [];
  let droppedLines = 0;
  let rewrittenAssistantMessages = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry: unknown = JSON.parse(line);
      if (isAssistantEntryWithEmptyContent(entry)) {
        entries.push(rewriteAssistantEntryWithEmptyContent(entry));
        rewrittenAssistantMessages += 1;
        continue;
      }
      entries.push(entry);
    } catch {
      droppedLines += 1;
    }
  }

  if (entries.length === 0) {
    return { repaired: false, droppedLines, reason: "empty session file" };
  }

  if (!isSessionHeader(entries[0])) {
    params.warn?.(
      `session file repair skipped: invalid session header (${path.basename(sessionFile)})`,
    );
    return { repaired: false, droppedLines, reason: "invalid session header" };
  }

  if (droppedLines === 0 && rewrittenAssistantMessages === 0) {
    return { repaired: false, droppedLines: 0 };
  }

  const cleaned = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const backupPath = `${sessionFile}.bak-${process.pid}-${Date.now()}`;
  const tmpPath = `${sessionFile}.repair-${process.pid}-${Date.now()}.tmp`;
  try {
    const stat = await fs.stat(sessionFile).catch(() => null);
    await fs.writeFile(backupPath, content, "utf-8");
    if (stat) {
      await fs.chmod(backupPath, stat.mode);
    }
    await fs.writeFile(tmpPath, cleaned, "utf-8");
    if (stat) {
      await fs.chmod(tmpPath, stat.mode);
    }
    await fs.rename(tmpPath, sessionFile);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch (cleanupErr) {
      params.warn?.(
        `session file repair cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : "unknown error"} (${path.basename(
          tmpPath,
        )})`,
      );
    }
    return {
      repaired: false,
      droppedLines,
      rewrittenAssistantMessages,
      reason: `repair failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  params.warn?.(
    `session file repaired: ${buildRepairSummaryParts(
      droppedLines,
      rewrittenAssistantMessages,
    )} (${path.basename(sessionFile)})`,
  );
  return { repaired: true, droppedLines, rewrittenAssistantMessages, backupPath };
}
