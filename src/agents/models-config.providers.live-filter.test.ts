import { describe, expect, it } from "vitest";
import type { PluginMetadataSnapshotOwnerMaps } from "../plugins/plugin-metadata-snapshot.js";
import {
  resolvePluginMetadataProviderOwnersForTest,
  resolveProviderDiscoveryFilterForTest,
} from "./models-config.providers.implicit.js";

function liveFilterEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    VITEST: "1",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function resolveOwners(provider: string): readonly string[] | undefined {
  return provider === "claude-cli" ? ["anthropic"] : undefined;
}

function metadataOwners(
  overrides: Partial<PluginMetadataSnapshotOwnerMaps>,
): PluginMetadataSnapshotOwnerMaps {
  return {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
    ...overrides,
  };
}

describe("resolveProviderDiscoveryFilterForTest", () => {
  it("maps live provider backend ids to owning plugin ids", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "claude-cli",
        }),
        resolveOwners,
      }),
    ).toEqual(["anthropic"]);
  });

  it("honors gateway live provider filters too", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_GATEWAY_PROVIDERS: "claude-cli",
        }),
        resolveOwners,
      }),
    ).toEqual(["anthropic"]);
  });

  it("keeps explicit plugin-id filters when no owning provider plugin exists", () => {
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "openrouter",
        }),
        resolveOwners,
      }),
    ).toEqual(["openrouter"]);
  });

  it("maps live provider backend ids through plugin metadata cli backend owners", () => {
    const snapshot = {
      owners: metadataOwners({
        cliBackends: new Map([["claude-cli", ["anthropic"]]]),
      }),
    };

    const resolveMetadataOwners = (provider: string) =>
      resolvePluginMetadataProviderOwnersForTest(snapshot, provider);

    expect(resolveMetadataOwners("claude-cli")).toEqual(["anthropic"]);
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "claude-cli",
        }),
        resolveOwners: resolveMetadataOwners,
      }),
    ).toEqual(["anthropic"]);
  });

  it("normalizes mixed-case backend ids through plugin metadata owners", () => {
    const snapshot = {
      owners: metadataOwners({
        cliBackends: new Map([["claude-cli", ["anthropic"]]]),
      }),
    };

    expect(resolvePluginMetadataProviderOwnersForTest(snapshot, "Claude-CLI")).toEqual([
      "anthropic",
    ]);
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "Claude-CLI",
        }),
        resolveOwners: (provider) => resolvePluginMetadataProviderOwnersForTest(snapshot, provider),
      }),
    ).toEqual(["anthropic"]);
  });

  it("normalizes provider aliases through plugin metadata owners", () => {
    const snapshot = {
      owners: metadataOwners({
        providers: new Map([["volcengine", ["volcengine"]]]),
      }),
    };

    expect(resolvePluginMetadataProviderOwnersForTest(snapshot, "bytedance")).toEqual([
      "volcengine",
    ]);
    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({
          OPENCLAW_LIVE_TEST: "1",
          OPENCLAW_LIVE_PROVIDERS: "bytedance",
        }),
        resolveOwners: (provider) => resolvePluginMetadataProviderOwnersForTest(snapshot, provider),
      }),
    ).toEqual(["volcengine"]);
  });

  it("scopes normal startup discovery to requested provider owners", () => {
    const snapshot = {
      owners: metadataOwners({
        providers: new Map([
          ["openai", ["openai"]],
          ["anthropic", ["anthropic"]],
        ]),
      }),
    };

    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({}),
        providerIds: ["openai"],
        resolveOwners: (provider) => resolvePluginMetadataProviderOwnersForTest(snapshot, provider),
      }),
    ).toEqual(["openai"]);
  });

  it("maps scoped startup provider aliases through model catalog owners", () => {
    const snapshot = {
      owners: metadataOwners({
        modelCatalogProviders: new Map([["openai-codex", ["codex"]]]),
      }),
    };

    expect(
      resolveProviderDiscoveryFilterForTest({
        env: liveFilterEnv({}),
        providerIds: ["OpenAI-Codex"],
        resolveOwners: (provider) => resolvePluginMetadataProviderOwnersForTest(snapshot, provider),
      }),
    ).toEqual(["codex"]);
  });
});
