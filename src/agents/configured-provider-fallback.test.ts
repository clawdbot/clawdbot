import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveConfiguredProviderFallback } from "./configured-provider-fallback.js";

type ModelProviders = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;

function configuredProviders(providers: ModelProviders): Pick<OpenClawConfig, "models"> {
  return { models: { providers } };
}

const localProvider = {
  baseUrl: "http://127.0.0.1:9191/v1",
  models: [{ id: "local-good", name: "Local Good" }],
};

describe("resolveConfiguredProviderFallback", () => {
  it("uses a configured model when the default provider is only an empty overlay", () => {
    expect(
      resolveConfiguredProviderFallback({
        cfg: configuredProviders({
          openai: { models: [] },
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
          openai: { models: [{ id: "other-openai-model", name: "Other OpenAI Model" }] },
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
          " OpenAI ": {
            models: [{ id: "configured-default", name: "Configured Default" }],
          },
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
          openai: { models: [{ id: "configured-default", name: "Configured Default" }] },
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
          openai: { models: [] },
          first: {
            baseUrl: "http://127.0.0.1:9192/v1",
            models: [{ id: "first-model", name: "First Model" }],
          },
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
        cfg: configuredProviders({ openai: { models: [] } }),
        defaultProvider: "openai",
        defaultModel: "missing-default-model",
      }),
    ).toBeNull();
  });
});
