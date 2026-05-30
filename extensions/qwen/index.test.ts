import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ProviderCatalogResult } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import { QWEN_36_PLUS_MODEL_ID, QWEN_BASE_URL } from "./api.js";
import qwenPlugin from "./index.js";
import { wrapQwenProviderStream } from "./stream.js";

function requireCatalogProvider(result: ProviderCatalogResult): ModelProviderConfig {
  if (!result || !("provider" in result)) {
    throw new Error("single provider catalog result missing");
  }
  return result.provider;
}

async function registerQwenProvider() {
  const { providers } = await registerProviderPlugin({
    plugin: qwenPlugin,
    id: "qwen",
    name: "Qwen Provider",
  });
  return requireRegisteredProvider(providers, "qwen");
}

describe("qwen provider plugin", () => {
  it("keeps qwen3.6-plus out of Coding Plan normalized catalogs", async () => {
    const provider = await registerQwenProvider();

    const normalized = provider.normalizeConfig?.({
      provider: "qwen",
      providerConfig: {
        baseUrl: QWEN_BASE_URL,
        models: [{ id: "qwen3.5-plus" }, { id: QWEN_36_PLUS_MODEL_ID }],
      },
    } as never);

    expect(normalized?.models?.map((model) => model.id)).toEqual(["qwen3.5-plus"]);
  });

  it("does not expose runtime model suppression hooks", async () => {
    const provider = await registerQwenProvider();

    expect(provider.suppressBuiltInModel).toBeUndefined();
  });

  it("registers qwen-oauth as a portal provider", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: qwenPlugin,
      id: "qwen",
      name: "Qwen Provider",
    });
    const provider = requireRegisteredProvider(providers, "qwen-oauth");

    expect(provider.aliases).toEqual(["qwen-portal", "qwen-cli"]);
    expect(provider.envVars).toEqual(["QWEN_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider.baseUrl).toBe("https://portal.qwen.ai/v1");
    expect(catalogProvider.models?.map((model) => model.id)).toContain("qwen3.5-plus");
  });

  it("reuses legacy qwen portal auth profiles for qwen-oauth catalog", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: qwenPlugin,
      id: "qwen",
      name: "Qwen Provider",
    });
    const provider = requireRegisteredProvider(providers, "qwen-oauth");

    const result = await provider.catalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: (providerId: string) =>
        providerId === "qwen-portal" ? { apiKey: "portal-token" } : {},
    } as never);

    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider.apiKey).toBe("portal-token");
    expect(catalogProvider.baseUrl).toBe("https://portal.qwen.ai/v1");
  });

  it.each([["qwen-oauth"], ["qwen-portal"], ["qwen-cli"]])(
    "patches %s message payloads for portal compatibility",
    async (providerId) => {
      let patchedPayload: Record<string, unknown> | undefined;
      const streamFn = wrapQwenProviderStream({
        provider: providerId,
        thinkingLevel: "off",
        streamFn: ((
          _model: unknown,
          _context: unknown,
          options?: {
            onPayload?: (payload: Record<string, unknown>, model: unknown) => void;
          },
        ) => {
          const payload = {
            messages: [
              { role: "system", content: "system text" },
              { role: "user", content: ["hello", { type: "text", text: "world" }] },
            ],
          };
          options?.onPayload?.(payload, _model);
          patchedPayload = payload;
          return (async function* () {})();
        }) as never,
      } as never);

      const stream = streamFn!(
        {
          provider: providerId,
          api: "openai-completions",
          id: "qwen3.5-plus",
        } as never,
        {} as never,
        {},
      ) as AsyncIterable<unknown>;
      for await (const event of stream) {
        void event;
        // Drain stream so the payload hook runs.
      }

      expect(patchedPayload?.vl_high_resolution_images).toBe(true);
      expect(patchedPayload?.messages).toEqual([
        {
          role: "system",
          content: [{ type: "text", text: "system text", cache_control: { type: "ephemeral" } }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: "world" },
          ],
        },
      ]);
    },
  );
});
