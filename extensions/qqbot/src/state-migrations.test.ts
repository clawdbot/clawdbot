import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "../doctor-contract-api.js";
import { buildQQBotStateKey } from "./engine/utils/state-keys.js";

function requireStateMigration(index: number) {
  return expectDefined(stateMigrations[index], `QQBot state migration ${index}`);
}

type CredentialBackup = {
  accountId: string;
  appId: string;
  clientSecret: string;
  savedAt: string;
};

const createdDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("qqbot", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

function createEvictingDoctorContext(params: {
  values: Map<string, CredentialBackup>;
  evictedKey: string;
}): PluginDoctorStateMigrationContext {
  let shouldEvict = true;
  const store: PluginStateKeyedStore<CredentialBackup> = {
    async register(key, value) {
      params.values.set(key, value);
      if (shouldEvict) {
        shouldEvict = false;
        params.values.delete(params.evictedKey);
      }
    },
    async registerIfAbsent(key, value) {
      if (params.values.has(key)) {
        return false;
      }
      await store.register(key, value);
      return true;
    },
    async lookup(key) {
      return params.values.get(key);
    },
    async consume(key) {
      const value = params.values.get(key);
      params.values.delete(key);
      return value;
    },
    async delete(key) {
      return params.values.delete(key);
    },
    async entries() {
      return [...params.values].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      params.values.clear();
    },
  };
  return {
    openPluginStateKeyedStore<T>() {
      return store as unknown as PluginStateKeyedStore<T>;
    },
  };
}

describe("qqbot doctor state migration", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await createTempDir("qqbot-state-");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    resetPluginStateStoreForTests();
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  function migrationParams() {
    return {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };
  }

  it("imports an active-state credential backup and archives the source", async () => {
    const sourcePath = path.join(stateDir, "qqbot", "data", "credential-backup-default.json");
    const backup: CredentialBackup = {
      accountId: "default",
      appId: "app-1",
      clientSecret: "secret-1",
      savedAt: "2026-06-02T00:00:00.000Z",
    };
    await writeJson(sourcePath, backup);

    const migration = requireStateMigration(0);
    await expect(migration.detectLegacyState(migrationParams())).resolves.toMatchObject({
      preview: [expect.stringContaining("QQBot credential backups: 1 file")],
    });
    await expect(migration.migrateLegacyState(migrationParams())).resolves.toEqual({
      changes: [
        "Migrated 1 QQBot credential backup -> plugin state",
        expect.stringContaining("Archived QQBot credential backup legacy source"),
      ],
      warnings: [],
    });

    await expect(fs.access(sourcePath)).rejects.toThrow();
    await expect(fs.access(`${sourcePath}.migrated`)).resolves.toBeUndefined();
    if (process.platform !== "win32") {
      expect((await fs.stat(`${sourcePath}.migrated`)).mode & 0o777).toBe(0o600);
    }
    await expect(
      createDoctorContext(env)
        .openPluginStateKeyedStore<CredentialBackup>({
          namespace: "credential-backups",
          maxEntries: 1000,
        })
        .lookup(buildQQBotStateKey("credential-backup", "default")),
    ).resolves.toEqual(backup);
  });

  it("prefers per-account backups over the legacy singleton", async () => {
    const dataDir = path.join(stateDir, "qqbot", "data");
    const singlePath = path.join(dataDir, "credential-backup.json");
    const accountPath = path.join(dataDir, "credential-backup-default.json");
    await writeJson(singlePath, {
      accountId: "default",
      appId: "stale-app",
      clientSecret: "stale-secret",
      savedAt: "2026-06-01T00:00:00.000Z",
    });
    await writeJson(accountPath, {
      accountId: "default",
      appId: "current-app",
      clientSecret: "current-secret",
      savedAt: "2026-06-02T00:00:00.000Z",
    });

    const result = await requireStateMigration(0).migrateLegacyState(migrationParams());

    expect(result.warnings).toEqual([]);
    await expect(
      createDoctorContext(env)
        .openPluginStateKeyedStore<CredentialBackup>({
          namespace: "credential-backups",
          maxEntries: 1000,
        })
        .lookup(buildQQBotStateKey("credential-backup", "default")),
    ).resolves.toMatchObject({ appId: "current-app", clientSecret: "current-secret" });
    await expect(fs.access(`${singlePath}.migrated`)).resolves.toBeUndefined();
    await expect(fs.access(`${accountPath}.migrated`)).resolves.toBeUndefined();
  });

  it("ignores mismatched per-account backup filenames", async () => {
    await writeJson(path.join(stateDir, "qqbot", "data", "credential-backup-other.json"), {
      accountId: "default",
      appId: "wrong-app",
      clientSecret: "wrong-secret",
      savedAt: "2026-06-02T00:00:00.000Z",
    });

    await expect(requireStateMigration(0).detectLegacyState(migrationParams())).resolves.toBeNull();
  });

  it("does not scan credential backups outside the active state directory", async () => {
    const homeDir = await createTempDir("qqbot-home-");
    env.HOME = homeDir;
    await writeJson(
      path.join(homeDir, ".openclaw", "qqbot", "data", "credential-backup-default.json"),
      {
        accountId: "default",
        appId: "other-state-app",
        clientSecret: "other-state-secret",
        savedAt: "2026-06-02T00:00:00.000Z",
      },
    );

    await expect(requireStateMigration(0).detectLegacyState(migrationParams())).resolves.toBeNull();
  });

  it("restores credential state and preserves sources when plugin capacity evicts a row", async () => {
    const sourcePath = path.join(stateDir, "qqbot", "data", "credential-backup-new.json");
    await writeJson(sourcePath, {
      accountId: "new",
      appId: "new-app",
      clientSecret: "new-secret",
      savedAt: "2026-06-02T00:00:00.000Z",
    });
    const existingKey = buildQQBotStateKey("credential-backup", "existing");
    const incomingKey = buildQQBotStateKey("credential-backup", "new");
    const existingBackup: CredentialBackup = {
      accountId: "existing",
      appId: "existing-app",
      clientSecret: "existing-secret",
      savedAt: "2026-06-01T00:00:00.000Z",
    };
    const values = new Map([[existingKey, existingBackup]]);
    const params = migrationParams();
    params.context = createEvictingDoctorContext({ values, evictedKey: existingKey });

    const result = await requireStateMigration(0).migrateLegacyState(params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("plugin state capacity evicted")]);
    expect(values).toEqual(new Map([[existingKey, existingBackup]]));
    expect(values.has(incomingKey)).toBe(false);
    await expect(fs.access(sourcePath)).resolves.toBeUndefined();
    await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
  });

  it("does not migrate QQBot runtime caches", async () => {
    await writeJson(path.join(stateDir, "qqbot", "sessions", "session-default.json"), {
      sessionId: "session-1",
    });
    await writeJson(path.join(stateDir, "qqbot", "data", "known-users.json"), []);
    await fs.writeFile(path.join(stateDir, "qqbot", "data", "ref-index.jsonl"), "{}\n");

    await expect(requireStateMigration(0).detectLegacyState(migrationParams())).resolves.toBeNull();
  });
});
