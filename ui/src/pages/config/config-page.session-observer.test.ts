/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import * as modelCatalogStore from "../../lib/model-catalog-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ConfigPage } from "./config-page.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConfigPage session observer models", () => {
  it.each(["client", "source"] as const)(
    "fences a pending catalog after Gateway %s replacement",
    async (replacement) => {
      const first = deferred<ModelCatalogResult>();
      const second = deferred<ModelCatalogResult>();
      vi.spyOn(modelCatalogStore, "loadModelCatalog")
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const firstClient = {} as GatewayBrowserClient;
      const secondClient = replacement === "client" ? ({} as GatewayBrowserClient) : firstClient;
      const gateway = {
        snapshot: {
          client: firstClient,
          phase: "connected",
          hello: { features: { methods: ["system.info"] } },
        },
      } as unknown as ApplicationGateway;
      const page = new ConfigPage();
      page.pageId = "appearance";
      const state = page as unknown as {
        context: ApplicationContext;
        systemInfoGatewaySource: ApplicationGateway;
        systemInfo: unknown;
        sessionObserverModels: ModelCatalogEntry[];
        sessionObserverModelsUnavailable: boolean;
        sessionObserverModelsTask: {
          run: () => Promise<void>;
          hostUpdate: () => void;
          taskComplete: Promise<unknown>;
        };
      };
      Object.defineProperty(page, "isConnected", { configurable: true, value: true });
      state.context = {
        gateway,
        agentSelection: { state: { selectedId: "main" } },
      } as ApplicationContext;
      state.systemInfoGatewaySource = gateway;
      state.systemInfo = {};

      const firstLoad = state.sessionObserverModelsTask.run();
      (gateway as { snapshot: ApplicationGatewaySnapshot }).snapshot = {
        client: secondClient,
        phase: "connected",
        hello: { features: { methods: ["system.info"] } },
      } as ApplicationGatewaySnapshot;
      const nextGateway = replacement === "source" ? { ...gateway } : gateway;
      state.context = { ...state.context, gateway: nextGateway };
      state.systemInfoGatewaySource = nextGateway;
      state.sessionObserverModelsTask.hostUpdate();
      const secondLoad = state.sessionObserverModelsTask.taskComplete;
      const currentModels = [{ id: "small", name: "Small", provider: "openai" }];
      second.resolve({ models: currentModels });
      await secondLoad;
      expect(state.sessionObserverModels).toEqual(currentModels);

      first.resolve({ models: [{ id: "stale", name: "Stale", provider: "old" }] });
      await firstLoad;
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
    const request = vi.fn((_method: string, params: unknown) => {
      const agentId = (params as { agentId?: string }).agentId;
      if (agentId === "writer") {
        return writer.promise;
      }
      mainRequests += 1;
      return mainRequests === 1 ? firstMain.promise : secondMain.promise;
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = {
      snapshot: { client, phase: "connected", hello: { features: { methods: ["system.info"] } } },
    } as unknown as ApplicationGateway;
    const selectionState = { selectedId: "main" as string | null };
    const page = new ConfigPage();
    page.pageId = "appearance";
    const state = page as unknown as {
      context: ApplicationContext;
      systemInfoGatewaySource: ApplicationGateway;
      systemInfo: unknown;
      sessionObserverModels: ModelCatalogEntry[];
      sessionObserverModelsUnavailable: boolean;
      sessionObserverModelsTask: {
        run: () => Promise<void>;
        hostUpdate: () => void;
        taskComplete: Promise<unknown>;
      };
    };
    Object.defineProperty(page, "isConnected", { configurable: true, value: true });
    state.context = {
      gateway,
      agentSelection: { state: selectionState },
    } as ApplicationContext;
    state.systemInfoGatewaySource = gateway;
    state.systemInfo = {};

    const mainLoad = state.sessionObserverModelsTask.run();
    selectionState.selectedId = "writer";
    state.sessionObserverModelsTask.hostUpdate();
    const writerLoad = state.sessionObserverModelsTask.taskComplete;
    const writerModels = [{ id: "writer-model", name: "Writer Model", provider: "openai" }];
    writer.resolve({ models: writerModels });
    await writerLoad;
    expect(state.sessionObserverModels).toEqual(writerModels);

    modelCatalogStore.invalidateModelCatalogCache(client);
    selectionState.selectedId = "main";
    state.sessionObserverModelsTask.hostUpdate();
    const secondMainLoad = state.sessionObserverModelsTask.taskComplete;
    const currentMainModels = [{ id: "current-main", name: "Current Main", provider: "openai" }];
    secondMain.resolve({ models: currentMainModels });
    await secondMainLoad;
    firstMain.resolve({
      models: [{ id: "stale-main", name: "Stale Main", provider: "openai" }],
    });
    await mainLoad;

    expect(state.sessionObserverModels).toEqual(currentMainModels);
    for (const [index, agentId] of ["main", "writer", "main"].entries()) {
      expect(request).toHaveBeenNthCalledWith(
        index + 1,
        "models.list",
        { agentId, preparedOnly: true, view: "configured" },
        { signal: expect.any(AbortSignal) },
      );
    }

    selectionState.selectedId = null;
    state.sessionObserverModelsTask.hostUpdate();
    expect(state.sessionObserverModels).toEqual([]);
    expect(state.sessionObserverModelsUnavailable).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
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
    const gateway = {
      snapshot: { client, phase: "connected", hello: { features: { methods: ["system.info"] } } },
    } as unknown as ApplicationGateway;
    const page = new ConfigPage();
    page.pageId = "appearance";
    const state = page as unknown as {
      context: ApplicationContext;
      systemInfoGatewaySource: ApplicationGateway;
      sessionObserverModels: ModelCatalogEntry[];
      sessionObserverModelsTask: {
        run: (args: readonly [ApplicationGateway, GatewayBrowserClient, string]) => Promise<void>;
      };
      systemInfoTask: {
        run: (args: readonly [ApplicationGateway, GatewayBrowserClient]) => Promise<void>;
      };
    };
    Object.defineProperty(page, "isConnected", { configurable: true, value: true });
    state.context = {
      gateway,
      agentSelection: { state: { selectedId: "main" } },
    } as ApplicationContext;
    state.systemInfoGatewaySource = gateway;
    const args = [gateway, client, "main"] as const;
    await state.sessionObserverModelsTask.run(args);
    modelCatalogStore.invalidateModelCatalogCache(client);
    const pending = state.sessionObserverModelsTask.run(args);
    expect(state.sessionObserverModels).toEqual(original);

    for (let poll = 0; poll < 3; poll += 1) {
      await state.systemInfoTask.run([gateway, client]);
    }
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
    page.disconnectedCallback();
    expect(signals[1]?.aborted).toBe(true);
    expect(state.sessionObserverModels).toEqual([]);
    await pending;

    state.systemInfoGatewaySource = gateway;
    await state.sessionObserverModelsTask.run(args);
    stale.resolve({ models: original });
    await stale.promise;
    expect(state.sessionObserverModels).toEqual(fresh);
    expect(signals).toHaveLength(3);
  });
});
