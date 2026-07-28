// Apiário tests cover index plugin behavior.
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveProviderAuthEnvVarCandidates } from "openclaw/plugin-sdk/provider-env-vars";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import apiarioPlugin from "./index.js";

describe("apiario provider plugin", () => {
  it("registers Apiário with direct API key auth", async () => {
    const provider = await registerSingleProviderPlugin(apiarioPlugin);

    expect(provider.id).toBe("apiario");
    expect(provider.label).toBe("Apiário");
    expect(provider.envVars).toEqual(["APIARIO_API_KEY"]);
    expect(provider.auth).toHaveLength(1);

    const directChoice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "apiario-api-key",
    });
    if (!directChoice) {
      throw new Error("expected Apiário auth choice");
    }
    expect(directChoice.provider.id).toBe("apiario");
    expect(directChoice.method.id).toBe("apiario-api-key");
  });

  it("keeps Apiário auth env candidates", () => {
    const candidates = resolveProviderAuthEnvVarCandidates();
    expect(candidates.apiario).toEqual(["APIARIO_API_KEY"]);
  });

  it("builds the Apiário model catalog", async () => {
    const provider = await registerSingleProviderPlugin(apiarioPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider, {
      resolveProviderApiKey: (id?: string) =>
        id === "apiario" ? { apiKey: "test-key" } : { apiKey: undefined },
    });

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://api.apiario.dev/v1");
    expect(catalogProvider.models).toBeDefined();
    expect(catalogProvider.models?.length).toBeGreaterThanOrEqual(1);
  });
});
