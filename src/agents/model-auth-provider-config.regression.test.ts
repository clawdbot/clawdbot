import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ModelProviderConfig, OpenClawConfig } from "../config/types.js";
import {
  getCustomProviderApiKey,
  resolveProviderConfigSecretInput,
} from "./model-auth-provider-config.js";

function createProviderConfig() {
  const provider: ModelProviderConfig = {
    baseUrl: "https://provider.example/v1",
    apiKey: "synthetic-resolved-value",
    models: [],
  };
  const config: OpenClawConfig = { models: { providers: { synthetic: provider } } };
  return { config, provider };
}

function publishProvider(config: OpenClawConfig) {
  const source = structuredClone(config);
  source.models!.providers!.synthetic.apiKey = {
    source: "store",
    provider: "default",
    id: "SYNTHETIC_PROVIDER_KEY",
  };
  setRuntimeConfigSnapshot(config, source);
}

afterEach(clearRuntimeConfigSnapshot);

describe("provider auth snapshot comparison", () => {
  it("does not traverse a shared runtime model catalog during repeated auth lookups", () => {
    const { config, provider } = createProviderConfig();
    let catalogReads = 0;
    provider.models = Array.from({ length: 400 }, (_, index) => ({
      id: `synthetic-${index}`,
      get name() {
        catalogReads += 1;
        return `Synthetic ${index}`;
      },
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 4096,
    }));
    publishProvider(config);
    catalogReads = 0;
    const started = performance.now();
    for (let agent = 0; agent < 11; agent += 1) {
      for (let model = 0; model < 400; model += 1) {
        expect(getCustomProviderApiKey(config, "synthetic")).toBe("secretref-managed");
      }
    }
    console.info(
      JSON.stringify({
        providerAuthCalls: 4400,
        catalogRows: 400,
        catalogReads,
        elapsedMs: performance.now() - started,
        rssBytes: process.memoryUsage().rss,
      }),
    );
    expect(catalogReads).toBe(0);
  });

  it("stops using runtime SecretRef provenance after a warmed input is mutated", () => {
    const { config } = createProviderConfig();
    publishProvider(config);
    const input = structuredClone(config);
    expect(resolveProviderConfigSecretInput(input, "synthetic").ref).toMatchObject({
      source: "store",
    });
    input.models!.providers!.synthetic.baseUrl = "https://another.example/v1";
    expect(resolveProviderConfigSecretInput(input, "synthetic").ref).toBeNull();
    expect(getCustomProviderApiKey(input, "synthetic")).toBe("synthetic-resolved-value");
  });
});
