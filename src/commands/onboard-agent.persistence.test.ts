import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readConfigFileSnapshot,
  replaceConfigFile,
  resetConfigRuntimeState,
} from "../config/config.js";
import { readExactSessionEntryRowForCanonicalRepair } from "../config/sessions/session-accessor.sqlite-canonical-repair.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { appendTranscriptEventInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { runSessionStartupMigration } from "../config/sessions/startup-migration.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { ensureOnboardingAgent } from "./onboard-agent.js";

describe("onboarding authored config persistence", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_AGENT_DIR", "OPENCLAW_STATE_DIR", "OPENCLAW_TOKEN"]);
  });

  afterEach(() => {
    envSnapshot.restore();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
  });

  it.each(["sourceConfig", "config"] as const)(
    "creates a named first agent from %s while retaining authored env references and includes",
    async (configShape) => {
      await withTempHome(async (rawHome) => {
        const home = await fs.realpath(rawHome);
        const configDir = path.join(home, ".openclaw");
        const configPath = path.join(configDir, "openclaw.json");
        const includePath = path.join(configDir, "channels.json");
        const includeRaw = JSON.stringify({ channels: { telegram: { enabled: true } } });
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(includePath, includeRaw);
        await fs.writeFile(
          configPath,
          `{
          $include: "./channels.json",
          gateway: { auth: { mode: "token", token: "\${OPENCLAW_TOKEN}" } }
        }`,
        );
        setTestEnvValue("OPENCLAW_TOKEN", "plaintext-secret");
        resetConfigRuntimeState();

        const snapshot = await readConfigFileSnapshot();
        const baseConfig = snapshot[configShape];
        const candidate = {
          ...baseConfig,
          gateway: { ...baseConfig.gateway, mode: "local" as const },
        };
        const result = await ensureOnboardingAgent({
          config: candidate,
          workspace: path.join(home, "workspace"),
          baseConfig,
          firstAgent: { name: "roster-proof" },
        });
        await replaceConfigFile({ nextConfig: result.config, afterWrite: { mode: "auto" } });

        const persistedRaw = await fs.readFile(configPath, "utf8");
        expect(result).toMatchObject({ agentId: "roster-proof", createdAgent: true });
        expect(JSON.parse(persistedRaw).agents.entries).toEqual({
          "roster-proof": expect.objectContaining({
            name: "roster-proof",
            workspace: path.join(home, "workspace"),
          }),
        });
        expect(persistedRaw).toContain("${OPENCLAW_TOKEN}");
        expect(persistedRaw).not.toContain("plaintext-secret");
        expect(persistedRaw).toContain("./channels.json");
        expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
      });
    },
  );

  it.each([
    { entries: { existing: { name: "Existing" } } },
    { entries: { main: {} } },
    { list: [{ id: "main", default: true }] },
    {
      list: [
        { id: "alpha", default: true, model: "fixture/alpha" },
        { id: "beta", model: "fixture/beta" },
      ],
    },
  ])("leaves an existing roster config byte-identical: %j", async (agents) => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const raw = `${JSON.stringify({ agents }, null, 2)}\n`;
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, raw);
      resetConfigRuntimeState();
      const snapshot = await readConfigFileSnapshot();

      const result = await ensureOnboardingAgent({
        config: snapshot.config,
        workspace: path.join(home, "workspace"),
        firstAgent: { name: "ignored" },
      });

      expect(result.createdAgent).toBe(false);
      expect(result.config.agents?.entries).toEqual(snapshot.config.agents?.entries);
      expect(snapshot.sourceConfigBeforeMigrations?.agents).toEqual(agents);
      expect(snapshot.sourceConfig.agents?.list).toBeUndefined();
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    });
  });

  it("renames a legacy install and converges its main session before returning", async () => {
    await withTempHome(async (rawHome) => {
      const home = await fs.realpath(rawHome);
      const stateDir = path.join(home, ".openclaw");
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      deleteTestEnvValue("OPENCLAW_AGENT_DIR");
      resetConfigRuntimeState();
      await replaceConfigFile({ nextConfig: {}, afterWrite: { mode: "auto" } });

      const legacyKey = "agent:main:main";
      const canonicalKey = "agent:robby:main";
      const legacyDatabasePath = path.join(
        stateDir,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      const entry = { sessionId: "legacy-main-session", updatedAt: 100 };
      runOpenClawAgentWriteTransaction(
        (database) => {
          writeSessionEntry(database, legacyKey, entry, {
            allowStoredAliases: true,
            previousEntry: null,
          });
          appendTranscriptEventInTransaction(
            database,
            {
              agentId: "main",
              path: legacyDatabasePath,
              sessionId: entry.sessionId,
              sessionKey: legacyKey,
            },
            { type: "message", text: "legacy history" },
            { allowStoredAlias: true },
          );
        },
        { agentId: "main", path: legacyDatabasePath },
      );

      const result = await ensureOnboardingAgent({
        config: {},
        workspace: path.join(stateDir, "workspace"),
        firstAgent: { name: "robby" },
      });
      const ownerDatabasePath = path.join(
        stateDir,
        "agents",
        "robby",
        "agent",
        "openclaw-agent.sqlite",
      );
      const readEntry = (databasePath: string, agentId: string, key: string) =>
        runOpenClawAgentWriteTransaction(
          (database) => readExactSessionEntryRowForCanonicalRepair(database, key)?.entry,
          { agentId, path: databasePath },
        );

      expect(result.agentId).toBe("robby");
      expect(readEntry(ownerDatabasePath, "robby", canonicalKey)).toMatchObject(entry);
      expect(readEntry(legacyDatabasePath, "main", legacyKey)).toBeUndefined();
      expect(
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) =>
            db
              .prepare(
                "SELECT status FROM migration_sources WHERE source_key = 'legacy-main-session-keys'",
              )
              .get() as { status: string },
        ),
      ).toEqual({ status: "completed" });
    });
  });

  it("surfaces a locked migration and converges it on the next startup", async () => {
    await withTempHome(async (rawHome) => {
      const home = await fs.realpath(rawHome);
      const stateDir = path.join(home, ".openclaw");
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      deleteTestEnvValue("OPENCLAW_AGENT_DIR");
      resetConfigRuntimeState();
      await replaceConfigFile({ nextConfig: {}, afterWrite: { mode: "auto" } });

      const legacyKey = "agent:main:main";
      const canonicalKey = "agent:robby:main";
      const legacyDatabasePath = path.join(
        stateDir,
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      );
      const entry = { sessionId: "locked-legacy-session", updatedAt: 100 };
      runOpenClawAgentWriteTransaction(
        (database) => {
          writeSessionEntry(database, legacyKey, entry, {
            allowStoredAliases: true,
            previousEntry: null,
          });
          appendTranscriptEventInTransaction(
            database,
            {
              agentId: "main",
              path: legacyDatabasePath,
              sessionId: entry.sessionId,
              sessionKey: legacyKey,
            },
            { type: "message", text: "locked history" },
            { allowStoredAlias: true },
          );
        },
        { agentId: "main", path: legacyDatabasePath },
      );
      const sourceDatabase = openOpenClawAgentDatabase({
        agentId: "main",
        path: legacyDatabasePath,
      });
      sourceDatabase.db.exec("BEGIN IMMEDIATE");
      let result: Awaited<ReturnType<typeof ensureOnboardingAgent>>;
      try {
        result = await ensureOnboardingAgent({
          config: {},
          workspace: path.join(stateDir, "workspace"),
          firstAgent: { name: "robby" },
        });
      } finally {
        sourceDatabase.db.exec("ROLLBACK");
      }

      expect(result.sessionMigrationWarnings).toEqual([
        expect.stringMatching(/incomplete.*openclaw doctor --fix/),
      ]);
      const readLedgerStatus = () =>
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) =>
            db
              .prepare(
                "SELECT status FROM migration_sources WHERE source_key = 'legacy-main-session-keys'",
              )
              .get() as { status: string } | undefined,
        );
      expect(readLedgerStatus()).toBeUndefined();
      const log = { info: vi.fn(), warn: vi.fn() };
      await runSessionStartupMigration({
        cfg: result.config,
        env: process.env,
        log,
        deps: {
          resolveAllAgentSessionStoreTargetsSync: () => [],
        },
      });
      const ownerDatabasePath = path.join(
        stateDir,
        "agents",
        "robby",
        "agent",
        "openclaw-agent.sqlite",
      );
      const readEntry = (databasePath: string, agentId: string, key: string) =>
        runOpenClawAgentWriteTransaction(
          (database) => readExactSessionEntryRowForCanonicalRepair(database, key)?.entry,
          { agentId, path: databasePath },
        );

      expect(readEntry(ownerDatabasePath, "robby", canonicalKey)).toMatchObject(entry);
      expect(readEntry(legacyDatabasePath, "main", legacyKey)).toBeUndefined();
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining("migrated retired main-agent session keys"),
      );
      expect(readLedgerStatus()).toEqual({ status: "completed" });
    });
  });
});
