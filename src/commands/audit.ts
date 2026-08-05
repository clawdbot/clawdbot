/** Operator CLI for bounded metadata-only activity audit pages. */
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  AuditActivityListParams,
  AuditActivityListResult,
  AuditListParams,
  AuditListResult,
  AuditRunInspectParams,
  AuditRunInspectResult,
  DecisionReceiptV1,
  ExecutionIdentityContextV1,
  PrincipalRefV1,
} from "../../packages/gateway-protocol/src/index.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { parseAbsoluteTimeMs } from "../cron/parse.js";
import { callGateway } from "../gateway/call.js";
import { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 500;
const DEFAULT_AUDIT_DECISION_LIMIT = 50;
const MAX_AUDIT_DECISION_LIMIT = 100;
const MAX_AUDIT_EXECUTION_LIMIT = 50;

export type AuditListCommandOptions = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  executionId?: string;
  kind?: AuditActivityListParams["kind"];
  status?: AuditActivityListParams["status"];
  direction?: AuditActivityListParams["direction"];
  channel?: string;
  after?: string;
  before?: string;
  cursor?: string;
  limit?: string;
  explain?: boolean;
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

function parseAuditDecisionLimit(value: string | undefined): number {
  if (!value) {
    return DEFAULT_AUDIT_DECISION_LIMIT;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined || parsed > MAX_AUDIT_DECISION_LIMIT) {
    throw new Error(
      `--limit must be between 1 and ${String(MAX_AUDIT_DECISION_LIMIT)} with --explain.`,
    );
  }
  return parsed;
}

function parseAuditExecutionLimit(value: string | undefined): number {
  const parsed = parseAuditDecisionLimit(value);
  if (parsed > MAX_AUDIT_EXECUTION_LIMIT) {
    throw new Error(
      `--limit must be between 1 and ${String(MAX_AUDIT_EXECUTION_LIMIT)} for run discovery.`,
    );
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

function isUnsupportedRunInspectMethodError(value: unknown): value is Error {
  return (
    value instanceof Error &&
    value.name === "GatewayClientRequestError" &&
    (value as Error & { gatewayCode?: unknown }).gatewayCode === "INVALID_REQUEST" &&
    (value.message === "unknown method: audit.run.inspect" ||
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

function unsupportedRunInspection(
  selector: { runId: string } | { executionId: string },
): AuditRunInspectResult {
  const missingEvidence = ["identity.context"];
  return {
    schemaVersion: 1,
    run: { ...selector, status: "unknown" },
    identity: {
      state: "unsupported",
      reasonCode: "gateway_upgrade_required",
      missingEvidence,
      remediation: [
        {
          code: "upgrade_gateway",
          text: "Upgrade the Gateway, run the agent again, and repeat this exact-run inspection.",
        },
      ],
    },
    decisions: [],
    coverage: { state: "unsupported", missingEvidence },
  };
}

async function queryAuditRunInspection(
  params: AuditRunInspectParams,
): Promise<AuditRunInspectResult> {
  try {
    return await callGateway<AuditRunInspectResult>({ method: "audit.run.inspect", params });
  } catch (error) {
    if (!isUnsupportedRunInspectMethodError(error)) {
      throw error;
    }
    return unsupportedRunInspection(
      typeof params.runId === "string"
        ? { runId: params.runId }
        : { executionId: params.executionId! },
    );
  }
}

function safe(value: string | undefined): string {
  return sanitizeTerminalText(value ?? "") || "-";
}

function principalText(principal: PrincipalRefV1): string {
  return `${safe(principal.kind)} ${safe(principal.principalRef)} in ${safe(principal.domainRef)}`;
}

function fieldLine(label: string, state: string, value?: string): string {
  return `  ${label} [${safe(state)}]${value ? `: ${safe(value)}` : ""}`;
}

const IDENTITY_FIELD_LABELS = [
  "Trust domain",
  "Invoker",
  "Ingress",
  "Agent principal",
  "Agent definition",
  "Runtime instance",
  "Represented subject",
  "Sponsor",
  "Applicable grants",
  "Assurance",
] as const;

function contextIdentityLines(context: ExecutionIdentityContextV1): string[] {
  const grants = context.applicableGrants.map((grant) => `${grant.grantRef} [${grant.state}]`);
  const assurance = context.assurance.map(
    (item) => `${item.kind} ${item.evidenceRef} [${item.strength}]`,
  );
  return [
    fieldLine(
      "Trust domain",
      context.trustDomain.state,
      `${context.trustDomain.kind} ${context.trustDomain.domainRef}`,
    ),
    fieldLine(
      "Invoker",
      context.invoker.state,
      context.invoker.principal ? principalText(context.invoker.principal) : undefined,
    ),
    fieldLine(
      "Ingress",
      context.ingress.state,
      `${context.ingress.kind} at ${context.ingress.boundary}${
        context.ingress.sourceRef ? ` (${context.ingress.sourceRef})` : ""
      }`,
    ),
    fieldLine("Agent principal", "present", principalText(context.agentPrincipal)),
    fieldLine(
      "Agent definition",
      context.agentDefinition.state,
      `${context.agentDefinition.definitionRef}${
        context.agentDefinition.revisionRef ? ` @ ${context.agentDefinition.revisionRef}` : ""
      }`,
    ),
    fieldLine(
      "Runtime instance",
      context.runtimeInstance.state,
      `${context.runtimeInstance.kind} ${context.runtimeInstance.runtimeRef}`,
    ),
    fieldLine(
      "Represented subject",
      context.representedSubject?.state ?? "absent",
      context.representedSubject ? principalText(context.representedSubject.principal) : undefined,
    ),
    fieldLine(
      "Sponsor",
      context.sponsor?.state ?? "absent",
      context.sponsor ? principalText(context.sponsor.principal) : undefined,
    ),
    fieldLine("Applicable grants", grants.length > 0 ? "present" : "absent", grants.join(", ")),
    fieldLine("Assurance", assurance.length > 0 ? "present" : "absent", assurance.join(", ")),
  ];
}

function unavailableIdentityLines(state: "unknown" | "unsupported"): string[] {
  return IDENTITY_FIELD_LABELS.map((label) => fieldLine(label, state));
}

function decisionLines(receipt: DecisionReceiptV1): string[] {
  return [
    `  ${safe(receipt.action.family)}.${safe(receipt.action.operation)}: ${safe(receipt.decision.outcome)}`,
    `    Coverage: ${safe(receipt.enforcement.coverageState)}`,
    `    Reason: ${safe(receipt.decision.reasonCode)}`,
    `    Source: ${safe(receipt.source.owner)} at ${safe(receipt.source.decisionBoundary)}`,
    ...(receipt.action.summary ? [`    Summary: ${safe(receipt.action.summary)}`] : []),
  ];
}

function formatAuditRunInspection(result: AuditRunInspectResult): string[] {
  const selectorText = result.run.executionId
    ? `Execution ${safe(result.run.executionId)}${result.run.runId ? ` (run ${safe(result.run.runId)})` : ""}`
    : `Run ${safe(result.run.runId)}`;
  const lines = [
    `${selectorText}: ${safe(result.run.status)} (${safe(result.coverage.state)})`,
    "",
    "Identity",
  ];
  if (result.identity.state === "present") {
    const identityLines = contextIdentityLines(result.identity.context);
    lines.push(
      `  Context: ${safe(result.identity.context.contextId)}`,
      `  Created: ${timestampMsToIsoString(result.identity.context.createdAt) ?? String(result.identity.context.createdAt)}`,
      ...identityLines.slice(0, 8),
      "",
      "Authority",
      ...identityLines.slice(8),
      "",
      "Lineage",
      result.identity.context.lineage
        ? fieldLine(
            "Parent",
            "present",
            result.identity.context.lineage.parentRunId ??
              result.identity.context.lineage.parentContextId ??
              `depth ${String(result.identity.context.lineage.depth)}`,
          )
        : fieldLine("Parent", "absent"),
    );
  } else if (result.identity.state === "ambiguous") {
    lines.push(
      `  Reason: ${safe(result.identity.reasonCode)}`,
      ...result.identity.candidates.map(
        (candidate) =>
          `  Candidate: ${safe(candidate.executionId)} (context ${safe(candidate.contextId)}, ${timestampMsToIsoString(candidate.createdAt) ?? String(candidate.createdAt)})`,
      ),
      "",
      "Authority",
      fieldLine("Selection", "unknown"),
      "",
      "Lineage",
      fieldLine("Parent", "unknown"),
    );
  } else {
    lines.push(
      `  Reason: ${safe(result.identity.reasonCode)}`,
      ...unavailableIdentityLines(result.identity.state).slice(0, 8),
      "",
      "Authority",
      ...unavailableIdentityLines(result.identity.state).slice(8),
      "",
      "Lineage",
      fieldLine("Parent", result.identity.state),
    );
  }
  lines.push("", "Decisions");
  if (result.decisions.length === 0) {
    lines.push("  none [absent]");
  } else {
    for (const receipt of result.decisions) {
      lines.push(...decisionLines(receipt));
    }
  }
  lines.push("", "Missing evidence");
  lines.push(
    ...(result.coverage.missingEvidence.length > 0
      ? result.coverage.missingEvidence.map((item) => `  - ${safe(item)}`)
      : ["  none"]),
  );
  const remediation = [
    ...(result.identity.state === "present" ? [] : result.identity.remediation),
    ...result.decisions.flatMap((decision) => decision.remediation),
  ];
  lines.push("", "Next steps");
  lines.push(
    ...(remediation.length > 0
      ? [...new Map(remediation.map((item) => [item.code, item])).values()].map(
          (item) => `  - ${safe(item.text)}`,
        )
      : ["  none"]),
  );
  if (result.nextDecisionCursor) {
    lines.push(`  More decisions: --cursor ${safe(result.nextDecisionCursor)}`);
  }
  if (result.nextExecutionCursor) {
    lines.push(`  More executions: --cursor ${safe(result.nextExecutionCursor)}`);
  }
  return lines;
}

function hasExplainIncompatibleFilters(options: AuditListCommandOptions): boolean {
  return Boolean(
    options.agentId ||
    options.sessionKey ||
    options.kind ||
    options.status ||
    options.direction ||
    options.channel ||
    options.after ||
    options.before,
  );
}

/** Query one stable page. JSON output is a bounded export with its next cursor. */
export async function auditListCommand(
  options: AuditListCommandOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  if (options.explain) {
    const runId = options.runId?.trim();
    const executionId = options.executionId?.trim();
    if (Boolean(runId) === Boolean(executionId)) {
      throw new Error("Pass exactly one of --run <id> or --execution <id> with --explain.");
    }
    if (hasExplainIncompatibleFilters(options)) {
      throw new Error(
        "--explain accepts only --run or --execution, plus --limit, --cursor, and --json; remove activity-list filters.",
      );
    }
    const result = await queryAuditRunInspection({
      ...(executionId
        ? { executionId }
        : {
            runId: runId!,
            executionLimit: parseAuditExecutionLimit(options.limit),
            ...(options.cursor ? { executionCursor: options.cursor } : {}),
          }),
      decisionLimit: parseAuditDecisionLimit(options.limit),
      ...(options.cursor ? { decisionCursor: options.cursor } : {}),
    });
    if (options.json) {
      writeRuntimeJson(runtime, result);
      return;
    }
    for (const line of formatAuditRunInspection(result)) {
      runtime.log(line);
    }
    return;
  }
  if (options.executionId) {
    throw new Error("--execution requires --explain.");
  }
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
  isUnsupportedRunInspectMethodError,
  formatAuditRunInspection,
  hasExplainIncompatibleFilters,
  parseAuditDecisionLimit,
  parseAuditExecutionLimit,
  parseAuditLimit,
  parseAuditTimestamp,
  toLegacyAuditListParams,
  validateAuditKind,
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.auditCommandTestApi")] =
    testApi;
}
