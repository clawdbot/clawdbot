// Control UI module implements activity model behavior.
import { formatUnknownText, truncateText } from "./format.ts";

export const ACTIVITY_ENTRY_LIMIT = 100;
export const ACTIVITY_OUTPUT_PREVIEW_LIMIT = 2_000;

export type ActivityStatus = "running" | "done" | "error";

export type ActivityEntry = {
  id: string;
  toolCallId: string;
  runId: string;
  sessionKey?: string;
  toolName: string;
  status: ActivityStatus;
  startedAt: number;
  updatedAt: number;
  durationMs: number;
  outputPreview?: string;
  outputTruncated: boolean;
  summary: string;
  hiddenArgumentCount: number;
};

const ACTIVITY_STATUS_SUMMARY_LABELS: Record<ActivityStatus, string> = {
  running: "running",
  done: "completed",
  error: "failed",
};

type ActivityHost = {
  activityEntries?: ActivityEntry[];
};

type ToolEventPayload = {
  runId: string;
  ts: number;
  sessionKey?: string;
  data: Record<string, unknown>;
};

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Authorization|Cookie|Set-Cookie)\s*:\s*[^\n\r]+/gi, "$1: [redacted]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[redacted]"],
  [
    /\b(api[_-]?key|token|secret|password|passwd|authorization)\b(\s*[:=]\s*)["']?[^"',\s}]+/gi,
    "$1$2[redacted]",
  ],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted private key]",
  ],
  [
    /(^|[\s"'`=])(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)[^\s"'`,;]+/g,
    "$1[redacted path]",
  ],
];

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const record = readRecord(value);
  if (!record) {
    return null;
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = record.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .map((item) => {
      const entry = readRecord(item);
      return entry?.type === "text" && typeof entry.text === "string" ? entry.text : null;
    })
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n") : null;
}

function stringifyOutput(value: unknown): string | null {
  const text = extractText(value);
  if (text !== null) {
    return text;
  }
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return formatUnknownText(value);
  }
}

function redactSensitiveText(value: string): string {
  return SECRET_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );
}

function buildOutputPreview(value: unknown): { text?: string; truncated: boolean } {
  const raw = stringifyOutput(value);
  if (!raw) {
    return { truncated: false };
  }
  const redacted = redactSensitiveText(raw);
  const truncated = truncateText(redacted, ACTIVITY_OUTPUT_PREVIEW_LIMIT);
  return { text: truncated.text, truncated: truncated.truncated };
}

function countArgumentFields(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  const record = readRecord(value);
  if (record) {
    return Object.keys(record).length;
  }
  return 1;
}

function hasExplicitErrorFlag(value: Record<string, unknown> | null): boolean {
  return value?.isError === true || value?.is_error === true;
}

function resolveStatus(data: Record<string, unknown>): ActivityStatus {
  const phase = toTrimmedString(data.phase);
  if (phase !== "result") {
    return "running";
  }
  const result = readRecord(data.result);
  if (hasExplicitErrorFlag(data) || hasExplicitErrorFlag(result)) {
    return "error";
  }
  const status = toTrimmedString(data.status) ?? toTrimmedString(result?.status);
  if (status && /error|fail|failed|failure/i.test(status)) {
    return "error";
  }
  const exitCode = Number(result?.exitCode ?? data.exitCode);
  if (Number.isFinite(exitCode) && exitCode !== 0) {
    return "error";
  }
  return "done";
}

function statusLabel(status: ActivityStatus): string {
  return ACTIVITY_STATUS_SUMMARY_LABELS[status];
}

function buildSummary(toolName: string, status: ActivityStatus, hiddenArgCount: number): string {
  const argText = `${hiddenArgCount} argument${hiddenArgCount === 1 ? "" : "s"} hidden`;
  return `${toolName} ${statusLabel(status)}; ${argText}`;
}

export function updateActivityFromToolEvent(host: ActivityHost, payload: ToolEventPayload) {
  if (!Array.isArray(host.activityEntries)) {
    return;
  }
  const data = payload.data ?? {};
  const toolCallId = toTrimmedString(data.toolCallId);
  if (!toolCallId) {
    return;
  }
  const toolName = toTrimmedString(data.name) ?? "tool";
  const id = `${payload.runId}:${toolCallId}`;
  const now = Date.now();
  const startedAt = typeof payload.ts === "number" ? payload.ts : now;
  const status = resolveStatus(data);
  const outputValue =
    data.phase === "update" ? data.partialResult : data.phase === "result" ? data.result : null;
  const preview = buildOutputPreview(outputValue);
  const existing = host.activityEntries.find((entry) => entry.id === id);
  const hiddenArgCount =
    data.args !== undefined ? countArgumentFields(data.args) : (existing?.hiddenArgumentCount ?? 0);
  const outputPreview = preview.text ?? existing?.outputPreview;
  const nextEntry: ActivityEntry = {
    id,
    toolCallId,
    runId: payload.runId,
    ...(payload.sessionKey ? { sessionKey: payload.sessionKey } : {}),
    toolName,
    status,
    startedAt: existing?.startedAt ?? startedAt,
    updatedAt: now,
    durationMs: Math.max(0, now - (existing?.startedAt ?? startedAt)),
    outputTruncated: preview.truncated || existing?.outputTruncated === true,
    summary: buildSummary(toolName, status, hiddenArgCount),
    hiddenArgumentCount: hiddenArgCount,
    ...(outputPreview ? { outputPreview } : {}),
  };
  const next = existing
    ? host.activityEntries.map((entry) => (entry.id === id ? nextEntry : entry))
    : [...host.activityEntries, nextEntry];
  host.activityEntries = next.slice(-ACTIVITY_ENTRY_LIMIT);
}

export function resetActivityEntries(host: ActivityHost) {
  if (Array.isArray(host.activityEntries)) {
    host.activityEntries = [];
  }
}
