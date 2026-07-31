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

    const models = await loadModels({ request } as unknown as GatewayBrowserClient);

    expect(request).toHaveBeenCalledWith("models.list", { view: "configured" });
    expect(models).toEqual([
      { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", provider: "minimax" },
    ]);
  });

  it("reuses the configured model list while the cache is fresh", async () => {
    const request = vi.fn(async () => ({
      models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }],
    }));
    const client = { request } as unknown as GatewayBrowserClient;

    const first = await loadModels(client);
    const second = await loadModels(client);

    expect(request).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
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

    const stalePromise = loadModels(client);
    const freshModels = await loadModels(client, { refresh: true });
    releaseStale?.();
    await stalePromise;

    expect(freshModels).toEqual(fresh);
    expect(await loadModels(client)).toEqual(fresh);
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
