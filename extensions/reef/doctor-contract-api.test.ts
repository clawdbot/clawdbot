import fs from "node:fs";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";
import { generateIdentity } from "./protocol/index.js";
import { ReefChannelConfigSchema } from "./src/config-schema.js";
import {
  REEF_TRUST_STORE_MAX_ENTRIES,
  REEF_TRUST_STORE_NAMESPACE,
  resolveReefTrustStoreKey,
} from "./src/trust-store.js";

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
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(() => {
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

  it("imports config-backed trust into scoped plugin state without overwriting canonical rows", async () => {
    const cfg = legacyConfig();
    const migration = stateMigrations[0]!;
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
    const migration = stateMigrations[0]!;
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
      stateMigrations[0]!.migrateLegacyState({
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
