import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MemoryOperation } from "openclaw/plugin-sdk/memory-authorization";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  resolveScopedMemoryArtifactBase,
  type MemoryPolicyEntryRow,
  type ScopedMemoryActorKind,
  type ScopedMemoryDatabase,
  type ScopedMemoryScopeKind,
  withScopedMemoryDatabase,
} from "./scoped-memory-db.js";

const OPAQUE_PATH_KEY_VERSION = 1;
const OPAQUE_PATH_ATTEMPTS = 8;
const OPAQUE_PATH_KEY_PATTERN = /^s1_[A-Za-z0-9_-]{24,}$/u;

export type ScopedMemoryActor = Readonly<{ kind: ScopedMemoryActorKind; id?: string }>;
export type ScopedMemoryPolicyEntryInput = Readonly<{
  kind?: MemoryPolicyEntryRow["entry_kind"];
  effect: MemoryPolicyEntryRow["effect"];
  principalId: string;
  audienceKind?: MemoryPolicyEntryRow["audience_kind"];
  audienceId?: string;
  operation: MemoryOperation;
  grantorPrincipalId: string;
  reason: string;
  expiresAt?: number;
}>;

export type BuiltinScopedMemoryStore = Readonly<{
  storageRootId: string;
  storeId: string;
  policyId: string;
  policyRevisionId: string;
  policyRevocationEpoch: number;
  sourcePolicySetId: string;
}>;

type OpaqueDirectoryDependencies = Readonly<{
  generatePathKey?: () => string;
  mkdir?: typeof fs.mkdirSync;
}>;

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createOpaquePathKey(): string {
  return `s1_${randomBytes(24).toString("base64url")}`;
}

function assertOpaquePathKey(pathKey: string): void {
  if (!OPAQUE_PATH_KEY_PATTERN.test(pathKey)) {
    throw new Error("generated scoped-memory path key is invalid");
  }
}

function resolveChildPath(base: string, child: string): string {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, child);
  if (path.dirname(resolved) !== resolvedBase || path.basename(resolved) !== child) {
    throw new Error("scoped-memory locator escaped its storage root");
  }
  return resolved;
}

/** Create one exclusive CSPRNG directory; collisions retry with a fresh opaque key. */
export function createOpaqueScopedMemoryDirectory(
  baseDir: string,
  dependencies: OpaqueDirectoryDependencies = {},
): { directoryPath: string; pathKey: string } {
  const mkdir = dependencies.mkdir ?? fs.mkdirSync;
  mkdir(baseDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < OPAQUE_PATH_ATTEMPTS; attempt += 1) {
    const pathKey = dependencies.generatePathKey?.() ?? createOpaquePathKey();
    assertOpaquePathKey(pathKey);
    const directoryPath = resolveChildPath(baseDir, pathKey);
    try {
      mkdir(directoryPath, { recursive: false, mode: 0o700 });
      return { directoryPath, pathKey };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error("could not allocate an opaque scoped-memory directory");
}

export function normalizeScopedMemoryRequiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0")) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function normalizeCapabilities(capabilities: readonly MemoryOperation[]): MemoryOperation[] {
  return [...new Set(capabilities)].toSorted();
}

export function createScopedMemorySourcePolicySetId(policyRevisionId: string): string {
  return `mps1_${hashText(`v1\0${policyRevisionId}`)}`;
}

function removeEmptyDirectory(directoryPath: string): void {
  try {
    fs.rmdirSync(directoryPath);
  } catch {}
}

function assertNoDirectPrivateUserPublish(params: {
  scopeKind: ScopedMemoryScopeKind;
  audienceKind: ScopedMemoryScopeKind;
  audienceId: string;
  authorityKind: ScopedMemoryScopeKind;
  authorityOwnerId: string;
  entries: readonly ScopedMemoryPolicyEntryInput[];
}): void {
  // Private user stores are self-owned in the first product. Allowing a different user here
  // would turn policy mutation into unreviewed Alice-to-Bob private-memory publication.
  if (params.scopeKind === "user") {
    if (
      params.audienceKind !== "user" ||
      params.authorityKind !== "user" ||
      params.audienceId !== params.authorityOwnerId
    ) {
      throw new Error("private user scoped memory must be owned and addressed by the same user");
    }
    if (
      params.entries.some(
        (entry) => entry.effect === "allow" && entry.principalId !== params.authorityOwnerId,
      )
    ) {
      throw new Error("direct private user-to-user memory publishing is unavailable");
    }
  }
}

function normalizeEntries(params: {
  entries: readonly ScopedMemoryPolicyEntryInput[];
  policyRevisionId: string;
  defaultAudienceKind: ScopedMemoryScopeKind | "*";
  defaultAudienceId: string;
  nowMs: number;
}) {
  return params.entries.map((entry) => ({
    entry_id: randomUUID(),
    policy_revision_id: params.policyRevisionId,
    entry_kind: entry.kind ?? "exception",
    effect: entry.effect,
    principal_id: normalizeScopedMemoryRequiredText(entry.principalId, "policy principalId"),
    audience_kind: entry.audienceKind ?? params.defaultAudienceKind,
    audience_id: normalizeScopedMemoryRequiredText(
      entry.audienceId ?? params.defaultAudienceId,
      "policy audienceId",
    ),
    operation: entry.operation,
    grantor_principal_id: normalizeScopedMemoryRequiredText(
      entry.grantorPrincipalId,
      "policy grantorPrincipalId",
    ),
    reason: normalizeScopedMemoryRequiredText(entry.reason, "policy reason"),
    expires_at: entry.expiresAt ?? null,
    created_at: params.nowMs,
  }));
}

/** Register one builtin logical store without putting authority identities in its path. */
export function createBuiltinScopedMemoryStore(params: {
  agentId: string;
  scopeKind: ScopedMemoryScopeKind;
  audienceKind: ScopedMemoryScopeKind;
  audienceId: string;
  authorityKind: ScopedMemoryScopeKind;
  authorityOwnerId: string;
  defaultCapabilities: readonly MemoryOperation[];
  policyEntries?: readonly ScopedMemoryPolicyEntryInput[];
  actor: ScopedMemoryActor;
  reason: string;
  nowMs?: number;
}): BuiltinScopedMemoryStore {
  const agentId = normalizeAgentId(params.agentId);
  const audienceId = normalizeScopedMemoryRequiredText(params.audienceId, "audienceId");
  const authorityOwnerId = normalizeScopedMemoryRequiredText(
    params.authorityOwnerId,
    "authorityOwnerId",
  );
  const entries = params.policyEntries ?? [];
  assertNoDirectPrivateUserPublish({
    scopeKind: params.scopeKind,
    audienceKind: params.audienceKind,
    audienceId,
    authorityKind: params.authorityKind,
    authorityOwnerId,
    entries,
  });
  const reason = normalizeScopedMemoryRequiredText(params.reason, "reason");
  const nowMs = params.nowMs ?? Date.now();
  const storageRootId = randomUUID();
  const storeId = randomUUID();
  const policyId = randomUUID();
  const policyRevisionId = randomUUID();
  const policyRevocationEpoch = 0;
  const policySetId = createScopedMemorySourcePolicySetId(policyRevisionId);

  return withScopedMemoryDatabase(agentId, (database, databasePath) => {
    const allocated = createOpaqueScopedMemoryDirectory(
      resolveScopedMemoryArtifactBase(databasePath),
    );
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    try {
      runSqliteImmediateTransactionSync(database, () => {
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_storage_roots").values({
            storage_root_id: storageRootId,
            agent_id: agentId,
            backend_kind: "builtin",
            opaque_locator: `builtin:v1:${allocated.pathKey}`,
            path_key_version: OPAQUE_PATH_KEY_VERSION,
            path_key: allocated.pathKey,
            authority_kind: params.authorityKind,
            authority_owner_id: authorityOwnerId,
            default_capabilities_json: JSON.stringify(
              normalizeCapabilities(params.defaultCapabilities),
            ),
            lifecycle_state: "active",
            created_at: nowMs,
            updated_at: nowMs,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_policies").values({
            policy_id: policyId,
            agent_id: agentId,
            current_revision_id: policyRevisionId,
            revocation_epoch: policyRevocationEpoch,
            lifecycle_state: "active",
            created_at: nowMs,
            updated_at: nowMs,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_policy_revisions").values({
            revision_id: policyRevisionId,
            policy_id: policyId,
            revision_number: 1,
            revocation_epoch: policyRevocationEpoch,
            lifecycle_state: "active",
            actor_kind: params.actor.kind,
            actor_id: params.actor.id ?? null,
            reason,
            created_at: nowMs,
          }),
        );
        const rows = normalizeEntries({
          entries,
          policyRevisionId,
          defaultAudienceKind: params.audienceKind,
          defaultAudienceId: audienceId,
          nowMs,
        });
        if (rows.length > 0) {
          executeSqliteQuerySync(database, db.insertInto("memory_policy_entries").values(rows));
        }
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_stores").values({
            store_id: storeId,
            agent_id: agentId,
            storage_root_id: storageRootId,
            policy_id: policyId,
            scope_kind: params.scopeKind,
            audience_kind: params.audienceKind,
            audience_id: audienceId,
            lifecycle_state: "active",
            created_at: nowMs,
            updated_at: nowMs,
          }),
        );
      });
    } catch (error) {
      removeEmptyDirectory(allocated.directoryPath);
      throw error;
    }
    return Object.freeze({
      storageRootId,
      storeId,
      policyId,
      policyRevisionId,
      policyRevocationEpoch,
      sourcePolicySetId: policySetId,
    });
  });
}

/** Replace one policy with a new immutable revision and revocation epoch. */
export function reviseBuiltinScopedMemoryPolicy(params: {
  agentId: string;
  policyId: string;
  entries: readonly ScopedMemoryPolicyEntryInput[];
  actor: ScopedMemoryActor;
  reason: string;
  nowMs?: number;
}): {
  policyId: string;
  policyRevisionId: string;
  policyRevocationEpoch: number;
  sourcePolicySetId: string;
} {
  const agentId = normalizeAgentId(params.agentId);
  const policyId = normalizeScopedMemoryRequiredText(params.policyId, "policyId");
  const reason = normalizeScopedMemoryRequiredText(params.reason, "reason");
  const policyRevisionId = randomUUID();
  const nowMs = params.nowMs ?? Date.now();
  return withScopedMemoryDatabase(agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    let policyRevocationEpoch = 0;
    runSqliteImmediateTransactionSync(database, () => {
      const current = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_policies as policy")
          .innerJoin(
            "memory_policy_revisions as revision",
            "revision.revision_id",
            "policy.current_revision_id",
          )
          .innerJoin("memory_stores as store", "store.policy_id", "policy.policy_id")
          .innerJoin(
            "memory_storage_roots as root",
            "root.storage_root_id",
            "store.storage_root_id",
          )
          .select([
            "policy.current_revision_id",
            "policy.revocation_epoch",
            "revision.revision_number",
            "store.scope_kind",
            "store.audience_kind",
            "store.audience_id",
            "root.authority_kind",
            "root.authority_owner_id",
          ])
          .where("policy.policy_id", "=", policyId)
          .where("policy.agent_id", "=", agentId)
          .where("policy.lifecycle_state", "=", "active")
          .where("revision.lifecycle_state", "=", "active")
          .where("store.lifecycle_state", "=", "active")
          .where("root.lifecycle_state", "=", "active"),
      );
      if (!current) {
        throw new Error("active scoped-memory policy is unavailable");
      }
      assertNoDirectPrivateUserPublish({
        scopeKind: current.scope_kind,
        audienceKind: current.audience_kind,
        audienceId: current.audience_id,
        authorityKind: current.authority_kind,
        authorityOwnerId: current.authority_owner_id,
        entries: params.entries,
      });
      policyRevocationEpoch = current.revocation_epoch + 1;
      executeSqliteQuerySync(
        database,
        db
          .updateTable("memory_policy_revisions")
          .set({ lifecycle_state: "superseded" })
          .where("revision_id", "=", current.current_revision_id)
          .where("lifecycle_state", "=", "active"),
      );
      executeSqliteQuerySync(
        database,
        db.insertInto("memory_policy_revisions").values({
          revision_id: policyRevisionId,
          policy_id: policyId,
          revision_number: current.revision_number + 1,
          revocation_epoch: policyRevocationEpoch,
          lifecycle_state: "active",
          actor_kind: params.actor.kind,
          actor_id: params.actor.id ?? null,
          reason,
          created_at: nowMs,
        }),
      );
      const rows = normalizeEntries({
        entries: params.entries,
        policyRevisionId,
        defaultAudienceKind: current.audience_kind,
        defaultAudienceId: current.audience_id,
        nowMs,
      });
      if (rows.length > 0) {
        executeSqliteQuerySync(database, db.insertInto("memory_policy_entries").values(rows));
      }
      const updated = executeSqliteQuerySync(
        database,
        db
          .updateTable("memory_policies")
          .set({
            current_revision_id: policyRevisionId,
            revocation_epoch: policyRevocationEpoch,
            updated_at: nowMs,
          })
          .where("policy_id", "=", policyId)
          .where("current_revision_id", "=", current.current_revision_id),
      );
      if (updated.numAffectedRows !== 1n) {
        throw new Error("scoped-memory policy changed during revision");
      }
    });
    return Object.freeze({
      policyId,
      policyRevisionId,
      policyRevocationEpoch,
      sourcePolicySetId: createScopedMemorySourcePolicySetId(policyRevisionId),
    });
  });
}
