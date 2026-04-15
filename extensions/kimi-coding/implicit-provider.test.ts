import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

async function runKimiCatalog(params: {
  apiKey?: string;
  explicitProvider?: Record<string, unknown>;
}) {
  const provider = await registerSingleProviderPlugin(plugin);
  const catalogResult = await provider.catalog?.run({
    config: {
      models: {
        providers: params.explicitProvider
          ? {
              "kimi-coding": params.explicitProvider,
            }
          : {},
      },
    },
    resolveProviderApiKey: () => ({ apiKey: params.apiKey ?? "" }),
  } as never);
  return catalogResult ?? null;
}

async function runKimiCatalogProvider(params: {
  apiKey: string;
  explicitProvider?: Record<string, unknown>;
}) {
  const result = await runKimiCatalog(params);
  if (!result || !("provider" in result)) {
    throw new Error("expected Kimi catalog to return one provider");
  }
  return result.provider;
}

describe("Kimi implicit provider (#22409)", () => {
  it("publishes the env vars used by core api-key auto-detection", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.envVars).toEqual(["KIMI_API_KEY", "KIMICODE_API_KEY"]);
  });

  it("does not publish a provider when no API key is resolved", async () => {
    await expect(runKimiCatalog({})).resolves.toBeNull();
  });

  it("publishes the Kimi provider when an API key is resolved", async () => {
    const provider = await runKimiCatalogProvider({ apiKey: "test-key" });

    expect(provider).toMatchObject({
      apiKey: "test-key",
      baseUrl: "https://api.kimi.com/coding/",
      api: "anthropic-messages",
    });
  });

  it("uses explicit legacy kimi-coding baseUrl when provided", async () => {
    const provider = await runKimiCatalogProvider({
      apiKey: "test-key",
      explicitProvider: {
        baseUrl: "https://kimi.example.test/coding/",
      },
    });

    expect(provider.baseUrl).toBe("https://kimi.example.test/coding/");
  });

  it("merges explicit legacy kimi-coding headers on top of the built-in user agent", async () => {
    const provider = await runKimiCatalogProvider({
      apiKey: "test-key",
      explicitProvider: {
        headers: {
          "User-Agent": "custom-kimi-client/1.0",
          "X-Kimi-Tenant": "tenant-a",
        },
      },
    });

    expect(provider.headers).toEqual({
      "User-Agent": "custom-kimi-client/1.0",
      "X-Kimi-Tenant": "tenant-a",
    });
  });
});
