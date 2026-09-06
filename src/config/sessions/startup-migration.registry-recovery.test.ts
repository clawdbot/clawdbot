import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sessionDirs from "../../agents/session-dirs.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../../state/openclaw-agent-db-registry-listing.js";
import { unregisterOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  isOpenClawAgentDatabaseOpen,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  repairOpenClawStateDatabaseSchemaIfNeeded,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { loadCombinedSessionStoreForGatewayCore } from "./combined-store-gateway.js";
import { replaceSessionEntry } from "./session-accessor.js";
import {
  isCanonicalSqliteSessionMainKeyCurrent,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { runSessionStartupMigration } from "./startup-migration.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each(["cold", "preexisting"] as const)(
  "preserves the %s database lifetime for maintenance without a runtime handoff",
  async (lifetime) => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-startup-handle-lifetime-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const options = { agentId: "main", env };
    const initial = openOpenClawAgentDatabase(options);
    setCanonicalSqliteSessionMainKey(initial, "previous");
    if (lifetime === "cold") {
      closeOpenClawAgentDatabasesForTest();
    }

    await runSessionStartupMigration({
      cfg: { agents: { entries: { main: {} } } },
      env,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(isCanonicalSqliteSessionMainKeyCurrent(options, undefined)).toBe(true);
    expect(isOpenClawAgentDatabaseOpen(initial.path)).toBe(lifetime === "preexisting");
    if (lifetime === "preexisting") {
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBe(initial);
    }
  },
);

it("does not create a missing configured agent database during startup maintenance", async () => {
  const root = fs.realpathSync.native(tempDirs.make("openclaw-startup-missing-agent-db-"));
  const stateDir = path.join(root, "state");
  const storePath = path.join(stateDir, "agents", "idle", "sessions", "sessions.json");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const cfg: OpenClawConfig = {
    agents: { entries: { idle: { default: true } } },
    session: { store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json") },
  };
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
    agentId: "idle",
    env,
  }).path;
  const migrateManagedWorktreeCanonicalWorkspaces = vi.fn(async () => 0);

  await runSessionStartupMigration({
    cfg,
    env,
    log: { info: vi.fn(), warn: vi.fn() },
    deps: {
      migrateLegacyMainSessionKeys: vi.fn(async () => ({
        armed: false,
        changes: [],
        complete: false,
        ledgerComplete: false,
        legacyAgentId: "main",
        mainKey: "main",
        outcomes: [{ kind: "not-armed" as const }],
        warnings: [],
      })),
      migrateManagedWorktreeCanonicalWorkspaces,
      resolveAllAgentSessionStoreTargetsSync: () => [{ agentId: "idle", storePath }],
    },
  });

  expect(fs.existsSync(sqlitePath)).toBe(false);
  expect(migrateManagedWorktreeCanonicalWorkspaces).not.toHaveBeenCalled();
});

it("re-registers durable lineage children before configured-only runtime reads", async () => {
  const root = fs.realpathSync.native(tempDirs.make("openclaw-startup-registry-recovery-"));
  const stateDir = path.join(root, "state");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const env = { ...process.env };
    const storeTemplate = path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json");
    const cfg: OpenClawConfig = {
      agents: { entries: { ops: { default: true } } },
      session: { store: storeTemplate },
    };
    const mainKey = "agent:ops:main";
    const childKey = "agent:codex:subagent:upgrade-child";
    const storePathFor = (agentId: string) => storeTemplate.replace("{agentId}", agentId);

    await replaceSessionEntry(
      { agentId: "ops", env, sessionKey: mainKey, storePath: storePathFor("ops") },
      { sessionId: "session-ops", updatedAt: 20 },
    );
    await replaceSessionEntry(
      { agentId: "codex", env, sessionKey: childKey, storePath: storePathFor("codex") },
      { sessionId: "session-codex", spawnedBy: mainKey, updatedAt: 30 },
    );
    await replaceSessionEntry(
      {
        agentId: "local",
        env,
        sessionKey: "agent:local:main",
        storePath: storePathFor("local"),
      },
      { sessionId: "session-local", updatedAt: 10 },
    );

    const childDatabasePath = resolveSqliteTargetFromSessionStorePath(storePathFor("codex"), {
      agentId: "codex",
      env,
    }).path;
    closeOpenClawAgentDatabasesForTest();
    unregisterOpenClawAgentDatabase({ agentId: "codex", env, path: childDatabasePath });

    expect(fs.existsSync(childDatabasePath)).toBe(true);
    expect(
      listOpenClawRegisteredAgentDatabases({ env }).some(
        (entry) => entry.agentId === "codex" && entry.path === childDatabasePath,
      ),
    ).toBe(false);

    const migrateManagedWorktreeCanonicalWorkspaces = vi.fn(async () => 0);
    await runSessionStartupMigration({
      cfg,
      env,
      log: { info: vi.fn(), warn: vi.fn() },
      deps: {
        migrateManagedWorktreeCanonicalWorkspaces,
        migrateLegacyMainSessionKeys: vi.fn(async () => ({
          armed: false,
          changes: [],
          complete: false,
          ledgerComplete: false,
          legacyAgentId: "main",
          mainKey: "main",
          outcomes: [{ kind: "not-armed" as const }],
          warnings: [],
        })),
      },
    });
    expect(migrateManagedWorktreeCanonicalWorkspaces).toHaveBeenCalled();

    expect(listOpenClawRegisteredAgentDatabases({ env })).toContainEqual(
      expect.objectContaining({ agentId: "codex", path: childDatabasePath }),
    );

    const enumerateAgentDirs = vi.spyOn(sessionDirs, "resolveAgentSessionDirsFromAgentsDirSync");
    try {
      const store = loadCombinedSessionStoreForGatewayCore(cfg, {
        configuredAgentsOnly: true,
      }).store;
      expect(store[mainKey]?.sessionId).toBe("session-ops");
      expect(store[childKey]?.sessionId).toBe("session-codex");
      expect(store["agent:local:main"]).toBeUndefined();
      expect(enumerateAgentDirs).not.toHaveBeenCalled();
    } finally {
      enumerateAgentDirs.mockRestore();
    }
  });
});

it("keeps copied state directories self-contained for combined gateway reads", async () => {
  const root = fs.realpathSync.native(tempDirs.make("openclaw-copied-state-registry-"));
  const sourceStateDir = path.join(root, "source");
  fs.mkdirSync(sourceStateDir);
  const canonicalSourceStateDir = fs.realpathSync.native(sourceStateDir);
  const copiedStateDir = path.join(root, "copy");
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { default: true } } },
  };
  const sessionKey = "agent:main:copied-state";

  await withEnvAsync({ OPENCLAW_STATE_DIR: canonicalSourceStateDir }, async () => {
    const env = { ...process.env };
    await replaceSessionEntry(
      { agentId: "main", env, sessionKey },
      { sessionId: "copied-session", updatedAt: 1 },
    );
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    invalidateRegisteredAgentDatabasesMemo({ env });
  });

  fs.cpSync(canonicalSourceStateDir, copiedStateDir, { recursive: true });
  const canonicalCopiedStateDir = fs.realpathSync.native(copiedStateDir);
  await withEnvAsync({ OPENCLAW_STATE_DIR: canonicalCopiedStateDir }, async () => {
    const env = { ...process.env };
    expect(repairOpenClawStateDatabaseSchemaIfNeeded({ env }).warnings).toEqual([]);
    const combined = loadCombinedSessionStoreForGatewayCore(cfg, {
      configuredAgentsOnly: true,
    });

    expect(combined.store[sessionKey]?.sessionId).toBe("copied-session");
    expect(Object.keys(combined.store).filter((key) => key === sessionKey)).toHaveLength(1);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    invalidateRegisteredAgentDatabasesMemo({ env });
  });
});

it.each(["registry", "main-key"] as const)(
  "keeps the event loop responsive while repairing a cold %s startup contract",
  async (repair) => {
    const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-startup-admission-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const options = { agentId: "main", env };
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      session: {},
    };
    const initial = openOpenClawAgentDatabase(options);
    setCanonicalSqliteSessionMainKey(initial, repair === "main-key" ? "previous" : "main");
    closeOpenClawAgentDatabasesForTest();
    if (repair === "registry") {
      unregisterOpenClawAgentDatabase({ ...options, path: initial.path });
    }
    const originalOpen = nodeSqlite.openNodeSqliteDatabase;
    let yielded = false;
    let maintenanceSawProgress = false;
    let maintenanceSawSelectedKey = false;
    let tick: ReturnType<typeof setImmediate> | undefined;
    const open = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((location, behavior) => {
        const database = originalOpen(location, behavior);
        if (location === initial.path && behavior?.readOnly !== true) {
          // Earlier async setup cannot satisfy this admission-phase progress check.
          tick = setImmediate(() => {
            yielded = true;
            cfg.session!.mainKey = "later";
          });
        }
        return database;
      });
    const log = { info: vi.fn(), warn: vi.fn() };
    try {
      await runSessionStartupMigration({
        cfg,
        env,
        log,
        deps: {
          migrateManagedWorktreeCanonicalWorkspaces: async () => {
            maintenanceSawProgress = yielded;
            maintenanceSawSelectedKey = isCanonicalSqliteSessionMainKeyCurrent(options, undefined);
            return 0;
          },
        },
      });
      expect(log.warn).not.toHaveBeenCalled();
      expect(maintenanceSawProgress).toBe(true);
      expect(maintenanceSawSelectedKey).toBe(true);
      expect(listOpenClawRegisteredAgentDatabases({ env })).toContainEqual(
        expect.objectContaining({ agentId: "main", path: initial.path }),
      );
      expect(isOpenClawAgentDatabaseOpen(initial.path)).toBe(false);
    } finally {
      if (tick) {
        clearImmediate(tick);
      }
      open.mockRestore();
    }
  },
);
