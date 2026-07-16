import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthHealthSummary } from "../../../agents/auth-health.js";
import { testing as externalAuthTesting } from "../../../agents/auth-profiles/external-auth.test-support.js";
import { resolveAuthProfileOrder } from "../../../agents/auth-profiles/order.js";
import {
  resolveAuthStorePath,
  resolveLegacyAuthStorePath,
} from "../../../agents/auth-profiles/paths.js";
import {
  resolveAuthProfileDatabasePath,
  resolveAuthProfileDatabaseFilePaths,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import { resetProviderAuthAliasMapCacheForTest } from "../../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import {
  collectStaleConfiguredAuthOrderWarnings,
  maybeRepairStaleConfiguredAuthOrders,
} from "./stale-auth-order.js";
import { repairStaleConfiguredAuthOrders } from "./stale-auth-order.test-support.js";

const pluginMetadataMocks = vi.hoisted(() => {
  const snapshot = {
    plugins: [
      {
        id: "anthropic",
        origin: "bundled",
        providerAuthChoices: [
          {
            provider: "anthropic",
            method: "cli",
            choiceId: "anthropic-cli",
            deprecatedChoiceIds: ["claude-cli"],
          },
        ],
      },
    ],
    diagnostics: [],
  };
  return {
    getCurrentPluginMetadataSnapshot: vi.fn(() => snapshot),
    loadPluginMetadataSnapshot: vi.fn(() => snapshot),
  };
});

vi.mock("../../../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: pluginMetadataMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginMetadataMocks.loadPluginMetadataSnapshot,
}));

function tokenStore(params: {
  profileId: string;
  provider?: string;
  token?: string;
  expires?: number;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "token",
        provider: params.provider ?? "claude-cli",
        token: params.token ?? "setup-token",
        ...(params.expires === undefined ? {} : { expires: params.expires }),
      },
    },
  };
}

function repair(
  cfg: OpenClawConfig,
  stores: AuthProfileStore[],
  runtimeProfileIds?: ReadonlySet<string>,
) {
  return repairStaleConfiguredAuthOrders({
    cfg,
    stores,
    ...(runtimeProfileIds ? { runtimeProfileIds } : {}),
  });
}

describe("repairStaleConfiguredAuthOrders", () => {
  beforeEach(() => {
    resetProviderAuthAliasMapCacheForTest();
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  });

  afterEach(() => {
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  });

  it("removes a stale Claude OAuth order so the live setup-token profile becomes effective", () => {
    const store = tokenStore({ profileId: "claude-cli:setup-token" });
    const cfg = {
      auth: {
        order: { anthropic: ["anthropic:claude-cli"] },
      },
    } satisfies OpenClawConfig;
    const before = buildAuthHealthSummary({ cfg, store });
    const result = repair(cfg, [store]);
    const after = buildAuthHealthSummary({ cfg: result.config, store });

    expect(before.providers).toEqual([
      expect.objectContaining({ provider: "claude-cli", status: "missing", effectiveProfiles: [] }),
    ]);
    expect(result.config.auth?.order?.anthropic).toBeUndefined();
    expect(after.providers).toEqual([
      expect.objectContaining({
        provider: "claude-cli",
        status: "ok",
        effectiveProfiles: [expect.objectContaining({ profileId: "claude-cli:setup-token" })],
      }),
    ]);
    expect(
      resolveAuthProfileOrder({
        cfg: result.config,
        store,
        provider: "claude-cli",
      }),
    ).toEqual(["claude-cli:setup-token"]);
    expect(result.changes).toEqual([
      "auth.order.anthropic: removed 1 missing profile reference to restore automatic per-agent auth selection.",
    ]);
  });

  it("preserves an explicit empty order", () => {
    const cfg = { auth: { order: { anthropic: [] } } } satisfies OpenClawConfig;

    const result = repair(cfg, [tokenStore({ profileId: "claude-cli:setup-token" })]);

    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it.each([null, "anthropic:missing", { profile: "anthropic:missing" }])(
    "leaves malformed auth-order entries to config validation",
    (orderEntry) => {
      const cfg = {
        auth: { order: { anthropic: orderEntry } },
      } as unknown as OpenClawConfig;

      expect(repair(cfg, [tokenStore({ profileId: "claude-cli:setup-token" })])).toEqual({
        config: cfg,
        changes: [],
      });
      expect(
        collectStaleConfiguredAuthOrderWarnings({
          cfg,
          doctorFixCommand: "openclaw doctor --fix",
        }),
      ).toEqual([]);
    },
  );

  it("leaves malformed auth profile metadata to config validation", () => {
    const cfg = {
      auth: {
        profiles: { broken: null },
        order: { anthropic: ["anthropic:missing"] },
      },
    } as unknown as OpenClawConfig;

    expect(repair(cfg, [tokenStore({ profileId: "claude-cli:setup-token" })])).toEqual({
      config: cfg,
      changes: [],
    });
    expect(
      collectStaleConfiguredAuthOrderWarnings({
        cfg,
        doctorFixCommand: "openclaw doctor --fix",
      }),
    ).toEqual([]);
  });

  it("preserves an order with surviving config metadata", () => {
    const cfg = {
      auth: {
        profiles: {
          "anthropic:pending": { provider: "anthropic", mode: "oauth" },
        },
        order: { anthropic: ["anthropic:removed", "anthropic:pending"] },
      },
    } satisfies OpenClawConfig;

    const result = repair(cfg, [tokenStore({ profileId: "claude-cli:setup-token" })]);

    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("preserves an order with a surviving persisted profile", () => {
    const cfg = {
      auth: {
        order: { anthropic: ["anthropic:removed", "anthropic:existing"] },
      },
    } satisfies OpenClawConfig;
    const store = tokenStore({
      profileId: "anthropic:existing",
      provider: "anthropic",
    });

    const result = repair(cfg, [store]);

    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("does not use a stored profile from another provider", () => {
    const cfg = {
      auth: { order: { anthropic: ["anthropic:removed"] } },
    } satisfies OpenClawConfig;
    const store = tokenStore({
      profileId: "openai:manual",
      provider: "openai",
    });

    const result = repair(cfg, [store]);

    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("does not remove an order when the only fallback credential is expired", () => {
    const cfg = {
      auth: { order: { anthropic: ["anthropic:removed"] } },
    } satisfies OpenClawConfig;
    const store = tokenStore({
      profileId: "claude-cli:expired",
      expires: Date.now() - 1,
    });

    const result = repair(cfg, [store]);

    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("preserves a stale config order when the agent's stored order has no usable fallback", () => {
    const cfg = {
      auth: { order: { anthropic: ["anthropic:removed"] } },
    } satisfies OpenClawConfig;
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:expired": {
          type: "token",
          provider: "anthropic",
          token: "expired",
          expires: Date.now() - 1,
        },
        "claude-cli:setup-token": {
          type: "token",
          provider: "claude-cli",
          token: "setup-token",
        },
      },
      order: { anthropic: ["anthropic:expired"] },
    };

    expect(repair(cfg, [store])).toEqual({ config: cfg, changes: [] });
  });

  it("removes stale aliases together and restores each agent's automatic selection", () => {
    const cfg = {
      auth: {
        order: {
          anthropic: ["anthropic:removed"],
          "claude-cli": ["claude-cli:removed"],
        },
      },
    } satisfies OpenClawConfig;
    const mainStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:oauth": {
          type: "oauth",
          provider: "anthropic",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    const childStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "claude-cli:token": {
          type: "token",
          provider: "claude-cli",
          token: "setup-token",
        },
      },
    };

    const result = repair(cfg, [mainStore, childStore]);

    expect(result.config.auth?.order).toEqual({});
    expect(
      resolveAuthProfileOrder({ cfg: result.config, store: mainStore, provider: "anthropic" }),
    ).toEqual(["anthropic:oauth"]);
    expect(
      resolveAuthProfileOrder({ cfg: result.config, store: childStore, provider: "claude-cli" }),
    ).toEqual(["claude-cli:token"]);
  });

  it("preserves a stale order unless every active agent has an automatic fallback", () => {
    const cfg = {
      auth: { order: { anthropic: ["anthropic:removed"] } },
    } satisfies OpenClawConfig;
    const healthyStore = tokenStore({ profileId: "claude-cli:setup-token" });
    const missingFallbackStore: AuthProfileStore = { version: 1, profiles: {} };

    const result = repairStaleConfiguredAuthOrders({
      cfg,
      stores: [healthyStore, missingFallbackStore],
      activeStores: [healthyStore, missingFallbackStore],
    });

    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("includes inherited main credentials when main is not a configured agent", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stale-auth-order-"));
    try {
      const mainAgentDir = path.join(stateDir, "agents", "main", "agent");
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:setup-token" }),
        mainAgentDir,
      );
      const cfg = {
        agents: { list: [{ id: "work", default: true }] },
        auth: { order: { anthropic: ["anthropic:removed"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not require the inherited main store itself to have a fallback", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stale-auth-order-"));
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:work-token" }),
        path.join(stateDir, "agents", "work", "agent"),
      );
      const cfg = {
        agents: { list: [{ id: "work", default: true }] },
        auth: { order: { anthropic: ["anthropic:removed"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "fails closed on an unreadable SQLite sidecar beside a present database",
    async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stale-auth-order-"));
      const agentDir = path.join(stateDir, "agents", "main", "agent");
      try {
        writePersistedAuthProfileStoreRaw(
          tokenStore({ profileId: "claude-cli:setup-token" }),
          agentDir,
        );
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        const [, walPath] = resolveAuthProfileDatabaseFilePaths(agentDir);
        if (!walPath) {
          throw new Error("expected SQLite WAL path");
        }
        await fs.rm(walPath, { force: true });
        await fs.symlink(path.join(stateDir, "missing-wal"), walPath);
        const cfg = {
          auth: { order: { anthropic: ["anthropic:removed"] } },
        } satisfies OpenClawConfig;

        const result = maybeRepairStaleConfiguredAuthOrders({
          cfg,
          env: { OPENCLAW_STATE_DIR: stateDir },
        });

        expect(result.config).toBe(cfg);
        expect(result.changes).toEqual([]);
        expect(result.warnings).toEqual([
          expect.stringContaining("SQLite auth profile store is unreadable"),
        ]);
      } finally {
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("preserves an ordered profile owned by a retained unconfigured agent", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-retained-auth-order-"));
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:setup-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "anthropic:retained", provider: "anthropic" }),
        path.join(stateDir, "agents", "retained", "agent"),
      );
      const cfg = {
        auth: { order: { anthropic: ["anthropic:retained"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result).toEqual({ config: cfg, changes: [] });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves an ordered profile in a registered custom agent directory", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-custom-auth-order-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:setup-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const database = openOpenClawAgentDatabase({
        agentId: "retained",
        env,
        path: resolveAuthProfileDatabasePath(customAgentDir),
      });
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "anthropic:retained", provider: "anthropic" }),
        customAgentDir,
        database,
      );
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const cfg = {
        auth: { order: { anthropic: ["anthropic:retained"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result).toEqual({ config: cfg, changes: [] });
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not use a registered inactive store as the automatic fallback proof", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-custom-fallback-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const database = openOpenClawAgentDatabase({
        agentId: "retained",
        env,
        path: resolveAuthProfileDatabasePath(customAgentDir),
      });
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:inactive-token" }),
        customAgentDir,
        database,
      );
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const cfg = {
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result).toEqual({ config: cfg, changes: [] });
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves an ordered runtime profile from a registered custom agent directory", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-custom-runtime-auth-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const database = openOpenClawAgentDatabase({
        agentId: "retained",
        env,
        path: resolveAuthProfileDatabasePath(customAgentDir),
      });
      writePersistedAuthProfileStateRaw(
        { version: 1, order: { anthropic: ["anthropic:runtime-only"] } },
        customAgentDir,
        database,
      );
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      externalAuthTesting.setResolveExternalAuthProfilesForTest((params) =>
        params.context.agentDir === customAgentDir &&
        params.context.store.order?.anthropic?.includes("anthropic:runtime-only")
          ? [
              {
                profileId: "anthropic:runtime-only",
                credential: {
                  type: "oauth",
                  provider: "anthropic",
                  access: "access",
                  refresh: "refresh",
                  expires: Date.now() + 60_000,
                },
                persistence: "runtime-only",
              },
            ]
          : [],
      );
      const cfg = {
        auth: { order: { anthropic: ["anthropic:runtime-only"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result).toEqual({ config: cfg, changes: [] });
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not repair while a registered custom agent has an unmigrated auth store", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-custom-legacy-auth-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
      openOpenClawAgentDatabase({ agentId: "retained", env, path: databasePath });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.writeFile(
        resolveAuthStorePath(customAgentDir),
        JSON.stringify(tokenStore({ profileId: "anthropic:legacy", provider: "anthropic" })),
      );
      const cfg = {
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result).toEqual({ config: cfg, changes: [] });
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not use an inactive retained agent as the automatic fallback proof", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inactive-auth-order-"));
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:inactive-token" }),
        path.join(stateDir, "agents", "retained", "agent"),
      );
      const cfg = {
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result).toEqual({ config: cfg, changes: [] });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "fails closed on a dangling retained-agent symlink",
    async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dangling-auth-order-"));
      try {
        writePersistedAuthProfileStoreRaw(
          tokenStore({ profileId: "claude-cli:main-token" }),
          path.join(stateDir, "agents", "main", "agent"),
        );
        const retainedRoot = path.join(stateDir, "agents", "retained");
        await fs.mkdir(retainedRoot, { recursive: true });
        await fs.symlink(
          path.join(stateDir, "missing-agent"),
          path.join(retainedRoot, "agent"),
          "dir",
        );
        const cfg = {
          auth: { order: { anthropic: ["anthropic:missing"] } },
        } satisfies OpenClawConfig;

        const result = maybeRepairStaleConfiguredAuthOrders({
          cfg,
          env: { OPENCLAW_STATE_DIR: stateDir },
        });

        expect(result.config).toBe(cfg);
        expect(result.changes).toEqual([]);
        expect(result.warnings?.join("\n")).toContain("unavailable");
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const)(
    "preserves profiles in the %s-selected auth store",
    async (envKey) => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-env-auth-order-"));
      try {
        const selectedAgentDir = path.join(stateDir, "selected-agent");
        writePersistedAuthProfileStoreRaw(
          tokenStore({ profileId: "claude-cli:selected-token" }),
          selectedAgentDir,
        );
        writePersistedAuthProfileStoreRaw(
          tokenStore({ profileId: "claude-cli:main-token" }),
          path.join(stateDir, "agents", "main", "agent"),
        );
        const cfg = {
          auth: { order: { anthropic: ["claude-cli:selected-token"] } },
        } satisfies OpenClawConfig;

        const result = maybeRepairStaleConfiguredAuthOrders({
          cfg,
          env: {
            OPENCLAW_STATE_DIR: stateDir,
            [envKey]: selectedAgentDir,
          },
        });

        expect(result).toEqual({ config: cfg, changes: [] });
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("preserves an order that selects a runtime-only external profile", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-auth-order-"));
    try {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      const cfg = {
        agents: { list: [{ id: "work", default: true }] },
        auth: { order: { openai: ["openai:runtime-only"] } },
      } satisfies OpenClawConfig;
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            "openai:main-seed": {
              type: "api_key",
              provider: "openai",
              key: "api-key",
            },
          },
        },
        path.join(stateDir, "agents", "main", "agent"),
      );
      externalAuthTesting.setResolveExternalAuthProfilesForTest((params) =>
        params.context.agentDir === workAgentDir &&
        params.context.store.profiles["openai:main-seed"]
          ? [
              {
                profileId: "openai:runtime-only",
                credential: {
                  type: "oauth",
                  provider: "openai",
                  access: "access",
                  refresh: "refresh",
                  expires: Date.now() + 60_000,
                },
                persistence: "runtime-only",
              },
            ]
          : [],
      );

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result).toEqual({ config: cfg, changes: [] });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("warns and does not repair when an active auth database is unreadable", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-unreadable-auth-order-"));
    try {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      await fs.mkdir(workAgentDir, { recursive: true });
      await fs.writeFile(resolveAuthProfileDatabasePath(workAgentDir), "not-a-sqlite-database");
      const cfg = {
        agents: { list: [{ id: "work", default: true }] },
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
      expect(
        collectStaleConfiguredAuthOrderWarnings({
          cfg,
          doctorFixCommand: "openclaw doctor --fix",
          env: { OPENCLAW_STATE_DIR: stateDir },
        }).join("\n"),
      ).toContain("SQLite auth profile store is unreadable");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "fails closed on a dangling active auth database symlink",
    async () => {
      const stateDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-active-dangling-auth-order-"),
      );
      try {
        writePersistedAuthProfileStoreRaw(
          tokenStore({ profileId: "claude-cli:main-token" }),
          path.join(stateDir, "agents", "main", "agent"),
        );
        const workAgentDir = path.join(stateDir, "agents", "work", "agent");
        await fs.mkdir(workAgentDir, { recursive: true });
        await fs.symlink(
          path.join(workAgentDir, "missing.sqlite"),
          resolveAuthProfileDatabasePath(workAgentDir),
        );
        const cfg = {
          agents: { list: [{ id: "work", default: true }] },
          auth: { order: { anthropic: ["anthropic:missing"] } },
        } satisfies OpenClawConfig;

        const result = maybeRepairStaleConfiguredAuthOrders({
          cfg,
          env: { OPENCLAW_STATE_DIR: stateDir },
        });

        expect(result.config).toBe(cfg);
        expect(result.changes).toEqual([]);
        expect(result.warnings?.join("\n")).toContain("unavailable");
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed on a dangling legacy auth source beside a legacy database",
    async () => {
      const stateDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-dangling-legacy-auth-order-"),
      );
      try {
        writePersistedAuthProfileStoreRaw(
          tokenStore({ profileId: "claude-cli:main-token" }),
          path.join(stateDir, "agents", "main", "agent"),
        );
        const workAgentDir = path.join(stateDir, "agents", "work", "agent");
        await fs.mkdir(workAgentDir, { recursive: true });
        const legacyDatabase = new DatabaseSync(resolveAuthProfileDatabasePath(workAgentDir));
        legacyDatabase.exec("CREATE TABLE legacy_state (id INTEGER PRIMARY KEY);");
        legacyDatabase.close();
        await fs.symlink(
          path.join(workAgentDir, "missing-auth-profiles.json"),
          resolveAuthStorePath(workAgentDir),
        );
        const cfg = {
          agents: { list: [{ id: "work", default: true }] },
          auth: { order: { anthropic: ["anthropic:missing"] } },
        } satisfies OpenClawConfig;

        const result = maybeRepairStaleConfiguredAuthOrders({
          cfg,
          env: { OPENCLAW_STATE_DIR: stateDir },
        });

        expect(result.config).toBe(cfg);
        expect(result.changes).toEqual([]);
        expect(result.warnings?.join("\n")).toContain("unavailable");
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("fails closed when a retained unconfigured auth database is unreadable", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-retained-invalid-auth-"));
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const retainedAgentDir = path.join(stateDir, "agents", "retained", "agent");
      await fs.mkdir(retainedAgentDir, { recursive: true });
      await fs.writeFile(resolveAuthProfileDatabasePath(retainedAgentDir), "not-sqlite");
      const cfg = {
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a registered custom auth database is unreadable", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-custom-invalid-auth-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
      openOpenClawAgentDatabase({ agentId: "retained", env, path: databasePath });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.writeFile(databasePath, "not-sqlite");
      const cfg = {
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when registered auth runtime state is unreadable without a secrets row", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-custom-state-auth-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
      const database = openOpenClawAgentDatabase({
        agentId: "retained",
        env,
        path: databasePath,
      });
      writePersistedAuthProfileStateRaw(
        { version: 1, order: { anthropic: ["anthropic:retained"] } },
        customAgentDir,
        database,
      );
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const rawDatabase = new DatabaseSync(databasePath);
      rawDatabase
        .prepare("UPDATE auth_profile_state SET state_json = ? WHERE state_key = ?")
        .run("{", "primary");
      rawDatabase.close();
      const cfg = {
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("unreadable");
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a registered auth database owner no longer matches", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-custom-owner-auth-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
      openOpenClawAgentDatabase({ agentId: "retained", env, path: databasePath });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const rawDatabase = new DatabaseSync(databasePath);
      rawDatabase
        .prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = ?")
        .run("replacement", "primary");
      rawDatabase.close();
      const cfg = {
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("uses the live owner after a registered database pathname is recreated", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reowned-auth-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
      openOpenClawAgentDatabase({ agentId: "retired", env, path: databasePath });
      closeOpenClawAgentDatabasesForTest();
      for (const pathname of resolveAuthProfileDatabaseFilePaths(customAgentDir)) {
        await fs.rm(pathname, { force: true });
      }
      openOpenClawAgentDatabase({ agentId: "replacement", env, path: databasePath });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const cfg = {
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toBeUndefined();
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when an active agent points at another agent's database", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-active-owner-auth-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const customAgentDir = path.join(stateDir, "custom-agents", "shared");
      const database = openOpenClawAgentDatabase({
        agentId: "other",
        env,
        path: resolveAuthProfileDatabasePath(customAgentDir),
      });
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "anthropic:other", provider: "anthropic" }),
        customAgentDir,
        database,
      );
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const cfg = {
        agents: { list: [{ id: "work", default: true, agentDir: customAgentDir }] },
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when an ownerless active database contains auth tables", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ownerless-auth-"));
    try {
      const agentDir = path.join(stateDir, "agents", "main", "agent");
      const databasePath = resolveAuthProfileDatabasePath(agentDir);
      await fs.mkdir(agentDir, { recursive: true });
      const rawDatabase = new DatabaseSync(databasePath);
      rawDatabase.exec(`
        CREATE TABLE auth_profile_store (
          store_key TEXT PRIMARY KEY NOT NULL,
          store_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE auth_profile_state (
          state_key TEXT PRIMARY KEY NOT NULL,
          state_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      rawDatabase
        .prepare(
          "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
        )
        .run(
          "primary",
          JSON.stringify(tokenStore({ profileId: "claude-cli:setup-token" })),
          Date.now(),
        );
      rawDatabase.close();
      const cfg = {
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("prefers a configured owner over the retained directory basename", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-renamed-owner-auth-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const renamedAgentDir = path.join(stateDir, "agents", "old", "agent");
      openOpenClawAgentDatabase({
        agentId: "work",
        env,
        path: resolveAuthProfileDatabasePath(renamedAgentDir),
      });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const cfg = {
        agents: { list: [{ id: "work", default: true, agentDir: renamedAgentDir }] },
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toBeUndefined();
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("uses durable ownership for a deconfigured relocated agent directory", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relocated-owner-auth-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const relocatedAgentDir = path.join(stateDir, "agents", "old", "agent");
      openOpenClawAgentDatabase({
        agentId: "work",
        env,
        path: resolveAuthProfileDatabasePath(relocatedAgentDir),
      });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const cfg = {
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toBeUndefined();
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when an environment-selected directory belongs to another agent", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-env-owner-auth-"));
    const envAgentDir = path.join(stateDir, "custom-env-agent");
    const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: envAgentDir };
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const database = openOpenClawAgentDatabase({
        agentId: "other",
        env,
        path: resolveAuthProfileDatabasePath(envAgentDir),
      });
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "anthropic:other", provider: "anthropic" }),
        envAgentDir,
        database,
      );
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const cfg = {
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when an active auth database has only one auth table", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-partial-schema-auth-"));
    try {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "anthropic:work", provider: "anthropic" }),
        workAgentDir,
      );
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const rawDatabase = new DatabaseSync(resolveAuthProfileDatabasePath(workAgentDir));
      rawDatabase.exec("DROP TABLE auth_profile_state;");
      rawDatabase.close();
      const cfg = {
        agents: { list: [{ id: "work", default: true }] },
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a stale registered database leaves a SQLite sidecar", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-custom-sidecar-auth-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
      openOpenClawAgentDatabase({ agentId: "retained", env, path: databasePath });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(databasePath);
      const [, walPath] = resolveAuthProfileDatabaseFilePaths(customAgentDir);
      if (!walPath) {
        throw new Error("expected SQLite WAL path");
      }
      await fs.writeFile(walPath, "orphaned-wal");
      const cfg = {
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("unavailable");
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("ignores a stale registered auth database after its pathname is removed", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-custom-missing-auth-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    try {
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
      openOpenClawAgentDatabase({ agentId: "retained", env, path: databasePath });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(databasePath);
      const cfg = {
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toBeUndefined();
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "fails closed on a dangling registered auth database symlink",
    async () => {
      const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-custom-dangling-auth-"));
      const env = { OPENCLAW_STATE_DIR: stateDir };
      try {
        writePersistedAuthProfileStoreRaw(
          tokenStore({ profileId: "claude-cli:main-token" }),
          path.join(stateDir, "agents", "main", "agent"),
        );
        const customAgentDir = path.join(stateDir, "custom-agents", "retained");
        const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
        openOpenClawAgentDatabase({ agentId: "retained", env, path: databasePath });
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(databasePath);
        await fs.symlink(path.join(customAgentDir, "missing.sqlite"), databasePath);
        const cfg = {
          auth: { order: { anthropic: ["anthropic:missing"] } },
        } satisfies OpenClawConfig;

        const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

        expect(result.config).toBe(cfg);
        expect(result.changes).toEqual([]);
        expect(result.warnings?.join("\n")).toContain("unavailable");
      } finally {
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed on a dangling registered auth database parent symlink",
    async () => {
      const stateDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-custom-dangling-parent-auth-"),
      );
      const env = { OPENCLAW_STATE_DIR: stateDir };
      try {
        writePersistedAuthProfileStoreRaw(
          tokenStore({ profileId: "claude-cli:main-token" }),
          path.join(stateDir, "agents", "main", "agent"),
        );
        const customAgentDir = path.join(stateDir, "custom-agents", "retained");
        const originalAgentDir = path.join(stateDir, "custom-agent-target");
        await fs.mkdir(originalAgentDir, { recursive: true });
        await fs.mkdir(path.dirname(customAgentDir), { recursive: true });
        await fs.symlink(originalAgentDir, customAgentDir, "dir");
        openOpenClawAgentDatabase({
          agentId: "retained",
          env,
          path: resolveAuthProfileDatabasePath(customAgentDir),
        });
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(customAgentDir);
        await fs.symlink(path.join(stateDir, "missing-agent-target"), customAgentDir, "dir");
        const cfg = {
          auth: { order: { anthropic: ["anthropic:missing"] } },
        } satisfies OpenClawConfig;

        const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

        expect(result.config).toBe(cfg);
        expect(result.changes).toEqual([]);
        expect(result.warnings?.join("\n")).toContain("unavailable");
      } finally {
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("warns and preserves an ordered profile dropped by store coercion", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-invalid-auth-order-"));
    try {
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            "anthropic:old": { type: "invalid", provider: "anthropic" },
            "claude-cli:setup-token": {
              type: "token",
              provider: "claude-cli",
              token: "setup-token",
            },
          },
        },
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = {
        auth: { order: { anthropic: ["anthropic:old"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("contains invalid credentials");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("repairs when an active agent database has no auth-profile row", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-empty-auth-order-"));
    try {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      writePersistedAuthProfileStateRaw({ version: 1 }, workAgentDir);
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = {
        agents: { list: [{ id: "work", default: true }] },
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("repairs when an active legacy agent database predates auth tables", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-db-auth-order-"));
    try {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      const databasePath = resolveAuthProfileDatabasePath(workAgentDir);
      await fs.mkdir(workAgentDir, { recursive: true });
      const legacyDatabase = new DatabaseSync(databasePath);
      legacyDatabase.exec("CREATE TABLE legacy_state (id INTEGER PRIMARY KEY);");
      legacyDatabase.close();
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = {
        agents: { list: [{ id: "work", default: true }] },
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not repair while an invalid legacy auth source remains", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-auth-order-"));
    try {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      await fs.mkdir(workAgentDir, { recursive: true });
      await fs.writeFile(resolveLegacyAuthStorePath(workAgentDir), "not-json", "utf8");
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:main-token" }),
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = {
        agents: { list: [{ id: "work", default: true }] },
        auth: { order: { anthropic: ["anthropic:missing"] } },
      } satisfies OpenClawConfig;

      const result = maybeRepairStaleConfiguredAuthOrders({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result).toEqual({ config: cfg, changes: [] });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
