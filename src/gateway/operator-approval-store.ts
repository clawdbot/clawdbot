// Persistent operator approval lifecycle and first-answer-wins transitions.
import type { Selectable } from "kysely";
import {
  type ApprovalPresentation,
  isWellFormedApprovalId,
  validateApprovalPresentation,
} from "../../packages/gateway-protocol/src/index.js";
import {
  buildApprovalResolutionRef,
  isApprovalResolutionRef,
} from "../infra/approval-resolution-ref.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
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
export const OPERATOR_APPROVAL_MAX_AUDIENCE_SESSION_KEYS = 64;
const OPERATOR_APPROVAL_PENDING_SCAN_PAGE_SIZE = 256;
const OPERATOR_APPROVAL_MAX_LIST_LIMIT = 1_001;

export type OperatorApprovalKind = "exec" | "plugin";
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

type OperatorApprovalDatabase = Pick<OpenClawStateKyselyDatabase, "operator_approvals">;
type OperatorApprovalRow = Selectable<OperatorApprovals>;

const OPERATOR_APPROVAL_DECISIONS = new Set<OperatorApprovalDecision>([
  "allow-once",
  "allow-always",
  "deny",
]);
const OPERATOR_APPROVAL_KINDS = new Set<OperatorApprovalKind>(["exec", "plugin"]);
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

function parseApprovalPresentation(raw: string): ApprovalPresentation | null {
  try {
    const value: unknown = JSON.parse(raw);
    return validateApprovalPresentation(value) ? value : null;
  } catch {
    return null;
  }
}

function parseStringArray(raw: string): string[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !Array.isArray(value) ||
      value.some((entry) => typeof entry !== "string" || !entry.trim())
    ) {
      return null;
    }
    return value as string[];
  } catch {
    return null;
  }
}

function normalizeString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function requireString(value: string, label: string): string {
  const normalized = normalizeString(value);
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

function normalizeStringArray(values: readonly string[] | undefined): string[] {
  const result: string[] = [];
  for (const value of values ?? []) {
    const normalized = normalizeString(value);
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
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
    (status === "allowed" && (!decision || !presentation.allowedDecisions.includes(decision)))
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
    row.requested_by_device_id === normalizeString(input.requester?.deviceId) &&
    row.requested_by_client_id === normalizeString(input.requester?.clientId) &&
    row.requested_by_device_token_auth === (input.requester?.deviceTokenAuth === true ? 1 : 0) &&
    row.reviewer_device_ids_json === serialized.reviewerDeviceIdsJson &&
    row.source_agent_id === normalizeString(source.agentId) &&
    row.source_session_key === normalizeString(source.sessionKey) &&
    row.source_session_id === normalizeString(source.sessionId) &&
    row.source_run_id === normalizeString(source.runId) &&
    row.source_tool_call_id === normalizeString(source.toolCallId) &&
    row.source_tool_name === normalizeString(source.toolName) &&
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
  const reviewerDeviceIdsJson = JSON.stringify(normalizeStringArray(input.reviewerDeviceIds));
  const audienceSessionKeys = normalizeStringArray(input.audienceSessionKeys);
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
          requested_by_device_id: normalizeString(input.requester?.deviceId),
          requested_by_client_id: normalizeString(input.requester?.clientId),
          requested_by_device_token_auth: input.requester?.deviceTokenAuth === true ? 1 : 0,
          reviewer_device_ids_json: reviewerDeviceIdsJson,
          source_agent_id: normalizeString(source.agentId),
          source_session_key: normalizeString(source.sessionKey),
          source_session_id: normalizeString(source.sessionId),
          source_run_id: normalizeString(source.runId),
          source_tool_call_id: normalizeString(source.toolCallId),
          source_tool_name: normalizeString(source.toolName),
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
      return { outcome: "inserted", record };
    }
    return inputMatchesExistingRow(input, row, serialized)
      ? { outcome: "existing", record }
      : { outcome: "conflict" };
  }, params.databaseOptions);
}

export function getOperatorApprovalDetailed(params: {
  id: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): GetOperatorApprovalResult {
  const id = requireApprovalId(params.id);
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    let row = selectOperatorApprovalRow(database, id);
    if (!row) {
      return { outcome: "not-found" };
    }
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
    return { outcome: "corrupt" };
  }, params.databaseOptions);
}

/** Resolve either the canonical id or its fixed-size transport reference. */
export function getOperatorApprovalDetailedByLocator(params: {
  locator: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): GetOperatorApprovalResult {
  const locator = requireApprovalId(params.locator);
  return runOpenClawStateWriteTransaction((database) => {
    const nowMs = params.nowMs ?? Date.now();
    let row = selectOperatorApprovalRowByLocator(database, locator);
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
    return { outcome: "corrupt", id };
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
  const resolverId = normalizeString(params.resolver.id);
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
    if (!record.presentation.allowedDecisions.includes(params.decision)) {
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
        resolver_id: normalizeString(params.resolver.id),
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
