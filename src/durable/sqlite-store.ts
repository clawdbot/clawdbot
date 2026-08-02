// SQLite-backed durable runtime store for the native control plane.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  acquireOpenClawStateDatabaseLease,
  closeOpenClawStateDatabaseForPath,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { DB as DurableSchemaKyselyDatabase } from "./schema-db.generated.js";
import { ensureDurableRuntimeSchema, openDurableRuntimeSchemaReadOnly } from "./schema.js";
import type {
  AppendDurableRuntimeEventInput,
  ClaimNextWakeObligationInput,
  ClaimDurableRuntimeStepInput,
  CompactDurableRuntimeRunInput,
  CompactDurableRuntimeRunResult,
  CompleteWakeObligationClaimInput,
  CreateDurableRuntimeLinkInput,
  CreateWakeObligationInput,
  CreateDurableRuntimeRefInput,
  CreateDurableRuntimeRunInput,
  CreateDurableRuntimeSignalInput,
  CreateDurableRuntimeStepInput,
  CreateDurableRuntimeTimerInput,
  CreateUncertaintyFactInput,
  WakeObligation,
  WakeObligationClaim,
  WakeObligationOwnerKind,
  WakeObligationStatus,
  WakeObligationTargetKind,
  WakeObligationTargetResolutionStatus,
  DurableRuntimeLink,
  DurableRuntimeLinkStatus,
  DurableRuntimeLinkType,
  DurableRecoveryState,
  DurableRuntimeEvent,
  DurableRuntimeRef,
  DurableRuntimeRefKind,
  DurableRuntimeRun,
  DurableRuntimeRunStatus,
  DurableRuntimeSignal,
  DurableRuntimeStep,
  DurableRuntimeStepStatus,
  DurableRuntimeStepType,
  DurableRuntimeStore,
  DurableRuntimeStoreStats,
  DurableRuntimeTimelineOptions,
  DurableRuntimeTimer,
  DurableRuntimeTimerStatus,
  UncertaintyFact,
  UncertaintyFactStatus,
  DurableUnresolvedObligation,
  WakeObligationControlDecision,
  WakeObligationControlDecisionKind,
  DeliveryAttemptEvidence,
  DeliveryAttemptEvidenceStatus,
  WakeObligationInspection,
  UpdateDurableRuntimeRunInput,
  UpdateDurableRuntimeLinkInput,
  ResumeWakeObligationInput,
  ResolveUncertaintyFactInput,
  RenewWakeObligationClaimInput,
  MarkWakeObligationDecisionRequiredInput,
  SupersedeWakeObligationInput,
  SuspendWakeObligationInput,
  WakeObligationControlInput,
  UpdateWakeObligationInput,
  UpdateWakeObligationProjectionInput,
  UpdateDurableRuntimeStepInput,
  UpdateDurableRuntimeTimerInput,
} from "./types.js";

type DurableRuntimeRunRow = {
  runtime_run_id: string;
  operation_kind: string;
  operation_version: string;
  idempotency_key: string | null;
  request_hash: string | null;
  status: DurableRuntimeRunStatus;
  source_owner: string | null;
  source_ref: string | null;
  input_ref: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  recovery_state: DurableRecoveryState;
  checkpoint_ref: string | null;
  parent_runtime_run_id: string | null;
  parent_step_id: string | null;
  message_id: string | null;
  turn_id: string | null;
  work_unit_id: string | null;
  report_route_id: string | null;
  heartbeat_at: number | null;
  metadata_json: string | null;
};

type DurableRuntimeEventRow = {
  event_id: string;
  runtime_run_id: string;
  event_seq: number;
  event_type: string;
  event_time: number;
  step_id: string | null;
  agent_invocation_id: string | null;
  tool_invocation_id: string | null;
  idempotency_key: string | null;
  payload_json: string | null;
  payload_hash: string | null;
  checkpoint_ref: string | null;
  causation_event_id: string | null;
  correlation_id: string | null;
  recorded_at: number;
};

type DurableRuntimeStepRow = {
  runtime_run_id: string;
  step_id: string;
  parent_step_id: string | null;
  step_type: DurableRuntimeStepType;
  status: DurableRuntimeStepStatus;
  recovery_state: DurableRecoveryState;
  attempt: number;
  max_attempts: number | null;
  idempotency_key: string | null;
  input_ref: string | null;
  output_ref: string | null;
  error_ref: string | null;
  checkpoint_ref: string | null;
  claimed_by: string | null;
  claim_expires_at: number | null;
  heartbeat_at: number | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
  metadata_json: string | null;
};

type DurableRuntimeRefRow = {
  ref_id: string;
  runtime_run_id: string;
  step_id: string | null;
  ref_kind: DurableRuntimeRefKind;
  media_type: string | null;
  hash: string | null;
  storage_kind: "inline" | "file" | "external";
  storage_uri: string | null;
  created_at: number;
  metadata_json: string | null;
};

type DurableRuntimeLinkRow = {
  parent_runtime_run_id: string;
  parent_step_id: string;
  child_runtime_run_id: string;
  link_type: DurableRuntimeLinkType;
  status: DurableRuntimeLinkStatus;
  created_at: number;
  updated_at: number;
  metadata_json: string | null;
};

type DurableRuntimeTimerRow = {
  timer_id: string;
  runtime_run_id: string;
  step_id: string | null;
  timer_type: DurableRuntimeTimer["timerType"];
  due_at: number;
  status: DurableRuntimeTimerStatus;
  created_at: number;
  fired_at: number | null;
  cancelled_at: number | null;
  metadata_json: string | null;
};

type DurableRuntimeSignalRow = {
  signal_id: string;
  runtime_run_id: string;
  step_id: string | null;
  signal_type: DurableRuntimeSignal["signalType"];
  idempotency_key: string | null;
  payload_ref: string | null;
  correlation_id: string | null;
  received_at: number;
  consumed_at: number | null;
  metadata_json: string | null;
};

type WakeObligationRow = {
  wake_id: string;
  source_owner: string;
  source_ref: string;
  parent_run_id: string | null;
  parent_session_key: string | null;
  target_agent: string | null;
  target_session: string | null;
  target_channel: string | null;
  target_kind: WakeObligationTargetKind | null;
  target_ref: string | null;
  owner_kind: WakeObligationOwnerKind | null;
  owner_ref: string | null;
  report_route_ref: string | null;
  target_resolution_status: WakeObligationTargetResolutionStatus | null;
  target_resolution_reason: string | null;
  reason: WakeObligation["reason"];
  facts_ref: string | null;
  source_run_id: string | null;
  dedupe_key: string;
  attempt_count: number | bigint;
  last_attempt_at: number | bigint | null;
  acked_at: number | bigint | null;
  failed_reason: string | null;
  status: WakeObligationStatus;
  created_at: number | bigint;
  updated_at: number | bigint;
  metadata_json: string | null;
};

type UncertaintyFactRow = {
  fact_id: string;
  source_owner: string;
  source_ref: string;
  kind: UncertaintyFact["kind"];
  source_run_id: string | null;
  step_id: string | null;
  event_id: string | null;
  ref_id: string | null;
  facts_ref: string | null;
  dedupe_key: string | null;
  facts_json: string | null;
  status: UncertaintyFactStatus;
  resolution_kind: string | null;
  resolution_ref: string | null;
  resolved_at: number | bigint | null;
  created_at: number | bigint;
  updated_at: number | bigint;
  metadata_json: string | null;
};

type DeliveryAttemptEvidenceRow = {
  delivery_attempt_id: string;
  source_owner: string;
  source_ref: string;
  wake_id: string;
  dedupe_key: string;
  replay_pass_id: string | null;
  target_kind: WakeObligationTargetKind | null;
  target_ref: string | null;
  route_kind: WakeObligationTargetKind | null;
  route_ref: string | null;
  status: DeliveryAttemptEvidenceStatus;
  evidence_json: string | null;
  error_message: string | null;
  scheduled_at: number | bigint;
  attempted_at: number | bigint | null;
  handoff_accepted_at: number | bigint | null;
  failed_at: number | bigint | null;
  unknown_at: number | bigint | null;
  delivery_claimed_by: string | null;
  delivery_claim_expires_at: number | bigint | null;
  created_at: number | bigint;
  updated_at: number | bigint;
  metadata_json: string | null;
};

type DurableUnresolvedObligationRow = {
  obligation_id: string;
  source_owner: string;
  source_ref: string;
  kind: DurableUnresolvedObligation["kind"];
  runtime_run_id: string | null;
  step_id: string | null;
  wake_id: string | null;
  uncertainty_fact_id: string | null;
  subject_ref: string | null;
  reason: string | null;
  status: string;
  created_at: number | bigint;
  updated_at: number | bigint;
  metadata_json: string | null;
};

type PendingSubagentDeliveryRow = {
  run_id: string;
  requester_session_key: string;
  pending_final_delivery_created_at: number | null;
  pending_final_delivery_last_attempt_at: number | null;
  pending_final_delivery_attempt_count: number | null;
  pending_final_delivery_last_error: string | null;
  created_at: number;
};

type PendingDeliveryQueueRow = {
  queue_name: string;
  id: string;
  status: string;
  session_key: string | null;
  channel: string | null;
  target: string | null;
  retry_count: number | bigint;
  last_attempt_at: number | null;
  last_error: string | null;
  recovery_state: string | null;
  enqueued_at: number;
  updated_at: number;
};

type ExpiredStateLeaseRow = {
  scope: string;
  lease_key: string;
  owner: string;
  expires_at: number | null;
  heartbeat_at: number | null;
  payload_json: string | null;
  created_at: number;
  updated_at: number;
};

type CountRow = { count: number | bigint };
type DurableRuntimeDatabase = DurableSchemaKyselyDatabase &
  Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries" | "state_leases" | "subagent_runs">;
type SyncQuery<Row> = Parameters<typeof executeSqliteQuerySync<Row>>[1];

function optionalText(value: string | undefined): string | null {
  return value && value.trim() ? value : null;
}

function metadataText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

const DURABLE_STEP_LEASE_SCOPE = "durable_execution_step";
const WAKE_OBLIGATION_LEASE_SCOPE = "wake_obligation";

function wakeRetryDelayMs(params: {
  wakeId: string;
  attemptCount: number;
  retryBaseMs: number;
  retryMaxMs: number;
}): number {
  const exponent = Math.max(0, Math.min(20, params.attemptCount - 1));
  const base = Math.min(params.retryMaxMs, params.retryBaseMs * 2 ** exponent);
  let hash = 0;
  for (const char of params.wakeId) {
    hash += char.codePointAt(0) ?? 0;
  }
  const jitter = 0.75 + (hash % 51) / 100;
  return Math.min(params.retryMaxMs, Math.max(params.retryBaseMs, Math.round(base * jitter)));
}

function durableStepLeaseKey(runtimeRunId: string, stepId: string): string {
  return `${runtimeRunId}:${stepId}`;
}

function requireSourceRef(
  input: { sourceOwner: string; sourceRef: string },
  subject: string,
): { sourceOwner: string; sourceRef: string } {
  const sourceOwner = optionalText(input.sourceOwner);
  const sourceRef = optionalText(input.sourceRef);
  if (!sourceOwner || !sourceRef) {
    throw new Error(`${subject} requires sourceOwner and sourceRef`);
  }
  return { sourceOwner, sourceRef };
}

function serializeJson(value: Record<string, unknown> | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function assertCompatibleEventReplay(
  existing: DurableRuntimeEventRow,
  input: AppendDurableRuntimeEventInput,
  identity: string,
): void {
  const mismatched =
    existing.runtime_run_id !== input.runtimeRunId ||
    existing.event_type !== input.eventType ||
    (input.eventId !== undefined && existing.event_id !== input.eventId) ||
    (input.stepId !== undefined && existing.step_id !== optionalText(input.stepId)) ||
    (input.agentInvocationId !== undefined &&
      existing.agent_invocation_id !== optionalText(input.agentInvocationId)) ||
    (input.toolInvocationId !== undefined &&
      existing.tool_invocation_id !== optionalText(input.toolInvocationId)) ||
    (input.idempotencyKey !== undefined &&
      existing.idempotency_key !== optionalText(input.idempotencyKey)) ||
    (input.payload !== undefined && existing.payload_json !== serializeJson(input.payload)) ||
    (input.payloadHash !== undefined &&
      existing.payload_hash !== optionalText(input.payloadHash)) ||
    (input.checkpointRef !== undefined &&
      existing.checkpoint_ref !== optionalText(input.checkpointRef)) ||
    (input.causationEventId !== undefined &&
      existing.causation_event_id !== optionalText(input.causationEventId)) ||
    (input.correlationId !== undefined &&
      existing.correlation_id !== optionalText(input.correlationId));
  if (mismatched) {
    throw new Error(`Durable event replay conflict for ${identity}`);
  }
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadata(value: string | null): Record<string, unknown> {
  return parseJsonRecord(value) ?? {};
}

function buildWakeControlDecision(
  input: WakeObligationControlInput,
  kind: WakeObligationControlDecisionKind,
  now: number,
): WakeObligationControlDecision {
  const actorRef = optionalText(input.actorRef);
  if (!actorRef) {
    throw new Error("Durable wake control requires actorRef");
  }
  return {
    kind,
    actorKind: input.actorKind,
    actorRef,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.decisionRef ? { decisionRef: input.decisionRef } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.expectedSourceRevision
      ? { expectedSourceRevision: input.expectedSourceRevision }
      : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    decidedAt: now,
  };
}

function mergeWakeControlMetadata(
  currentMetadataJson: string | null,
  decision: WakeObligationControlDecision,
  extras?: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = parseMetadata(currentMetadataJson);
  const existingControls = Array.isArray(metadata.durableWakeControls)
    ? metadata.durableWakeControls
    : [];
  return {
    ...metadata,
    durableWakeControl: decision,
    durableWakeControls: [...existingControls, decision],
    ...extras,
  };
}

function latestWakeControl(metadataJson: string | null): Record<string, unknown> | undefined {
  const metadata = parseJsonRecord(metadataJson);
  const control = metadata?.durableWakeControl;
  return isRecordValue(control) ? control : undefined;
}

function matchesExpectedWakeSourceRevision(
  current: WakeObligationRow,
  expectedSourceRevision: string | undefined,
): boolean {
  const expected = optionalText(expectedSourceRevision);
  if (!expected) {
    return true;
  }
  const metadata = parseMetadata(current.metadata_json);
  return metadataText(metadata.sourceRevision) === expected;
}

function isMatchingControlNoop(
  current: WakeObligationRow,
  kind: WakeObligationControlDecisionKind,
  idempotencyKey: string | undefined,
): boolean {
  const control = latestWakeControl(current.metadata_json);
  if (!control || control.kind !== kind) {
    return false;
  }
  return idempotencyKey ? control.idempotencyKey === idempotencyKey : true;
}

function rowToRun(row: DurableRuntimeRunRow): DurableRuntimeRun {
  const metadata = parseMetadata(row.metadata_json);
  const rootOperationReason = metadataText(metadata.rootOperationReason);
  return {
    runtimeRunId: row.runtime_run_id,
    operationKind: row.operation_kind,
    operationVersion: row.operation_version,
    status: row.status,
    recoveryState: row.recovery_state,
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.request_hash ? { requestHash: row.request_hash } : {}),
    ...(row.source_owner ? { sourceOwner: row.source_owner } : {}),
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    ...(rootOperationReason ? { rootOperationReason } : {}),
    ...(row.input_ref ? { inputRef: row.input_ref } : {}),
    ...(row.checkpoint_ref ? { checkpointRef: row.checkpoint_ref } : {}),
    ...(row.parent_runtime_run_id ? { parentRuntimeRunId: row.parent_runtime_run_id } : {}),
    ...(row.parent_step_id ? { parentStepId: row.parent_step_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.work_unit_id ? { workUnitId: row.work_unit_id } : {}),
    ...(row.report_route_id ? { reportRouteId: row.report_route_id } : {}),
    ...(row.heartbeat_at == null ? {} : { heartbeatAt: row.heartbeat_at }),
    ...(row.metadata_json ? { metadata } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at == null ? {} : { completedAt: row.completed_at }),
  };
}

function rowToEvent(row: DurableRuntimeEventRow): DurableRuntimeEvent {
  return {
    eventId: row.event_id,
    runtimeRunId: row.runtime_run_id,
    eventSeq: row.event_seq,
    eventType: row.event_type,
    eventTime: row.event_time,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.agent_invocation_id ? { agentInvocationId: row.agent_invocation_id } : {}),
    ...(row.tool_invocation_id ? { toolInvocationId: row.tool_invocation_id } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.payload_json ? { payload: parseJsonRecord(row.payload_json) } : {}),
    ...(row.payload_hash ? { payloadHash: row.payload_hash } : {}),
    ...(row.checkpoint_ref ? { checkpointRef: row.checkpoint_ref } : {}),
    ...(row.causation_event_id ? { causationEventId: row.causation_event_id } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    recordedAt: row.recorded_at,
  };
}

function rowToStep(row: DurableRuntimeStepRow): DurableRuntimeStep {
  return {
    runtimeRunId: row.runtime_run_id,
    stepId: row.step_id,
    ...(row.parent_step_id ? { parentStepId: row.parent_step_id } : {}),
    stepType: row.step_type,
    status: row.status,
    recoveryState: row.recovery_state,
    attempt: row.attempt,
    ...(row.max_attempts == null ? {} : { maxAttempts: row.max_attempts }),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.input_ref ? { inputRef: row.input_ref } : {}),
    ...(row.output_ref ? { outputRef: row.output_ref } : {}),
    ...(row.error_ref ? { errorRef: row.error_ref } : {}),
    ...(row.checkpoint_ref ? { checkpointRef: row.checkpoint_ref } : {}),
    ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
    ...(row.claim_expires_at == null ? {} : { claimExpiresAt: row.claim_expires_at }),
    ...(row.heartbeat_at == null ? {} : { heartbeatAt: row.heartbeat_at }),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: row.created_at,
    ...(row.started_at == null ? {} : { startedAt: row.started_at }),
    updatedAt: row.updated_at,
    ...(row.completed_at == null ? {} : { completedAt: row.completed_at }),
  };
}

function rowToRef(row: DurableRuntimeRefRow): DurableRuntimeRef {
  return {
    refId: row.ref_id,
    runtimeRunId: row.runtime_run_id,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    refKind: row.ref_kind,
    ...(row.media_type ? { mediaType: row.media_type } : {}),
    ...(row.hash ? { hash: row.hash } : {}),
    storageKind: row.storage_kind,
    ...(row.storage_uri ? { storageUri: row.storage_uri } : {}),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: row.created_at,
  };
}

function rowToLink(row: DurableRuntimeLinkRow): DurableRuntimeLink {
  return {
    parentRuntimeRunId: row.parent_runtime_run_id,
    parentStepId: row.parent_step_id,
    childRuntimeRunId: row.child_runtime_run_id,
    linkType: row.link_type,
    status: row.status,
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTimer(row: DurableRuntimeTimerRow): DurableRuntimeTimer {
  return {
    timerId: row.timer_id,
    runtimeRunId: row.runtime_run_id,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    timerType: row.timer_type,
    dueAt: row.due_at,
    status: row.status,
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: row.created_at,
    ...(row.fired_at == null ? {} : { firedAt: row.fired_at }),
    ...(row.cancelled_at == null ? {} : { cancelledAt: row.cancelled_at }),
  };
}

function rowToSignal(row: DurableRuntimeSignalRow): DurableRuntimeSignal {
  return {
    signalId: row.signal_id,
    runtimeRunId: row.runtime_run_id,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    signalType: row.signal_type,
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.payload_ref ? { payloadRef: row.payload_ref } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    receivedAt: row.received_at,
    ...(row.consumed_at == null ? {} : { consumedAt: row.consumed_at }),
  };
}

function rowToWakeObligation(row: WakeObligationRow): WakeObligation {
  return {
    wakeId: row.wake_id,
    sourceOwner: row.source_owner,
    sourceRef: row.source_ref,
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    ...(row.parent_session_key ? { parentSessionKey: row.parent_session_key } : {}),
    ...(row.target_agent ? { targetAgent: row.target_agent } : {}),
    ...(row.target_session ? { targetSession: row.target_session } : {}),
    ...(row.target_channel ? { targetChannel: row.target_channel } : {}),
    ...(row.target_kind ? { targetKind: row.target_kind } : {}),
    ...(row.target_ref ? { targetRef: row.target_ref } : {}),
    ...(row.owner_kind ? { ownerKind: row.owner_kind } : {}),
    ...(row.owner_ref ? { ownerRef: row.owner_ref } : {}),
    ...(row.report_route_ref ? { reportRouteRef: row.report_route_ref } : {}),
    ...(row.target_resolution_status
      ? { targetResolutionStatus: row.target_resolution_status }
      : {}),
    ...(row.target_resolution_reason
      ? { targetResolutionReason: row.target_resolution_reason }
      : {}),
    reason: row.reason,
    ...(row.facts_ref ? { factsRef: row.facts_ref } : {}),
    ...(row.source_run_id ? { sourceRunId: row.source_run_id } : {}),
    dedupeKey: row.dedupe_key,
    attemptCount: Number(row.attempt_count),
    ...(row.last_attempt_at == null ? {} : { lastAttemptAt: Number(row.last_attempt_at) }),
    ...(row.acked_at == null ? {} : { ackedAt: Number(row.acked_at) }),
    ...(row.failed_reason ? { failedReason: row.failed_reason } : {}),
    status: row.status,
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToUncertaintyFact(row: UncertaintyFactRow): UncertaintyFact {
  return {
    factId: row.fact_id,
    sourceOwner: row.source_owner,
    sourceRef: row.source_ref,
    kind: row.kind,
    ...(row.source_run_id ? { sourceRunId: row.source_run_id } : {}),
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.event_id ? { eventId: row.event_id } : {}),
    ...(row.ref_id ? { refId: row.ref_id } : {}),
    ...(row.facts_ref ? { factsRef: row.facts_ref } : {}),
    ...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
    ...(row.facts_json ? { facts: parseJsonRecord(row.facts_json) } : {}),
    status: row.status,
    ...(row.resolution_kind ? { resolutionKind: row.resolution_kind } : {}),
    ...(row.resolution_ref ? { resolutionRef: row.resolution_ref } : {}),
    ...(row.resolved_at == null ? {} : { resolvedAt: Number(row.resolved_at) }),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToDeliveryAttemptEvidence(row: DeliveryAttemptEvidenceRow): DeliveryAttemptEvidence {
  return {
    deliveryAttemptId: row.delivery_attempt_id,
    sourceOwner: row.source_owner,
    sourceRef: row.source_ref,
    wakeId: row.wake_id,
    dedupeKey: row.dedupe_key,
    ...(row.replay_pass_id ? { replayPassId: row.replay_pass_id } : {}),
    ...(row.target_kind ? { targetKind: row.target_kind } : {}),
    ...(row.target_ref ? { targetRef: row.target_ref } : {}),
    ...(row.route_kind ? { routeKind: row.route_kind } : {}),
    ...(row.route_ref ? { routeRef: row.route_ref } : {}),
    status: row.status,
    ...(row.evidence_json ? { evidence: parseJsonRecord(row.evidence_json) } : {}),
    ...(row.error_message ? { error: row.error_message } : {}),
    scheduledAt: Number(row.scheduled_at),
    ...(row.attempted_at == null ? {} : { attemptedAt: Number(row.attempted_at) }),
    ...(row.handoff_accepted_at == null
      ? {}
      : { handoffAcceptedAt: Number(row.handoff_accepted_at) }),
    ...(row.failed_at == null ? {} : { failedAt: Number(row.failed_at) }),
    ...(row.unknown_at == null ? {} : { unknownAt: Number(row.unknown_at) }),
    ...(row.delivery_claimed_by ? { deliveryClaimedBy: row.delivery_claimed_by } : {}),
    ...(row.delivery_claim_expires_at == null
      ? {}
      : { deliveryClaimExpiresAt: Number(row.delivery_claim_expires_at) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
  };
}

function rowToUnresolvedObligation(
  row: DurableUnresolvedObligationRow,
): DurableUnresolvedObligation {
  return {
    obligationId: row.obligation_id,
    sourceOwner: row.source_owner,
    sourceRef: row.source_ref,
    kind: row.kind,
    ...(row.runtime_run_id ? { runtimeRunId: row.runtime_run_id } : {}),
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.wake_id ? { wakeId: row.wake_id } : {}),
    ...(row.uncertainty_fact_id ? { uncertaintyFactId: row.uncertainty_fact_id } : {}),
    ...(row.subject_ref ? { subjectRef: row.subject_ref } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
  };
}

function queryRows<Row>(db: DatabaseSync, query: SyncQuery<Row>): Row[] {
  return executeSqliteQuerySync(db, query).rows as Row[];
}

function queryFirst<Row>(db: DatabaseSync, query: SyncQuery<Row>): Row | undefined {
  return executeSqliteQueryTakeFirstSync(db, query) as Row | undefined;
}

function executeQuery(db: DatabaseSync, query: SyncQuery<unknown>): number {
  const result = executeSqliteQuerySync(db, query);
  return Number(result.numAffectedRows ?? 0);
}

function count(db: DatabaseSync, query: SyncQuery<CountRow>): number {
  const row = queryFirst<CountRow>(db, query);
  return Number(row?.count ?? 0);
}

function normalizeQueryLimit(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(5000, Math.trunc(limit ?? fallback)));
}

const NO_SILENCE_DIAGNOSTIC_PATHS = {
  overdue: "$.diagnostics.noSilenceSla.overdue",
  slaMs: "$.diagnostics.noSilenceSla.slaMs",
} as const;

function noSilenceDiagnosticNumber(
  jsonPath: (typeof NO_SILENCE_DIAGNOSTIC_PATHS)[keyof typeof NO_SILENCE_DIAGNOSTIC_PATHS],
) {
  return sql<number>`json_extract(metadata_json, ${jsonPath})`; // kysely-allow-raw: closed path union
}

function isTerminalRunStatus(status: DurableRuntimeRunStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

function isTerminalStepStatus(status: DurableRuntimeStepStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "lost" ||
    status === "skipped"
  );
}

function isTerminalRunRow(row: DurableRuntimeRunRow): boolean {
  return (
    isTerminalRunStatus(row.status) ||
    row.recovery_state === "terminal" ||
    row.completed_at !== null
  );
}

function isTerminalStepRow(row: DurableRuntimeStepRow): boolean {
  return (
    isTerminalStepStatus(row.status) ||
    row.recovery_state === "terminal" ||
    row.completed_at !== null
  );
}

function isTerminalWakeStatus(status: WakeObligationStatus): boolean {
  return status === "acked" || status === "superseded";
}

function isAllowedWakeStatusTransition(
  current: WakeObligationStatus,
  next: WakeObligationStatus,
): boolean {
  if (current === next) {
    return true;
  }
  if (current === "pending") {
    return (
      next === "handoff_accepted" ||
      next === "acked" ||
      next === "failed" ||
      next === "suspended" ||
      next === "superseded"
    );
  }
  if (current === "handoff_accepted") {
    return next === "acked" || next === "failed" || next === "suspended" || next === "superseded";
  }
  if (current === "failed") {
    return (
      next === "handoff_accepted" ||
      next === "acked" ||
      next === "suspended" ||
      next === "superseded"
    );
  }
  if (current === "suspended") {
    return next === "pending" || next === "acked" || next === "superseded";
  }
  return false;
}

function isSameSqlValue(
  left: string | number | bigint | null,
  right: string | number | bigint | null,
): boolean {
  return left === right;
}

export function openDurableRuntimeSqliteStore(storeOptions?: {
  path?: string;
  env?: NodeJS.ProcessEnv;
  readOnly?: boolean;
}): DurableRuntimeStore {
  const env = storeOptions?.env ?? process.env;
  const pathname = path.resolve(storeOptions?.path ?? resolveOpenClawStateSqlitePath(env));
  const readOnly = storeOptions?.readOnly === true;
  let db: DatabaseSync;
  let releaseDatabase: () => void;
  if (readOnly) {
    db = openDurableRuntimeSchemaReadOnly(pathname);
    releaseDatabase = () => db.close();
  } else {
    const stateDatabaseLease = acquireOpenClawStateDatabaseLease({ env, path: pathname });
    db = stateDatabaseLease.database.db;
    releaseDatabase = () => {
      stateDatabaseLease.release();
      closeOpenClawStateDatabaseForPath({ env, path: pathname });
    };
  }
  const durableDb = (() => {
    try {
      if (!readOnly) {
        ensureDurableRuntimeSchema(db);
      }
      return getNodeSqliteKysely<DurableRuntimeDatabase>(db);
    } catch (err) {
      releaseDatabase();
      throw err;
    }
  })();
  let closed = false;

  const createWakeObligationRecord = (input: CreateWakeObligationInput): WakeObligation => {
    const { sourceOwner, sourceRef } = requireSourceRef(input, "Durable wake obligation");
    const parentRunId = optionalText(input.parentRunId);
    const parentSessionKey = optionalText(input.parentSessionKey);
    const targetRef = optionalText(input.targetRef);
    const reportRouteRef = optionalText(input.reportRouteRef);
    const targetResolutionStatus = input.targetResolutionStatus;
    const hasInspectableResolution =
      targetResolutionStatus === "ambiguous" ||
      targetResolutionStatus === "missing" ||
      targetResolutionStatus === "unauthorized" ||
      targetResolutionStatus === "inspect_only";
    if (
      !parentRunId &&
      !parentSessionKey &&
      !targetRef &&
      !reportRouteRef &&
      !hasInspectableResolution
    ) {
      throw new Error(
        "Durable wake requires a parent target, generalized target, report route, or inspect-only resolution",
      );
    }
    const dedupeKey = optionalText(input.dedupeKey);
    if (!dedupeKey) {
      throw new Error("Durable wake requires a dedupeKey");
    }
    const now = input.now ?? Date.now();
    const wakeId = input.wakeId ?? `wake_${randomUUID()}`;
    return runSqliteImmediateTransactionSync(db, () => {
      const existing = queryFirst<WakeObligationRow>(
        db,
        durableDb.selectFrom("wake_obligations").selectAll().where("dedupe_key", "=", dedupeKey),
      );
      if (existing) {
        return rowToWakeObligation(existing);
      }
      executeQuery(
        db,
        durableDb.insertInto("wake_obligations").values({
          wake_id: wakeId,
          source_owner: sourceOwner,
          source_ref: sourceRef,
          parent_run_id: parentRunId,
          parent_session_key: parentSessionKey,
          target_agent: optionalText(input.targetAgent),
          target_session: optionalText(input.targetSession),
          target_channel: optionalText(input.targetChannel),
          target_kind: optionalText(input.targetKind),
          target_ref: targetRef,
          owner_kind: optionalText(input.ownerKind),
          owner_ref: optionalText(input.ownerRef),
          report_route_ref: reportRouteRef,
          target_resolution_status: optionalText(input.targetResolutionStatus),
          target_resolution_reason: optionalText(input.targetResolutionReason),
          reason: input.reason,
          facts_ref: optionalText(input.factsRef),
          source_run_id: optionalText(input.sourceRunId),
          dedupe_key: dedupeKey,
          attempt_count: 0,
          last_attempt_at: null,
          acked_at: null,
          failed_reason: null,
          status: "pending",
          created_at: now,
          updated_at: now,
          metadata_json: serializeJson(input.metadata),
        }),
      );
      const row = queryFirst<WakeObligationRow>(
        db,
        durableDb.selectFrom("wake_obligations").selectAll().where("wake_id", "=", wakeId),
      );
      return rowToWakeObligation(row!);
    });
  };

  const updateWakeObligationRecord = (
    input: UpdateWakeObligationInput & {
      finalizeActiveClaim?: {
        attemptStatus: Extract<DeliveryAttemptEvidenceStatus, "handoff_accepted" | "superseded">;
        error?: string;
      };
    },
  ): WakeObligation | undefined => {
    const now = input.now ?? Date.now();
    return runSqliteImmediateTransactionSync(db, () => {
      const finalizeActiveClaim = () => {
        if (!input.finalizeActiveClaim) {
          return;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("delivery_attempt_evidence")
            .set({
              status: input.finalizeActiveClaim.attemptStatus,
              ...(input.finalizeActiveClaim.attemptStatus === "handoff_accepted"
                ? { handoff_accepted_at: now }
                : {}),
              ...(input.finalizeActiveClaim.error
                ? { error_message: input.finalizeActiveClaim.error }
                : {}),
              delivery_claimed_by: null,
              delivery_claim_expires_at: null,
              updated_at: now,
            })
            .where("wake_id", "=", input.wakeId)
            .where("delivery_claimed_by", "is not", null),
        );
        executeQuery(
          db,
          durableDb
            .deleteFrom("state_leases")
            .where("scope", "=", WAKE_OBLIGATION_LEASE_SCOPE)
            .where("lease_key", "=", input.wakeId),
        );
      };
      const current = queryFirst<WakeObligationRow>(
        db,
        durableDb.selectFrom("wake_obligations").selectAll().where("wake_id", "=", input.wakeId),
      );
      if (!current) {
        return undefined;
      }
      const nextAttemptCount = input.attemptCount ?? current.attempt_count;
      const nextLastAttemptAt =
        input.lastAttemptAt === undefined ? current.last_attempt_at : input.lastAttemptAt;
      const nextAckedAt = input.ackedAt === undefined ? current.acked_at : input.ackedAt;
      const nextFailedReason =
        input.failedReason === undefined
          ? current.failed_reason
          : optionalText(input.failedReason ?? undefined);
      const nextMetadataJson =
        input.metadata === undefined ? current.metadata_json : serializeJson(input.metadata);
      const nextFactsRef =
        input.factsRef === undefined ? current.facts_ref : optionalText(input.factsRef);
      if (isTerminalWakeStatus(current.status)) {
        const isNoOp =
          input.status === current.status &&
          isSameSqlValue(nextAttemptCount, current.attempt_count) &&
          isSameSqlValue(nextLastAttemptAt, current.last_attempt_at) &&
          isSameSqlValue(nextAckedAt, current.acked_at) &&
          isSameSqlValue(nextFailedReason, current.failed_reason) &&
          isSameSqlValue(nextFactsRef, current.facts_ref) &&
          isSameSqlValue(nextMetadataJson, current.metadata_json);
        if (!isNoOp) {
          return undefined;
        }
        finalizeActiveClaim();
        return rowToWakeObligation(current);
      }
      if (!isAllowedWakeStatusTransition(current.status, input.status)) {
        return undefined;
      }
      executeQuery(
        db,
        durableDb
          .updateTable("wake_obligations")
          .set({
            status: input.status,
            attempt_count: Number(nextAttemptCount),
            last_attempt_at: nextLastAttemptAt == null ? null : Number(nextLastAttemptAt),
            acked_at: nextAckedAt == null ? null : Number(nextAckedAt),
            failed_reason: nextFailedReason,
            facts_ref: nextFactsRef,
            updated_at: now,
            metadata_json: nextMetadataJson,
          })
          .where("wake_id", "=", input.wakeId),
      );
      finalizeActiveClaim();
      const row = queryFirst<WakeObligationRow>(
        db,
        durableDb.selectFrom("wake_obligations").selectAll().where("wake_id", "=", input.wakeId),
      );
      return rowToWakeObligation(row!);
    });
  };

  const updateWakeObligationProjectionRecord = (
    input: UpdateWakeObligationProjectionInput,
  ): WakeObligation | undefined => {
    const current = getWakeObligationRecord(input.wakeId);
    if (!current) {
      return undefined;
    }
    return updateWakeObligationRecord({
      wakeId: input.wakeId,
      status: current.status,
      metadata: input.metadata,
      factsRef: input.factsRef,
      now: input.now,
    });
  };

  const suspendWakeObligationRecord = (
    input: SuspendWakeObligationInput,
  ): WakeObligation | undefined => {
    const current = getWakeObligationRecord(input.wakeId);
    if (!current || isTerminalWakeStatus(current.status)) {
      return undefined;
    }
    return updateWakeObligationRecord({
      wakeId: input.wakeId,
      status: "suspended",
      failedReason: input.failedReason,
      metadata: input.metadata,
      now: input.now,
    });
  };

  const getWakeObligationRecord = (wakeId: string): WakeObligation | undefined => {
    const row = queryFirst<WakeObligationRow>(
      db,
      durableDb.selectFrom("wake_obligations").selectAll().where("wake_id", "=", wakeId),
    );
    return row ? rowToWakeObligation(row) : undefined;
  };

  const getWakeObligationByDedupeKeyRecord = (dedupeKey: string): WakeObligation | undefined => {
    const normalizedDedupeKey = dedupeKey.trim();
    if (!normalizedDedupeKey) {
      throw new Error("Wake obligation dedupe key is required");
    }
    const row = queryFirst<WakeObligationRow>(
      db,
      durableDb
        .selectFrom("wake_obligations")
        .selectAll()
        .where("dedupe_key", "=", normalizedDedupeKey),
    );
    return row ? rowToWakeObligation(row) : undefined;
  };

  const listWakeObligationRecords = (options?: {
    sourceOwner?: string;
    sourceRef?: string;
    parentRunId?: string;
    parentSessionKey?: string;
    targetKind?: WakeObligationTargetKind;
    targetRef?: string;
    ownerKind?: WakeObligationOwnerKind;
    ownerRef?: string;
    reportRouteRef?: string;
    targetResolutionStatus?: WakeObligationTargetResolutionStatus;
    status?: WakeObligationStatus;
    limit?: number;
  }): WakeObligation[] => {
    const sourceOwner = optionalText(options?.sourceOwner);
    const sourceRef = optionalText(options?.sourceRef);
    const parentRunId = optionalText(options?.parentRunId);
    const parentSessionKey = optionalText(options?.parentSessionKey);
    const targetRef = optionalText(options?.targetRef);
    const ownerRef = optionalText(options?.ownerRef);
    const reportRouteRef = optionalText(options?.reportRouteRef);
    const rows = queryRows<WakeObligationRow>(
      db,
      durableDb
        .selectFrom("wake_obligations")
        .selectAll()
        .$if(Boolean(sourceOwner), (qb) => qb.where("source_owner", "=", sourceOwner!))
        .$if(Boolean(sourceRef), (qb) => qb.where("source_ref", "=", sourceRef!))
        .$if(Boolean(parentRunId), (qb) => qb.where("parent_run_id", "=", parentRunId!))
        .$if(Boolean(parentSessionKey), (qb) =>
          qb.where("parent_session_key", "=", parentSessionKey!),
        )
        .$if(Boolean(options?.targetKind), (qb) =>
          qb.where("target_kind", "=", options!.targetKind!),
        )
        .$if(Boolean(targetRef), (qb) => qb.where("target_ref", "=", targetRef!))
        .$if(Boolean(options?.ownerKind), (qb) => qb.where("owner_kind", "=", options!.ownerKind!))
        .$if(Boolean(ownerRef), (qb) => qb.where("owner_ref", "=", ownerRef!))
        .$if(Boolean(reportRouteRef), (qb) => qb.where("report_route_ref", "=", reportRouteRef!))
        .$if(Boolean(options?.targetResolutionStatus), (qb) =>
          qb.where("target_resolution_status", "=", options!.targetResolutionStatus!),
        )
        .$if(Boolean(options?.status), (qb) => qb.where("status", "=", options!.status!))
        .orderBy("updated_at", "desc")
        .orderBy("wake_id", "desc")
        .limit(normalizeQueryLimit(options?.limit, 500)),
    );
    return rows.map(rowToWakeObligation);
  };

  const listWakeObligationsNeedingNoSilenceDiagnosticRecords = (input: {
    overdueBefore: number;
    slaMs: number;
    limit?: number;
  }): WakeObligation[] => {
    const rows = queryRows<WakeObligationRow>(
      db,
      durableDb
        .selectFrom("wake_obligations")
        .selectAll()
        .where("status", "not in", ["acked", "superseded"])
        .where("created_at", "<=", input.overdueBefore)
        .where((eb) =>
          eb.or([
            eb(noSilenceDiagnosticNumber(NO_SILENCE_DIAGNOSTIC_PATHS.overdue), "is not", 1),
            eb(noSilenceDiagnosticNumber(NO_SILENCE_DIAGNOSTIC_PATHS.slaMs), "is not", input.slaMs),
          ]),
        )
        .orderBy("created_at", "asc")
        .orderBy("wake_id", "asc")
        .limit(normalizeQueryLimit(input.limit, 500)),
    );
    return rows.map(rowToWakeObligation);
  };

  const storeListUncertaintyFacts = (options?: {
    sourceOwner?: string;
    sourceRef?: string;
    sourceRunId?: string;
    status?: UncertaintyFactStatus;
    limit?: number;
  }): UncertaintyFact[] => {
    const sourceOwner = optionalText(options?.sourceOwner);
    const sourceRef = optionalText(options?.sourceRef);
    const sourceRunId = optionalText(options?.sourceRunId);
    const rows = queryRows<UncertaintyFactRow>(
      db,
      durableDb
        .selectFrom("uncertainty_facts")
        .selectAll()
        .$if(Boolean(sourceOwner), (qb) => qb.where("source_owner", "=", sourceOwner!))
        .$if(Boolean(sourceRef), (qb) => qb.where("source_ref", "=", sourceRef!))
        .$if(Boolean(sourceRunId), (qb) => qb.where("source_run_id", "=", sourceRunId!))
        .$if(Boolean(options?.status), (qb) => qb.where("status", "=", options!.status!))
        .orderBy("updated_at", "desc")
        .orderBy("fact_id", "desc")
        .limit(normalizeQueryLimit(options?.limit, 500)),
    );
    return rows.map(rowToUncertaintyFact);
  };

  const acknowledgeWakeObligationRecord = (
    input: WakeObligationControlInput,
  ): WakeObligation | undefined => {
    const now = input.now ?? Date.now();
    const current = queryFirst<WakeObligationRow>(
      db,
      durableDb.selectFrom("wake_obligations").selectAll().where("wake_id", "=", input.wakeId),
    );
    if (!current) {
      return undefined;
    }
    if (!matchesExpectedWakeSourceRevision(current, input.expectedSourceRevision)) {
      return undefined;
    }
    if (current.status === "acked") {
      return updateWakeObligationRecord({
        wakeId: input.wakeId,
        status: "acked",
        finalizeActiveClaim: { attemptStatus: "handoff_accepted" },
        now,
      });
    }
    if (isTerminalWakeStatus(current.status)) {
      return undefined;
    }
    const decision = buildWakeControlDecision(input, "acknowledged", now);
    return updateWakeObligationRecord({
      wakeId: input.wakeId,
      status: "acked",
      ackedAt: now,
      metadata: mergeWakeControlMetadata(current.metadata_json, decision),
      finalizeActiveClaim: { attemptStatus: "handoff_accepted" },
      now,
    });
  };

  const supersedeWakeObligationRecord = (
    input: SupersedeWakeObligationInput,
  ): WakeObligation | undefined => {
    const now = input.now ?? Date.now();
    const current = queryFirst<WakeObligationRow>(
      db,
      durableDb.selectFrom("wake_obligations").selectAll().where("wake_id", "=", input.wakeId),
    );
    if (!current) {
      return undefined;
    }
    if (!matchesExpectedWakeSourceRevision(current, input.expectedSourceRevision)) {
      return undefined;
    }
    if (current.status === "superseded") {
      return updateWakeObligationRecord({
        wakeId: input.wakeId,
        status: "superseded",
        finalizeActiveClaim: {
          attemptStatus: "superseded",
          error: input.reason ?? "superseded",
        },
        now,
      });
    }
    if (isTerminalWakeStatus(current.status)) {
      return undefined;
    }
    const decision = buildWakeControlDecision(input, "superseded", now);
    return updateWakeObligationRecord({
      wakeId: input.wakeId,
      status: "superseded",
      failedReason: input.reason ?? "superseded",
      metadata: mergeWakeControlMetadata(
        current.metadata_json,
        decision,
        input.supersededByRef ? { supersededByRef: input.supersededByRef } : undefined,
      ),
      finalizeActiveClaim: {
        attemptStatus: "superseded",
        error: input.reason ?? "superseded",
      },
      now,
    });
  };

  const resumeWakeObligationRecord = (
    input: ResumeWakeObligationInput,
  ): WakeObligation | undefined => {
    const now = input.now ?? Date.now();
    const current = queryFirst<WakeObligationRow>(
      db,
      durableDb.selectFrom("wake_obligations").selectAll().where("wake_id", "=", input.wakeId),
    );
    if (!current) {
      return undefined;
    }
    if (!matchesExpectedWakeSourceRevision(current, input.expectedSourceRevision)) {
      return undefined;
    }
    if (current.status !== "suspended") {
      return isMatchingControlNoop(current, "resumed", input.idempotencyKey)
        ? rowToWakeObligation(current)
        : undefined;
    }
    const decision = buildWakeControlDecision(input, "resumed", now);
    return updateWakeObligationRecord({
      wakeId: input.wakeId,
      status: "pending",
      failedReason: null,
      metadata: mergeWakeControlMetadata(current.metadata_json, decision),
      now,
    });
  };

  const markWakeObligationDecisionRequiredRecord = (
    input: MarkWakeObligationDecisionRequiredInput,
  ): WakeObligation | undefined => {
    const now = input.now ?? Date.now();
    const current = queryFirst<WakeObligationRow>(
      db,
      durableDb.selectFrom("wake_obligations").selectAll().where("wake_id", "=", input.wakeId),
    );
    if (!current) {
      return undefined;
    }
    if (!matchesExpectedWakeSourceRevision(current, input.expectedSourceRevision)) {
      return undefined;
    }
    if (isTerminalWakeStatus(current.status)) {
      return isMatchingControlNoop(current, input.decisionKind, input.idempotencyKey)
        ? rowToWakeObligation(current)
        : undefined;
    }
    const decision = buildWakeControlDecision(input, input.decisionKind, now);
    return updateWakeObligationRecord({
      wakeId: input.wakeId,
      status: current.status,
      metadata: mergeWakeControlMetadata(current.metadata_json, decision),
      now,
    });
  };

  const getWakeObligationInspectionRecord = (
    wakeId: string,
  ): WakeObligationInspection | undefined => {
    const wake = getWakeObligationRecord(wakeId);
    if (!wake) {
      return undefined;
    }
    const metadata = wake.metadata ?? {};
    const diagnostics = isRecordValue(metadata.diagnostics) ? metadata.diagnostics : undefined;
    const evidence = isRecordValue(metadata.evidence) ? metadata.evidence : undefined;
    const unresolvedUncertaintyFacts = storeListUncertaintyFacts({
      sourceOwner: wake.sourceOwner,
      sourceRef: wake.sourceRef,
      status: "open",
    });
    return {
      wake,
      targetResolution: {
        ...(wake.targetResolutionStatus ? { status: wake.targetResolutionStatus } : {}),
        ...(wake.targetResolutionReason ? { reason: wake.targetResolutionReason } : {}),
        ...(wake.targetKind ? { targetKind: wake.targetKind } : {}),
        ...(wake.targetRef ? { targetRef: wake.targetRef } : {}),
        ...(wake.ownerKind ? { ownerKind: wake.ownerKind } : {}),
        ...(wake.ownerRef ? { ownerRef: wake.ownerRef } : {}),
        ...(wake.reportRouteRef ? { reportRouteRef: wake.reportRouteRef } : {}),
        ...(wake.factsRef ? { factsRef: wake.factsRef } : {}),
        ...(wake.sourceRunId ? { sourceRunId: wake.sourceRunId } : {}),
        ...(diagnostics ? { diagnostics } : {}),
        ...(evidence ? { evidence } : {}),
      },
      deliveryAttemptEvidence: listDeliveryAttemptEvidenceRecords({ wakeId }),
      unresolvedUncertaintyFacts,
      sourceRefs: {
        sourceOwner: wake.sourceOwner,
        sourceRef: wake.sourceRef,
        ...(wake.factsRef ? { factsRef: wake.factsRef } : {}),
        ...(wake.sourceRunId ? { sourceRunId: wake.sourceRunId } : {}),
        dedupeKey: wake.dedupeKey,
        ...(wake.parentRunId ? { parentRunId: wake.parentRunId } : {}),
        ...(wake.parentSessionKey ? { parentSessionKey: wake.parentSessionKey } : {}),
      },
    };
  };

  const claimNextWakeObligationRecord = (
    input: ClaimNextWakeObligationInput,
  ): WakeObligationClaim | undefined => {
    const now = input.now ?? Date.now();
    const claimExpiresAt = now + input.claimTtlMs;
    return runSqliteImmediateTransactionSync(db, () => {
      const candidates = queryRows<WakeObligationRow>(
        db,
        durableDb
          .selectFrom("wake_obligations")
          .selectAll()
          .where("status", "in", ["pending", "failed"])
          .orderBy("updated_at", "asc")
          .orderBy("wake_id", "asc")
          .limit(100),
      );
      for (const candidate of candidates) {
        const retryDelay = wakeRetryDelayMs({
          wakeId: candidate.wake_id,
          attemptCount: Number(candidate.attempt_count),
          retryBaseMs: input.retryBaseMs,
          retryMaxMs: input.retryMaxMs,
        });
        if (
          candidate.last_attempt_at !== null &&
          Number(candidate.last_attempt_at) + retryDelay > now
        ) {
          continue;
        }

        const ambiguousAttempt = queryFirst<DeliveryAttemptEvidenceRow>(
          db,
          durableDb
            .selectFrom("delivery_attempt_evidence")
            .selectAll()
            .where("wake_id", "=", candidate.wake_id)
            .where("status", "=", "attempted")
            .orderBy("scheduled_at", "desc")
            .limit(1),
        );
        if (
          ambiguousAttempt &&
          ambiguousAttempt.delivery_claim_expires_at !== null &&
          ambiguousAttempt.delivery_claim_expires_at <= now
        ) {
          executeQuery(
            db,
            durableDb
              .updateTable("delivery_attempt_evidence")
              .set({
                status: "unknown",
                error_message: "wake dispatch claim expired before durable completion evidence",
                unknown_at: now,
                delivery_claimed_by: null,
                delivery_claim_expires_at: null,
                updated_at: now,
              })
              .where("delivery_attempt_id", "=", ambiguousAttempt.delivery_attempt_id),
          );
          executeQuery(
            db,
            durableDb
              .updateTable("wake_obligations")
              .set({
                status: "suspended",
                failed_reason: "dispatch_outcome_unknown",
                updated_at: now,
              })
              .where("wake_id", "=", candidate.wake_id),
          );
          executeQuery(
            db,
            durableDb
              .deleteFrom("state_leases")
              .where("scope", "=", WAKE_OBLIGATION_LEASE_SCOPE)
              .where("lease_key", "=", candidate.wake_id),
          );
          executeQuery(
            db,
            durableDb
              .insertInto("uncertainty_facts")
              .values({
                fact_id: `uncertainty_${randomUUID()}`,
                source_owner: candidate.source_owner,
                source_ref: candidate.source_ref,
                kind: "delivery_unknown",
                source_run_id: candidate.source_run_id,
                step_id: null,
                event_id: null,
                ref_id: ambiguousAttempt.delivery_attempt_id,
                facts_ref: candidate.facts_ref,
                dedupe_key: `wake-dispatch-unknown:${ambiguousAttempt.delivery_attempt_id}`,
                facts_json: JSON.stringify({
                  wakeId: candidate.wake_id,
                  deliveryAttemptId: ambiguousAttempt.delivery_attempt_id,
                }),
                status: "open",
                resolution_kind: null,
                resolution_ref: null,
                resolved_at: null,
                created_at: now,
                updated_at: now,
                metadata_json: null,
              })
              .onConflict((conflict) => conflict.column("dedupe_key").doNothing()),
          );
          continue;
        }

        executeQuery(
          db,
          durableDb
            .deleteFrom("state_leases")
            .where("scope", "=", WAKE_OBLIGATION_LEASE_SCOPE)
            .where("lease_key", "=", candidate.wake_id)
            .where("expires_at", "<=", now),
        );
        const existingLease = queryFirst<{ owner: string }>(
          db,
          durableDb
            .selectFrom("state_leases")
            .select("owner")
            .where("scope", "=", WAKE_OBLIGATION_LEASE_SCOPE)
            .where("lease_key", "=", candidate.wake_id),
        );
        if (existingLease) {
          continue;
        }

        const claimToken = `wake_claim_${randomUUID()}`;
        const deliveryAttemptId = `wake_delivery_${randomUUID()}`;
        const attemptNumber = Number(candidate.attempt_count) + 1;
        executeQuery(
          db,
          durableDb.insertInto("state_leases").values({
            scope: WAKE_OBLIGATION_LEASE_SCOPE,
            lease_key: candidate.wake_id,
            owner: claimToken,
            expires_at: claimExpiresAt,
            heartbeat_at: now,
            payload_json: JSON.stringify({
              wakeId: candidate.wake_id,
              deliveryAttemptId,
              workerId: input.workerId,
            }),
            created_at: now,
            updated_at: now,
          }),
        );
        executeQuery(
          db,
          durableDb.insertInto("delivery_attempt_evidence").values({
            delivery_attempt_id: deliveryAttemptId,
            source_owner: candidate.source_owner,
            source_ref: candidate.source_ref,
            wake_id: candidate.wake_id,
            dedupe_key: `${candidate.wake_id}:dispatch:${attemptNumber}`,
            replay_pass_id: claimToken,
            target_kind: candidate.target_kind,
            target_ref: candidate.target_ref,
            route_kind: candidate.target_kind,
            route_ref: candidate.report_route_ref ?? candidate.target_ref,
            status: "attempted",
            evidence_json: JSON.stringify({ workerId: input.workerId }),
            error_message: null,
            scheduled_at: now,
            attempted_at: now,
            handoff_accepted_at: null,
            failed_at: null,
            unknown_at: null,
            delivery_claimed_by: claimToken,
            delivery_claim_expires_at: claimExpiresAt,
            created_at: now,
            updated_at: now,
            metadata_json: null,
          }),
        );
        executeQuery(
          db,
          durableDb
            .updateTable("wake_obligations")
            .set({ attempt_count: attemptNumber, last_attempt_at: now, updated_at: now })
            .where("wake_id", "=", candidate.wake_id),
        );
        const wake = queryFirst<WakeObligationRow>(
          db,
          durableDb
            .selectFrom("wake_obligations")
            .selectAll()
            .where("wake_id", "=", candidate.wake_id),
        );
        const attempt = queryFirst<DeliveryAttemptEvidenceRow>(
          db,
          durableDb
            .selectFrom("delivery_attempt_evidence")
            .selectAll()
            .where("delivery_attempt_id", "=", deliveryAttemptId),
        );
        return {
          wake: rowToWakeObligation(wake!),
          deliveryAttempt: rowToDeliveryAttemptEvidence(attempt!),
          claimToken,
          claimExpiresAt,
        };
      }
      return undefined;
    });
  };

  const completeWakeObligationClaimRecord = (
    input: CompleteWakeObligationClaimInput,
  ): DeliveryAttemptEvidence | undefined => {
    const now = input.now ?? Date.now();
    const validPair =
      (input.attemptStatus === "handoff_accepted" &&
        (input.wakeStatus === "handoff_accepted" || input.wakeStatus === "acked")) ||
      (input.attemptStatus === "failed" &&
        (input.wakeStatus === "failed" || input.wakeStatus === "suspended")) ||
      (input.attemptStatus === "unknown" && input.wakeStatus === "suspended") ||
      (input.attemptStatus === "superseded" && input.wakeStatus === "superseded");
    if (!validPair) {
      return undefined;
    }
    return runSqliteImmediateTransactionSync(db, () => {
      const lease = queryFirst<{ expires_at: number | bigint | null }>(
        db,
        durableDb
          .selectFrom("state_leases")
          .select("expires_at")
          .where("scope", "=", WAKE_OBLIGATION_LEASE_SCOPE)
          .where("lease_key", "=", input.wakeId)
          .where("owner", "=", input.claimToken),
      );
      if (!lease || lease.expires_at === null || Number(lease.expires_at) <= now) {
        return undefined;
      }
      const current = queryFirst<DeliveryAttemptEvidenceRow>(
        db,
        durableDb
          .selectFrom("delivery_attempt_evidence")
          .selectAll()
          .where("delivery_attempt_id", "=", input.deliveryAttemptId)
          .where("wake_id", "=", input.wakeId)
          .where("delivery_claimed_by", "=", input.claimToken),
      );
      const wake = queryFirst<WakeObligationRow>(
        db,
        durableDb.selectFrom("wake_obligations").selectAll().where("wake_id", "=", input.wakeId),
      );
      if (!current || !wake || isTerminalWakeStatus(wake.status)) {
        return undefined;
      }
      if (!isAllowedWakeStatusTransition(wake.status, input.wakeStatus)) {
        return undefined;
      }
      executeQuery(
        db,
        durableDb
          .updateTable("delivery_attempt_evidence")
          .set({
            status: input.attemptStatus,
            evidence_json: serializeJson(input.evidence),
            error_message: optionalText(input.error),
            handoff_accepted_at: input.attemptStatus === "handoff_accepted" ? now : null,
            failed_at: input.attemptStatus === "failed" ? now : null,
            unknown_at: input.attemptStatus === "unknown" ? now : null,
            delivery_claimed_by: null,
            delivery_claim_expires_at: null,
            updated_at: now,
          })
          .where("delivery_attempt_id", "=", input.deliveryAttemptId),
      );
      executeQuery(
        db,
        durableDb
          .updateTable("wake_obligations")
          .set({
            status: input.wakeStatus,
            acked_at: input.wakeStatus === "acked" ? now : null,
            failed_reason:
              input.wakeStatus === "failed" || input.wakeStatus === "suspended"
                ? optionalText(input.error)
                : null,
            updated_at: now,
          })
          .where("wake_id", "=", input.wakeId),
      );
      executeQuery(
        db,
        durableDb
          .deleteFrom("state_leases")
          .where("scope", "=", WAKE_OBLIGATION_LEASE_SCOPE)
          .where("lease_key", "=", input.wakeId)
          .where("owner", "=", input.claimToken),
      );
      if (input.attemptStatus === "unknown") {
        executeQuery(
          db,
          durableDb
            .insertInto("uncertainty_facts")
            .values({
              fact_id: `uncertainty_${randomUUID()}`,
              source_owner: wake.source_owner,
              source_ref: wake.source_ref,
              kind: "delivery_unknown",
              source_run_id: wake.source_run_id,
              step_id: null,
              event_id: null,
              ref_id: input.deliveryAttemptId,
              facts_ref: wake.facts_ref,
              dedupe_key: `wake-dispatch-unknown:${input.deliveryAttemptId}`,
              facts_json: serializeJson(input.evidence),
              status: "open",
              resolution_kind: null,
              resolution_ref: null,
              resolved_at: null,
              created_at: now,
              updated_at: now,
              metadata_json: null,
            })
            .onConflict((conflict) => conflict.column("dedupe_key").doNothing()),
        );
      }
      const row = queryFirst<DeliveryAttemptEvidenceRow>(
        db,
        durableDb
          .selectFrom("delivery_attempt_evidence")
          .selectAll()
          .where("delivery_attempt_id", "=", input.deliveryAttemptId),
      );
      return row ? rowToDeliveryAttemptEvidence(row) : undefined;
    });
  };

  const renewWakeObligationClaimRecord = (input: RenewWakeObligationClaimInput): boolean => {
    const now = input.now ?? Date.now();
    const claimExpiresAt = now + input.claimTtlMs;
    return runSqliteImmediateTransactionSync(db, () => {
      const lease = queryFirst<{ expires_at: number | bigint | null }>(
        db,
        durableDb
          .selectFrom("state_leases")
          .select("expires_at")
          .where("scope", "=", WAKE_OBLIGATION_LEASE_SCOPE)
          .where("lease_key", "=", input.wakeId)
          .where("owner", "=", input.claimToken),
      );
      const attempt = queryFirst<{
        delivery_claim_expires_at: number | bigint | null;
      }>(
        db,
        durableDb
          .selectFrom("delivery_attempt_evidence")
          .select("delivery_claim_expires_at")
          .where("delivery_attempt_id", "=", input.deliveryAttemptId)
          .where("wake_id", "=", input.wakeId)
          .where("status", "=", "attempted")
          .where("delivery_claimed_by", "=", input.claimToken),
      );
      if (
        !lease ||
        lease.expires_at === null ||
        Number(lease.expires_at) <= now ||
        !attempt ||
        attempt.delivery_claim_expires_at === null ||
        Number(attempt.delivery_claim_expires_at) <= now
      ) {
        return false;
      }
      const renewedLease = executeQuery(
        db,
        durableDb
          .updateTable("state_leases")
          .set({ expires_at: claimExpiresAt, heartbeat_at: now, updated_at: now })
          .where("scope", "=", WAKE_OBLIGATION_LEASE_SCOPE)
          .where("lease_key", "=", input.wakeId)
          .where("owner", "=", input.claimToken),
      );
      const renewedAttempt = executeQuery(
        db,
        durableDb
          .updateTable("delivery_attempt_evidence")
          .set({ delivery_claim_expires_at: claimExpiresAt, updated_at: now })
          .where("delivery_attempt_id", "=", input.deliveryAttemptId)
          .where("wake_id", "=", input.wakeId)
          .where("status", "=", "attempted")
          .where("delivery_claimed_by", "=", input.claimToken),
      );
      return renewedLease === 1 && renewedAttempt === 1;
    });
  };

  const getDeliveryAttemptEvidenceRecord = (
    deliveryAttemptId: string,
  ): DeliveryAttemptEvidence | undefined => {
    const row = queryFirst<DeliveryAttemptEvidenceRow>(
      db,
      durableDb
        .selectFrom("delivery_attempt_evidence")
        .selectAll()
        .where("delivery_attempt_id", "=", deliveryAttemptId),
    );
    return row ? rowToDeliveryAttemptEvidence(row) : undefined;
  };

  const listDeliveryAttemptEvidenceRecords = (options?: {
    wakeId?: string;
    dedupeKey?: string;
    status?: DeliveryAttemptEvidenceStatus;
    limit?: number;
  }): DeliveryAttemptEvidence[] => {
    const wakeId = optionalText(options?.wakeId);
    const dedupeKey = optionalText(options?.dedupeKey);
    const rows = queryRows<DeliveryAttemptEvidenceRow>(
      db,
      durableDb
        .selectFrom("delivery_attempt_evidence")
        .selectAll()
        .$if(Boolean(wakeId), (qb) => qb.where("wake_id", "=", wakeId!))
        .$if(Boolean(dedupeKey), (qb) => qb.where("dedupe_key", "=", dedupeKey!))
        .$if(Boolean(options?.status), (qb) => qb.where("status", "=", options!.status!))
        .orderBy("scheduled_at", "desc")
        .orderBy("delivery_attempt_id", "desc")
        .limit(normalizeQueryLimit(options?.limit, 500)),
    );
    return rows.map(rowToDeliveryAttemptEvidence);
  };

  return {
    withTransaction<T>(operation: () => T): T {
      return runSqliteImmediateTransactionSync(db, operation);
    },

    createRun(input: CreateDurableRuntimeRunInput): DurableRuntimeRun {
      const sourceOwner = optionalText(input.sourceOwner);
      const sourceRef = optionalText(input.sourceRef);
      const rootOperationReason = optionalText(input.rootOperationReason);
      if ((sourceOwner && !sourceRef) || (!sourceOwner && sourceRef)) {
        throw new Error(
          "Durable execution record sourceOwner and sourceRef must be provided together",
        );
      }
      if (sourceOwner && sourceRef && rootOperationReason) {
        throw new Error(
          "Durable execution record must use sourceOwner/sourceRef or rootOperationReason, not both",
        );
      }
      if ((!sourceOwner || !sourceRef) && !rootOperationReason) {
        throw new Error(
          "Durable execution record requires sourceOwner/sourceRef or rootOperationReason",
        );
      }
      const now = input.now ?? Date.now();
      const runtimeRunId = input.runtimeRunId ?? `run_${randomUUID()}`;
      const operationVersion = input.operationVersion ?? "1";
      const status = input.status ?? "received";
      const recoveryState = input.recoveryState ?? "runnable";
      const metadata = {
        ...input.metadata,
        ...(rootOperationReason ? { rootOperationReason } : {}),
      };
      return runSqliteImmediateTransactionSync(db, () => {
        const existing =
          input.idempotencyKey &&
          queryFirst<DurableRuntimeRunRow>(
            db,
            durableDb
              .selectFrom("durable_execution_records")
              .selectAll()
              .where("operation_kind", "=", input.operationKind)
              .where("idempotency_key", "=", input.idempotencyKey),
          );
        if (existing) {
          if (
            input.requestHash &&
            existing.request_hash &&
            existing.request_hash !== input.requestHash
          ) {
            throw new Error(
              `Durable runtime idempotency key conflict for ${input.operationKind}:${input.idempotencyKey}`,
            );
          }
          return rowToRun(existing);
        }
        executeQuery(
          db,
          durableDb.insertInto("durable_execution_records").values({
            runtime_run_id: runtimeRunId,
            operation_kind: input.operationKind,
            operation_version: operationVersion,
            idempotency_key: optionalText(input.idempotencyKey),
            request_hash: optionalText(input.requestHash),
            status,
            source_owner: sourceOwner,
            source_ref: sourceRef,
            input_ref: optionalText(input.inputRef),
            created_at: now,
            updated_at: now,
            completed_at: input.completedAt ?? null,
            recovery_state: recoveryState,
            checkpoint_ref: optionalText(input.checkpointRef),
            parent_runtime_run_id: optionalText(input.parentRuntimeRunId),
            parent_step_id: optionalText(input.parentStepId),
            message_id: optionalText(input.messageId),
            turn_id: optionalText(input.turnId),
            work_unit_id: optionalText(input.workUnitId),
            report_route_id: optionalText(input.reportRouteId),
            heartbeat_at: null,
            metadata_json: serializeJson(metadata),
          }),
        );
        const row = queryFirst<DurableRuntimeRunRow>(
          db,
          durableDb
            .selectFrom("durable_execution_records")
            .selectAll()
            .where("runtime_run_id", "=", runtimeRunId),
        );
        return rowToRun(row!);
      });
    },

    getRun(runtimeRunId: string): DurableRuntimeRun | undefined {
      const row = queryFirst<DurableRuntimeRunRow>(
        db,
        durableDb
          .selectFrom("durable_execution_records")
          .selectAll()
          .where("runtime_run_id", "=", runtimeRunId),
      );
      return row ? rowToRun(row) : undefined;
    },

    getRunByIdempotencyKey(
      operationKind: string,
      idempotencyKey: string,
    ): DurableRuntimeRun | undefined {
      const row = queryFirst<DurableRuntimeRunRow>(
        db,
        durableDb
          .selectFrom("durable_execution_records")
          .selectAll()
          .where("operation_kind", "=", operationKind)
          .where("idempotency_key", "=", idempotencyKey),
      );
      return row ? rowToRun(row) : undefined;
    },

    updateRun(input: UpdateDurableRuntimeRunInput): DurableRuntimeRun | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<DurableRuntimeRunRow>(
          db,
          durableDb
            .selectFrom("durable_execution_records")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
        if (!current) {
          return undefined;
        }
        const completedAt =
          input.completedAt === undefined
            ? current.completed_at
            : input.completedAt === null
              ? null
              : input.completedAt;
        const nextStatus = input.status ?? current.status;
        const nextRecoveryState = input.recoveryState ?? current.recovery_state;
        const nextCheckpointRef =
          input.checkpointRef === undefined
            ? current.checkpoint_ref
            : optionalText(input.checkpointRef ?? undefined);
        const nextWorkUnitId =
          input.workUnitId === undefined
            ? current.work_unit_id
            : optionalText(input.workUnitId ?? undefined);
        const nextReportRouteId =
          input.reportRouteId === undefined
            ? current.report_route_id
            : optionalText(input.reportRouteId ?? undefined);
        const nextHeartbeatAt =
          input.heartbeatAt === undefined ? current.heartbeat_at : input.heartbeatAt;
        const nextMetadataJson =
          input.metadata === undefined ? current.metadata_json : serializeJson(input.metadata);
        if (isTerminalRunRow(current)) {
          const isNoOp =
            nextStatus === current.status &&
            nextRecoveryState === current.recovery_state &&
            isSameSqlValue(completedAt, current.completed_at) &&
            isSameSqlValue(nextCheckpointRef, current.checkpoint_ref) &&
            isSameSqlValue(nextWorkUnitId, current.work_unit_id) &&
            isSameSqlValue(nextReportRouteId, current.report_route_id) &&
            isSameSqlValue(nextHeartbeatAt, current.heartbeat_at) &&
            isSameSqlValue(nextMetadataJson, current.metadata_json);
          return isNoOp ? rowToRun(current) : undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_execution_records")
            .set({
              status: nextStatus,
              recovery_state: nextRecoveryState,
              updated_at: now,
              completed_at: completedAt,
              checkpoint_ref: nextCheckpointRef,
              work_unit_id: nextWorkUnitId,
              report_route_id: nextReportRouteId,
              heartbeat_at: nextHeartbeatAt,
              metadata_json: nextMetadataJson,
            })
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
        const row = queryFirst<DurableRuntimeRunRow>(
          db,
          durableDb
            .selectFrom("durable_execution_records")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
        return rowToRun(row!);
      });
    },

    appendEvent(input: AppendDurableRuntimeEventInput): DurableRuntimeEvent {
      const now = input.eventTime ?? Date.now();
      const recordedAt = Date.now();
      const eventId = input.eventId ?? `evt_${randomUUID()}`;
      return runSqliteImmediateTransactionSync(db, () => {
        const existingById = input.eventId
          ? queryFirst<DurableRuntimeEventRow>(
              db,
              durableDb
                .selectFrom("durable_event_evidence")
                .selectAll()
                .where("event_id", "=", input.eventId),
            )
          : undefined;
        if (existingById) {
          assertCompatibleEventReplay(existingById, input, `event id ${input.eventId}`);
          return rowToEvent(existingById);
        }
        const existingByIdempotency = input.idempotencyKey
          ? queryFirst<DurableRuntimeEventRow>(
              db,
              durableDb
                .selectFrom("durable_event_evidence")
                .selectAll()
                .where("runtime_run_id", "=", input.runtimeRunId)
                .where("event_type", "=", input.eventType)
                .where("idempotency_key", "=", input.idempotencyKey),
            )
          : undefined;
        if (existingByIdempotency) {
          assertCompatibleEventReplay(
            existingByIdempotency,
            input,
            `idempotency key ${input.runtimeRunId}:${input.eventType}:${input.idempotencyKey}`,
          );
          return rowToEvent(existingByIdempotency);
        }
        const latestEvent = queryFirst<Pick<DurableRuntimeEventRow, "event_seq">>(
          db,
          durableDb
            .selectFrom("durable_event_evidence")
            .select("event_seq")
            .where("runtime_run_id", "=", input.runtimeRunId)
            .orderBy("event_seq", "desc")
            .limit(1),
        );
        const nextSeq = (latestEvent?.event_seq ?? 0) + 1;
        executeQuery(
          db,
          durableDb.insertInto("durable_event_evidence").values({
            event_id: eventId,
            runtime_run_id: input.runtimeRunId,
            event_seq: nextSeq,
            event_type: input.eventType,
            event_time: now,
            step_id: optionalText(input.stepId),
            agent_invocation_id: optionalText(input.agentInvocationId),
            tool_invocation_id: optionalText(input.toolInvocationId),
            idempotency_key: optionalText(input.idempotencyKey),
            payload_json: serializeJson(input.payload),
            payload_hash: optionalText(input.payloadHash),
            checkpoint_ref: optionalText(input.checkpointRef),
            causation_event_id: optionalText(input.causationEventId),
            correlation_id: optionalText(input.correlationId),
            recorded_at: recordedAt,
          }),
        );
        executeQuery(
          db,
          durableDb
            .updateTable("durable_execution_records")
            .set({ updated_at: recordedAt })
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
        const row = queryFirst<DurableRuntimeEventRow>(
          db,
          durableDb
            .selectFrom("durable_event_evidence")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("event_seq", "=", nextSeq),
        );
        return rowToEvent(row!);
      });
    },

    listRuns(options?: { limit?: number }): DurableRuntimeRun[] {
      const limit = Math.max(1, Math.min(500, Math.trunc(options?.limit ?? 50)));
      const rows = queryRows<DurableRuntimeRunRow>(
        db,
        durableDb
          .selectFrom("durable_execution_records")
          .selectAll()
          .orderBy("updated_at", "desc")
          .orderBy("runtime_run_id", "desc")
          .limit(limit),
      );
      return rows.map(rowToRun);
    },

    listOpenRuns(options?: { operationKind?: string; limit?: number }): DurableRuntimeRun[] {
      const limit = Math.max(1, Math.min(5000, Math.trunc(options?.limit ?? 500)));
      const operationKind = optionalText(options?.operationKind);
      const query = durableDb
        .selectFrom("durable_execution_records")
        .selectAll()
        .where("status", "not in", ["succeeded", "failed", "cancelled", "lost"])
        .$if(Boolean(operationKind), (qb) => qb.where("operation_kind", "=", operationKind!))
        .orderBy("updated_at", "asc")
        .orderBy("runtime_run_id", "asc")
        .limit(limit);
      return queryRows<DurableRuntimeRunRow>(db, query).map(rowToRun);
    },

    createStep(input: CreateDurableRuntimeStepInput): DurableRuntimeStep {
      const now = input.now ?? Date.now();
      const stepId = input.stepId ?? `step_${randomUUID()}`;
      const status = input.status ?? "pending";
      const recoveryState = input.recoveryState ?? "runnable";
      const attempt = input.attempt ?? 1;
      return runSqliteImmediateTransactionSync(db, () => {
        const existing =
          input.idempotencyKey &&
          queryFirst<DurableRuntimeStepRow>(
            db,
            durableDb
              .selectFrom("durable_execution_steps")
              .selectAll()
              .where("runtime_run_id", "=", input.runtimeRunId)
              .where("idempotency_key", "=", input.idempotencyKey),
          );
        if (existing) {
          return rowToStep(existing);
        }
        executeQuery(
          db,
          durableDb.insertInto("durable_execution_steps").values({
            runtime_run_id: input.runtimeRunId,
            step_id: stepId,
            parent_step_id: optionalText(input.parentStepId),
            step_type: input.stepType,
            status,
            recovery_state: recoveryState,
            attempt,
            max_attempts: input.maxAttempts ?? null,
            idempotency_key: optionalText(input.idempotencyKey),
            input_ref: optionalText(input.inputRef),
            output_ref: optionalText(input.outputRef),
            error_ref: optionalText(input.errorRef),
            checkpoint_ref: optionalText(input.checkpointRef),
            claimed_by: null,
            claim_expires_at: null,
            heartbeat_at: null,
            created_at: now,
            started_at: status === "running" ? now : null,
            updated_at: now,
            completed_at: null,
            metadata_json: serializeJson(input.metadata),
          }),
        );
        const row = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_execution_steps")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", stepId),
        );
        return rowToStep(row!);
      });
    },

    updateStep(input: UpdateDurableRuntimeStepInput): DurableRuntimeStep | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_execution_steps")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId),
        );
        if (!current) {
          return undefined;
        }
        const expectedClaimedBy = optionalText(input.expectedClaimedBy);
        const nextStatus = input.status ?? current.status;
        const nextRecoveryState = input.recoveryState ?? current.recovery_state;
        const nextAttempt = input.attempt ?? current.attempt;
        const nextMaxAttempts =
          input.maxAttempts === undefined ? current.max_attempts : input.maxAttempts;
        const nextInputRef =
          input.inputRef === undefined
            ? current.input_ref
            : optionalText(input.inputRef ?? undefined);
        const nextOutputRef =
          input.outputRef === undefined
            ? current.output_ref
            : optionalText(input.outputRef ?? undefined);
        const nextErrorRef =
          input.errorRef === undefined
            ? current.error_ref
            : optionalText(input.errorRef ?? undefined);
        const nextCheckpointRef =
          input.checkpointRef === undefined
            ? current.checkpoint_ref
            : optionalText(input.checkpointRef ?? undefined);
        const nextClaimedBy =
          input.claimedBy === undefined
            ? current.claimed_by
            : optionalText(input.claimedBy ?? undefined);
        const nextClaimExpiresAt =
          input.claimExpiresAt === undefined ? current.claim_expires_at : input.claimExpiresAt;
        const nextHeartbeatAt =
          input.heartbeatAt === undefined ? current.heartbeat_at : input.heartbeatAt;
        const nextStartedAt =
          input.startedAt === undefined
            ? current.started_at
            : input.startedAt === null
              ? null
              : input.startedAt;
        const nextCompletedAt =
          input.completedAt === undefined
            ? current.completed_at
            : input.completedAt === null
              ? null
              : input.completedAt;
        const nextMetadataJson =
          input.metadata === undefined ? current.metadata_json : serializeJson(input.metadata);
        if (nextClaimedBy !== null && nextClaimedBy !== current.claimed_by) {
          return undefined;
        }
        if (
          !expectedClaimedBy &&
          ((input.claimExpiresAt != null && input.claimExpiresAt !== current.claim_expires_at) ||
            (input.heartbeatAt != null && input.heartbeatAt !== current.heartbeat_at))
        ) {
          return undefined;
        }
        if (isTerminalStepRow(current) && !input.allowTerminalReopen) {
          if (expectedClaimedBy && current.claimed_by !== expectedClaimedBy) {
            return undefined;
          }
          const isNoOp =
            nextStatus === current.status &&
            nextRecoveryState === current.recovery_state &&
            isSameSqlValue(nextAttempt, current.attempt) &&
            isSameSqlValue(nextMaxAttempts, current.max_attempts) &&
            isSameSqlValue(nextInputRef, current.input_ref) &&
            isSameSqlValue(nextOutputRef, current.output_ref) &&
            isSameSqlValue(nextErrorRef, current.error_ref) &&
            isSameSqlValue(nextCheckpointRef, current.checkpoint_ref) &&
            isSameSqlValue(nextClaimedBy, current.claimed_by) &&
            isSameSqlValue(nextClaimExpiresAt, current.claim_expires_at) &&
            isSameSqlValue(nextHeartbeatAt, current.heartbeat_at) &&
            isSameSqlValue(nextStartedAt, current.started_at) &&
            isSameSqlValue(nextCompletedAt, current.completed_at) &&
            isSameSqlValue(nextMetadataJson, current.metadata_json);
          return isNoOp ? rowToStep(current) : undefined;
        }
        if (expectedClaimedBy && current.claimed_by !== expectedClaimedBy) {
          return undefined;
        }
        if (expectedClaimedBy) {
          const lease = queryFirst<{ expires_at: number | bigint | null }>(
            db,
            durableDb
              .selectFrom("state_leases")
              .select("expires_at")
              .where("scope", "=", DURABLE_STEP_LEASE_SCOPE)
              .where("lease_key", "=", durableStepLeaseKey(input.runtimeRunId, input.stepId))
              .where("owner", "=", expectedClaimedBy),
          );
          if (!lease || lease.expires_at === null || Number(lease.expires_at) <= now) {
            return undefined;
          }
        }
        if (expectedClaimedBy && nextClaimedBy === null) {
          executeQuery(
            db,
            durableDb
              .deleteFrom("state_leases")
              .where("scope", "=", DURABLE_STEP_LEASE_SCOPE)
              .where("lease_key", "=", durableStepLeaseKey(input.runtimeRunId, input.stepId))
              .where("owner", "=", expectedClaimedBy),
          );
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_execution_steps")
            .set({
              status: nextStatus,
              recovery_state: nextRecoveryState,
              attempt: nextAttempt,
              max_attempts: nextMaxAttempts,
              input_ref: nextInputRef,
              output_ref: nextOutputRef,
              error_ref: nextErrorRef,
              checkpoint_ref: nextCheckpointRef,
              claimed_by: nextClaimedBy,
              claim_expires_at: nextClaimExpiresAt,
              heartbeat_at: nextHeartbeatAt,
              started_at: nextStartedAt,
              completed_at: nextCompletedAt,
              updated_at: now,
              metadata_json: nextMetadataJson,
            })
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId),
        );
        const row = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_execution_steps")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId),
        );
        return rowToStep(row!);
      });
    },

    claimNextRunnableStep(input: ClaimDurableRuntimeStepInput): DurableRuntimeStep | undefined {
      const now = input.now ?? Date.now();
      const claimExpiresAt = now + input.claimTtlMs;
      return runSqliteImmediateTransactionSync(db, () => {
        const operationKind = optionalText(input.operationKind);
        const row = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_execution_steps as s")
            .innerJoin("durable_execution_records as r", "r.runtime_run_id", "s.runtime_run_id")
            .selectAll("s")
            .where("s.status", "in", ["pending", "queued"])
            .where("s.recovery_state", "in", ["runnable", "claimed"])
            .where((eb) =>
              eb.or([
                eb("s.claimed_by", "is", null),
                eb("s.claim_expires_at", "is", null),
                eb("s.claim_expires_at", "<=", now),
              ]),
            )
            .where("r.status", "not in", ["succeeded", "failed", "cancelled", "lost"])
            .$if(Boolean(operationKind), (qb) => qb.where("r.operation_kind", "=", operationKind!))
            .$if(Boolean(input.stepType), (qb) => qb.where("s.step_type", "=", input.stepType!))
            .orderBy("s.updated_at", "asc")
            .orderBy("s.runtime_run_id", "asc")
            .orderBy("s.step_id", "asc")
            .limit(1),
        );
        if (!row) {
          return undefined;
        }
        const leaseKey = durableStepLeaseKey(row.runtime_run_id, row.step_id);
        executeQuery(
          db,
          durableDb
            .deleteFrom("state_leases")
            .where("scope", "=", DURABLE_STEP_LEASE_SCOPE)
            .where("lease_key", "=", leaseKey)
            .where("expires_at", "<=", now),
        );
        const existingLease = queryFirst<{ owner: string }>(
          db,
          durableDb
            .selectFrom("state_leases")
            .select("owner")
            .where("scope", "=", DURABLE_STEP_LEASE_SCOPE)
            .where("lease_key", "=", leaseKey),
        );
        if (existingLease) {
          return undefined;
        }
        const claimToken = `claim_${randomUUID()}`;
        executeQuery(
          db,
          durableDb.insertInto("state_leases").values({
            scope: DURABLE_STEP_LEASE_SCOPE,
            lease_key: leaseKey,
            owner: claimToken,
            expires_at: claimExpiresAt,
            heartbeat_at: now,
            payload_json: JSON.stringify({
              runtimeRunId: row.runtime_run_id,
              stepId: row.step_id,
              workerId: input.workerId,
            }),
            created_at: now,
            updated_at: now,
          }),
        );
        executeQuery(
          db,
          durableDb
            .updateTable("durable_execution_steps")
            .set({
              status: "queued",
              recovery_state: "claimed",
              claimed_by: claimToken,
              claim_expires_at: claimExpiresAt,
              heartbeat_at: now,
              updated_at: now,
            })
            .where("runtime_run_id", "=", row.runtime_run_id)
            .where("step_id", "=", row.step_id),
        );
        const claimed = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_execution_steps")
            .selectAll()
            .where("runtime_run_id", "=", row.runtime_run_id)
            .where("step_id", "=", row.step_id),
        );
        return rowToStep(claimed!);
      });
    },

    renewStepClaim(input: {
      runtimeRunId: string;
      stepId: string;
      workerId: string;
      claimTtlMs: number;
      now?: number;
    }): DurableRuntimeStep | undefined {
      const now = input.now ?? Date.now();
      const claimExpiresAt = now + input.claimTtlMs;
      return runSqliteImmediateTransactionSync(db, () => {
        const renewed = executeQuery(
          db,
          durableDb
            .updateTable("state_leases")
            .set({
              expires_at: claimExpiresAt,
              heartbeat_at: now,
              updated_at: now,
            })
            .where("scope", "=", DURABLE_STEP_LEASE_SCOPE)
            .where("lease_key", "=", durableStepLeaseKey(input.runtimeRunId, input.stepId))
            .where("owner", "=", input.workerId)
            .where("expires_at", ">", now),
        );
        if (renewed !== 1) {
          return undefined;
        }
        const updated = executeQuery(
          db,
          durableDb
            .updateTable("durable_execution_steps")
            .set({
              claim_expires_at: claimExpiresAt,
              heartbeat_at: now,
              updated_at: now,
            })
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId)
            .where("claimed_by", "=", input.workerId)
            .where("status", "not in", ["succeeded", "failed", "cancelled", "lost", "skipped"]),
        );
        if (updated !== 1) {
          return undefined;
        }
        const row = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_execution_steps")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId),
        );
        return row ? rowToStep(row) : undefined;
      });
    },

    releaseStepClaim(input: {
      runtimeRunId: string;
      stepId: string;
      workerId: string;
      now?: number;
    }): DurableRuntimeStep | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_execution_steps")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId)
            .where("claimed_by", "=", input.workerId)
            .where("status", "not in", ["succeeded", "failed", "cancelled", "lost", "skipped"])
            .where("recovery_state", "!=", "terminal")
            .where("completed_at", "is", null),
        );
        if (!current) {
          return undefined;
        }
        executeQuery(
          db,
          durableDb
            .deleteFrom("state_leases")
            .where("scope", "=", DURABLE_STEP_LEASE_SCOPE)
            .where("lease_key", "=", durableStepLeaseKey(input.runtimeRunId, input.stepId))
            .where("owner", "=", input.workerId),
        );
        executeQuery(
          db,
          durableDb
            .updateTable("durable_execution_steps")
            .set({
              status: current.status === "running" ? "queued" : current.status,
              recovery_state: "runnable",
              claimed_by: null,
              claim_expires_at: null,
              heartbeat_at: null,
              updated_at: now,
            })
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId),
        );
        const row = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_execution_steps")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId),
        );
        return row ? rowToStep(row) : undefined;
      });
    },

    listSteps(runtimeRunId: string): DurableRuntimeStep[] {
      const rows = queryRows<DurableRuntimeStepRow>(
        db,
        durableDb
          .selectFrom("durable_execution_steps")
          .selectAll()
          .where("runtime_run_id", "=", runtimeRunId)
          .orderBy("created_at", "asc")
          .orderBy("step_id", "asc"),
      );
      return rows.map(rowToStep);
    },

    createRef(input: CreateDurableRuntimeRefInput): DurableRuntimeRef {
      const now = input.now ?? Date.now();
      const refId = input.refId ?? `ref_${randomUUID()}`;
      executeQuery(
        db,
        durableDb.insertInto("durable_payload_refs").values({
          ref_id: refId,
          runtime_run_id: input.runtimeRunId,
          step_id: optionalText(input.stepId),
          ref_kind: input.refKind,
          media_type: optionalText(input.mediaType),
          hash: optionalText(input.hash),
          storage_kind: input.storageKind ?? "external",
          storage_uri: optionalText(input.storageUri),
          created_at: now,
          metadata_json: serializeJson(input.metadata),
        }),
      );
      const row = queryFirst<DurableRuntimeRefRow>(
        db,
        durableDb.selectFrom("durable_payload_refs").selectAll().where("ref_id", "=", refId),
      );
      return rowToRef(row!);
    },

    getRef(refId: string): DurableRuntimeRef | undefined {
      const row = queryFirst<DurableRuntimeRefRow>(
        db,
        durableDb.selectFrom("durable_payload_refs").selectAll().where("ref_id", "=", refId),
      );
      return row ? rowToRef(row) : undefined;
    },

    listRefs(runtimeRunId: string): DurableRuntimeRef[] {
      const rows = queryRows<DurableRuntimeRefRow>(
        db,
        durableDb
          .selectFrom("durable_payload_refs")
          .selectAll()
          .where("runtime_run_id", "=", runtimeRunId)
          .orderBy("created_at", "asc")
          .orderBy("ref_id", "asc"),
      );
      return rows.map(rowToRef);
    },

    createLink(input: CreateDurableRuntimeLinkInput): DurableRuntimeLink {
      const now = input.now ?? Date.now();
      executeQuery(
        db,
        durableDb.insertInto("durable_run_correlations").values({
          parent_runtime_run_id: input.parentRuntimeRunId,
          parent_step_id: input.parentStepId,
          child_runtime_run_id: input.childRuntimeRunId,
          link_type: input.linkType,
          status: input.status ?? "pending",
          created_at: now,
          updated_at: now,
          metadata_json: serializeJson(input.metadata),
        }),
      );
      const row = queryFirst<DurableRuntimeLinkRow>(
        db,
        durableDb
          .selectFrom("durable_run_correlations")
          .selectAll()
          .where("parent_runtime_run_id", "=", input.parentRuntimeRunId)
          .where("parent_step_id", "=", input.parentStepId)
          .where("child_runtime_run_id", "=", input.childRuntimeRunId),
      );
      return rowToLink(row!);
    },

    updateLink(input: UpdateDurableRuntimeLinkInput): DurableRuntimeLink | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<DurableRuntimeLinkRow>(
          db,
          durableDb
            .selectFrom("durable_run_correlations")
            .selectAll()
            .where("parent_runtime_run_id", "=", input.parentRuntimeRunId)
            .where("parent_step_id", "=", input.parentStepId)
            .where("child_runtime_run_id", "=", input.childRuntimeRunId),
        );
        if (!current) {
          return undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_run_correlations")
            .set({
              status: input.status ?? current.status,
              updated_at: now,
              metadata_json:
                input.metadata === undefined
                  ? current.metadata_json
                  : serializeJson(input.metadata),
            })
            .where("parent_runtime_run_id", "=", input.parentRuntimeRunId)
            .where("parent_step_id", "=", input.parentStepId)
            .where("child_runtime_run_id", "=", input.childRuntimeRunId),
        );
        const row = queryFirst<DurableRuntimeLinkRow>(
          db,
          durableDb
            .selectFrom("durable_run_correlations")
            .selectAll()
            .where("parent_runtime_run_id", "=", input.parentRuntimeRunId)
            .where("parent_step_id", "=", input.parentStepId)
            .where("child_runtime_run_id", "=", input.childRuntimeRunId),
        );
        return rowToLink(row!);
      });
    },

    listChildLinks(parentRuntimeRunId: string): DurableRuntimeLink[] {
      const rows = queryRows<DurableRuntimeLinkRow>(
        db,
        durableDb
          .selectFrom("durable_run_correlations")
          .selectAll()
          .where("parent_runtime_run_id", "=", parentRuntimeRunId)
          .orderBy("created_at", "asc")
          .orderBy("child_runtime_run_id", "asc"),
      );
      return rows.map(rowToLink);
    },

    listParentLinks(childRuntimeRunId: string): DurableRuntimeLink[] {
      const rows = queryRows<DurableRuntimeLinkRow>(
        db,
        durableDb
          .selectFrom("durable_run_correlations")
          .selectAll()
          .where("child_runtime_run_id", "=", childRuntimeRunId)
          .orderBy("created_at", "asc")
          .orderBy("parent_runtime_run_id", "asc")
          .orderBy("parent_step_id", "asc"),
      );
      return rows.map(rowToLink);
    },

    createTimer(input: CreateDurableRuntimeTimerInput): DurableRuntimeTimer {
      const now = input.now ?? Date.now();
      const timerId = input.timerId ?? `timer_${randomUUID()}`;
      executeQuery(
        db,
        durableDb.insertInto("durable_timer_obligations").values({
          timer_id: timerId,
          runtime_run_id: input.runtimeRunId,
          step_id: optionalText(input.stepId),
          timer_type: input.timerType,
          due_at: input.dueAt,
          status: "pending",
          created_at: now,
          fired_at: null,
          cancelled_at: null,
          metadata_json: serializeJson(input.metadata),
        }),
      );
      const row = queryFirst<DurableRuntimeTimerRow>(
        db,
        durableDb
          .selectFrom("durable_timer_obligations")
          .selectAll()
          .where("timer_id", "=", timerId),
      );
      return rowToTimer(row!);
    },

    updateTimer(input: UpdateDurableRuntimeTimerInput): DurableRuntimeTimer | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<DurableRuntimeTimerRow>(
          db,
          durableDb
            .selectFrom("durable_timer_obligations")
            .selectAll()
            .where("timer_id", "=", input.timerId),
        );
        if (!current) {
          return undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_timer_obligations")
            .set({
              status: input.status,
              fired_at:
                input.firedAt === undefined
                  ? input.status === "fired"
                    ? now
                    : current.fired_at
                  : input.firedAt,
              cancelled_at:
                input.cancelledAt === undefined
                  ? input.status === "cancelled"
                    ? now
                    : current.cancelled_at
                  : input.cancelledAt,
            })
            .where("timer_id", "=", input.timerId),
        );
        const row = queryFirst<DurableRuntimeTimerRow>(
          db,
          durableDb
            .selectFrom("durable_timer_obligations")
            .selectAll()
            .where("timer_id", "=", input.timerId),
        );
        return rowToTimer(row!);
      });
    },

    listTimers(runtimeRunId?: string): DurableRuntimeTimer[] {
      const rows = queryRows<DurableRuntimeTimerRow>(
        db,
        durableDb
          .selectFrom("durable_timer_obligations")
          .selectAll()
          .$if(Boolean(runtimeRunId), (qb) => qb.where("runtime_run_id", "=", runtimeRunId!))
          .orderBy("due_at", "asc")
          .orderBy("timer_id", "asc"),
      );
      return rows.map(rowToTimer);
    },

    listDueTimers(now: number, options?: { limit?: number }): DurableRuntimeTimer[] {
      const limit = Math.max(1, Math.min(5000, Math.trunc(options?.limit ?? 500)));
      const rows = queryRows<DurableRuntimeTimerRow>(
        db,
        durableDb
          .selectFrom("durable_timer_obligations")
          .selectAll()
          .where("status", "=", "pending")
          .where("due_at", "<=", now)
          .orderBy("due_at", "asc")
          .orderBy("timer_id", "asc")
          .limit(limit),
      );
      return rows.map(rowToTimer);
    },

    createSignal(input: CreateDurableRuntimeSignalInput): DurableRuntimeSignal {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const existing =
          input.idempotencyKey &&
          queryFirst<DurableRuntimeSignalRow>(
            db,
            durableDb
              .selectFrom("durable_signal_evidence")
              .selectAll()
              .where("runtime_run_id", "=", input.runtimeRunId)
              .where("idempotency_key", "=", input.idempotencyKey),
          );
        if (existing) {
          return rowToSignal(existing);
        }
        const signalId = input.signalId ?? `sig_${randomUUID()}`;
        executeQuery(
          db,
          durableDb.insertInto("durable_signal_evidence").values({
            signal_id: signalId,
            runtime_run_id: input.runtimeRunId,
            step_id: optionalText(input.stepId),
            signal_type: input.signalType,
            idempotency_key: optionalText(input.idempotencyKey),
            payload_ref: optionalText(input.payloadRef),
            correlation_id: optionalText(input.correlationId),
            received_at: now,
            consumed_at: null,
            metadata_json: serializeJson(input.metadata),
          }),
        );
        const row = queryFirst<DurableRuntimeSignalRow>(
          db,
          durableDb
            .selectFrom("durable_signal_evidence")
            .selectAll()
            .where("signal_id", "=", signalId),
        );
        return rowToSignal(row!);
      });
    },

    consumeSignal(input: { signalId: string; now?: number }): DurableRuntimeSignal | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<DurableRuntimeSignalRow>(
          db,
          durableDb
            .selectFrom("durable_signal_evidence")
            .selectAll()
            .where("signal_id", "=", input.signalId),
        );
        if (!current) {
          return undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_signal_evidence")
            .set({ consumed_at: current.consumed_at ?? now })
            .where("signal_id", "=", input.signalId),
        );
        const row = queryFirst<DurableRuntimeSignalRow>(
          db,
          durableDb
            .selectFrom("durable_signal_evidence")
            .selectAll()
            .where("signal_id", "=", input.signalId),
        );
        return row ? rowToSignal(row) : undefined;
      });
    },

    listPendingSignals(options?: { limit?: number }): DurableRuntimeSignal[] {
      const limit = Math.max(1, Math.min(5000, Math.trunc(options?.limit ?? 500)));
      const rows = queryRows<DurableRuntimeSignalRow>(
        db,
        durableDb
          .selectFrom("durable_signal_evidence")
          .selectAll()
          .where("consumed_at", "is", null)
          .orderBy("received_at", "asc")
          .orderBy("signal_id", "asc")
          .limit(limit),
      );
      return rows.map(rowToSignal);
    },

    listSignals(runtimeRunId: string): DurableRuntimeSignal[] {
      const rows = queryRows<DurableRuntimeSignalRow>(
        db,
        durableDb
          .selectFrom("durable_signal_evidence")
          .selectAll()
          .where("runtime_run_id", "=", runtimeRunId)
          .orderBy("received_at", "asc")
          .orderBy("signal_id", "asc"),
      );
      return rows.map(rowToSignal);
    },

    createWakeObligation(input: CreateWakeObligationInput): WakeObligation {
      return createWakeObligationRecord(input);
    },

    updateWakeObligationProjection(
      input: UpdateWakeObligationProjectionInput,
    ): WakeObligation | undefined {
      return updateWakeObligationProjectionRecord(input);
    },

    suspendWakeObligation(input: SuspendWakeObligationInput): WakeObligation | undefined {
      return suspendWakeObligationRecord(input);
    },

    acknowledgeWakeObligation(input: WakeObligationControlInput): WakeObligation | undefined {
      return acknowledgeWakeObligationRecord(input);
    },

    supersedeWakeObligation(input: SupersedeWakeObligationInput): WakeObligation | undefined {
      return supersedeWakeObligationRecord(input);
    },

    resumeWakeObligation(input: ResumeWakeObligationInput): WakeObligation | undefined {
      return resumeWakeObligationRecord(input);
    },

    markWakeObligationDecisionRequired(
      input: MarkWakeObligationDecisionRequiredInput,
    ): WakeObligation | undefined {
      return markWakeObligationDecisionRequiredRecord(input);
    },

    getWakeObligation(wakeId: string): WakeObligation | undefined {
      return getWakeObligationRecord(wakeId);
    },

    getWakeObligationByDedupeKey(dedupeKey: string): WakeObligation | undefined {
      return getWakeObligationByDedupeKeyRecord(dedupeKey);
    },

    getWakeObligationInspection(wakeId: string): WakeObligationInspection | undefined {
      return getWakeObligationInspectionRecord(wakeId);
    },

    listWakeObligations(options?: {
      sourceOwner?: string;
      sourceRef?: string;
      parentRunId?: string;
      parentSessionKey?: string;
      targetKind?: WakeObligationTargetKind;
      targetRef?: string;
      ownerKind?: WakeObligationOwnerKind;
      ownerRef?: string;
      reportRouteRef?: string;
      targetResolutionStatus?: WakeObligationTargetResolutionStatus;
      status?: WakeObligationStatus;
      limit?: number;
    }): WakeObligation[] {
      return listWakeObligationRecords(options);
    },

    listWakeObligationsNeedingNoSilenceDiagnostic(input: {
      overdueBefore: number;
      slaMs: number;
      limit?: number;
    }): WakeObligation[] {
      return listWakeObligationsNeedingNoSilenceDiagnosticRecords(input);
    },

    recordUncertaintyFact(input: CreateUncertaintyFactInput): UncertaintyFact {
      const { sourceOwner, sourceRef } = requireSourceRef(input, "Durable uncertainty fact");
      const now = input.now ?? Date.now();
      const factId = input.factId ?? `uncertain_${randomUUID()}`;
      const dedupeKey = optionalText(input.dedupeKey);
      return runSqliteImmediateTransactionSync(db, () => {
        const existing =
          dedupeKey &&
          queryFirst<UncertaintyFactRow>(
            db,
            durableDb
              .selectFrom("uncertainty_facts")
              .selectAll()
              .where("dedupe_key", "=", dedupeKey),
          );
        if (existing) {
          return rowToUncertaintyFact(existing);
        }
        executeQuery(
          db,
          durableDb.insertInto("uncertainty_facts").values({
            fact_id: factId,
            source_owner: sourceOwner,
            source_ref: sourceRef,
            kind: input.kind,
            source_run_id: optionalText(input.sourceRunId),
            step_id: optionalText(input.stepId),
            event_id: optionalText(input.eventId),
            ref_id: optionalText(input.refId),
            facts_ref: optionalText(input.factsRef),
            dedupe_key: dedupeKey,
            facts_json: serializeJson(input.facts),
            status: "open",
            resolution_kind: null,
            resolution_ref: null,
            resolved_at: null,
            created_at: now,
            updated_at: now,
            metadata_json: serializeJson(input.metadata),
          }),
        );
        const row = queryFirst<UncertaintyFactRow>(
          db,
          durableDb.selectFrom("uncertainty_facts").selectAll().where("fact_id", "=", factId),
        );
        return rowToUncertaintyFact(row!);
      });
    },

    resolveUncertaintyFact(input: ResolveUncertaintyFactInput): UncertaintyFact | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<UncertaintyFactRow>(
          db,
          durableDb.selectFrom("uncertainty_facts").selectAll().where("fact_id", "=", input.factId),
        );
        if (!current) {
          return undefined;
        }
        if (
          input.expectedUpdatedAt !== undefined &&
          Number(current.updated_at) !== input.expectedUpdatedAt
        ) {
          return undefined;
        }
        if (current.status !== "open") {
          const isNoOp =
            input.status === current.status &&
            isSameSqlValue(optionalText(input.resolutionKind), current.resolution_kind) &&
            isSameSqlValue(optionalText(input.resolutionRef), current.resolution_ref) &&
            isSameSqlValue(
              input.metadata === undefined ? current.metadata_json : serializeJson(input.metadata),
              current.metadata_json,
            );
          return isNoOp ? rowToUncertaintyFact(current) : undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("uncertainty_facts")
            .set({
              status: input.status,
              resolution_kind: optionalText(input.resolutionKind),
              resolution_ref: optionalText(input.resolutionRef),
              resolved_at: now,
              updated_at: now,
              metadata_json:
                input.metadata === undefined
                  ? current.metadata_json
                  : serializeJson(input.metadata),
            })
            .where("fact_id", "=", input.factId),
        );
        const row = queryFirst<UncertaintyFactRow>(
          db,
          durableDb.selectFrom("uncertainty_facts").selectAll().where("fact_id", "=", input.factId),
        );
        return rowToUncertaintyFact(row!);
      });
    },

    listUncertaintyFacts(options?: {
      sourceOwner?: string;
      sourceRef?: string;
      sourceRunId?: string;
      status?: UncertaintyFactStatus;
      limit?: number;
    }): UncertaintyFact[] {
      return storeListUncertaintyFacts(options);
    },

    claimNextWakeObligation(input: ClaimNextWakeObligationInput): WakeObligationClaim | undefined {
      return claimNextWakeObligationRecord(input);
    },

    renewWakeObligationClaim(input: RenewWakeObligationClaimInput): boolean {
      return renewWakeObligationClaimRecord(input);
    },

    completeWakeObligationClaim(
      input: CompleteWakeObligationClaimInput,
    ): DeliveryAttemptEvidence | undefined {
      return completeWakeObligationClaimRecord(input);
    },

    getDeliveryAttemptEvidence(deliveryAttemptId: string): DeliveryAttemptEvidence | undefined {
      return getDeliveryAttemptEvidenceRecord(deliveryAttemptId);
    },

    listDeliveryAttemptEvidence(options?: {
      wakeId?: string;
      dedupeKey?: string;
      status?: DeliveryAttemptEvidenceStatus;
      limit?: number;
    }): DeliveryAttemptEvidence[] {
      return listDeliveryAttemptEvidenceRecords(options);
    },

    listPendingWakeObligations(options?: { limit?: number }): WakeObligation[] {
      return listWakeObligationRecords({ status: "pending", limit: options?.limit });
    },

    listUnresolvedUncertaintyFacts(options?: {
      sourceRunId?: string;
      limit?: number;
    }): UncertaintyFact[] {
      return storeListUncertaintyFacts({
        sourceRunId: options?.sourceRunId,
        status: "open",
        limit: options?.limit,
      });
    },

    listUnresolvedObligations(options?: {
      now?: number;
      limit?: number;
    }): DurableUnresolvedObligation[] {
      const now = options?.now ?? Date.now();
      const limit = normalizeQueryLimit(options?.limit, 500);
      const wakeRows = queryRows<WakeObligationRow>(
        db,
        durableDb
          .selectFrom("wake_obligations")
          .selectAll()
          .where("status", "in", ["pending", "handoff_accepted", "failed"])
          .orderBy("updated_at", "desc")
          .orderBy("wake_id", "desc")
          .limit(limit),
      ).map(
        (row): DurableUnresolvedObligationRow => ({
          obligation_id: `wake:${row.wake_id}`,
          source_owner: row.source_owner,
          source_ref: row.source_ref,
          kind: "pending_wake",
          runtime_run_id: row.source_run_id,
          step_id: null,
          wake_id: row.wake_id,
          uncertainty_fact_id: null,
          subject_ref: row.facts_ref ?? row.dedupe_key,
          reason: row.reason,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
          metadata_json: row.metadata_json,
        }),
      );
      const uncertaintyRows = queryRows<UncertaintyFactRow>(
        db,
        durableDb
          .selectFrom("uncertainty_facts")
          .selectAll()
          .where("status", "=", "open")
          .orderBy("updated_at", "desc")
          .orderBy("fact_id", "desc")
          .limit(limit),
      ).map(
        (row): DurableUnresolvedObligationRow => ({
          obligation_id: `uncertainty:${row.fact_id}`,
          source_owner: row.source_owner,
          source_ref: row.source_ref,
          kind: "unresolved_uncertainty",
          runtime_run_id: row.source_run_id,
          step_id: row.step_id,
          wake_id: null,
          uncertainty_fact_id: row.fact_id,
          subject_ref: row.facts_ref ?? row.ref_id ?? row.event_id ?? row.dedupe_key,
          reason: row.kind,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
          metadata_json: row.metadata_json,
        }),
      );
      const childRows = queryRows<DurableRuntimeLinkRow>(
        db,
        durableDb
          .selectFrom("durable_run_correlations")
          .selectAll()
          .where("status", "in", ["pending", "running"])
          .orderBy("updated_at", "desc")
          .orderBy("child_runtime_run_id", "desc")
          .limit(limit),
      ).map(
        (row): DurableUnresolvedObligationRow => ({
          obligation_id: `child:${row.parent_runtime_run_id}:${row.parent_step_id}:${row.child_runtime_run_id}`,
          source_owner: "durable_run_correlations",
          source_ref: `${row.parent_runtime_run_id}:${row.parent_step_id}:${row.child_runtime_run_id}`,
          kind: "open_child",
          runtime_run_id: row.parent_runtime_run_id,
          step_id: row.parent_step_id,
          wake_id: null,
          uncertainty_fact_id: null,
          subject_ref: row.child_runtime_run_id,
          reason: row.link_type,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
          metadata_json: row.metadata_json,
        }),
      );
      const pendingSubagentDeliveryRows = queryRows<PendingSubagentDeliveryRow>(
        db,
        durableDb
          .selectFrom("subagent_runs")
          .select([
            "run_id",
            "requester_session_key",
            "pending_final_delivery_created_at",
            "pending_final_delivery_last_attempt_at",
            "pending_final_delivery_attempt_count",
            "pending_final_delivery_last_error",
            "created_at",
          ])
          .where("pending_final_delivery", "=", 1)
          .orderBy("pending_final_delivery_last_attempt_at", "desc")
          .orderBy("run_id", "desc")
          .limit(limit),
      ).map(
        (row): DurableUnresolvedObligationRow => ({
          obligation_id: `subagent-delivery:${row.run_id}`,
          source_owner: "subagent_runs",
          source_ref: row.run_id,
          kind: "pending_subagent_delivery",
          runtime_run_id: null,
          step_id: null,
          wake_id: null,
          uncertainty_fact_id: null,
          subject_ref: row.requester_session_key,
          reason: row.pending_final_delivery_last_error ?? "pending_final_delivery",
          status: "pending",
          created_at: row.pending_final_delivery_created_at ?? row.created_at,
          updated_at:
            row.pending_final_delivery_last_attempt_at ??
            row.pending_final_delivery_created_at ??
            row.created_at,
          metadata_json: JSON.stringify({
            attemptCount: row.pending_final_delivery_attempt_count ?? 0,
          }),
        }),
      );
      const pendingDeliveryQueueRows = queryRows<PendingDeliveryQueueRow>(
        db,
        durableDb
          .selectFrom("delivery_queue_entries")
          .select([
            "queue_name",
            "id",
            "status",
            "session_key",
            "channel",
            "target",
            "retry_count",
            "last_attempt_at",
            "last_error",
            "recovery_state",
            "enqueued_at",
            "updated_at",
          ])
          .where("status", "in", ["pending", "failed"])
          .orderBy("updated_at", "desc")
          .orderBy("queue_name", "asc")
          .orderBy("id", "asc")
          .limit(limit),
      ).map(
        (row): DurableUnresolvedObligationRow => ({
          obligation_id: `delivery-queue:${row.queue_name}:${row.id}`,
          source_owner: "delivery_queue_entries",
          source_ref: `${row.queue_name}:${row.id}`,
          kind: "pending_delivery_queue",
          runtime_run_id: null,
          step_id: null,
          wake_id: null,
          uncertainty_fact_id: null,
          subject_ref: row.session_key ?? row.target,
          reason: row.last_error ?? row.recovery_state ?? "delivery_queued",
          status: row.status,
          created_at: row.enqueued_at,
          updated_at: row.updated_at,
          metadata_json: JSON.stringify({
            channel: row.channel,
            target: row.target,
            retryCount: Number(row.retry_count),
            lastAttemptAt: row.last_attempt_at,
          }),
        }),
      );
      const expiredStateLeaseRows = queryRows<ExpiredStateLeaseRow>(
        db,
        durableDb
          .selectFrom("state_leases")
          .selectAll()
          .where("scope", "=", DURABLE_STEP_LEASE_SCOPE)
          .where("expires_at", "is not", null)
          .where("expires_at", "<=", now)
          .orderBy("updated_at", "desc")
          .orderBy("scope", "asc")
          .orderBy("lease_key", "asc")
          .limit(limit),
      ).map((row): DurableUnresolvedObligationRow => {
        const payload = parseJsonRecord(row.payload_json);
        const runtimeRunId =
          typeof payload?.runtimeRunId === "string" ? payload.runtimeRunId : null;
        const stepId = typeof payload?.stepId === "string" ? payload.stepId : null;
        return {
          obligation_id: `state-lease:${row.scope}:${row.lease_key}`,
          source_owner: "state_leases",
          source_ref: `${row.scope}:${row.lease_key}`,
          kind: "expired_state_lease",
          runtime_run_id: runtimeRunId,
          step_id: stepId,
          wake_id: null,
          uncertainty_fact_id: null,
          subject_ref: row.owner,
          reason: "lease_expired",
          status: "expired",
          created_at: row.created_at,
          updated_at: row.updated_at,
          metadata_json: JSON.stringify({
            expiresAt: row.expires_at,
            heartbeatAt: row.heartbeat_at,
          }),
        };
      });
      return [
        ...wakeRows,
        ...uncertaintyRows,
        ...childRows,
        ...pendingSubagentDeliveryRows,
        ...pendingDeliveryQueueRows,
        ...expiredStateLeaseRows,
      ]
        .toSorted((left, right) => {
          const updated = Number(right.updated_at) - Number(left.updated_at);
          return updated === 0 ? right.obligation_id.localeCompare(left.obligation_id) : updated;
        })
        .slice(0, limit)
        .map(rowToUnresolvedObligation);
    },

    getTimeline(
      runtimeRunId: string,
      timelineOptions?: DurableRuntimeTimelineOptions,
    ): DurableRuntimeEvent[] {
      const afterEventSeq = Math.max(0, Math.trunc(timelineOptions?.afterEventSeq ?? 0));
      const shouldLimit = timelineOptions?.limit !== undefined || afterEventSeq !== 0;
      const rows = queryRows<DurableRuntimeEventRow>(
        db,
        durableDb
          .selectFrom("durable_event_evidence")
          .selectAll()
          .where("runtime_run_id", "=", runtimeRunId)
          .$if(afterEventSeq !== 0, (qb) => qb.where("event_seq", ">", afterEventSeq))
          .orderBy("event_seq", "asc")
          .$if(shouldLimit, (qb) => qb.limit(normalizeQueryLimit(timelineOptions?.limit, 500))),
      );
      return rows.map(rowToEvent);
    },

    compactTerminalRun(input: CompactDurableRuntimeRunInput): CompactDurableRuntimeRunResult {
      const keepLastEvents = normalizeQueryLimit(input.keepLastEvents, 200);
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const run = queryFirst<DurableRuntimeRunRow>(
          db,
          durableDb
            .selectFrom("durable_execution_records")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
        if (!run || !isTerminalRunStatus(run.status)) {
          return {
            runtimeRunId: input.runtimeRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const totalEvents = count(
          db,
          durableDb
            .selectFrom("durable_event_evidence")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
        if (totalEvents <= keepLastEvents) {
          return {
            runtimeRunId: input.runtimeRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const cutoff = queryFirst<{ event_seq: number | bigint }>(
          db,
          durableDb
            .selectFrom("durable_event_evidence")
            .select("event_seq")
            .where("runtime_run_id", "=", input.runtimeRunId)
            .orderBy("event_seq", "desc")
            .limit(1)
            .offset(keepLastEvents - 1),
        );
        const cutoffSeq = Number(cutoff?.event_seq ?? 0);
        if (cutoffSeq <= 1) {
          return {
            runtimeRunId: input.runtimeRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const removedEvents = executeQuery(
          db,
          durableDb
            .deleteFrom("durable_event_evidence")
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("event_seq", "<", cutoffSeq),
        );
        if (removedEvents <= 0) {
          return {
            runtimeRunId: input.runtimeRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const nextSeq =
          (queryFirst<Pick<DurableRuntimeEventRow, "event_seq">>(
            db,
            durableDb
              .selectFrom("durable_event_evidence")
              .select("event_seq")
              .where("runtime_run_id", "=", input.runtimeRunId)
              .orderBy("event_seq", "desc")
              .limit(1),
          )?.event_seq ?? 0) + 1;
        executeQuery(
          db,
          durableDb.insertInto("durable_event_evidence").values({
            event_id: `evt_${randomUUID()}`,
            runtime_run_id: input.runtimeRunId,
            event_seq: nextSeq,
            event_type: "runtime.history.compacted",
            event_time: now,
            step_id: null,
            agent_invocation_id: null,
            tool_invocation_id: null,
            idempotency_key: null,
            payload_json: serializeJson({
              removedEvents,
              keptLastEvents: keepLastEvents,
              compactedBeforeEventSeq: cutoffSeq,
            }),
            payload_hash: null,
            checkpoint_ref: null,
            causation_event_id: null,
            correlation_id: null,
            recorded_at: now,
          }),
        );
        return {
          runtimeRunId: input.runtimeRunId,
          compacted: true,
          removedEvents,
        };
      });
    },

    getStats(): DurableRuntimeStoreStats {
      return {
        path: pathname,
        runs: count(
          db,
          durableDb
            .selectFrom("durable_execution_records")
            .select((eb) => eb.fn.countAll<number>().as("count")),
        ),
        events: count(
          db,
          durableDb
            .selectFrom("durable_event_evidence")
            .select((eb) => eb.fn.countAll<number>().as("count")),
        ),
        steps: count(
          db,
          durableDb
            .selectFrom("durable_execution_steps")
            .select((eb) => eb.fn.countAll<number>().as("count")),
        ),
        openRuns: count(
          db,
          durableDb
            .selectFrom("durable_execution_records")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("status", "not in", ["succeeded", "failed", "cancelled", "lost"]),
        ),
        pendingWakes: count(
          db,
          durableDb
            .selectFrom("wake_obligations")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("status", "in", ["pending", "handoff_accepted", "failed"]),
        ),
        unresolvedUncertaintyFacts: count(
          db,
          durableDb
            .selectFrom("uncertainty_facts")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("status", "=", "open"),
        ),
      };
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      releaseDatabase();
    },
  };
}
