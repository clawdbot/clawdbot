import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetProviderAuthAliasMapCacheForTest } from "../provider-auth-aliases.js";
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

import { resolveAuthProfileOrder } from "./order.js";
import { markAuthProfileSuccess } from "./profiles.js";

describe("resolveAuthProfileOrder", () => {
  beforeEach(() => {
    resetProviderAuthAliasMapCacheForTest();
    loadPluginManifestRegistry.mockClear();
  });

  it("accepts aliased provider credentials from manifest metadata", async () => {
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

  it("lets Codex auth use friendly OpenAI auth order entries", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:personal": {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
        "openai:backup": {
          type: "api_key",
          provider: "openai-codex",
          key: "sk-backup",
        },
        "openai:platform": {
          type: "api_key",
          provider: "openai",
          key: "sk-platform",
        },
      },
    };

    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            openai: ["openai:personal", "openai:backup", "openai:platform"],
          },
        },
      },
      store,
      provider: "openai-codex",
    });

    expect(order).toEqual(["openai:personal", "openai:backup", "openai:platform"]);
  });

  it("lets Codex auth discover normal OpenAI API-key profiles as backups", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:personal": {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
        "openai:backup": {
          type: "api_key",
          provider: "openai",
          key: "sk-platform",
        },
        "openai:oauth": {
          type: "oauth",
          provider: "openai",
          access: "wrong-provider-access",
          refresh: "wrong-provider-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

    const order = resolveAuthProfileOrder({
      store,
      provider: "openai-codex",
    });

    expect(order).toEqual(["openai-codex:personal", "openai:backup"]);
  });

  it("preserves native Codex profiles before OpenAI alias API-key order", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-platform",
        },
        "openai-codex:personal": {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            openai: ["openai:default"],
          },
        },
      },
      store,
      provider: "openai-codex",
    });

    expect(order).toEqual(["openai-codex:personal", "openai:default"]);
  });

  it("keeps direct OpenAI Codex auth order ahead of the friendly OpenAI alias", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:personal": {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        },
        "openai-codex:legacy": {
          type: "oauth",
          provider: "openai-codex",
          access: "legacy-access",
          refresh: "legacy-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            openai: ["openai:personal"],
            "openai-codex": ["openai-codex:legacy"],
          },
        },
      },
      store,
      provider: "openai-codex",
    });

    expect(order).toEqual(["openai-codex:legacy"]);
  });

  it("keeps configured Codex auth order ahead of stored OpenAI fallback order", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:platform": {
          type: "api_key",
          provider: "openai",
          key: "sk-platform",
        },
        "openai-codex:work": {
          type: "oauth",
          provider: "openai-codex",
          access: "work-access",
          refresh: "work-refresh",
          expires: Date.now() + 60_000,
        },
      },
      order: {
        openai: ["openai:platform"],
      },
    };

    const order = resolveAuthProfileOrder({
      cfg: {
        auth: {
          order: {
            "openai-codex": ["openai-codex:work"],
          },
        },
      },
      store,
      provider: "openai-codex",
    });

    expect(order).toEqual(["openai-codex:work"]);
  });

  it("marks profile success with one canonical last-good and usage update", async () => {
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
            blockedUntil: Date.now() + 120_000,
            blockedReason: "subscription_limit",
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
      const usageStats = store.usageStats?.["fixture-provider:default"];
      expect(usageStats?.errorCount).toBe(0);
      expect(usageStats?.blockedUntil).toBeUndefined();
      expect(usageStats?.blockedReason).toBeUndefined();
      expect(usageStats?.cooldownUntil).toBeUndefined();
      expect(usageStats?.cooldownReason).toBeUndefined();
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
