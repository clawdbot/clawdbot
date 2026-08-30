import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNamespacedModelConfig } from "../test-utils/model-namespace-fixture.js";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  loadCatalog: vi.fn(),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  getPreparedModelCatalogSnapshot: (...args: unknown[]) => mocks.getSnapshot(...args),
  loadPreparedModelCatalog: (...args: unknown[]) => mocks.loadCatalog(...args),
}));

import {
  buildModelAliasIndex,
  loadModelCatalog,
  resolveAllowedModelRef,
  resolveModelRefFromString,
} from "./agent-runtime.js";

describe("agent-runtime model catalog compatibility", () => {
  beforeEach(() => {
    mocks.getSnapshot.mockReset();
    mocks.loadCatalog.mockReset();
  });

  it("keeps legacy cache-only reads nonblocking", async () => {
    mocks.getSnapshot.mockReturnValue({
      entries: [{ provider: "test", id: "cached", name: "Cached" }],
      routeVariants: [],
    });

    await expect(loadModelCatalog({ cacheOnly: true, useCache: true })).resolves.toEqual([
      { provider: "test", id: "cached", name: "Cached" },
    ]);
    expect(mocks.loadCatalog).not.toHaveBeenCalled();
  });

  it("accepts legacy options without overriding lifecycle metadata", async () => {
    mocks.loadCatalog.mockResolvedValue([]);
    const config = {};
    const env = { OPENCLAW_STATE_DIR: "/tmp/plugin-state" };

    await loadModelCatalog({
      agentDir: "/tmp/plugin-agent",
      config,
      env,
      metadataSnapshot: {} as never,
      readOnly: true,
      useCache: false,
      workspaceDir: "/tmp/plugin-workspace",
    });

    expect(mocks.loadCatalog).toHaveBeenCalledWith({
      agentDir: "/tmp/plugin-agent",
      config,
      env,
      readOnly: true,
      workspaceDir: "/tmp/plugin-workspace",
    });
  });

  it.each([false, true])(
    "preserves legacy alias-index keys without changing alias resolution (disabled=%s)",
    (disableNested) => {
      const cfg = createNamespacedModelConfig();
      cfg.agents = {
        ...cfg.agents,
        entries: {
          worker: { models: disableNested ? { "custom/custom/model": { alias: "" } } : {} },
        },
      };
      const params = {
        cfg,
        agentId: "worker",
        defaultProvider: "custom",
        manifestPlugins: [],
        allowPluginNormalization: false,
      };
      const aliasIndex = buildModelAliasIndex(params);

      expect([...aliasIndex.byKey]).toEqual([
        ["custom/model", disableNested ? ["plain"] : ["plain", "nested"]],
      ]);
      expect([...(aliasIndex.disabledKeys ?? [])]).toEqual(disableNested ? ["custom/model"] : []);
      expect(resolveModelRefFromString({ ...params, aliasIndex, raw: "plain" })?.ref).toEqual({
        provider: "custom",
        model: "model",
      });
      if (!disableNested) {
        expect(resolveModelRefFromString({ ...params, aliasIndex, raw: "nested" })?.ref).toEqual({
          provider: "custom",
          model: "custom/model",
        });
      }
    },
  );

  it("projects allowed-ref keys only after exact model authorization", () => {
    const cfg = createNamespacedModelConfig();
    cfg.agents = {
      ...cfg.agents,
      defaults: { ...cfg.agents?.defaults, modelPolicy: { allow: ["custom/custom/model"] } },
    };
    const params = { cfg, catalog: [], defaultProvider: "custom", manifestPlugins: [] };

    expect(resolveAllowedModelRef({ ...params, raw: "nested" })).toEqual({
      ref: { provider: "custom", model: "custom/model" },
      key: "custom/model",
    });
    expect(resolveAllowedModelRef({ ...params, raw: "plain" })).toEqual({
      error: "model not allowed: custom/model",
    });
  });

  it("preserves the shipped OpenRouter auto key", () => {
    const params = {
      cfg: {
        agents: { defaults: { models: { "openrouter/auto": { alias: "auto" } } } },
      },
      defaultProvider: "openrouter",
      allowPluginNormalization: false,
      manifestPlugins: [
        { modelIdNormalization: { providers: { openrouter: { prefixWhenBare: "openrouter" } } } },
      ],
    };

    expect([...buildModelAliasIndex(params).byKey]).toEqual([["openrouter/auto", ["auto"]]]);
    expect(
      resolveAllowedModelRef({
        ...params,
        catalog: [{ provider: "openrouter", id: "openrouter/auto", name: "Auto" }],
        raw: "auto",
      }),
    ).toEqual({
      ref: { provider: "openrouter", model: "openrouter/auto" },
      key: "openrouter/auto",
    });
  });
});
