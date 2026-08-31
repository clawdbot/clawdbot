import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveConfiguredProviderFallback } from "./configured-provider-fallback.js";

type ModelProviders = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;
type ConfiguredModel = ModelProviders[string]["models"][number];

function configuredProviders(providers: ModelProviders): Pick<OpenClawConfig, "models"> {
  return { models: { providers } };
}

function configuredModel(id: string, name: string): ConfiguredModel {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

function configuredProvider(
  baseUrl: string,
  models: ConfiguredModel[] = [],
): ModelProviders[string] {
  return { baseUrl, models };
}

const defaultProviderBaseUrl = "https://openai.example.com/v1";
const localProvider = configuredProvider("http://127.0.0.1:9191/v1", [
  configuredModel("local-good", "Local Good"),
]);

describe("resolveConfiguredProviderFallback", () => {
  it("uses a configured model when the default provider is only an empty overlay", () => {
    expect(
      resolveConfiguredProviderFallback({
        cfg: configuredProviders({
          openai: configuredProvider(defaultProviderBaseUrl),
          "local-provider": localProvider,
        }),
        defaultProvider: "openai",
        defaultModel: undefined,
      }),
    ).toEqual({ provider: "local-provider", model: "local-good" });
  });

  it("preserves configured provider order when the default model is absent", () => {
    expect(
      resolveConfiguredProviderFallback({
        cfg: configuredProviders({
          openai: configuredProvider(defaultProviderBaseUrl, [
            configuredModel("other-openai-model", "Other OpenAI Model"),
          ]),
          "local-provider": localProvider,
        }),
        defaultProvider: "openai",
        defaultModel: "missing-default-model",
      }),
    ).toEqual({ provider: "openai", model: "other-openai-model" });
  });

  it("recognizes normalized default provider keys", () => {
    expect(
      resolveConfiguredProviderFallback({
        cfg: configuredProviders({
          " OpenAI ": configuredProvider(defaultProviderBaseUrl, [
            configuredModel("configured-default", "Configured Default"),
          ]),
          "local-provider": localProvider,
        }),
        defaultProvider: "openai",
        defaultModel: "configured-default",
      }),
    ).toBeNull();
  });

  it("normalizes the selected custom provider without changing its configured model", () => {
    expect(
      resolveConfiguredProviderFallback({
        cfg: configuredProviders({ " Local-Provider ": localProvider }),
        defaultProvider: "openai",
        defaultModel: undefined,
      }),
    ).toEqual({ provider: "local-provider", model: "local-good" });
  });

  it("preserves the configured default model when it is available", () => {
    expect(
      resolveConfiguredProviderFallback({
        cfg: configuredProviders({
          openai: configuredProvider(defaultProviderBaseUrl, [
            configuredModel("configured-default", "Configured Default"),
          ]),
          "local-provider": localProvider,
        }),
        defaultProvider: "openai",
        defaultModel: "configured-default",
      }),
    ).toBeNull();
  });

  it("preserves configured provider preference order", () => {
    expect(
      resolveConfiguredProviderFallback({
        cfg: configuredProviders({
          openai: configuredProvider(defaultProviderBaseUrl),
          first: configuredProvider("http://127.0.0.1:9192/v1", [
            configuredModel("first-model", "First Model"),
          ]),
          second: localProvider,
        }),
        defaultProvider: "openai",
        defaultModel: undefined,
      }),
    ).toEqual({ provider: "first", model: "first-model" });
  });

  it("returns no fallback when no provider has a configured model", () => {
    expect(
      resolveConfiguredProviderFallback({
        cfg: configuredProviders({ openai: configuredProvider(defaultProviderBaseUrl) }),
        defaultProvider: "openai",
        defaultModel: "missing-default-model",
      }),
    ).toBeNull();
  });
});
