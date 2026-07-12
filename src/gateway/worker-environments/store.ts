import type { DatabaseSync } from "node:sqlite";
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
import type { WorkerProfile, WorkerSshEndpoint } from "../../plugins/types.js";
import { isValidSecretRef } from "../../secrets/ref-contract.js";
import type {
  DB as StateDatabase,
  WorkerEnvironmentCredentials,
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

export type WorkerEnvironmentProfileSnapshot = WorkerProfile;
export type WorkerEnvironmentSshEndpoint = WorkerSshEndpoint;
export type WorkerEnvironmentBootstrapReceipt = WorkerAdmissionHandshake;
export type WorkerEnvironmentTeardownTerminalState = "destroyed" | "failed";
type RecordIdentity = { environmentId: string; providerId: string; profileId: string };
type RecordBase = RecordIdentity & {
  profileSnapshot: WorkerEnvironmentProfileSnapshot;
  provisionOperationId: string;
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
type UnleasedRecord = { state: WorkerEnvironmentUnleasedState; leaseId: null; sshEndpoint: null };
type LeasedRecord = { state: WorkerEnvironmentLeasedState; leaseId: string; sshEndpoint: Ssh };
export type WorkerEnvironmentRecord = RecordBase & (UnleasedRecord | LeasedRecord);
export type WorkerEnvironmentTransitionPatch = {
  leaseId?: string | null;
  sshEndpoint?: WorkerEnvironmentSshEndpoint | null;
  bootstrapReceipt?: WorkerEnvironmentBootstrapReceipt;
  attachedSessionIds?: readonly string[];
  lastError?: string | null;
  credential?: CredentialInput;
};
type WorkerDb = Pick<
  StateDatabase,
  "worker_environment_credentials" | "worker_environments" | "worker_transcript_commit_heads"
>;
type Row = Selectable<WorkerEnvironments>;
type RowUpdate = Updateable<WorkerEnvironments>;
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
  return {
    bundleHash,
    openclawVersion: required(value.openclawVersion, "bootstrap OpenClaw version"),
    protocolFeatures: normalizeSortedUniqueTrimmedStringList(value.protocolFeatures),
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
  return { host, port: value.port, user, hostKey, keyRef: { ...value.keyRef } };
}
function endpointFrom(row: Row): Ssh | null {
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
    user,
    hostKey,
    keyRef: JSON.parse(encoded) as Ssh["keyRef"],
  });
}
function bootstrapReceiptFrom(row: Row): WorkerEnvironmentBootstrapReceipt | null {
  const {
    bootstrap_bundle_hash: bundleHash,
    bootstrap_openclaw_version: openclawVersion,
    bootstrap_protocol_features_json: encodedFeatures,
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
  });
}
function assertShape(
  state: WorkerEnvironmentState,
  leaseId: string | null,
  sshEndpoint: Ssh | null,
  bootstrapReceipt: WorkerEnvironmentBootstrapReceipt | null,
  attachedSessionIds: readonly string[],
): void {
  if (workerEnvironmentStateRequiresLease(state)) {
    if (!leaseId) {
      throw new Error(`Worker environment state ${state} requires a provider lease`);
    }
    if (!sshEndpoint) {
      throw new Error("Worker environment provider lease requires an SSH endpoint reference");
    }
  } else if (leaseId || sshEndpoint) {
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
function fromRow(row: Row): WorkerEnvironmentRecord {
  const record = {
    environmentId: row.environment_id,
    providerId: row.provider_id,
    profileId: row.profile_id,
    profileSnapshot: JSON.parse(row.profile_snapshot_json) as WorkerEnvironmentProfileSnapshot,
    provisionOperationId: row.provision_operation_id,
    leaseId: row.lease_id,
    sshEndpoint: endpointFrom(row),
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
    record.sshEndpoint,
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
function find(db: DatabaseSync, environmentId: string) {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("worker_environments")
      .selectAll()
      .where("environment_id", "=", environmentId),
  );
  return row ? fromRow(row) : undefined;
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
function getRequired(db: DatabaseSync, environmentId: string) {
  const record = find(db, environmentId);
  if (!record) {
    throw new Error(`Unknown worker environment: ${environmentId}`);
  }
  return record;
}
function update(db: DatabaseSync, id: string, state: WorkerEnvironmentState, values: RowUpdate) {
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
  return getRequired(db, id);
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
  const base = query(db).selectFrom("worker_environments").selectAll();
  const filtered = reconcile ? base.where("state", "not in", TERMINAL_STATES) : base;
  const ordered = reconcile ? filtered.orderBy("provider_id") : filtered;
  return executeSqliteQuerySync(
    db,
    ordered.orderBy("created_at_ms").orderBy("environment_id"),
  ).rows.map(fromRow);
}

export function createWorkerEnvironmentStore(
  options: { database?: OpenClawStateDatabase; now?: () => number } = {},
) {
  const path = (options.database ?? openOpenClawStateDatabase()).path;
  const now = options.now ?? Date.now;
  const read = () => openOpenClawStateDatabase({ path }).db;
  const write = <T>(operation: (db: DatabaseSync) => T): T =>
    runOpenClawStateWriteTransaction(({ db }) => operation(db), { path });
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
              ssh_host: null,
              ssh_port: null,
              ssh_user: null,
              ssh_host_key: null,
              ssh_key_ref_json: null,
              bootstrap_bundle_hash: null,
              bootstrap_openclaw_version: null,
              bootstrap_protocol_features_json: null,
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
    getCredential: (environmentId: string) => findCredential(read(), required(environmentId, "id")),
    findCredentialByHash: (credentialHash: string) =>
      findCredentialByHash(read(), normalizeCredentialHash(credentialHash)),
    list: (): WorkerEnvironmentRecord[] => listRows(read(), false),
    listForReconcile: (): WorkerEnvironmentRecord[] => listRows(read(), true),
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
        const sshEndpoint =
          patch.sshEndpoint === undefined
            ? current.sshEndpoint
            : patch.sshEndpoint === null
              ? null
              : normalizeWorkerSshEndpoint(patch.sshEndpoint);
        const acceptsBootstrapReceipt = from === "bootstrapping" && to === "ready";
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
        assertShape(to, leaseId, sshEndpoint, bootstrapReceipt, attachedSessionIds);
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
        const record = update(db, environmentId, from, {
          lease_id: leaseId,
          ssh_host: sshEndpoint?.host ?? null,
          ssh_port: sshEndpoint?.port ?? null,
          ssh_user: sshEndpoint?.user ?? null,
          ssh_host_key: sshEndpoint?.hostKey ?? null,
          ssh_key_ref_json: sshEndpoint ? json(sshEndpoint.keyRef) : null,
          bootstrap_bundle_hash: bootstrapReceipt?.bundleHash ?? null,
          bootstrap_openclaw_version: bootstrapReceipt?.openclawVersion ?? null,
          bootstrap_protocol_features_json: bootstrapReceipt
            ? json(bootstrapReceipt.protocolFeatures)
            : null,
          owner_epoch: ownerEpoch,
          state: to,
          attached_session_ids_json: json(attachedSessionIds),
          updated_at_ms: updatedAtMs,
          state_changed_at_ms: updatedAtMs,
          idle_since_at_ms: to === "idle" ? updatedAtMs : null,
          last_error: "lastError" in patch ? patch.lastError?.trim() || null : null,
        });
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
        return record;
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
