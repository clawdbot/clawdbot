import { redactSensitiveText } from "../logging/redact.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type {
  CronRunDiagnostic,
  CronRunDiagnostics,
  CronRunDiagnosticSeverity,
  CronRunDiagnosticSource,
} from "./types.js";

const MAX_ENTRIES = 10;
const MAX_ENTRY_CHARS = 1_000;
const MAX_SUMMARY_CHARS = 2_000;
const EXEC_DIAGNOSTIC_TAIL_CHARS = 2_000;

function normalizeSeverity(value: unknown): CronRunDiagnosticSeverity {
  return value === "info" || value === "warn" || value === "error" ? value : "error";
}

function normalizeSource(value: unknown): CronRunDiagnosticSource {
  switch (value) {
    case "cron-preflight":
    case "cron-setup":
    case "model-preflight":
    case "agent-run":
    case "tool":
    case "exec":
    case "delivery":
      return value;
    default:
      return "agent-run";
  }
}

function normalizeTimestamp(value: unknown, nowMs: () => number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : nowMs();
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return normalizeOptionalString(value);
}

function normalizeExitCode(value: unknown): number | null | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return value === null ? null : undefined;
}

function tailText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

function normalizeDiagnosticMessage(value: unknown): { message?: string; truncated?: boolean } {
  if (typeof value !== "string") {
    return {};
  }
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return {};
  }
  const redacted = redactSensitiveText(normalized, { mode: "tools" });
  if (redacted.length <= MAX_ENTRY_CHARS) {
    return { message: redacted };
  }
  return { message: `${redacted.slice(0, MAX_ENTRY_CHARS - 1)}…`, truncated: true };
}

function trimSummary(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= MAX_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

export function summarizeCronRunDiagnostics(
  diagnostics: CronRunDiagnostics | undefined,
): string | undefined {
  if (!diagnostics) {
    return undefined;
  }
  return trimSummary(diagnostics.summary ?? diagnostics.entries[0]?.message);
}

export function normalizeCronRunDiagnostics(
  value: unknown,
  opts?: { nowMs?: () => number },
): CronRunDiagnostics | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { summary?: unknown; entries?: unknown };
  const nowMs = opts?.nowMs ?? Date.now;
  const entriesRaw = Array.isArray(record.entries) ? record.entries : [];
  const entries: CronRunDiagnostic[] = [];
  for (const item of entriesRaw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Partial<CronRunDiagnostic>;
    const normalized = normalizeDiagnosticMessage(entry.message);
    if (!normalized.message) {
      continue;
    }
    entries.push({
      ts: normalizeTimestamp(entry.ts, nowMs),
      source: normalizeSource(entry.source),
      severity: normalizeSeverity(entry.severity),
      message: normalized.message,
      ...(typeof entry.toolName === "string" && entry.toolName.trim()
        ? { toolName: entry.toolName.trim() }
        : {}),
      ...(typeof entry.exitCode === "number" && Number.isFinite(entry.exitCode)
        ? { exitCode: entry.exitCode }
        : entry.exitCode === null
          ? { exitCode: null }
          : {}),
      ...(entry.truncated === true || normalized.truncated ? { truncated: true } : {}),
    });
    if (entries.length > MAX_ENTRIES) {
      entries.shift();
    }
  }
  const summary = trimSummary(
    typeof record.summary === "string"
      ? redactSensitiveText(record.summary, { mode: "tools" })
      : undefined,
  );
  if (entries.length === 0 && !summary) {
    return undefined;
  }
  return { ...(summary ? { summary } : {}), entries };
}

export function mergeCronRunDiagnostics(
  ...values: Array<CronRunDiagnostics | undefined>
): CronRunDiagnostics | undefined {
  const entries: CronRunDiagnostic[] = [];
  let summaryCandidate: { summary: string; severity: number; order: number } | undefined;
  for (const value of values) {
    const normalized = normalizeCronRunDiagnostics(value);
    if (!normalized) {
      continue;
    }
    const entryCandidate =
      normalized.entries.findLast((entry) => entry.severity === "error") ??
      normalized.entries.findLast((entry) => entry.severity === "warn") ??
      normalized.entries.findLast((entry) => entry.severity === "info");
    const summary = trimSummary(normalized.summary ?? entryCandidate?.message);
    if (summary) {
      const severity =
        entryCandidate?.severity === "error" ? 2 : entryCandidate?.severity === "warn" ? 1 : 0;
      const order = entries.length + normalized.entries.length;
      if (
        !summaryCandidate ||
        severity > summaryCandidate.severity ||
        (severity === summaryCandidate.severity && order >= summaryCandidate.order)
      ) {
        summaryCandidate = { summary, severity, order };
      }
    }
    entries.push(...normalized.entries);
  }
  return normalizeCronRunDiagnostics({
    summary: summaryCandidate?.summary,
    entries,
  });
}

export function createCronRunDiagnosticsFromError(
  source: CronRunDiagnosticSource,
  error: unknown,
  opts?: {
    severity?: CronRunDiagnosticSeverity;
    nowMs?: () => number;
    toolName?: string;
    exitCode?: number | null;
  },
): CronRunDiagnostics | undefined {
  const message = formatUnknownError(error);
  return normalizeCronRunDiagnostics(
    {
      summary: message,
      entries: [
        {
          ts: opts?.nowMs?.() ?? Date.now(),
          source,
          severity: opts?.severity ?? "error",
          message,
          toolName: opts?.toolName,
          exitCode: opts?.exitCode,
        },
      ],
    },
    opts,
  );
}

export function createCronRunDiagnosticsFromExecDetails(
  details: unknown,
  opts?: {
    nowMs?: () => number;
    toolName?: string;
  },
): CronRunDiagnostics | undefined {
  if (!isRecord(details)) {
    return undefined;
  }
  const status = typeof details.status === "string" ? details.status : undefined;
  const exitCode = normalizeExitCode(details.exitCode);
  const relevant = status === "failed" || (typeof exitCode === "number" && exitCode !== 0);
  if (!relevant) {
    return undefined;
  }
  const aggregated = normalizeOptionalString(details.aggregated);
  const message = aggregated
    ? tailText(aggregated, EXEC_DIAGNOSTIC_TAIL_CHARS)
    : typeof exitCode === "number"
      ? `exec failed with exit code ${exitCode}`
      : "exec failed";
  return normalizeCronRunDiagnostics(
    {
      summary: message,
      entries: [
        {
          ts: opts?.nowMs?.() ?? Date.now(),
          source: "exec",
          severity: status === "failed" ? "error" : "warn",
          message,
          toolName: opts?.toolName,
          exitCode,
        },
      ],
    },
    opts,
  );
}

export function createCronRunDiagnosticsFromToolPayload(
  payload: unknown,
  opts?: { nowMs?: () => number; finalStatus?: "ok" | "error" | "skipped" },
): CronRunDiagnostics | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const toolName = normalizeToolName(payload.toolName) ?? normalizeToolName(payload.name);
  const detailsDiagnostics = createCronRunDiagnosticsFromExecDetails(payload.details, {
    nowMs: opts?.nowMs,
    toolName,
  });
  const isError = payload.isError === true;
  const text = typeof payload.text === "string" ? payload.text : undefined;
  const textDiagnostics =
    isError && text
      ? createCronRunDiagnosticsFromError("tool", text, {
          severity: "error",
          nowMs: opts?.nowMs,
          toolName,
        })
      : undefined;
  return mergeCronRunDiagnostics(detailsDiagnostics, textDiagnostics);
}

export function createCronRunDiagnosticsFromAgentResult(
  result: unknown,
  opts?: { nowMs?: () => number; finalStatus?: "ok" | "error" | "skipped" },
): CronRunDiagnostics | undefined {
  const record = isRecord(result) ? result : {};
  const meta =
    record.meta && typeof record.meta === "object" ? (record.meta as Record<string, unknown>) : {};
  const diagnostics: Array<CronRunDiagnostics | undefined> = [];
  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  for (const payload of payloads) {
    diagnostics.push(createCronRunDiagnosticsFromToolPayload(payload, opts));
  }
  const metaError =
    meta.error && typeof meta.error === "object"
      ? (meta.error as { message?: unknown })
      : undefined;
  if (typeof metaError?.message === "string") {
    diagnostics.push(createCronRunDiagnosticsFromError("agent-run", metaError.message, opts));
  }
  const failureSignal =
    meta.failureSignal && typeof meta.failureSignal === "object"
      ? (meta.failureSignal as { message?: unknown })
      : undefined;
  if (typeof failureSignal?.message === "string") {
    diagnostics.push(createCronRunDiagnosticsFromError("tool", failureSignal.message, opts));
  }
  return mergeCronRunDiagnostics(...diagnostics);
}
