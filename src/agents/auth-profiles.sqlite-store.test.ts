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
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
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

  it("does not read legacy auth-profiles.json at runtime", async () => {
    await withAgentDirEnv("openclaw-auth-no-json-fallback-", (agentDir) => {
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify(apiKeyStore("sk-json"))}\n`,
        "utf8",
      );

      const loaded = ensureAuthProfileStore(agentDir, { syncExternalCli: false });

      expect(loaded.profiles["openai:default"]).toBeUndefined();
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
