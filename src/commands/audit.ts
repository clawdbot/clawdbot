/** Operator CLI for bounded metadata-only activity audit pages. */
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  AuditActivityListParams,
  AuditActivityListResult,
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
  kind?: AuditActivityListParams["kind"];
  status?: AuditActivityListParams["status"];
  direction?: AuditActivityListParams["direction"];
  channel?: string;
  after?: string;
  before?: string;
  cursor?: string;
  limit?: string;
  json?: boolean;
};

type AuditCliEvent = {
  occurredAt: number;
  kind: string;
  status: string;
  action: string;
  direction?: string;
  channel?: string;
  agentId?: string;
  runId?: string;
  toolName?: string;
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

function formatAuditRows(events: readonly AuditCliEvent[]): string[] {
  const rows = ["TIME\tKIND\tDIRECTION\tCHANNEL\tSTATUS\tAGENT\tRUN\tACTION"];
  for (const event of events) {
    rows.push(
      [
        timestampMsToIsoString(event.occurredAt) ?? String(event.occurredAt),
        event.kind,
        short(event.direction, 10),
        short(event.channel, 18),
        event.status,
        short(event.agentId, 18),
        short(event.runId, 18),
        event.toolName ? `${event.action}:${short(event.toolName, 28)}` : event.action,
      ].join("\t"),
    );
  }
  return rows;
}

function isUnsupportedActivityMethodError(value: unknown): value is Error {
  // Frozen shipped-gateway strings: pre-activity gateways answer unknown
  // methods with "unknown method: ..." or fail closed to operator.admin. A
  // current gateway registers audit.activity.list at operator.read, so it can
  // never emit these for this method; matching them only triggers the legacy
  // audit.list fallback.
  return (
    value instanceof Error &&
    value.name === "GatewayClientRequestError" &&
    (value as Error & { gatewayCode?: unknown }).gatewayCode === "INVALID_REQUEST" &&
    (value.message === "unknown method: audit.activity.list" ||
      value.message === "missing scope: operator.admin")
  );
}

function hasMessageSpecificFilters(options: AuditListCommandOptions): boolean {
  return (
    options.kind === "message" || options.direction !== undefined || options.channel !== undefined
  );
}

function validateAuditKind(kind: AuditListCommandOptions["kind"]): void {
  if (kind !== undefined && kind !== "agent_run" && kind !== "tool_action" && kind !== "message") {
    throw new Error("--kind must be agent_run, tool_action, or message.");
  }
}

function toLegacyAuditListParams(params: AuditActivityListParams): AuditListParams {
  return {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.kind === "agent_run" || params.kind === "tool_action" ? { kind: params.kind } : {}),
    ...(params.status ? { status: params.status } : {}),
    ...(params.after !== undefined ? { after: params.after } : {}),
    ...(params.before !== undefined ? { before: params.before } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
  };
}

async function queryAuditActivity(
  params: AuditActivityListParams,
  options: AuditListCommandOptions,
): Promise<AuditActivityListResult | AuditListResult> {
  try {
    return await callGateway<AuditActivityListResult>({
      method: "audit.activity.list",
      params,
    });
  } catch (error) {
    if (!isUnsupportedActivityMethodError(error)) {
      throw error;
    }
    if (hasMessageSpecificFilters(options)) {
      throw new Error(
        "The connected Gateway does not support message audit filters. Upgrade the Gateway to use --kind message, --direction, or --channel.",
        { cause: error },
      );
    }
    return await callGateway<AuditListResult>({
      method: "audit.list",
      params: toLegacyAuditListParams(params),
    });
  }
}

/** Query one stable page. JSON output is a bounded export with its next cursor. */
export async function auditListCommand(
  options: AuditListCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  validateAuditKind(options.kind);
  const after = parseAuditTimestamp(options.after, "--after");
  const before = parseAuditTimestamp(options.before, "--before");
  if (after !== undefined && before !== undefined && after > before) {
    throw new Error("--after must not be later than --before.");
  }
  const params: AuditActivityListParams = {
    limit: parseAuditLimit(options.limit),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.direction ? { direction: options.direction } : {}),
    ...(options.channel ? { channel: options.channel } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
  };
  const result = await queryAuditActivity(params, options);
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

const testApi = {
  formatAuditRows,
  hasMessageSpecificFilters,
  isUnsupportedActivityMethodError,
  parseAuditLimit,
  parseAuditTimestamp,
  toLegacyAuditListParams,
  validateAuditKind,
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.auditCommandTestApi")] =
    testApi;
}
