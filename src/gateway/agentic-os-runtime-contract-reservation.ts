import { randomUUID } from "node:crypto";
import { mintSpawnSessionKey } from "../agents/spawn-plan.js";
import type {
  LeaseRecord,
  RuntimeMetadata,
  SessionRecord,
} from "./agentic-os-runtime-contract-shared.js";

export function createSpawnReservation(params: {
  fingerprint: string;
  clientRequestId: string;
  idempotencyKey: string;
  gatewayLeaseId: string;
  metadata: RuntimeMetadata;
  taskName?: string;
  agentId: string;
  authenticatedPrincipalId: string;
  createdAtMs: number;
}): SessionRecord {
  return {
    sessionKey: mintSpawnSessionKey({ targetAgentId: params.agentId, backend: "subagent" }),
    fingerprint: params.fingerprint,
    clientRequestId: params.clientRequestId,
    idempotencyKey: params.idempotencyKey,
    gatewayLeaseId: params.gatewayLeaseId,
    metadata: params.metadata,
    taskName: params.taskName,
    agentId: params.agentId,
    authenticatedPrincipalId: params.authenticatedPrincipalId,
    runId: randomUUID(),
    created_at_ms: params.createdAtMs,
  };
}

export function clearSpawnReservation(lease: LeaseRecord): void {
  delete lease.spawn_reserved_at_ms;
  delete lease.spawn_reservation_fingerprint;
  delete lease.spawn_reservation;
}

export function reconcileSpawnReservation(params: {
  lease: LeaseRecord;
  acceptedSession?: SessionRecord;
  now: number;
}): SessionRecord | undefined {
  const acceptedSession = params.acceptedSession ?? params.lease.spawn_reservation;
  const reservedAt =
    typeof params.lease.spawn_reserved_at_ms === "number" &&
    Number.isFinite(params.lease.spawn_reserved_at_ms)
      ? Math.min(params.lease.spawn_reserved_at_ms, params.now)
      : params.now;
  params.lease.consumed_at_ms = acceptedSession?.created_at_ms ?? reservedAt;
  clearSpawnReservation(params.lease);
  return acceptedSession;
}
