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
  const [{ resolveAuthProfileOrder }, { markAuthProfileGood }] = await Promise.all([
    import("./order.js"),
    import("./profiles.js"),
  ]);
  return { markAuthProfileGood, resolveAuthProfileOrder };
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

    expect(order).toEqual([]);
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

    expect(order).toEqual([]);
  });

  it("marks aliased provider profiles good under the canonical auth provider", async () => {
    const { markAuthProfileGood } = await importAuthProfileModulesWithAliasRegistry();
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-auth-profile-alias-"));
    try {
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
      saveAuthProfileStore(store, agentDir);

      await markAuthProfileGood({
        store,
        provider: "fixture-provider-plan",
        profileId: "fixture-provider:default",
        agentDir,
      });

      expect(store.lastGood).toEqual({
        "fixture-provider": "fixture-provider:default",
      });
    } finally {
      await rm(agentDir, { force: true, recursive: true });
    }
  });
});
