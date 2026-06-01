import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { expectGatewayErrorResponse } from "./gateway-response.test-helpers.js";
import { modelsHandlers } from "./models.js";
import type { RespondFn } from "./types.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

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

    vi.useFakeTimers();
    try {
      const { request, respond } = requestModelsList({
        view: "configured",
        runtimeConfig,
        loadGatewayModelCatalog,
        reqId: "req-models-list-slow-catalog",
      });

      await vi.advanceTimersByTimeAsync(800);
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "gpt-test",
              name: "GPT Test",
              provider: "openai",
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

  it("keeps the all view exact instead of timing out to a partial catalog", async () => {
    const catalog = createDeferred<[{ id: string; name: string; provider: string }]>();
    const loadGatewayModelCatalog = vi.fn(() => catalog.promise);

    vi.useFakeTimers();
    try {
      const { request, respond } = requestModelsList({
        view: "all",
        loadGatewayModelCatalog,
        reqId: "req-models-list-all-slow-catalog",
      });

      await vi.advanceTimersByTimeAsync(800);
      expect(respond).not.toHaveBeenCalled();

      catalog.resolve([{ id: "gpt-test", name: "GPT Test", provider: "openai" }]);
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        { models: [{ id: "gpt-test", name: "GPT Test", provider: "openai" }] },
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
      { models: [{ id: "qwen-local", name: "Qwen Local", provider: "vllm" }] },
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
          { id: "gpt-5.4-codex", name: "GPT-5.4 Codex", provider: "openai" },
          { id: "gpt-codex-test", name: "GPT Codex Test", provider: "openai" },
          { id: "llama-local", name: "Llama Local", provider: "vllm" },
          { id: "qwen-local", name: "Qwen Local", provider: "vllm" },
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

    expect(allRespond).toHaveBeenCalledWith(true, { models: catalog }, undefined);
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
