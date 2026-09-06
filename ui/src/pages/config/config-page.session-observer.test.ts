/* @vitest-environment jsdom */

import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import * as modelCatalogStore from "../../lib/model-catalog-store.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { settleLitElement, settleLitElements } from "../../test-helpers/lit-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ConfigPage } from "./config-page.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.useFakeTimers();
});

afterEach(async () => {
  const pages = document.querySelectorAll<ConfigPage>("openclaw-config-page");
  document.body.replaceChildren();
  await settleLitElements(pages);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(client: GatewayBrowserClient) {
  const source = createApplicationGateway({
    client,
    phase: "connected",
    hello: { features: { methods: ["system.info"] } },
  } as ApplicationGatewaySnapshot);
  const subscribe = () => () => undefined;
  const context = {
    gateway: source.gateway,
    agentSelection: { state: { selectedId: "main" }, subscribe },
    runtimeConfig: { state: { configSnapshot: {}, configSchema: {} }, subscribe },
    theme: { serverSelection: null, subscribe },
    overlays: { snapshot: {}, subscribe },
    config: { subscribe },
    webPush: { subscribe },
  } as unknown as ApplicationContext;
  const page = new ConfigPage();
  page.pageId = "appearance";
  // Exercise the actual host, subscriptions and Tasks; browser recovery tests own the picker UI.
  vi.spyOn(page, "render").mockReturnValue(html``);
  const provider = createApplicationContextProvider(context);
  provider.append(page);
  document.body.append(provider);
  await settleLitElement(page);
  const state = page as unknown as {
    sessionObserverModels: ModelCatalogEntry[];
    sessionObserverModelsUnavailable: boolean;
    sessionObserverModelsTask: {
      run: () => Promise<void>;
      taskComplete: Promise<unknown>;
    };
  };
  return { page, state, source, provider, context };
}

describe("ConfigPage session observer models", () => {
  it.each(["client", "source"] as const)(
    "fences a pending catalog after Gateway %s replacement",
    async (replacement) => {
      const first = deferred<ModelCatalogResult>();
      const second = deferred<ModelCatalogResult>();
      vi.spyOn(modelCatalogStore, "loadModelCatalog")
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const firstClient = {
        request: vi.fn().mockResolvedValue({}),
      } as unknown as GatewayBrowserClient;
      const secondClient =
        replacement === "client"
          ? ({ request: vi.fn().mockResolvedValue({}) } as unknown as GatewayBrowserClient)
          : firstClient;
      const { page, state, source, provider, context } = await mount(firstClient);
      const snapshot = { ...source.gateway.snapshot, client: secondClient };
      if (replacement === "source") {
        provider.setContext({ ...context, gateway: createApplicationGateway(snapshot).gateway });
      } else {
        source.publish(snapshot);
      }
      await settleLitElement(page);
      const secondLoad = state.sessionObserverModelsTask.taskComplete;
      const currentModels = [{ id: "small", name: "Small", provider: "openai" }];
      second.resolve({ models: currentModels });
      await secondLoad;
      expect(state.sessionObserverModels).toEqual(currentModels);

      first.resolve({ models: [{ id: "stale", name: "Stale", provider: "old" }] });
      await first.promise;
      await settleLitElement(page);
      expect(state.sessionObserverModels).toEqual(currentModels);
      expect(modelCatalogStore.loadModelCatalog).toHaveBeenCalledTimes(2);
      expect(modelCatalogStore.loadModelCatalog).toHaveBeenNthCalledWith(1, firstClient, {
        agentId: "main",
        preparedOnly: true,
        signal: expect.any(AbortSignal),
      });
      expect(modelCatalogStore.loadModelCatalog).toHaveBeenNthCalledWith(2, secondClient, {
        agentId: "main",
        preparedOnly: true,
        signal: expect.any(AbortSignal),
      });
    },
  );

  it("keeps same-client agent switches from restoring stale observer models", async () => {
    const firstMain = deferred<ModelCatalogResult>();
    const writer = deferred<ModelCatalogResult>();
    const secondMain = deferred<ModelCatalogResult>();
    let mainRequests = 0;
    const request = vi.fn((method: string, params: unknown) => {
      if (method === "system.info") {
        return Promise.resolve({});
      }
      const agentId = (params as { agentId?: string }).agentId;
      if (agentId === "writer") {
        return writer.promise;
      }
      mainRequests += 1;
      return mainRequests === 1 ? firstMain.promise : secondMain.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { page, state, context } = await mount(client);
    const selection = context.agentSelection.state as { selectedId: string | null };
    selection.selectedId = "writer";
    page.requestUpdate();
    await settleLitElement(page);
    const writerLoad = state.sessionObserverModelsTask.taskComplete;
    const writerModels = [{ id: "writer-model", name: "Writer Model", provider: "openai" }];
    writer.resolve({ models: writerModels });
    await writerLoad;
    expect(state.sessionObserverModels).toEqual(writerModels);

    modelCatalogStore.invalidateModelCatalogCache(client);
    selection.selectedId = "main";
    page.requestUpdate();
    await settleLitElement(page);
    const secondMainLoad = state.sessionObserverModelsTask.taskComplete;
    const currentMainModels = [{ id: "current-main", name: "Current Main", provider: "openai" }];
    secondMain.resolve({ models: currentMainModels });
    await secondMainLoad;
    firstMain.resolve({ models: [{ id: "stale-main", name: "Stale Main", provider: "openai" }] });
    await firstMain.promise;
    await settleLitElement(page);
    expect(state.sessionObserverModels).toEqual(currentMainModels);
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual(
      ["main", "writer", "main"].map((agentId) => [
        "models.list",
        { agentId, preparedOnly: true, view: "configured" },
        { signal: expect.any(AbortSignal) },
      ]),
    );

    selection.selectedId = null;
    page.requestUpdate();
    await settleLitElement(page);
    expect(state.sessionObserverModels).toEqual([]);
    expect(state.sessionObserverModelsUnavailable).toBe(true);
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(3);
  });

  it("keeps a slow refresh through status polls and retires it on disconnect", async () => {
    const stale = deferred<ModelCatalogResult>();
    const original = [{ id: "original", name: "Original", provider: "openai" }];
    const fresh = [{ id: "fresh", name: "Fresh", provider: "openai" }];
    const signals: AbortSignal[] = [];
    const request = vi.fn((method: string, _params: unknown, options: { signal: AbortSignal }) => {
      if (method === "system.info") {
        return Promise.resolve({});
      }
      signals.push(options.signal);
      return signals.length === 2
        ? stale.promise
        : Promise.resolve({ models: signals.length === 1 ? original : fresh });
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { page, state, provider } = await mount(client);
    modelCatalogStore.invalidateModelCatalogCache(client);
    const pending = state.sessionObserverModelsTask.run();
    expect(state.sessionObserverModels).toEqual(original);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(4);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
    page.remove();
    expect(signals[1]?.aborted).toBe(true);
    expect(state.sessionObserverModels).toEqual([]);
    await pending;

    provider.append(page);
    await settleLitElement(page);
    stale.resolve({ models: original });
    await settleLitElement(page);
    expect(state.sessionObserverModels).toEqual(fresh);
    expect(signals).toHaveLength(3);
  });

  it("stops status polling outside Appearance while the page remains mounted", async () => {
    const request = vi.fn((method: string) =>
      Promise.resolve(method === "models.list" ? { models: [] } : {}),
    );
    const { page } = await mount({ request } as unknown as GatewayBrowserClient);
    expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(1);
    page.pageId = "advanced";
    await settleLitElement(page);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(page.isConnected).toBe(true);
    expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(1);
    page.pageId = "appearance";
    await settleLitElement(page);
    expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(2);
  });
});
