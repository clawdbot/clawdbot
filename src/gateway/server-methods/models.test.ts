// Models method tests cover slow catalog timeouts, configured/all views,
// validation errors, and protocol response shapes.
import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDeferred } from "../test-helpers.deferred.js";
import { expectGatewayErrorResponse } from "./gateway-response.test-helpers.js";
import { modelsHandlers } from "./models.js";
import type { RespondFn } from "./types.js";

function requestModelsList(params: {
  view: "configured" | "all";
  respond?: ReturnType<typeof vi.fn>;
  runtimeConfig?: OpenClawConfig;
  loadGatewayModelCatalog: () => Promise<Array<Record<string, unknown>>>;
  reqId?: string;
}) {
  const respond = params.respond ?? vi.fn();
  const request = modelsHandlers["models.list"]({
    req: {
      type: "req",
      id: params.reqId ?? `req-models-list-${params.view}`,
      method: "models.list",
      params: { view: params.view },
    },
    params: { view: params.view },
    respond: respond as RespondFn,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => params.runtimeConfig ?? ({} as OpenClawConfig),
      loadGatewayModelCatalog: params.loadGatewayModelCatalog,
      logGateway: {
        debug: vi.fn(),
      },
    } as never,
  });
  return { request, respond };
}

describe("models.list", () => {
  it("does not block the configured view on slow model catalog discovery", async () => {
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

  it("keeps SecretRef configured fallback rows unknown when catalog discovery times out", async () => {
    const catalog = createDeferred<never>();
    const loadGatewayModelCatalog = vi.fn(() => catalog.promise);
    const runtimeConfig = {
      models: {
        providers: {
          vllm: {
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
        { models: [{ id: "gpt-test", name: "GPT Test", provider: "openai", available: false }] },
        undefined,
      );
      expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ readOnly: false });
    } finally {
      vi.useRealTimers();
    }
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
      { models: [{ id: "qwen-local", name: "Qwen Local", provider: "vllm", available: false }] },
      undefined,
    );
  });

  it("loads the full catalog for provider-scoped configured view and filters only providers", async () => {
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
          openai: { apiKey: "test-key" },
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
          { id: "gpt-5.4-codex", name: "GPT-5.4 Codex", provider: "openai", available: true },
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
          { id: "claude-test", name: "Claude Test", provider: "anthropic", available: false },
          { id: "gpt-5.4-codex", name: "GPT-5.4 Codex", provider: "openai", available: true },
          { id: "gpt-codex-test", name: "GPT Codex Test", provider: "openai", available: true },
          { id: "llama-local", name: "Llama Local", provider: "vllm", available: true },
          { id: "qwen-local", name: "Qwen Local", provider: "vllm", available: true },
        ],
      },
      undefined,
    );
  });

  it("marks legacy OpenAI Codex aliases available through ChatGPT OAuth", async () => {
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
                id: "gpt-5.4-codex",
                name: "GPT-5.4 Codex",
                provider: "openai",
                api: "openai-responses",
                available: true,
              },
            ],
          },
          undefined,
        );
      },
    );
  });

  it("marks file SecretRef provider unavailable when read-only auth cannot prove availability", async () => {
    const catalog = [{ id: "llama-secure", name: "Llama Secure", provider: "vllm" }];
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

  it("marks managed SecretRef provider unavailable when read-only auth cannot prove availability", async () => {
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

  it("does not mark catalog rows available from expired OAuth profiles", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-models-list-expired-profile-",
        agentEnv: "main",
      },
      async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "demo-provider:expired": {
              type: "oauth",
              provider: "demo-provider",
              access: "expired-access",
              refresh: "refresh-token",
              expires: Date.now() - 60_000,
            },
          },
        });

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
