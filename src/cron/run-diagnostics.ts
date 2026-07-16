/** Builds bounded, redacted diagnostics for cron run logs and UI surfaces. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import { normalizeToolName as normalizePolicyToolName } from "../agents/tool-policy.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { redactSensitiveText } from "../logging/redact.js";
import {
  formatUnknownError,
  isRecord,
  normalizeCronRunDiagnostics as normalizeCronRunDiagnosticsValue,
  normalizeExitCode,
  normalizeToolName,
  tailText,
} from "./run-diagnostics-normalize.js";
import type {
  CronRunDiagnostic,
  CronRunDiagnostics,
  CronRunDiagnosticSeverity,
  CronRunDiagnosticSource,
} from "./types.js";

const MAX_SUMMARY_CHARS = 2_000;
const EXEC_DIAGNOSTIC_TAIL_CHARS = 2_000;
const WEB_SEARCH_TOOL_NAME = "web_search";

const MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE =
  "web_search tool requested in toolsAllow but no web search provider is selected. Configure one with: openclaw configure --section web, or set tools.web.search.provider.";

export function toolsAllowRequestsWebSearch(toolsAllow?: string[]): boolean {
  const explicitAllow = (toolsAllow ?? []).filter(
    (entry) => normalizePolicyToolName(entry) !== "*",
  );
  return (
    explicitAllow.length > 0 &&
    isToolAllowedByPolicyName(WEB_SEARCH_TOOL_NAME, { allow: explicitAllow })
  );
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

/** Returns the operator-facing summary for persisted cron diagnostics. */
export function summarizeCronRunDiagnostics(
  diagnostics: CronRunDiagnostics | undefined,
): string | undefined {
  if (!diagnostics) {
    return undefined;
  }
  return trimSummary(diagnostics.summary ?? diagnostics.entries[0]?.message);
}

/** Normalizes untrusted cron diagnostic payloads into bounded, redacted entries. */
export function normalizeCronRunDiagnostics(
  value: unknown,
  opts?: { nowMs?: () => number },
): CronRunDiagnostics | undefined {
  return normalizeCronRunDiagnosticsValue(value, {
    ...opts,
    redactText: (text) => redactSensitiveText(text, { mode: "tools" }),
  });
}

/** Merges cron diagnostics while choosing the highest-severity latest summary. */
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
      // Summary text is operator-facing; prefer severe diagnostics, then the
      // newest diagnostic at the same severity so retries surface current cause.
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

/** Converts an arbitrary thrown cron error into a redacted diagnostic entry. */
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

/** Reports a cron preflight warning for an explicitly allowed web_search with no provider. */
export function createCronRunDiagnosticsFromMissingWebSearchProvider(params: {
  toolsAllow?: string[];
  hasWebSearchProvider: boolean;
  nowMs?: () => number;
}): CronRunDiagnostics | undefined {
  if (params.hasWebSearchProvider || !params.toolsAllow || params.toolsAllow.length === 0) {
    return undefined;
  }
  if (!toolsAllowRequestsWebSearch(params.toolsAllow)) {
    return undefined;
  }
  return normalizeCronRunDiagnostics(
    {
      summary: MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE,
      entries: [
        {
          ts: params.nowMs?.() ?? Date.now(),
          source: "cron-preflight",
          severity: "warn",
          message: MISSING_WEB_SEARCH_PROVIDER_DIAGNOSTIC_MESSAGE,
          toolName: WEB_SEARCH_TOOL_NAME,
        },
      ],
    },
    { nowMs: params.nowMs },
  );
}

/** Extracts failed exec details from tool metadata into cron diagnostics. */
function createCronRunDiagnosticsFromExecDetails(
  details: unknown,
  opts?: {
    nowMs?: () => number;
    toolName?: string;
    finalStatus?: "ok" | "error" | "skipped";
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
          severity: opts?.finalStatus === "ok" ? "warn" : status === "failed" ? "error" : "warn",
          message,
          toolName: opts?.toolName,
          exitCode,
        },
      ],
    },
    opts,
  );
}

/** Extracts tool-call failure diagnostics from an agent reply payload. */
function createCronRunDiagnosticsFromToolPayload(
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
    finalStatus: opts?.finalStatus,
  });
  const isError = payload.isError === true;
  const text = typeof payload.text === "string" ? payload.text : undefined;
  const isNonTerminalToolWarning =
    opts?.finalStatus === "ok" &&
    getReplyPayloadMetadata(payload)?.nonTerminalToolErrorWarning === true;
  const textDiagnostics =
    isError && text
      ? createCronRunDiagnosticsFromError("tool", text, {
          severity: isNonTerminalToolWarning || opts?.finalStatus === "ok" ? "warn" : "error",
          nowMs: opts?.nowMs,
          toolName,
        })
      : undefined;
  return mergeCronRunDiagnostics(detailsDiagnostics, textDiagnostics);
}

/** Extracts cron run diagnostics from agent result payloads and metadata. */
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
