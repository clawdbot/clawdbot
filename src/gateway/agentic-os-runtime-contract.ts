import { randomUUID } from "node:crypto";
import { spawnSubagentDirect } from "../agents/subagent-spawn.js";
import {
  leaseResponse,
  metadataEnvelope,
  releaseResponse,
  sessionProjection,
  spawnProjectionPayload,
} from "./agentic-os-runtime-contract-projections.js";
import {
  AGENTIC_OS_ALLOW_LEASE_MAX_TTL_MS,
  AGENTIC_OS_RUNTIME_MAX_RECORDS,
  AGENTIC_OS_RUNTIME_REPLAY_RETENTION_MS,
  AGENTIC_OS_RUNTIME_SESSION_RETENTION_MS,
  ALLOW_LEASE_IDENTITY_FIELDS,
  ALLOW_LEASE_OWNER_FIELDS,
  ContractInputError,
  FORBIDDEN_HISTORY_CAMEL_ALIASES,
  FORBIDDEN_LEASE_CAMEL_ALIASES,
  FORBIDDEN_RELEASE_ALIASES,
  FORBIDDEN_SESSION_STATUS_CAMEL_ALIASES,
  FORBIDDEN_SPAWN_CAMEL_ALIASES,
  SESSION_METADATA_FIELDS,
  assertNoForbiddenAliases,
  isRecord,
  pickStrings,
  readPositiveInteger,
  readString,
  stableJson,
  type LeaseRecord,
  type ReleaseReplay,
  type SessionRecord,
  type SpawnPending,
} from "./agentic-os-runtime-contract-shared.js";
import {
  loadAgenticOsRuntimeSnapshot,
  runtimeSnapshotPath,
  saveAgenticOsRuntimeSnapshot,
} from "./agentic-os-runtime-contract-store.js";
import {
  sessionRecordHasActiveChildRun,
  taskDigest,
} from "./agentic-os-runtime-contract-task-state.js";

const leasesByGatewayId = new Map<string, LeaseRecord>();
const acquireByIdempotencyKey = new Map<string, LeaseRecord>();
const acquireByClientLeaseId = new Map<string, LeaseRecord>();
const releaseByReleaseIdempotencyKey = new Map<string, ReleaseReplay>();
const sessionsByKey = new Map<string, SessionRecord>();
const spawnByIdempotencyKey = new Map<string, SessionRecord>();
const spawnByClientRequestId = new Map<string, SessionRecord>();
const spawnPendingByIdempotencyKey = new Map<string, SpawnPending>();
const spawnPendingByClientRequestId = new Map<string, SpawnPending>();
const ACCEPTED_SPAWN_PERSIST_ATTEMPTS = 3;

type RuntimeSnapshot = {
  leases: LeaseRecord[];
  releaseReplays: ReleaseReplay[];
  sessions: SessionRecord[];
};

let loadedSnapshotPath: string | undefined;

function principalScopedKey(authenticatedPrincipalId: string, identity: string): string {
  return `${authenticatedPrincipalId}\0${identity}`;
}

function snapshotRuntimeState(): RuntimeSnapshot {
  return {
    leases: [...acquireByIdempotencyKey.values()],
    releaseReplays: [...releaseByReleaseIdempotencyKey.values()],
    sessions: [...sessionsByKey.values()],
  };
}

function hydrateRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
  leasesByGatewayId.clear();
  acquireByIdempotencyKey.clear();
  acquireByClientLeaseId.clear();
  releaseByReleaseIdempotencyKey.clear();
  sessionsByKey.clear();
  spawnByIdempotencyKey.clear();
  spawnByClientRequestId.clear();
  spawnPendingByIdempotencyKey.clear();
  spawnPendingByClientRequestId.clear();

  for (const lease of snapshot.leases) {
    acquireByIdempotencyKey.set(
      principalScopedKey(lease.authenticatedPrincipalId, lease.acquireIdempotencyKey),
      lease,
    );
    acquireByClientLeaseId.set(
      principalScopedKey(lease.authenticatedPrincipalId, lease.clientLeaseId),
      lease,
    );
    if (!lease.released_at_ms && !lease.consumed_at_ms) {
      leasesByGatewayId.set(lease.gatewayLeaseId, lease);
    }
  }
  for (const replay of snapshot.releaseReplays) {
    if (replay.releaseIdempotencyKey) {
      releaseByReleaseIdempotencyKey.set(
        principalScopedKey(replay.authenticatedPrincipalId, replay.releaseIdempotencyKey),
        replay,
      );
    }
  }
  for (const session of snapshot.sessions) {
    const idempotencyScopedKey = principalScopedKey(
      session.authenticatedPrincipalId,
      session.idempotencyKey,
    );
    const clientRequestScopedKey = principalScopedKey(
      session.authenticatedPrincipalId,
      session.clientRequestId,
    );
    sessionsByKey.set(session.sessionKey, session);
    spawnByIdempotencyKey.set(idempotencyScopedKey, session);
    spawnByClientRequestId.set(clientRequestScopedKey, session);
  }
}

function ensureRuntimeStateLoaded(): void {
  const storePath = runtimeSnapshotPath();
  if (loadedSnapshotPath === storePath) {
    return;
  }
  hydrateRuntimeSnapshot(
    (loadAgenticOsRuntimeSnapshot() as RuntimeSnapshot | undefined) ?? {
      leases: [],
      releaseReplays: [],
      sessions: [],
    },
  );
  loadedSnapshotPath = storePath;
}

function persistRuntimeState(): void {
  ensureRuntimeStateLoaded();
  saveAgenticOsRuntimeSnapshot(snapshotRuntimeState());
  loadedSnapshotPath = runtimeSnapshotPath();
}

function persistAcceptedSpawn(): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < ACCEPTED_SPAWN_PERSIST_ATTEMPTS; attempt += 1) {
    try {
      persistRuntimeState();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function rejectConflict(message: string): never {
  throw new ContractInputError(message);
}

function pruneExpiredLeases(now = Date.now()) {
  let changed = false;
  for (const [gatewayLeaseId, record] of leasesByGatewayId.entries()) {
    if (!record.released_at_ms && record.expires_at_ms <= now) {
      record.released_at_ms = record.expires_at_ms;
      leasesByGatewayId.delete(gatewayLeaseId);
      changed = true;
    }
  }
  for (const [key, record] of acquireByIdempotencyKey) {
    if (
      record.released_at_ms &&
      now - record.released_at_ms > AGENTIC_OS_RUNTIME_REPLAY_RETENTION_MS
    ) {
      acquireByIdempotencyKey.delete(key);
      const clientLeaseKey = principalScopedKey(
        record.authenticatedPrincipalId,
        record.clientLeaseId,
      );
      if (acquireByClientLeaseId.get(clientLeaseKey) === record) {
        acquireByClientLeaseId.delete(clientLeaseKey);
      }
      changed = true;
    }
  }
  for (const [key, replay] of releaseByReleaseIdempotencyKey) {
    if (now - replay.createdAtMs > AGENTIC_OS_RUNTIME_REPLAY_RETENTION_MS) {
      releaseByReleaseIdempotencyKey.delete(key);
      changed = true;
    }
  }
  for (const [sessionKey, record] of sessionsByKey) {
    if (now - record.created_at_ms <= AGENTIC_OS_RUNTIME_SESSION_RETENTION_MS) {
      continue;
    }
    if (sessionRecordHasActiveChildRun(record)) {
      continue;
    }
    sessionsByKey.delete(sessionKey);
    const idempotencyScopedKey = principalScopedKey(
      record.authenticatedPrincipalId,
      record.idempotencyKey,
    );
    if (spawnByIdempotencyKey.get(idempotencyScopedKey) === record) {
      spawnByIdempotencyKey.delete(idempotencyScopedKey);
    }
    const clientRequestScopedKey = principalScopedKey(
      record.authenticatedPrincipalId,
      record.clientRequestId,
    );
    if (spawnByClientRequestId.get(clientRequestScopedKey) === record) {
      spawnByClientRequestId.delete(clientRequestScopedKey);
    }
    changed = true;
  }
  if (changed) {
    persistRuntimeState();
  }
}

function assertRecordCapacity(map: ReadonlyMap<unknown, unknown>, label: string) {
  if (map.size >= AGENTIC_OS_RUNTIME_MAX_RECORDS) {
    throw new ContractInputError(`${label} capacity reached`);
  }
}

export function acquireAgenticOsAllowLease(
  params: Record<string, unknown>,
  authenticatedRequesterAgentId?: string,
  authenticatedPrincipalId = "internal",
): Record<string, unknown> {
  ensureRuntimeStateLoaded();
  pruneExpiredLeases();
  assertNoForbiddenAliases(params, FORBIDDEN_LEASE_CAMEL_ALIASES);
  const owner = pickStrings(params, ALLOW_LEASE_IDENTITY_FIELDS);
  if (authenticatedRequesterAgentId && owner.requester_agent_id !== authenticatedRequesterAgentId) {
    return rejectConflict("requester_agent_id does not match authenticated requester");
  }
  const spawnOwner = pickStrings(params, ALLOW_LEASE_OWNER_FIELDS);
  const ttlMs = readPositiveInteger(params, "ttl_ms");
  if (ttlMs > AGENTIC_OS_ALLOW_LEASE_MAX_TTL_MS) {
    return rejectConflict(`ttl_ms exceeds maximum ${AGENTIC_OS_ALLOW_LEASE_MAX_TTL_MS}`);
  }
  const fingerprint = stableJson({ ...owner, ttl_ms: ttlMs });
  const idempotencyScopedKey = principalScopedKey(authenticatedPrincipalId, owner.idempotency_key);
  const clientLeaseScopedKey = principalScopedKey(authenticatedPrincipalId, owner.client_lease_id);
  const existingByIdempotency = acquireByIdempotencyKey.get(idempotencyScopedKey);
  if (existingByIdempotency) {
    if (existingByIdempotency.fingerprint !== fingerprint) {
      return rejectConflict("conflicting allow lease acquire idempotency_key");
    }
    return leaseResponse(existingByIdempotency);
  }
  const existingByClientLease = acquireByClientLeaseId.get(clientLeaseScopedKey);
  if (existingByClientLease) {
    return rejectConflict("conflicting allow lease client_lease_id");
  }
  assertRecordCapacity(acquireByIdempotencyKey, "allow lease");
  const gatewayLeaseId = `gateway-lease:${randomUUID()}`;
  const now = Date.now();
  const acquireMetadata = metadataEnvelope({
    ...owner,
    ttl_ms: ttlMs,
    gateway_lease_id: gatewayLeaseId,
  });
  const record: LeaseRecord = {
    gatewayLeaseId,
    fingerprint,
    acquireIdempotencyKey: owner.idempotency_key,
    clientLeaseId: owner.client_lease_id,
    owner,
    spawnOwner,
    authenticatedPrincipalId,
    acquireMetadata,
    created_at_ms: now,
    expires_at_ms: now + ttlMs,
  };
  leasesByGatewayId.set(gatewayLeaseId, record);
  acquireByIdempotencyKey.set(idempotencyScopedKey, record);
  acquireByClientLeaseId.set(clientLeaseScopedKey, record);
  persistRuntimeState();
  return leaseResponse(record);
}

export function listAgenticOsAllowLeases(
  authenticatedPrincipalId = "internal",
): Record<string, unknown> {
  ensureRuntimeStateLoaded();
  pruneExpiredLeases();
  const activeLeases = new Map<string, LeaseRecord>();
  for (const record of acquireByIdempotencyKey.values()) {
    if (!record.released_at_ms && !record.consumed_at_ms) {
      activeLeases.set(record.gatewayLeaseId, record);
      leasesByGatewayId.set(record.gatewayLeaseId, record);
    }
  }
  const leases = [...activeLeases.values()]
    .filter(
      (record) =>
        !record.released_at_ms &&
        !record.consumed_at_ms &&
        record.authenticatedPrincipalId === authenticatedPrincipalId,
    )
    .map((record) => leaseResponse(record));
  return { status: "ok", leases };
}

export function releaseAgenticOsAllowLease(
  params: Record<string, unknown>,
  authenticatedRequesterAgentId?: string,
  authenticatedPrincipalId = "internal",
): Record<string, unknown> {
  ensureRuntimeStateLoaded();
  pruneExpiredLeases();
  assertNoForbiddenAliases(params, FORBIDDEN_RELEASE_ALIASES);
  const owner = pickStrings(params, ALLOW_LEASE_OWNER_FIELDS);
  if (authenticatedRequesterAgentId && owner.requester_agent_id !== authenticatedRequesterAgentId) {
    return rejectConflict("requester_agent_id does not match authenticated requester");
  }
  const releaseIdempotencyKey = readString(params, "release_idempotency_key");
  const gatewayLeaseId = readString(params, "gateway_lease_id");
  const normalized = {
    ...owner,
    release_idempotency_key: releaseIdempotencyKey,
    gateway_lease_id: gatewayLeaseId,
  };
  const fingerprint = stableJson(normalized);
  const releaseScopedKey = principalScopedKey(authenticatedPrincipalId, releaseIdempotencyKey);
  const replay = releaseByReleaseIdempotencyKey.get(releaseScopedKey);
  if (replay) {
    if (replay.fingerprint !== fingerprint) {
      return rejectConflict("conflicting allow lease release release_idempotency_key");
    }
    return replay.response;
  }
  assertRecordCapacity(releaseByReleaseIdempotencyKey, "allow lease release replay");
  const record = acquireByClientLeaseId.get(
    principalScopedKey(authenticatedPrincipalId, owner.client_lease_id),
  );
  if (!record || record.gatewayLeaseId !== gatewayLeaseId) {
    return rejectConflict("unknown allow lease owner or gateway_lease_id");
  }
  if (record.authenticatedPrincipalId !== authenticatedPrincipalId) {
    return rejectConflict("allow lease belongs to a different authenticated principal");
  }
  for (const field of ALLOW_LEASE_OWNER_FIELDS) {
    if (record.spawnOwner[field] !== owner[field]) {
      return rejectConflict(`allow lease owner mismatch: ${field}`);
    }
  }
  const previousReleasedAtMs = record.released_at_ms;
  record.released_at_ms = record.released_at_ms ?? Date.now();
  leasesByGatewayId.delete(gatewayLeaseId);
  const response = releaseResponse(record, metadataEnvelope(normalized));
  releaseByReleaseIdempotencyKey.set(releaseScopedKey, {
    releaseIdempotencyKey,
    fingerprint,
    response,
    createdAtMs: Date.now(),
    authenticatedPrincipalId,
  });
  try {
    persistRuntimeState();
  } catch (error) {
    // A failed snapshot must leave neither half of the release authoritative.
    // Otherwise an in-memory replay can report success while restart restores an active lease.
    if (previousReleasedAtMs === undefined) {
      delete record.released_at_ms;
    } else {
      record.released_at_ms = previousReleasedAtMs;
    }
    if (!record.released_at_ms && !record.consumed_at_ms) {
      leasesByGatewayId.set(gatewayLeaseId, record);
    }
    releaseByReleaseIdempotencyKey.delete(releaseScopedKey);
    throw error;
  }
  return response;
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
  const normalized: Record<string, unknown> = {};
  for (const field of SESSION_METADATA_FIELDS) {
    normalized[field] = readString(metadata, field);
  }
  return normalized;
}

function requireLeaseAuthorizesSpawn(params: {
  lease: LeaseRecord;
  metadata: Record<string, unknown>;
  agentId: string;
}) {
  const { lease, metadata, agentId } = params;
  const expected: Record<(typeof ALLOW_LEASE_OWNER_FIELDS)[number], unknown> = {
    client_lease_id: lease.spawnOwner.client_lease_id,
    run_id: metadata.run_id,
    phase: metadata.phase,
    transition_id: metadata.transition_id,
    agent_id: agentId,
    requester_agent_id: lease.spawnOwner.requester_agent_id,
  };
  for (const field of ALLOW_LEASE_OWNER_FIELDS) {
    if (lease.spawnOwner[field] !== expected[field]) {
      rejectConflict(`gateway_lease_id owner does not authorize spawn: ${field}`);
    }
  }
}

function spawnResultSessionKey(result: Record<string, unknown>): string | undefined {
  for (const key of ["childSessionKey", "sessionKey", "session_key"]) {
    const value = result[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

function spawnResultRunId(result: Record<string, unknown>): string | undefined {
  const value = result.runId;
  return typeof value === "string" && value ? value : undefined;
}

export async function spawnAgenticOsSession(
  params: Record<string, unknown>,
  authenticatedRequesterAgentId?: string,
  authenticatedPrincipalId = "internal",
): Promise<Record<string, unknown>> {
  ensureRuntimeStateLoaded();
  pruneExpiredLeases();
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
  const metadataClientRequestId = metadata.client_request_id;
  const metadataIdempotencyKey = metadata.idempotency_key;
  if (metadataClientRequestId !== clientRequestId || metadataIdempotencyKey !== idempotencyKey) {
    return rejectConflict("session metadata identity does not match spawn identity");
  }
  if (metadata.task_digest !== taskDigest(task)) {
    return rejectConflict("session metadata task_digest does not match spawn task");
  }
  const agentId =
    typeof params.agentId === "string" && params.agentId
      ? params.agentId
      : String(metadata.agent_id);
  if (agentId !== metadata.agent_id) {
    return rejectConflict("spawn agentId does not match session metadata agent_id");
  }
  const taskName =
    typeof params.taskName === "string" && params.taskName ? params.taskName : undefined;
  if (params.mode === "session") {
    return rejectConflict("sessions_spawn mode session is not supported by this contract");
  }
  const mode = "run";
  const cleanup =
    params.cleanup === "delete" || params.cleanup === "keep" ? params.cleanup : undefined;
  if (
    Object.hasOwn(params, "cleanup") &&
    params.cleanup !== "delete" &&
    params.cleanup !== "keep"
  ) {
    return rejectConflict("invalid enum: cleanup");
  }
  const context =
    params.context === "fork" || params.context === "isolated" ? params.context : undefined;
  if (
    Object.hasOwn(params, "context") &&
    params.context !== "fork" &&
    params.context !== "isolated"
  ) {
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
  const idempotencyScopedKey = principalScopedKey(authenticatedPrincipalId, idempotencyKey);
  const clientRequestScopedKey = principalScopedKey(authenticatedPrincipalId, clientRequestId);
  const existingByIdempotency = spawnByIdempotencyKey.get(idempotencyScopedKey);
  if (existingByIdempotency) {
    if (existingByIdempotency.fingerprint !== fingerprint) {
      return rejectConflict("conflicting sessions_spawn idempotency_key");
    }
    return spawnProjectionPayload(existingByIdempotency);
  }
  const existingByClientRequest = spawnByClientRequestId.get(clientRequestScopedKey);
  if (existingByClientRequest) {
    return rejectConflict("conflicting sessions_spawn client_request_id");
  }
  const pendingByIdempotency = spawnPendingByIdempotencyKey.get(idempotencyScopedKey);
  if (pendingByIdempotency) {
    if (pendingByIdempotency.fingerprint !== fingerprint) {
      return rejectConflict("conflicting sessions_spawn idempotency_key");
    }
    return spawnProjectionPayload(await pendingByIdempotency.promise);
  }
  const pendingByClientRequest = spawnPendingByClientRequestId.get(clientRequestScopedKey);
  if (pendingByClientRequest) {
    return rejectConflict("conflicting sessions_spawn client_request_id");
  }
  const lease = leasesByGatewayId.get(gatewayLeaseId);
  if (!lease || lease.gatewayLeaseId !== gatewayLeaseId || lease.released_at_ms) {
    return rejectConflict("gateway_lease_id is not active");
  }
  if (lease.consumed_at_ms || lease.spawn_reservation_fingerprint) {
    return rejectConflict("gateway_lease_id is already reserved or consumed");
  }
  if (
    authenticatedRequesterAgentId &&
    lease.spawnOwner.requester_agent_id !== authenticatedRequesterAgentId
  ) {
    return rejectConflict("allow lease requester does not match authenticated requester");
  }
  if (lease.authenticatedPrincipalId !== authenticatedPrincipalId) {
    return rejectConflict("allow lease belongs to a different authenticated principal");
  }
  requireLeaseAuthorizesSpawn({ lease, metadata, agentId });
  assertRecordCapacity(spawnByIdempotencyKey, "session spawn replay");
  assertRecordCapacity(spawnPendingByIdempotencyKey, "pending session spawn");
  lease.spawn_reserved_at_ms = Date.now();
  lease.spawn_reservation_fingerprint = fingerprint;
  try {
    persistRuntimeState();
  } catch (error) {
    delete lease.spawn_reserved_at_ms;
    delete lease.spawn_reservation_fingerprint;
    throw error;
  }
  const pending: SpawnPending = {
    fingerprint,
    authenticatedPrincipalId,
    promise: (async () => {
      try {
        const spawnResult = (await spawnSubagentDirect(
          {
            task,
            taskName,
            agentId,
            mode,
            cleanup,
            context,
            lightContext,
            expectsCompletionMessage: false,
          },
          {
            agentSessionKey: `agent:${lease.spawnOwner.requester_agent_id}`,
            requesterAgentIdOverride: lease.spawnOwner.requester_agent_id,
            authorizedTargetAgentId: lease.spawnOwner.agent_id,
          },
        )) as Record<string, unknown>;
        if (spawnResult.status !== "accepted") {
          throw new ContractInputError(
            typeof spawnResult.error === "string"
              ? spawnResult.error
              : "child runner rejected spawn",
          );
        }
        const sessionKey = spawnResultSessionKey(spawnResult);
        if (!sessionKey) {
          return rejectConflict("sessions_spawn accepted without a child session identity");
        }
        const record: SessionRecord = {
          sessionKey,
          fingerprint,
          clientRequestId,
          idempotencyKey,
          gatewayLeaseId,
          metadata: metadataEnvelope(metadata),
          taskName,
          agentId,
          authenticatedPrincipalId,
          runId: spawnResultRunId(spawnResult),
          created_at_ms: Date.now(),
        };
        sessionsByKey.set(sessionKey, record);
        spawnByIdempotencyKey.set(idempotencyScopedKey, record);
        spawnByClientRequestId.set(clientRequestScopedKey, record);
        lease.consumed_at_ms = Date.now();
        delete lease.spawn_reserved_at_ms;
        delete lease.spawn_reservation_fingerprint;
        leasesByGatewayId.delete(gatewayLeaseId);
        try {
          persistAcceptedSpawn();
        } catch {
          // The child is already authoritative once the runner accepts it. Keep
          // replay state in memory and report the accepted session instead of a
          // false failure. Transient snapshot failures were durably retried
          // above before reaching this irreversible fallback.
        }
        return record;
      } catch (error) {
        if (lease.spawn_reservation_fingerprint === fingerprint) {
          delete lease.spawn_reserved_at_ms;
          delete lease.spawn_reservation_fingerprint;
          if (!lease.released_at_ms && !lease.consumed_at_ms) {
            leasesByGatewayId.set(gatewayLeaseId, lease);
          }
          persistRuntimeState();
        }
        throw error;
      }
    })(),
  };
  spawnPendingByIdempotencyKey.set(idempotencyScopedKey, pending);
  spawnPendingByClientRequestId.set(clientRequestScopedKey, pending);
  try {
    return spawnProjectionPayload(await pending.promise);
  } finally {
    spawnPendingByIdempotencyKey.delete(idempotencyScopedKey);
    spawnPendingByClientRequestId.delete(clientRequestScopedKey);
  }
}

export function listAgenticOsSessions(
  authenticatedPrincipalId = "internal",
): Record<string, unknown> {
  ensureRuntimeStateLoaded();
  pruneExpiredLeases();
  const sessions = [...sessionsByKey.values()]
    .filter((record) => record.authenticatedPrincipalId === authenticatedPrincipalId)
    .map((record) => sessionProjection(record));
  return { status: "ok", count: sessions.length, sessions };
}

export function statusAgenticOsSession(
  params: Record<string, unknown>,
  authenticatedPrincipalId = "internal",
): Record<string, unknown> {
  ensureRuntimeStateLoaded();
  pruneExpiredLeases();
  assertNoForbiddenAliases(params, FORBIDDEN_SESSION_STATUS_CAMEL_ALIASES);
  const sessionKey = readString(params, "session_key");
  const record = sessionsByKey.get(sessionKey);
  if (!record) {
    throw new ContractInputError("unknown session_key");
  }
  if (record.authenticatedPrincipalId !== authenticatedPrincipalId) {
    throw new ContractInputError("session belongs to a different authenticated principal");
  }
  const projection = sessionProjection(record);
  return { status: "tracked", ...projection, session: projection };
}

export function historyAgenticOsSession(
  params: Record<string, unknown>,
  authenticatedPrincipalId = "internal",
): Record<string, unknown> {
  ensureRuntimeStateLoaded();
  pruneExpiredLeases();
  assertNoForbiddenAliases(params, FORBIDDEN_HISTORY_CAMEL_ALIASES);
  const sessionKey = readString(params, "sessionKey");
  const record = sessionsByKey.get(sessionKey);
  if (!record) {
    throw new ContractInputError("unknown sessionKey");
  }
  if (record.authenticatedPrincipalId !== authenticatedPrincipalId) {
    throw new ContractInputError("session belongs to a different authenticated principal");
  }
  const projection = sessionProjection(record);
  return {
    status: "ok",
    ...projection,
    session: projection,
  };
}

export { ContractInputError };
