/* @vitest-environment jsdom */

import type { ReactiveController } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import * as chatModels from "../chat/models.ts";
import * as realtimeTalk from "../chat/realtime-talk.ts";
import { ConfigPage, configSelectionFromSearch, supportsSystemInfo } from "./config-page.ts";
import { configSectionKeysForPage } from "./config-sections.ts";
import type { ConfigViewState } from "./view.ts";

const switchActiveRealtimeTalkCameras =
  vi.fn<typeof realtimeTalk.switchActiveRealtimeTalkCameras>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

let localStorageMock: Storage;

beforeEach(() => {
  vi.spyOn(realtimeTalk, "switchActiveRealtimeTalkCameras").mockImplementation(
    switchActiveRealtimeTalkCameras,
  );
  localStorageMock = createStorageMock();
  vi.stubGlobal("localStorage", localStorageMock);
  switchActiveRealtimeTalkCameras.mockReset();
  switchActiveRealtimeTalkCameras.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("configSelectionFromSearch", () => {
  it("opens a valid linked Settings section", () => {
    expect(configSelectionFromSearch("communications", "?section=talk")).toEqual({
      activeSection: "talk",
      activeSubsection: null,
    });
  });

  it("falls back when a linked section does not belong to the page", () => {
    expect(configSelectionFromSearch("communications", "?section=gateway")).toEqual({
      activeSection: "messages",
      activeSubsection: null,
    });
  });

  it("keeps MCP separate from Infrastructure", () => {
    expect(configSectionKeysForPage("mcp")).toEqual(["mcp"]);
    expect(configSectionKeysForPage("infrastructure")).toEqual([
      "gateway",
      "web",
      "browser",
      "nodeHost",
      "canvasHost",
      "discovery",
      "media",
      "acp",
    ]);
    expect(configSelectionFromSearch("mcp", "?section=browser")).toEqual({
      activeSection: "mcp",
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("infrastructure", "?section=mcp")).toEqual({
      activeSection: "gateway",
      activeSubsection: null,
    });
  });
});

describe("supportsSystemInfo", () => {
  it("requires the Gateway to advertise system.info", () => {
    const hello = {
      features: { methods: ["health", "system.info"] },
    } as ApplicationGatewaySnapshot["hello"];
    const unsupportedHello = {
      features: { methods: ["health"] },
    } as ApplicationGatewaySnapshot["hello"];

    expect(supportsSystemInfo(hello)).toBe(true);
    expect(supportsSystemInfo(unsupportedHello)).toBe(false);
    expect(supportsSystemInfo(null)).toBe(false);
  });
});

describe("ConfigPage advanced selection guard", () => {
  it("keeps curated sections off the Advanced page", () => {
    expect(configSelectionFromSearch("advanced", "?section=messages")).toEqual({
      activeSection: null,
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("advanced", "?section=env")).toEqual({
      activeSection: "env",
      activeSubsection: null,
    });
    expect(configSelectionFromSearch("advanced", "?section=mcp")).toEqual({
      activeSection: null,
      activeSubsection: null,
    });
  });
});

describe("ConfigPage media discovery", () => {
  it("coalesces refreshes while discovery is in flight", async () => {
    for (const method of ["refreshMicrophones", "refreshCameras"] as const) {
      const discovery = deferred<MediaDeviceInfo[]>();
      const enumerateDevices = vi.fn(() => discovery.promise);
      vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices } });
      const page = new ConfigPage();
      const state = page as unknown as Record<
        typeof method,
        (requestPermission: boolean) => Promise<void>
      >;

      const first = state[method](true);
      await state[method](true);
      expect(enumerateDevices).toHaveBeenCalledOnce();

      discovery.resolve([]);
      await first;
    }
  });

  it("upgrades passive discovery when the user requests permission", async () => {
    for (const method of ["refreshMicrophones", "refreshCameras"] as const) {
      const passiveDiscovery = deferred<MediaDeviceInfo[]>();
      const enumerateDevices = vi
        .fn()
        .mockImplementationOnce(() => passiveDiscovery.promise)
        .mockResolvedValueOnce([]);
      vi.stubGlobal("navigator", { mediaDevices: { enumerateDevices } });
      const page = new ConfigPage();
      const state = page as unknown as Record<
        typeof method,
        (requestPermission: boolean) => Promise<void>
      >;

      const passive = state[method](false);
      await state[method](true);
      expect(enumerateDevices).toHaveBeenCalledOnce();

      passiveDiscovery.resolve([]);
      await passive;
      expect(enumerateDevices).toHaveBeenCalledTimes(2);
    }
  });
});

describe("ConfigPage camera selection", () => {
  it("clears recovered errors and ignores failures from superseded selections", async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    switchActiveRealtimeTalkCameras
      .mockRejectedValueOnce(new Error("The selected camera is unavailable"))
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const page = new ConfigPage();
    const state = page as unknown as {
      cameraError: string | null;
      selectCamera: (deviceId: string) => Promise<void>;
      applySettings: () => void;
    };
    state.applySettings = () => undefined;

    await state.selectCamera("missing-camera");
    expect(state.cameraError).toBe("The selected camera is unavailable");

    const staleSelection = state.selectCamera("slow-camera");
    expect(state.cameraError).toBeNull();
    await state.selectCamera("back-camera");
    rejectFirst(new Error("The selected camera is unavailable"));
    await staleSelection;
    expect(state.cameraError).toBeNull();

    state.cameraError = "Another camera error";
    await state.selectCamera("");
    expect(state.cameraError).toBeNull();
  });
});

describe("ConfigPage system info", () => {
  it("clears stale host info when the Gateway disconnects", () => {
    const client = {} as GatewayBrowserClient;
    const snapshot = {
      client,
      connected: false,
      hello: null,
    } as ApplicationGatewaySnapshot;
    const page = new ConfigPage();
    const state = page as unknown as {
      context: { gateway: { snapshot: ApplicationGatewaySnapshot } };
      systemInfo: SystemInfoResult | null;
      systemInfoClient: GatewayBrowserClient | null;
      handleSystemInfoGatewaySnapshot: (snapshot: ApplicationGatewaySnapshot) => void;
    };
    state.context = { gateway: { snapshot } };
    state.systemInfoClient = client;
    state.systemInfo = {} as SystemInfoResult;

    state.handleSystemInfoGatewaySnapshot(snapshot);

    expect(state.systemInfo).toBeNull();
  });

  it("rejects an old Gateway source response when the replacement reuses its client", async () => {
    const firstResponse = deferred<SystemInfoResult>();
    const secondResponse = deferred<SystemInfoResult>();
    const client = {
      request: vi
        .fn()
        .mockImplementationOnce(() => firstResponse.promise)
        .mockImplementationOnce(() => secondResponse.promise),
    } as unknown as GatewayBrowserClient;
    const snapshot = {
      client,
      connected: true,
      hello: { features: { methods: ["system.info"] } },
    } as ApplicationGatewaySnapshot;
    const firstGateway = { snapshot } as ApplicationGateway;
    const secondGateway = { snapshot } as ApplicationGateway;
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
      subscriptions: ReactiveController;
      shouldUpdate: () => boolean;
      syncSystemInfoPolling: () => void;
      synchronizeSystemInfoGateway: (gateway: ApplicationGateway) => void;
      loadSystemInfo: () => Promise<void>;
      systemInfo: SystemInfoResult | null;
      systemInfoUnavailable: boolean;
    };
    page.removeController(state.subscriptions);
    state.shouldUpdate = () => false;
    state.syncSystemInfoPolling = () => undefined;
    state.context = { gateway: firstGateway } as ApplicationContext;
    document.body.append(page);
    state.synchronizeSystemInfoGateway(firstGateway);

    const firstLoad = state.loadSystemInfo();
    state.systemInfo = {} as SystemInfoResult;
    state.systemInfoUnavailable = true;
    state.context = { gateway: secondGateway } as ApplicationContext;
    state.synchronizeSystemInfoGateway(secondGateway);
    const secondLoad = state.loadSystemInfo();

    const stale = { platform: "stale" } as unknown as SystemInfoResult;
    firstResponse.resolve(stale);
    await firstLoad;
    expect(state.systemInfo).toBeNull();
    expect(state.systemInfoUnavailable).toBe(false);

    const current = { platform: "current" } as unknown as SystemInfoResult;
    secondResponse.resolve(current);
    await secondLoad;
    expect(state.systemInfo).toBe(current);
    page.remove();
  });
});

describe("ConfigPage session observer models", () => {
  it("lets a replacement Gateway load while the stale client is still pending", async () => {
    const first = deferred<ModelCatalogEntry[]>();
    const second = deferred<ModelCatalogEntry[]>();
    vi.spyOn(chatModels, "loadModels")
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const firstClient = {} as GatewayBrowserClient;
    const secondClient = {} as GatewayBrowserClient;
    const gateway = {
      snapshot: { client: firstClient, connected: true },
    } as unknown as ApplicationGateway;
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
      systemInfoGatewaySource: ApplicationGateway;
      sessionObserverModels: ModelCatalogEntry[];
      sessionObserverModelsClient: GatewayBrowserClient | null;
      ensureSessionObserverModels: (client: GatewayBrowserClient) => Promise<void>;
    };
    Object.defineProperty(page, "isConnected", { configurable: true, value: true });
    state.context = { gateway } as ApplicationContext;
    state.systemInfoGatewaySource = gateway;

    const firstLoad = state.ensureSessionObserverModels(firstClient);
    (gateway as { snapshot: ApplicationGatewaySnapshot }).snapshot = {
      client: secondClient,
      connected: true,
    } as ApplicationGatewaySnapshot;
    const secondLoad = state.ensureSessionObserverModels(secondClient);
    const currentModels = [{ id: "small", name: "Small", provider: "openai" }];
    second.resolve(currentModels);
    await secondLoad;
    expect(state.sessionObserverModels).toEqual(currentModels);
    expect(state.sessionObserverModelsClient).toBe(secondClient);

    first.resolve([{ id: "stale", name: "Stale", provider: "old" }]);
    await firstLoad;
    expect(state.sessionObserverModels).toEqual(currentModels);
    expect(chatModels.loadModels).toHaveBeenCalledTimes(2);
  });

  it("marks a failed client unavailable without polling it again", async () => {
    vi.spyOn(chatModels, "loadModels").mockRejectedValue(new Error("catalog unavailable"));
    const client = {} as GatewayBrowserClient;
    const gateway = {
      snapshot: { client, connected: true },
    } as unknown as ApplicationGateway;
    const page = new ConfigPage();
    const state = page as unknown as {
      context: ApplicationContext;
      systemInfoGatewaySource: ApplicationGateway;
      sessionObserverModels: ModelCatalogEntry[];
      sessionObserverModelsUnavailable: boolean;
      ensureSessionObserverModels: (client: GatewayBrowserClient) => Promise<void>;
    };
    Object.defineProperty(page, "isConnected", { configurable: true, value: true });
    state.context = { gateway } as ApplicationContext;
    state.systemInfoGatewaySource = gateway;

    await state.ensureSessionObserverModels(client);
    await state.ensureSessionObserverModels(client);

    expect(state.sessionObserverModels).toEqual([]);
    expect(state.sessionObserverModelsUnavailable).toBe(true);
    expect(chatModels.loadModels).toHaveBeenCalledOnce();
  });
});

describe("ConfigPage runtime config lifecycle", () => {
  it("loads replacement sources and clears sensitive reveal state", async () => {
    const page = new ConfigPage();
    const state = page as unknown as {
      configViewState: ConfigViewState;
      synchronizeRuntimeConfig: (runtimeConfig: ApplicationContext["runtimeConfig"]) => void;
    };
    const createRuntimeConfig = () =>
      ({
        state: {
          configSnapshot: null,
          configLoading: false,
          configSchema: null,
          configSchemaLoading: false,
        },
        ensureLoaded: vi.fn(() => Promise.resolve()),
        ensureSchemaLoaded: vi.fn(() => Promise.resolve()),
      }) as unknown as ApplicationContext["runtimeConfig"];
    const first = createRuntimeConfig();
    const second = createRuntimeConfig();

    state.synchronizeRuntimeConfig(first);
    await Promise.resolve();
    state.configViewState.rawRevealed = true;
    state.configViewState.envRevealed = true;
    state.configViewState.revealedSensitivePaths.add("gateway.auth.token");
    state.synchronizeRuntimeConfig(second);
    await Promise.resolve();

    expect(first.ensureLoaded).toHaveBeenCalledOnce();
    expect(first.ensureSchemaLoaded).toHaveBeenCalledOnce();
    expect(second.ensureLoaded).toHaveBeenCalledOnce();
    expect(second.ensureSchemaLoaded).toHaveBeenCalledOnce();
    expect(state.configViewState.rawRevealed).toBe(false);
    expect(state.configViewState.envRevealed).toBe(false);
    expect(state.configViewState.revealedSensitivePaths.size).toBe(0);
  });
});
