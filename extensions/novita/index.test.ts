// Novita tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

function requireCatalogProvider(
  result:
    | { provider: { baseUrl?: string; models?: Array<{ id: string }> } }
    | { providers: Record<string, unknown> }
    | null
    | undefined,
): { baseUrl?: string; models?: Array<{ id: string }> } {
  if (!result || !("provider" in result)) {
    throw new Error("single provider catalog result missing");
  }
  return result.provider;
}

describe("novita provider plugin", () => {
  it("registers NovitaAI as an OpenAI-compatible provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("novita");
    expect(provider.aliases).toEqual(["novita-ai", "novitaai"]);
    expect(provider.envVars).toEqual(["NOVITA_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);
    expect(provider.auth?.[0]?.starterModel).toBe("novita/deepseek/deepseek-v4-pro");

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider.baseUrl).toBe("https://api.novita.ai/openai/v1");
    expect(catalogProvider.models?.map((model) => model.id)).toContain("deepseek/deepseek-v4-pro");
  });

  // Mirrors the regression that produced #103532: PR #112412 introduced the
  // refreshable provider mode (live discovery with a static fallback), so the
  // manifest must declare a discovery mode other than `undefined` for the
  // bundled static-catalog resolver and the static-authoritative manifest
  // filter to surface the shipped manifest rows. The companion code change in
  // src/commands/models/list.manifest-catalog.ts and
  // src/agents/embedded-agent-runner/model.static-catalog.ts makes both
  // consumers accept refreshable catalog rows, which keeps the live-augmentation
  // path intact for existing users.
  it("declares a non-runtime discovery mode so the bundled resolver surfaces Novita rows", () => {
    expect(manifest.modelCatalog?.discovery?.novita).toBe("refreshable");
  });
});
