import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS } from "../../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { getLogbookState, stopLogbookPolling } from "./logbook-controller.ts";
import { renderLogbook } from "./logbook-view.ts";
import { PluginPage } from "./plugin-page.ts";

type TestBundledView = {
  render: (props: Parameters<typeof renderLogbook>[0]) => unknown;
  stop: (host: object) => void;
};

type ApplicationConfig = ApplicationConfigCapability["current"];

const logbookBundledView = {
  render: renderLogbook,
  stop: stopLogbookPolling,
} satisfies TestBundledView;

function bundledViewHost(page: PluginPage): object {
  return (page as unknown as { bundledViewHost: object }).bundledViewHost;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class DeferredPluginPage extends PluginPage {
  loads = new Map<string, Promise<TestBundledView>[]>();

  protected override loadBundledView(key: string): Promise<TestBundledView> {
    const load = this.loads.get(key)?.shift();
    if (!load) {
      throw new Error(`Unexpected bundled view load: ${key}`);
    }
    return load;
  }
}

class ExternalPluginPage extends PluginPage {
  probeResults: Promise<boolean>[] = [Promise.resolve(true)];
  probeCalls: string[] = [];

  protected override probeExternalTabAuth(path: string, _signal: AbortSignal): Promise<boolean> {
    this.probeCalls.push(path);
    return this.probeResults.shift() ?? Promise.resolve(true);
  }
}

const deferredPluginPageTag = "openclaw-deferred-plugin-page-test";
if (!customElements.get(deferredPluginPageTag)) {
  customElements.define(deferredPluginPageTag, DeferredPluginPage);
}

const externalPluginPageTag = "openclaw-external-plugin-page-test";
if (!customElements.get(externalPluginPageTag)) {
  customElements.define(externalPluginPageTag, ExternalPluginPage);
}

function createLogbookPage(): DeferredPluginPage {
  const page = document.createElement(deferredPluginPageTag) as DeferredPluginPage;
  // Import the real owner modules before test timing begins; this suite verifies
  // PluginPage lifecycle, not Vite's concurrent dynamic-transform latency.
  page.loads = new Map([["logbook/logbook", [Promise.resolve(logbookBundledView)]]]);
  page.pluginId = "logbook";
  page.tabId = "logbook";
  return page;
}

function externalPluginConfig(
  pluginFrameGrants: ApplicationConfig["pluginFrameGrants"] = [
    {
      pluginId: "external-plugin",
      path: "/plugins/external",
      match: "prefix",
    },
  ],
): ApplicationConfig {
  return {
    assistantIdentity: {
      agentId: null,
      name: "Assistant",
      avatar: null,
      avatarSource: null,
      avatarStatus: null,
      avatarReason: null,
    },
    serverVersion: null,
    devGitBranch: null,
    localMediaPreviewRoots: [],
    embedSandboxMode: "scripts",
    allowExternalEmbedUrls: false,
    chatMessageMaxWidth: null,
    terminalEnabled: false,
    pluginFrameGrants,
  };
}

function createExternalPluginPage(
  refresh: ApplicationConfigCapability["refresh"],
  requiresGatewayAuth = true,
  path = "/plugins/external/panel",
) {
  const hello: GatewayHelloOk = {
    type: "hello-ok",
    protocol: 3,
    auth: { role: "operator", scopes: ["operator.write"] },
    controlUiTabs: [
      {
        pluginId: "external-plugin",
        id: "panel",
        label: "External panel",
        path,
        ...(requiresGatewayAuth ? { requiresGatewayAuth: true } : {}),
      },
    ],
  };
  const snapshot: ApplicationGatewaySnapshot = {
    client: null,
    connected: true,
    reconnecting: false,
    hello,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const page = document.createElement(externalPluginPageTag) as ExternalPluginPage;
  page.pluginId = "external-plugin";
  page.tabId = "panel";
  (page as unknown as { context: ApplicationContext<RouteId> }).context = {
    gateway: {
      snapshot,
      subscribe: () => () => undefined,
    },
    config: {
      current: externalPluginConfig([]),
      refresh,
    },
  } as unknown as ApplicationContext<RouteId>;
  return page;
}

describe("PluginPage", () => {
  beforeEach(() => {
    vi.stubGlobal("isSecureContext", true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes parent auth before mounting an external plugin frame", async () => {
    const pendingRefresh = deferred<ApplicationConfig | null>();
    const pendingProbe = deferred<boolean>();
    const refresh = vi.fn(() => pendingRefresh.promise);
    const page = createExternalPluginPage(refresh);
    page.probeResults = [pendingProbe.promise];
    document.body.append(page);
    try {
      await page.updateComplete;
      expect(refresh).toHaveBeenCalledOnce();
      expect(page.querySelector("iframe")).toBeNull();

      pendingRefresh.resolve(externalPluginConfig());
      await waitForFast(() => expect(page.probeCalls).toEqual(["/plugins/external/panel"]));
      expect(page.querySelector("iframe")).toBeNull();

      pendingProbe.resolve(true);
      await waitForFast(() =>
        expect(page.querySelector("iframe")?.getAttribute("src")).toBe("/plugins/external/panel"),
      );
    } finally {
      page.remove();
    }
  });

  it("keeps the frame unmounted when browser policy blocks the sandbox cookie", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh);
    page.probeResults = [Promise.resolve(false)];
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.textContent).toContain("Plugin panel unavailable"));
      expect(page.probeCalls).toEqual(["/plugins/external/panel"]);
      expect(page.querySelector("iframe")).toBeNull();
    } finally {
      page.remove();
    }
  });

  it("matches a route grant against tab URLs with query strings and fragments", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const path = "/plugins/external/panel?view=activity#settings";
    const page = createExternalPluginPage(refresh, true, path);
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.querySelector("iframe")?.getAttribute("src")).toBe(path));
      expect(page.probeCalls).toEqual([path]);
    } finally {
      page.remove();
    }
  });

  it("marks the panel unavailable when bootstrap issued no matching grant", async () => {
    const refresh = vi.fn(async () => externalPluginConfig([]));
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.textContent).toContain("Plugin panel unavailable"));
      expect(page.querySelector("iframe")).toBeNull();
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      page.remove();
    }
  });

  it("renews external plugin auth before the route-bound grant expires", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await page.updateComplete;
      await Promise.resolve();
      await page.updateComplete;
      expect(refresh).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
      expect(refresh).toHaveBeenCalledTimes(2);

      page.remove();
      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      page.remove();
      vi.useRealTimers();
    }
  });

  it("unmounts an external frame when renewal hangs past grant expiry", async () => {
    vi.useFakeTimers();
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    const refresh = vi
      .fn<ApplicationConfigCapability["refresh"]>()
      .mockResolvedValueOnce(externalPluginConfig())
      .mockImplementation(
        (options) =>
          new Promise<ApplicationConfig | null>((resolve) => {
            activeRefreshes += 1;
            maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
            options?.signal?.addEventListener(
              "abort",
              () => {
                activeRefreshes -= 1;
                resolve(null);
              },
              { once: true },
            );
          }),
      );
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await page.updateComplete;
      await Promise.resolve();
      await page.updateComplete;
      await Promise.resolve();
      await page.updateComplete;
      expect(page.querySelector("iframe")).not.toBeNull();

      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(page.querySelector("iframe")).not.toBeNull();

      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
      await page.updateComplete;
      expect(page.querySelector("iframe")).toBeNull();
      expect(refresh.mock.calls.length).toBeGreaterThan(2);
      expect(maxActiveRefreshes).toBe(1);
    } finally {
      page.remove();
      vi.useRealTimers();
    }
  });

  it("serially replaces a hung renewal when an expired page resumes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    const refresh = vi
      .fn<ApplicationConfigCapability["refresh"]>()
      .mockResolvedValueOnce(externalPluginConfig())
      .mockImplementation(
        (options) =>
          new Promise<ApplicationConfig | null>((resolve) => {
            activeRefreshes += 1;
            maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
            options?.signal?.addEventListener(
              "abort",
              () => {
                activeRefreshes -= 1;
                resolve(null);
              },
              { once: true },
            );
          }),
      );
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await page.updateComplete;
      await Promise.resolve();
      await page.updateComplete;
      await vi.advanceTimersByTimeAsync(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
      expect(refresh).toHaveBeenCalledTimes(2);

      vi.setSystemTime(new Date(CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS));
      (
        page as unknown as {
          handleVisibilityChange: () => void;
        }
      ).handleVisibilityChange();
      await Promise.resolve();
      await page.updateComplete;

      expect(page.querySelector("iframe")).toBeNull();
      expect(refresh).toHaveBeenCalledTimes(3);
      expect(maxActiveRefreshes).toBe(1);
    } finally {
      page.remove();
      vi.useRealTimers();
    }
  });

  it("refreshes the frame grant after gateway reconnect", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh);
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.querySelector("iframe")).not.toBeNull());
      const context = (page as unknown as { context: ApplicationContext<RouteId> }).context;
      const gateway = context.gateway;
      const snapshot = gateway.snapshot as { connected: boolean };

      snapshot.connected = false;
      (
        page as unknown as {
          updateGatewaySource: (source: ApplicationContext<RouteId>["gateway"]) => void;
        }
      ).updateGatewaySource(gateway);
      await page.updateComplete;
      expect(page.querySelector("iframe")).toBeNull();

      snapshot.connected = true;
      (
        page as unknown as {
          updateGatewaySource: (source: ApplicationContext<RouteId>["gateway"]) => void;
        }
      ).updateGatewaySource(gateway);
      await waitForFast(() => expect(page.querySelector("iframe")).not.toBeNull());
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      page.remove();
    }
  });

  it("refuses external plugin auth outside a secure browser context", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh);
    (
      page as unknown as {
        isExternalTabAuthSupported: () => boolean;
      }
    ).isExternalTabAuthSupported = () => false;
    document.body.append(page);
    try {
      await page.updateComplete;
      expect(refresh).not.toHaveBeenCalled();
      expect(page.querySelector("iframe")).toBeNull();
      expect(page.textContent).toContain("Secure browser context required");
    } finally {
      page.remove();
    }
  });

  it("keeps plugin-auth external panels available outside a secure context", async () => {
    const refresh = vi.fn(async () => externalPluginConfig());
    const page = createExternalPluginPage(refresh, false);
    (
      page as unknown as {
        isExternalTabAuthSupported: () => boolean;
      }
    ).isExternalTabAuthSupported = () => false;
    document.body.append(page);
    try {
      await page.updateComplete;
      expect(refresh).not.toHaveBeenCalled();
      expect(page.querySelector("iframe")?.getAttribute("src")).toBe("/plugins/external/panel");
    } finally {
      page.remove();
    }
  });

  it("stops a bundled view when its advertised descriptor disappears", async () => {
    const bundledView = deferred<TestBundledView>();
    const stop = vi.fn();
    const hello: GatewayHelloOk = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.write"] },
      controlUiTabs: [{ pluginId: "logbook", id: "logbook", label: "Logbook" }],
    };
    const snapshot: ApplicationGatewaySnapshot = {
      client: null,
      connected: true,
      reconnecting: false,
      hello,
      assistantAgentId: null,
      sessionKey: "main",
      lastError: null,
      lastErrorCode: null,
    };
    const page = document.createElement(deferredPluginPageTag) as DeferredPluginPage;
    page.loads = new Map([["logbook/logbook", [bundledView.promise]]]);
    page.pluginId = "logbook";
    page.tabId = "logbook";
    (page as unknown as { context: ApplicationContext<RouteId> }).context = {
      gateway: { snapshot, subscribe: () => () => undefined },
    } as unknown as ApplicationContext<RouteId>;

    document.body.append(page);
    try {
      bundledView.resolve({ render: () => "Logbook view", stop });
      await waitForFast(() => expect(page.textContent).toContain("Logbook view"));
      const previousHost = bundledViewHost(page);

      hello.controlUiTabs = [];
      page.requestUpdate();
      await page.updateComplete;

      expect(bundledViewHost(page)).not.toBe(previousHost);
      expect(stop).toHaveBeenCalledWith(previousHost);
    } finally {
      page.remove();
    }
  });

  it("drops bundled view state and reloads immediately when the gateway source changes", async () => {
    const hello: GatewayHelloOk = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.write"] },
      controlUiTabs: [{ pluginId: "logbook", id: "logbook", label: "Logbook" }],
    };
    const responseFor = (method: string) => {
      if (method === "logbook.status") {
        return {
          captureEnabled: true,
          capturePaused: false,
          captureIntervalSeconds: 30,
          analysisIntervalMinutes: 15,
          retentionDays: 30,
          pendingFrames: 0,
          analysisRunning: false,
          visionModelSource: "missing",
          today: "2026-07-05",
          todayCards: 0,
          timeZone: "UTC",
        };
      }
      if (method === "logbook.days") {
        return { days: [] };
      }
      return {
        day: "2026-07-05",
        cards: [],
        stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
      };
    };
    const firstRequest = vi.fn(async (method: string) => responseFor(method));
    const secondRequest = vi.fn(async (method: string) => responseFor(method));
    const createContext = (request: typeof firstRequest) => {
      const snapshot: ApplicationGatewaySnapshot = {
        client: { request } as unknown as GatewayBrowserClient,
        connected: true,
        reconnecting: false,
        hello,
        assistantAgentId: null,
        sessionKey: "main",
        lastError: null,
        lastErrorCode: null,
      };
      return {
        gateway: { snapshot, subscribe: () => () => undefined },
      } as unknown as ApplicationContext<RouteId>;
    };
    const page = createLogbookPage();
    (page as unknown as { context: ApplicationContext<RouteId> }).context =
      createContext(firstRequest);
    document.body.append(page);
    try {
      await waitForFast(() => expect(firstRequest).toHaveBeenCalled());
      const firstHost = bundledViewHost(page);
      expect(getLogbookState(firstHost).pollTimer).not.toBeNull();

      (page as unknown as { context: ApplicationContext<RouteId> }).context =
        createContext(secondRequest);
      page.requestUpdate();
      await page.updateComplete;

      await waitForFast(() => expect(secondRequest).toHaveBeenCalledWith("logbook.status", {}));
      expect(bundledViewHost(page)).not.toBe(firstHost);
      expect(getLogbookState(firstHost).pollTimer).toBeNull();
    } finally {
      page.remove();
    }
  });

  it("isolates an in-flight bundled load across a same-client reconnect", async () => {
    const hello: GatewayHelloOk = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.write"] },
      controlUiTabs: [{ pluginId: "logbook", id: "logbook", label: "Logbook" }],
    };
    const staleStatus = deferred<unknown>();
    const staleDays = deferred<unknown>();
    const staleTimeline = deferred<unknown>();
    const pending = new Map([
      ["logbook.status", staleStatus],
      ["logbook.days", staleDays],
      ["logbook.timeline", staleTimeline],
    ]);
    const responseFor = (method: string) => {
      if (method === "logbook.status") {
        return {
          captureEnabled: true,
          capturePaused: false,
          captureIntervalSeconds: 30,
          analysisIntervalMinutes: 15,
          retentionDays: 30,
          pendingFrames: 0,
          analysisRunning: false,
          visionModelSource: "missing",
          today: "2026-07-05",
          todayCards: 0,
          timeZone: "UTC",
        };
      }
      if (method === "logbook.days") {
        return { days: [] };
      }
      return {
        day: "2026-07-05",
        cards: [],
        stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
      };
    };
    const request = vi.fn((method: string) => {
      const deferredResponse = pending.get(method);
      return deferredResponse ? deferredResponse.promise : Promise.resolve(responseFor(method));
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot: ApplicationGatewaySnapshot = {
      client,
      connected: true,
      reconnecting: false,
      hello,
      assistantAgentId: null,
      sessionKey: "main",
      lastError: null,
      lastErrorCode: null,
    };
    let listener: ((snapshot: ApplicationGatewaySnapshot) => void) | undefined;
    const gateway = {
      snapshot,
      subscribe(next: (snapshot: ApplicationGatewaySnapshot) => void) {
        listener = next;
        return () => {
          if (listener === next) {
            listener = undefined;
          }
        };
      },
    } as unknown as ApplicationContext<RouteId>["gateway"];
    const page = createLogbookPage();
    (page as unknown as { context: ApplicationContext<RouteId> }).context = {
      gateway,
    } as unknown as ApplicationContext<RouteId>;
    document.body.append(page);
    try {
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
      const staleHost = bundledViewHost(page);

      snapshot.connected = false;
      listener?.(snapshot);
      await page.updateComplete;
      const disconnectedHost = bundledViewHost(page);
      expect(disconnectedHost).not.toBe(staleHost);

      pending.clear();
      staleStatus.resolve(responseFor("logbook.status"));
      staleDays.resolve(responseFor("logbook.days"));
      staleTimeline.resolve(responseFor("logbook.timeline"));
      await waitForFast(() => expect(getLogbookState(staleHost).timeline).not.toBeNull());
      expect(getLogbookState(disconnectedHost).timeline).toBeNull();

      snapshot.connected = true;
      listener?.(snapshot);
      await page.updateComplete;
      expect(bundledViewHost(page)).not.toBe(disconnectedHost);
      await waitForFast(() => expect(getLogbookState(bundledViewHost(page)).status).not.toBeNull());
    } finally {
      page.remove();
    }
  });

  it("does not install an earlier bundled view after switching away and back", async () => {
    const firstLogbookLoad = deferred<TestBundledView>();
    const currentLogbookLoad = deferred<TestBundledView>();
    const hello: GatewayHelloOk = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.write"] },
      controlUiTabs: [
        { pluginId: "logbook", id: "logbook", label: "Logbook" },
        {
          pluginId: "external-plugin",
          id: "panel",
          label: "External panel",
        },
      ],
    };
    const snapshot: ApplicationGatewaySnapshot = {
      client: null,
      connected: true,
      reconnecting: false,
      hello,
      assistantAgentId: null,
      sessionKey: "main",
      lastError: null,
      lastErrorCode: null,
    };
    const page = document.createElement(deferredPluginPageTag) as DeferredPluginPage;
    page.loads = new Map([
      ["logbook/logbook", [firstLogbookLoad.promise, currentLogbookLoad.promise]],
    ]);
    page.pluginId = "logbook";
    page.tabId = "logbook";
    (page as unknown as { context: ApplicationContext<RouteId> }).context = {
      gateway: { snapshot, subscribe: () => () => undefined },
    } as unknown as ApplicationContext<RouteId>;

    document.body.append(page);
    try {
      await page.updateComplete;
      page.pluginId = "external-plugin";
      page.tabId = "panel";
      await page.updateComplete;
      page.pluginId = "logbook";
      page.tabId = "logbook";
      await page.updateComplete;

      currentLogbookLoad.resolve({ render: () => "current Logbook view", stop: vi.fn() });
      await waitForFast(() => expect(page.textContent).toContain("current Logbook view"));

      firstLogbookLoad.resolve({ render: () => "stale Logbook view", stop: vi.fn() });
      await Promise.resolve();
      await page.updateComplete;
      expect(page.textContent).not.toContain("stale Logbook view");
      expect(page.textContent).toContain("current Logbook view");
    } finally {
      page.remove();
    }
  });
});
