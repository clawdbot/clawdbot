import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusResult } from "../api/types.ts";
import { loadModelAuthStatus } from "./model-auth.ts";

const status = (ts: number): ModelAuthStatusResult => ({ ts, providers: [] });

describe("model auth status reads", () => {
  it("shares pending ordinary reads without retaining completed results", async () => {
    const first = createDeferred<ModelAuthStatusResult>();
    const request = vi.fn(() => first.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const one = loadModelAuthStatus(client, { agentId: "main" });
    const two = loadModelAuthStatus(client, { agentId: "main" });

    first.resolve(status(1));
    expect(await Promise.all([one, two])).toEqual([status(1), status(1)]);
    expect(request).toHaveBeenCalledExactlyOnceWith("models.authStatus", { agentId: "main" });

    request.mockResolvedValueOnce(status(2));
    expect(await loadModelAuthStatus(client, { agentId: "main" })).toEqual(status(2));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent reads separate across agents and clients", async () => {
    const request = vi.fn(async (_method: string, params: { agentId: string }) =>
      status(params.agentId === "main" ? 1 : 2),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const otherRequest = vi.fn(async () => status(3));
    const otherClient = { request: otherRequest } as unknown as GatewayBrowserClient;

    expect(
      await Promise.all([
        loadModelAuthStatus(client, { agentId: "main" }),
        loadModelAuthStatus(client, { agentId: "work" }),
        loadModelAuthStatus(otherClient, { agentId: "main" }),
      ]),
    ).toEqual([status(1), status(2), status(3)]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(otherRequest).toHaveBeenCalledOnce();
  });

  it("keeps signal-bearing reads independent", async () => {
    const first = createDeferred<ModelAuthStatusResult>();
    const second = createDeferred<ModelAuthStatusResult>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const one = loadModelAuthStatus(client, { agentId: "main", signal: firstAbort.signal });
    const two = loadModelAuthStatus(client, { agentId: "main", signal: secondAbort.signal });

    first.resolve(status(1));
    second.resolve(status(2));
    expect(await Promise.all([one, two])).toEqual([status(1), status(2)]);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "models.authStatus",
      { agentId: "main" },
      { signal: firstAbort.signal },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "models.authStatus",
      { agentId: "main" },
      { signal: secondAbort.signal },
    );
  });

  it("does not let a cancellable read join or cancel an ordinary read", async () => {
    const pending = createDeferred<ModelAuthStatusResult>();
    const reason = new DOMException("consumer retired", "AbortError");
    const request = vi.fn(
      (_method: string, _params: unknown, options?: { signal?: AbortSignal }) => {
        const signal = options?.signal;
        if (!signal) {
          return pending.promise;
        }
        return new Promise<ModelAuthStatusResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(reason), { once: true });
        });
      },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const controller = new AbortController();
    const first = loadModelAuthStatus(client, { agentId: "main" });
    const cancellable = loadModelAuthStatus(client, {
      agentId: "main",
      signal: controller.signal,
    }).catch((error: unknown) => error);
    controller.abort(reason);
    expect(await cancellable).toBe(reason);
    const follower = loadModelAuthStatus(client, { agentId: "main" });
    pending.resolve(status(1));
    expect(await Promise.all([first, follower])).toEqual([status(1), status(1)]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not retain a failed ordinary read", async () => {
    const pending = createDeferred<ModelAuthStatusResult>();
    const request = vi.fn(() => pending.promise);
    const client = { request } as unknown as GatewayBrowserClient;
    const first = loadModelAuthStatus(client, { agentId: "main" }).catch((error: unknown) => error);
    const second = loadModelAuthStatus(client, { agentId: "main" }).catch(
      (error: unknown) => error,
    );
    const error = new Error("status unavailable");
    pending.reject(error);
    expect(await Promise.all([first, second])).toEqual([error, error]);
    expect(request).toHaveBeenCalledOnce();

    request.mockResolvedValueOnce(status(2));
    expect(await loadModelAuthStatus(client, { agentId: "main" })).toEqual(status(2));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"] as const)(
    "keeps explicit refreshes and reads during them independent through the last refresh %s",
    async (outcome) => {
      const old = createDeferred<ModelAuthStatusResult>();
      const refreshOne = createDeferred<ModelAuthStatusResult>();
      const refreshTwo = createDeferred<ModelAuthStatusResult>();
      const during = createDeferred<ModelAuthStatusResult>();
      let ordinary = old;
      let refreshCount = 0;
      const request = vi.fn((_method: string, params: { refresh?: boolean }) =>
        params.refresh
          ? (refreshCount++ === 0 ? refreshOne : refreshTwo).promise
          : ordinary.promise,
      );
      const client = { request } as unknown as GatewayBrowserClient;
      const before = loadModelAuthStatus(client, { agentId: "main" });
      const one = loadModelAuthStatus(client, { agentId: "main", refresh: true });
      const two = loadModelAuthStatus(client, { agentId: "main", refresh: true }).catch(
        (error: unknown) => error,
      );
      ordinary = during;
      const duringOne = loadModelAuthStatus(client, { agentId: "main" });
      refreshOne.resolve(status(2));
      expect(await one).toEqual(status(2));
      const duringTwo = loadModelAuthStatus(client, { agentId: "main" });
      old.resolve(status(1));
      during.resolve(status(3));
      expect(await before).toEqual(status(1));
      expect(await Promise.all([duringOne, duringTwo])).toEqual([status(3), status(3)]);
      expect(request).toHaveBeenCalledTimes(5);
      const failed = new Error("refresh failed");
      if (outcome === "success") {
        refreshTwo.resolve(status(4));
      } else {
        refreshTwo.reject(failed);
      }
      expect(await two).toEqual(outcome === "success" ? status(4) : failed);

      ordinary = createDeferred<ModelAuthStatusResult>();
      const afterOne = loadModelAuthStatus(client, { agentId: "main" });
      const afterTwo = loadModelAuthStatus(client, { agentId: "main" });
      ordinary.resolve(status(5));
      expect(await Promise.all([afterOne, afterTwo])).toEqual([status(5), status(5)]);
      expect(request).toHaveBeenCalledTimes(6);
    },
  );
});
