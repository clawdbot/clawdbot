import { gatewayStartupUnavailableDetails } from "@openclaw/gateway-client/browser";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadModels, revalidateModels } from "./model-catalog-store.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function deferredCatalog(models: Awaited<ReturnType<typeof loadModels>>) {
  const gate = deferred();
  return {
    release: gate.resolve,
    reject: gate.reject,
    response: gate.promise.then(() => ({ models })),
  };
}

describe("loadModels", () => {
  it("requests the configured model list view", async () => {
    const request = vi.fn(async () => ({
      models: [
        { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", provider: "minimax" },
      ],
    }));

    const models = await loadModels({ request } as unknown as GatewayBrowserClient, {
      agentId: "main",
    });

    expect(request).toHaveBeenCalledWith("models.list", {
      view: "configured",
      agentId: "main",
    });
    expect(models).toEqual([
      { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", provider: "minimax" },
    ]);
  });

  it("requests only the prepared catalog for automatic reads", async () => {
    const request = vi.fn(async () => ({ models: [] }));

    await loadModels({ request } as unknown as GatewayBrowserClient, {
      agentId: "main",
      preparedOnly: true,
    });

    expect(request).toHaveBeenCalledWith("models.list", {
      view: "configured",
      agentId: "main",
      preparedOnly: true,
    });
  });

  it("keeps startup revalidation pending until runtime discovery publishes", async () => {
    const pending = Object.assign(new Error("runtime discovery pending"), {
      code: "UNAVAILABLE",
      details: gatewayStartupUnavailableDetails(),
      retryAfterMs: 100,
      retryable: true,
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(pending)
      .mockResolvedValueOnce({
        models: [{ id: "runtime", name: "Runtime", provider: "omniroute" }],
      });
    const client = { request } as unknown as GatewayBrowserClient;

    await expect(
      revalidateModels(client, {
        agentId: "main",
        preparedOnly: true,
        waitForRuntimeDiscovery: true,
        startupRetryWindowMs: 1_000,
      }),
    ).resolves.toEqual([{ id: "runtime", name: "Runtime", provider: "omniroute" }]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "models.list",
      {
        view: "configured",
        agentId: "main",
        preparedOnly: true,
        waitForRuntimeDiscovery: true,
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "models.list",
      {
        view: "configured",
        agentId: "main",
        preparedOnly: true,
        waitForRuntimeDiscovery: true,
      },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("reuses the configured model list while the cache is fresh", async () => {
    const request = vi.fn(async () => ({
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
    }));
    const client = { request } as unknown as GatewayBrowserClient;

    const first = await loadModels(client, { agentId: "main" });
    const second = await loadModels(client, { agentId: "main" });

    expect(request).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("revalidates cached models without forcing a Gateway catalog rebuild", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        models: [{ id: "cached", name: "Cached", provider: "openai" }],
      })
      .mockResolvedValueOnce({
        models: [{ id: "revalidated", name: "Revalidated", provider: "openai" }],
      });
    const client = { request } as unknown as GatewayBrowserClient;

    await loadModels(client, { agentId: "main" });
    await expect(revalidateModels(client, { agentId: "main" })).resolves.toEqual([
      { id: "revalidated", name: "Revalidated", provider: "openai" },
    ]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, "models.list", {
      view: "configured",
      agentId: "main",
    });
  });

  it("keeps model catalogs scoped by agent", async () => {
    const request = vi.fn(async (_method: string, params: { agentId?: string }) => ({
      models: [
        {
          id: params.agentId ?? "default-model",
          name: params.agentId ?? "Default Model",
          provider: "openai",
        },
      ],
    }));
    const client = { request } as unknown as GatewayBrowserClient;

    const writer = await loadModels(client, { agentId: "writer" });
    const reviewer = await loadModels(client, { agentId: "reviewer" });
    await loadModels(client, { agentId: "writer" });

    expect(writer[0]?.id).toBe("writer");
    expect(reviewer[0]?.id).toBe("reviewer");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("models.list", {
      view: "configured",
      agentId: "writer",
    });
  });

  it("keeps a Models refresh visible when a prepared read revalidates", async () => {
    const prepared = [{ id: "prepared", name: "Prepared", provider: "openai" }];
    const exact = [{ id: "exact", name: "Exact", provider: "openai" }];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: prepared })
      .mockResolvedValueOnce({ models: exact })
      .mockResolvedValueOnce({ models: prepared });
    const client = { request } as unknown as GatewayBrowserClient;

    expect(await loadModels(client, { agentId: "main", preparedOnly: true })).toEqual(prepared);
    expect(await loadModels(client, { agentId: "main", refresh: true })).toEqual(exact);
    expect(await revalidateModels(client, { agentId: "main", preparedOnly: true })).toEqual(exact);
    expect(await loadModels(client, { agentId: "main", preparedOnly: true })).toEqual(exact);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("lets a readiness-confirmed prepared catalog replace an older exact cache", async () => {
    const exact = [{ id: "exact", name: "Exact", provider: "openai" }];
    const runtime = [{ id: "runtime", name: "Runtime", provider: "omniroute" }];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: exact })
      .mockResolvedValueOnce({ models: runtime });
    const client = { request } as unknown as GatewayBrowserClient;

    expect(await loadModels(client, { agentId: "main" })).toEqual(exact);
    await expect(
      revalidateModels(client, {
        agentId: "main",
        preparedOnly: true,
        waitForRuntimeDiscovery: true,
      }),
    ).resolves.toEqual(runtime);
    expect(await loadModels(client, { agentId: "main", preparedOnly: true })).toEqual(runtime);
  });

  it("keeps a late readiness-confirmed response authoritative over a newer exact refresh", async () => {
    const stale = [{ id: "runtime-old", name: "Runtime Old", provider: "omniroute" }];
    const exact = [{ id: "runtime-new", name: "Runtime New", provider: "omniroute" }];
    const staleCatalog = deferredCatalog(stale);
    const request = vi
      .fn()
      .mockReturnValueOnce(staleCatalog.response)
      .mockResolvedValueOnce({ models: exact });
    const client = { request } as unknown as GatewayBrowserClient;

    const stalePromise = revalidateModels(client, {
      agentId: "main",
      preparedOnly: true,
      waitForRuntimeDiscovery: true,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(await loadModels(client, { agentId: "main", refresh: true })).toEqual(exact);
    staleCatalog.release();

    await expect(stalePromise).resolves.toEqual(stale);
    expect(await loadModels(client, { agentId: "main", preparedOnly: true })).toEqual(stale);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps newer readiness-confirmed data over an older exact response", async () => {
    const exact = [{ id: "exact-old", name: "Exact Old", provider: "omniroute" }];
    const ready = [{ id: "runtime-ready", name: "Runtime Ready", provider: "omniroute" }];
    const exactCatalog = deferredCatalog(exact);
    const request = vi
      .fn()
      .mockReturnValueOnce(exactCatalog.response)
      .mockResolvedValueOnce({ models: ready });
    const client = { request } as unknown as GatewayBrowserClient;

    const exactPromise = loadModels(client, { agentId: "main", refresh: true });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await expect(
      revalidateModels(client, {
        agentId: "main",
        preparedOnly: true,
        waitForRuntimeDiscovery: true,
      }),
    ).resolves.toEqual(ready);
    exactCatalog.release();
    await exactPromise;

    expect(await loadModels(client, { agentId: "main", preparedOnly: true })).toEqual(ready);
  });

  it("keeps readiness-confirmed data over a later ordinary prepared read", async () => {
    const ready = [{ id: "runtime-ready", name: "Runtime Ready", provider: "omniroute" }];
    const ordinary = [{ id: "static", name: "Static", provider: "omniroute" }];
    const readyCatalog = deferredCatalog(ready);
    const request = vi
      .fn()
      .mockReturnValueOnce(readyCatalog.response)
      .mockResolvedValueOnce({ models: ordinary });
    const client = { request } as unknown as GatewayBrowserClient;

    const readyPromise = revalidateModels(client, {
      agentId: "main",
      preparedOnly: true,
      waitForRuntimeDiscovery: true,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await loadModels(client, { agentId: "main", preparedOnly: true });
    readyCatalog.release();

    await expect(readyPromise).resolves.toEqual(ready);
    expect(await loadModels(client, { agentId: "main", preparedOnly: true })).toEqual(ready);
  });

  it.each([true, false])(
    "does not rescue failed readiness with an ordinary exact read (exact first: %s)",
    async (exactFirst) => {
      const exact = [{ id: "exact", name: "Exact", provider: "omniroute" }];
      const readyCatalog = deferredCatalog([]);
      const exactCatalog = deferredCatalog(exact);
      const request = vi
        .fn()
        .mockReturnValueOnce(readyCatalog.response)
        .mockReturnValueOnce(exactCatalog.response);
      const client = { request } as unknown as GatewayBrowserClient;

      const readinessPromise = revalidateModels(client, {
        agentId: "main",
        preparedOnly: true,
        waitForRuntimeDiscovery: true,
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      const exactPromise = loadModels(client, { agentId: "main", refresh: true });
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

      const settleReadiness = () => readyCatalog.reject(new Error("runtime discovery failed"));
      const settleExact = () => exactCatalog.release();
      if (exactFirst) {
        settleExact();
        await expect(exactPromise).resolves.toEqual(exact);
        settleReadiness();
      } else {
        settleReadiness();
        await expect(readinessPromise).rejects.toThrow("runtime discovery failed");
        settleExact();
      }

      await expect(readinessPromise).rejects.toThrow("runtime discovery failed");
      await expect(exactPromise).resolves.toEqual(exact);
    },
  );

  it("keeps a late stale response from clobbering a fresher refresh result", async () => {
    const stale = [{ id: "stale", name: "Stale", provider: "openai" }];
    const fresh = [{ id: "fresh", name: "Fresh", provider: "openai" }];
    const staleCatalog = deferredCatalog(stale);
    const request = vi
      .fn()
      .mockReturnValueOnce(staleCatalog.response)
      .mockImplementationOnce(async () => ({ models: fresh }));
    const client = { request } as unknown as GatewayBrowserClient;

    const stalePromise = loadModels(client, { agentId: "main" });
    const freshModels = await loadModels(client, { agentId: "main", refresh: true });
    staleCatalog.release();
    await stalePromise;

    expect(freshModels).toEqual(fresh);
    expect(await loadModels(client, { agentId: "main" })).toEqual(fresh);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes without reusing a completed refresh", async () => {
    const refreshCatalog = deferredCatalog([{ id: "fresh", name: "Fresh", provider: "openai" }]);
    const request = vi.fn(() => refreshCatalog.response);
    const client = { request } as unknown as GatewayBrowserClient;

    const first = loadModels(client, { agentId: "writer", refresh: true });
    const concurrent = loadModels(client, { agentId: "writer", refresh: true });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    refreshCatalog.release();
    expect(await concurrent).toBe(await first);

    await loadModels(client, { agentId: "writer", refresh: true });

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("joins an active picker refresh instead of returning the cooldown cache", async () => {
    const initial = [{ id: "initial", name: "Initial", provider: "openai" }];
    const refreshed = [{ id: "refreshed", name: "Refreshed", provider: "openai" }];
    const refreshCatalog = deferredCatalog(refreshed);
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: initial })
      .mockReturnValueOnce(refreshCatalog.response);
    const client = { request } as unknown as GatewayBrowserClient;

    expect(await loadModels(client, { agentId: "main" })).toEqual(initial);
    const first = loadModels(client, { agentId: "main", refreshIfDue: true });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const concurrent = loadModels(client, { agentId: "main", refreshIfDue: true });
    refreshCatalog.release();

    expect(await concurrent).toBe(await first);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refreshes an account catalog once per picker cooldown", async () => {
    const initial = [{ id: "initial", name: "Initial", provider: "openai" }];
    const refreshed = [{ id: "refreshed", name: "Refreshed", provider: "openai" }];
    const later = [{ id: "later", name: "Later", provider: "openai" }];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: initial })
      .mockResolvedValueOnce({ models: refreshed })
      .mockResolvedValueOnce({ models: later });
    const client = { request } as unknown as GatewayBrowserClient;
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);

    try {
      expect(await loadModels(client, { agentId: "main" })).toEqual(initial);
      expect(await loadModels(client, { agentId: "main", refreshIfDue: true })).toEqual(refreshed);
      expect(await loadModels(client, { agentId: "main", refreshIfDue: true })).toEqual(refreshed);
      expect(request).toHaveBeenCalledTimes(2);

      now.mockReturnValue(1_000 + 60_000 + 1);
      expect(await loadModels(client, { agentId: "main", refreshIfDue: true })).toEqual(refreshed);
      expect(request).toHaveBeenCalledTimes(2);

      now.mockReturnValue(1_000 + 5 * 60_000 + 1);
      expect(await loadModels(client, { agentId: "main", refreshIfDue: true })).toEqual(later);
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls.slice(1).map((call) => call[1])).toEqual([
        { view: "configured", agentId: "main", refresh: true },
        { view: "configured", agentId: "main", refresh: true },
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("keeps a failed account catalog refresh retryable", async () => {
    const initial = [{ id: "initial", name: "Initial", provider: "openai" }];
    const recovered = [{ id: "recovered", name: "Recovered", provider: "openai" }];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: initial })
      .mockRejectedValueOnce(new Error("probe timed out"))
      .mockResolvedValueOnce({ models: recovered });
    const client = { request } as unknown as GatewayBrowserClient;

    expect(await loadModels(client, { agentId: "main" })).toEqual(initial);
    await expect(
      loadModels(client, { agentId: "main", refreshIfDue: true, rejectOnFailure: true }),
    ).rejects.toThrow("probe timed out");
    expect(await loadModels(client, { agentId: "main", refreshIfDue: true })).toEqual(recovered);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
