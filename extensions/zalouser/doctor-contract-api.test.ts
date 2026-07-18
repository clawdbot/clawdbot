// Zalouser tests cover Doctor-owned state migration.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateSyncKeyedStoreForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { listSessionEntries, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { setZalouserRuntime } from "./src/runtime.js";
import {
  clearStoredZaloCredentials,
  resolveLegacyZalouserCredentialsPath,
  zalouserCredentialStoreKey,
  ZALOUSER_CREDENTIALS_MAX_ENTRIES,
  ZALOUSER_CREDENTIALS_NAMESPACE,
  type StoredZaloCredentials,
} from "./src/session-state.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("zalouser", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

function findMigration(id: string) {
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing Zalouser state migration: ${id}`);
  }
  return migration;
}

describe("zalouser doctor state migration", () => {
  let stateDir = "";
  let storePath = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-zalouser-doctor-"));
    storePath = path.join(stateDir, "sessions.json");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("imports a profile credential blob into SQLite before archiving it", async () => {
    const profile = "work";
    const filePath = resolveLegacyZalouserCredentialsPath(profile, env);
    const legacy = {
      imei: "imei-1",
      cookie: [{ key: "zpsid", value: "secret", domain: "chat.zalo.me" }],
      userAgent: "user-agent",
      language: "vi",
      lastUsedAt: "2026-07-02T12:00:00.000Z",
    };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(legacy));
    const createdAt = (await fs.stat(filePath)).mtime.toISOString();
    const migration = findMigration("zalouser-credentials-json-to-plugin-state");
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [
        `- Zalo Personal credentials: 1 file -> plugin state (${ZALOUSER_CREDENTIALS_NAMESPACE})`,
      ],
    });
    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Zalo Personal credentials for profile work",
      expect.stringContaining("Archived Zalo Personal credentials legacy source"),
    ]);
    const store = context.openPluginStateKeyedStore<StoredZaloCredentials>({
      namespace: ZALOUSER_CREDENTIALS_NAMESPACE,
      maxEntries: ZALOUSER_CREDENTIALS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(store.lookup(zalouserCredentialStoreKey(profile))).resolves.toEqual({
      profile,
      ...legacy,
      createdAt,
    });
    await expect(fs.access(`${filePath}.migrated`)).resolves.toBeUndefined();
  });

  it("archives legacy credentials without restoring an explicitly cleared profile", async () => {
    const profile = "work";
    const filePath = resolveLegacyZalouserCredentialsPath(profile, env);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      JSON.stringify({
        imei: "legacy-imei",
        cookie: [{ key: "zpsid", value: "legacy", domain: "chat.zalo.me" }],
        userAgent: "legacy-agent",
      }),
    );
    const runtime = createPluginRuntimeMock();
    runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("zalouser", {
        ...options,
        env: options.env ?? env,
      });
    setZalouserRuntime(runtime);
    clearStoredZaloCredentials(profile, env);
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };
    const migration = findMigration("zalouser-credentials-json-to-plugin-state");

    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Archived revoked Zalo Personal credential legacy source for profile work",
      expect.stringContaining("Archived Zalo Personal credentials legacy source"),
    ]);
    await expect(fs.access(`${filePath}.migrated`)).resolves.toBeUndefined();
  });

  it("moves legacy group-shaped DM sessions to canonical direct keys", async () => {
    const legacyKey = "agent:main:zalouser:group:user-1";
    const canonicalKey = "agent:main:zalouser:direct:user-1";
    const config = { session: { store: storePath, dmScope: "per-channel-peer" as const } };
    await upsertSessionEntry({
      agentId: "main",
      env,
      storePath,
      sessionKey: legacyKey,
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
        chatType: "direct",
        lastAccountId: "default",
      },
    });
    await upsertSessionEntry({
      agentId: "main",
      env,
      storePath,
      sessionKey: "agent:main:zalouser:group:room-1",
      entry: { sessionId: "group-session", updatedAt: 2, chatType: "group" },
    });
    const migration = findMigration("zalouser-direct-session-keys");
    const context = createDoctorContext(env);

    expect(
      await migration.detectLegacyState({ config, env, stateDir, oauthDir: stateDir, context }),
    ).toMatchObject({ preview: [expect.stringContaining("1 legacy row")] });
    await expect(
      migration.migrateLegacyState({ config, env, stateDir, oauthDir: stateDir, context }),
    ).resolves.toMatchObject({ changes: [expect.stringContaining("Migrated 1")], warnings: [] });

    const entries = new Map(
      listSessionEntries({ agentId: "main", env, storePath }).map(({ sessionKey, entry }) => [
        sessionKey,
        entry,
      ]),
    );
    expect(entries.has(legacyKey)).toBe(false);
    expect(entries.has("agent:main:zalouser:group:room-1")).toBe(true);
    expect(entries.get(canonicalKey)).toMatchObject({ sessionId: "session-1", chatType: "direct" });
  });

  it("keeps the freshest session when identity links collapse legacy peers", async () => {
    const firstLegacyKey = "agent:main:zalouser:group:user-1";
    const secondLegacyKey = "agent:main:zalouser:group:user-2";
    const canonicalKey = "agent:main:zalouser:direct:alice";
    const config = {
      session: {
        store: storePath,
        dmScope: "per-channel-peer" as const,
        identityLinks: { alice: ["zalouser:user-1", "zalouser:user-2"] },
      },
    };
    for (const [sessionKey, sessionId, updatedAt] of [
      [firstLegacyKey, "freshest", 5],
      [secondLegacyKey, "older", 2],
      [canonicalKey, "canonical", 4],
    ] as const) {
      await upsertSessionEntry({
        agentId: "main",
        env,
        storePath,
        sessionKey,
        entry: { sessionId, updatedAt, chatType: "direct", lastAccountId: "default" },
      });
    }
    const migration = findMigration("zalouser-direct-session-keys");
    const context = createDoctorContext(env);

    await expect(
      migration.migrateLegacyState({ config, env, stateDir, oauthDir: stateDir, context }),
    ).resolves.toMatchObject({ changes: [expect.stringContaining("Migrated 2")], warnings: [] });

    const entries = new Map(
      listSessionEntries({ agentId: "main", env, storePath }).map(({ sessionKey, entry }) => [
        sessionKey,
        entry,
      ]),
    );
    expect(entries.has(firstLegacyKey)).toBe(false);
    expect(entries.has(secondLegacyKey)).toBe(false);
    expect(entries.get(canonicalKey)).toMatchObject({ sessionId: "freshest", updatedAt: 5 });
  });
});
