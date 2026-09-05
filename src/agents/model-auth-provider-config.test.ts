import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  providerConfigMatchesRuntimeSnapshot,
  resolveProviderConfigSecretInput,
} from "./model-auth-provider-config.js";

afterEach(clearRuntimeConfigSnapshot);

describe("provider runtime config matching", () => {
  it("reads published credential provenance without traversing the model inventory", () => {
    let modelReads = 0;
    const cfg = {
      models: {
        providers: {
          acme: {
            apiKey: "resolved-fixture-key",
            baseUrl: "https://acme.example/v1",
            models: Array.from({ length: 16 }, (_, index) => ({
              id: `model-${index}`,
              get name() {
                modelReads += 1;
                return `Model ${index}`;
              },
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 4096,
            })),
          },
        },
      },
    } satisfies OpenClawConfig;
    const ref = { source: "store", provider: "default", id: "CATALOG_KEY" } as const;
    const source = {
      models: { providers: { acme: { ...cfg.models.providers.acme, apiKey: ref } } },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(cfg, source);
    modelReads = 0;

    for (let index = 0; index < 16; index += 1) {
      expect(resolveProviderConfigSecretInput(cfg, "acme").ref).toEqual(ref);
    }
    expect(modelReads).toBe(0);
  });

  it("compares distinct provider snapshots and observes replacements", () => {
    const runtimeConfig = {
      models: {
        providers: { acme: { baseUrl: "https://acme.example/v1", models: [] } },
      },
    } satisfies OpenClawConfig;
    const inputConfig = structuredClone(runtimeConfig);
    const matches = () =>
      providerConfigMatchesRuntimeSnapshot({ inputConfig, runtimeConfig, provider: "acme" });
    expect(matches()).toBe(true);
    inputConfig.models.providers.acme.baseUrl = "https://other.example/v1";
    expect(matches()).toBe(false);
    inputConfig.models.providers.acme = runtimeConfig.models.providers.acme;
    expect(matches()).toBe(true);
    expect(
      providerConfigMatchesRuntimeSnapshot({ inputConfig, runtimeConfig, provider: "missing" }),
    ).toBe(false);
  });

  it("preserves normalized provider merging before comparing snapshots", () => {
    const provider = { baseUrl: "https://acme.example/v1", models: [] };
    const inputConfig = {
      models: { providers: { " acme ": provider, acme: { ...provider, auth: "api-key" } } },
    } satisfies OpenClawConfig;
    const runtimeConfig = {
      models: { providers: { acme: { ...provider, auth: "api-key" } } },
    } satisfies OpenClawConfig;
    const matches = () =>
      providerConfigMatchesRuntimeSnapshot({ inputConfig, runtimeConfig, provider: "ACME" });
    expect(matches()).toBe(true);
    inputConfig.models.providers.acme.baseUrl = "https://other.example/v1";
    expect(matches()).toBe(false);
  });
});
