export const CONTRACT_VERSION = "v1";
export const AGENTIC_OS_ALLOW_LEASE_MAX_TTL_MS = 24 * 60 * 60 * 1000;
export const AGENTIC_OS_RUNTIME_MAX_RECORDS = 1_024;
export const AGENTIC_OS_RUNTIME_REPLAY_RETENTION_MS = 5 * 60 * 1000;
export const AGENTIC_OS_RUNTIME_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

export const ALLOW_LEASE_IDENTITY_FIELDS = [
  "client_lease_id",
  "idempotency_key",
  "run_id",
  "phase",
  "transition_id",
  "agent_id",
  "requester_agent_id",
] as const;

export const ALLOW_LEASE_OWNER_FIELDS = [
  "client_lease_id",
  "run_id",
  "phase",
  "transition_id",
  "agent_id",
  "requester_agent_id",
] as const;

export const SESSION_METADATA_FIELDS = [
  "run_id",
  "transition_id",
  "client_request_id",
  "idempotency_key",
  "phase",
  "agent_id",
  "task_digest",
] as const;

export const FORBIDDEN_LEASE_CAMEL_ALIASES = [
  "clientLeaseId",
  "idempotencyKey",
  "runId",
  "transitionId",
  "agentId",
  "requesterAgentId",
  "ttlMs",
  "gatewayLeaseId",
] as const;

export const FORBIDDEN_SPAWN_CAMEL_ALIASES = [
  "clientRequestId",
  "idempotencyKey",
  "gatewayLeaseId",
] as const;

export const FORBIDDEN_RELEASE_ALIASES = [
  ...FORBIDDEN_LEASE_CAMEL_ALIASES,
  "releaseIdempotencyKey",
  "idempotency_key",
] as const;

export const FORBIDDEN_SESSION_STATUS_CAMEL_ALIASES = ["sessionKey"] as const;
export const FORBIDDEN_HISTORY_CAMEL_ALIASES = ["session_key"] as const;
const FORBIDDEN_ALL_CAMEL_ALIASES = [...FORBIDDEN_LEASE_CAMEL_ALIASES, "clientRequestId"] as const;

export type RuntimeMetadata = {
  metadata_contract_version: "v1";
  normalized: Record<string, unknown>;
  raw_json: string;
};

export type LeaseRecord = {
  gatewayLeaseId: string;
  fingerprint: string;
  acquireIdempotencyKey: string;
  clientLeaseId: string;
  owner: Record<(typeof ALLOW_LEASE_IDENTITY_FIELDS)[number], string>;
  spawnOwner: Record<(typeof ALLOW_LEASE_OWNER_FIELDS)[number], string>;
  authenticatedPrincipalId: string;
  acquireMetadata: RuntimeMetadata;
  created_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms?: number;
  spawn_reserved_at_ms?: number;
  spawn_reservation_fingerprint?: string;
  spawn_reservation?: SessionRecord;
  released_at_ms?: number;
};

export type SessionRecord = {
  sessionKey: string;
  fingerprint: string;
  clientRequestId: string;
  idempotencyKey: string;
  gatewayLeaseId: string;
  metadata: RuntimeMetadata;
  taskName?: string;
  agentId: string;
  authenticatedPrincipalId: string;
  runId?: string;
  created_at_ms: number;
};

export type ReleaseReplay = {
  releaseIdempotencyKey: string;
  fingerprint: string;
  response: Record<string, unknown>;
  createdAtMs: number;
  authenticatedPrincipalId: string;
};

export type SpawnPending = {
  fingerprint: string;
  promise: Promise<SessionRecord>;
  authenticatedPrincipalId: string;
};

export class ContractInputError extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function assertNoForbiddenAliases(
  params: Record<string, unknown>,
  aliases: readonly string[] = FORBIDDEN_ALL_CAMEL_ALIASES,
) {
  const alias = aliases.find((key) => Object.hasOwn(params, key));
  if (alias) {
    throw new ContractInputError(`conflicting alias is not accepted: ${alias}`);
  }
}

export function readString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContractInputError(`missing required string: ${key}`);
  }
  return value;
}

export function readPositiveInteger(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    throw new ContractInputError(`missing required positive integer: ${key}`);
  }
  return value;
}

export function pickStrings<const T extends readonly string[]>(
  params: Record<string, unknown>,
  fields: T,
): Record<T[number], string> {
  const picked = {} as Record<T[number], string>;
  for (const field of fields) {
    picked[field as T[number]] = readString(params, field);
  }
  return picked;
}
