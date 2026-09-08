import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildModelsListResult } from "./models-list-result.js";
import {
  catalogEntry,
  listModels,
  providerCatalogEntry,
  registerTestCatalogAccess,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";
import type { GatewayRequestContext } from "./types.js";

const IMPLICIT_CODEX_RUNTIME = {
  id: "codex",
  cloudPlacementSupported: false,
  devicePlacementSupported: false,
  source: "implicit",
} as const;
const IMPLICIT_OPENCLAW_RUNTIME = {
  id: "openclaw",
  cloudPlacementSupported: true,
  cloudPlacementExecutionMode: "worker-turn",
  devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
  devicePlacementSupported: true,
  source: "implicit",
} as const;
const MODEL_CODEX_RUNTIME = { ...IMPLICIT_CODEX_RUNTIME, source: "model" } as const;

const preparedOwnerFacts = (config: OpenClawConfig) =>
  ({
    authStore: { version: 1, profiles: {} },
    metadataSnapshot: loadManifestMetadataSnapshot({ config, env: process.env }),
  }) as const;

function emptyPreparedOwner(config: OpenClawConfig) {
  return {
    agentId: "main",
    agentDir: "/tmp/models-list-openai-agent",
    config,
    entries: [],
    routeVariants: [],
    ...preparedOwnerFacts(config),
  } as never;
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
        ...preparedOwnerFacts(config),
        entries: [],
        routeVariants: [],
      }),
    );
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    registerTestCatalogAccess(context, async () => emptyPreparedOwner(config));
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
    const config = { agents: { defaults: { model: "openai/current" } } } as OpenClawConfig;
    const loadGatewayModelCatalogSnapshot = vi.fn(() =>
      Promise.resolve({
        agentDir: "/tmp/models-list-openai-agent",
        config,
        ...preparedOwnerFacts(config),
        entries: [],
        routeVariants: [],
      }),
    );
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    registerTestCatalogAccess(context);

    await expect(
      buildModelsListResult({
        context,
        params: { view: "default" },
        preloadedCatalog: {
          agentId: "main",
          config: { agents: { defaults: { model: "openai/stale" } } } as OpenClawConfig,
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
        ...preparedOwnerFacts(replacementConfig),
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
    registerTestCatalogAccess(context, async () => emptyPreparedOwner(config));

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
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", readOnly: false }),
    );
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
    registerTestCatalogAccess(context, async () => emptyPreparedOwner(config));

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
          ...preparedOwnerFacts(config),
          entries: [ownerEntry],
          routeVariants: [ownerEntry],
        }),
      ),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    registerTestCatalogAccess(context);

    const result = await buildModelsListResult({
      context,
      params: { view: "all" },
    });

    expect(result).toEqual({
      models: [
        expect.objectContaining({
          id: "gpt-owner",
          provider: "openai",
          agentRuntime: MODEL_CODEX_RUNTIME,
        }),
      ],
    });
    expect(context.loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "worker", readOnly: false }),
    );
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
        catalogComplete: false,
        workspaceDir: "/tmp/models-list-main-workspace",
        config: replacementConfig,
        ...preparedOwnerFacts(replacementConfig),
        entries: [entry],
        routeVariants: [entry],
      })
      .mockResolvedValueOnce({
        agentId: "main",
        agentDir: "/tmp/models-list-main-agent",
        catalogComplete: true,
        workspaceDir: "/tmp/models-list-main-workspace",
        config: replacementConfig,
        ...preparedOwnerFacts(replacementConfig),
        entries: [entry],
        routeVariants: [entry],
      });
    const context = {
      getRuntimeConfig: () => initialConfig,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    registerTestCatalogAccess(context);

    await buildModelsListResult({ context, params: { view: "configured" } });

    expect(loadGatewayModelCatalogSnapshot.mock.calls).toEqual([
      [expect.objectContaining({ agentId: "worker", readOnly: true })],
      [expect.objectContaining({ agentId: "main", readOnly: false })],
    ]);
  });

  it("rejects a full-discovery snapshot from a different owner", async () => {
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
        catalogComplete: false,
        workspaceDir: "/tmp/models-list-main-workspace",
        config: replacementConfig,
        ...preparedOwnerFacts(replacementConfig),
        entries: [entry],
        routeVariants: [entry],
      })
      .mockResolvedValueOnce({
        agentId: "worker",
        agentDir: "/tmp/models-list-worker-agent",
        catalogComplete: true,
        workspaceDir: "/tmp/models-list-worker-workspace",
        config: replacementConfig,
        ...preparedOwnerFacts(replacementConfig),
        entries: [entry],
        routeVariants: [entry],
      });
    const context = {
      getRuntimeConfig: () => initialConfig,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    registerTestCatalogAccess(context);

    await expect(
      buildModelsListResult({ context, params: { view: "configured" } }),
    ).resolves.toEqual({ models: [] });
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
          workspaceDir: "/tmp/models-list-openai-workspace",
          config,
          ...preparedOwnerFacts(config),
          entries: [],
          routeVariants: [],
        }),
    );
    const context = {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    registerTestCatalogAccess(context);

    await expect(buildModelsListResult({ context, params: { view: "all" } })).resolves.toEqual({
      models: [],
    });
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", readOnly: false }),
    );
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
          ...preparedOwnerFacts(config),
          entries: [ownerlessEntry],
          routeVariants: [ownerlessEntry],
        }),
      ),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    registerTestCatalogAccess(context);

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
          ...preparedOwnerFacts(config),
          entries: [mainEntry],
          routeVariants: [mainEntry],
        }),
      ),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    registerTestCatalogAccess(context);

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
          ...preparedOwnerFacts(config),
          entries: [workerEntry],
          routeVariants: [workerEntry],
        }),
      ),
      logGateway: { debug: vi.fn() },
    } as unknown as GatewayRequestContext;
    registerTestCatalogAccess(context);

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
          agentRuntime: { ...IMPLICIT_OPENCLAW_RUNTIME, source: "model" },
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

  it("preserves provider-owned order in the public route-aware model list", async () => {
    const routeResolverFactory = vi.fn(() => () => ({
      kind: "indeterminate" as const,
      defaultRuntimeId: "codex",
    }));
    const catalog: ModelCatalogEntry[] = [
      { ...catalogEntry("gpt-5.4", "openai-responses"), providerOrder: 3 },
      { ...catalogEntry("gpt-5.6-luna", "openai-responses"), providerOrder: 2 },
      { ...catalogEntry("gpt-5.6-sol", "openai-responses"), providerOrder: 0 },
      { ...catalogEntry("gpt-5.6-terra", "openai-responses"), providerOrder: 1 },
    ];

    const result = await listModels({ catalog, routeResolverFactory });

    expect(result.models.map((entry) => entry.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.4",
    ]);
    expect(result.models.every((entry) => !("providerOrder" in entry))).toBe(true);
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
          expect.objectContaining({
            id: "gpt-5.4-nano",
            name: "GPT-5.4 Nano",
            provider: "openai",
            agentRuntime: IMPLICIT_OPENCLAW_RUNTIME,
            contextWindow: 1_000_000,
            reasoning: true,
            available: true,
          }),
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
          tags: ["default"],
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
          tags: ["default"],
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
              expect.objectContaining({
                id: "gpt-5.5",
                name: "gpt-5.5",
                provider: "openai",
                agentRuntime: IMPLICIT_CODEX_RUNTIME,
                available: true,
              }),
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
              expect.objectContaining({
                id: "gpt-5.5",
                name: "gpt-5.5",
                provider: "openai",
                agentRuntime: IMPLICIT_CODEX_RUNTIME,
                contextWindow: 400_000,
                reasoning: true,
                available: true,
              }),
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
              expect.objectContaining({
                id: "gpt-5.5",
                name: "GPT-5.5",
                provider: "openai",
                agentRuntime: IMPLICIT_CODEX_RUNTIME,
                contextWindow: 400_000,
                reasoning: true,
                input: ["text", "video"],
                available: true,
              }),
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
              expect.objectContaining({
                id: "gpt-5.5",
                name: "gpt-5.5",
                provider: "openai",
                agentRuntime: IMPLICIT_CODEX_RUNTIME,
                contextWindow: 1_000_000,
                reasoning: true,
                available: true,
              }),
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
            tags: ["default"],
          },
        ],
      });
    });
  });

  it("includes runtime-discovered rows for configured providers without explicit models", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      const cfg = {
        models: {
          providers: {
            litellm: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:14004",
            },
          },
        },
      } as unknown as OpenClawConfig;

      await expect(
        listModels({
          cfg,
          discoveryModes: { litellm: "runtime" },
          view: "provider-config",
          catalog: [
            providerCatalogEntry("litellm", "model-a"),
            providerCatalogEntry("litellm", "model-b"),
          ],
        }),
      ).resolves.toEqual({
        models: [
          expect.objectContaining({ id: "model-a", provider: "litellm" }),
          expect.objectContaining({ id: "model-b", provider: "litellm" }),
        ],
      });
    });
  });

  it("does not infer runtime inventory for static providers without explicit models", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      const cfg = {
        models: {
          providers: {
            kimi: {
              api: "openai-completions",
              baseUrl: "https://api.kimi.com/coding/v1",
            },
          },
        },
      } as unknown as OpenClawConfig;

      await expect(
        listModels({
          cfg,
          discoveryModes: { kimi: "static" },
          view: "provider-config",
          catalog: [providerCatalogEntry("kimi", "kimi-for-coding")],
        }),
      ).resolves.toEqual({ models: [] });
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
            tags: ["fallback#1"],
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
            tags: ["fallback#1", "configured"],
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
            agentRuntime: MODEL_CODEX_RUNTIME,
          }),
        );
      },
    );
  });
});
