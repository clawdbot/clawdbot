import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { createOpenAIModelRoutesResolver } from "../../agents/openai-model-routes.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestContext } from "./types.js";

const WITHOUT_OPENAI_ENV_AUTH = {
  CODEX_API_KEY: undefined,
  CODEX_HOME: "/__openclaw_models_list_test__/codex",
  OPENAI_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  OPENAI_OAUTH_TOKEN: undefined,
  CHATGPT_OAUTH_TOKEN: undefined,
} as const;

function catalogEntry(id: string, api: ModelCatalogEntry["api"]): ModelCatalogEntry {
  return { id, name: id, provider: "openai", api };
}

async function listModels(params: {
  catalog: ModelCatalogEntry[];
  cfg?: OpenClawConfig;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
  view?: "all" | "configured" | "provider-config" | "default";
}) {
  const context = {
    getRuntimeConfig: () => params.cfg ?? ({} as OpenClawConfig),
    loadGatewayModelCatalog: vi.fn(() => Promise.resolve(params.catalog)),
    loadGatewayModelCatalogSnapshot: vi.fn(() =>
      Promise.resolve({ entries: params.catalog, routeVariants: params.catalog }),
    ),
    logGateway: { debug: vi.fn() },
  } as unknown as GatewayRequestContext;
  return await buildModelsListResult({
    context,
    params: { view: params.view ?? "all" },
    ...(params.routeResolverFactory ? { routeResolverFactory: params.routeResolverFactory } : {}),
  });
}

describe("models.list OpenAI routes", () => {
  it("keeps route-aware default browse indeterminate without the provider artifact", async () => {
    const resolveRoutes = vi.fn(() => null);
    const createResolver = vi.fn(() => resolveRoutes);
    await withEnvAsync({ ...WITHOUT_OPENAI_ENV_AUTH, OPENAI_API_KEY: "test-key" }, async () => {
      await expect(
        listModels({
          view: "default",
          catalog: [
            catalogEntry("gpt-5.5", "openai-responses"),
            catalogEntry("gpt-5.6", "openai-responses"),
          ],
          routeResolverFactory: createResolver,
        }),
      ).resolves.toEqual({ models: [] });
    });
    expect(createResolver).toHaveBeenCalledOnce();
    expect(resolveRoutes).toHaveBeenCalledTimes(2);
  });
  it("keeps exhaustive Codex rows visible but unavailable when the route artifact is missing", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-models-list-openai-null-artifact-oauth-",
          agentEnv: "main",
        },
        async (state) => {
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "openai:chatgpt": {
                type: "oauth",
                provider: "openai",
                access: "chatgpt-access",
                refresh: "chatgpt-refresh",
                expires: Date.now() + 30 * 60_000,
              },
            },
          });
          await expect(
            listModels({
              catalog: [catalogEntry("gpt-5.4-codex", "openai-responses")],
              routeResolverFactory: () => () => null,
            }),
          ).resolves.toEqual({
            models: [
              {
                id: "gpt-5.4-codex",
                name: "gpt-5.4-codex",
                provider: "openai",
                available: false,
              },
            ],
          });
        },
      );
    });
  });

  it("omits route-sensitive metadata while route observation is required", async () => {
    const routeResolverFactory = vi.fn(() => () => ({
      kind: "indeterminate" as const,
      defaultRuntimeId: "codex",
    }));
    const row = {
      ...catalogEntry("gpt-5.6", "openai-responses"),
      baseUrl: "https://api.openai.com/v1",
      contextTokens: 800_000,
      contextWindow: 1_000_000,
      input: ["text", "image"],
      params: { apiKey: "private" },
      compat: { supportsStore: false },
      mediaInput: { image: { maxBytes: 42 } },
      reasoning: true,
    } as ModelCatalogEntry;

    await expect(listModels({ catalog: [row], routeResolverFactory })).resolves.toEqual({
      models: [{ id: "gpt-5.6", name: "gpt-5.6", provider: "openai", available: false }],
    });
  });

  it("keeps public metadata for a provider-canonical model-level Platform route", async () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.4-nano",
                name: "GPT-5.4 Nano",
                api: "openai-completions",
                baseUrl: "https://api.openai.com",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const row = {
      ...catalogEntry("gpt-5.4-nano", "openai-completions"),
      baseUrl: "https://api.openai.com",
      contextTokens: 800_000,
      contextWindow: 1_000_000,
      input: ["text", "image"],
      params: { apiKey: "private" },
      compat: { supportsStore: false },
      mediaInput: { image: { maxBytes: 42 } },
      reasoning: true,
    } as ModelCatalogEntry;

    await withEnvAsync({ ...WITHOUT_OPENAI_ENV_AUTH, OPENAI_API_KEY: "test-key" }, async () => {
      await expect(listModels({ catalog: [row], cfg })).resolves.toEqual({
        models: [
          {
            id: "gpt-5.4-nano",
            name: "GPT-5.4 Nano",
            provider: "openai",
            contextWindow: 1_000_000,
            reasoning: true,
            available: true,
          },
        ],
      });
    });
  });

  it("keeps the all view exhaustive while default hides incompatible implicit rows", async () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            models: [{ id: "gpt-5.6", name: "GPT-5.6" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const incompatibleRow = {
      ...catalogEntry("chat-latest", "openai-chatgpt-responses"),
      reasoning: true,
    } as ModelCatalogEntry;

    await expect(
      listModels({
        cfg,
        catalog: [catalogEntry("gpt-5.6", "openai-chatgpt-responses"), incompatibleRow],
      }),
    ).resolves.toEqual({
      models: [
        { id: "chat-latest", name: "chat-latest", provider: "openai", available: false },
        { id: "gpt-5.6", name: "GPT-5.6", provider: "openai", available: false },
      ],
    });

    await expect(
      listModels({
        cfg,
        view: "default",
        catalog: [catalogEntry("gpt-5.6", "openai-chatgpt-responses"), incompatibleRow],
      }),
    ).resolves.toEqual({
      models: [{ id: "gpt-5.6", name: "GPT-5.6", provider: "openai", available: false }],
    });
  });
  it("uses auth.order to project one logical route and its capabilities", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-models-list-openai-auth-order-",
          agentEnv: "main",
        },
        async (state) => {
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "openai:chatgpt": {
                type: "oauth",
                provider: "openai",
                access: "chatgpt-access",
                refresh: "chatgpt-refresh",
                expires: Date.now() + 30 * 60_000,
              },
              "openai:key": {
                type: "api_key",
                provider: "openai",
                key: "test-key",
              },
            },
          });
          const cfg = {
            auth: { order: { openai: ["openai:chatgpt", "openai:key"] } },
          } as unknown as OpenClawConfig;
          const row = {
            ...catalogEntry("gpt-5.5", "openai-responses"),
            baseUrl: "https://api.openai.com/v1",
            contextWindow: 1_000_000,
            reasoning: true,
          } as ModelCatalogEntry;

          await expect(listModels({ catalog: [row], cfg })).resolves.toEqual({
            models: [
              {
                id: "gpt-5.5",
                name: "gpt-5.5",
                provider: "openai",
                available: true,
              },
            ],
          });

          const chatGPTRow = {
            ...catalogEntry("gpt-5.5", "openai-chatgpt-responses"),
            baseUrl: "https://chatgpt.com/backend-api/codex",
            contextWindow: 400_000,
            params: { apiKey: "private" },
            compat: { supportsStore: false },
            mediaInput: { image: { maxBytes: 42 } },
            reasoning: true,
          } as ModelCatalogEntry;
          const subscriptionProjection = {
            models: [
              {
                id: "gpt-5.5",
                name: "gpt-5.5",
                provider: "openai",
                contextWindow: 400_000,
                reasoning: true,
                available: true,
              },
            ],
          };
          await expect(listModels({ catalog: [row, chatGPTRow], cfg })).resolves.toEqual(
            subscriptionProjection,
          );
          await expect(listModels({ catalog: [chatGPTRow, row], cfg })).resolves.toEqual(
            subscriptionProjection,
          );

          const inventoryConfig = {
            ...cfg,
            models: {
              providers: {
                openai: {
                  models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
                },
              },
            },
          } as unknown as OpenClawConfig;
          await expect(
            listModels({
              catalog: [
                { ...row, input: ["text", "image"] },
                { ...chatGPTRow, input: ["text", "video"] },
              ],
              cfg: inventoryConfig,
              view: "provider-config",
            }),
          ).resolves.toEqual({
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                provider: "openai",
                contextWindow: 400_000,
                reasoning: true,
                input: ["text", "video"],
                available: true,
              },
            ],
          });

          await expect(
            listModels({ catalog: [row, chatGPTRow], cfg, view: "default" }),
          ).resolves.toEqual(subscriptionProjection);

          const apiKeyFirst = {
            auth: { order: { openai: ["openai:key", "openai:chatgpt"] } },
          } as unknown as OpenClawConfig;
          await expect(listModels({ catalog: [row], cfg: apiKeyFirst })).resolves.toEqual({
            models: [
              {
                id: "gpt-5.5",
                name: "gpt-5.5",
                provider: "openai",
                contextWindow: 1_000_000,
                reasoning: true,
                available: true,
              },
            ],
          });
        },
      );
    });
  });
  it("keeps configured provider rows visible when unavailable", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      const cfg = {
        models: {
          providers: {
            openai: {
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              models: [{ id: "gpt-5.6", name: "GPT-5.6" }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      await expect(
        listModels({
          cfg,
          view: "configured",
          catalog: [catalogEntry("gpt-5.6", "openai-chatgpt-responses")],
        }),
      ).resolves.toEqual({
        models: [
          {
            id: "gpt-5.6",
            name: "GPT-5.6",
            provider: "openai",
            available: false,
          },
        ],
      });
    });
  });

  it("keeps configured fallback rows visible when their route is unavailable", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-models-list-openai-fallback-",
          agentEnv: "main",
        },
        async () => {
          const cfg = {
            agents: {
              defaults: {
                model: {
                  primary: "anthropic/claude-test",
                  fallbacks: ["openai/chat-latest"],
                },
              },
            },
            models: {
              providers: {
                openai: {
                  api: "openai-chatgpt-responses",
                  baseUrl: "https://chatgpt.com/backend-api/codex",
                  models: [],
                },
              },
            },
          } as unknown as OpenClawConfig;
          const result = await listModels({
            cfg,
            view: "configured",
            catalog: [catalogEntry("chat-latest", "openai-chatgpt-responses")],
          });

          expect(result.models).toContainEqual({
            id: "chat-latest",
            name: "chat-latest",
            provider: "openai",
            available: false,
          });
        },
      );
    });
  });

  it("resolves configured fallback aliases before retaining unavailable rows", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      const cfg = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-test",
              fallbacks: ["fast"],
            },
            models: {
              "openai/chat-latest": { alias: "fast" },
            },
          },
        },
        models: {
          providers: {
            openai: {
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig;

      await expect(
        listModels({
          cfg,
          view: "configured",
          catalog: [catalogEntry("chat-latest", "openai-chatgpt-responses")],
        }),
      ).resolves.toEqual({
        models: [
          {
            id: "chat-latest",
            name: "chat-latest",
            provider: "openai",
            alias: "fast",
            available: false,
          },
        ],
      });
    });
  });
});
