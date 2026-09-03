// Control UI tests cover models behavior.
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  peekChatMetadata,
  loadChatMetadata,
  beginChatMetadataPublication,
  subscribeChatMetadata,
} from "./chat/chat-metadata-store.ts";
import { invalidateModelCatalogCache, loadModelCatalog } from "./model-catalog-store.ts";

const loadModels = async (...args: Parameters<typeof loadModelCatalog>) =>
  (await loadModelCatalog(...args)).models;

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

  it("revalidates existing metadata after explicit account-model discovery", async () => {
    const prepared = [{ id: "prepared", name: "Prepared", provider: "openai" }];
    const discovered = [
      ...prepared,
      { id: "discovered", name: "Discovered", provider: "openai", contextWindow: 262_144 },
    ];
    const request = vi.fn(async (method: string) => ({
      models: discovered,
      ...(method === "chat.metadata" ? { commands: [] } : {}),
    }));
    const client = { request } as unknown as GatewayBrowserClient;
    beginChatMetadataPublication(client, { agentId: "main" }).publish({
      commands: [],
      models: prepared,
    });
    const listener = vi.fn((update: { type: string }) => {
      if (update.type === "invalidated") {
        void loadChatMetadata(client, { agentId: "main" });
      }
    });
    const unsubscribe = subscribeChatMetadata(client, { agentId: "main" }, listener);

    await loadModels(client, { agentId: "main" });

    await vi.waitFor(() =>
      expect(peekChatMetadata(client, { agentId: "main" })?.models).toEqual(discovered),
    );
    expect(request).toHaveBeenCalledWith("chat.metadata", { agentId: "main" });
    expect(listener.mock.calls.filter(([update]) => update.type === "result")).toHaveLength(1);
    unsubscribe();
  });

  it("does not revalidate metadata for automatic prepared-only catalog reads", async () => {
    const models = [{ id: "prepared", name: "Prepared", provider: "openai" }];
    const request = vi.fn(async () => ({ models }));
    const client = { request } as unknown as GatewayBrowserClient;
    beginChatMetadataPublication(client, { agentId: "main" }).publish({ commands: [], models });

    await loadModels(client, { agentId: "main", preparedOnly: true });

    expect(request).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalledWith("chat.metadata", expect.anything());
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

  it("keeps a Models refresh visible when route re-entry uses a prepared read", async () => {
    const prepared = [{ id: "prepared", name: "Prepared", provider: "openai" }];
    const exact = [{ id: "exact", name: "Exact", provider: "openai" }];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: prepared })
      .mockResolvedValueOnce({ models: exact });
    const client = { request } as unknown as GatewayBrowserClient;

    expect(await loadModels(client, { agentId: "main", preparedOnly: true })).toEqual(prepared);
    expect(await loadModels(client, { agentId: "main", refresh: true })).toEqual(exact);
    expect(await loadModels(client, { agentId: "main", preparedOnly: true })).toEqual(exact);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps a late stale response from clobbering a fresher refresh result", async () => {
    const stale = [{ id: "stale", name: "Stale", provider: "openai" }];
    const fresh = [{ id: "fresh", name: "Fresh", provider: "openai" }];
    let releaseStale: (() => void) | undefined;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    const request = vi
      .fn()
      .mockImplementationOnce(async () => {
        await staleGate;
        return { models: stale };
      })
      .mockImplementationOnce(async () => ({ models: fresh }));
    const client = { request } as unknown as GatewayBrowserClient;

    const stalePromise = loadModels(client, { agentId: "main" });
    const freshModels = await loadModels(client, { agentId: "main", refresh: true });
    releaseStale?.();
    await stalePromise;

    expect(freshModels).toEqual(fresh);
    expect(await loadModels(client, { agentId: "main" })).toEqual(fresh);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes without reusing a completed refresh", async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const request = vi.fn(async () => {
      await refreshGate;
      return { models: [{ id: "fresh", name: "Fresh", provider: "openai" }] };
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const first = loadModels(client, { agentId: "writer", refresh: true });
    const concurrent = loadModels(client, { agentId: "writer", refresh: true });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    releaseRefresh?.();
    expect(await concurrent).toBe(await first);

    await loadModels(client, { agentId: "writer", refresh: true });

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps a shared refresh alive until its final subscriber aborts", async () => {
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn(
      async (_method: string, _params: unknown, options?: { signal?: AbortSignal }) => {
        const signal = options?.signal;
        if (!signal) {
          throw new Error("expected a cancellable model-catalog request");
        }
        requestSignal = signal;
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException("model catalog request aborted", "AbortError"),
              ),
            { once: true },
          );
        });
      },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const firstReason = new DOMException("first page retired", "AbortError");
    const secondReason = new DOMException("last page retired", "AbortError");

    const first = loadModels(client, {
      agentId: "writer",
      refresh: true,
      signal: firstAbort.signal,
    });
    const second = loadModels(client, {
      agentId: "writer",
      refresh: true,
      signal: secondAbort.signal,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    firstAbort.abort(firstReason);
    await expect(first).rejects.toBe(firstReason);
    expect(requestSignal?.aborted).toBe(false);

    secondAbort.abort(secondReason);
    await expect(second).rejects.toBe(secondReason);
    expect(requestSignal?.aborted).toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "explicit refresh", refresh: { refresh: true } },
    { label: "picker refresh", refresh: { refreshIfDue: true } },
  ])(
    "starts a replacement $label when the retired request is already aborted",
    async (testCase) => {
      const fresh = [{ id: "fresh", name: "Fresh", provider: "openai" }];
      let requestCount = 0;
      const request = vi.fn(
        (_method: string, _params: unknown, options?: { signal?: AbortSignal }) => {
          const signal = options?.signal;
          if (!signal) {
            throw new Error("expected a cancellable model-catalog request");
          }
          requestCount += 1;
          if (requestCount > 1) {
            return Promise.resolve({ models: fresh });
          }
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () =>
                reject(
                  signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException("model catalog request aborted", "AbortError"),
                ),
              { once: true },
            );
          });
        },
      );
      const client = { request } as unknown as GatewayBrowserClient;
      const retired = new AbortController();
      const replacementTask = new AbortController();
      const reason = new DOMException("page retired", "AbortError");
      const first = loadModels(client, {
        agentId: "writer",
        ...testCase.refresh,
        signal: retired.signal,
      });
      const firstResult = first.catch((error: unknown) => error);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

      retired.abort(reason);
      const replacement = loadModels(client, {
        agentId: "writer",
        ...testCase.refresh,
        signal: replacementTask.signal,
      });

      expect(await firstResult).toBe(reason);
      await expect(replacement).resolves.toEqual(fresh);
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("joins an active picker refresh instead of returning the cooldown cache", async () => {
    const initial = [{ id: "initial", name: "Initial", provider: "openai" }];
    const refreshed = [{ id: "refreshed", name: "Refreshed", provider: "openai" }];
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: initial })
      .mockImplementationOnce(async () => {
        await refreshGate;
        return { models: refreshed };
      });
    const client = { request } as unknown as GatewayBrowserClient;

    expect(await loadModels(client, { agentId: "main" })).toEqual(initial);
    const first = loadModels(client, { agentId: "main", refreshIfDue: true });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const concurrent = loadModels(client, { agentId: "main", refreshIfDue: true });
    releaseRefresh?.();

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

  it("retires a picker catalog when its logical Gateway connection changes", async () => {
    const beforeReconnect = [{ id: "before", name: "Before", provider: "openai" }];
    const afterReconnect = [{ id: "after", name: "After", provider: "openai" }];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ models: beforeReconnect })
      .mockResolvedValueOnce({ models: afterReconnect });
    const client = { request } as unknown as GatewayBrowserClient;

    expect(await loadModels(client, { agentId: "main", refreshIfDue: true })).toEqual(
      beforeReconnect,
    );

    invalidateModelCatalogCache(client);

    expect(await loadModels(client, { agentId: "main", refreshIfDue: true })).toEqual(
      afterReconnect,
    );
    expect(request).toHaveBeenCalledTimes(2);
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
