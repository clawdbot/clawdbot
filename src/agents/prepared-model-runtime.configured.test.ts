import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import {
  collectPreparedModelRuntimeProviderIds,
  toStaticCatalogEntry,
} from "./prepared-model-runtime.configured.js";
import type { AuthStorageData } from "./sessions/auth-storage.js";

describe("collectPreparedModelRuntimeProviderIds", () => {
  beforeEach(() => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
    });
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
  });

  it("includes the canonical provider for a CLI alias credential", () => {
    const credentials: AuthStorageData = {
      "claude-cli": { type: "api_key", key: "test-key" },
    };

    expect(collectPreparedModelRuntimeProviderIds({}, credentials)).toContain("anthropic");
  });
});

describe("catalog row normalization", () => {
  it("keeps static and shared row conversion in parity for route metadata", () => {
    const model = {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      contextTokens: 128_000,
      compat: { supportsStore: true },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 8_192,
    } satisfies ProviderRuntimeModel;

    expect(toStaticCatalogEntry(model)).toEqual(modelCatalogRowToEntry(model));
    expect(toStaticCatalogEntry(model)).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_000_000,
      contextTokens: 128_000,
    });
  });
});
