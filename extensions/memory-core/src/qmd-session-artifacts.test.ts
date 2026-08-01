import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import {
  refreshQmdSessionArtifactDocIds,
  replaceQmdSessionArtifactMappings,
  resolveQmdSessionArtifactIdentity,
} from "./qmd-session-artifacts.js";

describe("QMD session artifact mappings", () => {
  it("migrates and resolves exact per-line provenance while failing closed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-artifact-provenance-"));
    const indexPath = path.join(tempDir, "index.sqlite");
    const { DatabaseSync } = requireNodeSqlite();
    try {
      const legacy = new DatabaseSync(indexPath);
      legacy.exec(`
        CREATE TABLE openclaw_qmd_session_artifacts (
          collection TEXT NOT NULL,
          artifact_path TEXT NOT NULL,
          search_path TEXT NOT NULL,
          docid TEXT,
          memory_key TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (collection, artifact_path)
        ) STRICT;
      `);
      legacy.close();

      replaceQmdSessionArtifactMappings({
        collection: "sessions-main",
        indexPath,
        mappings: [
          {
            agentId: "main",
            archived: false,
            artifactPath: "session-1.md",
            collection: "sessions-main",
            memoryKey: "session/main/session-1",
            provenance: {
              contentStartLine: 3,
              lines: [
                {
                  originClass: "owner",
                  sessionKind: "interactive",
                  observedAt: 10,
                  supersedesKey: "tea-preference",
                },
                {
                  originClass: "owner",
                  sessionKind: "interactive",
                  observedAt: 20,
                  supersedesKey: "tea-preference",
                },
                {
                  originClass: "owner",
                  sessionKind: "interactive",
                  observedAt: 30,
                  supersedesKey: "coffee-preference",
                },
                {
                  originClass: "agent",
                  sessionKind: "interactive",
                  observedAt: 40,
                  supersedesKey: "coffee-preference",
                },
              ],
            },
            searchPath: "qmd/sessions-main/session-1.md",
            sessionId: "session-1",
          },
        ],
      });
      const indexed = new DatabaseSync(indexPath);
      indexed.exec(`
        CREATE TABLE documents (
          collection TEXT NOT NULL,
          path TEXT NOT NULL,
          active INTEGER NOT NULL,
          hash TEXT NOT NULL
        ) STRICT;
        INSERT INTO documents (collection, path, active, hash)
        VALUES ('sessions-main', 'session-1.md', 1, 'doc-1');
      `);
      indexed.close();
      refreshQmdSessionArtifactDocIds({
        assertOwned: vi.fn(),
        collection: "sessions-main",
        indexPath,
      });

      const lookup = {
        artifactPath: "session-1.md",
        collection: "sessions-main",
        docid: "doc-1",
        indexPath,
        searchPath: "qmd/sessions-main/session-1.md",
      };
      const identity = {
        agentId: "main",
        archived: false,
        memoryKey: "session/main/session-1",
        sessionId: "session-1",
      };
      expect(resolveQmdSessionArtifactIdentity({ ...lookup, startLine: 3, endLine: 3 })).toEqual({
        ...identity,
        provenance: {
          originClass: "owner",
          sessionKind: "interactive",
          observedAt: 10,
          supersedesKey: "tea-preference",
        },
      });
      expect(resolveQmdSessionArtifactIdentity({ ...lookup, startLine: 3, endLine: 4 })).toEqual({
        ...identity,
        provenance: {
          originClass: "owner",
          sessionKind: "interactive",
          observedAt: 10,
          supersedesKey: "tea-preference",
        },
      });
      expect(resolveQmdSessionArtifactIdentity({ ...lookup, startLine: 2, endLine: 2 })).toEqual(
        identity,
      );
      expect(resolveQmdSessionArtifactIdentity({ ...lookup, startLine: 4, endLine: 5 })).toEqual(
        identity,
      );
      expect(resolveQmdSessionArtifactIdentity({ ...lookup, startLine: 5, endLine: 6 })).toEqual(
        identity,
      );
      expect(
        resolveQmdSessionArtifactIdentity({
          ...lookup,
          docid: "stale-doc",
          startLine: 3,
          endLine: 3,
        }),
      ).toEqual(identity);

      const verify = new DatabaseSync(indexPath);
      const columns = verify
        .prepare("SELECT name FROM pragma_table_info('openclaw_qmd_session_artifacts')")
        .all() as Array<{ name: string }>;
      expect(columns.some((column) => column.name === "provenance_json")).toBe(true);
      verify
        .prepare(
          "UPDATE openclaw_qmd_session_artifacts SET provenance_json = ? WHERE collection = ?",
        )
        .run("{invalid", "sessions-main");
      verify.close();

      expect(resolveQmdSessionArtifactIdentity({ ...lookup, startLine: 3, endLine: 3 })).toEqual(
        identity,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rechecks lease ownership before every doc-id publication and commit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-artifact-lease-"));
    const indexPath = path.join(tempDir, "index.sqlite");
    try {
      replaceQmdSessionArtifactMappings({
        collection: "sessions-main",
        indexPath,
        mappings: [
          {
            agentId: "main",
            archived: false,
            artifactPath: "session-1.md",
            collection: "sessions-main",
            memoryKey: "session/main/session-1",
            searchPath: "qmd/sessions-main/session-1.md",
            sessionId: "session-1",
          },
        ],
      });
      const { DatabaseSync } = requireNodeSqlite();
      const seed = new DatabaseSync(indexPath);
      seed.exec(`
        CREATE TABLE documents (
          collection TEXT NOT NULL,
          path TEXT NOT NULL,
          active INTEGER NOT NULL,
          hash TEXT NOT NULL
        ) STRICT;
      `);
      seed
        .prepare("INSERT INTO documents (collection, path, active, hash) VALUES (?, ?, 1, ?)")
        .run("sessions-main", "session-1.md", "doc-1");
      seed.close();

      const leaseLost = new Error("lease lost");
      let checks = 0;
      expect(() =>
        refreshQmdSessionArtifactDocIds({
          assertOwned: () => {
            checks += 1;
            if (checks === 2) {
              throw leaseLost;
            }
          },
          collection: "sessions-main",
          indexPath,
        }),
      ).toThrow(leaseLost);

      const verifyRollback = new DatabaseSync(indexPath, { readOnly: true });
      expect(
        verifyRollback
          .prepare("SELECT docid FROM openclaw_qmd_session_artifacts WHERE artifact_path = ?")
          .get("session-1.md"),
      ).toEqual({ docid: null });
      verifyRollback.close();

      const assertOwned = vi.fn();
      refreshQmdSessionArtifactDocIds({
        assertOwned,
        collection: "sessions-main",
        indexPath,
      });
      expect(assertOwned).toHaveBeenCalledTimes(3);
      const verifyCommit = new DatabaseSync(indexPath, { readOnly: true });
      expect(
        verifyCommit
          .prepare("SELECT docid FROM openclaw_qmd_session_artifacts WHERE artifact_path = ?")
          .get("session-1.md"),
      ).toEqual({ docid: "doc-1" });
      verifyCommit.close();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
