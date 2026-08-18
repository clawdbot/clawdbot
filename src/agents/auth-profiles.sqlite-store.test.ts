/**
 * SQLite auth-profile store integration tests.
 * Verifies secrets/state persistence, runtime overlays, and legacy JSON
 * migration boundaries in temporary agent directories.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as kyselySync from "../infra/kysely-sync.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveAgentDir } from "./agent-scope.js";
import { loadPersistedAuthProfileStore } from "./auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import {
  ensureAuthProfileStore,
  getRuntimeAuthProfileStoreSnapshotRevision,
  saveAuthProfileStore,
} from "./auth-profiles/store.js";
import type { AuthProfileStore, OAuthCredential } from "./auth-profiles/types.js";

type RuntimeOnlyOverlay = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

const mocks = vi.hoisted(() => ({
  resolveExternalCliAuthProfiles: vi.fn<
    (store?: unknown, options?: unknown) => RuntimeOnlyOverlay[]
  >(() => []),
}));

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  resolveExternalCliAuthProfiles: mocks.resolveExternalCliAuthProfiles,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

function apiKeyStore(key: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key,
      },
    },
  };
}

async function withAgentDirEnv(prefix: string, run: (agentDir: string) => void | Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const agentDir = path.join(root, "agents", "main", "agent");
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_AGENT_DIR: agentDir,
      },
      async () => await run(agentDir),
    );
  } finally {
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("auth profile sqlite store", () => {
  beforeEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    mocks.resolveExternalCliAuthProfiles.mockReset();
    mocks.resolveExternalCliAuthProfiles.mockReturnValue([]);
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
  });

  it("persists auth profiles and runtime scheduling state in the agent sqlite database", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-", (agentDir) => {
      saveAuthProfileStore(
        {
          ...apiKeyStore("sk-test"),
          order: { openai: ["openai:default"] },
          lastGood: { openai: "openai:default" },
          usageStats: { "openai:default": { lastUsed: 123 } },
        },
        agentDir,
      );

      const loaded = ensureAuthProfileStore(agentDir, { syncExternalCli: false });

      expect(loaded.profiles["openai:default"]).toMatchObject({ key: "sk-test" });
      expect(loaded.order?.openai).toEqual(["openai:default"]);
      expect(loaded.lastGood?.openai).toBe("openai:default");
      expect(loaded.usageStats?.["openai:default"]?.lastUsed).toBe(123);
      expect(fs.existsSync(path.join(agentDir, "auth-profiles.json"))).toBe(false);
      expect(fs.existsSync(path.join(agentDir, "auth-state.json"))).toBe(false);
      expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(true);
    });
  });

  it("persists the relocated shared store through the shared-state adapter", async () => {
    await withAgentDirEnv("openclaw-auth-shared-state-", () => {
      writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      saveAuthProfileStore({
        ...apiKeyStore("sk-shared"),
        order: { openai: ["openai:default"] },
      });

      expect(ensureAuthProfileStore(undefined, { syncExternalCli: false })).toMatchObject({
        profiles: { "openai:default": { key: "sk-shared" } },
        order: { openai: ["openai:default"] },
      });
      const database = new DatabaseSync(resolveOpenClawStateSqlitePath());
      expect(
        database
          .prepare("SELECT store_key FROM auth_profile_stores WHERE store_key = 'shared'")
          .get(),
      ).toEqual({ store_key: "shared" });
      expect(
        database
          .prepare("SELECT store_key FROM auth_profile_state WHERE store_key = 'shared'")
          .get(),
      ).toEqual({ store_key: "shared" });
      database.close();
    });
  });

  it("does not read legacy auth-profiles.json at runtime", async () => {
    await withAgentDirEnv("openclaw-auth-no-json-fallback-", (agentDir) => {
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify(apiKeyStore("sk-json"))}\n`,
        "utf8",
      );

      expect(() => ensureAuthProfileStore(agentDir, { syncExternalCli: false })).toThrow(
        "requires legacy credential migration",
      );
    });
  });

  it("fails closed when a credential source appears during a successful SQLite read", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-late-legacy-", (agentDir) => {
      saveAuthProfileStore(apiKeyStore("not-a-real"), agentDir);
      const legacyPath = path.join(agentDir, "auth.json");
      const existsSync = fs.existsSync.bind(fs);
      let legacyChecks = 0;
      const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((pathname) => {
        if (path.resolve(String(pathname)) === path.resolve(legacyPath)) {
          legacyChecks += 1;
          if (legacyChecks === 2) {
            fs.writeFileSync(legacyPath, '{"openai":{"key":"not-a-real"}}\n', "utf8");
            return true;
          }
          return false;
        }
        return existsSync(pathname);
      });
      try {
        expect(() => ensureAuthProfileStore(agentDir, { syncExternalCli: false })).toThrow(
          "requires legacy credential migration",
        );
      } finally {
        existsSpy.mockRestore();
      }
      expect(fs.existsSync(legacyPath)).toBe(true);
    });
  });

  it("does not create sqlite files for missing-store reads", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-no-create-", (agentDir) => {
      expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
      expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    });
  });

  it("treats a legacy agent database without auth tables as a missing store", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-legacy-schema-", (agentDir) => {
      const database = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
      database.exec("CREATE TABLE legacy_state (id INTEGER PRIMARY KEY);");
      database.close();

      expect(inspectPersistedAuthProfileStoreRaw(agentDir)).toEqual({
        status: "missing",
        reason: "table",
      });
    });
  });

  it("classifies each missing auth table through an existing database handle", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-partial-schema-", (agentDir) => {
      const database = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
      database.exec(`
        CREATE TABLE auth_profile_store (
          store_key TEXT NOT NULL PRIMARY KEY,
          store_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      try {
        expect(inspectPersistedAuthProfileStoreRaw(agentDir, { db: database })).toEqual({
          status: "missing",
          reason: "row",
        });
        expect(inspectPersistedAuthProfileStateRaw(agentDir, { db: database })).toEqual({
          status: "missing",
          reason: "table",
        });
      } finally {
        database.close();
      }
    });
  });

  it("rejects a newer agent database that has no current auth table", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-newer-schema-", (agentDir) => {
      const database = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
      database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
      database.close();

      expect(inspectPersistedAuthProfileStoreRaw(agentDir)).toEqual({ status: "unreadable" });
    });
  });

  it("treats a non-table auth schema object as unreadable", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-invalid-schema-", (agentDir) => {
      const database = new DatabaseSync(resolveAuthProfileDatabasePath(agentDir));
      database.exec(
        "CREATE VIEW auth_profile_store AS SELECT 'primary' AS store_key, '{}' AS store_json;",
      );
      database.close();

      expect(inspectPersistedAuthProfileStoreRaw(agentDir)).toEqual({ status: "unreadable" });
    });
  });

  it("reads existing sqlite auth stores without registering shared state", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-readonly-", (agentDir) => {
      saveAuthProfileStore(apiKeyStore("sk-test"), agentDir);
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const stateDbPath = resolveOpenClawStateSqlitePath();
      fs.rmSync(path.dirname(stateDbPath), { recursive: true, force: true });

      const loaded = loadPersistedAuthProfileStore(agentDir);

      expect(loaded?.profiles["openai:default"]).toMatchObject({ key: "sk-test" });
      expect(fs.existsSync(stateDbPath)).toBe(false);
    });
  });

  it("reuses path-keyed read handles until the runtime snapshot revision changes", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-read-reuse-", (agentDir) => {
      const secondaryAgentDir = path.join(
        path.dirname(path.dirname(agentDir)),
        "secondary",
        "agent",
      );
      saveAuthProfileStore(apiKeyStore("sk-test"), agentDir);
      saveAuthProfileStore(apiKeyStore("sk-secondary"), secondaryAgentDir);
      closeOpenClawAgentDatabasesForTest();
      clearRuntimeAuthProfileStoreSnapshots();
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      const statementCacheSpy = vi.spyOn(kyselySync, "enableNodeSqliteKyselyStatementCache");
      try {
        const initialRevision = getRuntimeAuthProfileStoreSnapshotRevision(agentDir);
        expect(loadPersistedAuthProfileStore(agentDir)).not.toBeNull();
        expect(loadPersistedAuthProfileStore(secondaryAgentDir)).not.toBeNull();
        expect(loadPersistedAuthProfileStore(agentDir)).not.toBeNull();
        expect(loadPersistedAuthProfileStore(secondaryAgentDir)).not.toBeNull();
        expect(openSpy.mock.calls.filter(([, options]) => options?.readOnly === true)).toHaveLength(
          2,
        );
        expect(statementCacheSpy).toHaveBeenCalledTimes(2);
        const firstDatabase = openSpy.mock.results[0]?.value as DatabaseSync | undefined;
        const secondDatabase = openSpy.mock.results[1]?.value as DatabaseSync | undefined;
        expect(firstDatabase?.isOpen).toBe(true);
        expect(secondDatabase?.isOpen).toBe(true);

        replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: apiKeyStore("sk-test") }]);

        expect(getRuntimeAuthProfileStoreSnapshotRevision(agentDir)).toBeGreaterThan(
          initialRevision,
        );
        expect(firstDatabase?.isOpen).toBe(false);
        expect(secondDatabase?.isOpen).toBe(false);
        expect(loadPersistedAuthProfileStore(agentDir)).not.toBeNull();
        expect(openSpy.mock.calls.filter(([, options]) => options?.readOnly === true)).toHaveLength(
          3,
        );
        expect(statementCacheSpy).toHaveBeenCalledTimes(3);
      } finally {
        statementCacheSpy.mockRestore();
        openSpy.mockRestore();
      }
    });
  });

  it("reuses the transaction database while filtering multiple inherited OAuth profiles", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-save-reuse-", (mainAgentDir) => {
      const customAgentDir = path.join(path.dirname(path.dirname(mainAgentDir)), "custom", "agent");
      const profiles = Object.fromEntries(
        Array.from({ length: 3 }, (_, index) => [
          `openai:profile-${index}`,
          {
            type: "oauth" as const,
            provider: "openai",
            access: `access-${index}`,
            refresh: `refresh-${index}`,
            expires: Date.now() + 60_000,
          },
        ]),
      );
      const store: AuthProfileStore = { version: 1, profiles };
      saveAuthProfileStore(store, mainAgentDir);
      closeOpenClawAgentDatabasesForTest();
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      try {
        saveAuthProfileStore(store, customAgentDir);
        const readOnlyOpens = openSpy.mock.calls.filter(
          ([, options]) => options?.readOnly === true,
        );
        expect(readOnlyOpens).toHaveLength(1);
        expect(path.resolve(String(readOnlyOpens[0]?.[0]))).toBe(
          path.resolve(resolveAuthProfileDatabasePath(mainAgentDir)),
        );
      } finally {
        openSpy.mockRestore();
      }
    });
  });

  it("waits for brief rollback-journal contention before reading persisted auth", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-contention-", async (agentDir) => {
      saveAuthProfileStore(apiKeyStore("sk-test"), agentDir);
      closeOpenClawAgentDatabasesForTest();

      const databasePath = resolveAuthProfileDatabasePath(agentDir);
      const setup = new DatabaseSync(databasePath);
      setup.exec("PRAGMA journal_mode = DELETE;");
      setup.close();

      const child = spawn(
        process.execPath,
        [
          "-e",
          `
            const { DatabaseSync } = require("node:sqlite");
            const db = new DatabaseSync(process.argv[1]);
            db.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;");
            db.prepare(
              "UPDATE auth_profile_store SET updated_at = updated_at + 1 WHERE store_key = ?",
            ).run("primary");
            process.stdout.write("locked\\n");
            setTimeout(() => {
              db.exec("ROLLBACK;");
              db.close();
            }, 250);
          `,
          databasePath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const childExit = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`contention child exited with code ${code}`));
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        let locked = false;
        child.stdout.once("data", () => {
          locked = true;
          resolve();
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (!locked) {
            reject(new Error(`contention child exited before locking with code ${code}`));
          }
        });
      });

      const loaded = loadPersistedAuthProfileStore(agentDir);

      await childExit;
      expect(loaded?.profiles["openai:default"]).toMatchObject({ key: "sk-test" });
    });
  });

  it("uses the configured agent id for custom agentDir databases", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-custom-agent-", (envAgentDir) => {
      const customAgentDir = path.join(path.dirname(path.dirname(envAgentDir)), "custom-coder");
      const cfg = {
        agents: {
          list: [{ id: "coder", agentDir: customAgentDir }],
        },
      };
      const agentDir = resolveAgentDir(cfg, "coder");

      saveAuthProfileStore(apiKeyStore("sk-test"), agentDir);

      const database = openOpenClawAgentDatabase({
        agentId: "coder",
        path: resolveAuthProfileDatabasePath(agentDir),
      });
      expect(database.agentId).toBe("coder");
    });
  });

  it("keeps SecretRef-backed credentials from persisting duplicate plaintext", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-secret-ref-", (agentDir) => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "sk-plaintext",
              keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            },
            "anthropic:default": {
              type: "token",
              provider: "anthropic",
              token: "token-plaintext",
              tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_AUTH_TOKEN" },
            },
          },
        },
        agentDir,
      );

      const loaded = ensureAuthProfileStore(agentDir, { syncExternalCli: false });

      expect(loaded.profiles["openai:default"]).toEqual({
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      });
      expect(loaded.profiles["anthropic:default"]).toEqual({
        type: "token",
        provider: "anthropic",
        tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_AUTH_TOKEN" },
      });
    });
  });

  it("recomputes runtime-only external auth overlays from the sqlite base store", async () => {
    await withAgentDirEnv("openclaw-auth-sqlite-overlay-", (agentDir) => {
      saveAuthProfileStore(apiKeyStore("sk-test"), agentDir);
      mocks.resolveExternalCliAuthProfiles
        .mockReturnValueOnce([
          {
            profileId: "openai:default",
            credential: {
              type: "oauth",
              provider: "openai",
              access: "access-1",
              refresh: "refresh-1",
              expires: Date.now() + 60_000,
            },
          },
        ])
        .mockReturnValueOnce([
          {
            profileId: "openai:default",
            credential: {
              type: "oauth",
              provider: "openai",
              access: "access-2",
              refresh: "refresh-2",
              expires: Date.now() + 60_000,
            },
          },
        ]);

      const first = ensureAuthProfileStore(agentDir);
      const second = ensureAuthProfileStore(agentDir);

      expect((first.profiles["openai:default"] as OAuthCredential | undefined)?.access).toBe(
        "access-1",
      );
      expect((second.profiles["openai:default"] as OAuthCredential | undefined)?.access).toBe(
        "access-2",
      );
      expect(mocks.resolveExternalCliAuthProfiles).toHaveBeenCalledTimes(2);
    });
  });
});
