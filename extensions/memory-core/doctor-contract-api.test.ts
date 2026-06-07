// Memory Core tests cover doctor migration of legacy dreaming state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { testing as dreamingTesting } from "./src/dreaming-phases.js";
import {
  configureMemoryCoreDreamingState,
  resetMemoryCoreDreamingStateForTests,
} from "./src/dreaming-state.js";
import { testing as shortTermTesting } from "./src/short-term-promotion.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("memory-core", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

describe("memory-core doctor dreaming migration", () => {
  let rootDir = "";
  let workspaceDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-core-doctor-"));
    workspaceDir = path.join(rootDir, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(rootDir, "state") };
  });

  afterEach(async () => {
    resetMemoryCoreDreamingStateForTests();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function context(): PluginDoctorStateMigrationContext {
    return createDoctorContext(env);
  }

  function migrationParams(
    config: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: workspaceDir }],
      },
    },
  ) {
    return {
      config,
      env,
      stateDir: path.join(rootDir, "state"),
      oauthDir: path.join(rootDir, "oauth"),
      context: context(),
    };
  }

  it("imports persistent legacy dreaming state and ignores transient locks", async () => {
    const dreamsDir = path.join(workspaceDir, "memory", ".dreams");
    const dailyPath = path.join(dreamsDir, "daily-ingestion.json");
    const sessionPath = path.join(dreamsDir, "session-ingestion.json");
    const recallPath = path.join(dreamsDir, "short-term-recall.json");
    const phasePath = path.join(dreamsDir, "phase-signals.json");
    const lockPath = path.join(dreamsDir, "short-term-promotion.lock");

    await fs.writeFile(
      dailyPath,
      JSON.stringify({
        version: 1,
        files: {
          "memory/2026-04-05.md": {
            size: 42,
            mtimeMs: 1,
            contentHash: "daily-hash",
            ingestedAt: "2026-04-05T10:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      sessionPath,
      JSON.stringify({
        version: 1,
        files: {
          "main/session.jsonl": {
            size: 91,
            mtimeMs: 2,
            lineCount: 3,
            lastContentLine: 3,
            contentHash: "session-hash",
            ingestedAt: "2026-04-05T11:00:00.000Z",
          },
        },
        seenMessages: {
          "main/session.jsonl": ["seen-a", "seen-b"],
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      recallPath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-04-05T12:00:00.000Z",
        entries: {
          "memory:memory/2026-04-05.md:1:1": {
            key: "memory:memory/2026-04-05.md:1:1",
            path: "memory/2026-04-05.md",
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet: "Move backups to S3 Glacier.",
            recallCount: 1,
            totalScore: 0.9,
            maxScore: 0.9,
            firstRecalledAt: "2026-04-05T12:00:00.000Z",
            lastRecalledAt: "2026-04-05T12:00:00.000Z",
            queryHashes: ["hash-a"],
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      phasePath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-04-05T13:00:00.000Z",
        entries: {
          "memory:memory/2026-04-05.md:1:1": {
            key: "memory:memory/2026-04-05.md:1:1",
            lightHits: 1,
            remHits: 2,
            lastLightAt: "2026-04-05T12:00:00.000Z",
            lastRemAt: "2026-04-05T13:00:00.000Z",
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(lockPath, `${process.pid}:${Date.now()}\n`, "utf8");

    const migration = stateMigrations[0];
    const preview = await migration.detectLegacyState(migrationParams());
    expect(preview?.preview).toEqual([
      expect.stringContaining("Memory Core daily ingestion"),
      expect.stringContaining("Memory Core session ingestion"),
      expect.stringContaining("Memory Core short-term recall"),
      expect.stringContaining("Memory Core phase signals"),
    ]);
    expect(preview?.preview.join("\n")).not.toContain("short-term-promotion.lock");

    const result = await migration.migrateLegacyState(migrationParams());
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core daily ingestion -> SQLite plugin state (1 row(s))",
      expect.stringContaining("Archived Memory Core daily ingestion legacy source"),
      "Migrated Memory Core session ingestion -> SQLite plugin state (2 row(s))",
      expect.stringContaining("Archived Memory Core session ingestion legacy source"),
      "Migrated Memory Core short-term recall -> SQLite plugin state (1 row(s))",
      expect.stringContaining("Archived Memory Core short-term recall legacy source"),
      "Migrated Memory Core phase signals -> SQLite plugin state (1 row(s))",
      expect.stringContaining("Archived Memory Core phase signals legacy source"),
    ]);

    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    await expect(fs.access(`${dailyPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${sessionPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${recallPath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${phasePath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(lockPath)).resolves.toBeUndefined();

    const daily = await dreamingTesting.readDailyIngestionState(workspaceDir);
    expect(daily.files["memory/2026-04-05.md"]?.mtimeMs).toBe(1);
    const session = await dreamingTesting.readSessionIngestionState(workspaceDir);
    expect(session.files["main/session.jsonl"]?.contentHash).toBe("session-hash");
    expect(session.seenMessages["main/session.jsonl"]).toEqual(["seen-a", "seen-b"]);
    const recall = await shortTermTesting.readRecallStore(workspaceDir, "2026-04-05T12:00:00.000Z");
    expect(recall.entries["memory:memory/2026-04-05.md:1:1"]?.conceptTags).toContain("glacier");
    const phase = await shortTermTesting.readPhaseSignalStore(
      workspaceDir,
      "2026-04-05T13:00:00.000Z",
    );
    expect(phase.entries["memory:memory/2026-04-05.md:1:1"]?.remHits).toBe(2);
  });

  it("leaves invalid legacy JSON in place", async () => {
    const recallPath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
    await fs.writeFile(recallPath, "{", "utf8");

    const result = await stateMigrations[0].migrateLegacyState(migrationParams());

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Skipped Memory Core short-term recall import"),
    ]);
    await expect(fs.access(recallPath)).resolves.toBeUndefined();
    await expect(fs.access(`${recallPath}.migrated`)).rejects.toThrow();
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    const recall = await shortTermTesting.readRecallStore(workspaceDir, new Date().toISOString());
    expect(recall.entries).toEqual({});
  });

  it("uses migration env when resolving default workspaces", async () => {
    env = { ...env, OPENCLAW_WORKSPACE_DIR: workspaceDir };
    const recallPath = path.join(workspaceDir, "memory", ".dreams", "short-term-recall.json");
    await fs.writeFile(
      recallPath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-04-05T12:00:00.000Z",
        entries: {
          "memory:memory/2026-04-05.md:1:1": {
            key: "memory:memory/2026-04-05.md:1:1",
            path: "memory/2026-04-05.md",
            startLine: 1,
            endLine: 1,
            source: "memory",
            snippet: "Move backups to S3 Glacier.",
            recallCount: 1,
            totalScore: 0.9,
            maxScore: 0.9,
            firstRecalledAt: "2026-04-05T12:00:00.000Z",
            lastRecalledAt: "2026-04-05T12:00:00.000Z",
            queryHashes: ["hash-a"],
          },
        },
      }),
      "utf8",
    );
    const config = { agents: { list: [{ id: "main", default: true }] } };

    const preview = await stateMigrations[0].detectLegacyState(migrationParams(config));
    expect(preview?.preview).toEqual([expect.stringContaining("Memory Core short-term recall")]);

    const result = await stateMigrations[0].migrateLegacyState(migrationParams(config));

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Memory Core short-term recall -> SQLite plugin state (1 row(s))",
      expect.stringContaining("Archived Memory Core short-term recall legacy source"),
    ]);
    configureMemoryCoreDreamingState(context().openPluginStateKeyedStore);
    const recall = await shortTermTesting.readRecallStore(workspaceDir, "2026-04-05T12:00:00.000Z");
    expect(recall.entries["memory:memory/2026-04-05.md:1:1"]?.conceptTags).toContain("glacier");
  });
});
