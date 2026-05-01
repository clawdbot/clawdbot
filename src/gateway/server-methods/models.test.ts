import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ErrorCodes } from "../protocol/index.js";
import { modelsHandlers } from "./models.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("models.list", () => {
  it("does not block the configured view on slow model catalog discovery", async () => {
    const catalog = createDeferred<never>();
    const respond = vi.fn();

    vi.useFakeTimers();
    try {
      const request = modelsHandlers["models.list"]({
        req: {
          type: "req",
          id: "req-models-list-slow-catalog",
          method: "models.list",
          params: { view: "configured" },
        },
        params: { view: "configured" },
        respond,
        client: null,
        isWebchatConnect: () => false,
        context: {
          getRuntimeConfig: () => {
            const config = {
              models: {
                providers: {
                  openai: {
                    baseUrl: "https://openai.example.com",
                    models: [{ id: "gpt-test", name: "GPT Test" }],
                  },
                },
              },
            };
            return config as unknown as OpenClawConfig;
          },
          loadGatewayModelCatalog: vi.fn(() => catalog.promise),
          logGateway: {
            debug: vi.fn(),
          },
        } as never,
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the all view exact instead of timing out to a partial catalog", async () => {
    const catalog = createDeferred<[{ id: string; name: string; provider: string }]>();
    const respond = vi.fn();

    vi.useFakeTimers();
    try {
      const request = modelsHandlers["models.list"]({
        req: {
          type: "req",
          id: "req-models-list-all-slow-catalog",
          method: "models.list",
          params: { view: "all" },
        },
        params: { view: "all" },
        respond,
        client: null,
        isWebchatConnect: () => false,
        context: {
          getRuntimeConfig: () => ({}) as OpenClawConfig,
          loadGatewayModelCatalog: vi.fn(() => catalog.promise),
          logGateway: {
            debug: vi.fn(),
          },
        } as never,
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
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves catalog load errors before the timeout fallback wins", async () => {
    const respond = vi.fn();

    await modelsHandlers["models.list"]({
      req: {
        type: "req",
        id: "req-models-list-catalog-error",
        method: "models.list",
        params: { view: "configured" },
      },
      params: { view: "configured" },
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig: () => ({}) as OpenClawConfig,
        loadGatewayModelCatalog: vi.fn(() => Promise.reject(new Error("catalog failed"))),
        logGateway: {
          debug: vi.fn(),
        },
      } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: "Error: catalog failed",
      }),
    );
  });
});
