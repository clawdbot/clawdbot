/**
 * Regression coverage for live model sweep filtering.
 * Verifies provider exclusions, explicit filters, and high-signal model caps.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { withEnv } from "../test-utils/env.js";
import {
  isHighSignalLiveModelRef,
  listPrioritizedHighSignalLiveModelRefs,
  resolveHighSignalLiveModelLimit,
  shouldExcludeProviderFromDefaultHighSignalLiveSweep,
} from "./test-helpers/live-model-dynamic-candidates.js";

describe("live model policy configuration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetPluginLoaderTestStateForTest();
    cleanupTrackedTempDirs(tempDirs);
  });

  it("selects a scoped plugin's modern models under Vitest", () => {
    const rootDir = makeTrackedTempDir("openclaw-live-model-policy", tempDirs);
    const fixture = createColdPluginFixture({ rootDir });
    fs.writeFileSync(
      fixture.runtimeSource,
      `module.exports = {
        id: ${JSON.stringify(fixture.pluginId)},
        register(api) {
          api.registerProvider({
            id: ${JSON.stringify(fixture.providerId)},
            label: "Live model fixture",
            auth: [],
            isModernModelRef: ({ modelId }) => modelId === "current-model",
          });
        },
      };`,
    );
    const env = createColdPluginHermeticEnv(rootDir, {
      bundledPluginsDir: makeTrackedTempDir("openclaw-live-model-empty-bundles", tempDirs),
    });
    const config = createColdPluginConfig(rootDir, fixture.pluginId);
    const ref = { provider: fixture.providerId, id: "current-model", env };

    withEnv(env, () => {
      expect(isHighSignalLiveModelRef(ref)).toBe(false);
      expect(isHighSignalLiveModelRef({ ...ref, config })).toBe(true);
      expect(isHighSignalLiveModelRef({ ...ref, config, id: "retired-model" })).toBe(false);
      expect(
        isHighSignalLiveModelRef({
          ...ref,
          config: { ...config, plugins: { ...config.plugins, enabled: false } },
        }),
      ).toBe(false);
    });
  });
});

function resolveProviderOwners(provider: string): readonly string[] | undefined {
  if (provider === "openai") {
    return ["openai"];
  }
  if (provider === "codex" || provider === "codex-cli") {
    return ["codex"];
  }
  return undefined;
}

describe("shouldExcludeProviderFromDefaultHighSignalLiveSweep", () => {
  it("excludes dedicated harness providers from the default high-signal sweep", () => {
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex",
        useExplicitModels: false,
        providerFilter: null,
        resolveProviderOwners,
      }),
    ).toBe(true);
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex-cli",
        useExplicitModels: false,
        providerFilter: null,
        resolveProviderOwners,
      }),
    ).toBe(true);
  });

  it("keeps dedicated harness providers when explicitly requested by provider filter", () => {
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex",
        useExplicitModels: false,
        providerFilter: new Set(["codex"]),
        resolveProviderOwners,
      }),
    ).toBe(false);
  });

  it("keeps dedicated harness providers when the caller uses explicit model selection", () => {
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "codex",
        useExplicitModels: true,
        providerFilter: null,
      }),
    ).toBe(false);
  });

  it("does not exclude ordinary or legacy OpenAI provider ids", () => {
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "openai",
        useExplicitModels: false,
        providerFilter: null,
        resolveProviderOwners,
      }),
    ).toBe(false);
    expect(
      shouldExcludeProviderFromDefaultHighSignalLiveSweep({
        provider: "openai",
        useExplicitModels: false,
        providerFilter: null,
        resolveProviderOwners,
      }),
    ).toBe(false);
  });
});

describe("resolveHighSignalLiveModelLimit", () => {
  it("accepts signed decimal max model limits", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        rawMaxModels: "+3",
        useExplicitModels: false,
        defaultLimit: 5,
      }),
    ).toBe(3);
  });

  it("does not coerce partial max model limits", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        rawMaxModels: "3models",
        useExplicitModels: false,
        defaultLimit: 5,
      }),
    ).toBe(0);
  });

  it("does not coerce non-decimal max model limits", () => {
    expect(
      resolveHighSignalLiveModelLimit({
        rawMaxModels: "0x3",
        useExplicitModels: false,
        defaultLimit: 5,
      }),
    ).toBe(0);
  });
});

describe("live model priorities", () => {
  it("includes the always-thinking Moonshot K3 route", () => {
    expect(listPrioritizedHighSignalLiveModelRefs()).toContainEqual({
      provider: "moonshot",
      id: "kimi-k3",
    });
  });
});
