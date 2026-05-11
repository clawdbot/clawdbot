import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAuthProfileStore } from "./store.js";
import type { AuthProfileStore } from "./types.js";

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(() => ({
    plugins: [
      {
        id: "fixture-provider",
        providerAuthAliases: { "fixture-provider-plan": "fixture-provider" },
      },
    ],
    diagnostics: [],
  })),
);

vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

vi.mock("./external-auth.js", () => ({
  overlayExternalAuthProfiles: <T>(store: T) => store,
  shouldPersistExternalAuthProfile: () => true,
}));

async function importAuthProfileModulesWithAliasRegistry() {
  vi.resetModules();
  vi.doMock("../../plugins/manifest-registry.js", () => ({
    loadPluginManifestRegistry,
  }));
  const [{ resolveAuthProfileOrder }, { markAuthProfileSuccess }] = await Promise.all([
    import("./order.js"),
    import("./profiles.js"),
  ]);
  return { markAuthProfileSuccess, resolveAuthProfileOrder };
}

describe("resolveAuthProfileOrder", () => {
  beforeEach(() => {
    loadPluginManifestRegistry.mockClear();
  });

  afterEach(() => {
    vi.doUnmock("../../plugins/manifest-registry.js");
    vi.resetModules();
  });

  it("accepts aliased provider credentials from manifest metadata", async () => {
    const { resolveAuthProfileOrder } = await importAuthProfileModulesWithAliasRegistry();
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "fixture-provider:default": {
          type: "api_key",
          provider: "fixture-provider",
          key: "sk-test",
        },
      },
    };

    const order = resolveAuthProfileOrder({
      store,
      provider: "fixture-provider-plan",
    });

    expect(order).toEqual(["fixture-provider:default"]);
  });

  it("uses canonical provider auth order for alias providers", async () => {
    const { resolveAuthProfileOrder } = await importAuthProfileModulesWithAliasRegistry();
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "fixture-provider:primary": {
          type: "api_key",
          provider: "fixture-provider",
          key: "sk-primary",
        },
        "fixture-provider:secondary": {
          type: "api_key",
          provider: "fixture-provider",
          key: "sk-secondary",
        },
      },
      order: {
        "fixture-provider": ["fixture-provider:secondary", "fixture-provider:primary"],
      },
    };

    const order = resolveAuthProfileOrder({
      store,
      provider: "fixture-provider-plan",
    });

    expect(order).toEqual(["fixture-provider:secondary", "fixture-provider:primary"]);
  });

  it("falls back to legacy stored auth order when alias order is empty", async () => {
    const { resolveAuthProfileOrder } = await importAuthProfileModulesWithAliasRegistry();
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "fixture-provider:primary": {
          type: "api_key",
          provider: "fixture-provider",
          key: "sk-primary",
        },
        "fixture-provider:secondary": {
          type: "api_key",
          provider: "fixture-provider",
          key: "sk-secondary",
        },
      },
      order: {
        "fixture-provider-plan": [],
        "fixture-provider": ["fixture-provider:secondary", "fixture-provider:primary"],
      },
    };

    const order = resolveAuthProfileOrder({
      store,
      provider: "fixture-provider-plan",
    });

    expect(order).toEqual(["fixture-provider:secondary", "fixture-provider:primary"]);
  });

  it("falls back to legacy configured auth order when alias order is empty", async () => {
    const { resolveAuthProfileOrder } = await importAuthProfileModulesWithAliasRegistry();
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "fixture-provider:primary": {
          type: "api_key",
          provider: "fixture-provider",
          key: "sk-primary",
        },
        "fixture-provider:secondary": {
          type: "api_key",
          provider: "fixture-provider",
          key: "sk-secondary",
        },
      },
    };

    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            "fixture-provider-plan": [],
            "fixture-provider": ["fixture-provider:secondary", "fixture-provider:primary"],
          },
        },
      },
      store,
      provider: "fixture-provider-plan",
    });

    expect(order).toEqual(["fixture-provider:secondary", "fixture-provider:primary"]);
  });

  it("keeps explicit empty configured auth order as a provider disable", async () => {
    const { resolveAuthProfileOrder } = await importAuthProfileModulesWithAliasRegistry();
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "fixture-provider:primary": {
          type: "api_key",
          provider: "fixture-provider",
          key: "sk-primary",
        },
      },
    };

    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            "fixture-provider": [],
          },
        },
      },
      store,
      provider: "fixture-provider",
    });

    expect(order).toStrictEqual([]);
  });

  it("keeps explicit empty stored auth order as a provider disable", async () => {
    const { resolveAuthProfileOrder } = await importAuthProfileModulesWithAliasRegistry();
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "fixture-provider:primary": {
          type: "api_key",
          provider: "fixture-provider",
          key: "sk-primary",
        },
      },
      order: {
        "fixture-provider": [],
      },
    };

    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            "fixture-provider": ["fixture-provider:primary"],
          },
        },
      },
      store,
      provider: "fixture-provider",
    });

    expect(order).toStrictEqual([]);
  });

  it("marks profile success with one canonical last-good and usage update", async () => {
    const { markAuthProfileSuccess } = await importAuthProfileModulesWithAliasRegistry();
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-auth-profile-success-"));
    try {
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "fixture-provider:default": {
            type: "oauth",
            provider: "fixture-provider",
            access: "token",
            refresh: "refresh",
            expires: Date.now() + 60_000,
          },
        },
        usageStats: {
          "fixture-provider:default": {
            errorCount: 3,
            cooldownUntil: Date.now() + 60_000,
            cooldownReason: "rate_limit",
          },
        },
      };
      saveAuthProfileStore(store, agentDir);

      const beforeSuccess = Date.now();
      await markAuthProfileSuccess({
        store,
        provider: "fixture-provider-plan",
        profileId: "fixture-provider:default",
        agentDir,
      });
      const afterSuccess = Date.now();

      expect(store.lastGood).toEqual({
        "fixture-provider": "fixture-provider:default",
      });
      expect(store.usageStats?.["fixture-provider:default"]).toMatchObject({
        errorCount: 0,
        cooldownUntil: undefined,
        cooldownReason: undefined,
      });
      const lastUsed = store.usageStats?.["fixture-provider:default"]?.lastUsed;
      expect(typeof lastUsed).toBe("number");
      expect(Number.isFinite(lastUsed)).toBe(true);
      expect(lastUsed).toBeGreaterThanOrEqual(beforeSuccess);
      expect(lastUsed).toBeLessThanOrEqual(afterSuccess);
    } finally {
      await rm(agentDir, { force: true, recursive: true });
    }
  });
});
