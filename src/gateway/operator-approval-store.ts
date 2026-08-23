// Persistent operator approval lifecycle and first-answer-wins transitions.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { sql, type Selectable } from "kysely";
import {
  type DecisionReceiptV1,
  type ApprovalPresentation,
  isWellFormedApprovalId,
  validateApprovalPresentation,
} from "../../packages/gateway-protocol/src/index.js";
import type { ExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import {
  buildApprovalResolutionRef,
  isApprovalResolutionRef,
} from "../infra/approval-resolution-ref.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type {
  DB as OpenClawStateKyselyDatabase,
  OperatorApprovals,
} from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

const OPERATOR_APPROVAL_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const OPERATOR_APPROVAL_RECEIPT_SUMMARY_MAX_ROWS = 128;
const OPERATOR_APPROVAL_RECEIPT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS = 64;
const OPERATOR_APPROVAL_PENDING_SCAN_PAGE_SIZE = 256;
const OPERATOR_APPROVAL_MAX_LIST_LIMIT = 1_001;
const OPERATOR_APPROVAL_HISTORY_DEFAULT_LIMIT = 50;
const OPERATOR_APPROVAL_HISTORY_MAX_LIMIT = 100;

export type OperatorApprovalKind = "exec" | "plugin" | "system-agent";
export type OperatorApprovalStatus = "pending" | "allowed" | "denied" | "expired" | "cancelled";
type OperatorApprovalDecision = "allow-once" | "allow-always" | "deny";
export type OperatorApprovalTerminalReason =
  | "user"
  | "timeout"
  | "malformed-verdict"
  | "no-route"
  | "run-aborted"
  | "gateway-restart"
  | "storage-corrupt";
type OperatorApprovalResolverKind = "device" | "channel" | "runtime" | "system";
type OperatorApprovalRequester = {
  deviceId: string | null;
  clientId: string | null;
  deviceTokenAuth: boolean;
};

export type OperatorApprovalSource = {
  agentId: string | null;
  sessionKey: string | null;
  sessionId: string | null;
  runId: string | null;
  toolCallId: string | null;
  toolName: string | null;
};

export type OperatorApprovalResolver = {
  kind: OperatorApprovalResolverKind;
  id: string | null;
};

export type OperatorApprovalRecord = {
  id: string;
  resolutionRef: string;
  kind: OperatorApprovalKind;
  status: OperatorApprovalStatus;
  presentation: ApprovalPresentation;
  requester: OperatorApprovalRequester;
  reviewerDeviceIds: string[];
  source: OperatorApprovalSource;
  audienceSessionKeys: string[];
  runtimeEpoch: string;
  createdAtMs: number;
  expiresAtMs: number;
  updatedAtMs: number;
  decision: OperatorApprovalDecision | null;
  terminalReason: OperatorApprovalTerminalReason | null;
  resolvedAtMs: number | null;
  resolver: OperatorApprovalResolver | null;
  consumedAtMs: number | null;
  consumedBy: string | null;
};

type NewOperatorApproval = {
  id: string;
  kind: OperatorApprovalKind;
  presentation: ApprovalPresentation;
  requester?: Partial<OperatorApprovalRequester>;
  reviewerDeviceIds?: readonly string[];
  source?: Partial<OperatorApprovalSource>;
  audienceSessionKeys?: readonly string[];
  runtimeEpoch: string;
  createdAtMs: number;
  expiresAtMs: number;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
};

type InsertOperatorApprovalResult =
  | { outcome: "inserted"; record: OperatorApprovalRecord }
  | { outcome: "existing"; record: OperatorApprovalRecord }
  | { outcome: "conflict" };

type GetOperatorApprovalResult =
  | { outcome: "found"; record: OperatorApprovalRecord }
  | { outcome: "not-found" }
  | { outcome: "corrupt"; id?: string };

export type ResolveOperatorApprovalResult =
  | { outcome: "resolved"; record: OperatorApprovalRecord }
  | { outcome: "expired"; record: OperatorApprovalRecord }
  | {
      outcome: "already-resolved";
      retry: "same" | "conflict";
      record: OperatorApprovalRecord;
    }
  | { outcome: "decision-not-allowed"; record: OperatorApprovalRecord }
  | { outcome: "not-found" }
  | { outcome: "corrupt" };

export type ForceDenyOperatorApprovalResult =
  | { outcome: "denied"; record: OperatorApprovalRecord }
  | { outcome: "expired"; record: OperatorApprovalRecord }
  | { outcome: "not-due"; record: OperatorApprovalRecord }
  | { outcome: "already-terminal"; record: OperatorApprovalRecord }
  | { outcome: "not-found" }
  | { outcome: "corrupt" };

type ConsumeOperatorApprovalResult =
  | { outcome: "consumed"; record: OperatorApprovalRecord }
  | { outcome: "already-consumed"; record: OperatorApprovalRecord }
  | { outcome: "redemption-expired"; record: OperatorApprovalRecord }
  | { outcome: "not-allow-once"; record: OperatorApprovalRecord }
  | { outcome: "not-found" }
  | { outcome: "corrupt" };

type TerminalizeOperatorApprovalsResult = {
  affected: number;
  records: OperatorApprovalRecord[];
};

type OperatorApprovalDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "operator_approvals" | "operator_approval_execution_identities"
>;
type OperatorApprovalRow = Selectable<OperatorApprovals>;

type OperatorApprovalHistoryCursor = {
  resolvedAtMs: number;
  id: string;
};

export class OperatorApprovalHistoryCursorError extends Error {
  constructor() {
    super("invalid operator approval history cursor");
    this.name = "OperatorApprovalHistoryCursorError";
  }
}

type ListTerminalOperatorApprovalsResult = {
  records: OperatorApprovalRecord[];
  nextCursor?: string;
};

type OperatorApprovalReceiptContext = {
  contextId: string;
  executionId: string;
  runId: string;
};
type OperatorApprovalReceiptRow = OperatorApprovalRow & {
  binding_context_id: string | null;
  binding_execution_id: string | null;
};
type OperatorApprovalReceiptCursor = { occurredAt: number; rowId: number };
type OperatorApprovalReceiptSnapshotRow = Omit<
  OperatorApprovalReceiptRow,
  "presentation_json" | "reviewer_device_ids_json" | "audience_session_keys_json"
> & {
  presentation_json: string | null;
  reviewer_device_ids_json: string | null;
  audience_session_keys_json: string | null;
  receipt_rowid: number;
  payload_bytes: number;
};
type OperatorApprovalReceiptSnapshotQueryRow = OperatorApprovalReceiptSnapshotRow & {
  cursor_boundary_rowid: number | null;
  page_present: 0 | 1;
};
type OperatorApprovalReceiptPageEntry = {
  receipt: DecisionReceiptV1;
  selectorId: string;
};
type OperatorApprovalReceiptPage = {
  entries: OperatorApprovalReceiptPageEntry[];
  nextCursor?: OperatorApprovalReceiptCursor;
};
type OperatorApprovalExecutionLinkState = "exact" | "missing" | "malformed" | "mismatch";

const OPERATOR_APPROVAL_DECISIONS = new Set<OperatorApprovalDecision>([
  "allow-once",
  "allow-always",
  "deny",
]);
const OPERATOR_APPROVAL_KINDS = new Set<OperatorApprovalKind>(["exec", "plugin", "system-agent"]);
const OPERATOR_APPROVAL_STATUSES = new Set<OperatorApprovalStatus>([
  "pending",
  "allowed",
  "denied",
  "expired",
  "cancelled",
]);
const OPERATOR_APPROVAL_TERMINAL_REASONS = new Set<OperatorApprovalTerminalReason>([
  "user",
  "timeout",
  "malformed-verdict",
  "no-route",
  "run-aborted",
  "gateway-restart",
  "storage-corrupt",
]);
const OPERATOR_APPROVAL_RESOLVER_KINDS = new Set<OperatorApprovalResolverKind>([
  "device",
  "channel",
  "runtime",
  "system",
]);

const OPERATOR_APPROVAL_EXECUTION_IDENTITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS operator_approval_execution_identities (
  approval_id TEXT NOT NULL PRIMARY KEY
    REFERENCES operator_approvals(approval_id) ON DELETE CASCADE,
  source_context_id TEXT NOT NULL CHECK (
    length(source_context_id) BETWEEN 1 AND 256 AND source_context_id = trim(source_context_id)
  ),
  source_execution_id TEXT NOT NULL CHECK (
    length(source_execution_id) BETWEEN 1 AND 256 AND source_execution_id = trim(source_execution_id)
  )
) STRICT;
`;

function normalizeExecutionIdentityBinding(input: NewOperatorApproval) {
  const binding = input.executionIdentityToken;
  const sourceRunId = normalizeNullableString(input.source?.runId);
  if (!binding || normalizeNullableString(binding.runId) !== sourceRunId) {
    return undefined;
  }
  const sourceContextId = normalizeNullableString(binding.contextId);
  const sourceExecutionId = normalizeNullableString(binding.executionId);
  if (
    !sourceContextId ||
    !sourceExecutionId ||
    sourceContextId.length > 256 ||
    sourceExecutionId.length > 256
  ) {
    return undefined;
  }
  return { sourceContextId, sourceExecutionId };
}

function parseApprovalPresentation(raw: string): ApprovalPresentation | null {
  const value = safeParseJson(raw);
  return validateApprovalPresentation(value) ? value : null;
}

function parseStringArray(raw: string): string[] | null {
  const value = safeParseJson(raw);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    return null;
  }
  return value as string[];
}

function requireString(value: string, label: string): string {
  const normalized = normalizeNullableString(value);
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function requireApprovalId(value: string): string {
  if (!isWellFormedApprovalId(value)) {
    throw new Error("operator approval id must be non-empty, well-formed Unicode, and not . or ..");
  }
  return value;
}

function encodeOperatorApprovalHistoryCursor(cursor: OperatorApprovalHistoryCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

function decodeOperatorApprovalHistoryCursor(raw: string): OperatorApprovalHistoryCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("v" in parsed) ||
      parsed.v !== 1 ||
      !("resolvedAtMs" in parsed) ||
      typeof parsed.resolvedAtMs !== "number" ||
      !Number.isSafeInteger(parsed.resolvedAtMs) ||
      parsed.resolvedAtMs < 0 ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      !isWellFormedApprovalId(parsed.id)
    ) {
      throw new OperatorApprovalHistoryCursorError();
    }
    return { resolvedAtMs: parsed.resolvedAtMs, id: parsed.id };
  } catch (error) {
    if (error instanceof OperatorApprovalHistoryCursorError) {
      throw error;
    }
    throw new OperatorApprovalHistoryCursorError();
  }
}

function stringifyPresentation(presentation: ApprovalPresentation): string {
  if (!validateApprovalPresentation(presentation)) {
    throw new Error("operator approval presentation must match the safe protocol schema");
  }
  let raw: string;
  try {
    raw = JSON.stringify(presentation);
  } catch (error) {
    throw new Error(`operator approval presentation is not JSON serializable: ${String(error)}`, {
      cause: error,
    });
  }
  if (!parseApprovalPresentation(raw)) {
    throw new Error("operator approval presentation must serialize to the safe protocol schema");
  }
  return raw;
}

function isValidTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function clampAuditTimestamp(nowMs: number, ...minimums: Array<number | null>): number {
  return Math.max(nowMs, ...minimums.filter((value): value is number => value !== null));
}

function hasValidLifecycleTuple(params: {
  row: OperatorApprovalRow;
  status: OperatorApprovalStatus;
  decision: OperatorApprovalDecision | null;
  terminalReason: OperatorApprovalTerminalReason | null;
  resolverKind: OperatorApprovalResolverKind | null;
}): boolean {
  const { row, status, decision, terminalReason, resolverKind } = params;
  const noConsumption = row.consumed_at_ms === null && row.consumed_by === null;
  if (status === "pending") {
    return (
      decision === null &&
      terminalReason === null &&
      row.resolved_at_ms === null &&
      resolverKind === null &&
      row.resolver_id === null &&
      noConsumption
    );
  }
  if (row.resolved_at_ms === null || resolverKind === null) {
    return false;
  }
  if (status === "allowed") {
    const validConsumption =
      decision === "allow-once"
        ? noConsumption || (row.consumed_at_ms !== null && Boolean(row.consumed_by?.trim()))
        : noConsumption;
    return (
      (decision === "allow-once" || decision === "allow-always") &&
      terminalReason === "user" &&
      validConsumption
    );
  }
  if (decision !== "deny" || !noConsumption) {
    return false;
  }
  if (status === "denied") {
    return (
      terminalReason === "user" ||
      terminalReason === "malformed-verdict" ||
      terminalReason === "no-route" ||
      terminalReason === "storage-corrupt"
    );
  }
  if (status === "expired") {
    return terminalReason === "timeout";
  }
  return (
    status === "cancelled" &&
    (terminalReason === "run-aborted" || terminalReason === "gateway-restart")
  );
}

function decodeOperatorApprovalRow(row: OperatorApprovalRow): OperatorApprovalRecord | null {
  const presentation = parseApprovalPresentation(row.presentation_json);
  const reviewerDeviceIds = parseStringArray(row.reviewer_device_ids_json);
  const audienceSessionKeys = parseStringArray(row.audience_session_keys_json);
  const kind = row.kind as OperatorApprovalKind;
  const status = row.status as OperatorApprovalStatus;
  const decision = row.decision as OperatorApprovalDecision | null;
  const terminalReason = row.terminal_reason as OperatorApprovalTerminalReason | null;
  const resolverKind = row.resolver_kind as OperatorApprovalResolverKind | null;
  if (
    !presentation ||
    !isWellFormedApprovalId(row.approval_id) ||
    !isApprovalResolutionRef(row.resolution_ref) ||
    !reviewerDeviceIds ||
    !audienceSessionKeys ||
    audienceSessionKeys.length > OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS ||
    !OPERATOR_APPROVAL_KINDS.has(kind) ||
    !OPERATOR_APPROVAL_STATUSES.has(status) ||
    !isValidTimestamp(row.created_at_ms) ||
    !isValidTimestamp(row.expires_at_ms) ||
    !isValidTimestamp(row.updated_at_ms) ||
    row.expires_at_ms < row.created_at_ms ||
    row.updated_at_ms < row.created_at_ms ||
    (row.resolved_at_ms !== null &&
      (!isValidTimestamp(row.resolved_at_ms) ||
        row.resolved_at_ms < row.created_at_ms ||
        row.resolved_at_ms > row.updated_at_ms)) ||
    (row.consumed_at_ms !== null &&
      (!isValidTimestamp(row.consumed_at_ms) ||
        row.resolved_at_ms === null ||
        row.consumed_at_ms < row.resolved_at_ms ||
        row.consumed_at_ms > row.updated_at_ms)) ||
    (row.requested_by_device_token_auth !== 0 && row.requested_by_device_token_auth !== 1) ||
    (decision !== null && !OPERATOR_APPROVAL_DECISIONS.has(decision)) ||
    (terminalReason !== null && !OPERATOR_APPROVAL_TERMINAL_REASONS.has(terminalReason)) ||
    (resolverKind !== null && !OPERATOR_APPROVAL_RESOLVER_KINDS.has(resolverKind))
  ) {
    return null;
  }
  if (
    presentation.kind !== kind ||
    row.resolution_ref !==
      buildApprovalResolutionRef({ approvalId: row.approval_id, approvalKind: kind }) ||
    !hasValidLifecycleTuple({ row, status, decision, terminalReason, resolverKind }) ||
    (status === "allowed" &&
      (!decision || !Array.prototype.includes.call(presentation.allowedDecisions, decision)))
  ) {
    return null;
  }

  return {
    id: row.approval_id,
    resolutionRef: row.resolution_ref,
    kind,
    status,
    presentation,
    requester: {
      deviceId: row.requested_by_device_id,
      clientId: row.requested_by_client_id,
      deviceTokenAuth: row.requested_by_device_token_auth === 1,
    },
    reviewerDeviceIds,
    source: {
      agentId: row.source_agent_id,
      sessionKey: row.source_session_key,
      sessionId: row.source_session_id,
      runId: row.source_run_id,
      toolCallId: row.source_tool_call_id,
      toolName: row.source_tool_name,
    },
    audienceSessionKeys,
    runtimeEpoch: row.runtime_epoch,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    updatedAtMs: row.updated_at_ms,
    decision,
    terminalReason,
    resolvedAtMs: row.resolved_at_ms,
    resolver:
      resolverKind === null
        ? null
        : {
            kind: resolverKind,
            id: row.resolver_id,
          },
    consumedAtMs: row.consumed_at_ms,
    consumedBy: row.consumed_by,
  };
}

function operatorApprovalReasonCode(record: OperatorApprovalRecord): string {
  if (record.status === "allowed") {
    return record.decision === "allow-always"
      ? "operator_approval_allowed_always"
      : "operator_approval_allowed_once";
  }
  if (record.status === "expired") {
    return "operator_approval_expired";
  }
  if (record.status === "cancelled") {
    return record.terminalReason === "gateway-restart"
      ? "operator_approval_cancelled_gateway_restart"
      : "operator_approval_cancelled_run_aborted";
  }
  switch (record.terminalReason) {
    case "malformed-verdict":
      return "operator_approval_denied_malformed_verdict";
    case "no-route":
      return "operator_approval_denied_no_route";
    case "storage-corrupt":
      return "operator_approval_denied_storage_corrupt";
    default:
      return "operator_approval_denied_by_reviewer";
  }
}

function operatorApprovalPolicyRefs(record: OperatorApprovalRecord): string[] {
  const refs = ["operator-approval:first-answer-wins"];
  switch (record.terminalReason) {
    case "user":
      refs.push("operator-approval:human-decision");
      break;
    case "timeout":
      refs.push("operator-approval:deadline");
      break;
    case "no-route":
      refs.push("operator-approval:delivery-route-required");
      break;
    case "run-aborted":
      refs.push("operator-approval:run-lifecycle");
      break;
    case "gateway-restart":
      refs.push("operator-approval:runtime-lifecycle");
      break;
    case "malformed-verdict":
      refs.push("operator-approval:valid-verdict-required");
      break;
    case "storage-corrupt":
      refs.push("operator-approval:fail-closed-storage");
      break;
    case null:
      break;
  }
  return refs.toSorted();
}

function operatorApprovalRemediation(
  record: OperatorApprovalRecord,
): DecisionReceiptV1["remediation"] {
  if (record.status === "allowed") {
    return [];
  }
  switch (record.terminalReason) {
    case "timeout":
      return [
        {
          code: "request_approval_again",
          text: "Request the action again and resolve the new approval before its deadline.",
        },
      ];
    case "no-route":
      return [
        {
          code: "restore_approval_route",
          text: "Connect an eligible approval client or configure an approval delivery route, then request the action again.",
        },
      ];
    case "run-aborted":
      return [
        {
          code: "start_new_run",
          text: "Start a new run and request the action again if it is still needed.",
        },
      ];
    case "gateway-restart":
      return [
        {
          code: "request_after_restart",
          text: "After the Gateway is available, request the action again to create a current approval.",
        },
      ];
    case "malformed-verdict":
      return [
        {
          code: "submit_supported_decision",
          text: "Request the action again and resolve it with one of the decisions shown by the approval prompt.",
        },
      ];
    case "storage-corrupt":
      return [
        {
          code: "inspect_state_integrity",
          text: "Run openclaw doctor and inspect the shared state database before requesting the action again.",
        },
      ];
    default:
      return [
        {
          code: "review_and_request_again",
          text: "Review the denial, then request the action again only if an eligible reviewer should reconsider it.",
        },
      ];
  }
}

function projectOperatorApprovalReceipt(
  record: OperatorApprovalRecord,
  context: OperatorApprovalReceiptContext,
): DecisionReceiptV1 {
  const allowed = record.status === "allowed";
  const sourceRef = record.resolutionRef;
  return {
    schemaVersion: 1,
    receiptId: `approval:${sourceRef}`,
    contextId: context.contextId,
    executionId: context.executionId,
    runId: context.runId,
    actionId: sourceRef,
    occurredAt: record.resolvedAtMs ?? record.updatedAtMs,
    action: {
      family: record.kind,
      operation: "approval",
      summary: allowed
        ? `A ${record.kind} approval allowed the requested action.`
        : `A ${record.kind} approval stopped the requested action.`,
    },
    decision: {
      outcome: allowed ? "allowed" : "denied",
      reasonCode: operatorApprovalReasonCode(record),
    },
    enforcement: {
      coverageState: "enforced",
      evaluatorRef: `operator-approval:${record.resolver?.kind ?? "system"}`,
      policyRefs: operatorApprovalPolicyRefs(record),
      grantRefs: allowed ? [`operator-approval-grant:${sourceRef}`] : [],
      contextFieldsUsed: ["contextId", "executionId", "runId"],
    },
    source: {
      owner: "operator_approvals",
      recordRef: sourceRef,
      decisionBoundary: "gateway.operator-approval.first-answer",
    },
    missingEvidence: [],
    remediation: operatorApprovalRemediation(record),
  };
}

function projectUnlinkedOperatorApprovalReceipt(
  record: OperatorApprovalRecord,
  context: OperatorApprovalReceiptContext,
  linkState: Exclude<OperatorApprovalExecutionLinkState, "exact">,
): DecisionReceiptV1 {
  const sourceRef = record.resolutionRef;
  const receiptId = `approval-unlinked:${createHash("sha256")
    .update(sourceRef, "utf8")
    .update("\0", "utf8")
    .update(context.contextId, "utf8")
    .digest("base64url")}`;
  return {
    schemaVersion: 1,
    receiptId,
    contextId: context.contextId,
    executionId: context.executionId,
    runId: context.runId,
    actionId: sourceRef,
    occurredAt: record.resolvedAtMs ?? record.updatedAtMs,
    action: {
      family: record.kind,
      operation: "approval",
      summary: `A terminal ${record.kind} approval shares this run correlation, but its retained binding does not match this exact execution.`,
    },
    decision: {
      outcome: "unknown",
      reasonCode: `operator_approval_execution_link_${linkState}`,
    },
    enforcement: {
      coverageState: "unknown",
      policyRefs: operatorApprovalPolicyRefs(record),
      grantRefs: [],
      contextFieldsUsed: ["contextId", "executionId", "runId"],
    },
    source: {
      owner: "operator_approvals",
      recordRef: sourceRef,
      decisionBoundary: "gateway.operator-approval.first-answer",
    },
    missingEvidence: ["decision.execution_link"],
    remediation: [
      {
        code: "inspect_exact_approval_binding",
        text: "Treat this approval only as run-correlated; inspect its retained execution binding before trusting attribution.",
      },
    ],
  };
}

function projectCorruptOperatorApprovalReceipt(
  row: Pick<
    OperatorApprovalRow,
    "approval_id" | "kind" | "resolution_ref" | "resolved_at_ms" | "updated_at_ms"
  >,
  context: OperatorApprovalReceiptContext,
): DecisionReceiptV1 {
  const kind = OPERATOR_APPROVAL_KINDS.has(row.kind as OperatorApprovalKind)
    ? (row.kind as OperatorApprovalKind)
    : "exec";
  const sourceRef = isApprovalResolutionRef(row.resolution_ref)
    ? row.resolution_ref
    : buildApprovalResolutionRef({ approvalId: row.approval_id, approvalKind: kind });
  const occurredAt = isValidTimestamp(row.resolved_at_ms ?? -1)
    ? row.resolved_at_ms!
    : isValidTimestamp(row.updated_at_ms)
      ? row.updated_at_ms
      : 0;
  return {
    schemaVersion: 1,
    receiptId: `approval:${sourceRef}`,
    contextId: context.contextId,
    executionId: context.executionId,
    runId: context.runId,
    actionId: sourceRef,
    occurredAt,
    action: { family: kind, operation: "approval" },
    decision: { outcome: "unknown", reasonCode: "operator_approval_record_corrupt" },
    enforcement: {
      coverageState: "unknown",
      policyRefs: [],
      grantRefs: [],
      contextFieldsUsed: ["runId"],
    },
    source: {
      owner: "operator_approvals",
      recordRef: sourceRef,
      decisionBoundary: "gateway.operator-approval.first-answer",
    },
    missingEvidence: ["operator_approval.valid"],
    remediation: [
      {
        code: "inspect_state_integrity",
        text: "Run openclaw doctor and inspect the shared state database before trusting this approval.",
      },
    ],
  };
}

function projectOversizedOperatorApprovalReceipt(
  row: OperatorApprovalReceiptSnapshotRow,
  context: OperatorApprovalReceiptContext,
): DecisionReceiptV1 {
  const receipt = projectCorruptOperatorApprovalReceipt(row, context);
  return {
    ...receipt,
    decision: { outcome: "unknown", reasonCode: "operator_approval_payload_bounded" },
    missingEvidence: ["operator_approval.payload_bounded"],
    remediation: [
      {
        code: "inspect_approval_record",
        text: "Inspect the retained approval directly; its presentation exceeds the bounded audit projection.",
      },
    ],
  };
}

function terminalApprovalsForRunQuery(
  database: ReturnType<typeof getNodeSqliteKysely<OperatorApprovalDatabase>>,
  runId: string,
  nowMs: number,
) {
  return database
    .selectFrom("operator_approvals")
    .where("source_run_id", "=", runId)
    .where("status", "!=", "pending")
    .where("resolved_at_ms", "is not", null)
    .where("resolved_at_ms", ">=", nowMs - OPERATOR_APPROVAL_TERMINAL_RETENTION_MS);
}

function operatorApprovalRowId() {
  return /* kysely-allow-raw: SQLite rowid keeps the external cursor compact while the indexed approval id remains the query key. */ sql<number>`operator_approvals.rowid`;
}

function operatorApprovalSelectorId(
  row: Pick<OperatorApprovalReceiptSnapshotRow, "receipt_rowid">,
): string {
  const rowId = normalizeSqliteNumber(row.receipt_rowid);
  if (rowId === undefined || rowId < 1) {
    throw new Error("invalid operator approval receipt rowid");
  }
  return `approval-decision:${rowId}`;
}

function operatorApprovalPayloadBytes() {
  return /* kysely-allow-raw: SQLite byte length excludes oversized retained presentation JSON before materialization. */ sql<number>`
    length(CAST(operator_approvals.presentation_json AS BLOB)) +
    length(CAST(operator_approvals.reviewer_device_ids_json AS BLOB)) +
    length(CAST(operator_approvals.audience_session_keys_json AS BLOB))
  `;
}

const OPERATOR_APPROVAL_PAYLOAD_COLUMNS = {
  presentation_json: sql`operator_approvals.presentation_json`,
  reviewer_device_ids_json: sql`operator_approvals.reviewer_device_ids_json`,
  audience_session_keys_json: sql`operator_approvals.audience_session_keys_json`,
} as const;

function boundedOperatorApprovalPayload(column: keyof typeof OPERATOR_APPROVAL_PAYLOAD_COLUMNS) {
  return /* kysely-allow-raw: the page statement must not materialize owner payload JSON above its audit bound. */ sql<
    string | null
  >`CASE WHEN ${operatorApprovalPayloadBytes()} <= ${OPERATOR_APPROVAL_RECEIPT_MAX_PAYLOAD_BYTES} THEN ${OPERATOR_APPROVAL_PAYLOAD_COLUMNS[column]} ELSE NULL END`;
}

function operatorApprovalReceiptSnapshotColumns(hasExecutionIdentityTable: boolean) {
  const bindingContextId = hasExecutionIdentityTable
    ? sql`operator_approval_execution_identities.source_context_id`
    : sql`NULL`;
  const bindingExecutionId = hasExecutionIdentityTable
    ? sql`operator_approval_execution_identities.source_execution_id`
    : sql`NULL`;
  return sql`
    operator_approvals.approval_id,
    operator_approvals.consumed_at_ms,
    operator_approvals.consumed_by,
    operator_approvals.created_at_ms,
    operator_approvals.decision,
    operator_approvals.expires_at_ms,
    operator_approvals.kind,
    ${boundedOperatorApprovalPayload("presentation_json")} AS presentation_json,
    operator_approvals.requested_by_client_id,
    operator_approvals.requested_by_device_id,
    operator_approvals.requested_by_device_token_auth,
    operator_approvals.resolution_ref,
    operator_approvals.resolved_at_ms,
    operator_approvals.resolver_id,
    operator_approvals.resolver_kind,
    ${boundedOperatorApprovalPayload("reviewer_device_ids_json")} AS reviewer_device_ids_json,
    operator_approvals.runtime_epoch,
    operator_approvals.source_agent_id,
    operator_approvals.source_run_id,
    operator_approvals.source_session_id,
    operator_approvals.source_session_key,
    operator_approvals.source_tool_call_id,
    operator_approvals.source_tool_name,
    operator_approvals.status,
    operator_approvals.terminal_reason,
    operator_approvals.updated_at_ms,
    ${boundedOperatorApprovalPayload("audience_session_keys_json")} AS audience_session_keys_json,
    ${bindingContextId} AS binding_context_id,
    ${bindingExecutionId} AS binding_execution_id,
    ${operatorApprovalRowId()} AS receipt_rowid,
    ${operatorApprovalPayloadBytes()} AS payload_bytes
  `;
}

function terminalApprovalReceiptPageRows(params: {
  db: DatabaseSync;
  runId: string;
  nowMs: number;
  after?: OperatorApprovalReceiptCursor;
  offset?: number;
  limit: number;
}): OperatorApprovalReceiptSnapshotRow[] {
  const hasExecutionIdentityTable = tableExists(
    params.db,
    "operator_approval_execution_identities",
  );
  const executionIdentityJoin = hasExecutionIdentityTable
    ? sql`LEFT JOIN operator_approval_execution_identities
          ON operator_approval_execution_identities.approval_id = operator_approvals.approval_id`
    : sql``;
  const cutoffMs = params.nowMs - OPERATOR_APPROVAL_TERMINAL_RETENTION_MS;
  const offset = params.offset ?? 0;
  const pageStatement = params.after
    ? /* kysely-allow-raw: one CTE statement preserves cursor validation and pairs each owner rowid with its bounded receipt payload in the same SQLite snapshot. */ sql<OperatorApprovalReceiptSnapshotQueryRow>`
        WITH cursor_boundary AS (
          SELECT approval_id, resolved_at_ms, ${operatorApprovalRowId()} AS receipt_rowid
          FROM operator_approvals
          WHERE ${operatorApprovalRowId()} = ${params.after.rowId}
            AND source_run_id = ${params.runId}
            AND resolved_at_ms = ${params.after.occurredAt}
        ), approval_page AS (
          SELECT ${operatorApprovalReceiptSnapshotColumns(hasExecutionIdentityTable)}
          FROM operator_approvals
          ${executionIdentityJoin}
          CROSS JOIN cursor_boundary
          WHERE operator_approvals.source_run_id = ${params.runId}
            AND operator_approvals.status != 'pending'
            AND operator_approvals.resolved_at_ms IS NOT NULL
            AND operator_approvals.resolved_at_ms >= ${cutoffMs}
            AND (
              operator_approvals.resolved_at_ms > cursor_boundary.resolved_at_ms
              OR (
                operator_approvals.resolved_at_ms = cursor_boundary.resolved_at_ms
                AND operator_approvals.approval_id > cursor_boundary.approval_id
              )
            )
          ORDER BY operator_approvals.resolved_at_ms ASC, operator_approvals.approval_id ASC
          LIMIT ${params.limit} OFFSET ${offset}
        )
        SELECT
          cursor_boundary.receipt_rowid AS cursor_boundary_rowid,
          CASE WHEN approval_page.receipt_rowid IS NULL THEN 0 ELSE 1 END AS page_present,
          approval_page.*
        FROM (SELECT 1) AS snapshot_seed
        LEFT JOIN cursor_boundary ON TRUE
        LEFT JOIN approval_page ON TRUE
        ORDER BY approval_page.resolved_at_ms ASC, approval_page.approval_id ASC
      `
    : /* kysely-allow-raw: the initial page returns owner rowids and bounded receipt payloads in one SQLite snapshot. */ sql<OperatorApprovalReceiptSnapshotQueryRow>`
        SELECT
          NULL AS cursor_boundary_rowid,
          1 AS page_present,
          ${operatorApprovalReceiptSnapshotColumns(hasExecutionIdentityTable)}
        FROM operator_approvals
        ${executionIdentityJoin}
        WHERE operator_approvals.source_run_id = ${params.runId}
          AND operator_approvals.status != 'pending'
          AND operator_approvals.resolved_at_ms IS NOT NULL
          AND operator_approvals.resolved_at_ms >= ${cutoffMs}
        ORDER BY operator_approvals.resolved_at_ms ASC, operator_approvals.approval_id ASC
        LIMIT ${params.limit} OFFSET ${offset}
      `;
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(params.db);
  const rows = executeSqliteQuerySync(
    params.db,
    stateDb
      .selectFrom(
        /* kysely-allow-raw: this derived table preserves the single owner-snapshot statement while exposing its closed row shape to Kysely. */
        sql<OperatorApprovalReceiptSnapshotQueryRow>`(${pageStatement})`.as("approval_snapshot"),
      )
      .selectAll(),
  ).rows;
  if (params.after && rows[0]?.cursor_boundary_rowid === null) {
    throw new Error("operator approval decision cursor is no longer retained");
  }
  if (rows.length === 1 && rows[0]?.page_present === 0) {
    return [];
  }
  return rows.map((row) => {
    if (row.page_present !== 1) {
      throw new Error("operator approval page snapshot is malformed");
    }
    return row;
  });
}

function materializeBoundedOperatorApprovalRow(
  row: OperatorApprovalReceiptSnapshotRow,
): OperatorApprovalReceiptRow | null {
  return typeof row.presentation_json === "string" &&
    typeof row.reviewer_device_ids_json === "string" &&
    typeof row.audience_session_keys_json === "string"
    ? {
        ...row,
        presentation_json: row.presentation_json,
        reviewer_device_ids_json: row.reviewer_device_ids_json,
        audience_session_keys_json: row.audience_session_keys_json,
      }
    : null;
}

function operatorApprovalExecutionLinkState(
  row: Pick<
    OperatorApprovalReceiptRow,
    "binding_context_id" | "binding_execution_id" | "source_run_id"
  >,
  context: OperatorApprovalReceiptContext,
): OperatorApprovalExecutionLinkState {
  if (row.binding_context_id === null && row.binding_execution_id === null) {
    return "missing";
  }
  if (
    typeof row.binding_context_id !== "string" ||
    typeof row.binding_execution_id !== "string" ||
    row.binding_context_id.length === 0 ||
    row.binding_execution_id.length === 0 ||
    row.binding_context_id.length > 256 ||
    row.binding_execution_id.length > 256 ||
    row.binding_context_id.trim() !== row.binding_context_id ||
    row.binding_execution_id.trim() !== row.binding_execution_id
  ) {
    return "malformed";
  }
  return row.binding_context_id === context.contextId &&
    row.binding_execution_id === context.executionId &&
    row.source_run_id === context.runId
    ? "exact"
    : "mismatch";
}

/** Probe for an authoritative retained approval without scanning the full run history. */
export function hasOperatorApprovalReceiptsForRun(params: {
  runId: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): boolean {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "operator_approvals")) {
        return false;
      }
      const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(db);
      return Boolean(
        executeSqliteQueryTakeFirstSync(
          db,
          terminalApprovalsForRunQuery(stateDb, params.runId, params.nowMs ?? Date.now())
            .clearSelect()
            .select("approval_id")
            .limit(1),
        ),
      );
    }, params.databaseOptions) ?? false
  );
}

/** Summarize at most 128 owner rows; the 129th makes coverage explicitly unknown. */
export function summarizeOperatorApprovalReceiptsForRun(params: {
  context: OperatorApprovalReceiptContext;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
  exactCount?: boolean;
}): {
  count: number;
  coverageState?: "enforced" | "unknown";
  missingEvidence: string[];
} {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "operator_approvals")) {
        return { count: 0, missingEvidence: [] };
      }
      const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(db);
      const snapshotRows = terminalApprovalReceiptPageRows({
        db,
        runId: params.context.runId,
        nowMs: params.nowMs ?? Date.now(),
        limit: OPERATOR_APPROVAL_RECEIPT_SUMMARY_MAX_ROWS + 1,
      });
      const boundedCount = snapshotRows.length;
      const count = params.exactCount
        ? (executeSqliteQueryTakeFirstSync(
            db,
            terminalApprovalsForRunQuery(stateDb, params.context.runId, params.nowMs ?? Date.now())
              .clearSelect()
              .select((eb) => eb.fn.countAll<number>().as("count")),
          )?.count ?? 0)
        : boundedCount;
      if (boundedCount === 0) {
        return { count: 0, missingEvidence: [] };
      }
      // Whole-set coverage stays conservative without decoding an unbounded
      // collection on the Gateway event loop.
      if (boundedCount > OPERATOR_APPROVAL_RECEIPT_SUMMARY_MAX_ROWS) {
        return {
          count,
          coverageState: "unknown" as const,
          missingEvidence: ["operator_approval.summary_bounded"],
        };
      }
      const hasOversizedRecord = snapshotRows.some(
        (row) => row.payload_bytes > OPERATOR_APPROVAL_RECEIPT_MAX_PAYLOAD_BYTES,
      );
      const boundedSnapshotRows = snapshotRows.filter(
        (row) => row.payload_bytes <= OPERATOR_APPROVAL_RECEIPT_MAX_PAYLOAD_BYTES,
      );
      const rows = boundedSnapshotRows.map(materializeBoundedOperatorApprovalRow);
      const hasMissingBoundedRow = rows.some((row) => row === null);
      const records = rows.map((row) => (row === null ? null : decodeOperatorApprovalRow(row)));
      const hasCorruptRecord = records.some((record) => record === null);
      const hasUnlinkedRecord = rows.some(
        (row, index) =>
          row !== null &&
          records[index] !== null &&
          operatorApprovalExecutionLinkState(row, params.context) !== "exact",
      );
      return {
        count,
        coverageState:
          hasOversizedRecord || hasMissingBoundedRow || hasCorruptRecord || hasUnlinkedRecord
            ? "unknown"
            : "enforced",
        missingEvidence: [
          ...(hasUnlinkedRecord ? ["decision.execution_link"] : []),
          ...(hasCorruptRecord ? ["operator_approval.valid"] : []),
          ...(hasOversizedRecord || hasMissingBoundedRow
            ? ["operator_approval.payload_bounded"]
            : []),
        ],
      };
    }, params.databaseOptions) ?? { count: 0, missingEvidence: [] }
  );
}

/** Project authoritative approval rows directly; no generic decision fact is written. */
export function pageOperatorApprovalReceiptsForRun(params: {
  context: OperatorApprovalReceiptContext;
  after?: OperatorApprovalReceiptCursor;
  offset?: number;
  limit: number;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): OperatorApprovalReceiptPage {
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "operator_approvals")) {
        return { entries: [] };
      }
      const snapshotRows = terminalApprovalReceiptPageRows({
        db,
        runId: params.context.runId,
        nowMs: params.nowMs ?? Date.now(),
        after: params.after,
        offset: params.offset,
        limit: params.limit + 1,
      });
      const pageRows = snapshotRows.slice(0, params.limit);
      const entries = pageRows.map((snapshot) => {
        let receipt: DecisionReceiptV1;
        if (snapshot.payload_bytes > OPERATOR_APPROVAL_RECEIPT_MAX_PAYLOAD_BYTES) {
          receipt = projectOversizedOperatorApprovalReceipt(snapshot, params.context);
        } else {
          const row = materializeBoundedOperatorApprovalRow(snapshot);
          const record = row === null ? null : decodeOperatorApprovalRow(row);
          if (row === null || record === null) {
            receipt = projectCorruptOperatorApprovalReceipt(snapshot, params.context);
          } else {
            const linkState = operatorApprovalExecutionLinkState(row, params.context);
            receipt =
              linkState === "exact"
                ? projectOperatorApprovalReceipt(record, params.context)
                : projectUnlinkedOperatorApprovalReceipt(record, params.context, linkState);
          }
        }
        return { receipt, selectorId: operatorApprovalSelectorId(snapshot) };
      });
      const last = pageRows.at(-1);
      return {
        entries,
        ...(snapshotRows.length > params.limit && last && last.resolved_at_ms !== null
          ? {
              nextCursor: {
                occurredAt: last.resolved_at_ms,
                rowId: last.receipt_rowid,
              },
            }
          : {}),
      };
    }, params.databaseOptions) ?? { entries: [] }
  );
}

function selectOperatorApprovalRow(
  database: ReturnType<typeof openOpenClawStateDatabase>,
  id: string,
): OperatorApprovalRow | undefined {
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb.selectFrom("operator_approvals").selectAll().where("approval_id", "=", id),
  );
}

function selectOperatorApprovalRowByLocator(
  database: ReturnType<typeof openOpenClawStateDatabase>,
  locator: string,
): OperatorApprovalRow | undefined {
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("operator_approvals")
      .selectAll()
      .where((eb) => eb.or([eb("approval_id", "=", locator), eb("resolution_ref", "=", locator)]))
      .limit(2),
  ).rows;
  return rows.length === 1 ? rows[0] : undefined;
}

function hasApprovalLocatorNamespaceConflict(params: {
  database: ReturnType<typeof openOpenClawStateDatabase>;
  id: string;
  resolutionRef: string;
}): boolean {
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(params.database.db);
  const row = executeSqliteQueryTakeFirstSync(
    params.database.db,
    stateDb
      .selectFrom("operator_approvals")
      .select("approval_id")
      .where((eb) =>
        eb.or([eb("approval_id", "=", params.resolutionRef), eb("resolution_ref", "=", params.id)]),
      )
      .where("approval_id", "!=", params.id),
  );
  return row !== undefined;
}

function matchesExpectedApprovalOwner(params: {
  row: OperatorApprovalRow;
  expectedKind?: OperatorApprovalKind;
  runtimeEpoch?: string;
}): boolean {
  return (
    (params.expectedKind === undefined || params.row.kind === params.expectedKind) &&
    (params.runtimeEpoch === undefined || params.row.runtime_epoch === params.runtimeEpoch)
  );
}

function denyCorruptPendingRow(params: {
  database: ReturnType<typeof openOpenClawStateDatabase>;
  id: string;
  nowMs: number;
  createdAtMs: number;
}): void {
  const auditTimestampMs = clampAuditTimestamp(params.nowMs, params.createdAtMs);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(params.database.db);
  executeSqliteQuerySync(
    params.database.db,
    stateDb
      .updateTable("operator_approvals")
      .set({
        status: "denied",
        decision: "deny",
        terminal_reason: "storage-corrupt",
        resolved_at_ms: auditTimestampMs,
        resolver_kind: "system",
        resolver_id: null,
        updated_at_ms: auditTimestampMs,
      })
      .where("approval_id", "=", params.id)
      .where("status", "=", "pending"),
  );
}

function expirePendingRow(params: {
  database: ReturnType<typeof openOpenClawStateDatabase>;
  id: string;
  nowMs: number;
  createdAtMs: number;
}): OperatorApprovalRow | undefined {
  const auditTimestampMs = clampAuditTimestamp(params.nowMs, params.createdAtMs);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(params.database.db);
  executeSqliteQuerySync(
    params.database.db,
    stateDb
      .updateTable("operator_approvals")
      .set({
        status: "expired",
        decision: "deny",
        terminal_reason: "timeout",
        resolved_at_ms: auditTimestampMs,
        resolver_kind: "system",
        resolver_id: null,
        updated_at_ms: auditTimestampMs,
      })
      .where("approval_id", "=", params.id)
      .where("status", "=", "pending")
      .where("expires_at_ms", "<=", params.nowMs),
  );
  return selectOperatorApprovalRow(params.database, params.id);
}

function requireDecodedRecord(row: OperatorApprovalRow): OperatorApprovalRecord {
  const record = decodeOperatorApprovalRow(row);
  if (!record) {
    throw new Error(`operator approval '${row.approval_id}' became corrupt during a transaction`);
  }
  return record;
}

function inputMatchesExistingRow(
  input: NewOperatorApproval,
  row: OperatorApprovalRow,
  serialized: {
    presentationJson: string;
    reviewerDeviceIdsJson: string;
    audienceSessionKeysJson: string;
  },
): boolean {
  const source = input.source ?? {};
  return (
    row.status === "pending" &&
    row.kind === input.kind &&
    row.presentation_json === serialized.presentationJson &&
    row.requested_by_device_id === normalizeNullableString(input.requester?.deviceId) &&
    row.requested_by_client_id === normalizeNullableString(input.requester?.clientId) &&
    row.requested_by_device_token_auth === (input.requester?.deviceTokenAuth === true ? 1 : 0) &&
    row.reviewer_device_ids_json === serialized.reviewerDeviceIdsJson &&
    row.source_agent_id === normalizeNullableString(source.agentId) &&
    row.source_session_key === normalizeNullableString(source.sessionKey) &&
    row.source_session_id === normalizeNullableString(source.sessionId) &&
    row.source_run_id === normalizeNullableString(source.runId) &&
    row.source_tool_call_id === normalizeNullableString(source.toolCallId) &&
    row.source_tool_name === normalizeNullableString(source.toolName) &&
    row.audience_session_keys_json === serialized.audienceSessionKeysJson &&
    row.runtime_epoch === input.runtimeEpoch.trim() &&
    row.created_at_ms === input.createdAtMs &&
    row.expires_at_ms === input.expiresAtMs
  );
}

export function insertOperatorApproval(params: {
  approval: NewOperatorApproval;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): InsertOperatorApprovalResult {
  const input = params.approval;
  const id = requireApprovalId(input.id);
  const resolutionRef = buildApprovalResolutionRef({
    approvalId: id,
    approvalKind: input.kind,
  });
  const runtimeEpoch = requireString(input.runtimeEpoch, "operator approval runtime epoch");
  if (!isValidTimestamp(input.createdAtMs) || !isValidTimestamp(input.expiresAtMs)) {
    throw new Error("operator approval timestamps must be non-negative safe integers");
  }
  if (input.expiresAtMs < input.createdAtMs) {
    throw new Error("operator approval expiry cannot precede creation");
  }
  const presentationJson = stringifyPresentation(input.presentation);
  if (input.presentation.kind !== input.kind) {
    throw new Error("operator approval kind must match its safe presentation");
  }
  const reviewerDeviceIdsJson = JSON.stringify(
    normalizeUniqueTrimmedStringList(input.reviewerDeviceIds),
  );
  const audienceSessionKeys = normalizeUniqueTrimmedStringList(input.audienceSessionKeys);
  if (audienceSessionKeys.length > OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS) {
    throw new Error(
      `operator approval audience exceeds ${OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS} sessions`,
    );
  }
  const audienceSessionKeysJson = JSON.stringify(audienceSessionKeys);
  const serialized = {
    presentationJson,
    reviewerDeviceIdsJson,
    audienceSessionKeysJson,
  };
  const executionIdentityBinding = normalizeExecutionIdentityBinding(input);

  return runOpenClawStateWriteTransaction((database) => {
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .deleteFrom("operator_approvals")
        .where("status", "!=", "pending")
        .where("resolved_at_ms", "is not", null)
        .where("resolved_at_ms", "<=", input.createdAtMs - OPERATOR_APPROVAL_TERMINAL_RETENTION_MS),
    );
    if (hasApprovalLocatorNamespaceConflict({ database, id, resolutionRef })) {
      return { outcome: "conflict" };
    }
    const source = input.source ?? {};
    const result = executeSqliteQuerySync(
      database.db,
      stateDb
        .insertInto("operator_approvals")
        .values({
          approval_id: id,
          resolution_ref: resolutionRef,
          kind: input.kind,
          status: "pending",
          presentation_json: presentationJson,
          requested_by_device_id: normalizeNullableString(input.requester?.deviceId),
          requested_by_client_id: normalizeNullableString(input.requester?.clientId),
          requested_by_device_token_auth: input.requester?.deviceTokenAuth === true ? 1 : 0,
          reviewer_device_ids_json: reviewerDeviceIdsJson,
          source_agent_id: normalizeNullableString(source.agentId),
          source_session_key: normalizeNullableString(source.sessionKey),
          source_session_id: normalizeNullableString(source.sessionId),
          source_run_id: normalizeNullableString(source.runId),
          source_tool_call_id: normalizeNullableString(source.toolCallId),
          source_tool_name: normalizeNullableString(source.toolName),
          audience_session_keys_json: audienceSessionKeysJson,
          runtime_epoch: runtimeEpoch,
          created_at_ms: input.createdAtMs,
          expires_at_ms: input.expiresAtMs,
          updated_at_ms: input.createdAtMs,
          decision: null,
          terminal_reason: null,
          resolved_at_ms: null,
          resolver_kind: null,
          resolver_id: null,
          consumed_at_ms: null,
          consumed_by: null,
        })
        .onConflict((conflict) => conflict.column("approval_id").doNothing()),
    );
    const row = selectOperatorApprovalRow(database, id);
    if (!row) {
      throw new Error(`operator approval '${id}' was not readable after insert`);
    }
    const record = decodeOperatorApprovalRow(row);
    if (!record) {
      denyCorruptPendingRow({
        database,
        id,
        nowMs: input.createdAtMs,
        createdAtMs: row.created_at_ms,
      });
      return { outcome: "conflict" };
    }
    if (result.numAffectedRows === 1n) {
      if (executionIdentityBinding) {
        // sqlite-allow-raw -- feature-local additive schema DDL; binding rows use Kysely.
        database.db.exec(OPERATOR_APPROVAL_EXECUTION_IDENTITY_SCHEMA_SQL);
        executeSqliteQuerySync(
          database.db,
          stateDb.insertInto("operator_approval_execution_identities").values({
            approval_id: id,
            source_context_id: executionIdentityBinding.sourceContextId,
            source_execution_id: executionIdentityBinding.sourceExecutionId,
          }),
        );
      }
      return { outcome: "inserted", record };
    }
    if (!inputMatchesExistingRow(input, row, serialized)) {
      return { outcome: "conflict" };
    }
    if (executionIdentityBinding) {
      if (!tableExists(database.db, "operator_approval_execution_identities")) {
        return { outcome: "conflict" };
      }
      const existingBinding = executeSqliteQueryTakeFirstSync(
        database.db,
        stateDb
          .selectFrom("operator_approval_execution_identities")
          .select(["source_context_id", "source_execution_id"])
          .where("approval_id", "=", id),
      );
      if (
        existingBinding?.source_context_id !== executionIdentityBinding.sourceContextId ||
        existingBinding.source_execution_id !== executionIdentityBinding.sourceExecutionId
      ) {
        return { outcome: "conflict" };
      }
    }
    return { outcome: "existing", record };
  }, params.databaseOptions);
}

export function getOperatorApprovalDetailed(params: {
  id: string;
  allowTransportRef?: boolean;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): GetOperatorApprovalResult {
  const locator = requireApprovalId(params.id);
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    let row = params.allowTransportRef
      ? selectOperatorApprovalRowByLocator(database, locator)
      : selectOperatorApprovalRow(database, locator);
    if (!row) {
      return { outcome: "not-found" };
    }
    const id = row.approval_id;
    if (row.status === "pending" && row.expires_at_ms <= nowMs) {
      row = expirePendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
      if (!row) {
        return { outcome: "not-found" };
      }
    }
    const record = decodeOperatorApprovalRow(row);
    if (record) {
      return { outcome: "found", record };
    }
    denyCorruptPendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
    return params.allowTransportRef ? { outcome: "corrupt", id } : { outcome: "corrupt" };
  }, params.databaseOptions);
}

export function listPendingOperatorApprovals(
  params: {
    kind?: OperatorApprovalKind;
    sourceSessionKey?: string;
    audienceSessionKey?: string;
    recordFilter?: (record: OperatorApprovalRecord) => boolean;
    limit?: number;
    nowMs?: number;
    databaseOptions?: OpenClawStateDatabaseOptions;
  } = {},
): OperatorApprovalRecord[] {
  expireDueOperatorApprovals({ nowMs: params.nowMs, databaseOptions: params.databaseOptions });
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    const resultLimit = Math.max(
      1,
      Math.min(params.limit ?? 1_000, OPERATOR_APPROVAL_MAX_LIST_LIMIT),
    );
    const audienceSessionKey =
      params.audienceSessionKey === undefined
        ? undefined
        : requireString(params.audienceSessionKey, "operator approval audience session key");
    const requiresPostFilter =
      audienceSessionKey !== undefined || params.recordFilter !== undefined;
    const records: OperatorApprovalRecord[] = [];
    let cursor: { createdAtMs: number; id: string } | undefined;
    // Audience and reviewer bindings live in validated bounded JSON. Keyset-scan
    // first, then apply the limit so unrelated records cannot starve replay.
    while (records.length < resultLimit) {
      let query = stateDb
        .selectFrom("operator_approvals")
        .selectAll()
        .where("status", "=", "pending")
        .where("expires_at_ms", ">", nowMs)
        .orderBy("created_at_ms", "asc")
        .orderBy("approval_id", "asc")
        .limit(requiresPostFilter ? OPERATOR_APPROVAL_PENDING_SCAN_PAGE_SIZE : resultLimit);
      if (params.kind) {
        query = query.where("kind", "=", params.kind);
      }
      if (params.sourceSessionKey) {
        query = query.where("source_session_key", "=", params.sourceSessionKey);
      }
      if (cursor) {
        const pageCursor = cursor;
        query = query.where((eb) =>
          eb.or([
            eb("created_at_ms", ">", pageCursor.createdAtMs),
            eb.and([
              eb("created_at_ms", "=", pageCursor.createdAtMs),
              eb("approval_id", ">", pageCursor.id),
            ]),
          ]),
        );
      }
      const rows = executeSqliteQuerySync(database.db, query).rows;
      for (const row of rows) {
        const record = decodeOperatorApprovalRow(row);
        if (!record) {
          denyCorruptPendingRow({
            database,
            id: row.approval_id,
            nowMs,
            createdAtMs: row.created_at_ms,
          });
          continue;
        }
        const matchesAudience =
          !audienceSessionKey || record.audienceSessionKeys.includes(audienceSessionKey);
        if (matchesAudience && (!params.recordFilter || params.recordFilter(record))) {
          records.push(record);
          if (records.length === resultLimit) {
            break;
          }
        }
      }
      const last = rows.at(-1);
      if (!requiresPostFilter || rows.length < OPERATOR_APPROVAL_PENDING_SCAN_PAGE_SIZE || !last) {
        break;
      }
      cursor = { createdAtMs: last.created_at_ms, id: last.approval_id };
    }
    return records;
  }, params.databaseOptions);
}

export function listTerminalOperatorApprovals(
  params: {
    cursor?: string;
    limit?: number;
    kind?: OperatorApprovalKind;
    nowMs?: number;
    databaseOptions?: OpenClawStateDatabaseOptions;
  } = {},
): ListTerminalOperatorApprovalsResult {
  const requestedLimit = Number.isSafeInteger(params.limit)
    ? (params.limit ?? OPERATOR_APPROVAL_HISTORY_DEFAULT_LIMIT)
    : OPERATOR_APPROVAL_HISTORY_DEFAULT_LIMIT;
  const resultLimit = Math.max(1, Math.min(requestedLimit, OPERATOR_APPROVAL_HISTORY_MAX_LIMIT));
  // Enforce the same 30-day retention the UI promises, independent of whether a
  // prune has run recently, so history can never surface rows past the window.
  const retentionCutoffMs = (params.nowMs ?? Date.now()) - OPERATOR_APPROVAL_TERMINAL_RETENTION_MS;
  let cursor =
    params.cursor === undefined ? undefined : decodeOperatorApprovalHistoryCursor(params.cursor);
  const database = openOpenClawStateDatabase(params.databaseOptions);
  const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
  const records: OperatorApprovalRecord[] = [];
  const pageSize = resultLimit + 1;

  // Corrupt rows are skipped through the same decode-and-validate path used by
  // point lookups. Continue the keyset scan so one bad row cannot hide later
  // valid history.
  while (records.length < pageSize) {
    const batchLimit = pageSize - records.length;
    let query = stateDb
      .selectFrom("operator_approvals")
      .selectAll()
      .where("status", "!=", "pending")
      .where("resolved_at_ms", "is not", null)
      .where("resolved_at_ms", ">=", retentionCutoffMs)
      .orderBy("resolved_at_ms", "desc")
      .orderBy("approval_id", "desc")
      .limit(batchLimit);
    if (params.kind) {
      query = query.where("kind", "=", params.kind);
    }
    if (cursor) {
      const pageCursor = cursor;
      query = query.where((eb) =>
        eb.or([
          eb("resolved_at_ms", "<", pageCursor.resolvedAtMs),
          eb.and([
            eb("resolved_at_ms", "=", pageCursor.resolvedAtMs),
            eb("approval_id", "<", pageCursor.id),
          ]),
        ]),
      );
    }
    const rows = executeSqliteQuerySync(database.db, query).rows;
    for (const row of rows) {
      const record = decodeOperatorApprovalRow(row);
      if (record) {
        records.push(record);
      }
    }
    const last = rows.at(-1);
    if (rows.length < batchLimit || !last || last.resolved_at_ms === null) {
      break;
    }
    cursor = { resolvedAtMs: last.resolved_at_ms, id: last.approval_id };
  }

  const page = records.slice(0, resultLimit);
  const last = page.at(-1);
  return {
    records: page,
    ...(records.length > resultLimit && last && last.resolvedAtMs !== null
      ? {
          nextCursor: encodeOperatorApprovalHistoryCursor({
            resolvedAtMs: last.resolvedAtMs,
            id: last.id,
          }),
        }
      : {}),
  };
}

export function resolveOperatorApproval(params: {
  id: string;
  decision: OperatorApprovalDecision;
  resolver: OperatorApprovalResolver;
  expectedKind?: OperatorApprovalKind;
  runtimeEpoch?: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): ResolveOperatorApprovalResult {
  const id = requireApprovalId(params.id);
  const resolverId = normalizeNullableString(params.resolver.id);
  const runtimeEpoch =
    params.runtimeEpoch === undefined
      ? undefined
      : requireString(params.runtimeEpoch, "operator approval runtime epoch");
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    let row = selectOperatorApprovalRow(database, id);
    if (!row) {
      return { outcome: "not-found" };
    }
    if (!matchesExpectedApprovalOwner({ row, expectedKind: params.expectedKind, runtimeEpoch })) {
      return { outcome: "not-found" };
    }
    let record = decodeOperatorApprovalRow(row);
    if (!record) {
      denyCorruptPendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
      return { outcome: "corrupt" };
    }
    if (record.status !== "pending") {
      return {
        outcome: "already-resolved",
        retry: record.decision === params.decision ? "same" : "conflict",
        record,
      };
    }
    if (record.expiresAtMs <= nowMs) {
      row = expirePendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
      if (!row) {
        return { outcome: "not-found" };
      }
      record = requireDecodedRecord(row);
      return { outcome: "expired", record };
    }
    if (!Array.prototype.includes.call(record.presentation.allowedDecisions, params.decision)) {
      return { outcome: "decision-not-allowed", record };
    }

    const auditTimestampMs = clampAuditTimestamp(nowMs, record.createdAtMs);
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    let resolveQuery = stateDb
      .updateTable("operator_approvals")
      .set({
        status: params.decision === "deny" ? "denied" : "allowed",
        decision: params.decision,
        terminal_reason: "user",
        resolved_at_ms: auditTimestampMs,
        resolver_kind: params.resolver.kind,
        resolver_id: resolverId,
        updated_at_ms: auditTimestampMs,
      })
      .where("approval_id", "=", id)
      .where("status", "=", "pending")
      .where("expires_at_ms", ">", nowMs);
    if (params.expectedKind !== undefined) {
      resolveQuery = resolveQuery.where("kind", "=", params.expectedKind);
    }
    if (runtimeEpoch !== undefined) {
      resolveQuery = resolveQuery.where("runtime_epoch", "=", runtimeEpoch);
    }
    const result = executeSqliteQuerySync(database.db, resolveQuery);
    row = selectOperatorApprovalRow(database, id);
    if (!row) {
      return { outcome: "not-found" };
    }
    record = requireDecodedRecord(row);
    if (result.numAffectedRows === 1n) {
      return { outcome: "resolved", record };
    }
    if (record.status === "pending" && record.expiresAtMs <= nowMs) {
      const expiredRow = expirePendingRow({
        database,
        id,
        nowMs,
        createdAtMs: record.createdAtMs,
      });
      if (!expiredRow) {
        return { outcome: "not-found" };
      }
      return { outcome: "expired", record: requireDecodedRecord(expiredRow) };
    }
    return {
      outcome: "already-resolved",
      retry: record.decision === params.decision ? "same" : "conflict",
      record,
    };
  }, params.databaseOptions);
}

export function forceDenyOperatorApproval(params: {
  id: string;
  status?: "denied" | "expired" | "cancelled";
  requireDue?: boolean;
  reason: OperatorApprovalTerminalReason;
  resolver: OperatorApprovalResolver;
  expectedKind?: OperatorApprovalKind;
  runtimeEpoch?: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): ForceDenyOperatorApprovalResult {
  const id = requireApprovalId(params.id);
  const runtimeEpoch =
    params.runtimeEpoch === undefined
      ? undefined
      : requireString(params.runtimeEpoch, "operator approval runtime epoch");
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    const row = selectOperatorApprovalRow(database, id);
    if (!row) {
      return { outcome: "not-found" };
    }
    if (!matchesExpectedApprovalOwner({ row, expectedKind: params.expectedKind, runtimeEpoch })) {
      return { outcome: "not-found" };
    }
    if (row.status === "pending" && row.expires_at_ms <= nowMs) {
      const expiredRow = expirePendingRow({
        database,
        id,
        nowMs,
        createdAtMs: row.created_at_ms,
      });
      if (!expiredRow) {
        return { outcome: "not-found" };
      }
      const expiredRecord = decodeOperatorApprovalRow(expiredRow);
      return expiredRecord ? { outcome: "expired", record: expiredRecord } : { outcome: "corrupt" };
    }
    const record = decodeOperatorApprovalRow(row);
    if (!record) {
      denyCorruptPendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
      return { outcome: "corrupt" };
    }
    if (record.status !== "pending") {
      return { outcome: "already-terminal", record };
    }
    if (params.status === "expired" && params.requireDue === true && record.expiresAtMs > nowMs) {
      return { outcome: "not-due", record };
    }
    const auditTimestampMs = clampAuditTimestamp(nowMs, record.createdAtMs);
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    let denyQuery = stateDb
      .updateTable("operator_approvals")
      .set({
        status: params.status ?? "denied",
        decision: "deny",
        terminal_reason: params.reason,
        resolved_at_ms: auditTimestampMs,
        resolver_kind: params.resolver.kind,
        resolver_id: normalizeNullableString(params.resolver.id),
        updated_at_ms: auditTimestampMs,
      })
      .where("approval_id", "=", id)
      .where("status", "=", "pending");
    if (params.expectedKind !== undefined) {
      denyQuery = denyQuery.where("kind", "=", params.expectedKind);
    }
    if (runtimeEpoch !== undefined) {
      denyQuery = denyQuery.where("runtime_epoch", "=", runtimeEpoch);
    }
    executeSqliteQuerySync(database.db, denyQuery);
    const terminalRow = selectOperatorApprovalRow(database, id);
    if (!terminalRow) {
      return { outcome: "not-found" };
    }
    return { outcome: "denied", record: requireDecodedRecord(terminalRow) };
  }, params.databaseOptions);
}

export function expireDueOperatorApprovals(params: {
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): TerminalizeOperatorApprovalsResult {
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    const dueRows = executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("operator_approvals")
        .selectAll()
        .where("status", "=", "pending")
        .where("expires_at_ms", "<=", nowMs)
        .orderBy("expires_at_ms", "asc")
        .orderBy("approval_id", "asc"),
    ).rows;
    if (dueRows.length === 0) {
      return { affected: 0, records: [] };
    }
    const result = executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set({
          status: "expired",
          decision: "deny",
          terminal_reason: "timeout",
          resolved_at_ms: nowMs,
          resolver_kind: "system",
          resolver_id: null,
          updated_at_ms: nowMs,
        })
        .where("status", "=", "pending")
        .where("expires_at_ms", "<=", nowMs),
    );
    const terminalRows: OperatorApprovalRow[] = [];
    for (const row of dueRows) {
      terminalRows.push({
        ...row,
        status: "expired",
        decision: "deny",
        terminal_reason: "timeout",
        resolved_at_ms: nowMs,
        resolver_kind: "system",
        resolver_id: null,
        updated_at_ms: nowMs,
      });
    }
    return {
      affected: Number(result.numAffectedRows ?? 0n),
      records: terminalRows
        .map((row) => decodeOperatorApprovalRow(row))
        .filter((record): record is OperatorApprovalRecord => record !== null),
    };
  }, params.databaseOptions);
}

export function closeOrphanedOperatorApprovals(params: {
  runtimeEpoch: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): TerminalizeOperatorApprovalsResult {
  const runtimeEpoch = requireString(params.runtimeEpoch, "operator approval runtime epoch");
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    const orphanRows = executeSqliteQuerySync(
      database.db,
      stateDb
        .selectFrom("operator_approvals")
        .selectAll()
        .where("status", "=", "pending")
        .where("runtime_epoch", "!=", runtimeEpoch)
        .orderBy("created_at_ms", "asc")
        .orderBy("approval_id", "asc"),
    ).rows;
    if (orphanRows.length === 0) {
      return { affected: 0, records: [] };
    }
    let affected = 0;
    const terminalRows: OperatorApprovalRow[] = [];
    for (const row of orphanRows) {
      const auditTimestampMs = clampAuditTimestamp(nowMs, row.created_at_ms);
      const result = executeSqliteQuerySync(
        database.db,
        stateDb
          .updateTable("operator_approvals")
          .set({
            status: "cancelled",
            decision: "deny",
            terminal_reason: "gateway-restart",
            resolved_at_ms: auditTimestampMs,
            resolver_kind: "system",
            resolver_id: null,
            updated_at_ms: auditTimestampMs,
          })
          .where("approval_id", "=", row.approval_id)
          .where("status", "=", "pending"),
      );
      const rowAffected = Number(result.numAffectedRows ?? 0n);
      affected += rowAffected;
      if (rowAffected === 1) {
        terminalRows.push({
          ...row,
          status: "cancelled",
          decision: "deny",
          terminal_reason: "gateway-restart",
          resolved_at_ms: auditTimestampMs,
          resolver_kind: "system",
          resolver_id: null,
          updated_at_ms: auditTimestampMs,
        });
      }
    }
    return {
      affected,
      records: terminalRows
        .map((row) => decodeOperatorApprovalRow(row))
        .filter((record): record is OperatorApprovalRecord => record !== null),
    };
  }, params.databaseOptions);
}

export function consumeOperatorApprovalAllowOnce(params: {
  id: string;
  consumerId: string;
  expectedKind?: OperatorApprovalKind;
  runtimeEpoch?: string;
  redemptionWindowMs?: number;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): ConsumeOperatorApprovalResult {
  const id = requireApprovalId(params.id);
  const consumerId = requireString(params.consumerId, "operator approval consumer id");
  const runtimeEpoch =
    params.runtimeEpoch === undefined
      ? undefined
      : requireString(params.runtimeEpoch, "operator approval runtime epoch");
  if (params.redemptionWindowMs !== undefined && !isValidTimestamp(params.redemptionWindowMs)) {
    throw new Error("operator approval redemption window must be a non-negative safe integer");
  }
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    const redemptionThresholdMs =
      params.redemptionWindowMs === undefined ? undefined : nowMs - params.redemptionWindowMs;
    let row = selectOperatorApprovalRow(database, id);
    if (!row) {
      return { outcome: "not-found" };
    }
    if (!matchesExpectedApprovalOwner({ row, expectedKind: params.expectedKind, runtimeEpoch })) {
      return { outcome: "not-found" };
    }
    if (row.status === "pending" && row.expires_at_ms <= nowMs) {
      row = expirePendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
      if (!row) {
        return { outcome: "not-found" };
      }
    }
    let record = decodeOperatorApprovalRow(row);
    if (!record) {
      denyCorruptPendingRow({ database, id, nowMs, createdAtMs: row.created_at_ms });
      return { outcome: "corrupt" };
    }
    if (record.status !== "allowed" || record.decision !== "allow-once") {
      return { outcome: "not-allow-once", record };
    }
    if (record.consumedAtMs !== null) {
      return { outcome: "already-consumed", record };
    }
    if (record.resolvedAtMs === null) {
      return { outcome: "corrupt" };
    }
    if (redemptionThresholdMs !== undefined && record.resolvedAtMs <= redemptionThresholdMs) {
      return { outcome: "redemption-expired", record };
    }
    const auditTimestampMs = clampAuditTimestamp(
      nowMs,
      record.createdAtMs,
      record.resolvedAtMs,
      record.updatedAtMs,
    );
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    let consumeQuery = stateDb
      .updateTable("operator_approvals")
      .set({
        consumed_at_ms: auditTimestampMs,
        consumed_by: consumerId,
        updated_at_ms: auditTimestampMs,
      })
      .where("approval_id", "=", id)
      .where("status", "=", "allowed")
      .where("decision", "=", "allow-once")
      .where("consumed_at_ms", "is", null);
    if (redemptionThresholdMs !== undefined) {
      consumeQuery = consumeQuery.where("resolved_at_ms", ">", redemptionThresholdMs);
    }
    if (params.expectedKind !== undefined) {
      consumeQuery = consumeQuery.where("kind", "=", params.expectedKind);
    }
    if (runtimeEpoch !== undefined) {
      consumeQuery = consumeQuery.where("runtime_epoch", "=", runtimeEpoch);
    }
    const result = executeSqliteQuerySync(database.db, consumeQuery);
    row = selectOperatorApprovalRow(database, id);
    if (!row) {
      return { outcome: "not-found" };
    }
    record = requireDecodedRecord(row);
    if (result.numAffectedRows === 1n) {
      return { outcome: "consumed", record };
    }
    if (
      redemptionThresholdMs !== undefined &&
      record.resolvedAtMs !== null &&
      record.resolvedAtMs <= redemptionThresholdMs
    ) {
      return { outcome: "redemption-expired", record };
    }
    return { outcome: "already-consumed", record };
  }, params.databaseOptions);
}

export function pruneTerminalOperatorApprovals(params: {
  nowMs?: number;
  retentionMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): number {
  const retentionMs = params.retentionMs ?? OPERATOR_APPROVAL_TERMINAL_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
    throw new Error("operator approval retention must be a non-negative safe integer");
  }
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    const cutoffMs = nowMs - retentionMs;
    const stateDb = getNodeSqliteKysely<OperatorApprovalDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      stateDb
        .deleteFrom("operator_approvals")
        .where("status", "!=", "pending")
        .where("resolved_at_ms", "is not", null)
        .where("resolved_at_ms", "<=", cutoffMs),
    );
    return Number(result.numAffectedRows ?? 0n);
  }, params.databaseOptions);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
