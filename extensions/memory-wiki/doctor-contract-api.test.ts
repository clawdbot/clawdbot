// Memory Wiki tests cover doctor migration of legacy source sync state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import {
  createMemoryWikiImportRunStateStore,
  readMemoryWikiImportRunRecord,
} from "./src/import-runs-state.js";
import {
  createMemoryWikiSourceSyncStateStore,
  readMemoryWikiSourceSyncState,
  resolveMemoryWikiSourceSyncStatePath,
} from "./src/source-sync-state.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-doctor-"));
  tempDirs.push(dir);
  return dir;
}

function resolveLegacyImportRunRecordPath(vaultRoot: string, runId: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "import-runs", `${runId}.json`);
}

function migrationParams(params: { stateDir: string; vaultRoot: string; agentIds?: string[] }) {
  const env = { ...process.env, HOME: params.stateDir, OPENCLAW_STATE_DIR: params.stateDir };
  return {
    config: {
      ...(params.agentIds ? { agents: { list: params.agentIds.map((id) => ({ id })) } } : {}),
      plugins: {
        entries: {
          "memory-wiki": {
            config: {
              vault: {
                path: params.vaultRoot,
                ...(params.agentIds ? { scope: "agent" as const } : {}),
              },
            },
          },
        },
      },
    },
    env,
    stateDir: params.stateDir,
    oauthDir: path.join(params.stateDir, "credentials"),
    context: {
      openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
    },
  };
}

describe("memory-wiki doctor source sync migration", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
  });

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("detects and migrates legacy source-sync.json into plugin state", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const legacyPath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        entries: {
          alpha: {
            group: "bridge",
            pagePath: "sources/alpha.md",
            sourcePath: "/tmp/alpha.md",
            sourceUpdatedAtMs: 100,
            sourceSize: 200,
            renderFingerprint: "alpha",
          },
        },
      })}\n`,
    );
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = stateMigrations[0];

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining("Memory Wiki source sync:")],
    });

    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Memory Wiki source sync -> plugin state (1 imported, 0 existing)",
        expect.stringContaining("Archived Memory Wiki source-sync legacy source ->"),
      ],
      warnings: [],
    });
    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual({
      version: 1,
      entries: {
        alpha: {
          group: "bridge",
          pagePath: "sources/alpha.md",
          sourcePath: "/tmp/alpha.md",
          sourceUpdatedAtMs: 100,
          sourceSize: 200,
          renderFingerprint: "alpha",
        },
      },
    });
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${legacyPath}.migrated`)).resolves.toBeDefined();
  });

  it("detects and migrates legacy import-run records into plugin state", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const legacyPath = resolveLegacyImportRunRecordPath(vaultRoot, "chatgpt-alpha");
    const snapshotPath = path.join(
      vaultRoot,
      ".openclaw-wiki",
      "import-runs",
      "chatgpt-alpha",
      "snapshots",
      "alpha.md",
    );
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(snapshotPath, "previous page\n", "utf8");
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        runId: "chatgpt-alpha",
        importType: "chatgpt",
        exportPath: "/tmp/chatgpt",
        sourcePath: "/tmp/chatgpt/conversations.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 2,
        createdCount: 1,
        updatedCount: 1,
        skippedCount: 0,
        createdPaths: ["sources/new.md"],
        updatedPaths: [{ path: "sources/existing.md", snapshotPath: "snapshots/alpha.md" }],
      })}\n`,
    );
    const params = migrationParams({ stateDir, vaultRoot });
    const migration = stateMigrations.find(
      (entry) => entry.id === "memory-wiki-import-runs-json-to-plugin-state",
    );
    if (!migration) {
      throw new Error("Expected import-run migration");
    }

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [expect.stringContaining("Memory Wiki import runs:")],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Memory Wiki import runs -> plugin state (1 imported, 0 existing)",
        expect.stringContaining("Archived Memory Wiki import-run legacy source ->"),
      ],
      warnings: [],
    });
    const store = createMemoryWikiImportRunStateStore(params.context.openPluginStateKeyedStore);
    await expect(readMemoryWikiImportRunRecord(vaultRoot, "chatgpt-alpha", store)).resolves.toEqual(
      {
        version: 1,
        runId: "chatgpt-alpha",
        importType: "chatgpt",
        exportPath: "/tmp/chatgpt",
        sourcePath: "/tmp/chatgpt/conversations.json",
        appliedAt: "2026-04-10T10:00:00.000Z",
        conversationCount: 2,
        createdCount: 1,
        updatedCount: 1,
        skippedCount: 0,
        createdPaths: ["sources/new.md"],
        updatedPaths: [{ path: "sources/existing.md", snapshotPath: "snapshots/alpha.md" }],
      },
    );
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${legacyPath}.migrated`)).resolves.toBeDefined();
    await expect(fs.readFile(snapshotPath, "utf8")).resolves.toBe("previous page\n");
  });

  it("merges legacy entries with existing plugin state before archiving", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const legacyPath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        entries: {
          stale: {
            group: "bridge",
            pagePath: "sources/stale.md",
            sourcePath: "/tmp/stale.md",
            sourceUpdatedAtMs: 10,
            sourceSize: 20,
            renderFingerprint: "stale",
          },
          current: {
            group: "bridge",
            pagePath: "sources/current-old.md",
            sourcePath: "/tmp/current-old.md",
            sourceUpdatedAtMs: 30,
            sourceSize: 40,
            renderFingerprint: "old",
          },
        },
      })}\n`,
    );
    const params = migrationParams({ stateDir, vaultRoot });
    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    await store.write(vaultRoot, {
      version: 1,
      entries: {
        current: {
          group: "bridge",
          pagePath: "sources/current.md",
          sourcePath: "/tmp/current.md",
          sourceUpdatedAtMs: 50,
          sourceSize: 60,
          renderFingerprint: "current",
        },
      },
    });

    await expect(stateMigrations[0].migrateLegacyState(params)).resolves.toEqual({
      changes: [
        "Migrated Memory Wiki source sync -> plugin state (1 imported, 1 existing)",
        expect.stringContaining("Archived Memory Wiki source-sync legacy source ->"),
      ],
      warnings: [],
    });
    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual({
      version: 1,
      entries: {
        stale: {
          group: "bridge",
          pagePath: "sources/stale.md",
          sourcePath: "/tmp/stale.md",
          sourceUpdatedAtMs: 10,
          sourceSize: 20,
          renderFingerprint: "stale",
        },
        current: {
          group: "bridge",
          pagePath: "sources/current.md",
          sourcePath: "/tmp/current.md",
          sourceUpdatedAtMs: 50,
          sourceSize: 60,
          renderFingerprint: "current",
        },
      },
    });
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates legacy state from every configured agent vault", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vaults");
    const agentIds = ["support", "marketing"];
    for (const agentId of agentIds) {
      const legacyPath = resolveMemoryWikiSourceSyncStatePath(path.join(vaultRoot, agentId));
      await fs.mkdir(path.dirname(legacyPath), { recursive: true });
      await fs.writeFile(
        legacyPath,
        `${JSON.stringify({
          version: 1,
          entries: {
            [agentId]: {
              group: "bridge",
              pagePath: `sources/${agentId}.md`,
              sourcePath: `/tmp/${agentId}.md`,
              sourceUpdatedAtMs: 100,
              sourceSize: 200,
              renderFingerprint: agentId,
            },
          },
        })}\n`,
      );
    }

    const params = migrationParams({ stateDir, vaultRoot, agentIds });
    await expect(stateMigrations[0].detectLegacyState(params)).resolves.toEqual({
      preview: [
        expect.stringContaining(path.join(vaultRoot, "support")),
        expect.stringContaining(path.join(vaultRoot, "marketing")),
      ],
    });
    await expect(stateMigrations[0].migrateLegacyState(params)).resolves.toMatchObject({
      warnings: [],
    });

    const store = createMemoryWikiSourceSyncStateStore(params.context.openPluginStateKeyedStore);
    for (const agentId of agentIds) {
      await expect(
        readMemoryWikiSourceSyncState(path.join(vaultRoot, agentId), store),
      ).resolves.toMatchObject({ entries: { [agentId]: { renderFingerprint: agentId } } });
    }
  });
});
