// Session state migration command helpers cover explicit legacy store imports.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSqliteSessionStoreDatabasePath } from "../config/sessions/store-sqlite.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  ensureExplicitSessionStoreMigratedForCommand,
  loadExplicitSessionStorePreviewForCommand,
} from "./session-state-migration.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) => fsp.rm(tempRoot, { recursive: true, force: true })),
  );
});

describe("ensureExplicitSessionStoreMigratedForCommand", () => {
  it("loads explicit legacy stores for read-only previews without deleting JSON", async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-session-preview-"));
    tempRoots.push(tempRoot);
    const storePath = path.join(tempRoot, "sessions.json");
    await fsp.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "legacy-session", updatedAt: 10 },
      }),
      "utf8",
    );

    const preview = loadExplicitSessionStorePreviewForCommand(storePath);

    expect(preview["agent:main:main"]?.sessionId).toBe("legacy-session");
    await expect(fsp.readFile(storePath, "utf8")).resolves.toContain("legacy-session");
    expect(fs.existsSync(resolveSqliteSessionStoreDatabasePath(storePath))).toBe(false);
  });

  it("previews existing SQLite stores without creating session schema", async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-session-preview-db-"));
    tempRoots.push(tempRoot);
    const storePath = path.join(tempRoot, "sessions.json");
    const databasePath = resolveSqliteSessionStoreDatabasePath(storePath);
    await fsp.mkdir(path.dirname(databasePath), { recursive: true });
    const sqlite = requireNodeSqlite();
    const emptyDatabase = new sqlite.DatabaseSync(databasePath);
    emptyDatabase.close();

    const preview = loadExplicitSessionStorePreviewForCommand(storePath);

    expect(preview).toStrictEqual({});
    const readOnlyDatabase = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const cacheEntriesTable = readOnlyDatabase
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cache_entries'")
        .get();
      expect(cacheEntriesTable).toBeUndefined();
    } finally {
      readOnlyDatabase.close();
    }
  });

  it("warns instead of failing when legacy JSON cleanup fails after SQLite import", async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-session-migrate-"));
    tempRoots.push(tempRoot);
    const storePath = path.join(tempRoot, "sessions.json");
    await fsp.writeFile(
      storePath,
      JSON.stringify({
        "agent:main:main": { sessionId: "legacy-session", updatedAt: 10 },
      }),
      "utf8",
    );
    vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw Object.assign(new Error("locked"), { code: "EPERM" });
    });
    const warnings: string[] = [];

    await expect(
      ensureExplicitSessionStoreMigratedForCommand(storePath, {
        onWarning: (warning) => warnings.push(warning),
      }),
    ).resolves.toBeUndefined();

    const migrated = loadSessionStore(storePath, { skipCache: true });
    expect(migrated["agent:main:main"]?.sessionId).toBe("legacy-session");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("failed removing");
  });
});
