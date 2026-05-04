import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const SESSION_TAIL_BYTES = 64 * 1024;
const MAX_QUOTED_FIELD_CHARS = 140;

type CronSessionContext = {
  agentId?: string;
  cronJobId?: string;
  cronRunId?: string;
  cronJobName?: string;
  lastAssistant?: string;
};

function quoteLogField(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  const truncated =
    oneLine.length > MAX_QUOTED_FIELD_CHARS
      ? `${oneLine.slice(0, Math.max(0, MAX_QUOTED_FIELD_CHARS - 3))}...`
      : oneLine;
  return `"${truncated.replace(/["\\]/g, "\\$&")}"`;
}

export function parseCronRunSessionKey(sessionKey?: string): {
  agentId?: string;
  cronJobId?: string;
  cronRunId?: string;
} {
  const parts = sessionKey?.trim().split(":") ?? [];
  if (parts[0] !== "agent") {
    return {};
  }
  const cronIndex = parts.indexOf("cron");
  if (cronIndex < 2) {
    return {};
  }
  const runIndex = parts.indexOf("run", cronIndex + 2);
  return {
    agentId: parts[1],
    cronJobId: parts[cronIndex + 1],
    cronRunId: runIndex >= 0 ? parts[runIndex + 1] : undefined,
  };
}

function resolveSessionFile(params: {
  agentId?: string;
  cronRunId?: string;
  activeSessionId?: string;
}): string | undefined {
  const agentId = params.agentId?.trim();
  const runId = params.activeSessionId?.trim() || params.cronRunId?.trim();
  if (!agentId || !runId) {
    return undefined;
  }
  return path.join(resolveStateDir(), "agents", agentId, "sessions", `${runId}.jsonl`);
}

function readTailText(filePath: string): { text: string; truncated: boolean } | undefined {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) {
      return undefined;
    }
    const length = Math.min(stat.size, SESSION_TAIL_BYTES);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(filePath, "r");
    const read = fs.readSync(fd, buffer, 0, length, start);
    return { text: buffer.subarray(0, read).toString("utf8"), truncated: start > 0 };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort diagnostic context only
      }
    }
  }
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const texts = content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return undefined;
      }
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : undefined;
    })
    .filter((text): text is string => Boolean(text?.trim()));
  return texts.length ? texts.join(" ") : undefined;
}

export function readLastAssistantFromSessionFile(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const tail = readTailText(filePath);
  if (!tail?.text) {
    return undefined;
  }
  const lines = tail.text.split(/\r?\n/).filter(Boolean);
  if (tail.truncated && lines.length > 0) {
    lines.shift();
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as {
        message?: { role?: unknown; content?: unknown };
      };
      if (parsed.message?.role !== "assistant") {
        continue;
      }
      const text = textFromContent(parsed.message.content)?.trim();
      if (text) {
        return text;
      }
    } catch {
      // Ignore partial or non-JSON diagnostic transcript lines.
    }
  }
  return undefined;
}

function readCronJobName(cronJobId: string | undefined): string | undefined {
  if (!cronJobId) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(path.join(resolveStateDir(), "cron", "jobs.json"), "utf8");
    const parsed = JSON.parse(raw) as { jobs?: Array<{ id?: unknown; name?: unknown }> };
    const job = parsed.jobs?.find((entry) => entry.id === cronJobId);
    return typeof job?.name === "string" && job.name.trim() ? job.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCronSessionDiagnosticContext(params: {
  sessionKey?: string;
  activeSessionId?: string;
}): CronSessionContext {
  const parsed = parseCronRunSessionKey(params.sessionKey);
  if (!parsed.cronJobId && !parsed.cronRunId) {
    return {};
  }
  return {
    ...parsed,
    cronJobName: readCronJobName(parsed.cronJobId),
    lastAssistant: readLastAssistantFromSessionFile(
      resolveSessionFile({ ...parsed, activeSessionId: params.activeSessionId }),
    ),
  };
}

export function formatCronSessionDiagnosticFields(context: CronSessionContext): string {
  const fields: string[] = [];
  if (context.cronJobId) {
    fields.push(`cronJobId=${context.cronJobId}`);
  }
  if (context.cronRunId) {
    fields.push(`cronRunId=${context.cronRunId}`);
  }
  if (context.cronJobName) {
    fields.push(`cronJob=${quoteLogField(context.cronJobName)}`);
  }
  if (context.lastAssistant) {
    fields.push(`lastAssistant=${quoteLogField(context.lastAssistant)}`);
  }
  return fields.join(" ");
}

export function formatStoppedCronSessionDiagnosticFields(context: CronSessionContext): string {
  const fields: string[] = [];
  if (context.cronJobName) {
    fields.push(`stopped=${quoteLogField(context.cronJobName)}`);
  }
  const rest = formatCronSessionDiagnosticFields({
    cronJobId: context.cronJobId,
    cronRunId: context.cronRunId,
    lastAssistant: context.lastAssistant,
  });
  if (rest) {
    fields.push(rest);
  }
  return fields.join(" ");
}

export const __testing = {
  quoteLogField,
};
