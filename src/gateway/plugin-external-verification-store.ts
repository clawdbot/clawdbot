// Durable, proof-free attempt ledger and atomic external approval completion.
import { createHash, randomUUID } from "node:crypto";
import { sql, type Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type {
  PluginExternalVerificationAttemptSnapshot,
  PluginExternalVerificationGrantAuthorization,
} from "../plugins/external-verification-approval-types.js";
import { ensurePluginExternalVerificationSchema } from "../state/openclaw-state-db-schema-additive.js";
import type {
  DB as OpenClawStateKyselyDatabase,
  OperatorApprovals,
  PluginExternalVerificationAttempts,
} from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { isOperatorApprovalReviewerAuthorized } from "./operator-approval-authorization.js";

type ExternalAttemptRow = Selectable<PluginExternalVerificationAttempts>;
type OperatorApprovalRow = Selectable<OperatorApprovals>;
type ExternalVerificationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "operator_approvals" | "plugin_external_verification_attempts"
>;

type ExternalVerificationUnavailableOutcome =
  | "approval-expired"
  | "approval-not-found"
  | "approval-not-pending"
  | "decision-unavailable"
  | "owner-unavailable"
  | "reviewer-unauthorized"
  | "run-unavailable";

type NativeExternalVerificationAction = {
  intent: "start" | "retry";
  expectedAttemptId: string | null;
};

type StartExternalVerificationResult =
  | {
      outcome: "started" | "replay";
      attempt: PluginExternalVerificationAttemptSnapshot;
    }
  | {
      outcome: "stale-action";
      attempt?: PluginExternalVerificationAttemptSnapshot;
    }
  | {
      outcome: ExternalVerificationUnavailableOutcome;
    };

export type ExternalVerificationNativeActionState =
  | {
      outcome: "ready";
      action: NativeExternalVerificationAction;
    }
  | {
      outcome: ExternalVerificationUnavailableOutcome;
    };

type CompleteExternalVerificationStoreResult =
  | {
      outcome: "completed" | "replay";
      applied: boolean;
      approvalId: string;
      attempt: PluginExternalVerificationAttemptSnapshot;
      grantAuthorization?: PluginExternalVerificationGrantAuthorization;
    }
  | { outcome: "approval-expired"; approvalId: string }
  | { outcome: "attempt-not-found" };

export function getExternalVerificationAttemptSnapshot(params: {
  attemptId: string;
  pluginId: string;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): PluginExternalVerificationAttemptSnapshot | null {
  return runOpenClawStateWriteTransaction((database) => {
    ensurePluginExternalVerificationSchema(database.db);
    const attempt = selectAttempt(database, params.attemptId);
    if (!attempt || attempt.plugin_id !== params.pluginId) {
      return null;
    }
    return decodeAttempt(attempt);
  }, params.databaseOptions);
}

type ExternalResolutionProjection = {
  label: string;
  decisions: Array<"allow-once" | "allow-always">;
};

function readExternalResolution(row: OperatorApprovalRow): ExternalResolutionProjection | null {
  try {
    const presentation: unknown = JSON.parse(row.presentation_json);
    if (typeof presentation !== "object" || presentation === null || Array.isArray(presentation)) {
      return null;
    }
    // SAFETY: isRecord(presentation) was checked by the caller guard above.
    const record = presentation as Record<string, unknown>;
    const external = record.externalResolution;
    if (typeof external !== "object" || external === null || Array.isArray(external)) {
      return null;
    }
    // SAFETY: isRecord(external) was checked immediately above.
    const externalRecord = external as Record<string, unknown>;
    const label = typeof externalRecord.label === "string" ? externalRecord.label.trim() : "";
    const rawDecisions = externalRecord.decisions;
    if (
      !label ||
      !Array.isArray(rawDecisions) ||
      rawDecisions.length < 1 ||
      rawDecisions.length > 2 ||
      rawDecisions.some((decision) => decision !== "allow-once" && decision !== "allow-always")
    ) {
      return null;
    }
    return {
      label,
      // SAFETY: the filter above kept only allow-once/allow-always literals.
      decisions: rawDecisions as Array<"allow-once" | "allow-always">,
    };
  } catch {
    return null;
  }
}

function readReviewerDeviceIds(row: OperatorApprovalRow): string[] | null {
  try {
    const value: unknown = JSON.parse(row.reviewer_device_ids_json);
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
  } catch {
    return null;
  }
}

function decodeAttempt(row: ExternalAttemptRow): PluginExternalVerificationAttemptSnapshot {
  const decision = row.decision === "allow-always" ? "allow-always" : "allow-once";
  const outcome =
    row.outcome === "succeeded" ||
    row.outcome === "failed" ||
    row.outcome === "cancelled" ||
    row.outcome === "timed-out"
      ? row.outcome
      : undefined;
  return {
    id: row.attempt_id,
    context: {
      approvalId: row.approval_id,
      pluginId: row.plugin_id,
      runId: row.run_id,
      toolName: row.tool_name,
      ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
      ...(row.agent_id ? { agentId: row.agent_id } : {}),
      ...(row.session_key ? { sessionKey: row.session_key } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      decision,
      label: row.label,
      expiresAtMs: row.expires_at_ms,
    },
    createdAtMs: row.created_at_ms,
    ...(row.ended_at_ms === null ? {} : { endedAtMs: row.ended_at_ms }),
    ...(outcome ? { outcome } : {}),
    ...(row.error_class ? { errorClass: row.error_class } : {}),
    ...(row.terminal_source ? { terminalSource: row.terminal_source } : {}),
  };
}

function decodeAttemptForDecision(
  row: ExternalAttemptRow | undefined,
  decision: "allow-once" | "allow-always",
): PluginExternalVerificationAttemptSnapshot | undefined {
  return row?.decision === decision ? decodeAttempt(row) : undefined;
}

function buildGrantAuthorization(
  row: ExternalAttemptRow,
): PluginExternalVerificationGrantAuthorization | undefined {
  if (
    row.outcome !== "succeeded" ||
    row.decision !== "allow-always" ||
    !row.grant_authorization_id ||
    row.grant_issued_at_ms === null
  ) {
    return undefined;
  }
  return {
    id: row.grant_authorization_id,
    issuedAtMs: row.grant_issued_at_ms,
    approvalId: row.approval_id,
    attemptId: row.attempt_id,
    decision: row.decision === "allow-always" ? "allow-always" : "allow-once",
  };
}

function stableGrantAuthorizationId(attemptId: string): string {
  return createHash("sha256").update(`external-verification:${attemptId}`).digest("base64url");
}

function bindInteractionIdToDecision(
  interactionId: string,
  decision: "allow-once" | "allow-always",
): string {
  return createHash("sha256")
    .update(`external-verification-interaction:${interactionId}:${decision}`)
    .digest("hex");
}

function selectAttempt(
  database: OpenClawStateDatabase,
  attemptId: string,
): ExternalAttemptRow | undefined {
  const stateDb = getNodeSqliteKysely<ExternalVerificationDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("plugin_external_verification_attempts")
      .selectAll()
      .where("attempt_id", "=", attemptId),
  );
}

function selectLatestAttempt(
  database: OpenClawStateDatabase,
  approvalId: string,
): ExternalAttemptRow | undefined {
  const stateDb = getNodeSqliteKysely<ExternalVerificationDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("plugin_external_verification_attempts")
      .selectAll()
      .where("approval_id", "=", approvalId)
      .orderBy(sql<number>`rowid`, "desc"),
  );
}

function selectActiveAttempt(
  database: OpenClawStateDatabase,
  approvalId: string,
): ExternalAttemptRow | undefined {
  const stateDb = getNodeSqliteKysely<ExternalVerificationDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    stateDb
      .selectFrom("plugin_external_verification_attempts")
      .selectAll()
      .where("approval_id", "=", approvalId)
      .where("ended_at_ms", "is", null),
  );
}

function selectExternalApproval(params: {
  database: OpenClawStateDatabase;
  approvalId: string;
  reviewerDeviceId?: string;
  runtimeEpoch: string;
}):
  | { outcome: "ready"; approval: OperatorApprovalRow }
  | { outcome: "approval-not-found" | "reviewer-unauthorized" } {
  const stateDb = getNodeSqliteKysely<ExternalVerificationDatabase>(params.database.db);
  const approval = executeSqliteQueryTakeFirstSync(
    params.database.db,
    stateDb
      .selectFrom("operator_approvals")
      .selectAll()
      .where("approval_id", "=", params.approvalId),
  );
  if (!approval || approval.kind !== "plugin" || approval.runtime_epoch !== params.runtimeEpoch) {
    return { outcome: "approval-not-found" };
  }
  const reviewerDeviceIds = readReviewerDeviceIds(approval);
  if (
    !reviewerDeviceIds ||
    !isOperatorApprovalReviewerAuthorized({
      reviewerDeviceId: params.reviewerDeviceId,
      reviewerDeviceIds,
    })
  ) {
    return { outcome: "reviewer-unauthorized" };
  }
  return { outcome: "ready", approval };
}

function validatePendingExternalApproval(params: {
  database: OpenClawStateDatabase;
  approval: OperatorApprovalRow;
  decision: "allow-once" | "allow-always";
  nowMs: number;
}):
  | {
      outcome: "ready";
      external: ExternalResolutionProjection;
      pluginId: string;
      runId: string;
      toolName: string;
    }
  | { outcome: Exclude<ExternalVerificationUnavailableOutcome, "reviewer-unauthorized"> } {
  const { approval } = params;
  if (approval.status !== "pending") {
    return { outcome: "approval-not-pending" };
  }
  if (approval.expires_at_ms <= params.nowMs) {
    return { outcome: "approval-expired" };
  }
  const external = readExternalResolution(approval);
  if (!external?.decisions.includes(params.decision)) {
    return { outcome: "decision-unavailable" };
  }
  const pluginId = (() => {
    try {
      // SAFETY: presentation_json is host-written canonical presentation state.
      const presentation = JSON.parse(approval.presentation_json) as {
        pluginId?: unknown;
      };
      return typeof presentation.pluginId === "string" ? presentation.pluginId.trim() : "";
    } catch {
      return "";
    }
  })();
  if (!pluginId) {
    return { outcome: "owner-unavailable" };
  }
  const runId = approval.source_run_id?.trim() ?? "";
  if (!runId) {
    return { outcome: "run-unavailable" };
  }
  const toolName = approval.source_tool_name?.trim() ?? "";
  if (!toolName) {
    return { outcome: "approval-not-found" };
  }
  return { outcome: "ready", external, pluginId, runId, toolName };
}

/** Read the exact attempt generation a native approval action must bind. */
export function getExternalVerificationNativeActionState(params: {
  approvalId: string;
  decision: "allow-once" | "allow-always";
  reviewerDeviceId?: string;
  runtimeEpoch: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): ExternalVerificationNativeActionState {
  return runOpenClawStateWriteTransaction((database) => {
    ensurePluginExternalVerificationSchema(database.db);
    const selected = selectExternalApproval({ database, ...params });
    if (selected.outcome !== "ready") {
      return selected;
    }
    const validated = validatePendingExternalApproval({
      database,
      approval: selected.approval,
      decision: params.decision,
      nowMs: params.nowMs ?? Date.now(),
    });
    if (validated.outcome !== "ready") {
      return validated;
    }
    const active = selectActiveAttempt(database, selected.approval.approval_id);
    if (active) {
      return {
        outcome: "ready",
        action: { intent: "retry", expectedAttemptId: active.attempt_id },
      };
    }
    return {
      outcome: "ready",
      action: {
        intent: "start",
        expectedAttemptId:
          selectLatestAttempt(database, selected.approval.approval_id)?.attempt_id ?? null,
      },
    };
  }, params.databaseOptions);
}

/** Start or replay one reviewer interaction, replacing only an active prior attempt. */
export function startExternalVerificationAttempt(params: {
  approvalId: string;
  decision: "allow-once" | "allow-always";
  interactionId: string;
  reviewerDeviceId?: string;
  nativeAction?: NativeExternalVerificationAction;
  runtimeEpoch: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): StartExternalVerificationResult {
  return runOpenClawStateWriteTransaction((database) => {
    ensurePluginExternalVerificationSchema(database.db);
    const nowMs = params.nowMs ?? Date.now();
    // Decision is part of the idempotency key: each authenticated interaction/decision
    // pair starts once, so stale redelivery cannot revive superseded reviewer intent.
    const interactionId = bindInteractionIdToDecision(params.interactionId, params.decision);
    const selected = selectExternalApproval({ database, ...params });
    if (selected.outcome !== "ready") {
      return selected;
    }
    const approval = selected.approval;
    const stateDb = getNodeSqliteKysely<ExternalVerificationDatabase>(database.db);
    // The manager owns terminal lifecycle publication and in-memory cancellation.
    // Report due state before replay so the runtime can expire through that owner.
    if (approval.status === "pending" && approval.expires_at_ms <= nowMs) {
      return { outcome: "approval-expired" };
    }
    const replay = executeSqliteQueryTakeFirstSync(
      database.db,
      stateDb
        .selectFrom("plugin_external_verification_attempts")
        .selectAll()
        .where("approval_id", "=", approval.approval_id)
        .where("interaction_id", "=", interactionId),
    );
    if (replay) {
      if (params.nativeAction) {
        const latest = selectLatestAttempt(database, approval.approval_id);
        if (latest?.attempt_id !== replay.attempt_id) {
          const attempt = decodeAttemptForDecision(latest, params.decision);
          return {
            outcome: "stale-action",
            ...(attempt ? { attempt } : {}),
          };
        }
      }
      return { outcome: "replay", attempt: decodeAttempt(replay) };
    }
    const validated = validatePendingExternalApproval({
      database,
      approval,
      decision: params.decision,
      nowMs,
    });
    if (validated.outcome !== "ready") {
      return validated;
    }
    if (params.nativeAction) {
      const active = selectActiveAttempt(database, approval.approval_id);
      const latest = selectLatestAttempt(database, approval.approval_id);
      const actionMatches =
        params.nativeAction.intent === "retry"
          ? Boolean(
              active &&
              latest?.attempt_id === active.attempt_id &&
              active.attempt_id === params.nativeAction.expectedAttemptId,
            )
          : !active && (latest?.attempt_id ?? null) === params.nativeAction.expectedAttemptId;
      if (!actionMatches) {
        const attempt = decodeAttemptForDecision(latest, params.decision);
        return {
          outcome: "stale-action",
          ...(attempt ? { attempt } : {}),
        };
      }
    }
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("plugin_external_verification_attempts")
        .set({
          ended_at_ms: nowMs,
          outcome: "cancelled",
          terminal_source: "reviewer-retry",
          completion_applied: 0,
        })
        .where("approval_id", "=", approval.approval_id)
        .where("ended_at_ms", "is", null),
    );
    const attemptId = `external:${randomUUID()}`;
    executeSqliteQuerySync(
      database.db,
      stateDb.insertInto("plugin_external_verification_attempts").values({
        attempt_id: attemptId,
        approval_id: approval.approval_id,
        plugin_id: validated.pluginId,
        run_id: validated.runId,
        tool_name: validated.toolName,
        tool_call_id: approval.source_tool_call_id,
        agent_id: approval.source_agent_id,
        session_key: approval.source_session_key,
        session_id: approval.source_session_id,
        interaction_id: interactionId,
        decision: params.decision,
        label: validated.external.label,
        created_at_ms: nowMs,
        expires_at_ms: approval.expires_at_ms,
        ended_at_ms: null,
        outcome: null,
        error_class: null,
        terminal_source: null,
        completion_applied: null,
        grant_authorization_id: null,
        grant_issued_at_ms: null,
        resolver_plugin_id: null,
        runtime_epoch: params.runtimeEpoch,
      }),
    );
    const attempt = selectAttempt(database, attemptId);
    if (!attempt) {
      throw new Error("external verification attempt was not readable after insert");
    }
    return { outcome: "started", attempt: decodeAttempt(attempt) };
  }, params.databaseOptions);
}

function endExternalVerificationAttempt(params: {
  attemptId: string;
  pluginId: string;
  outcome: "failed" | "cancelled";
  errorClass?: string;
  terminalSource: "verifier-error" | "verifier-retired";
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): void {
  runOpenClawStateWriteTransaction((database) => {
    ensurePluginExternalVerificationSchema(database.db);
    const stateDb = getNodeSqliteKysely<ExternalVerificationDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("plugin_external_verification_attempts")
        .set({
          ended_at_ms: params.nowMs ?? Date.now(),
          outcome: params.outcome,
          error_class: params.errorClass ?? null,
          terminal_source: params.terminalSource,
          completion_applied: 0,
        })
        .where("attempt_id", "=", params.attemptId)
        .where("plugin_id", "=", params.pluginId)
        .where("ended_at_ms", "is", null),
    );
  }, params.databaseOptions);
}

/** Mark a verifier dispatch failure without resolving the owning approval. */
export function failExternalVerificationAttempt(params: {
  attemptId: string;
  pluginId: string;
  errorClass: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): void {
  endExternalVerificationAttempt({
    ...params,
    outcome: "failed",
    terminalSource: "verifier-error",
  });
}

/** Cancel an attempt whose owning verifier instance is no longer live. */
export function cancelRetiredExternalVerificationAttempt(params: {
  attemptId: string;
  pluginId: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): void {
  endExternalVerificationAttempt({
    ...params,
    outcome: "cancelled",
    terminalSource: "verifier-retired",
  });
}

/** Complete an attempt and atomically authorize the canonical approval on success. */
export function completeExternalVerificationAttempt(params: {
  attemptId: string;
  pluginId: string;
  outcome: "succeeded" | "failed";
  runtimeEpoch: string;
  nowMs?: number;
  databaseOptions?: OpenClawStateDatabaseOptions;
}): CompleteExternalVerificationStoreResult {
  return runOpenClawStateWriteTransaction((database) => {
    ensurePluginExternalVerificationSchema(database.db);
    const nowMs = params.nowMs ?? Date.now();
    const stateDb = getNodeSqliteKysely<ExternalVerificationDatabase>(database.db);
    let attempt = selectAttempt(database, params.attemptId);
    if (!attempt || attempt.plugin_id !== params.pluginId) {
      return { outcome: "attempt-not-found" };
    }
    if (attempt.ended_at_ms !== null) {
      return {
        outcome: "replay",
        applied: false,
        approvalId: attempt.approval_id,
        attempt: decodeAttempt(attempt),
        ...(buildGrantAuthorization(attempt)
          ? { grantAuthorization: buildGrantAuthorization(attempt) }
          : {}),
      };
    }
    if (attempt.runtime_epoch !== params.runtimeEpoch) {
      return { outcome: "attempt-not-found" };
    }
    if (params.outcome === "failed") {
      executeSqliteQuerySync(
        database.db,
        stateDb
          .updateTable("plugin_external_verification_attempts")
          .set({
            ended_at_ms: nowMs,
            outcome: "failed",
            terminal_source: "plugin-completion",
            completion_applied: 0,
          })
          .where("attempt_id", "=", params.attemptId)
          .where("ended_at_ms", "is", null),
      );
      attempt = selectAttempt(database, params.attemptId)!;
      return {
        outcome: "completed",
        applied: false,
        approvalId: attempt.approval_id,
        attempt: decodeAttempt(attempt),
      };
    }
    const approval = executeSqliteQueryTakeFirstSync(
      database.db,
      stateDb
        .selectFrom("operator_approvals")
        .selectAll()
        .where("approval_id", "=", attempt.approval_id),
    );
    const matchesApproval =
      approval?.kind === "plugin" &&
      approval.runtime_epoch === params.runtimeEpoch &&
      approval.status === "pending" &&
      approval.source_run_id === attempt.run_id;
    if (matchesApproval && approval.expires_at_ms <= nowMs) {
      return { outcome: "approval-expired", approvalId: attempt.approval_id };
    }
    if (!matchesApproval) {
      executeSqliteQuerySync(
        database.db,
        stateDb
          .updateTable("plugin_external_verification_attempts")
          .set({
            ended_at_ms: nowMs,
            outcome: "cancelled",
            terminal_source: "approval-unavailable",
            completion_applied: 0,
          })
          .where("attempt_id", "=", params.attemptId)
          .where("ended_at_ms", "is", null),
      );
      attempt = selectAttempt(database, params.attemptId)!;
      return {
        outcome: "completed",
        applied: false,
        approvalId: attempt.approval_id,
        attempt: decodeAttempt(attempt),
      };
    }
    const external = readExternalResolution(approval);
    if (
      approval.presentation_json.length === 0 ||
      !external?.decisions.includes(
        attempt.decision === "allow-always" ? "allow-always" : "allow-once",
      )
    ) {
      executeSqliteQuerySync(
        database.db,
        stateDb
          .updateTable("plugin_external_verification_attempts")
          .set({
            ended_at_ms: nowMs,
            outcome: "cancelled",
            terminal_source: "decision-unavailable",
            completion_applied: 0,
          })
          .where("attempt_id", "=", params.attemptId)
          .where("ended_at_ms", "is", null),
      );
      attempt = selectAttempt(database, params.attemptId)!;
      return {
        outcome: "completed",
        applied: false,
        approvalId: attempt.approval_id,
        attempt: decodeAttempt(attempt),
      };
    }
    const reusable = attempt.decision === "allow-always";
    const grantAuthorizationId = reusable ? stableGrantAuthorizationId(attempt.attempt_id) : null;
    executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("plugin_external_verification_attempts")
        .set({
          ended_at_ms: nowMs,
          outcome: "succeeded",
          terminal_source: "plugin-completion",
          completion_applied: 1,
          grant_authorization_id: grantAuthorizationId,
          grant_issued_at_ms: reusable ? nowMs : null,
          resolver_plugin_id: params.pluginId,
        })
        .where("attempt_id", "=", params.attemptId)
        .where("ended_at_ms", "is", null),
    );
    const approvalUpdate = executeSqliteQuerySync(
      database.db,
      stateDb
        .updateTable("operator_approvals")
        .set({
          status: "allowed",
          decision: attempt.decision,
          terminal_reason: "user",
          resolved_at_ms: nowMs,
          resolver_kind: "runtime",
          resolver_id: `plugin:${params.pluginId}`,
          updated_at_ms: nowMs,
        })
        .where("approval_id", "=", attempt.approval_id)
        .where("status", "=", "pending")
        .where("runtime_epoch", "=", params.runtimeEpoch)
        .where("expires_at_ms", ">", nowMs),
    );
    if (approvalUpdate.numAffectedRows !== 1n) {
      throw new Error("external verification lost approval authorization after validation");
    }
    attempt = selectAttempt(database, params.attemptId)!;
    const grantAuthorization = buildGrantAuthorization(attempt);
    return {
      outcome: "completed",
      applied: true,
      approvalId: attempt.approval_id,
      attempt: decodeAttempt(attempt),
      ...(grantAuthorization ? { grantAuthorization } : {}),
    };
  }, params.databaseOptions);
}
