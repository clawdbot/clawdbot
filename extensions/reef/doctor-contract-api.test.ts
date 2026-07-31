import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";
import {
  base64url,
  generateIdentity,
  MemoryAuditStore,
  type ReviewRequest,
} from "./protocol/index.js";
import { ReefChannelConfigSchema } from "./src/config-schema.js";
import {
  generateAndStoreKeys,
  loadKeys,
  openStores,
  REEF_AUDIT_MIGRATION_KEY,
  REEF_AUDIT_MIGRATION_MAX_ENTRIES,
  REEF_AUDIT_MIGRATION_NAMESPACE,
  REEF_AUDIT_HEAD_MAX_ENTRIES,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_NAMESPACE,
  REEF_AUDIT_STORE_MAX_ENTRIES,
  REEF_KEYS_KEY,
  REEF_KEYS_MAX_ENTRIES,
  REEF_KEYS_MIGRATION_KEY,
  REEF_KEYS_MIGRATION_MAX_ENTRIES,
  REEF_KEYS_MIGRATION_NAMESPACE,
  REEF_KEYS_NAMESPACE,
  REEF_DELIVERED_MAX_ENTRIES,
  REEF_DELIVERED_NAMESPACE,
  REEF_DELIVERED_TTL_MS,
  REEF_REPLAY_MAX_ENTRIES,
  REEF_REPLAY_NAMESPACE,
  REEF_REPLAY_TTL_MS,
  REEF_REGISTRATION_IDENTITY_KEY,
  REEF_REGISTRATION_MAX_ENTRIES,
  REEF_REGISTRATION_NAMESPACE,
  REEF_REVIEWS_MAX_ENTRIES,
  REEF_REVIEWS_NAMESPACE,
  reefAuditEntryKey,
  reefReplayStoreKey,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
  type ReefIdentityBinding,
  type ReefIdentityMigrationRecord,
  type ReefReplayRecord,
  type ReefReviewRecord,
} from "./src/state.js";
import {
  REEF_TRUST_STORE_MAX_ENTRIES,
  REEF_TRUST_STORE_NAMESPACE,
  resolveReefTrustStoreKey,
} from "./src/trust-store.js";
import type { ReefKeys } from "./src/types.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("reef", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

function migrationById(id: string) {
  const migration = stateMigrations.find((entry) => entry.id === id);
  if (!migration) {
    throw new Error(`missing migration ${id}`);
  }
  return migration;
}

function createRuntime(env: NodeJS.ProcessEnv) {
  const runtime = createPluginRuntimeMock();
  runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateSyncKeyedStoreForTests<T>("reef", {
      ...options,
      env: options.env ?? env,
    });
  return runtime;
}

function reefKeys(): ReefKeys {
  return {
    ...generateIdentity(),
    auditKey: base64url(new Uint8Array(32).fill(1)),
    replayKey: base64url(new Uint8Array(32).fill(2)),
    keyEpoch: 1,
  };
}

function legacyConfig(): OpenClawConfig {
  const identity = generateIdentity();
  return {
    channels: {
      reef: {
        enabled: true,
        handle: "owner",
        relayUrl: "https://reefwire.ai",
        requestPolicy: "code-only",
        dmPolicy: "pairing",
        allowFrom: ["peer"],
        friends: {
          peer: {
            autonomy: "extended",
            ed25519PublicKey: identity.signing.publicKey,
            x25519PublicKey: identity.encryption.publicKey,
            keyEpoch: 2,
            safetyNumberChanged: false,
          },
        },
      },
    },
  } as OpenClawConfig;
}

describe("Reef doctor contract", () => {
  let stateDir = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-doctor-"));
    vi.spyOn(os, "homedir").mockReturnValue(stateDir);
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("detects and removes retired config fields", () => {
    const cfg = legacyConfig();
    expect(legacyConfigRules[0]?.match?.(cfg.channels?.reef, cfg)).toBe(true);

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.changes).toEqual([
      "Removed retired Reef dmPolicy field.",
      "Removed retired Reef allowFrom field.",
    ]);
    expect(result.config.channels?.reef).toEqual({
      enabled: true,
      handle: "owner",
      relayUrl: "https://reefwire.ai",
      requestPolicy: "code-only",
      friends: expect.any(Object),
    });
  });

  it("imports identity keys into SQLite before archiving keys.json", async () => {
    const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
    const filePath = path.join(legacyDir, "keys.json");
    const keys = reefKeys();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(keys));
    const migration = migrationById("reef-keys-json-to-plugin-state");
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["- Reef identity keys -> plugin state (identity)"],
    });
    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated Reef identity keys -> plugin state",
      expect.stringContaining("Archived Reef identity keys legacy source"),
    ]);
    const store = context.openPluginStateKeyedStore<ReefKeys>({
      namespace: REEF_KEYS_NAMESPACE,
      maxEntries: REEF_KEYS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(store.lookup(REEF_KEYS_KEY)).resolves.toEqual(keys);
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
  });

  it("does not import the default home's Reef identity into an isolated state", async () => {
    const homeDir = path.join(stateDir, "home");
    const isolatedStateDir = path.join(stateDir, "isolated");
    const homeKeysPath = path.join(homeDir, ".openclaw", "data", "reef", "keys.json");
    fs.mkdirSync(path.dirname(homeKeysPath), { recursive: true });
    fs.mkdirSync(isolatedStateDir, { recursive: true });
    fs.writeFileSync(homeKeysPath, JSON.stringify(reefKeys()));
    vi.mocked(os.homedir).mockReturnValue(homeDir);
    const isolatedEnv = { ...env, OPENCLAW_STATE_DIR: isolatedStateDir };
    const migration = migrationById("reef-keys-json-to-plugin-state");
    const params = {
      config: {},
      env: isolatedEnv,
      stateDir: isolatedStateDir,
      oauthDir: path.join(isolatedStateDir, "oauth"),
      context: createDoctorContext(isolatedEnv),
    };

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(fs.existsSync(homeKeysPath)).toBe(true);
  });

  it("imports an explicitly configured default-home Reef identity into isolated state", async () => {
    const homeDir = path.join(stateDir, "explicit-home");
    const isolatedStateDir = path.join(stateDir, "explicit-isolated");
    const legacyDir = path.join(homeDir, ".openclaw", "data", "reef");
    const homeKeysPath = path.join(legacyDir, "keys.json");
    const keys = reefKeys();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(isolatedStateDir, { recursive: true });
    fs.writeFileSync(homeKeysPath, JSON.stringify(keys));
    vi.mocked(os.homedir).mockReturnValue(homeDir);
    const isolatedEnv = { ...env, OPENCLAW_STATE_DIR: isolatedStateDir };
    const context = createDoctorContext(isolatedEnv);
    const migration = migrationById("reef-keys-json-to-plugin-state");
    const params = {
      config: { channels: { reef: { stateDir: legacyDir } } },
      env: isolatedEnv,
      stateDir: isolatedStateDir,
      oauthDir: path.join(isolatedStateDir, "oauth"),
      context,
    };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["- Reef identity keys -> plugin state (identity)"],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({ warnings: [] });
    await expect(
      context
        .openPluginStateKeyedStore<ReefKeys>({
          namespace: REEF_KEYS_NAMESPACE,
          maxEntries: REEF_KEYS_MAX_ENTRIES,
          overflowPolicy: "reject-new",
        })
        .lookup(REEF_KEYS_KEY),
    ).resolves.toEqual(keys);
    expect(fs.existsSync(homeKeysPath)).toBe(false);
    expect(fs.existsSync(`${homeKeysPath}.migrated`)).toBe(true);
  });

  it("blocks identity regeneration after a failed keys.json import", async () => {
    const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
    const filePath = path.join(legacyDir, "keys.json");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(filePath, "{broken");
    const migration = migrationById("reef-keys-json-to-plugin-state");
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };

    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([
      expect.stringContaining("Failed importing Reef identity keys"),
    ]);
    fs.rmSync(filePath);
    const missingSourceResult = await migration.migrateLegacyState(params);
    expect(missingSourceResult.warnings).toEqual([
      expect.stringContaining("migration is incomplete and keys.json is missing"),
    ]);
    await expect(generateAndStoreKeys(createRuntime(env))).rejects.toThrow(
      "migration is incomplete",
    );
  });

  it("keeps legacy identity keys blocked until their handle binding is canonical", async () => {
    const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
    const keys = reefKeys();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keys.json"), JSON.stringify(keys));
    fs.writeFileSync(
      path.join(legacyDir, "identity.json"),
      JSON.stringify({ handle: "molty", relayUrl: "https://reefwire.ai" }),
    );
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    const keysResult = await migrationById("reef-keys-json-to-plugin-state").migrateLegacyState(
      params,
    );

    expect(keysResult.warnings).toEqual([]);
    const migrationStore = context.openPluginStateKeyedStore<ReefIdentityMigrationRecord>({
      namespace: REEF_KEYS_MIGRATION_NAMESPACE,
      maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(migrationStore.lookup(REEF_KEYS_MIGRATION_KEY)).resolves.toEqual({
      pending: true,
      identityBindingRequired: true,
    });
    await expect(loadKeys(createRuntime(env))).rejects.toThrow(
      "durable state migration is incomplete",
    );

    const registrationResult = await migrationById(
      "reef-registration-json-to-plugin-state",
    ).migrateLegacyState(params);

    expect(registrationResult.warnings).toEqual([]);
    expect(registrationResult.changes).toContain(
      "Verified Reef identity keys and binding; cleared migration marker",
    );
    await expect(migrationStore.lookup(REEF_KEYS_MIGRATION_KEY)).resolves.toBeUndefined();
    await expect(loadKeys(createRuntime(env))).rejects.toThrow(
      "durable state migration is incomplete",
    );
    await migrationById("reef-runtime-files-to-plugin-state").migrateLegacyState(params);
    await expect(loadKeys(createRuntime(env))).resolves.toEqual(keys);
  });

  it("binds wizard-created legacy keys when unrelated Reef config is invalid", async () => {
    const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
    const keys = reefKeys();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keys.json"), JSON.stringify(keys));
    const context = createDoctorContext(env);
    const params = {
      config: {
        channels: {
          reef: {
            handle: "molty",
            relayUrl: "https://reefwire.ai/",
            email: "not-an-email",
          },
        },
      },
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    await expect(
      migrationById("reef-registration-json-to-plugin-state").detectLegacyState(params),
    ).resolves.toEqual({
      preview: ["- Reef configured identity binding -> plugin state"],
    });

    await migrationById("reef-keys-json-to-plugin-state").migrateLegacyState(params);
    const migrationStore = context.openPluginStateKeyedStore<ReefIdentityMigrationRecord>({
      namespace: REEF_KEYS_MIGRATION_NAMESPACE,
      maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(migrationStore.lookup(REEF_KEYS_MIGRATION_KEY)).resolves.toEqual({
      pending: true,
      identityBindingRequired: true,
    });

    const registrationResult = await migrationById(
      "reef-registration-json-to-plugin-state",
    ).migrateLegacyState(params);

    expect(registrationResult.warnings).toEqual([]);
    expect(registrationResult.changes).toContain(
      "Migrated Reef identity binding from config -> plugin state",
    );
    const registrationStore = context.openPluginStateKeyedStore<ReefIdentityBinding>({
      namespace: REEF_REGISTRATION_NAMESPACE,
      maxEntries: REEF_REGISTRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(registrationStore.lookup(REEF_REGISTRATION_IDENTITY_KEY)).resolves.toEqual({
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });
    await expect(migrationStore.lookup(REEF_KEYS_MIGRATION_KEY)).resolves.toBeUndefined();
  });

  it("keeps identity migration blocked when config conflicts with the imported binding", async () => {
    const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "keys.json"), JSON.stringify(reefKeys()));
    fs.writeFileSync(
      path.join(legacyDir, "identity.json"),
      JSON.stringify({ handle: "canonical", relayUrl: "https://reefwire.ai" }),
    );
    const context = createDoctorContext(env);
    const params = {
      config: {
        channels: {
          reef: { handle: "conflict", relayUrl: "https://reefwire.ai" },
        },
      },
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    await migrationById("reef-keys-json-to-plugin-state").migrateLegacyState(params);
    const result = await migrationById("reef-registration-json-to-plugin-state").migrateLegacyState(
      params,
    );

    expect(result.warnings).toEqual([
      expect.stringContaining("configured handle or relay differs"),
      expect.stringContaining("identity migration is incomplete"),
    ]);
    const migrationStore = context.openPluginStateKeyedStore<ReefIdentityMigrationRecord>({
      namespace: REEF_KEYS_MIGRATION_NAMESPACE,
      maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(migrationStore.lookup(REEF_KEYS_MIGRATION_KEY)).resolves.toEqual({
      pending: true,
      identityBindingRequired: true,
    });
  });

  it("imports and verifies the append-only audit chain", async () => {
    const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
    const filePath = path.join(legacyDir, "audit.jsonl");
    const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
    await audit.appendEvent("one", { id: 1 }, 10);
    await audit.appendEvent("two", { id: 2 }, 11);
    const entries = await audit.entries();
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const migration = migrationById("reef-audit-jsonl-to-plugin-state");
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([
      "Migrated 2 Reef audit entries -> plugin state",
      expect.stringContaining("Archived Reef audit trail legacy source"),
    ]);
    const store = context.openPluginStateKeyedStore<ReefAuditStateRecord>({
      namespace: REEF_AUDIT_NAMESPACE,
      maxEntries: REEF_AUDIT_STORE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const headStore = context.openPluginStateKeyedStore<ReefAuditHeadRecord>({
      namespace: REEF_AUDIT_HEAD_NAMESPACE,
      maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(headStore.lookup(REEF_AUDIT_HEAD_KEY)).resolves.toEqual({
      kind: "head",
      hash: entries[1]!.entryHash,
      seq: 2,
      oldestHash: entries[0]!.entryHash,
    });
    await expect(store.lookup(reefAuditEntryKey(entries[0]!.entryHash))).resolves.toEqual({
      kind: "entry",
      entry: entries[0],
      nextHash: entries[1]!.entryHash,
    });
    expect(fs.existsSync(`${filePath}.migrated`)).toBe(true);
  });

  it("finishes an interrupted migration of an empty audit trail", async () => {
    const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
    const filePath = path.join(legacyDir, "audit.jsonl");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(filePath, "");
    const migration = migrationById("reef-audit-jsonl-to-plugin-state");
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    const imported = await migration.migrateLegacyState(params);
    expect(imported.warnings).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);

    const migrationStore = context.openPluginStateKeyedStore<{
      pending: true;
      expectedEntries: number;
    }>({
      namespace: REEF_AUDIT_MIGRATION_NAMESPACE,
      maxEntries: REEF_AUDIT_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await migrationStore.register(REEF_AUDIT_MIGRATION_KEY, {
      pending: true,
      expectedEntries: 0,
    });

    const recovered = await migration.migrateLegacyState(params);

    expect(recovered.warnings).toEqual([]);
    expect(recovered.changes).toContain(
      "Verified Reef audit trail; cleared completed migration marker",
    );
    await expect(migrationStore.lookup(REEF_AUDIT_MIGRATION_KEY)).resolves.toBeUndefined();
  });

  it("blocks runtime audit writes until a failed legacy import is repaired", async () => {
    const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
    const filePath = path.join(legacyDir, "audit.jsonl");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(filePath, "{broken\n");
    const migration = migrationById("reef-audit-jsonl-to-plugin-state");
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    const failed = await migration.migrateLegacyState(params);

    expect(failed.warnings).toEqual([expect.stringContaining("Failed importing Reef audit trail")]);
    const migrationStore = context.openPluginStateKeyedStore<{ pending: true }>({
      namespace: REEF_AUDIT_MIGRATION_NAMESPACE,
      maxEntries: REEF_AUDIT_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(migrationStore.lookup(REEF_AUDIT_MIGRATION_KEY)).resolves.toEqual({
      pending: true,
    });
    expect(() => openStores(createRuntime(env), reefKeys())).toThrow(
      "Reef durable state migration is incomplete",
    );

    const audit = new MemoryAuditStore(new Uint8Array(32).fill(1));
    await audit.appendEvent("repaired", { id: 1 }, 10);
    const entries = await audit.entries();
    fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const repaired = await migration.migrateLegacyState(params);

    expect(repaired.warnings).toEqual([]);
    await expect(migrationStore.lookup(REEF_AUDIT_MIGRATION_KEY)).resolves.toBeUndefined();
    await migrationById("reef-runtime-files-to-plugin-state").migrateLegacyState(params);
    expect(() => openStores(createRuntime(env), reefKeys())).not.toThrow();
  });

  it("imports registration and durable runtime state before archiving files", async () => {
    const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, "identity.json"),
      JSON.stringify({ handle: "molty", relayUrl: "https://reefwire.ai" }),
    );
    fs.writeFileSync(
      path.join(legacyDir, "setup-session.json"),
      JSON.stringify({
        session: "setup-secret",
        relayUrl: "https://reefwire.ai",
        email: "molty@example.com",
      }),
    );
    const replayId = "01JZ0000000000000000000000";
    const secondReplayId = "01JZ0000000000000000000001";
    fs.writeFileSync(
      path.join(legacyDir, "replay.jsonl"),
      `${JSON.stringify({ op: "claim", peer: "alice", id: replayId, envelopeHash: "a".repeat(64) })}\n${JSON.stringify({ op: "consume", peer: "alice", id: replayId })}\n${JSON.stringify({ op: "claim", peer: "bob", id: secondReplayId, envelopeHash: "d".repeat(64) })}\n`,
    );
    const review: ReviewRequest = {
      id: replayId,
      from: "alice#1",
      to: "bob#1",
      direction: "outbound",
      bodyHash: "b".repeat(64),
      approvalDigest: "c".repeat(64),
      verdict: {
        decision: "review",
        category: "ambiguous",
        reason: "Owner review.",
        model: "test-model",
        policyVersion: "v1",
      },
    };
    fs.writeFileSync(
      path.join(legacyDir, "reviews.json"),
      JSON.stringify({ [review.approvalDigest]: { review, approved: true } }),
    );
    fs.writeFileSync(path.join(legacyDir, "delivered.json"), JSON.stringify([replayId]));
    const context = createDoctorContext(env);
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };
    const partiallyImportedReplay = context.openPluginStateKeyedStore<ReefReplayRecord>({
      namespace: REEF_REPLAY_NAMESPACE,
      maxEntries: REEF_REPLAY_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_REPLAY_TTL_MS,
    });
    await partiallyImportedReplay.register(reefReplayStoreKey("alice", replayId), {
      peer: "alice",
      id: replayId,
      envelopeHash: "a".repeat(64),
      state: "consumed",
    });

    const registration = await migrationById(
      "reef-registration-json-to-plugin-state",
    ).migrateLegacyState(params);
    const runtimeState = await migrationById(
      "reef-runtime-files-to-plugin-state",
    ).migrateLegacyState(params);
    await expect(generateAndStoreKeys(createRuntime(env))).rejects.toThrow("has no canonical keys");

    expect(registration.warnings).toEqual([]);
    expect(registration.changes).toHaveLength(4);
    expect(runtimeState.warnings).toEqual([]);
    expect(runtimeState.changes).toHaveLength(7);
    for (const filename of [
      "identity.json",
      "setup-session.json",
      "replay.jsonl",
      "reviews.json",
      "delivered.json",
    ]) {
      expect(fs.existsSync(path.join(legacyDir, filename))).toBe(false);
      expect(fs.existsSync(path.join(legacyDir, `${filename}.migrated`))).toBe(true);
    }
    const replayStore = context.openPluginStateKeyedStore<ReefReplayRecord>({
      namespace: REEF_REPLAY_NAMESPACE,
      maxEntries: REEF_REPLAY_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_REPLAY_TTL_MS,
    });
    await expect(replayStore.lookup(reefReplayStoreKey("alice", replayId))).resolves.toMatchObject({
      state: "consumed",
      envelopeHash: "a".repeat(64),
    });
    await expect(
      replayStore.lookup(reefReplayStoreKey("bob", secondReplayId)),
    ).resolves.toMatchObject({
      state: "available",
      envelopeHash: "d".repeat(64),
    });
    const reviewStore = context.openPluginStateKeyedStore<ReefReviewRecord>({
      namespace: REEF_REVIEWS_NAMESPACE,
      maxEntries: REEF_REVIEWS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(reviewStore.lookup(review.approvalDigest)).resolves.toEqual({
      review,
      approved: true,
    });
    const deliveredStore = context.openPluginStateKeyedStore<{ id: string }>({
      namespace: REEF_DELIVERED_NAMESPACE,
      maxEntries: REEF_DELIVERED_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      defaultTtlMs: REEF_DELIVERED_TTL_MS,
    });
    await expect(deliveredStore.lookup(replayId)).resolves.toEqual({ id: replayId });
  });

  it("leaves oversized replay and delivered sources blocked and unarchived", async () => {
    const legacyDir = path.join(stateDir, ".openclaw", "data", "reef");
    const replayPath = path.join(legacyDir, "replay.jsonl");
    const deliveredPath = path.join(legacyDir, "delivered.json");
    fs.mkdirSync(legacyDir, { recursive: true });
    const replayIds = Array.from(
      { length: REEF_REPLAY_MAX_ENTRIES + 1 },
      (_, index) => `replay-${index}`,
    );
    fs.writeFileSync(
      replayPath,
      `${replayIds
        .map((id) => JSON.stringify({ op: "claim", peer: "alice", id, envelopeHash: id }))
        .join("\n")}\n`,
    );
    fs.writeFileSync(
      deliveredPath,
      JSON.stringify(
        Array.from({ length: REEF_DELIVERED_MAX_ENTRIES + 1 }, (_, index) => `delivered-${index}`),
      ),
    );
    const migration = migrationById("reef-runtime-files-to-plugin-state");
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };

    const result = await migration.migrateLegacyState(params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        `${REEF_REPLAY_MAX_ENTRIES + 1} replay bindings exceed plugin-state capacity`,
      ),
      expect.stringContaining(
        `${REEF_DELIVERED_MAX_ENTRIES + 1} delivered markers exceed plugin-state capacity`,
      ),
      expect.stringContaining("Reef durable state migration is incomplete"),
    ]);
    for (const filePath of [replayPath, deliveredPath]) {
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.existsSync(`${filePath}.migrated`)).toBe(false);
    }
  });

  it("imports config-backed trust into scoped plugin state without overwriting canonical rows", async () => {
    const cfg = legacyConfig();
    const migration = migrationById("reef-config-trust-to-plugin-state");
    const context = createDoctorContext(env);
    const params = { config: cfg, env, stateDir, oauthDir: path.join(stateDir, "oauth"), context };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["- Reef peer trust: config -> plugin state (1 peer(s), 0 invalid)"],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: ["Migrated Reef peer trust -> plugin state (1 imported, 0 already present)"],
      warnings: [],
    });

    const canonical = ReefChannelConfigSchema.parse({
      handle: "owner",
      relayUrl: "https://reefwire.ai",
      requestPolicy: "code-only",
    });
    const store = context.openPluginStateKeyedStore<{
      revision: number;
      trust: { autonomy: string; approvedAt: number };
    }>({
      namespace: REEF_TRUST_STORE_NAMESPACE,
      maxEntries: REEF_TRUST_STORE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const peerKey = resolveReefTrustStoreKey(canonical, "peer");
    await expect(store.lookup(peerKey)).resolves.toMatchObject({
      revision: 1,
      trust: { autonomy: "extended", approvedAt: 0 },
    });
    await expect(migration.detectLegacyState(params)).resolves.toBeNull();
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    await store.delete(peerKey);
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    await expect(store.lookup(peerKey)).resolves.toBeUndefined();
  });

  it("migrates valid rows but retains the legacy map when another row is invalid", async () => {
    const cfg = legacyConfig();
    const reef = cfg.channels?.reef as Record<string, unknown>;
    reef.friends = {
      ...(reef.friends as Record<string, unknown>),
      broken: { autonomy: "extended" },
    };
    const migration = migrationById("reef-config-trust-to-plugin-state");
    const context = createDoctorContext(env);
    const params = { config: cfg, env, stateDir, oauthDir: path.join(stateDir, "oauth"), context };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: ["- Reef peer trust: config -> plugin state (1 peer(s), 1 invalid)"],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toEqual({
      changes: ["Migrated Reef peer trust -> plugin state (1 imported, 0 already present)"],
      warnings: ["Skipped 1 invalid Reef peer trust row(s); left legacy friends config in place"],
    });

    const normalized = normalizeCompatibilityConfig({ cfg });
    expect(normalized.config.channels?.reef).toHaveProperty("friends.broken");
    expect(normalized.config.channels?.reef).not.toHaveProperty("dmPolicy");
    expect(normalized.config.channels?.reef).not.toHaveProperty("allowFrom");
  });

  it("does not partially migrate when the trust namespace is full", async () => {
    const cfg = legacyConfig();
    const registerIfAbsent = vi.fn();
    const context = {
      openPluginStateKeyedStore() {
        return {
          entries: async () =>
            Array.from({ length: REEF_TRUST_STORE_MAX_ENTRIES }, (_, index) => ({
              key: `existing-${index}`,
              value: {},
              createdAt: 0,
            })),
          registerIfAbsent,
        } as never;
      },
    } as PluginDoctorStateMigrationContext;

    await expect(
      migrationById("reef-config-trust-to-plugin-state").migrateLegacyState({
        config: cfg,
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
        context,
      }),
    ).resolves.toEqual({
      changes: [],
      warnings: [
        "Skipped Reef peer trust migration because plugin state has room for 0 of 1 trust row(s) and 0 of 1 import marker(s); left legacy friends config in place",
      ],
    });
    expect(registerIfAbsent).not.toHaveBeenCalled();
  });
});
