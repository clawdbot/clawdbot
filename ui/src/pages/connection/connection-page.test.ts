/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { ConnectionPage, supportsSystemInfo } from "./connection-page.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
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

describe("ConnectionPage system info", () => {
  it("clears stale host info when the Gateway disconnects", () => {
    const client = {} as GatewayBrowserClient;
    const snapshot = {
      client,
      phase: "stopped",
      hello: null,
    } as ApplicationGatewaySnapshot;
    const page = new ConnectionPage();
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
      phase: "connected",
      hello: { features: { methods: ["system.info"] } },
    } as ApplicationGatewaySnapshot;
    const firstGateway = { snapshot } as ApplicationGateway;
    const secondGateway = { snapshot } as ApplicationGateway;
    const page = new ConnectionPage();
    const state = page as unknown as {
      context: ApplicationContext;
      syncSystemInfoPolling: () => void;
      synchronizeSystemInfoGateway: (gateway: ApplicationGateway) => void;
      loadSystemInfo: () => Promise<void>;
      systemInfo: SystemInfoResult | null;
      systemInfoUnavailable: boolean;
    };
    Object.defineProperty(page, "isConnected", { configurable: true, value: true });
    state.syncSystemInfoPolling = () => undefined;
    state.context = { gateway: firstGateway } as ApplicationContext;
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
  });
});
