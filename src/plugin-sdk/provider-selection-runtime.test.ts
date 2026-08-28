/**
 * Tests provider selection runtime helper behavior.
 */
import { describe, expect, it, vi } from "vitest";
import {
  resolveConfiguredCapabilityProvider,
  resolveProviderRawConfig,
  selectConfiguredOrAutoProvider,
  type AutoSelectableProvider,
} from "./provider-selection-runtime.js";

type TestProvider = AutoSelectableProvider & {
  configured?: boolean;
};

describe("plugin-sdk provider-selection-runtime", () => {
  const providers: TestProvider[] = [
    { id: "first", autoSelectOrder: 1 },
    { id: "second", autoSelectOrder: 2, configured: true },
  ];

  it("selects an explicit provider when it exists", () => {
    const selection = selectConfiguredOrAutoProvider({
      configuredProviderId: " second ",
      getConfiguredProvider: (providerId) => providers.find((entry) => entry.id === providerId),
      listProviders: () => providers,
    });

    expect(selection).toEqual({
      configuredProviderId: "second",
      missingConfiguredProvider: false,
      provider: providers[1],
    });
  });

  it("reports a missing explicit provider", () => {
    const resolution = resolveConfiguredCapabilityProvider({
      configuredProviderId: "missing",
      cfg: {},
      cfgForResolve: {},
      getConfiguredProvider: (providerId) => providers.find((entry) => entry.id === providerId),
      listProviders: () => providers,
      resolveProviderConfig: ({ rawConfig }) => rawConfig,
      isProviderConfigured: ({ provider }) => provider.configured === true,
    });

    expect(resolution).toEqual({
      ok: false,
      code: "missing-configured-provider",
      configuredProviderId: "missing",
    });
  });

  it("auto-selects the first configured provider by order", () => {
    const resolution = resolveConfiguredCapabilityProvider({
      cfg: {},
      cfgForResolve: {},
      getConfiguredProvider: (providerId) => providers.find((entry) => entry.id === providerId),
      listProviders: () => providers,
      resolveProviderConfig: ({ provider, rawConfig }) => ({
        ...rawConfig,
        providerId: provider.id,
      }),
      isProviderConfigured: ({ providerConfig }) => providerConfig.providerId === "second",
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      throw new Error("expected provider resolution to succeed");
    }
    expect(resolution.provider).toBe(providers[1]);
    expect(resolution.providerConfig).toEqual({ providerId: "second" });
  });

  it("skips unavailable auto candidates before config normalization", () => {
    const resolveProviderConfig = vi.fn(({ provider }: { provider: TestProvider }) => ({
      providerId: provider.id,
    }));
    const resolution = resolveConfiguredCapabilityProvider({
      cfg: {},
      cfgForResolve: {},
      getConfiguredProvider: (providerId) => providers.find((entry) => entry.id === providerId),
      listProviders: () => providers,
      isProviderAvailable: ({ provider }) => provider.id !== "first",
      resolveProviderConfig,
      isProviderConfigured: () => true,
    });

    expect(resolution.ok).toBe(true);
    expect(resolveProviderConfig).toHaveBeenCalledOnce();
    expect(resolveProviderConfig).toHaveBeenCalledWith(
      expect.objectContaining({ provider: providers[1] }),
    );
  });

  it("retains the first unavailable provider when no auto candidate is available", () => {
    const resolveProviderConfig = vi.fn();
    const resolution = resolveConfiguredCapabilityProvider({
      cfg: {},
      cfgForResolve: {},
      getConfiguredProvider: (providerId) => providers.find((entry) => entry.id === providerId),
      listProviders: () => providers,
      isProviderAvailable: () => false,
      resolveProviderConfig,
      isProviderConfigured: () => true,
    });

    expect(resolution).toEqual({
      ok: false,
      code: "provider-unavailable",
      provider: providers[0],
    });
    expect(resolveProviderConfig).not.toHaveBeenCalled();
  });

  it("merges canonical and selected provider config", () => {
    expect(
      resolveProviderRawConfig({
        providerId: "canonical",
        configuredProviderId: "alias",
        providerConfigs: {
          canonical: { apiKey: "default", model: "base" },
          alias: { model: "alias-model" },
        },
      }),
    ).toEqual({
      apiKey: "default",
      model: "alias-model",
    });
  });
});
