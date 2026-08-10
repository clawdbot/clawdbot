import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  resolveScopedMemoryArtifactBase,
  type ScopedMemoryDatabase,
  type ScopedMemoryLifecycleState,
  withScopedMemoryDatabase,
} from "./scoped-memory-db.js";
import {
  createScopedMemorySourcePolicySetId,
  normalizeScopedMemoryRequiredText,
  type BuiltinScopedMemoryStore,
  type ScopedMemoryActor,
} from "./scoped-memory-store.js";

const ARTIFACT_NAME_PATTERN =
  /^r1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/u;
const LOGICAL_LOCATOR_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)[^\0\\]+$/u;

export type BuiltinScopedMemoryRevision = Readonly<{
  resourceId: string;
  revisionId: string;
  policyRevisionId: string;
  policyRevocationEpoch: number;
  sourcePolicySetId: string;
  artifactLocator: string;
}>;

/** Content verified against the active immutable catalog record, before any future exposure. */
export type BuiltinScopedMemoryRevisionSnapshot = Readonly<{
  resourceId: string;
  revisionId: string;
  storeId: string;
  logicalLocator: string;
  content: string;
  contentHash: string;
  contentBytes: number;
  policyRevisionId: string;
  policyRevocationEpoch: number;
}>;

export type ScopedMemoryChunk = Readonly<{
  ordinal: number;
  startLine: number;
  endLine: number;
  text: string;
}>;

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeLogicalLocator(locator: string): string {
  const normalized = normalizeScopedMemoryRequiredText(locator, "logical locator").replaceAll(
    "\\",
    "/",
  );
  if (!LOGICAL_LOCATOR_PATTERN.test(normalized)) {
    throw new Error("logical locator is invalid");
  }
  return normalized;
}

function createArtifactLocator(revisionId: string): string {
  return `r1_${revisionId}.md`;
}

function resolveArtifactDirectory(params: { databasePath: string; pathKey: string }): string {
  const base = path.resolve(resolveScopedMemoryArtifactBase(params.databasePath));
  if (!/^s1_[A-Za-z0-9_-]{24,}$/u.test(params.pathKey)) {
    throw new Error("scoped-memory path key is invalid");
  }
  const directory = path.resolve(base, params.pathKey);
  if (path.dirname(directory) !== base) {
    throw new Error("scoped-memory storage root is invalid");
  }
  return directory;
}

/** Resolve a canonical artifact path without allowing logical locators to affect the filesystem. */
export function resolveBuiltinScopedMemoryArtifactPath(params: {
  databasePath: string;
  pathKey: string;
  artifactLocator: string;
}): string {
  if (!ARTIFACT_NAME_PATTERN.test(params.artifactLocator)) {
    throw new Error("artifact locator is invalid");
  }
  const directory = resolveArtifactDirectory(params);
  const artifactPath = path.resolve(directory, params.artifactLocator);
  if (path.dirname(artifactPath) !== directory) {
    throw new Error("artifact locator escaped its storage root");
  }
  return artifactPath;
}

/** Deterministic Markdown chunks retained as scoped derived state beside the canonical artifact. */
export function chunkScopedMemoryMarkdown(content: string): readonly ScopedMemoryChunk[] {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const chunks: ScopedMemoryChunk[] = [];
  const chunkSize = 48;
  for (let start = 0; start < lines.length; start += chunkSize) {
    const selected = lines
      .slice(start, start + chunkSize)
      .join("\n")
      .trim();
    if (!selected) {
      continue;
    }
    chunks.push(
      Object.freeze({
        ordinal: chunks.length,
        startLine: start + 1,
        endLine: Math.min(lines.length, start + chunkSize),
        text: selected,
      }),
    );
  }
  return Object.freeze(chunks);
}

function writeImmutableArtifact(params: { artifactPath: string; content: string }): void {
  fs.mkdirSync(path.dirname(params.artifactPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(params.artifactPath, params.content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function removeArtifact(pathname: string): void {
  try {
    fs.unlinkSync(pathname);
  } catch {}
}

/**
 * Resolve a revision only while its immutable catalog evidence is current.
 * The Phase 1C runtime supplies the authorized store view; this foundation
 * never treats a logical locator or filesystem path as an authorization grant.
 */
export function readBuiltinScopedMemoryRevisionSnapshot(params: {
  agentId: string;
  storeIds: readonly string[];
  revisionId: string;
  nowMs?: number;
}): BuiltinScopedMemoryRevisionSnapshot | undefined {
  const agentId = normalizeAgentId(params.agentId);
  const revisionId = normalizeScopedMemoryRequiredText(params.revisionId, "revisionId");
  const storeIds = [
    ...new Set(
      params.storeIds.map((storeId) => normalizeScopedMemoryRequiredText(storeId, "storeId")),
    ),
  ];
  if (storeIds.length === 0) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  return withScopedMemoryDatabase(agentId, (database, databasePath) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const revision = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_resource_revisions as revision")
        .innerJoin("memory_resources as resource", "resource.resource_id", "revision.resource_id")
        .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
        .innerJoin("memory_storage_roots as root", "root.storage_root_id", "store.storage_root_id")
        .innerJoin("memory_policies as policy", "policy.policy_id", "store.policy_id")
        .innerJoin(
          "memory_policy_revisions as policy_revision",
          "policy_revision.revision_id",
          "policy.current_revision_id",
        )
        .select([
          "resource.resource_id",
          "resource.store_id",
          "resource.logical_locator",
          "revision.revision_id",
          "revision.artifact_locator",
          "revision.content_hash",
          "revision.content_bytes",
          "revision.policy_revision_id",
          "revision.policy_revocation_epoch",
          "revision.source_policy_set_id",
          "revision.lifecycle_state as revision_lifecycle_state",
          "revision.expires_at",
          "store.lifecycle_state as store_lifecycle_state",
          "root.path_key",
          "root.backend_kind",
          "root.lifecycle_state as root_lifecycle_state",
          "policy.current_revision_id",
          "policy.revocation_epoch",
          "policy.lifecycle_state as policy_lifecycle_state",
          "policy_revision.lifecycle_state as policy_revision_lifecycle_state",
          "policy_revision.revocation_epoch as current_policy_revocation_epoch",
        ])
        .where("revision.revision_id", "=", revisionId),
    );
    if (
      !revision?.path_key ||
      !storeIds.includes(revision.store_id) ||
      revision.revision_lifecycle_state !== "active" ||
      revision.store_lifecycle_state !== "active" ||
      revision.root_lifecycle_state !== "active" ||
      revision.backend_kind !== "builtin" ||
      revision.policy_lifecycle_state !== "active" ||
      revision.policy_revision_lifecycle_state !== "active" ||
      revision.policy_revision_id !== revision.current_revision_id ||
      revision.policy_revocation_epoch !== revision.revocation_epoch ||
      revision.current_policy_revocation_epoch !== revision.revocation_epoch ||
      revision.source_policy_set_id !==
        createScopedMemorySourcePolicySetId(revision.current_revision_id) ||
      (revision.expires_at !== null && revision.expires_at <= nowMs)
    ) {
      return undefined;
    }
    const artifactPath = resolveBuiltinScopedMemoryArtifactPath({
      databasePath,
      pathKey: revision.path_key,
      artifactLocator: revision.artifact_locator,
    });
    let content: string;
    try {
      // Scoped artifact roots are owner-only. Refuse a symlink rather than letting a compromised
      // artifact entry make a future authorized read cross the selected store boundary.
      if (fs.lstatSync(artifactPath).isSymbolicLink()) {
        return undefined;
      }
      content = fs.readFileSync(artifactPath, "utf8");
    } catch {
      return undefined;
    }
    if (
      Buffer.byteLength(content) !== revision.content_bytes ||
      contentHash(content) !== revision.content_hash
    ) {
      return undefined;
    }
    return Object.freeze({
      resourceId: revision.resource_id,
      revisionId: revision.revision_id,
      storeId: revision.store_id,
      logicalLocator: revision.logical_locator,
      content,
      contentHash: revision.content_hash,
      contentBytes: revision.content_bytes,
      policyRevisionId: revision.policy_revision_id,
      policyRevocationEpoch: revision.policy_revocation_epoch,
    });
  });
}

function createRevision(params: {
  agentId: string;
  resourceId: string;
  content: string;
  lifecycleState: ScopedMemoryLifecycleState;
  expiresAt: number | null;
  actor: ScopedMemoryActor;
  nowMs: number;
}): BuiltinScopedMemoryRevision {
  const content = params.content;
  if (!content.trim()) {
    throw new Error("scoped memory content is required");
  }
  if (params.lifecycleState === "tombstoned") {
    throw new Error("new scoped-memory revisions cannot start tombstoned");
  }
  if (
    params.expiresAt !== null &&
    (!Number.isSafeInteger(params.expiresAt) || params.expiresAt < 0)
  ) {
    throw new Error("scoped-memory expiry is invalid");
  }
  const revisionId = randomUUID();
  const artifactLocator = createArtifactLocator(revisionId);
  return withScopedMemoryDatabase(params.agentId, (database, databasePath) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const resource = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_resources as resource")
        .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
        .innerJoin("memory_storage_roots as root", "root.storage_root_id", "store.storage_root_id")
        .select(["resource.resource_id", "root.path_key"])
        .where("resource.resource_id", "=", params.resourceId)
        .where("resource.agent_id", "=", params.agentId)
        .where("store.lifecycle_state", "=", "active")
        .where("root.lifecycle_state", "=", "active"),
    );
    if (!resource?.path_key) {
      throw new Error("scoped-memory resource storage root is unavailable");
    }
    const artifactPath = resolveBuiltinScopedMemoryArtifactPath({
      databasePath,
      pathKey: resource.path_key,
      artifactLocator,
    });
    writeImmutableArtifact({ artifactPath, content });
    try {
      let output: BuiltinScopedMemoryRevision | undefined;
      runSqliteImmediateTransactionSync(database, () => {
        const current = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("memory_resources as resource")
            .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
            .innerJoin("memory_policies as policy", "policy.policy_id", "store.policy_id")
            .innerJoin(
              "memory_policy_revisions as policy_revision",
              "policy_revision.revision_id",
              "policy.current_revision_id",
            )
            .select([
              "resource.resource_id",
              "policy.current_revision_id",
              "policy.revocation_epoch",
              "policy_revision.revision_number",
            ])
            .where("resource.resource_id", "=", params.resourceId)
            .where("resource.agent_id", "=", params.agentId)
            .where("store.lifecycle_state", "=", "active")
            .where("policy.lifecycle_state", "=", "active")
            .where("policy_revision.lifecycle_state", "=", "active"),
        );
        if (!current) {
          throw new Error("scoped-memory resource policy is unavailable");
        }
        const previous = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("memory_resource_revisions")
            .select("revision_number")
            .where("resource_id", "=", params.resourceId)
            .orderBy("revision_number", "desc")
            .limit(1),
        );
        if (params.lifecycleState === "active") {
          executeSqliteQuerySync(
            database,
            db
              .updateTable("memory_resource_revisions")
              .set({ lifecycle_state: "tombstoned", retired_at: params.nowMs })
              .where("resource_id", "=", params.resourceId)
              .where("lifecycle_state", "=", "active"),
          );
        }
        const revisionNumber = (previous?.revision_number ?? 0) + 1;
        const hash = contentHash(content);
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_resource_revisions").values({
            revision_id: revisionId,
            resource_id: params.resourceId,
            revision_number: revisionNumber,
            artifact_locator: artifactLocator,
            content_hash: hash,
            content_bytes: Buffer.byteLength(content),
            policy_revision_id: current.current_revision_id,
            policy_revocation_epoch: current.revocation_epoch,
            source_policy_set_id: createScopedMemorySourcePolicySetId(current.current_revision_id),
            lifecycle_state: params.lifecycleState,
            actor_kind: params.actor.kind,
            actor_id: params.actor.id ?? null,
            expires_at: params.expiresAt,
            created_at: params.nowMs,
            activated_at: params.lifecycleState === "active" ? params.nowMs : null,
            retired_at: null,
          }),
        );
        const chunks = chunkScopedMemoryMarkdown(content);
        if (chunks.length > 0) {
          executeSqliteQuerySync(
            database,
            db.insertInto("memory_scoped_chunks").values(
              chunks.map((chunk) => ({
                chunk_id: randomUUID(),
                revision_id: revisionId,
                chunk_ordinal: chunk.ordinal,
                start_line: chunk.startLine,
                end_line: chunk.endLine,
                text: chunk.text,
                content_hash: hash,
                model: "fts-only",
                updated_at: params.nowMs,
              })),
            ),
          );
        }
        output = Object.freeze({
          resourceId: params.resourceId,
          revisionId,
          policyRevisionId: current.current_revision_id,
          policyRevocationEpoch: current.revocation_epoch,
          sourcePolicySetId: createScopedMemorySourcePolicySetId(current.current_revision_id),
          artifactLocator,
        });
      });
      if (!output) {
        throw new Error("scoped-memory revision was not created");
      }
      return output;
    } catch (error) {
      removeArtifact(artifactPath);
      throw error;
    }
  });
}

/** Create the stable resource and first immutable revision under its store policy. */
export function createBuiltinScopedMemoryResource(params: {
  agentId: string;
  store: BuiltinScopedMemoryStore;
  logicalLocator: string;
  content: string;
  lifecycleState?: Exclude<ScopedMemoryLifecycleState, "tombstoned">;
  expiresAt?: number;
  actor: ScopedMemoryActor;
  nowMs?: number;
}): BuiltinScopedMemoryRevision {
  const agentId = normalizeAgentId(params.agentId);
  const logicalLocator = normalizeLogicalLocator(params.logicalLocator);
  const nowMs = params.nowMs ?? Date.now();
  const resourceId = randomUUID();
  return withScopedMemoryDatabase(agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    runSqliteImmediateTransactionSync(database, () => {
      const store = executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_stores")
          .select("store_id")
          .where("store_id", "=", params.store.storeId)
          .where("agent_id", "=", agentId)
          .where("lifecycle_state", "=", "active"),
      );
      if (!store) {
        throw new Error("scoped-memory store is unavailable");
      }
      executeSqliteQuerySync(
        database,
        db.insertInto("memory_resources").values({
          resource_id: resourceId,
          agent_id: agentId,
          store_id: store.store_id,
          logical_locator: logicalLocator,
          source: "memory",
          created_at: nowMs,
        }),
      );
    });
    return createRevision({
      agentId,
      resourceId,
      content: params.content,
      lifecycleState: params.lifecycleState ?? "active",
      expiresAt: params.expiresAt ?? null,
      actor: params.actor,
      nowMs,
    });
  });
}

/** Add a later immutable revision; only one active revision can exist per resource. */
export function createBuiltinScopedMemoryResourceRevision(params: {
  agentId: string;
  resourceId: string;
  content: string;
  lifecycleState?: Exclude<ScopedMemoryLifecycleState, "tombstoned">;
  expiresAt?: number;
  actor: ScopedMemoryActor;
  nowMs?: number;
}): BuiltinScopedMemoryRevision {
  return createRevision({
    agentId: normalizeAgentId(params.agentId),
    resourceId: normalizeScopedMemoryRequiredText(params.resourceId, "resourceId"),
    content: params.content,
    lifecycleState: params.lifecycleState ?? "active",
    expiresAt: params.expiresAt ?? null,
    actor: params.actor,
    nowMs: params.nowMs ?? Date.now(),
  });
}

/** Quarantine or tombstone a revision without mutating its immutable evidence. */
export function setBuiltinScopedMemoryRevisionLifecycle(params: {
  agentId: string;
  revisionId: string;
  lifecycleState: "quarantined" | "tombstoned";
  nowMs?: number;
}): void {
  const agentId = normalizeAgentId(params.agentId);
  const revisionId = normalizeScopedMemoryRequiredText(params.revisionId, "revisionId");
  const nowMs = params.nowMs ?? Date.now();
  withScopedMemoryDatabase(agentId, (database) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const updated = executeSqliteQuerySync(
      database,
      db
        .updateTable("memory_resource_revisions as revision")
        .set({ lifecycle_state: params.lifecycleState, retired_at: nowMs })
        .where("revision.revision_id", "=", revisionId)
        .where(
          "revision.resource_id",
          "in",
          db.selectFrom("memory_resources").select("resource_id").where("agent_id", "=", agentId),
        )
        .where("revision.lifecycle_state", "in", ["pending", "active", "quarantined"]),
    );
    if (updated.numAffectedRows !== 1n) {
      throw new Error("invalid scoped-memory revision lifecycle transition");
    }
  });
}
