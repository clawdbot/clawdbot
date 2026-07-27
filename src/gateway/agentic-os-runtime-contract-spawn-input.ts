import { normalizeSubagentTaskName } from "../agents/subagent-task-name.js";
import {
  ALLOW_LEASE_OWNER_FIELDS,
  ContractInputError,
  FORBIDDEN_SPAWN_CAMEL_ALIASES,
  SESSION_METADATA_FIELDS,
  assertNoForbiddenAliases,
  isRecord,
  readString,
  stableJson,
  type LeaseRecord,
} from "./agentic-os-runtime-contract-shared.js";
import { taskDigest } from "./agentic-os-runtime-contract-task-state.js";

function rejectConflict(message: string): never {
  throw new ContractInputError(message);
}

function readSessionMetadata(params: Record<string, unknown>): Record<string, unknown> {
  const metadata = params.metadata;
  if (!isRecord(metadata)) {
    throw new ContractInputError("missing required object: metadata");
  }
  const keys = Object.keys(metadata).toSorted();
  const expected = [...SESSION_METADATA_FIELDS].toSorted();
  if (stableJson(keys) !== stableJson(expected)) {
    throw new ContractInputError("metadata must contain exactly the Agentic OS session v1 fields");
  }
  return Object.fromEntries(
    SESSION_METADATA_FIELDS.map((field) => [field, readString(metadata, field)]),
  );
}

export function parseAgenticOsSpawnInput(params: Record<string, unknown>) {
  assertNoForbiddenAliases(params, FORBIDDEN_SPAWN_CAMEL_ALIASES);
  const clientRequestId = readString(params, "client_request_id");
  const idempotencyKey = readString(params, "idempotency_key");
  const gatewayLeaseId = readString(params, "gateway_lease_id");
  const task = readString(params, "task");
  const runtime = readString(params, "runtime");
  if (runtime !== "subagent") {
    return rejectConflict("unsupported sessions_spawn runtime");
  }
  const metadata = readSessionMetadata(params);
  if (
    metadata.client_request_id !== clientRequestId ||
    metadata.idempotency_key !== idempotencyKey
  ) {
    return rejectConflict("session metadata identity does not match spawn identity");
  }
  if (metadata.task_digest !== taskDigest(task)) {
    return rejectConflict("session metadata task_digest does not match spawn task");
  }
  const agentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? params.agentId.trim()
      : String(metadata.agent_id);
  if (agentId !== metadata.agent_id) {
    return rejectConflict("spawn agentId does not match session metadata agent_id");
  }
  const taskNameResult = normalizeSubagentTaskName(params.taskName);
  if (taskNameResult.error) {
    return rejectConflict(taskNameResult.error);
  }
  const taskName = taskNameResult.taskName;
  if (Object.hasOwn(params, "mode") && params.mode !== "run") {
    return rejectConflict("invalid enum: mode");
  }
  const mode = "run" as const;
  const cleanup: "delete" | "keep" | undefined =
    params.cleanup === "delete" || params.cleanup === "keep" ? params.cleanup : undefined;
  if (Object.hasOwn(params, "cleanup") && cleanup === undefined) {
    return rejectConflict("invalid enum: cleanup");
  }
  const context: "fork" | "isolated" | undefined =
    params.context === "fork" || params.context === "isolated" ? params.context : undefined;
  if (Object.hasOwn(params, "context") && context === undefined) {
    return rejectConflict("invalid enum: context");
  }
  if (Object.hasOwn(params, "lightContext") && typeof params.lightContext !== "boolean") {
    return rejectConflict("invalid boolean: lightContext");
  }
  const lightContext = params.lightContext === true;
  const fingerprint = stableJson({
    client_request_id: clientRequestId,
    idempotency_key: idempotencyKey,
    gateway_lease_id: gatewayLeaseId,
    task,
    taskName,
    runtime,
    mode,
    cleanup,
    context,
    lightContext,
    agentId,
    metadata,
  });
  return {
    clientRequestId,
    idempotencyKey,
    gatewayLeaseId,
    task,
    taskName,
    runtime,
    mode,
    cleanup,
    context,
    lightContext,
    agentId,
    metadata,
    fingerprint,
  };
}

export function requireLeaseAuthorizesSpawn(params: {
  lease: LeaseRecord;
  metadata: Record<string, unknown>;
  agentId: string;
}): void {
  const expected: Record<(typeof ALLOW_LEASE_OWNER_FIELDS)[number], unknown> = {
    client_lease_id: params.lease.spawnOwner.client_lease_id,
    run_id: params.metadata.run_id,
    phase: params.metadata.phase,
    transition_id: params.metadata.transition_id,
    agent_id: params.agentId,
    requester_agent_id: params.lease.spawnOwner.requester_agent_id,
  };
  for (const field of ALLOW_LEASE_OWNER_FIELDS) {
    if (params.lease.spawnOwner[field] !== expected[field]) {
      rejectConflict(`gateway_lease_id owner does not authorize spawn: ${field}`);
    }
  }
}

export function spawnResultSessionKey(result: Record<string, unknown>): string | undefined {
  const values: string[] = [];
  for (const key of ["childSessionKey", "sessionKey", "session_key"]) {
    if (!Object.hasOwn(result, key)) {
      continue;
    }
    const value = result[key];
    if (typeof value !== "string" || !value) {
      return undefined;
    }
    values.push(value);
  }
  const first = values[0];
  return first && values.every((value) => value === first) ? first : undefined;
}

export function spawnResultRunId(result: Record<string, unknown>): string | undefined {
  const value = result.runId;
  return typeof value === "string" && value ? value : undefined;
}
