import {
  CONTRACT_VERSION,
  stableJson,
  type LeaseRecord,
  type RuntimeMetadata,
  type SessionRecord,
} from "./agentic-os-runtime-contract-shared.js";

export function metadataEnvelope(normalized: Record<string, unknown>): RuntimeMetadata {
  return {
    metadata_contract_version: CONTRACT_VERSION,
    normalized,
    raw_json: stableJson(normalized),
  };
}

export function leaseResponse(record: LeaseRecord): Record<string, unknown> {
  const status = record.released_at_ms
    ? "released"
    : record.consumed_at_ms
      ? "consumed"
      : record.spawn_reservation_fingerprint
        ? "reserved"
        : "active";
  return {
    status,
    gateway_lease_id: record.gatewayLeaseId,
    external_id: record.gatewayLeaseId,
    lease: {
      status,
      lease_id: record.gatewayLeaseId,
      gateway_lease_id: record.gatewayLeaseId,
      client_lease_id: record.clientLeaseId,
      expires_at_ms: record.expires_at_ms,
      consumed_at_ms: record.consumed_at_ms,
      released_at_ms: record.released_at_ms,
      metadata: record.acquireMetadata,
    },
    metadata: record.acquireMetadata,
  };
}

export function releaseResponse(
  record: LeaseRecord,
  releaseMetadata: RuntimeMetadata,
): Record<string, unknown> {
  return {
    status: "released",
    released: true,
    gateway_lease_id: record.gatewayLeaseId,
    external_id: record.gatewayLeaseId,
    lease: {
      status: "released",
      lease_id: record.gatewayLeaseId,
      gateway_lease_id: record.gatewayLeaseId,
      client_lease_id: record.clientLeaseId,
      released_at_ms: record.released_at_ms,
      metadata: releaseMetadata,
    },
    metadata: releaseMetadata,
  };
}

export function sessionProjection(record: SessionRecord): Record<string, unknown> {
  return {
    key: record.sessionKey,
    session_key: record.sessionKey,
    sessionKey: record.sessionKey,
    external_id: record.sessionKey,
    spawn_request_session_key: record.sessionKey,
    gateway_lease_id: record.gatewayLeaseId,
    client_request_id: record.clientRequestId,
    idempotency_key: record.idempotencyKey,
    agent_id: record.agentId,
    taskName: record.taskName,
    runId: record.runId,
    created_at_ms: record.created_at_ms,
    metadata: record.metadata,
  };
}

export function spawnProjectionPayload(record: SessionRecord): Record<string, unknown> {
  const projection = sessionProjection(record);
  return {
    status: "accepted",
    ...projection,
    childSessionKey: record.sessionKey,
    runId: record.runId,
    session: projection,
  };
}
