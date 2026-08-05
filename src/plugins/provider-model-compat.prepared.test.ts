import { describe, expect, it, vi } from "vitest";
import { attachModelProviderMetadataOwners } from "../agents/provider-request-config.js";
import type { Model } from "../llm/types.js";
import type { PluginMetadataSnapshotOwnerMaps } from "./plugin-metadata-snapshot.types.js";

const resolveProviderRequestCapabilities = vi.hoisted(() =>
  vi.fn(() => ({
    supportsDeveloperRole: false,
    supportsUsageInStreaming: false,
    supportsStrictMode: false,
  })),
);

vi.mock("../agents/provider-attribution.js", () => ({
  resolveProviderRequestCapabilities,
}));

vi.mock("@openclaw/ai/transports", () => ({
  resolveOpenAICompletionsCompat: (
    model: Model,
    resolveCapabilities: (input: Model) => {
      supportsDeveloperRole: boolean;
      supportsUsageInStreaming: boolean;
      supportsStrictMode: boolean;
    },
  ) => resolveCapabilities(model),
}));

import { normalizeModelCompat } from "./provider-model-compat.js";

function makeOwners(provider: string): PluginMetadataSnapshotOwnerMaps {
  return {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map([[provider, [provider]]]),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
  };
}

const model = {
  id: "model",
  name: "Model",
  provider: "custom",
  api: "openai-completions",
  baseUrl: "https://models.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as Model;

describe("normalizeModelCompat prepared metadata", () => {
  it("uses the exact owner generation supplied by its registry", () => {
    const firstOwners = makeOwners("first");
    const secondOwners = makeOwners("second");

    normalizeModelCompat(attachModelProviderMetadataOwners(model, firstOwners));
    normalizeModelCompat(attachModelProviderMetadataOwners(model, secondOwners));

    expect(resolveProviderRequestCapabilities).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ providerMetadataOwners: firstOwners }),
    );
    expect(resolveProviderRequestCapabilities).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ providerMetadataOwners: secondOwners }),
    );
  });
});
