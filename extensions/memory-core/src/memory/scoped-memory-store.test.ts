import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readScopedMemoryFtsCandidatePage,
  readScopedMemorySqliteVecCandidatePage,
  readScopedMemoryVectorCandidatePage,
} from "./scoped-memory-candidates.js";
import { withScopedMemoryDatabase } from "./scoped-memory-db.js";
import {
  createBuiltinScopedMemoryResource,
  createBuiltinScopedMemoryResourceRevision,
  readBuiltinScopedMemoryRevisionSnapshot,
  resolveBuiltinScopedMemoryArtifactPath,
  setBuiltinScopedMemoryRevisionLifecycle,
} from "./scoped-memory-resources.js";
import {
  createBuiltinScopedMemoryStore,
  createOpaqueScopedMemoryDirectory,
  reviseBuiltinScopedMemoryPolicy,
} from "./scoped-memory-store.js";

describe("builtin scoped memory store", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-scoped-memory-store-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function storeFor(agentId = "main", audienceId = "principal-owner") {
    return createBuiltinScopedMemoryStore({
      agentId,
      scopeKind: "user",
      audienceKind: "user",
      audienceId,
      authorityKind: "user",
      authorityOwnerId: audienceId,
      defaultCapabilities: ["retrieve", "read"],
      actor: { kind: "human", id: audienceId },
      reason: "test placement",
      nowMs: 1_000,
    });
  }

  it("retries opaque directory collisions and rejects traversal", () => {
    const baseDir = path.join(stateDir, "opaque");
    const first = `s1_${"a".repeat(32)}`;
    const second = `s1_${"b".repeat(32)}`;
    fs.mkdirSync(path.join(baseDir, first), { recursive: true });
    const generated = [first, second];

    const allocated = createOpaqueScopedMemoryDirectory(baseDir, {
      generatePathKey: () => generated.shift() ?? second,
    });

    expect(allocated.pathKey).toBe(second);
    expect(fs.statSync(allocated.directoryPath).isDirectory()).toBe(true);
    expect(() =>
      createOpaqueScopedMemoryDirectory(baseDir, { generatePathKey: () => "../principal-owner" }),
    ).toThrow("path key is invalid");
    expect(() =>
      resolveBuiltinScopedMemoryArtifactPath({
        databasePath: path.join(stateDir, "agent.sqlite"),
        pathKey: second,
        artifactLocator: "../private.md",
      }),
    ).toThrow("artifact locator is invalid");
  });

  it("stores opaque roots, immutable resource revisions, and scoped chunks only", () => {
    const store = storeFor();
    const first = createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "MEMORY.md",
      content: "first immutable revision",
      actor: { kind: "human", id: "principal-owner" },
      nowMs: 2_000,
    });
    const second = createBuiltinScopedMemoryResourceRevision({
      agentId: "main",
      resourceId: first.resourceId,
      content: "second immutable revision",
      actor: { kind: "human", id: "principal-owner" },
      nowMs: 3_000,
    });

    withScopedMemoryDatabase("main", (database, databasePath) => {
      const root = database
        .prepare("SELECT path_key, authority_owner_id FROM memory_storage_roots")
        .get() as { path_key: string; authority_owner_id: string };
      expect(root.path_key).not.toContain("principal-owner");
      expect(databasePath).not.toContain("principal-owner");
      expect(
        database
          .prepare(
            "SELECT revision_id, revision_number, lifecycle_state FROM memory_resource_revisions ORDER BY revision_number",
          )
          .all(),
      ).toEqual([
        { revision_id: first.revisionId, revision_number: 1, lifecycle_state: "tombstoned" },
        { revision_id: second.revisionId, revision_number: 2, lifecycle_state: "active" },
      ]);
      expect(() =>
        database
          .prepare("UPDATE memory_resource_revisions SET content_hash = ? WHERE revision_id = ?")
          .run("rewritten", second.revisionId),
      ).toThrow("immutable");
      expect(database.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
      expect(database.prepare("SELECT * FROM memory_index_chunks").all()).toEqual([]);
      expect(database.prepare("SELECT * FROM memory_scoped_chunks").all()).toHaveLength(2);
      expect(root.authority_owner_id).toBe("principal-owner");
    });
  });

  it("never writes scoped resources or chunks into legacy index, FTS, or vector tables", () => {
    const store = storeFor();
    const legacy = withScopedMemoryDatabase("main", (database) => {
      database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_index_chunks_fts USING fts5(text);
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_index_paths_fts USING fts5(path);
        CREATE TABLE IF NOT EXISTS memory_index_chunks_vec (id TEXT PRIMARY KEY, embedding BLOB);
      `);
      database
        .prepare(
          "INSERT INTO memory_index_sources(path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
        )
        .run("legacy.md", "memory", "legacy-source", 1, 1);
      database
        .prepare(
          "INSERT INTO memory_index_chunks(id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("legacy-chunk", "legacy.md", "memory", 1, 1, "legacy", "legacy", "legacy", "[]", 1);
      database.prepare("INSERT INTO memory_index_chunks_fts(text) VALUES (?)").run("legacy fts");
      database.prepare("INSERT INTO memory_index_paths_fts(path) VALUES (?)").run("legacy.md");
      database
        .prepare("INSERT INTO memory_index_chunks_vec(id, embedding) VALUES (?, ?)")
        .run("legacy-vector", "legacy");
      return {
        sources: database.prepare("SELECT * FROM memory_index_sources").all(),
        chunks: database.prepare("SELECT * FROM memory_index_chunks").all(),
        chunkFts: database.prepare("SELECT * FROM memory_index_chunks_fts").all(),
        pathFts: database.prepare("SELECT * FROM memory_index_paths_fts").all(),
        vectors: database.prepare("SELECT * FROM memory_index_chunks_vec").all(),
      };
    });

    createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "private.md",
      content: "scoped only",
      actor: { kind: "human", id: "principal-owner" },
    });

    withScopedMemoryDatabase("main", (database) => {
      expect(database.prepare("SELECT * FROM memory_index_sources").all()).toEqual(legacy.sources);
      expect(database.prepare("SELECT * FROM memory_index_chunks").all()).toEqual(legacy.chunks);
      expect(database.prepare("SELECT * FROM memory_index_chunks_fts").all()).toEqual(
        legacy.chunkFts,
      );
      expect(database.prepare("SELECT * FROM memory_index_paths_fts").all()).toEqual(
        legacy.pathFts,
      );
      expect(database.prepare("SELECT * FROM memory_index_chunks_vec").all()).toEqual(
        legacy.vectors,
      );
    });
  });

  it("returns FTS candidate identifiers only from the requested scoped store", () => {
    const owner = storeFor("main", "owner");
    const other = storeFor("main", "other");
    const ownerRevision = createBuiltinScopedMemoryResource({
      agentId: "main",
      store: owner,
      logicalLocator: "MEMORY.md",
      content: "owner-only recall needle",
      actor: { kind: "human", id: "owner" },
    });
    createBuiltinScopedMemoryResource({
      agentId: "main",
      store: other,
      logicalLocator: "MEMORY.md",
      content: "other-only recall needle",
      actor: { kind: "human", id: "other" },
    });

    withScopedMemoryDatabase("main", (database) => {
      const candidates = readScopedMemoryFtsCandidatePage({
        database,
        query: "recall needle",
        storeIds: [owner.storeId],
        sources: ["memory"],
        limit: 10,
        offset: 0,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.revisionId).toBe(ownerRevision.revisionId);
    });
  });

  it("does not prefilter pending, quarantined, tombstoned, or expired revisions as candidates", () => {
    const store = storeFor();
    const active = createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "active.md",
      content: "candidate lifecycle sentinel",
      actor: { kind: "human", id: "principal-owner" },
      nowMs: 2_000,
    });
    const pending = createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "pending.md",
      content: "candidate lifecycle sentinel",
      lifecycleState: "pending",
      actor: { kind: "human", id: "principal-owner" },
      nowMs: 2_000,
    });
    const expired = createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "expired.md",
      content: "candidate lifecycle sentinel",
      expiresAt: 2_500,
      actor: { kind: "human", id: "principal-owner" },
      nowMs: 2_000,
    });
    const tombstoned = createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "tombstoned.md",
      content: "candidate lifecycle sentinel",
      actor: { kind: "human", id: "principal-owner" },
      nowMs: 2_000,
    });
    setBuiltinScopedMemoryRevisionLifecycle({
      agentId: "main",
      revisionId: tombstoned.revisionId,
      lifecycleState: "tombstoned",
      nowMs: 2_100,
    });

    withScopedMemoryDatabase("main", (database) => {
      for (const revisionId of [
        active.revisionId,
        pending.revisionId,
        expired.revisionId,
        tombstoned.revisionId,
      ]) {
        const chunk = database
          .prepare("SELECT chunk_id FROM memory_scoped_chunks WHERE revision_id = ?")
          .get(revisionId) as { chunk_id: string };
        database
          .prepare(
            "INSERT INTO memory_scoped_chunk_vectors(chunk_id, model, dims, embedding, updated_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(chunk.chunk_id, "fixture", 2, "[1,0]", 3_000);
      }
      const candidates = readScopedMemoryFtsCandidatePage({
        database,
        query: "candidate lifecycle",
        storeIds: [store.storeId],
        sources: ["memory"],
        limit: 10,
        offset: 0,
        nowMs: 3_000,
      });
      expect(candidates.map((candidate) => candidate.revisionId)).toEqual([active.revisionId]);
      expect(candidates.map((candidate) => candidate.revisionId)).not.toContain(pending.revisionId);
      expect(candidates.map((candidate) => candidate.revisionId)).not.toContain(expired.revisionId);

      const params = {
        database,
        query: "ignored",
        queryVector: [1, 0],
        storeIds: [store.storeId],
        sources: ["memory"] as const,
        limit: 10,
        offset: 0,
        nowMs: 3_000,
      };
      expect(
        readScopedMemoryVectorCandidatePage(params).map((candidate) => candidate.revisionId),
      ).toEqual([active.revisionId]);
      // No sqlite-vec table is installed in this fixture, so the same scoped scan is the exact
      // fallback path rather than a broader legacy search.
      expect(
        readScopedMemorySqliteVecCandidatePage(params).map((candidate) => candidate.revisionId),
      ).toEqual([active.revisionId]);
    });
  });

  it("rejects inactive, expired, stale-policy, and stale-hash exact revision reads", () => {
    const store = storeFor();
    const revision = createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "exact.md",
      content: "exact read sentinel",
      actor: { kind: "human", id: "principal-owner" },
      nowMs: 2_000,
    });
    const read = () =>
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId: "main",
        storeIds: [store.storeId],
        revisionId: revision.revisionId,
        nowMs: 3_000,
      });

    expect(read()).toMatchObject({ content: "exact read sentinel" });
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId: "main",
        storeIds: ["unrelated-store"],
        revisionId: revision.revisionId,
        nowMs: 3_000,
      }),
    ).toBeUndefined();

    withScopedMemoryDatabase("main", (database, databasePath) => {
      const artifact = database
        .prepare("SELECT artifact_locator FROM memory_resource_revisions WHERE revision_id = ?")
        .get(revision.revisionId) as { artifact_locator: string };
      const pathKey = database
        .prepare("SELECT path_key FROM memory_storage_roots WHERE storage_root_id = ?")
        .get(store.storageRootId) as { path_key: string };
      const artifactPath = resolveBuiltinScopedMemoryArtifactPath({
        databasePath,
        pathKey: pathKey.path_key,
        artifactLocator: artifact.artifact_locator,
      });
      fs.writeFileSync(artifactPath, "tampered bytes");
    });
    expect(read()).toBeUndefined();

    const clean = createBuiltinScopedMemoryResourceRevision({
      agentId: "main",
      resourceId: revision.resourceId,
      content: "clean exact read sentinel",
      actor: { kind: "human", id: "principal-owner" },
      nowMs: 4_000,
    });
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId: "main",
        storeIds: [store.storeId],
        revisionId: clean.revisionId,
        nowMs: 5_000,
      }),
    ).toMatchObject({ content: "clean exact read sentinel" });
    reviseBuiltinScopedMemoryPolicy({
      agentId: "main",
      policyId: store.policyId,
      entries: [],
      actor: { kind: "human", id: "principal-owner" },
      reason: "invalidate old resource policy",
      nowMs: 5_500,
    });
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId: "main",
        storeIds: [store.storeId],
        revisionId: clean.revisionId,
        nowMs: 5_500,
      }),
    ).toBeUndefined();

    const expired = createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "expired-exact.md",
      content: "expired exact read sentinel",
      expiresAt: 6_000,
      actor: { kind: "human", id: "principal-owner" },
      nowMs: 5_600,
    });
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId: "main",
        storeIds: [store.storeId],
        revisionId: expired.revisionId,
        nowMs: 6_000,
      }),
    ).toBeUndefined();
    setBuiltinScopedMemoryRevisionLifecycle({
      agentId: "main",
      revisionId: clean.revisionId,
      lifecycleState: "quarantined",
      nowMs: 6_000,
    });
    expect(
      readBuiltinScopedMemoryRevisionSnapshot({
        agentId: "main",
        storeIds: [store.storeId],
        revisionId: clean.revisionId,
        nowMs: 6_000,
      }),
    ).toBeUndefined();
  });

  it("rejects direct private user-to-user allows during store and policy creation", () => {
    expect(() =>
      createBuiltinScopedMemoryStore({
        agentId: "main",
        scopeKind: "user",
        audienceKind: "user",
        audienceId: "bob",
        authorityKind: "user",
        authorityOwnerId: "alice",
        defaultCapabilities: ["retrieve"],
        actor: { kind: "human", id: "alice" },
        reason: "private publish",
      }),
    ).toThrow("private user scoped memory");

    const store = storeFor();
    expect(() =>
      reviseBuiltinScopedMemoryPolicy({
        agentId: "main",
        policyId: store.policyId,
        entries: [
          {
            effect: "allow",
            principalId: "bob",
            operation: "read",
            grantorPrincipalId: "principal-owner",
            reason: "private publish",
          },
        ],
        actor: { kind: "human", id: "principal-owner" },
        reason: "private publish",
      }),
    ).toThrow("direct private user-to-user");
  });

  it("never revives a terminal revision", () => {
    const store = storeFor();
    const revision = createBuiltinScopedMemoryResource({
      agentId: "main",
      store,
      logicalLocator: "MEMORY.md",
      content: "temporary text",
      actor: { kind: "human", id: "principal-owner" },
    });
    setBuiltinScopedMemoryRevisionLifecycle({
      agentId: "main",
      revisionId: revision.revisionId,
      lifecycleState: "tombstoned",
    });
    expect(() =>
      setBuiltinScopedMemoryRevisionLifecycle({
        agentId: "main",
        revisionId: revision.revisionId,
        lifecycleState: "quarantined",
      }),
    ).toThrow("invalid scoped-memory revision lifecycle transition");
  });
});
