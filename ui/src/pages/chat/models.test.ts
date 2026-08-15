// Control UI tests cover models behavior.
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { applyModelCatalogResult, loadModels } from "./models.ts";

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
});

describe("applyModelCatalogResult", () => {
  it("preserves availability from metadata results", () => {
    expect(
      applyModelCatalogResult([
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          available: true,
        },
        {
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          provider: "codex",
          available: false,
        },
      ]),
    ).toEqual([
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "openai",
        available: true,
      },
      {
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        provider: "codex",
        available: false,
      },
    ]);
  });
});
