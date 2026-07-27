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
  clearSpawnReservation,
  createSpawnReservation,
  reconcileSpawnReservation,
} from "./agentic-os-runtime-contract-reservation.js";
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
  assertNoForbiddenAliases,
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
  parseAgenticOsSpawnInput,
  requireLeaseAuthorizesSpawn,
  spawnResultRunId,
  spawnResultSessionKey,
} from "./agentic-os-runtime-contract-spawn-input.js";
import {
  loadAgenticOsRuntimeSnapshot,
  runtimeSnapshotPath,
  saveAgenticOsRuntimeSnapshot,
} from "./agentic-os-runtime-contract-store.js";
import {
  sessionRecordHasActiveChildRun,
  sessionRecordHasChildRunEvidence,
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
const REJECTED_SPAWN_ROLLBACK_PERSIST_ATTEMPTS = 3;

class AcceptedSpawnIdentityError extends Error {}

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

function hydrateRuntimeSnapshot(snapshot: RuntimeSnapshot): boolean {
  leasesByGatewayId.clear();
  acquireByIdempotencyKey.clear();
  acquireByClientLeaseId.clear();
  releaseByReleaseIdempotencyKey.clear();
  sessionsByKey.clear();
  spawnByIdempotencyKey.clear();
  spawnByClientRequestId.clear();
  spawnPendingByIdempotencyKey.clear();
  spawnPendingByClientRequestId.clear();

  let changed = false;
  const hydrationNow = Date.now();
  const reconciledSessions = [...snapshot.sessions];
  const acceptedSessionByLease = new Map(
    snapshot.sessions.map((session) => [session.gatewayLeaseId, session]),
  );
  for (const lease of snapshot.leases) {
    if (lease.spawn_reservation_fingerprint && !lease.consumed_at_ms) {
      // A pending promise cannot survive process restart. Promote a durable
      // reservation only when an accepted snapshot or canonical child-run
      // evidence proves that launch crossed the acceptance boundary. Otherwise
      // clear the stale reservation so a definitively rejected launch cannot
      // reappear as accepted after a failed rollback write. Release can race a
      // pending runner after reservation persistence; canonical child-run
      // evidence still wins so exact spawn replay remains crash-safe.
      const durableAcceptedSession = acceptedSessionByLease.get(lease.gatewayLeaseId);
      const reservedSession = lease.spawn_reservation;
      if (
        !durableAcceptedSession &&
        (!reservedSession || !sessionRecordHasChildRunEvidence(reservedSession))
      ) {
        if (!lease.released_at_ms) {
          lease.consumed_at_ms =
            typeof lease.spawn_reserved_at_ms === "number"
              ? Math.min(lease.spawn_reserved_at_ms, hydrationNow)
              : hydrationNow;
        }
        clearSpawnReservation(lease);
        changed = true;
      } else {
        const acceptedSession = reconcileSpawnReservation({
          lease,
          acceptedSession: durableAcceptedSession,
          now: hydrationNow,
        });
        if (acceptedSession && !acceptedSessionByLease.has(lease.gatewayLeaseId)) {
          reconciledSessions.push(acceptedSession);
          acceptedSessionByLease.set(lease.gatewayLeaseId, acceptedSession);
        }
        changed = true;
      }
    }
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
  for (const session of reconciledSessions) {
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
  return changed;
}

function ensureRuntimeStateLoaded(): void {
  const storePath = runtimeSnapshotPath();
  if (loadedSnapshotPath === storePath) {
    return;
  }
  const reconciledReservation = hydrateRuntimeSnapshot(
    (loadAgenticOsRuntimeSnapshot() as RuntimeSnapshot | undefined) ?? {
      leases: [],
      releaseReplays: [],
      sessions: [],
    },
  );
  if (reconciledReservation) {
    saveAgenticOsRuntimeSnapshot(snapshotRuntimeState());
  }
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

function persistRejectedSpawnRollback(lease: LeaseRecord): void {
  clearSpawnReservation(lease);
  let lastError: unknown;
  for (let attempt = 0; attempt < REJECTED_SPAWN_ROLLBACK_PERSIST_ATTEMPTS; attempt += 1) {
    try {
      persistRuntimeState();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function consumeIndeterminateSpawn(lease: LeaseRecord): void {
  lease.consumed_at_ms = Date.now();
  clearSpawnReservation(lease);
  leasesByGatewayId.delete(lease.gatewayLeaseId);
  try {
    persistAcceptedSpawn();
  } catch {
    // The pre-launch reservation remains durable when terminal persistence is
    // unavailable. Restart recovery consumes reservations without canonical
    // child-run evidence, so an accepted-but-invalid result cannot reopen the
    // one-shot lease and launch a second child.
  }
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
    const terminalAtMs = record.released_at_ms ?? record.consumed_at_ms;
    if (terminalAtMs && now - terminalAtMs > AGENTIC_OS_RUNTIME_REPLAY_RETENTION_MS) {
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
  try {
    persistRuntimeState();
  } catch (error) {
    leasesByGatewayId.delete(gatewayLeaseId);
    acquireByIdempotencyKey.delete(idempotencyScopedKey);
    acquireByClientLeaseId.delete(clientLeaseScopedKey);
    throw error;
  }
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

export async function spawnAgenticOsSession(
  params: Record<string, unknown>,
  authenticatedRequesterAgentId?: string,
  authenticatedPrincipalId = "internal",
): Promise<Record<string, unknown>> {
  ensureRuntimeStateLoaded();
  pruneExpiredLeases();
  const {
    clientRequestId,
    idempotencyKey,
    gatewayLeaseId,
    task,
    taskName,
    mode,
    cleanup,
    context,
    lightContext,
    agentId,
    metadata,
    fingerprint,
  } = parseAgenticOsSpawnInput(params);
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
  const reservationNow = Date.now();
  if (lease.expires_at_ms <= reservationNow) {
    pruneExpiredLeases(reservationNow);
    return rejectConflict("gateway_lease_id is not active");
  }
  const reservedSession = createSpawnReservation({
    fingerprint,
    clientRequestId,
    idempotencyKey,
    gatewayLeaseId,
    metadata: metadataEnvelope(metadata),
    taskName,
    agentId,
    authenticatedPrincipalId,
    createdAtMs: reservationNow,
  });
  lease.spawn_reserved_at_ms = reservationNow;
  lease.spawn_reservation_fingerprint = fingerprint;
  lease.spawn_reservation = reservedSession;
  try {
    persistRuntimeState();
  } catch (error) {
    clearSpawnReservation(lease);
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
            agentSessionKey: `agent:${lease.spawnOwner.requester_agent_id}:main`,
            requesterAgentIdOverride: lease.spawnOwner.requester_agent_id,
            authorizedTargetAgentId: lease.spawnOwner.agent_id,
            preallocatedChildSessionKey: reservedSession.sessionKey,
            preallocatedRunId: reservedSession.runId,
          },
        )) as Record<string, unknown>;
        if (spawnResult.status === "forbidden") {
          throw new ContractInputError(
            typeof spawnResult.error === "string"
              ? spawnResult.error
              : "child runner forbids spawn",
          );
        }
        if (spawnResult.status !== "accepted") {
          throw new Error("child runner failed to accept spawn");
        }
        const returnedSessionKey = spawnResultSessionKey(spawnResult);
        const returnedRunId = spawnResultRunId(spawnResult);
        if (
          returnedSessionKey !== reservedSession.sessionKey ||
          returnedRunId !== reservedSession.runId
        ) {
          throw new AcceptedSpawnIdentityError(
            "child runner violated the preallocated spawn identity",
          );
        }
        const record: SessionRecord = {
          ...reservedSession,
          created_at_ms: Date.now(),
        };
        sessionsByKey.set(record.sessionKey, record);
        spawnByIdempotencyKey.set(idempotencyScopedKey, record);
        spawnByClientRequestId.set(clientRequestScopedKey, record);
        delete lease.released_at_ms;
        lease.consumed_at_ms = Date.now();
        clearSpawnReservation(lease);
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
        if (error instanceof AcceptedSpawnIdentityError) {
          consumeIndeterminateSpawn(lease);
          throw error;
        }
        if (lease.spawn_reservation_fingerprint === fingerprint) {
          if (!lease.released_at_ms && !lease.consumed_at_ms) {
            leasesByGatewayId.set(gatewayLeaseId, lease);
          }
          persistRejectedSpawnRollback(lease);
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
