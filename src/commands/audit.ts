/** Operator CLI for bounded metadata-only run/tool audit pages. */
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  AuditEvent,
  AuditListParams,
  AuditListResult,
} from "../../packages/gateway-protocol/src/index.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { parseAbsoluteTimeMs } from "../cron/parse.js";
import { callGateway } from "../gateway/call.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 500;

export type AuditListCommandOptions = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  kind?: AuditListParams["kind"];
  status?: AuditListParams["status"];
  after?: string;
  before?: string;
  cursor?: string;
  limit?: string;
  json?: boolean;
};

function parseAuditTimestamp(value: string | undefined, flag: string): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed) && parseAbsoluteTimeMs(trimmed) !== null) {
    return parsed;
  }
  throw new Error(`${flag} must be an ISO timestamp or Unix milliseconds.`);
}

function parseAuditLimit(value: string | undefined): number {
  if (!value) {
    return DEFAULT_AUDIT_LIMIT;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined || parsed > MAX_AUDIT_LIMIT) {
    throw new Error(`--limit must be between 1 and ${MAX_AUDIT_LIMIT}.`);
  }
  return parsed;
}

function short(value: string | undefined, maxChars: number): string {
  if (!value) {
    return "-";
  }
  const sanitized = sanitizeTerminalText(value);
  if (!sanitized) {
    return "-";
  }
  return sanitized.length <= maxChars
    ? sanitized
    : `${truncateUtf16Safe(sanitized, maxChars - 1)}…`;
}

function formatAuditRows(events: AuditEvent[]): string[] {
  const rows = ["TIME\tKIND\tSTATUS\tAGENT\tRUN\tACTION"];
  for (const event of events) {
    rows.push(
      [
        timestampMsToIsoString(event.occurredAt) ?? String(event.occurredAt),
        event.kind,
        event.status,
        short(event.agentId, 18),
        short(event.runId, 18),
        event.toolName ? `${event.action}:${short(event.toolName, 28)}` : event.action,
      ].join("\t"),
    );
  }
  return rows;
}

/** Query one stable page. JSON output is a bounded export with its next cursor. */
export async function auditListCommand(
  options: AuditListCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const after = parseAuditTimestamp(options.after, "--after");
  const before = parseAuditTimestamp(options.before, "--before");
  if (after !== undefined && before !== undefined && after > before) {
    throw new Error("--after must not be later than --before.");
  }
  const params: AuditListParams = {
    limit: parseAuditLimit(options.limit),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
  };
  const result = await callGateway<AuditListResult>({ method: "audit.list", params });
  if (options.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  for (const row of formatAuditRows(result.events)) {
    runtime.log(row);
  }
  if (result.nextCursor) {
    runtime.log(`More records: --cursor ${result.nextCursor}`);
  }
}

export const testApi = { formatAuditRows, parseAuditLimit, parseAuditTimestamp };
