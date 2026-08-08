import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  assertFactoryNativeAuthorityProof,
  assertFactoryNativeLaunchAuthority,
} from "./factory-authority-profile.js";
import type {
  SubagentRunRecord,
  SwarmLaunchAuthority,
  SwarmTerminalEvidence,
} from "./subagent-registry.types.js";

type SwarmReplayDatabase = Pick<OpenClawStateKyselyDatabase, "swarm_replay_launches">;
type SwarmReplayRow = Selectable<OpenClawStateKyselyDatabase["swarm_replay_launches"]>;

const SWARM_REPLAY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS swarm_replay_launches (
  requester_session_key TEXT NOT NULL,
  replay_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  public_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'accepted', 'terminal', 'failed', 'expired')),
  requester_session_id TEXT NOT NULL,
  requester_lifecycle_revision TEXT,
  child_session_key TEXT,
  agent_id TEXT,
  launch_identity_digest TEXT,
  authority_profile_id TEXT NOT NULL,
  authority_json TEXT NOT NULL,
  worktree_fence_token TEXT NOT NULL,
  worktree_ownership_generation INTEGER NOT NULL CHECK (worktree_ownership_generation > 0),
  cwd TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  terminal_evidence_json TEXT,
  failure_error TEXT,
  archive_at_ms INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (requester_session_key, replay_key),
  UNIQUE (public_run_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_swarm_replay_launches_expires
  ON swarm_replay_launches(expires_at, status, requester_session_key, replay_key);
`;

const ensuredDatabases = new WeakSet<DatabaseSync>();
const SWARM_REPLAY_RESERVATION_LEASE_MS = 30 * 60_000;
const SWARM_REPLAY_JOIN_TIMEOUT_MS = 30_000;
const SWARM_REPLAY_JOIN_POLL_MS = 25;
export const SWARM_REPLAY_RESULT_RETENTION_HORIZON_MS = 5 * 60_000;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type SwarmReplayReservationInput = {
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterLifecycleRevision?: string;
  replayKey: string;
  requestFingerprint: `sha256:${string}`;
  publicRunId: string;
  authority: SwarmLaunchAuthority;
};

export type SwarmReplayAcceptedIdentity = {
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterLifecycleRevision?: string;
  replayKey: string;
  requestFingerprint: `sha256:${string}`;
  runId: string;
  sessionKey: string;
  agentId: string;
  launchIdentityDigest: `sha256:${string}`;
  authority: SwarmLaunchAuthority;
};

export type SwarmReplayLaunchRecord = {
  status: "reserved" | "accepted" | "terminal" | "failed" | "expired";
  identity: Omit<SwarmReplayAcceptedIdentity, "sessionKey" | "agentId" | "launchIdentityDigest"> & {
    sessionKey?: string;
    agentId?: string;
    launchIdentityDigest?: `sha256:${string}`;
  };
  terminalEvidence?: SwarmTerminalEvidence;
  failureError?: string;
  archiveAtMs?: number;
  expiresAt?: number;
};

export type SwarmReplayReservationResult =
  | { status: "owner"; runId: string }
  | { status: "pending"; runId: string }
  | { status: "accepted"; identity: SwarmReplayAcceptedIdentity; terminal: boolean }
  | { status: "failed"; error: string }
  | { status: "expired"; runId: string }
  | { status: "conflict"; error: string };

export function hashSwarmEvidenceBytes(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function buildSwarmReplayRunId(requesterSessionKey: string, replayKey: string): string {
  return `swarm_${createHash("sha256")
    .update(JSON.stringify([requesterSessionKey, replayKey]))
    .digest("hex")
    .slice(0, 32)}`;
}

export function buildSwarmLaunchIdentityDigest(params: {
  runId: string;
  sessionKey: string;
  agentId: string;
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterLifecycleRevision?: string;
  replayKey: string;
  requestFingerprint: string;
  authority: SwarmLaunchAuthority;
}): `sha256:${string}` {
  return hashSwarmEvidenceBytes(
    stableStringify({
      contractVersion: 1,
      runId: params.runId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      requesterSessionKey: params.requesterSessionKey,
      requesterSessionId: params.requesterSessionId,
      ...(params.requesterLifecycleRevision
        ? { requesterLifecycleRevision: params.requesterLifecycleRevision }
        : {}),
      replayKey: params.replayKey,
      requestFingerprint: params.requestFingerprint,
      authority: params.authority,
    }),
  );
}

function ensureSwarmReplaySchema(database: OpenClawStateDatabase): void {
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  // sqlite-allow-raw -- feature-local additive schema DDL; all row access uses Kysely.
  database.db.exec(SWARM_REPLAY_SCHEMA_SQL);
  ensuredDatabases.add(database.db);
}

function openSwarmReplayDatabase(options: OpenClawStateDatabaseOptions = {}) {
  const database = openOpenClawStateDatabase(options);
  if (!ensuredDatabases.has(database.db)) {
    runOpenClawStateWriteTransaction(
      (transactionDatabase) => ensureSwarmReplaySchema(transactionDatabase),
      options,
      { operationLabel: "swarm.replay.schema.ensure" },
    );
  }
  return database;
}

function rowAuthority(row: SwarmReplayRow): SwarmLaunchAuthority {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.authority_json) as unknown;
  } catch {
    throw new Error("persisted collector authority profile is invalid");
  }
  const authority = assertFactoryNativeLaunchAuthority(parsed);
  if (
    stableStringify(authority) !== row.authority_json ||
    authority.authorityProfileId !== row.authority_profile_id ||
    authority.worktreeFenceToken !== row.worktree_fence_token ||
    authority.worktreeOwnershipGeneration !== row.worktree_ownership_generation ||
    authority.cwd !== row.cwd ||
    authority.workspaceRoot !== row.workspace_root
  ) {
    throw new Error("persisted collector authority profile is invalid");
  }
  return authority;
}

function rowMatchesReservation(row: SwarmReplayRow, input: SwarmReplayReservationInput): boolean {
  return (
    row.requester_session_key === input.requesterSessionKey &&
    row.replay_key === input.replayKey &&
    row.request_fingerprint === input.requestFingerprint &&
    row.public_run_id === input.publicRunId &&
    row.requester_session_id === input.requesterSessionId &&
    (row.requester_lifecycle_revision ?? undefined) === input.requesterLifecycleRevision &&
    stableStringify(rowAuthority(row)) === stableStringify(input.authority)
  );
}

function acceptedIdentityFromRow(row: SwarmReplayRow): SwarmReplayAcceptedIdentity | undefined {
  if (
    !row.child_session_key ||
    !row.agent_id ||
    !row.launch_identity_digest ||
    !SHA256_PATTERN.test(row.request_fingerprint) ||
    !SHA256_PATTERN.test(row.launch_identity_digest)
  ) {
    return undefined;
  }
  return {
    requesterSessionKey: row.requester_session_key,
    requesterSessionId: row.requester_session_id,
    ...(row.requester_lifecycle_revision
      ? { requesterLifecycleRevision: row.requester_lifecycle_revision }
      : {}),
    replayKey: row.replay_key,
    requestFingerprint: row.request_fingerprint as `sha256:${string}`,
    runId: row.public_run_id,
    sessionKey: row.child_session_key,
    agentId: row.agent_id,
    launchIdentityDigest: row.launch_identity_digest as `sha256:${string}`,
    authority: rowAuthority(row),
  };
}

function parseTerminalEvidence(row: SwarmReplayRow): SwarmTerminalEvidence | undefined {
  if (!row.terminal_evidence_json) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.terminal_evidence_json) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    parsed.evidenceContractVersion !== 1 ||
    typeof parsed.launchIdentityDigest !== "string" ||
    typeof parsed.runId !== "string" ||
    typeof parsed.sessionKey !== "string" ||
    typeof parsed.agentId !== "string" ||
    typeof parsed.requesterSessionKey !== "string" ||
    typeof parsed.requesterSessionId !== "string" ||
    typeof parsed.replayKey !== "string" ||
    typeof parsed.requestFingerprint !== "string" ||
    typeof parsed.schemaContractVersion !== "string" ||
    typeof parsed.schemaCanonicalJson !== "string" ||
    typeof parsed.schemaHash !== "string" ||
    typeof parsed.endedAt !== "number" ||
    typeof parsed.frozenAt !== "number" ||
    !isRecord(parsed.authority) ||
    !isRecord(parsed.outcome) ||
    !isRecord(parsed.runtime)
  ) {
    return undefined;
  }
  const evidence = parsed as SwarmTerminalEvidence;
  const accepted = acceptedIdentityFromRow(row);
  if (
    !accepted ||
    stableStringify(evidence) !== row.terminal_evidence_json ||
    evidence.launchIdentityDigest !== accepted.launchIdentityDigest ||
    evidence.runId !== accepted.runId ||
    evidence.sessionKey !== accepted.sessionKey ||
    evidence.agentId !== accepted.agentId ||
    evidence.requesterSessionKey !== accepted.requesterSessionKey ||
    evidence.requesterSessionId !== accepted.requesterSessionId ||
    evidence.requesterLifecycleRevision !== accepted.requesterLifecycleRevision ||
    evidence.replayKey !== accepted.replayKey ||
    evidence.requestFingerprint !== accepted.requestFingerprint ||
    stableStringify(evidence.authority) !== stableStringify(accepted.authority) ||
    evidence.schemaContractVersion !== "openclaw/agent-structured-result/v1" ||
    hashSwarmEvidenceBytes(evidence.schemaCanonicalJson) !== evidence.schemaHash
  ) {
    return undefined;
  }
  if (
    evidence.result &&
    hashSwarmEvidenceBytes(evidence.result.canonicalJson) !== evidence.result.contentHash
  ) {
    return undefined;
  }
  if (!evidence.runtime.authorityProof) {
    return evidence.outcome.status === "done" ? undefined : evidence;
  }
  try {
    assertFactoryNativeAuthorityProof({
      binding: {
        runId: accepted.runId,
        launchIdentityDigest: accepted.launchIdentityDigest,
        authority: accepted.authority,
      },
      proof: evidence.runtime.authorityProof,
    });
  } catch {
    return undefined;
  }
  return evidence;
}

function reservationResultFromRow(row: SwarmReplayRow): SwarmReplayReservationResult {
  if (row.status === "expired") {
    return { status: "expired", runId: row.public_run_id };
  }
  if (row.status === "failed") {
    return { status: "failed", error: row.failure_error || "collector launch failed" };
  }
  if (row.status === "accepted" || row.status === "terminal") {
    const identity = acceptedIdentityFromRow(row);
    return identity
      ? { status: "accepted", identity, terminal: row.status === "terminal" }
      : { status: "conflict", error: "persisted collector identity is incomplete" };
  }
  return { status: "pending", runId: row.public_run_id };
}

/** Atomically reserves a requester-scoped replay key before any asynchronous launch work. */
export function reserveSwarmReplayLaunch(
  input: SwarmReplayReservationInput,
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): SwarmReplayReservationResult {
  openSwarmReplayDatabase(options);
  const now = options.now ?? Date.now();
  return runOpenClawStateWriteTransaction(
    (database) => {
      ensureSwarmReplaySchema(database);
      const sqlite = database.db;
      const db = getNodeSqliteKysely<SwarmReplayDatabase>(sqlite);
      const select = () =>
        executeSqliteQueryTakeFirstSync(
          sqlite,
          db
            .selectFrom("swarm_replay_launches")
            .selectAll()
            .where("requester_session_key", "=", input.requesterSessionKey)
            .where("replay_key", "=", input.replayKey),
        );
      let existing = select();
      if (
        existing?.expires_at !== null &&
        existing?.expires_at !== undefined &&
        existing.expires_at <= now &&
        existing.status !== "accepted" &&
        existing.status !== "expired"
      ) {
        executeSqliteQuerySync(
          sqlite,
          db
            .updateTable("swarm_replay_launches")
            .set({
              status: "expired",
              terminal_evidence_json: null,
              failure_error: null,
              archive_at_ms: null,
              updated_at: now,
            })
            .where("requester_session_key", "=", input.requesterSessionKey)
            .where("replay_key", "=", input.replayKey)
            .where("updated_at", "=", existing.updated_at)
            .where("expires_at", "<=", now),
        );
        existing = select();
      }
      if (existing) {
        return rowMatchesReservation(existing, input)
          ? reservationResultFromRow(existing)
          : { status: "conflict" as const, error: "replay key is bound to a different request" };
      }
      const inserted = executeSqliteQuerySync(
        sqlite,
        db
          .insertInto("swarm_replay_launches")
          .values({
            requester_session_key: input.requesterSessionKey,
            replay_key: input.replayKey,
            request_fingerprint: input.requestFingerprint,
            public_run_id: input.publicRunId,
            status: "reserved",
            requester_session_id: input.requesterSessionId,
            requester_lifecycle_revision: input.requesterLifecycleRevision ?? null,
            child_session_key: null,
            agent_id: null,
            launch_identity_digest: null,
            authority_profile_id: input.authority.authorityProfileId,
            authority_json: stableStringify(input.authority),
            worktree_fence_token: input.authority.worktreeFenceToken,
            worktree_ownership_generation: input.authority.worktreeOwnershipGeneration,
            cwd: input.authority.cwd,
            workspace_root: input.authority.workspaceRoot,
            terminal_evidence_json: null,
            failure_error: null,
            archive_at_ms: null,
            created_at: now,
            updated_at: now,
            expires_at: now + SWARM_REPLAY_RESERVATION_LEASE_MS,
          })
          .onConflict((conflict) =>
            conflict.columns(["requester_session_key", "replay_key"]).doNothing(),
          ),
      );
      const row = select();
      if (!row || !rowMatchesReservation(row, input)) {
        return { status: "conflict", error: "replay key is bound to a different request" };
      }
      return inserted.numAffectedRows === 1n
        ? { status: "owner", runId: input.publicRunId }
        : reservationResultFromRow(row);
    },
    options,
    { operationLabel: "swarm.replay.reserve" },
  );
}

/** Reads a replay launch and verifies any producer-frozen terminal evidence. */
export function readSwarmReplayLaunch(
  requesterSessionKey: string,
  replayKey: string,
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): SwarmReplayLaunchRecord | undefined {
  const state = openSwarmReplayDatabase(options);
  const db = getNodeSqliteKysely<SwarmReplayDatabase>(state.db);
  const select = () =>
    executeSqliteQueryTakeFirstSync(
      state.db,
      db
        .selectFrom("swarm_replay_launches")
        .selectAll()
        .where("requester_session_key", "=", requesterSessionKey)
        .where("replay_key", "=", replayKey),
    );
  let row = select();
  const now = options.now ?? Date.now();
  if (
    row?.expires_at !== null &&
    row?.expires_at !== undefined &&
    row.expires_at <= now &&
    row.status !== "accepted" &&
    row.status !== "expired"
  ) {
    runOpenClawStateWriteTransaction(
      ({ db: sqlite }) => {
        const transactionDb = getNodeSqliteKysely<SwarmReplayDatabase>(sqlite);
        executeSqliteQuerySync(
          sqlite,
          transactionDb
            .updateTable("swarm_replay_launches")
            .set({
              status: "expired",
              terminal_evidence_json: null,
              failure_error: null,
              archive_at_ms: null,
              updated_at: now,
            })
            .where("requester_session_key", "=", requesterSessionKey)
            .where("replay_key", "=", replayKey)
            .where("expires_at", "<=", now)
            .where("status", "!=", "accepted")
            .where("status", "!=", "expired"),
        );
      },
      { database: state },
      { operationLabel: "swarm.replay.expire" },
    );
    row = select();
  }
  if (!row || !SHA256_PATTERN.test(row.request_fingerprint)) {
    return undefined;
  }
  const identity = acceptedIdentityFromRow(row);
  const terminalEvidence = row.status === "terminal" ? parseTerminalEvidence(row) : undefined;
  if (row.status === "terminal" && !terminalEvidence) {
    return undefined;
  }
  return {
    status:
      row.status === "accepted" ||
      row.status === "terminal" ||
      row.status === "failed" ||
      row.status === "expired"
        ? row.status
        : "reserved",
    identity: {
      requesterSessionKey: row.requester_session_key,
      requesterSessionId: row.requester_session_id,
      ...(row.requester_lifecycle_revision
        ? { requesterLifecycleRevision: row.requester_lifecycle_revision }
        : {}),
      replayKey: row.replay_key,
      requestFingerprint: row.request_fingerprint as `sha256:${string}`,
      runId: row.public_run_id,
      ...(identity
        ? {
            sessionKey: identity.sessionKey,
            agentId: identity.agentId,
            launchIdentityDigest: identity.launchIdentityDigest,
          }
        : {}),
      authority: rowAuthority(row),
    },
    ...(terminalEvidence ? { terminalEvidence } : {}),
    ...(row.failure_error ? { failureError: row.failure_error } : {}),
    ...(row.archive_at_ms !== null ? { archiveAtMs: row.archive_at_ms } : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
  };
}

/** Waits for the owner of an identical concurrent reservation to publish its identity. */
export async function waitForSwarmReplayLaunch(params: {
  requesterSessionKey: string;
  replayKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<SwarmReplayReservationResult> {
  const deadline = Date.now() + (params.timeoutMs ?? SWARM_REPLAY_JOIN_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (params.signal?.aborted) {
      return { status: "failed", error: "collector replay wait was aborted" };
    }
    const row = readSwarmReplayLaunch(params.requesterSessionKey, params.replayKey);
    if (!row) {
      return { status: "failed", error: "collector replay reservation disappeared" };
    }
    if (row.status === "failed") {
      return { status: "failed", error: row.failureError || "collector launch failed" };
    }
    if (row.status === "expired") {
      return { status: "expired", runId: row.identity.runId };
    }
    if (row.status === "accepted" || row.status === "terminal") {
      const identity = row.identity;
      if (identity.sessionKey && identity.agentId && identity.launchIdentityDigest) {
        return {
          status: "accepted",
          terminal: row.status === "terminal",
          identity: {
            ...identity,
            sessionKey: identity.sessionKey,
            agentId: identity.agentId,
            launchIdentityDigest: identity.launchIdentityDigest,
          },
        };
      }
      return { status: "conflict", error: "persisted collector identity is incomplete" };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SWARM_REPLAY_JOIN_POLL_MS));
  }
  return { status: "failed", error: "timed out waiting for the accepted collector identity" };
}

/** Seals a failed owner reservation so identical retries observe one deterministic outcome. */
export function failSwarmReplayLaunch(params: {
  requesterSessionKey: string;
  replayKey: string;
  requestFingerprint: string;
  error: string;
  now?: number;
}): void {
  const state = openSwarmReplayDatabase();
  const now = params.now ?? Date.now();
  runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      const db = getNodeSqliteKysely<SwarmReplayDatabase>(sqlite);
      executeSqliteQuerySync(
        sqlite,
        db
          .updateTable("swarm_replay_launches")
          .set({
            status: "failed",
            failure_error: params.error.slice(0, 2_000),
            updated_at: now,
            expires_at: now + SWARM_REPLAY_RESULT_RETENTION_HORIZON_MS,
          })
          .where("requester_session_key", "=", params.requesterSessionKey)
          .where("replay_key", "=", params.replayKey)
          .where("request_fingerprint", "=", params.requestFingerprint)
          .where("status", "=", "reserved"),
      );
    },
    { database: state },
    { operationLabel: "swarm.replay.fail" },
  );
}

function assertReplayEntryMatchesRow(entry: SubagentRunRecord, row: SwarmReplayRow): void {
  const authority = entry.swarmLaunchAuthority;
  const publicRunId = entry.swarmRunId ?? entry.runId;
  if (
    !authority ||
    !entry.swarmRequesterSessionId ||
    !entry.swarmLaunchIdentityDigest ||
    row.public_run_id !== publicRunId ||
    row.request_fingerprint !== entry.swarmLaunchRequestFingerprint ||
    row.requester_session_id !== entry.swarmRequesterSessionId ||
    (row.requester_lifecycle_revision ?? undefined) !== entry.swarmRequesterLifecycleRevision ||
    stableStringify(rowAuthority(row)) !== stableStringify(authority)
  ) {
    throw new Error("collector replay reservation does not match the registered launch");
  }
  const expectedDigest = buildSwarmLaunchIdentityDigest({
    runId: publicRunId,
    sessionKey: entry.childSessionKey,
    agentId: resolveAgentIdFromSessionKey(entry.childSessionKey),
    requesterSessionKey: row.requester_session_key,
    requesterSessionId: row.requester_session_id,
    ...(row.requester_lifecycle_revision
      ? { requesterLifecycleRevision: row.requester_lifecycle_revision }
      : {}),
    replayKey: row.replay_key,
    requestFingerprint: row.request_fingerprint,
    authority,
  });
  if (entry.swarmLaunchIdentityDigest !== expectedDigest) {
    throw new Error("collector launch identity digest does not match the registered launch");
  }
}

/** Commits accepted identity and immutable terminal evidence inside the registry transaction. */
export function syncSwarmReplayRunInTransaction(
  database: OpenClawStateDatabase,
  entry: SubagentRunRecord,
): void {
  const replayKey = entry.swarmLaunchReplayKey?.trim();
  const requestFingerprint = entry.swarmLaunchRequestFingerprint?.trim();
  if (!entry.collect || !replayKey || !requestFingerprint) {
    return;
  }
  ensureSwarmReplaySchema(database);
  const db = getNodeSqliteKysely<SwarmReplayDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("swarm_replay_launches")
      .selectAll()
      .where(
        "requester_session_key",
        "=",
        entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
      )
      .where("replay_key", "=", replayKey),
  );
  // Only the host RPC creates replay ledger rows. Internal collector callers
  // without a host reservation retain their existing registry-only behavior.
  if (!row) {
    return;
  }
  assertReplayEntryMatchesRow(entry, row);
  if (row.status === "failed" || row.status === "expired") {
    throw new Error(`collector replay reservation was already sealed as ${row.status}`);
  }
  const agentId = resolveAgentIdFromSessionKey(entry.childSessionKey);
  if (!agentId) {
    throw new Error("collector child session does not contain an agent identity");
  }
  if (
    row.child_session_key &&
    (row.child_session_key !== entry.childSessionKey ||
      row.agent_id !== agentId ||
      row.launch_identity_digest !== entry.swarmLaunchIdentityDigest)
  ) {
    throw new Error("collector replay identity is immutable after acceptance");
  }
  const now = Date.now();
  const terminalJson = entry.swarmTerminalEvidence
    ? stableStringify(entry.swarmTerminalEvidence)
    : undefined;
  if (row.terminal_evidence_json && row.terminal_evidence_json !== terminalJson) {
    throw new Error("collector terminal evidence is immutable after completion");
  }
  const terminal = terminalJson !== undefined;
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("swarm_replay_launches")
      .set({
        status: terminal ? "terminal" : "accepted",
        child_session_key: entry.childSessionKey,
        agent_id: agentId,
        launch_identity_digest: entry.swarmLaunchIdentityDigest,
        terminal_evidence_json: terminalJson ?? row.terminal_evidence_json,
        failure_error: null,
        archive_at_ms: entry.archiveAtMs ?? null,
        updated_at: now,
        expires_at: terminal
          ? entry.archiveAtMs !== undefined
            ? entry.archiveAtMs + SWARM_REPLAY_RESULT_RETENTION_HORIZON_MS
            : null
          : null,
      })
      .where("requester_session_key", "=", row.requester_session_key)
      .where("replay_key", "=", row.replay_key)
      .where("request_fingerprint", "=", row.request_fingerprint),
  );
}
