import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import {
  refreshQmdSessionArtifactDocIds,
  replaceQmdSessionArtifactMappings,
} from "./qmd-session-artifacts.js";

describe("QMD session artifact mappings", () => {
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
