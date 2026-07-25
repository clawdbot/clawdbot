import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
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
const IMPLICIT_CODEX_RUNTIME = { id: "codex", source: "implicit" } as const;
const IMPLICIT_OPENCLAW_RUNTIME = { id: "openclaw", source: "implicit" } as const;

function catalogEntry(id: string, api: ModelCatalogEntry["api"]): ModelCatalogEntry {
  return { id, name: id, provider: "openai", api };
}

async function listModels(params: {
  catalog: ModelCatalogEntry[];
  cfg?: OpenClawConfig;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
  view?: "all" | "configured" | "provider-config" | "default";
}) {
  const config = params.cfg ?? ({} as OpenClawConfig);
  const context = {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalog: vi.fn(() => Promise.resolve(params.catalog)),
    loadGatewayModelCatalogSnapshot: vi.fn(() =>
      Promise.resolve({
        agentId: "main",
        agentDir: "/tmp/models-list-openai-agent",
        config,
        entries: params.catalog,
        routeVariants: params.catalog,
      }),
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
  it("does not reuse a preloaded catalog owned by another agent", async () => {
    const config = {
      agents: {
        defaults: {},
        list: [{ id: "main", default: true }, { id: "worker" }],
      },
    } as OpenClawConfig;
    const loadGatewayModelCatalogSnapshot = vi.fn(() =>
      Promise.resolve({
        agentDir: "/tmp/models-list-openai-agent",
        config,
        entries: [],
        routeVariants: [],
      }),
    );
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    const preloadedCatalog: ModelCatalogSnapshot = {
      entries: [catalogEntry("gpt-main", "openai-responses")],
      routeVariants: [],
    };

    await expect(
      buildModelsListResult({
        context,
        agentId: "worker",
        params: { view: "default" },
        preloadedCatalog: { agentId: "main", config, snapshot: preloadedCatalog },
      }),
    ).resolves.toEqual({ models: [] });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "worker" }),
    );
  });

  it("does not reuse a preloaded catalog from another config generation", async () => {
    const config = {} as OpenClawConfig;
    const loadGatewayModelCatalogSnapshot = vi.fn(() =>
      Promise.resolve({
        agentDir: "/tmp/models-list-openai-agent",
        config,
        entries: [],
        routeVariants: [],
      }),
    );
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await expect(
      buildModelsListResult({
        context,
        params: { view: "default" },
        preloadedCatalog: {
          agentId: "main",
          config: {} as OpenClawConfig,
          snapshot: { entries: [catalogEntry("stale", "openai-responses")], routeVariants: [] },
        },
      }),
    ).resolves.toEqual({ models: [] });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledOnce();
  });

  it("does not reuse a preloaded projector after a full replacement-owner load", async () => {
    const config = {} as OpenClawConfig;
    const replacementConfig = {} as OpenClawConfig;
    const loadGatewayModelCatalogSnapshot = vi.fn(() =>
      Promise.resolve({
        agentDir: "/tmp/models-list-openai-agent",
        config: replacementConfig,
        entries: [],
        routeVariants: [],
      }),
    );
    const evaluateEntry = vi.fn();
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await expect(
      buildModelsListResult({
        context,
        params: { view: "all" },
        preloadedCatalog: {
          agentId: "main",
          config,
          snapshot: { entries: [catalogEntry("stale", "openai-responses")], routeVariants: [] },
        },
        catalogProjector: { evaluateEntry } as never,
      }),
    ).resolves.toEqual({ models: [] });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({
      agentId: "main",
      readOnly: false,
    });
    expect(evaluateEntry).not.toHaveBeenCalled();
  });

  it("does not start full discovery when restricted to a preloaded catalog", async () => {
    const config = {} as OpenClawConfig;
    const loadGatewayModelCatalogSnapshot = vi.fn();
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await expect(
      buildModelsListResult({
        context,
        params: { view: "all" },
        preloadedCatalog: {
          agentId: "main",
          config,
          snapshot: { entries: [catalogEntry("stale", "openai-responses")], routeVariants: [] },
        },
        preloadedOnly: true,
      }),
    ).resolves.toEqual({ models: [] });
    expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
  });

  it("uses the published fallback owner's identity for implicit projection", async () => {
    const config = {
      agents: {
        defaults: {},
        list: [
          {
            id: "main",
            models: { "openai/gpt-owner": { agentRuntime: { id: "codex" } } },
          },
          {
            id: "worker",
            default: true,
            models: { "openai/gpt-owner": { agentRuntime: { id: "openclaw" } } },
          },
        ],
      },
    } as OpenClawConfig;
    const ownerEntry = catalogEntry("gpt-owner", "openai-responses");
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot: vi.fn(() =>
        Promise.resolve({
          agentId: "main",
          agentDir: "/tmp/models-list-openai-agent",
          config,
          entries: [ownerEntry],
          routeVariants: [ownerEntry],
        }),
      ),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    const result = await buildModelsListResult({
      context,
      params: { view: "all" },
    });

    expect(result).toEqual({
      models: [
        expect.objectContaining({
          id: "gpt-owner",
          provider: "openai",
          agentRuntime: { id: "codex", source: "model" },
        }),
      ],
    });
    expect(context.loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({
      agentId: "worker",
      readOnly: false,
    });
  });

  it("escalates full discovery using the replacement owner's agent", async () => {
    const initialConfig = {
      agents: { defaults: {}, list: [{ id: "main" }, { id: "worker", default: true }] },
    } as OpenClawConfig;
    const replacementConfig = {
      agents: {
        defaults: { models: { "openai/*": {} } },
        list: [{ id: "main", default: true }, { id: "worker" }],
      },
    } as OpenClawConfig;
    const entry = catalogEntry("gpt-owner", "openai-responses");
    const loadGatewayModelCatalogSnapshot = vi
      .fn<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>()
      .mockResolvedValueOnce({
        agentId: "main",
        agentDir: "/tmp/models-list-main-agent",
        config: replacementConfig,
        entries: [entry],
        routeVariants: [entry],
      })
      .mockResolvedValueOnce({
        agentId: "main",
        agentDir: "/tmp/models-list-main-agent",
        config: replacementConfig,
        entries: [entry],
        routeVariants: [entry],
      });
    const context = {
      getRuntimeConfig: () => initialConfig,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await buildModelsListResult({ context, params: { view: "configured" } });

    expect(loadGatewayModelCatalogSnapshot.mock.calls).toEqual([
      [{ agentId: "worker", readOnly: true }],
      [{ agentId: "main", readOnly: false }],
    ]);
  });

  it("passes the resolved default agent to catalog loads", async () => {
    const config = {
      agents: { defaults: {}, list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const loadGatewayModelCatalogSnapshot = vi.fn(
      (params: { agentId?: string; readOnly?: boolean }) =>
        Promise.resolve({
          agentId: params.agentId,
          agentDir: "/tmp/models-list-openai-agent",
          config,
          entries: [],
          routeVariants: [],
        }),
    );
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await expect(buildModelsListResult({ context, params: { view: "all" } })).resolves.toEqual({
      models: [],
    });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({
      agentId: "main",
      readOnly: false,
    });
  });

  it("does not project an ownerless catalog as the requested agent", async () => {
    const config = {
      agents: {
        defaults: {},
        list: [
          { id: "main", default: true },
          {
            id: "worker",
            models: { "openai/gpt-ownerless": { agentRuntime: { id: "openclaw" } } },
          },
        ],
      },
    } as OpenClawConfig;
    const ownerlessEntry = catalogEntry("gpt-ownerless", "openai-responses");
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot: vi.fn(() =>
        Promise.resolve({
          agentDir: "/tmp/models-list-openai-agent",
          config,
          entries: [ownerlessEntry],
          routeVariants: [ownerlessEntry],
        }),
      ),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await expect(
      buildModelsListResult({
        context,
        agentId: "worker",
        params: { view: "all" },
      }),
    ).resolves.toEqual({ models: [] });
  });

  it("does not project another owner's catalog as an explicitly requested agent", async () => {
    const config = {
      agents: {
        defaults: {},
        list: [{ id: "main", default: true }, { id: "worker" }],
      },
    } as OpenClawConfig;
    const mainEntry = catalogEntry("gpt-main", "openai-responses");
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot: vi.fn(() =>
        Promise.resolve({
          agentId: "main",
          agentDir: "/tmp/models-list-main-agent",
          config,
          entries: [mainEntry],
          routeVariants: [mainEntry],
        }),
      ),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await expect(
      buildModelsListResult({
        context,
        agentId: "worker",
        params: { view: "all" },
      }),
    ).resolves.toEqual({ models: [] });
  });

  it("accepts a canonical owner for a noncanonical explicit agent request", async () => {
    const config = {
      agents: {
        defaults: {},
        list: [
          { id: "main", default: true },
          {
            id: "worker",
            models: { "openai/gpt-worker": { agentRuntime: { id: "openclaw" } } },
          },
        ],
      },
    } as OpenClawConfig;
    const workerEntry = catalogEntry("gpt-worker", "openai-responses");
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot: vi.fn(() =>
        Promise.resolve({
          agentId: "worker",
          agentDir: "/tmp/models-list-worker-agent",
          config,
          entries: [workerEntry],
          routeVariants: [workerEntry],
        }),
      ),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;

    await expect(
      buildModelsListResult({
        context,
        agentId: "WORKER",
        params: { view: "all" },
      }),
    ).resolves.toEqual({
      models: [
        expect.objectContaining({
          id: "gpt-worker",
          provider: "openai",
          agentRuntime: { id: "openclaw", source: "model" },
        }),
      ],
    });
  });

  it("keeps route-aware default browse indeterminate without the provider artifact", async () => {
    const resolveRoutes = vi.fn(() => null);
    const createResolver = vi.fn(() => resolveRoutes);
    await withEnvAsync(
      { ...WITHOUT_OPENAI_ENV_AUTH, OPENAI_API_KEY: "test-token-placeholder" },
      async () => {
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
      },
    );
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
                agentRuntime: IMPLICIT_CODEX_RUNTIME,
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
      models: [
        {
          id: "gpt-5.6",
          name: "gpt-5.6",
          provider: "openai",
          agentRuntime: IMPLICIT_CODEX_RUNTIME,
          available: false,
        },
      ],
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
            agentRuntime: IMPLICIT_OPENCLAW_RUNTIME,
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
        {
          id: "chat-latest",
          name: "chat-latest",
          provider: "openai",
          agentRuntime: IMPLICIT_OPENCLAW_RUNTIME,
          available: false,
        },
        {
          id: "gpt-5.6",
          name: "GPT-5.6",
          provider: "openai",
          agentRuntime: IMPLICIT_OPENCLAW_RUNTIME,
          available: false,
        },
      ],
    });

    await expect(
      listModels({
        cfg,
        view: "default",
        catalog: [catalogEntry("gpt-5.6", "openai-chatgpt-responses"), incompatibleRow],
      }),
    ).resolves.toEqual({
      models: [
        {
          id: "gpt-5.6",
          name: "GPT-5.6",
          provider: "openai",
          agentRuntime: IMPLICIT_OPENCLAW_RUNTIME,
          available: false,
        },
      ],
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
                agentRuntime: IMPLICIT_CODEX_RUNTIME,
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
                agentRuntime: IMPLICIT_CODEX_RUNTIME,
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
                agentRuntime: IMPLICIT_CODEX_RUNTIME,
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
                agentRuntime: IMPLICIT_CODEX_RUNTIME,
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
            agentRuntime: IMPLICIT_OPENCLAW_RUNTIME,
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
            agentRuntime: IMPLICIT_OPENCLAW_RUNTIME,
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
            agentRuntime: IMPLICIT_OPENCLAW_RUNTIME,
            available: false,
          },
        ],
      });
    });
  });

  it("exposes configured runtime intent independently of route execution", async () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4-nano": {
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    await withEnvAsync(
      { ...WITHOUT_OPENAI_ENV_AUTH, OPENAI_API_KEY: "test-token-placeholder" },
      async () => {
        const result = await listModels({
          cfg,
          catalog: [catalogEntry("gpt-5.4-nano", "openai-responses")],
        });

        expect(result.models).toContainEqual(
          expect.objectContaining({
            id: "gpt-5.4-nano",
            agentRuntime: { id: "codex", source: "model" },
          }),
        );
      },
    );
  });
});
