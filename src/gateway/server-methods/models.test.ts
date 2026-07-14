// Models method tests cover slow catalog timeouts, configured/all views,
// validation errors, and protocol response shapes.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferred } from "../../test-utils/deferred.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { expectGatewayErrorResponse } from "./gateway-response.test-helpers.js";
import { modelsHandlers } from "./models.js";
import type { RespondFn } from "./types.js";

const withoutOpenAIEnvAuth = async <T>(run: () => Promise<T>): Promise<T> =>
  await withEnvAsync(
    {
      CODEX_API_KEY: undefined,
      CODEX_HOME: "/__openclaw_models_list_test__/codex",
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
      OPENAI_OAUTH_TOKEN: undefined,
      CHATGPT_OAUTH_TOKEN: undefined,
    },
    run,
  );

function createDemoOAuthStore(params: { access: string; expires: number }) {
  return {
    version: 1 as const,
    profiles: {
      "demo-provider:oauth": {
        type: "oauth" as const,
        provider: "demo-provider",
        access: params.access,
        refresh: "refresh-token",
        expires: params.expires,
      },
    },
  };
}

function requestModelsList(params: {
  view: "default" | "configured" | "provider-config" | "all";
  respond?: ReturnType<typeof vi.fn>;
  runtimeConfig?: OpenClawConfig;
  loadGatewayModelCatalog: (params?: {
    readOnly?: boolean;
  }) => Promise<Array<Record<string, unknown>>>;
  reqId?: string;
  includeProviderCapabilities?: boolean;
}) {
  const respond = params.respond ?? vi.fn();
  const request = expectDefined(
    modelsHandlers["models.list"],
    'modelsHandlers["models.list"] test invariant',
  )({
    req: {
      type: "req",
      id: params.reqId ?? `req-models-list-${params.view}`,
      method: "models.list",
      params: {
        view: params.view,
        ...(params.includeProviderCapabilities ? { includeProviderCapabilities: true } : {}),
      },
    },
    params: {
      view: params.view,
      ...(params.includeProviderCapabilities ? { includeProviderCapabilities: true } : {}),
    },
    respond: respond as RespondFn,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => params.runtimeConfig ?? ({} as OpenClawConfig),
      loadGatewayModelCatalog: params.loadGatewayModelCatalog,
      loadGatewayModelCatalogSnapshot: async (
        loadParams: Parameters<typeof params.loadGatewayModelCatalog>[0],
      ) => {
        const entries = await params.loadGatewayModelCatalog(loadParams);
        return { entries, routeVariants: entries };
      },
      logGateway: {
        debug: vi.fn(),
      },
    } as never,
  });
  return { request, respond };
}

describe("models.list", () => {
  it("reports API-key capability from provider auth contracts when requested", async () => {
    const { request, respond } = requestModelsList({
      view: "all",
      includeProviderCapabilities: true,
      loadGatewayModelCatalog: vi.fn(() =>
        Promise.resolve([
          { id: "claude-test", name: "Claude Test", provider: "anthropic" },
          { id: "copilot-test", name: "Copilot Test", provider: "github-copilot" },
          { id: "byteplus-test", name: "BytePlus Plan Test", provider: "byteplus-plan" },
          { id: "custom-test", name: "Custom Test", provider: "custom-cloud" },
        ]),
      ),
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: expect.arrayContaining([
          expect.objectContaining({ provider: "anthropic", apiKeySupported: true }),
          expect.objectContaining({ provider: "github-copilot", apiKeySupported: false }),
          expect.objectContaining({ provider: "byteplus-plan", apiKeySupported: true }),
        ]),
      },
      undefined,
    );
    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<{ provider: string; apiKeySupported?: boolean }> }
      | undefined;
    const custom = payload?.models.find((model) => model.provider === "custom-cloud");
    expect(custom).toBeDefined();
    expect(custom).not.toHaveProperty("apiKeySupported");
  });

  it("keeps source-authored provider inventory when the canonical catalog is missing", async () => {
    const sourceProvider = {
      baseUrl: "https://vllm.example/v1",
      apiKey: {
        source: "file",
        provider: "mounted-json",
        id: "/providers/vllm/apiKey",
      },
      models: [
        {
          id: "source-model",
          name: "Source Model",
          contextWindow: 128_000,
          reasoning: true,
          input: ["text", "image"],
          params: { temperature: 0.2 },
          compat: { supportsDeveloperRole: false },
        },
      ],
    };
    const sourceConfig = {
      agents: {
        defaults: {
          models: {
            "vllm/allowlisted": {},
          },
        },
      },
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      models: {
        providers: {
          vllm: sourceProvider,
        },
      },
    } as unknown as OpenClawConfig;
    const runtimeConfig = {
      ...sourceConfig,
      models: {
        providers: {
          vllm: {
            ...sourceProvider,
            apiKey: "test-key",
            models: [{ id: "runtime-only", name: "Runtime Only" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const loadGatewayModelCatalog = vi.fn(() => Promise.resolve([]));
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    try {
      const { request, respond } = requestModelsList({
        view: "provider-config",
        runtimeConfig,
        loadGatewayModelCatalog,
        reqId: "req-models-list-provider-config-source",
      });
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "source-model",
              name: "Source Model",
              provider: "vllm",
              contextWindow: 128_000,
              reasoning: true,
              input: ["text", "image"],
              available: true,
            },
          ],
        },
        undefined,
      );
      expect(loadGatewayModelCatalog).toHaveBeenCalledExactlyOnceWith({ readOnly: true });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("omits unknown provider-config availability", async () => {
    const config = {
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            apiKey: {
              source: "file",
              provider: "mounted-json",
              id: "/providers/vllm/apiKey",
            },
            models: [
              {
                id: "llama-secure",
                name: "Llama Secure",
                input: ["text", "image", "document"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(config, config);
    try {
      const { request, respond } = requestModelsList({
        view: "provider-config",
        runtimeConfig: config,
        loadGatewayModelCatalog: vi.fn(() => Promise.resolve([])),
        reqId: "req-models-list-provider-config-unknown",
      });
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "llama-secure",
              name: "Llama Secure",
              provider: "vllm",
              input: ["text", "image", "document"],
            },
          ],
        },
        undefined,
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not block the configured view on slow model catalog discovery", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const catalog = createDeferred<never>();
      const loadGatewayModelCatalog = vi.fn(() => catalog.promise);
      const runtimeConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com",
              models: [{ id: "gpt-test", name: "GPT Test" }],
            },
          },
        },
      } as unknown as OpenClawConfig;

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { request, respond } = requestModelsList({
          view: "configured",
          runtimeConfig,
          loadGatewayModelCatalog,
          reqId: "req-models-list-slow-catalog",
        });

        await vi.advanceTimersByTimeAsync(800);
        await vi.runOnlyPendingTimersAsync();
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "gpt-test",
                name: "GPT Test",
                provider: "openai",
                available: false,
              },
            ],
          },
          undefined,
        );
        expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ readOnly: true });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("keeps SecretRef configured fallback rows unknown when catalog discovery times out", async () => {
    const catalog = createDeferred<never>();
    const loadGatewayModelCatalog = vi.fn(() => catalog.promise);
    const runtimeConfig = {
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            apiKey: {
              source: "file",
              provider: "mounted-json",
              id: "/providers/vllm/apiKey",
            },
            models: [{ id: "llama-secure", name: "Llama Secure" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { request, respond } = requestModelsList({
        view: "configured",
        runtimeConfig,
        loadGatewayModelCatalog,
        reqId: "req-models-list-secretref-timeout",
      });

      await vi.advanceTimersByTimeAsync(800);
      await vi.runOnlyPendingTimersAsync();
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "llama-secure",
              name: "Llama Secure",
              provider: "vllm",
              available: false,
            },
          ],
        },
        undefined,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the all view exact instead of timing out to a partial catalog", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const catalog = createDeferred<[{ id: string; name: string; provider: string }]>();
      const loadGatewayModelCatalog = vi.fn(() => catalog.promise);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { request, respond } = requestModelsList({
          view: "all",
          loadGatewayModelCatalog,
          reqId: "req-models-list-all-slow-catalog",
        });

        await vi.advanceTimersByTimeAsync(800);
        expect(respond).not.toHaveBeenCalled();

        catalog.resolve([{ id: "gpt-test", name: "GPT Test", provider: "openai" }]);
        await vi.runAllTimersAsync();
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [{ id: "gpt-test", name: "GPT Test", provider: "openai", available: false }],
          },
          undefined,
        );
        expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ readOnly: false });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("does not expose runtime params from catalog rows", async () => {
    const { request, respond } = requestModelsList({
      view: "all",
      loadGatewayModelCatalog: vi.fn(() =>
        Promise.resolve([
          {
            id: "qwen-local",
            name: "Qwen Local",
            provider: "vllm",
            params: { qwenThinkingFormat: "chat-template" },
          },
        ]),
      ),
      reqId: "req-models-list-redact-params",
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [{ id: "qwen-local", name: "Qwen Local", provider: "vllm", available: false }],
      },
      undefined,
    );
  });

  it("loads the full catalog for provider-scoped configured view and filters only providers", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const catalog = [
        { id: "claude-test", name: "Claude Test", provider: "anthropic" },
        { id: "gpt-5.4-codex", name: "GPT-5.4 Codex", provider: "openai" },
        { id: "gpt-codex-test", name: "GPT Codex Test", provider: "openai" },
        { id: "llama-local", name: "Llama Local", provider: "vllm" },
        { id: "qwen-local", name: "Qwen Local", provider: "vllm" },
      ];
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openai/*": {},
              "vllm/*": {},
            },
          },
        },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              apiKey: "test-key",
              baseUrl: "https://api.openai.com/v1",
            },
            vllm: { apiKey: "test-key" },
          },
        },
      } as unknown as OpenClawConfig;

      const loadConfiguredCatalog = vi.fn(() => Promise.resolve(catalog));
      const { request: configuredRequest, respond: configuredRespond } = requestModelsList({
        view: "configured",
        runtimeConfig: cfg,
        loadGatewayModelCatalog: loadConfiguredCatalog,
        reqId: "req-models-list-provider-allowlist",
      });
      await configuredRequest;

      expect(configuredRespond).toHaveBeenCalledWith(
        true,
        {
          models: [
            { id: "gpt-5.4", name: "GPT-5.4 Codex", provider: "openai", available: true },
            { id: "gpt-codex-test", name: "GPT Codex Test", provider: "openai", available: true },
            { id: "llama-local", name: "Llama Local", provider: "vllm", available: true },
            { id: "qwen-local", name: "Qwen Local", provider: "vllm", available: true },
          ],
        },
        undefined,
      );
      expect(loadConfiguredCatalog).toHaveBeenCalledWith({ readOnly: false });

      const { request: allRequest, respond: allRespond } = requestModelsList({
        view: "all",
        runtimeConfig: cfg,
        loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
        reqId: "req-models-list-provider-allowlist-all",
      });
      await allRequest;

      expect(allRespond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "claude-test",
              name: "Claude Test",
              provider: "anthropic",
              available: false,
            },
            { id: "gpt-5.4", name: "GPT-5.4 Codex", provider: "openai", available: true },
            { id: "gpt-codex-test", name: "GPT Codex Test", provider: "openai", available: true },
            { id: "llama-local", name: "Llama Local", provider: "vllm", available: true },
            { id: "qwen-local", name: "Qwen Local", provider: "vllm", available: true },
          ],
        },
        undefined,
      );
    });
  });

  it("keeps keyless local provider wildcard discoveries visible with unknown availability", async () => {
    await withoutOpenAIEnvAuth(async () => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-models-list-local-wildcard-",
          agentEnv: "main",
          env: { VLLM_API_KEY: undefined },
        },
        async () => {
          const catalog = [
            {
              id: "llama-configured",
              name: "Llama Configured",
              provider: "vllm",
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8000/v1",
            },
            {
              id: "llama-discovered",
              name: "Llama Discovered",
              provider: "vllm",
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8000/v1",
            },
          ];
          const cfg = {
            agents: { defaults: { models: { "vllm/*": {} } } },
            models: {
              providers: {
                vllm: {
                  api: "openai-completions",
                  baseUrl: "http://127.0.0.1:8000/v1",
                  models: [{ id: "llama-configured", name: "Llama Configured" }],
                },
              },
            },
          } as unknown as OpenClawConfig;
          const expected = {
            models: [
              {
                id: "llama-configured",
                name: "Llama Configured",
                provider: "vllm",
                available: true,
              },
              {
                id: "llama-discovered",
                name: "Llama Discovered",
                provider: "vllm",
                available: true,
              },
            ],
          };

          for (const view of ["default", "configured"] as const) {
            const { request, respond } = requestModelsList({
              view,
              runtimeConfig: cfg,
              loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
              reqId: `req-models-list-local-wildcard-${view}`,
            });
            await request;
            expect(respond).toHaveBeenCalledWith(true, expected, undefined);
          }
        },
      );
    });
  });

  it("marks legacy OpenAI Codex aliases available through ChatGPT OAuth", async () => {
    await withoutOpenAIEnvAuth(async () => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-models-list-codex-alias-",
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

          const { request, respond } = requestModelsList({
            view: "all",
            loadGatewayModelCatalog: vi.fn(() =>
              Promise.resolve([
                {
                  id: "gpt-5.4-codex",
                  name: "GPT-5.4 Codex",
                  provider: "openai",
                  api: "openai-responses",
                  baseUrl: "https://api.openai.com/v1",
                },
              ]),
            ),
            reqId: "req-models-list-codex-alias",
          });
          await request;

          expect(respond).toHaveBeenCalledWith(
            true,
            {
              models: [
                {
                  id: "gpt-5.4",
                  name: "GPT-5.4 Codex",
                  provider: "openai",
                  available: true,
                },
              ],
            },
            undefined,
          );
        },
      );
    });
  });

  it("marks catalog models available through their configured CLI runtime", async () => {
    await withEnvAsync({ ANTHROPIC_API_KEY: undefined }, async () => {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: "openclaw-models-list-cli-runtime-",
          agentEnv: "main",
        },
        async (state) => {
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "anthropic:claude-cli": {
                type: "oauth",
                provider: "claude-cli",
                access: "claude-cli-access",
                refresh: "claude-cli-refresh",
                expires: Date.now() + 30 * 60_000,
              },
            },
          });

          const runtimeConfig = {
            agents: {
              defaults: {
                models: {
                  "anthropic/claude-opus-4-8": {
                    agentRuntime: { id: "claude-cli" },
                  },
                },
              },
            },
          } as unknown as OpenClawConfig;
          const { request, respond } = requestModelsList({
            view: "all",
            runtimeConfig,
            loadGatewayModelCatalog: vi.fn(() =>
              Promise.resolve([
                {
                  id: "claude-opus-4-8",
                  name: "Claude Opus 4.8",
                  provider: "anthropic",
                },
              ]),
            ),
            reqId: "req-models-list-cli-runtime",
          });
          await request;

          expect(respond).toHaveBeenCalledWith(
            true,
            {
              models: [
                {
                  id: "claude-opus-4-8",
                  name: "Claude Opus 4.8",
                  provider: "anthropic",
                  available: true,
                },
              ],
            },
            undefined,
          );
        },
      );
    });
  });

  it("keeps file SecretRef provider availability unknown when read-only auth cannot resolve it", async () => {
    const catalog = [{ id: "llama-secure", name: "Llama Secure", provider: "vllm" }];
    const cfg = {
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      agents: {
        defaults: {
          models: {
            "vllm/*": {},
          },
        },
      },
      models: {
        providers: {
          vllm: {
            apiKey: {
              source: "file",
              provider: "mounted-json",
              id: "/providers/vllm/apiKey",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { request, respond } = requestModelsList({
      view: "all",
      runtimeConfig: cfg,
      loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
      reqId: "req-models-list-secretref-file",
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [{ id: "llama-secure", name: "Llama Secure", provider: "vllm", available: false }],
      },
      undefined,
    );
  });

  it("keeps managed SecretRef provider availability unknown without runtime proof", async () => {
    const catalog = [{ id: "llama-managed", name: "Llama Managed", provider: "vllm" }];
    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/*": {},
          },
        },
      },
      models: {
        providers: {
          vllm: {
            apiKey: "secretref-managed",
          },
        },
      },
    } as unknown as OpenClawConfig;

    const { request, respond } = requestModelsList({
      view: "all",
      runtimeConfig: cfg,
      loadGatewayModelCatalog: vi.fn(() => Promise.resolve(catalog)),
      reqId: "req-models-list-secretref-managed",
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [
          { id: "llama-managed", name: "Llama Managed", provider: "vllm", available: false },
        ],
      },
      undefined,
    );
  });

  it("uses an exact hydrated runtime snapshot as managed SecretRef proof", async () => {
    const sourceConfig: OpenClawConfig = {
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            apiKey: {
              source: "file",
              provider: "mounted-json",
              id: "/providers/vllm/apiKey",
            },
            models: [],
          },
        },
      },
    };
    const sourceProvider = expectDefined(
      sourceConfig.models?.providers?.vllm,
      "source vLLM provider",
    );
    const runtimeConfig: OpenClawConfig = {
      ...sourceConfig,
      models: {
        providers: {
          vllm: {
            ...sourceProvider,
            apiKey: "resolved-runtime-key",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    try {
      const { request, respond } = requestModelsList({
        view: "all",
        runtimeConfig: sourceConfig,
        loadGatewayModelCatalog: vi.fn(() =>
          Promise.resolve([{ id: "llama-secure", name: "Llama Secure", provider: "vllm" }]),
        ),
        reqId: "req-models-list-secretref-runtime-proof",
      });
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [{ id: "llama-secure", name: "Llama Secure", provider: "vllm", available: true }],
        },
        undefined,
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not mark catalog rows available from expired OAuth profiles", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-expired-profile-",
        agentEnv: "main",
      },
      async (state) => {
        await state.writeAuthProfiles(
          createDemoOAuthStore({
            access: "expired-access",
            expires: Date.now() - 60_000,
          }),
        );

        const { request, respond } = requestModelsList({
          view: "all",
          loadGatewayModelCatalog: vi.fn(() =>
            Promise.resolve([{ id: "demo-model", name: "Demo Model", provider: "demo-provider" }]),
          ),
          reqId: "req-models-list-expired-profile",
        });
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "demo-model",
                name: "Demo Model",
                provider: "demo-provider",
                available: false,
              },
            ],
          },
          undefined,
        );
      },
    );
  });

  it("uses refreshed persisted OAuth when the runtime auth snapshot is stale", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-stale-runtime-profile-",
        agentEnv: "main",
      },
      async (state) => {
        const agentDir = state.agentDir();
        await state.writeAuthProfiles(
          createDemoOAuthStore({
            access: "refreshed-access",
            expires: Date.now() + 60 * 60_000,
          }),
        );
        replaceRuntimeAuthProfileStoreSnapshots([
          {
            agentDir,
            store: createDemoOAuthStore({
              access: "expired-access",
              expires: Date.now() - 60_000,
            }),
          },
        ]);

        try {
          const { request, respond } = requestModelsList({
            view: "all",
            loadGatewayModelCatalog: vi.fn(() =>
              Promise.resolve([
                { id: "demo-model", name: "Demo Model", provider: "demo-provider" },
              ]),
            ),
            reqId: "req-models-list-stale-runtime-profile",
          });
          await request;

          expect(respond).toHaveBeenCalledWith(
            true,
            {
              models: [
                {
                  id: "demo-model",
                  name: "Demo Model",
                  provider: "demo-provider",
                  available: true,
                },
              ],
            },
            undefined,
          );
        } finally {
          clearRuntimeAuthProfileStoreSnapshots();
        }
      },
    );
  });

  it("marks env SecretRef-backed auth profiles available", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-env-profile-",
        agentEnv: "main",
        env: {
          DEMO_PROVIDER_TOKEN: "test-token",
        },
      },
      async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "demo-provider:env": {
              type: "token",
              provider: "demo-provider",
              tokenRef: {
                source: "env",
                provider: "default",
                id: "DEMO_PROVIDER_TOKEN",
              },
              expires: Date.now() + 60_000,
            },
          },
        });

        const { request, respond } = requestModelsList({
          view: "all",
          loadGatewayModelCatalog: vi.fn(() =>
            Promise.resolve([{ id: "demo-model", name: "Demo Model", provider: "demo-provider" }]),
          ),
          reqId: "req-models-list-env-profile",
        });
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "demo-model",
                name: "Demo Model",
                provider: "demo-provider",
                available: true,
              },
            ],
          },
          undefined,
        );
      },
    );
  });

  it("keeps non-env SecretRef-backed auth profile availability unknown", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-file-profile-",
        agentEnv: "main",
      },
      async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "demo-provider:file": {
              type: "token",
              provider: "demo-provider",
              tokenRef: {
                source: "file",
                provider: "mounted-json",
                id: "/providers/demo/token",
              },
              expires: Date.now() + 60_000,
            },
          },
        });

        const { request, respond } = requestModelsList({
          view: "all",
          runtimeConfig: {
            secrets: {
              providers: {
                "mounted-json": {
                  source: "file",
                  path: "/tmp/openclaw-test-secrets.json",
                  mode: "json",
                },
              },
            },
          } as OpenClawConfig,
          loadGatewayModelCatalog: vi.fn(() =>
            Promise.resolve([{ id: "demo-model", name: "Demo Model", provider: "demo-provider" }]),
          ),
          reqId: "req-models-list-file-profile",
        });
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "demo-model",
                name: "Demo Model",
                provider: "demo-provider",
                available: false,
              },
            ],
          },
          undefined,
        );
      },
    );
  });

  it("uses an exact hydrated runtime profile SecretRef as read-only proof", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-hydrated-file-profile-",
        agentEnv: "main",
      },
      async (state) => {
        const tokenRef = {
          source: "file" as const,
          provider: "mounted-json",
          id: "/providers/demo/token",
        };
        const persisted = {
          version: 1 as const,
          profiles: {
            "demo-provider:file": {
              type: "token" as const,
              provider: "demo-provider",
              tokenRef,
              expires: Date.now() + 10 * 60_000,
            },
          },
        };
        await state.writeAuthProfiles(persisted);
        replaceRuntimeAuthProfileStoreSnapshots([
          {
            agentDir: state.agentDir(),
            store: {
              ...persisted,
              profiles: {
                "demo-provider:file": {
                  ...persisted.profiles["demo-provider:file"],
                  token: "resolved-runtime-token",
                },
              },
            },
          },
        ]);
        try {
          const { request, respond } = requestModelsList({
            view: "all",
            runtimeConfig: {
              secrets: {
                providers: {
                  "mounted-json": {
                    source: "file",
                    path: "/tmp/openclaw-test-secrets.json",
                    mode: "json",
                  },
                },
              },
            } as OpenClawConfig,
            loadGatewayModelCatalog: vi.fn(() =>
              Promise.resolve([
                { id: "demo-model", name: "Demo Model", provider: "demo-provider" },
              ]),
            ),
            reqId: "req-models-list-hydrated-file-profile",
          });
          await request;

          expect(respond).toHaveBeenCalledWith(
            true,
            {
              models: [
                {
                  id: "demo-model",
                  name: "Demo Model",
                  provider: "demo-provider",
                  available: true,
                },
              ],
            },
            undefined,
          );
        } finally {
          clearRuntimeAuthProfileStoreSnapshots();
        }
      },
    );
  });

  it("marks auth profiles available even when provider config uses non-env SecretRef markers", async () => {
    for (const fixture of [
      {
        name: "file",
        apiKey: {
          source: "file",
          provider: "mounted-json",
          id: "/providers/vllm/apiKey",
        },
      },
      { name: "managed-marker", apiKey: "secretref-managed" },
    ] as const) {
      await withOpenClawTestState(
        {
          layout: "state-only",
          prefix: `openclaw-models-list-provider-${fixture.name}-profile-`,
          agentEnv: "main",
          env: {
            OPENCLAW_TEST_PROFILE_API_KEY: "test-token",
            VLLM_API_KEY: undefined,
          },
        },
        async (state) => {
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "vllm:env": {
                type: "api_key",
                provider: "vllm",
                keyRef: {
                  source: "env",
                  provider: "default",
                  id: "OPENCLAW_TEST_PROFILE_API_KEY",
                },
              },
            },
          });

          const cfg = {
            agents: {
              defaults: {
                models: {
                  "vllm/*": {},
                },
              },
            },
            models: {
              providers: {
                vllm: {
                  apiKey: fixture.apiKey,
                },
              },
            },
          } as unknown as OpenClawConfig;

          const { request, respond } = requestModelsList({
            view: "all",
            runtimeConfig: cfg,
            loadGatewayModelCatalog: vi.fn(() =>
              Promise.resolve([{ id: "llama-secure", name: "Llama Secure", provider: "vllm" }]),
            ),
            reqId: `req-models-list-provider-${fixture.name}-profile`,
          });
          await request;

          expect(respond).toHaveBeenCalledWith(
            true,
            {
              models: [
                {
                  id: "llama-secure",
                  name: "Llama Secure",
                  provider: "vllm",
                  available: true,
                },
              ],
            },
            undefined,
          );
        },
      );
    }
  });

  it("projects only public model fields", async () => {
    const { request, respond } = requestModelsList({
      view: "all",
      loadGatewayModelCatalog: vi.fn(() =>
        Promise.resolve([
          {
            id: "demo-model",
            name: "Demo Model",
            provider: "demo-provider",
            contextWindow: 0,
            reasoning: "yes",
            api: "openai-responses",
            baseUrl: "https://private.example.test/v1",
            authRequirement: "api-key",
            agentRuntime: { id: "private-runtime" },
            params: { private: true },
          },
        ]),
      ),
      reqId: "req-models-list-safe-public-projection",
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [
          {
            id: "demo-model",
            name: "Demo Model",
            provider: "demo-provider",
            available: false,
          },
        ],
      },
      undefined,
    );
  });

  it("does not reinterpret context tokens or expose model input metadata", async () => {
    const { request, respond } = requestModelsList({
      view: "all",
      loadGatewayModelCatalog: vi.fn(() =>
        Promise.resolve([
          {
            id: "vision-model",
            name: "Vision Model",
            provider: "demo-provider",
            contextWindow: 128_000,
            contextTokens: 96_000,
            input: ["text", "image", "private-runtime-capability", "image"],
          },
        ]),
      ),
      reqId: "req-models-list-public-capabilities",
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [
          {
            id: "vision-model",
            name: "Vision Model",
            provider: "demo-provider",
            available: false,
            contextWindow: 128_000,
          },
        ],
      },
      undefined,
    );
  });

  it("preserves catalog load errors before the timeout fallback wins", async () => {
    const { request, respond } = requestModelsList({
      view: "configured",
      loadGatewayModelCatalog: vi.fn(() => Promise.reject(new Error("catalog failed"))),
      reqId: "req-models-list-catalog-error",
    });
    await request;

    expectGatewayErrorResponse(respond, {
      code: ErrorCodes.UNAVAILABLE,
      message: "Error: catalog failed",
    });
  });
});
