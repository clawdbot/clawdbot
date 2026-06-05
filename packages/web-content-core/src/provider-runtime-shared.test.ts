// Web Content Core tests cover provider runtime shared behavior.
import { describe, expect, it } from "vitest";
import {
  hasWebProviderEntryCredential,
  readWebProviderEnvValue,
  resolveWebProviderConfig,
  resolveWebProviderDefinition,
} from "./provider-runtime-shared.js";

describe("resolveWebProviderConfig", () => {
  it("selects the requested web tool config", () => {
    const search = { provider: "search-provider" };

    expect(
      resolveWebProviderConfig(
        {
          tools: {
            web: {
              search,
            },
          },
        },
        "search",
      ),
    ).toBe(search);
  });
});

describe("readWebProviderEnvValue", () => {
  it("normalizes env credentials before returning them", () => {
    expect(readWebProviderEnvValue(["API_KEY"], { API_KEY: " key\r\nvalue🙂 " })).toBe("keyvalue");
  });
});

describe("hasWebProviderEntryCredential", () => {
  const provider = {
    id: "custom",
    envVars: ["CUSTOM_API_KEY"],
  };

  it("treats non-env secret refs as configured credentials", () => {
    expect(
      hasWebProviderEntryCredential({
        provider,
        config: {},
        toolConfig: undefined,
        resolveRawValue: () => ({
          source: "file",
          provider: "mounted-json",
          id: "/custom/apiKey",
        }),
        resolveEnvValue: () => undefined,
      }),
    ).toBe(true);
  });

  it("resolves env secret ref ids through the env resolver", () => {
    expect(
      hasWebProviderEntryCredential({
        provider,
        config: {},
        toolConfig: undefined,
        resolveRawValue: () => ({
          source: "env",
          provider: "default",
          id: "CUSTOM_API_KEY",
        }),
        resolveEnvValue: ({ configuredEnvVarId }) =>
          configuredEnvVarId === "CUSTOM_API_KEY" ? "secret" : undefined,
      }),
    ).toBe(true);
  });

  it("falls back to provider auth before env probing", () => {
    expect(
      hasWebProviderEntryCredential({
        provider: {
          ...provider,
          authProviderId: "custom-auth",
        },
        config: {},
        toolConfig: undefined,
        resolveRawValue: () => undefined,
        resolveEnvValue: () => undefined,
        resolveProviderAuthValue: (providerId) => providerId === "custom-auth",
      }),
    ).toBe(true);
  });
});

describe("resolveWebProviderDefinition", () => {
  it("falls back to auto-detect when runtime metadata has no selected provider", () => {
    const resolved = resolveWebProviderDefinition({
      config: {},
      toolConfig: { enabled: true },
      runtimeMetadata: {},
      providers: [
        {
          id: "custom",
        },
      ],
      resolveEnabled: () => true,
      resolveAutoProviderId: () => "custom",
      createTool: ({ provider }) => ({
        name: provider.id,
      }),
    });

    expect(resolved).toEqual({
      provider: {
        id: "custom",
      },
      definition: {
        name: "custom",
      },
    });
  });
});
