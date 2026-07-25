/** Dependency-light normalization helpers for stored cron run diagnostics. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const MAX_ENTRIES = 10;
const MAX_ENTRY_CHARS = 1_000;
const MAX_SUMMARY_CHARS = 2_000;

type NormalizedCronRunDiagnostic = {
  ts: number;
  source: ReturnType<typeof normalizeSource>;
  severity: ReturnType<typeof normalizeSeverity>;
  message: string;
  toolName?: string;
  exitCode?: number | null;
  truncated?: boolean;
};

type NormalizedCronRunDiagnostics = {
  summary?: string;
  entries: NormalizedCronRunDiagnostic[];
};

type CronRunDiagnosticsNormalizeOptions = {
  nowMs?: () => number;
  // Authoring injects redaction; ledger/history reads trust canonical stored text.
  redactText?: (value: string) => string;
};

function normalizeSeverity(value: unknown): "info" | "warn" | "error" {
  return value === "info" || value === "warn" || value === "error" ? value : "error";
}

function normalizeSource(
  value: unknown,
):
  | "cron-preflight"
  | "cron-setup"
  | "model-preflight"
  | "agent-run"
  | "tool"
  | "exec"
  | "delivery" {
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

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return normalizeOptionalString(value);
}

export function normalizeExitCode(value: unknown): number | null | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return value === null ? null : undefined;
}

export function tailText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  // Exec output often ends with the actionable failure; keep the tail when
  // bounding diagnostic text for run logs and control surfaces.
  return sliceUtf16Safe(value, -maxChars);
}

function normalizeDiagnosticMessage(
  value: unknown,
  redactText: (value: string) => string,
): { message?: string; truncated?: boolean } {
  if (typeof value !== "string") {
    return {};
  }
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return {};
  }
  const redacted = redactText(normalized);
  if (redacted.length <= MAX_ENTRY_CHARS) {
    return { message: redacted };
  }
  return { message: `${truncateUtf16Safe(redacted, MAX_ENTRY_CHARS - 1)}…`, truncated: true };
}

function trimSummary(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= MAX_SUMMARY_CHARS) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, MAX_SUMMARY_CHARS - 1)}…`;
}

/** Normalizes stored cron diagnostic payloads into bounded entries. */
export function normalizeCronRunDiagnostics(
  value: unknown,
  opts?: CronRunDiagnosticsNormalizeOptions,
): NormalizedCronRunDiagnostics | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { summary?: unknown; entries?: unknown };
  const nowMs = opts?.nowMs ?? Date.now;
  const redactText = opts?.redactText ?? ((text: string) => text);
  const entriesRaw = Array.isArray(record.entries) ? record.entries : [];
  const entries: NormalizedCronRunDiagnostic[] = [];
  for (const item of entriesRaw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entry = item as Partial<NormalizedCronRunDiagnostic>;
    const normalized = normalizeDiagnosticMessage(entry.message, redactText);
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
      // Keep the latest diagnostics because late tool/exec failures usually
      // explain the final cron result better than setup noise.
      entries.shift();
    }
  }
  const summary = trimSummary(
    typeof record.summary === "string" ? redactText(record.summary) : undefined,
  );
  if (entries.length === 0 && !summary) {
    return undefined;
  }
  return { ...(summary ? { summary } : {}), entries };
}
