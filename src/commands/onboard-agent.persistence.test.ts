import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import {
  readConfigFileSnapshot,
  replaceConfigFile,
  resetConfigRuntimeState,
} from "../config/config.js";
import { readExactSessionEntryRowForCanonicalRepair } from "../config/sessions/session-accessor.sqlite-canonical-repair.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "../config/sessions/session-accessor.sqlite-read.js";
import { appendTranscriptEventInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { runSessionStartupMigration } from "../config/sessions/startup-migration.js";
import { resetAgentRunRegistryForTest } from "../infra/agent-run-registry.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
  readAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import { readAgentProvenance } from "../state/agent-provenance.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { ensureOnboardingAgent } from "./onboard-agent.js";

const migrationWindow = vi.hoisted(() => ({
  afterPublication: undefined as (() => void) | undefined,
}));
vi.mock("../config/config.js", async (original) => {
  const actual = await original<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: async () => {
      const snapshot = await actual.readConfigFileSnapshot();
      if (snapshot.config.agents?.entries?.robby) {
        const afterPublication = migrationWindow.afterPublication;
        migrationWindow.afterPublication = undefined;
        afterPublication?.();
      }
      return snapshot;
    },
  };
});

describe("onboarding authored config persistence", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_AGENT_DIR", "OPENCLAW_STATE_DIR", "OPENCLAW_TOKEN"]);
  });

  afterEach(() => {
    migrationWindow.afterPublication = undefined;
    resetAgentRunRegistryForTest();
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

  it.each(["locked", "closed after publication"] as const)(
    "defers migration when %s and converges on the next startup",
    async (boundary) => {
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
        const admission = prepareSystemAgentRunAdmission({}, "onboard-migration", "main", "setup");
        const beforePersistentApply = resolveAdmittedRunActiveAssertion(
          await admission.admit("embedded"),
        )!;
        const beforeRows = readTranscriptEventRows(sourceDatabase, entry.sessionId);
        if (boundary === "locked") {
          sourceDatabase.db.exec("BEGIN IMMEDIATE");
        } else {
          beginAgentDeletionJournal({
            agentId: "robby",
            operationId: "previous-robby",
            deleteFiles: false,
            agentDir: path.join(stateDir, "agents", "robby", "agent"),
            sessionsDir: path.join(stateDir, "agents", "robby", "sessions"),
            workspaceDir: path.join(stateDir, "workspace"),
          });
          runOpenClawStateWriteTransaction((sharedStateDatabase) =>
            completeAgentDeletionJournalInDatabase(sharedStateDatabase, "robby", "previous-robby"),
          );
          migrationWindow.afterPublication = () => {
            beforePersistentApply();
            admission.close();
          };
        }
        let result: Awaited<ReturnType<typeof ensureOnboardingAgent>> | undefined;
        let failure: unknown;
        try {
          result = await ensureOnboardingAgent({
            config: {},
            workspace: path.join(stateDir, "workspace"),
            firstAgent: { name: "robby" },
            beforePersistentApply,
          });
        } catch (error) {
          failure = error;
        } finally {
          if (boundary === "locked") {
            sourceDatabase.db.exec("ROLLBACK");
          }
          admission.close();
        }

        if (boundary === "locked") {
          expect(failure).toBeUndefined();
          expect(result?.sessionMigrationWarnings).toEqual([
            expect.stringMatching(/incomplete.*openclaw doctor --fix/),
          ]);
        } else {
          expect.soft(failure).toEqual(new Error("admitted run authority is no longer active"));
          expect.soft(readAgentDeletionJournal("robby")).toBeUndefined();
          expect.soft(readAgentProvenance("robby")).toMatchObject({ createdVia: "operator" });
          expect
            .soft(readExactSessionEntryRowForCanonicalRepair(sourceDatabase, legacyKey)?.entry)
            .toMatchObject(entry);
          expect.soft(readTranscriptEventRows(sourceDatabase, entry.sessionId)).toEqual(beforeRows);
          expect
            .soft(
              await fs
                .stat(path.join(stateDir, "agents", "robby", "agent", "openclaw-agent.sqlite"))
                .catch(() => null),
            )
            .toBeNull();
        }
        const readLedgerStatus = () =>
          withExistingOpenClawStateDatabaseReadOnly(
            ({ db }) =>
              db
                .prepare(
                  "SELECT status FROM migration_sources WHERE source_key = 'legacy-main-session-keys'",
                )
                .get() as { status: string } | undefined,
          );
        expect.soft(readLedgerStatus()).toBeUndefined();
        const published = await readConfigFileSnapshot();
        expect(Object.keys(published.config.agents?.entries ?? {})).toEqual(["robby"]);
        const log = { info: vi.fn(), warn: vi.fn() };
        await runSessionStartupMigration({
          cfg: published.config,
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
    },
  );
});
