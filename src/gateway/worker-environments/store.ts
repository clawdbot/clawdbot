import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { Insertable, Selectable, Updateable } from "kysely";
import {
  type WorkerAdmissionHandshake,
  WORKER_PROTOCOL_MAX_FEATURE_LENGTH,
  WORKER_PROTOCOL_MAX_FEATURES,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type {
  WorkerDesktopApp,
  WorkerDesktopEndpoint,
  WorkerProfile,
  WorkerSshEndpoint,
} from "../../plugins/types.js";
import { isValidSecretRef } from "../../secrets/ref-contract.js";
import { ensureWorkerEnvironmentNodeEnrollmentSchema } from "../../state/openclaw-state-db-schema-additive.js";
import type {
  DB as StateDatabase,
  WorkerEnvironmentCredentials,
  WorkerEnvironmentSshFallbackPorts,
  WorkerEnvironments,
} from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { WorkerCredentialRecord } from "./credential.js";
import {
  canTransitionWorkerEnvironment,
  parseWorkerEnvironmentState,
  workerEnvironmentStateRequiresLease,
  type WorkerEnvironmentLeasedState,
  type WorkerEnvironmentState,
  type WorkerEnvironmentUnleasedState,
} from "./state.js";
import { pruneExpiredTerminalWorkerEnvironments } from "./terminal-environment-retention.js";

type WorkerEnvironmentProfileSnapshot = WorkerProfile;
type WorkerEnvironmentSshEndpoint = WorkerSshEndpoint;
type WorkerBootstrapInstallKind = "bundle" | "local";
type WorkerEnvironmentBootstrapReceipt = WorkerAdmissionHandshake & {
  /** Provenance only; admission authority remains the exact stored build identity. */
  installKind?: WorkerBootstrapInstallKind;
};
type WorkerEnvironmentTeardownTerminalState = "destroyed" | "failed";
type RecordIdentity = { environmentId: string; providerId: string; profileId: string };
type RecordBase = RecordIdentity & {
  profileSnapshot: WorkerEnvironmentProfileSnapshot;
  provisionOperationId: string;
  nodeSetupId: string | null;
  nodeDeviceId: string | null;
  sharedHost: boolean | null;
  desktop: WorkerDesktopEndpoint | null;
  bootstrapReceipt: WorkerEnvironmentBootstrapReceipt | null;
  ownerEpoch: number;
  teardownTerminalState: WorkerEnvironmentTeardownTerminalState | null;
  attachedSessionIds: string[];
  lastError: string | null;
} & { createdAtMs: number; updatedAtMs: number; stateChangedAtMs: number } & {
  idleSinceAtMs: number | null;
  destroyRequestedAtMs: number | null;
};
type Ssh = WorkerEnvironmentSshEndpoint;
type UnleasedRecord = {
  state: WorkerEnvironmentUnleasedState;
  leaseId: null;
  sshEndpoint: null;
};
type LeasedRecord = {
  state: WorkerEnvironmentLeasedState;
  leaseId: string;
  sshEndpoint: Ssh | null;
};
export type WorkerEnvironmentRecord = RecordBase & (UnleasedRecord | LeasedRecord);
export class WorkerSessionAlreadyAttachedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly environmentId: string,
  ) {
    super(`Session ${sessionId} is already attached to worker environment ${environmentId}`);
  }
}
export type WorkerEnvironmentTransitionPatch = {
  leaseId?: string | null;
  nodeDeviceId?: string | null;
  sshEndpoint?: WorkerEnvironmentSshEndpoint | null;
  sharedHost?: boolean;
  desktop?: WorkerDesktopEndpoint | null;
  bootstrapReceipt?: WorkerEnvironmentBootstrapReceipt;
  attachedSessionIds?: readonly string[];
  lastError?: string | null;
  credential?: CredentialInput;
};
type WorkerDb = Pick<
  StateDatabase,
  | "device_pair_setup_completions"
  | "worker_environment_credentials"
  | "worker_environment_ssh_fallback_ports"
  | "worker_environments"
  | "worker_transcript_commit_heads"
>;
type Row = Selectable<WorkerEnvironments>;
type RowWithFallbackPort = Row & { ssh_fallback_port: number | null };
type RowUpdate = Updateable<WorkerEnvironments>;
type SshFallbackPortInsert = Insertable<WorkerEnvironmentSshFallbackPorts>;
type CredentialRow = Selectable<WorkerEnvironmentCredentials>;
type CredentialInsert = Insertable<WorkerEnvironmentCredentials>;
type CredentialInput = {
  credentialHash: string;
  sessionId: string | null;
  rpcSetVersion: number;
  expiresAtMs: number;
};
type IntentInput = RecordIdentity & {
  profileSnapshot: WorkerEnvironmentProfileSnapshot;
  provisionOperationId: string;
};
type TransitionInput = {
  environmentId: string;
  from: WorkerEnvironmentState;
  to: WorkerEnvironmentState;
  expectedOwnerEpoch?: number;
  patch?: WorkerEnvironmentTransitionPatch;
};
const TERMINAL_STATES: WorkerEnvironmentState[] = ["destroyed", "failed", "orphaned"];
const WORKER_BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_HOST_KEY_LENGTH = 16_384;
const MAX_SSH_FALLBACK_PORTS = 10;
const MAX_WORKER_DESKTOP_APPS = 8;
const ensuredWorkerEnvironmentDatabases = new WeakSet<DatabaseSync>();
const WORKER_ENVIRONMENT_SSH_FALLBACK_PORTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS worker_environment_ssh_fallback_ports (
  environment_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0 AND position <= 9),
  port INTEGER NOT NULL CHECK (port >= 1 AND port <= 65535),
  PRIMARY KEY (environment_id, position),
  UNIQUE (environment_id, port),
  FOREIGN KEY (environment_id) REFERENCES worker_environments(environment_id) ON DELETE CASCADE
) STRICT;
`;
const WORKER_CREDENTIAL_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const OPENSSH_HOST_KEY_TYPE_PATTERN =
  /^(?:ssh|ecdsa-sha2|sk-(?:ssh|ecdsa-sha2))-[A-Za-z0-9@._+-]+$/u;
const OPENSSH_HOST_KEY_DATA_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
function required(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Worker environment ${field} must be a non-empty string`);
  }
  return value.trim();
}
function normalizeOpenSshHostKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_HOST_KEY_LENGTH ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new Error("Worker environment SSH host key must be one OpenSSH public-key line");
  }
  const tokens = value.trim().split(/\s+/u);
  const [algorithm, encodedKey] = tokens;
  if (
    tokens.length !== 2 ||
    !algorithm ||
    !encodedKey ||
    !OPENSSH_HOST_KEY_TYPE_PATTERN.test(algorithm) ||
    !OPENSSH_HOST_KEY_DATA_PATTERN.test(encodedKey) ||
    encodedKey.length % 4 !== 0
  ) {
    throw new Error("Worker environment SSH host key must use OpenSSH public-key format");
  }
  return `${algorithm} ${encodedKey}`;
}
function teardownTerminalStateFrom(
  value: string | null,
): WorkerEnvironmentTeardownTerminalState | null {
  if (value === null || value === "destroyed" || value === "failed") {
    return value;
  }
  throw new Error("Worker environment teardown terminal state is invalid");
}
function normalizeBootstrapReceipt(value: {
  bundleHash: unknown;
  openclawVersion: unknown;
  protocolFeatures: unknown;
  installKind?: unknown;
}): WorkerEnvironmentBootstrapReceipt {
  const bundleHash = required(value.bundleHash, "bootstrap bundle hash");
  if (!WORKER_BUNDLE_HASH_PATTERN.test(bundleHash)) {
    throw new Error("Worker environment bootstrap bundle hash must be lowercase SHA-256 hex");
  }
  if (!Array.isArray(value.protocolFeatures)) {
    throw new Error("Worker environment bootstrap protocol features must be an array");
  }
  if (
    value.protocolFeatures.length > WORKER_PROTOCOL_MAX_FEATURES ||
    value.protocolFeatures.some(
      (feature) =>
        typeof feature !== "string" || feature.trim().length > WORKER_PROTOCOL_MAX_FEATURE_LENGTH,
    )
  ) {
    throw new Error("Worker environment bootstrap protocol features exceed admission limits");
  }
  if (
    value.installKind !== undefined &&
    value.installKind !== "bundle" &&
    value.installKind !== "local"
  ) {
    throw new Error("Worker environment bootstrap install kind is invalid");
  }
  return {
    bundleHash,
    openclawVersion: required(value.openclawVersion, "bootstrap OpenClaw version"),
    protocolFeatures: normalizeSortedUniqueTrimmedStringList(value.protocolFeatures),
    ...(value.installKind ? { installKind: value.installKind } : {}),
  };
}
function normalizeCredentialHash(value: unknown): string {
  const credentialHash = required(value, "credential hash");
  if (!WORKER_CREDENTIAL_HASH_PATTERN.test(credentialHash)) {
    throw new Error("Worker credential hash must be a SHA-256 base64url digest");
  }
  return credentialHash;
}
function normalizeSessionId(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  const sessionId = required(value, "credential session id");
  if (sessionId.length > WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH) {
    throw new Error("Worker credential session id exceeds the admission limit");
  }
  return sessionId;
}
function normalizeAttachedSessionIds(value: unknown): string[] {
  const sessionIds = normalizeSortedUniqueTrimmedStringList(value);
  for (const sessionId of sessionIds) {
    if (sessionId.length > WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH) {
      throw new Error("Worker environment attached session id exceeds the admission limit");
    }
  }
  return sessionIds;
}
function assertCredentialSessionBinding(
  attachedSessionIds: readonly string[],
  sessionId: string | null,
): void {
  if (sessionId !== (attachedSessionIds[0] ?? null)) {
    throw new Error("Worker credential session does not match the environment attachment");
  }
}
function normalizeRpcSetVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("Worker credential RPC-set version must be a positive safe integer");
  }
  return value as number;
}
function normalizeExpiry(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Worker credential expiry must be a non-negative safe integer");
  }
  return value as number;
}
export function normalizeWorkerSshEndpoint(value: Ssh): Ssh {
  const host = required(value.host, "SSH host");
  const user = required(value.user, "SSH user");
  const hostKey = normalizeOpenSshHostKey(value.hostKey);
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535) {
    throw new Error("Worker environment SSH port must be an integer from 1 through 65535");
  }
  if (!isValidSecretRef(value.keyRef)) {
    throw new Error("Worker environment SSH key must be a canonical SecretRef");
  }
  if (value.fallbackPorts !== undefined && !Array.isArray(value.fallbackPorts)) {
    throw new Error("Worker environment SSH fallback ports must be an array");
  }
  const seen = new Set([value.port]);
  const fallbackPorts: number[] = [];
  for (const port of value.fallbackPorts ?? []) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(
        "Worker environment SSH fallback ports must be integers from 1 through 65535",
      );
    }
    if (!seen.has(port)) {
      seen.add(port);
      fallbackPorts.push(port);
    }
  }
  if (fallbackPorts.length > MAX_SSH_FALLBACK_PORTS) {
    throw new Error(
      `Worker environment SSH fallback ports cannot exceed ${MAX_SSH_FALLBACK_PORTS}`,
    );
  }
  return {
    host,
    port: value.port,
    ...(fallbackPorts.length > 0 ? { fallbackPorts } : {}),
    user,
    hostKey,
    keyRef: { ...value.keyRef },
  };
}
export function normalizeWorkerDesktopEndpoint(
  value: WorkerDesktopEndpoint,
): WorkerDesktopEndpoint {
  if (!isRecord(value) || value.protocol !== "rfb") {
    throw new Error('Worker environment desktop protocol must be "rfb"');
  }
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535) {
    throw new Error("Worker environment desktop port must be an integer from 1 through 65535");
  }
  const passwordFilePath = value.passwordFilePath;
  if (
    passwordFilePath !== undefined &&
    (typeof passwordFilePath !== "string" || !isAbsolute(passwordFilePath))
  ) {
    throw new Error("Worker environment desktop password file path must be absolute");
  }
  if (value.apps !== undefined && !Array.isArray(value.apps)) {
    throw new Error("Worker environment desktop apps must be an array");
  }
  if ((value.apps?.length ?? 0) > MAX_WORKER_DESKTOP_APPS) {
    throw new Error(`Worker environment desktop apps cannot exceed ${MAX_WORKER_DESKTOP_APPS}`);
  }
  const seenAppIds = new Set<WorkerDesktopApp["id"]>();
  const apps = (value.apps ?? []).map((app): WorkerDesktopApp => {
    if (!isRecord(app) || (app.id !== "browser" && app.id !== "terminal")) {
      throw new Error('Worker environment desktop app id must be "browser" or "terminal"');
    }
    if (seenAppIds.has(app.id)) {
      throw new Error(`Worker environment desktop app id ${app.id} must be unique`);
    }
    seenAppIds.add(app.id);
    if (typeof app.executablePath !== "string" || !isAbsolute(app.executablePath)) {
      throw new Error("Worker environment desktop app executable path must be absolute");
    }
    if (app.id === "terminal") {
      if (Object.keys(app).some((key) => key !== "id" && key !== "executablePath")) {
        throw new Error("Worker environment terminal desktop app contains unknown fields");
      }
      return { id: "terminal", executablePath: app.executablePath };
    }
    if (
      Object.keys(app).some((key) => key !== "id" && key !== "executablePath" && key !== "cdpPort")
    ) {
      throw new Error("Worker environment browser desktop app contains unknown fields");
    }
    if (
      typeof app.cdpPort !== "number" ||
      !Number.isSafeInteger(app.cdpPort) ||
      app.cdpPort < 1 ||
      app.cdpPort > 65_535
    ) {
      throw new Error(
        "Worker environment browser CDP port must be an integer from 1 through 65535",
      );
    }
    return {
      id: "browser",
      executablePath: app.executablePath,
      cdpPort: app.cdpPort,
    };
  });
  return {
    protocol: "rfb",
    port: value.port,
    ...(passwordFilePath === undefined ? {} : { passwordFilePath }),
    ...(value.apps === undefined ? {} : { apps }),
  };
}
function endpointFrom(row: Row, fallbackPorts: readonly number[]): Ssh | null {
  const {
    ssh_host: host,
    ssh_port: port,
    ssh_user: user,
    ssh_host_key: hostKey,
    ssh_key_ref_json: encoded,
  } = row;
  if (host === null || port === null || user === null || hostKey === null || encoded === null) {
    return null;
  }
  return normalizeWorkerSshEndpoint({
    host,
    port,
    ...(fallbackPorts.length > 0 ? { fallbackPorts } : {}),
    user,
    hostKey,
    keyRef: JSON.parse(encoded) as Ssh["keyRef"],
  });
}
function desktopFrom(row: Row): WorkerDesktopEndpoint | null {
  return row.desktop_json === null
    ? null
    : normalizeWorkerDesktopEndpoint(JSON.parse(row.desktop_json) as WorkerDesktopEndpoint);
}
function bootstrapReceiptFrom(row: Row): WorkerEnvironmentBootstrapReceipt | null {
  const {
    bootstrap_bundle_hash: bundleHash,
    bootstrap_openclaw_version: openclawVersion,
    bootstrap_protocol_features_json: encodedFeatures,
    bootstrap_install_kind: installKind,
  } = row;
  if (bundleHash === null && openclawVersion === null && encodedFeatures === null) {
    return null;
  }
  if (bundleHash === null || openclawVersion === null || encodedFeatures === null) {
    throw new Error("Worker environment bootstrap receipt is incomplete");
  }
  return normalizeBootstrapReceipt({
    bundleHash,
    openclawVersion,
    protocolFeatures: JSON.parse(encodedFeatures) as unknown,
    ...(installKind === null ? {} : { installKind }),
  });
}
function assertShape(
  state: WorkerEnvironmentState,
  leaseId: string | null,
  nodeDeviceId: string | null,
  sshEndpoint: Ssh | null,
  desktop: WorkerDesktopEndpoint | null,
  bootstrapReceipt: WorkerEnvironmentBootstrapReceipt | null,
  attachedSessionIds: readonly string[],
): void {
  if (sshEndpoint && nodeDeviceId) {
    throw new Error("Worker environment cannot retain both SSH and node transports");
  }
  if (workerEnvironmentStateRequiresLease(state)) {
    if (!leaseId) {
      throw new Error(`Worker environment state ${state} requires a provider lease`);
    }
    if (state === "bootstrapping" && !sshEndpoint) {
      throw new Error("Worker environment bootstrap requires an SSH endpoint reference");
    }
    if (state === "ready" && !sshEndpoint && !nodeDeviceId) {
      throw new Error("Ready worker environment requires a transport binding");
    }
  } else if (leaseId || sshEndpoint || desktop) {
    throw new Error(`Worker environment state ${state} cannot retain a provider lease`);
  }
  if (state === "bootstrapping" && bootstrapReceipt) {
    throw new Error("Bootstrapping worker environment cannot retain a stale bootstrap receipt");
  }
  if (state === "attached" && attachedSessionIds.length !== 1) {
    throw new Error("Attached worker environment requires exactly one session id");
  }
  if (state !== "attached" && attachedSessionIds.length !== 0) {
    throw new Error("Only an attached worker environment may retain a session id");
  }
}
function nextOwnerEpoch(ownerEpoch: number): number {
  const next = ownerEpoch + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error("Worker environment owner epoch is exhausted");
  }
  return next;
}
function nextGlobalOwnerEpoch(db: DatabaseSync): number {
  // Transcript commit identity is (session, epoch, seq), so an ownership
  // generation may never be reused when a session moves between environments.
  const latestEnvironment = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_environments")
      .select(({ fn }) => fn.max<number>("owner_epoch").as("owner_epoch")),
  );
  const latestTranscriptCommit = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_transcript_commit_heads")
      .select(({ fn }) => fn.max<number>("run_epoch").as("run_epoch")),
  );
  return nextOwnerEpoch(
    Math.max(latestEnvironment?.owner_epoch ?? 0, latestTranscriptCommit?.run_epoch ?? 0),
  );
}
function fromRow(row: Row, fallbackPorts: readonly number[]): WorkerEnvironmentRecord {
  const record = {
    environmentId: row.environment_id,
    providerId: row.provider_id,
    profileId: row.profile_id,
    profileSnapshot: JSON.parse(row.profile_snapshot_json) as WorkerEnvironmentProfileSnapshot,
    provisionOperationId: row.provision_operation_id,
    nodeSetupId: row.node_setup_id,
    nodeDeviceId: row.node_device_id,
    sharedHost: row.shared_host === null ? null : row.shared_host === 1,
    leaseId: row.lease_id,
    sshEndpoint: endpointFrom(row, fallbackPorts),
    desktop: desktopFrom(row),
    bootstrapReceipt: bootstrapReceiptFrom(row),
    ownerEpoch: row.owner_epoch,
    teardownTerminalState: teardownTerminalStateFrom(row.teardown_terminal_state),
    state: parseWorkerEnvironmentState(row.state),
    attachedSessionIds: normalizeAttachedSessionIds(
      JSON.parse(row.attached_session_ids_json) as unknown,
    ),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    stateChangedAtMs: row.state_changed_at_ms,
    idleSinceAtMs: row.idle_since_at_ms,
    destroyRequestedAtMs: row.destroy_requested_at_ms,
    lastError: row.last_error,
  };
  assertShape(
    record.state,
    record.leaseId,
    record.nodeDeviceId,
    record.sshEndpoint,
    record.desktop,
    record.bootstrapReceipt,
    record.attachedSessionIds,
  );
  return record as WorkerEnvironmentRecord;
}
function credentialFromRow(row: CredentialRow): WorkerCredentialRecord {
  return {
    environmentId: row.environment_id,
    credentialHash: normalizeCredentialHash(row.credential_hash),
    bundleHash: row.bundle_hash,
    sessionId: row.session_id,
    rpcSetVersion: row.rpc_set_version,
    ownerEpoch: row.owner_epoch,
    expiresAtMs: row.expires_at_ms,
    deliveredAtMs: row.delivered_at_ms,
  };
}
const json = (value: unknown) => JSON.stringify(value) as string;
const query = (db: DatabaseSync) => getNodeSqliteKysely<WorkerDb>(db);
function environmentRows(db: DatabaseSync) {
  return query(db)
    .selectFrom("worker_environments")
    .leftJoin(
      "worker_environment_ssh_fallback_ports",
      "worker_environment_ssh_fallback_ports.environment_id",
      "worker_environments.environment_id",
    )
    .selectAll("worker_environments")
    .select("worker_environment_ssh_fallback_ports.port as ssh_fallback_port");
}
function recordsFromRows(rows: readonly RowWithFallbackPort[]): WorkerEnvironmentRecord[] {
  const grouped = new Map<string, { ports: number[]; row: Row }>();
  for (const row of rows) {
    const current = grouped.get(row.environment_id);
    if (current) {
      if (row.ssh_fallback_port !== null) {
        current.ports.push(row.ssh_fallback_port);
      }
      continue;
    }
    grouped.set(row.environment_id, {
      ports: row.ssh_fallback_port === null ? [] : [row.ssh_fallback_port],
      row,
    });
  }
  return Array.from(grouped.values(), ({ row, ports }) => fromRow(row, ports));
}
function find(db: DatabaseSync, environmentId: string) {
  const rows = executeSqliteQuerySync(
    db,
    environmentRows(db)
      .where("worker_environments.environment_id", "=", environmentId)
      .orderBy("worker_environment_ssh_fallback_ports.position"),
  ).rows;
  return recordsFromRows(rows)[0];
}
function findCredential(db: DatabaseSync, environmentId: string) {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_environment_credentials")
      .selectAll()
      .where("environment_id", "=", environmentId),
  );
  return row ? credentialFromRow(row) : undefined;
}
function findCredentialByHash(db: DatabaseSync, credentialHash: string) {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_environment_credentials")
      .selectAll()
      .where("credential_hash", "=", credentialHash),
  );
  return row ? credentialFromRow(row) : undefined;
}
function findTransferOwner(db: DatabaseSync, environmentId: string) {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_environments")
      .leftJoin(
        "worker_environment_credentials",
        "worker_environment_credentials.environment_id",
        "worker_environments.environment_id",
      )
      .select([
        "worker_environments.owner_epoch as environment_owner_epoch",
        "worker_environments.attached_session_ids_json",
        "worker_environments.destroy_requested_at_ms",
        "worker_environments.state",
        "worker_environment_credentials.owner_epoch as credential_owner_epoch",
        "worker_environment_credentials.expires_at_ms",
        "worker_environment_credentials.session_id",
      ])
      .where("worker_environments.environment_id", "=", environmentId),
  );
  if (!row) {
    return undefined;
  }
  return {
    environment: {
      ownerEpoch: row.environment_owner_epoch,
      attachedSessionIds: normalizeAttachedSessionIds(
        JSON.parse(row.attached_session_ids_json) as unknown,
      ),
      destroyRequestedAtMs: row.destroy_requested_at_ms,
      state: row.state,
    },
    credential:
      row.credential_owner_epoch === null || row.expires_at_ms === null
        ? undefined
        : {
            ownerEpoch: row.credential_owner_epoch,
            expiresAtMs: row.expires_at_ms,
            sessionId: row.session_id,
          },
  };
}
function getRequired(db: DatabaseSync, environmentId: string) {
  const record = find(db, environmentId);
  if (!record) {
    throw new Error(`Unknown worker environment: ${environmentId}`);
  }
  return record;
}
function updateRow(db: DatabaseSync, id: string, state: WorkerEnvironmentState, values: RowUpdate) {
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_environments")
      .set(values)
      .where("environment_id", "=", id)
      .where("state", "=", state),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Worker environment ${id} changed during update`);
  }
}
function update(db: DatabaseSync, id: string, state: WorkerEnvironmentState, values: RowUpdate) {
  updateRow(db, id, state, values);
  return getRequired(db, id);
}
function replaceSshFallbackPorts(
  db: DatabaseSync,
  environmentId: string,
  ports: readonly number[],
): void {
  executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("worker_environment_ssh_fallback_ports")
      .where("environment_id", "=", environmentId),
  );
  if (ports.length === 0) {
    return;
  }
  const rows: SshFallbackPortInsert[] = ports.map((port, position) => ({
    environment_id: environmentId,
    position,
    port,
  }));
  executeSqliteQuerySync(
    db,
    query(db).insertInto("worker_environment_ssh_fallback_ports").values(rows),
  );
}
function revokeCredential(db: DatabaseSync, environmentId: string): void {
  executeSqliteQuerySync(
    db,
    query(db)
      .deleteFrom("worker_environment_credentials")
      .where("environment_id", "=", environmentId),
  );
}
function upsertCredential(db: DatabaseSync, credential: CredentialInsert): void {
  executeSqliteQuerySync(
    db,
    query(db)
      .insertInto("worker_environment_credentials")
      .values(credential)
      .onConflict((conflict) =>
        conflict.column("environment_id").doUpdateSet({
          credential_hash: credential.credential_hash,
          bundle_hash: credential.bundle_hash,
          session_id: credential.session_id,
          rpc_set_version: credential.rpc_set_version,
          owner_epoch: credential.owner_epoch,
          expires_at_ms: credential.expires_at_ms,
          delivered_at_ms: credential.delivered_at_ms,
        }),
      ),
  );
}
function credentialInsert(params: {
  input: CredentialInput;
  environmentId: string;
  bundleHash: string;
  attachedSessionIds: readonly string[];
  ownerEpoch: number;
  nowMs: number;
}): CredentialInsert {
  const sessionId = normalizeSessionId(params.input.sessionId);
  assertCredentialSessionBinding(params.attachedSessionIds, sessionId);
  const expiresAtMs = normalizeExpiry(params.input.expiresAtMs);
  if (expiresAtMs <= params.nowMs) {
    throw new Error("Worker credential expiry must be in the future");
  }
  return {
    environment_id: params.environmentId,
    credential_hash: normalizeCredentialHash(params.input.credentialHash),
    bundle_hash: params.bundleHash,
    session_id: sessionId,
    rpc_set_version: normalizeRpcSetVersion(params.input.rpcSetVersion),
    owner_epoch: params.ownerEpoch,
    expires_at_ms: expiresAtMs,
    delivered_at_ms: null,
  };
}
function listRows(db: DatabaseSync, reconcile: boolean): WorkerEnvironmentRecord[] {
  const base = environmentRows(db);
  const filtered = reconcile
    ? base.where("worker_environments.state", "not in", TERMINAL_STATES)
    : base;
  const ordered = reconcile ? filtered.orderBy("worker_environments.provider_id") : filtered;
  const rows = executeSqliteQuerySync(
    db,
    ordered
      .orderBy("worker_environments.created_at_ms")
      .orderBy("worker_environments.environment_id")
      .orderBy("worker_environment_ssh_fallback_ports.position"),
  ).rows;
  return recordsFromRows(rows);
}

function compareAttachmentAuthority(
  left: WorkerEnvironmentRecord,
  right: WorkerEnvironmentRecord,
): number {
  if (left.ownerEpoch !== right.ownerEpoch) {
    return left.ownerEpoch > right.ownerEpoch ? -1 : 1;
  }
  if (left.stateChangedAtMs !== right.stateChangedAtMs) {
    return left.stateChangedAtMs > right.stateChangedAtMs ? -1 : 1;
  }
  if (left.environmentId === right.environmentId) {
    return 0;
  }
  return left.environmentId < right.environmentId ? -1 : 1;
}

function reconcileAttachedSessionOwners(db: DatabaseSync, nowMs: number): void {
  const ownersBySession = new Map<string, WorkerEnvironmentRecord[]>();
  for (const record of listRows(db, false)) {
    // Closing attachments retain physical cleanup scope, not live ownership.
    if (record.state !== "attached" || record.destroyRequestedAtMs !== null) {
      continue;
    }
    const sessionId = record.attachedSessionIds[0];
    if (!sessionId) {
      continue;
    }
    const owners = ownersBySession.get(sessionId) ?? [];
    owners.push(record);
    ownersBySession.set(sessionId, owners);
  }
  for (const owners of ownersBySession.values()) {
    if (owners.length < 2) {
      continue;
    }
    const [, ...duplicates] = owners.toSorted(compareAttachmentAuthority);
    for (const duplicate of duplicates) {
      // Fence legacy duplicate live owners before startup snapshots them.
      update(db, duplicate.environmentId, "attached", {
        owner_epoch: nextGlobalOwnerEpoch(db),
        state: "idle",
        attached_session_ids_json: json([]),
        updated_at_ms: nowMs,
        state_changed_at_ms: nowMs,
        idle_since_at_ms: nowMs,
      });
      revokeCredential(db, duplicate.environmentId);
    }
  }
}

export function createWorkerEnvironmentStore(
  options: { database?: OpenClawStateDatabase; now?: () => number } = {},
) {
  const database = options.database ?? openOpenClawStateDatabase();
  if (!ensuredWorkerEnvironmentDatabases.has(database.db)) {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        // sqlite-allow-raw -- feature-local additive schema DDL; rows use Kysely below.
        db.exec(WORKER_ENVIRONMENT_SSH_FALLBACK_PORTS_SCHEMA_SQL);
      },
      { database },
      { operationLabel: "worker-environments.ssh-fallback-ports.schema.ensure" },
    );
    ensuredWorkerEnvironmentDatabases.add(database.db);
  }
  const path = database.path;
  const now = options.now ?? Date.now;
  const read = () => openOpenClawStateDatabase({ path }).db;
  let inventoryVersion = 0;
  const write = <T>(operation: (db: DatabaseSync) => T): T => {
    const result = runOpenClawStateWriteTransaction(({ db }) => operation(db), { path });
    // Device pairing's nodeDeviceId patch deliberately stays outside this version:
    // it changes no identity/epoch/state input. Runner availability owns its own fence.
    inventoryVersion += 1;
    return result;
  };
  write((db) => reconcileAttachedSessionOwners(db, now()));
  const writeCredential = (
    input: CredentialInput & {
      environmentId: string;
      expectedOwnerEpoch: number;
    },
  ): WorkerCredentialRecord => {
    const environmentId = required(input.environmentId, "id");
    return write((db) => {
      const current = getRequired(db, environmentId);
      if (current.ownerEpoch !== input.expectedOwnerEpoch) {
        throw new Error(`Worker environment ${environmentId} owner epoch changed`);
      }
      if (current.state !== "ready" && current.state !== "idle" && current.state !== "attached") {
        throw new Error(`Cannot mint worker credential in state ${current.state}`);
      }
      if (current.destroyRequestedAtMs !== null) {
        throw new Error("Cannot mint worker credential after destroy is requested");
      }
      if (!current.bootstrapReceipt) {
        throw new Error("Worker environment has no admitted bootstrap identity");
      }
      const updatedAtMs = now();
      const ownerEpoch = Math.max(1, current.ownerEpoch);
      if (ownerEpoch !== current.ownerEpoch) {
        update(db, environmentId, current.state, {
          owner_epoch: ownerEpoch,
          updated_at_ms: updatedAtMs,
        });
      }
      upsertCredential(
        db,
        credentialInsert({
          input,
          environmentId,
          bundleHash: current.bootstrapReceipt.bundleHash,
          attachedSessionIds: current.attachedSessionIds,
          ownerEpoch,
          nowMs: updatedAtMs,
        }),
      );
      const credential = findCredential(db, environmentId);
      if (!credential) {
        throw new Error("Worker credential persistence failed");
      }
      return credential;
    });
  };
  return {
    createIntent(input: IntentInput): WorkerEnvironmentRecord {
      const environmentId = required(input.environmentId, "id");
      const createdAtMs = now();
      return write((db) => {
        executeSqliteQuerySync(
          db,
          query(db)
            .insertInto("worker_environments")
            .values({
              environment_id: environmentId,
              provider_id: required(input.providerId, "provider id"),
              profile_id: required(input.profileId, "profile id"),
              profile_snapshot_json: json(input.profileSnapshot),
              provision_operation_id: required(
                input.provisionOperationId,
                "provision operation id",
              ),
              lease_id: null,
              node_setup_id: null,
              node_device_id: null,
              shared_host: null,
              ssh_host: null,
              ssh_port: null,
              ssh_user: null,
              ssh_host_key: null,
              ssh_key_ref_json: null,
              desktop_json: null,
              bootstrap_bundle_hash: null,
              bootstrap_openclaw_version: null,
              bootstrap_protocol_features_json: null,
              bootstrap_install_kind: null,
              owner_epoch: 0,
              teardown_terminal_state: null,
              state: "requested",
              created_at_ms: createdAtMs,
              updated_at_ms: createdAtMs,
              state_changed_at_ms: createdAtMs,
              idle_since_at_ms: null,
              destroy_requested_at_ms: null,
              last_error: null,
            }),
        );
        return getRequired(db, environmentId);
      });
    },
    get: (environmentId: string) => find(read(), required(environmentId, "id")),
    inventoryVersion: () => inventoryVersion,
    hasNodeEnrollmentOwner(nodeId: string): boolean {
      const db = read();
      // Pairing can bind the node without changing inventoryVersion. Cleanup states
      // still own enrollment until the environment reaches its terminal state.
      return (
        executeSqliteQueryTakeFirstSync(
          db,
          query(db)
            .selectFrom("worker_environments")
            .select("environment_id")
            .where("node_device_id", "=", nodeId)
            .where("node_setup_id", "is not", null)
            .where("state", "not in", TERMINAL_STATES)
            .limit(1),
        ) !== undefined
      );
    },
    hasPendingNodeEnrollmentSetup(setupIdInput: string, deviceIdInput: string): boolean {
      const setupId = setupIdInput.trim();
      const deviceId = deviceIdInput.trim();
      if (!setupId || !deviceId) {
        return false;
      }
      const db = read();
      const matches = executeSqliteQuerySync(
        db,
        query(db)
          .selectFrom("worker_environments")
          .select("environment_id")
          .where("node_setup_id", "=", setupId)
          .where("destroy_requested_at_ms", "is", null)
          .where((eb) =>
            eb.or([
              eb.and([eb("state", "=", "provisioning"), eb("node_device_id", "is", null)]),
              eb.and([
                eb("state", "in", ["provisioning", "bootstrapping", "ready", "idle", "attached"]),
                eb("node_device_id", "=", deviceId),
              ]),
            ]),
          )
          .limit(2),
      ).rows;
      return matches.length === 1;
    },
    ensureNodeEnrollment(environmentIdInput: string): WorkerEnvironmentRecord {
      const environmentId = required(environmentIdInput, "id");
      return write((db) => {
        ensureWorkerEnvironmentNodeEnrollmentSchema(db);
        const current = getRequired(db, environmentId);
        if (TERMINAL_STATES.includes(current.state) || current.destroyRequestedAtMs !== null) {
          throw new Error(`Worker environment ${environmentId} cannot begin node enrollment`);
        }
        const setupId = current.nodeSetupId ?? randomUUID();
        const completion = executeSqliteQueryTakeFirstSync(
          db,
          query(db)
            .selectFrom("device_pair_setup_completions")
            .select("device_id")
            .where("setup_id", "=", setupId),
        );
        const completedDeviceId = completion?.device_id ?? null;
        if (
          current.nodeDeviceId !== null &&
          completedDeviceId !== null &&
          current.nodeDeviceId !== completedDeviceId
        ) {
          throw new Error(`Worker environment ${environmentId} node enrollment identity changed`);
        }
        const nodeDeviceId = current.nodeDeviceId ?? completedDeviceId;
        if (current.nodeSetupId === setupId && current.nodeDeviceId === nodeDeviceId) {
          return current;
        }
        return update(db, environmentId, current.state, {
          node_setup_id: setupId,
          node_device_id: nodeDeviceId,
          updated_at_ms: now(),
        });
      });
    },
    getCredential: (environmentId: string) => findCredential(read(), required(environmentId, "id")),
    getTransferOwner: (environmentId: string) =>
      findTransferOwner(read(), required(environmentId, "id")),
    revokeEnvironmentCredential(environmentId: string): void {
      return write((db) => revokeCredential(db, required(environmentId, "id")));
    },
    findCredentialByHash: (credentialHash: string) =>
      findCredentialByHash(read(), normalizeCredentialHash(credentialHash)),
    list: (): WorkerEnvironmentRecord[] => listRows(read(), false),
    listForReconcile: (): WorkerEnvironmentRecord[] => listRows(read(), true),
    pruneTerminalEnvironments(params: { nowMs?: number; limit?: number } = {}): number {
      return write((db) =>
        pruneExpiredTerminalWorkerEnvironments({
          db,
          nowMs: params.nowMs ?? now(),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
        }),
      );
    },
    reconcileSharedHost(input: {
      environmentId: string;
      state: WorkerEnvironmentState;
      leaseId: string;
      sharedHost: boolean;
    }): WorkerEnvironmentRecord {
      const environmentId = required(input.environmentId, "id");
      const leaseId = required(input.leaseId, "lease id");
      return write((db) => {
        const current = getRequired(db, environmentId);
        if (current.state !== input.state || current.leaseId !== leaseId) {
          throw new Error(`Worker environment ${environmentId} lease changed during inspection`);
        }
        if (current.sharedHost === input.sharedHost) {
          return current;
        }
        // Provider inspection owns facts that may predate their durable column. Persist an
        // explicit value before tunnel startup so upgraded leases cannot keep stale isolation.
        return update(db, environmentId, current.state, {
          shared_host: input.sharedHost ? 1 : 0,
          updated_at_ms: now(),
        });
      });
    },
    adoptProvisionCleanupFailure(input: {
      environmentId: string;
      leaseId: string;
      lastError: string;
    }): WorkerEnvironmentRecord {
      const environmentId = required(input.environmentId, "id");
      const leaseId = required(input.leaseId, "lease id");
      const lastError = required(input.lastError, "last error");
      return write((db) => {
        const current = getRequired(db, environmentId);
        if (current.state !== "provisioning" || current.leaseId !== null) {
          throw new Error(`Worker environment ${environmentId} cannot adopt provision cleanup`);
        }
        const updatedAtMs = now();
        // Lease identity and teardown ownership must become durable together. A crash between
        // separate writes would make startup replay an operation whose fixed id may be terminal.
        return update(db, environmentId, current.state, {
          lease_id: leaseId,
          state: "destroying",
          updated_at_ms: updatedAtMs,
          state_changed_at_ms: updatedAtMs,
          destroy_requested_at_ms: current.destroyRequestedAtMs ?? updatedAtMs,
          teardown_terminal_state: current.teardownTerminalState ?? "failed",
          last_error: lastError,
        });
      });
    },
    requestDestroy(input: {
      environmentId: string;
      state: WorkerEnvironmentState;
      terminalState?: WorkerEnvironmentTeardownTerminalState;
      lastError?: string;
    }) {
      const environmentId = required(input.environmentId, "id");
      return write((db) => {
        const current = getRequired(db, environmentId);
        if (current.state !== input.state) {
          throw new Error(`Worker environment ${environmentId} changed before destroy request`);
        }
        if (current.destroyRequestedAtMs !== null) {
          return current;
        }
        const requestedAtMs = now();
        const terminalState = input.terminalState ?? "destroyed";
        return update(db, environmentId, input.state, {
          updated_at_ms: requestedAtMs,
          destroy_requested_at_ms: requestedAtMs,
          teardown_terminal_state: terminalState,
          ...(input.lastError === undefined
            ? {}
            : { last_error: required(input.lastError, "last error") }),
        });
      });
    },
    transition(input: TransitionInput): WorkerEnvironmentRecord {
      const { from, to, patch = {} } = input;
      if (!canTransitionWorkerEnvironment(from, to)) {
        throw new Error(`Illegal worker environment transition: ${from} -> ${to}`);
      }
      const environmentId = required(input.environmentId, "id");
      const updatedAtMs = now();
      return write((db) => {
        const current = getRequired(db, environmentId);
        if (current.state !== from) {
          throw new Error(
            `Worker environment ${environmentId} state conflict: expected ${from}, found ${current.state}`,
          );
        }
        if (
          input.expectedOwnerEpoch !== undefined &&
          current.ownerEpoch !== input.expectedOwnerEpoch
        ) {
          throw new Error(`Worker environment ${environmentId} owner epoch changed`);
        }
        if (to === "attached" && current.destroyRequestedAtMs !== null) {
          throw new Error("Cannot attach worker after destroy is requested");
        }
        // Terminal bootstrap failure is valid only after the service proves teardown;
        // explicit clearing prevents the state row from silently losing a paid lease.
        const clearsLeaseAfterTeardownFailure = to === "failed" && from === "destroying";
        if (
          clearsLeaseAfterTeardownFailure &&
          (current.destroyRequestedAtMs === null || current.teardownTerminalState !== "failed")
        ) {
          throw new Error("Failed bootstrap transition requires durable provider teardown intent");
        }
        if (
          clearsLeaseAfterTeardownFailure &&
          (patch.leaseId !== null || patch.sshEndpoint !== null)
        ) {
          throw new Error(
            "Failed bootstrap transition requires explicit lease clearing after provider teardown",
          );
        }
        const leaseId =
          patch.leaseId === undefined
            ? current.leaseId
            : patch.leaseId === null
              ? null
              : required(patch.leaseId, "lease id");
        if (current.leaseId && leaseId !== current.leaseId && !clearsLeaseAfterTeardownFailure) {
          throw new Error("Worker environment provider lease id is immutable once persisted");
        }
        const nodeDeviceId =
          patch.nodeDeviceId === undefined
            ? (current.nodeDeviceId ?? null)
            : patch.nodeDeviceId === null
              ? null
              : required(patch.nodeDeviceId, "node device id");
        if (
          current.nodeDeviceId &&
          nodeDeviceId !== current.nodeDeviceId &&
          !clearsLeaseAfterTeardownFailure
        ) {
          throw new Error("Worker environment node device id is immutable once persisted");
        }
        const sshEndpoint =
          patch.sshEndpoint === undefined
            ? current.sshEndpoint
            : patch.sshEndpoint === null
              ? null
              : normalizeWorkerSshEndpoint(patch.sshEndpoint);
        const sharedHost = leaseId === null ? null : (patch.sharedHost ?? current.sharedHost);
        const desktop =
          leaseId === null
            ? null
            : patch.desktop === undefined
              ? current.desktop
              : patch.desktop === null
                ? null
                : normalizeWorkerDesktopEndpoint(patch.desktop);
        const acceptsBootstrapReceipt =
          to === "ready" &&
          (from === "bootstrapping" || (from === "provisioning" && sshEndpoint === null));
        if (to === "ready" && !acceptsBootstrapReceipt) {
          throw new Error("Ready worker transition requires bootstrap proof or a node lease");
        }
        if (patch.bootstrapReceipt !== undefined && !acceptsBootstrapReceipt) {
          throw new Error("Bootstrap receipt can only be recorded when a worker becomes ready");
        }
        if (acceptsBootstrapReceipt && patch.bootstrapReceipt === undefined) {
          throw new Error("Ready worker transition requires a bootstrap receipt");
        }
        const acceptsAttachedCredential = to === "attached";
        const acceptsCredential = acceptsBootstrapReceipt || acceptsAttachedCredential;
        if (patch.credential !== undefined && !acceptsCredential) {
          throw new Error("Worker credential cannot be minted during this transition");
        }
        if (acceptsCredential && patch.credential === undefined) {
          throw new Error(
            `${to === "ready" ? "Ready" : "Attached"} worker transition requires a worker credential`,
          );
        }
        // Rebootstrap invalidates the old admission proof before remote mutation;
        // a crash therefore resumes in bootstrapping instead of advertising stale readiness.
        const clearsBootstrapReceipt =
          to === "bootstrapping" && (from === "ready" || from === "idle");
        const bootstrapReceipt = clearsBootstrapReceipt
          ? null
          : patch.bootstrapReceipt === undefined
            ? current.bootstrapReceipt
            : normalizeBootstrapReceipt(patch.bootstrapReceipt);
        if (acceptsCredential && !bootstrapReceipt) {
          throw new Error(
            `${to === "ready" ? "Ready" : "Attached"} worker requires bootstrap proof`,
          );
        }
        const attachedSessionIds =
          to !== "attached"
            ? []
            : patch.attachedSessionIds === undefined
              ? current.attachedSessionIds
              : normalizeAttachedSessionIds(patch.attachedSessionIds);
        assertShape(
          to,
          leaseId,
          nodeDeviceId,
          sshEndpoint,
          desktop,
          bootstrapReceipt,
          attachedSessionIds,
        );
        const [attachedSessionId] = attachedSessionIds;
        if (to === "attached" && attachedSessionId) {
          // Destroy-requested attachments retain physical cleanup scope, not live ownership.
          // Change session ownership atomically without discarding that old scope.
          const existingOwner = listRows(db, false).find(
            (record) =>
              record.environmentId !== environmentId &&
              record.state === "attached" &&
              record.destroyRequestedAtMs === null &&
              record.attachedSessionIds[0] === attachedSessionId,
          );
          if (existingOwner) {
            throw new WorkerSessionAlreadyAttachedError(
              attachedSessionId,
              existingOwner.environmentId,
            );
          }
        }
        const revokesCredential =
          clearsBootstrapReceipt ||
          to === "attached" ||
          (from === "attached" && to === "idle") ||
          to === "draining" ||
          to === "destroyed" ||
          to === "failed" ||
          to === "orphaned";
        const ownerEndingTransition =
          (from === "ready" || from === "idle" || from === "attached") &&
          (to === "bootstrapping" ||
            (from === "attached" && to === "idle") ||
            to === "draining" ||
            to === "destroyed" ||
            to === "failed" ||
            to === "orphaned");
        const ownerEpoch = acceptsBootstrapReceipt
          ? Math.max(1, current.ownerEpoch)
          : acceptsAttachedCredential || ownerEndingTransition
            ? nextGlobalOwnerEpoch(db)
            : current.ownerEpoch;
        updateRow(db, environmentId, from, {
          lease_id: leaseId,
          node_device_id: nodeDeviceId,
          shared_host: sharedHost === null ? null : sharedHost ? 1 : 0,
          ssh_host: sshEndpoint?.host ?? null,
          ssh_port: sshEndpoint?.port ?? null,
          ssh_user: sshEndpoint?.user ?? null,
          ssh_host_key: sshEndpoint?.hostKey ?? null,
          ssh_key_ref_json: sshEndpoint ? json(sshEndpoint.keyRef) : null,
          desktop_json: desktop ? json(desktop) : null,
          bootstrap_bundle_hash: bootstrapReceipt?.bundleHash ?? null,
          bootstrap_openclaw_version: bootstrapReceipt?.openclawVersion ?? null,
          bootstrap_protocol_features_json: bootstrapReceipt
            ? json(bootstrapReceipt.protocolFeatures)
            : null,
          bootstrap_install_kind: bootstrapReceipt?.installKind ?? null,
          owner_epoch: ownerEpoch,
          state: to,
          attached_session_ids_json: json(attachedSessionIds),
          updated_at_ms: updatedAtMs,
          state_changed_at_ms: updatedAtMs,
          idle_since_at_ms: to === "idle" ? updatedAtMs : null,
          last_error: "lastError" in patch ? patch.lastError?.trim() || null : null,
        });
        if (patch.sshEndpoint !== undefined) {
          replaceSshFallbackPorts(db, environmentId, sshEndpoint?.fallbackPorts ?? []);
        }
        if (revokesCredential) {
          revokeCredential(db, environmentId);
        }
        if (patch.credential && bootstrapReceipt) {
          upsertCredential(
            db,
            credentialInsert({
              input: patch.credential,
              environmentId,
              bundleHash: bootstrapReceipt.bundleHash,
              attachedSessionIds,
              ownerEpoch,
              nowMs: updatedAtMs,
            }),
          );
        }
        return getRequired(db, environmentId);
      });
    },
    renewCredential(
      input: CredentialInput & {
        environmentId: string;
        expectedOwnerEpoch: number;
      },
    ): WorkerCredentialRecord {
      return writeCredential(input);
    },
    markCredentialDelivered(input: {
      environmentId: string;
      credentialHash: string;
      ownerEpoch: number;
      sessionId: string | null;
      deliveredAtMs: number;
    }): void {
      const environmentId = required(input.environmentId, "id");
      return write((db) => {
        const environment = getRequired(db, environmentId);
        const credential = findCredential(db, environmentId);
        if (
          !credential ||
          (environment.state !== "ready" &&
            environment.state !== "idle" &&
            environment.state !== "attached") ||
          environment.destroyRequestedAtMs !== null ||
          credential.credentialHash !== normalizeCredentialHash(input.credentialHash) ||
          credential.ownerEpoch !== input.ownerEpoch ||
          environment.ownerEpoch !== input.ownerEpoch ||
          credential.sessionId !== normalizeSessionId(input.sessionId)
        ) {
          throw new Error(`Worker environment ${environmentId} credential changed`);
        }
        const deliveredAtMs = normalizeExpiry(input.deliveredAtMs);
        if (deliveredAtMs >= credential.expiresAtMs) {
          throw new Error("Expired worker credential cannot be marked delivered");
        }
        const result = executeSqliteQuerySync(
          db,
          query(db)
            .updateTable("worker_environment_credentials")
            .set({ delivered_at_ms: deliveredAtMs })
            .where("environment_id", "=", environmentId)
            .where("credential_hash", "=", credential.credentialHash)
            .where("owner_epoch", "=", credential.ownerEpoch),
        );
        if (result.numAffectedRows !== 1n) {
          throw new Error(`Worker environment ${environmentId} credential changed`);
        }
      });
    },
    recordError(input: { environmentId: string; state: WorkerEnvironmentState; error: string }) {
      return write((db) =>
        update(db, required(input.environmentId, "id"), input.state, {
          updated_at_ms: now(),
          last_error: required(input.error, "last error"),
        }),
      );
    },
  };
}

export type WorkerEnvironmentStore = ReturnType<typeof createWorkerEnvironmentStore>;
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
