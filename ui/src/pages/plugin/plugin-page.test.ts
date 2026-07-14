import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { getLogbookState, stopLogbookPolling } from "./logbook-controller.ts";
import { renderLogbook } from "./logbook-view.ts";
import { PluginPage } from "./plugin-page.ts";

type TestBundledView = {
  render: (props: Parameters<typeof renderLogbook>[0]) => unknown;
  stop: (host: object) => void;
};

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

const deferredPluginPageTag = "openclaw-deferred-plugin-page-test";
if (!customElements.get(deferredPluginPageTag)) {
  customElements.define(deferredPluginPageTag, DeferredPluginPage);
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

describe("PluginPage", () => {
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
      await vi.waitFor(() => expect(page.textContent).toContain("Logbook view"));
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
      await vi.waitFor(() => expect(firstRequest).toHaveBeenCalled());
      const firstHost = bundledViewHost(page);
      expect(getLogbookState(firstHost).pollTimer).not.toBeNull();

      (page as unknown as { context: ApplicationContext<RouteId> }).context =
        createContext(secondRequest);
      page.requestUpdate();
      await page.updateComplete;

      await vi.waitFor(() => expect(secondRequest).toHaveBeenCalledWith("logbook.status", {}));
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
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
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
      await vi.waitFor(() => expect(getLogbookState(staleHost).timeline).not.toBeNull());
      expect(getLogbookState(disconnectedHost).timeline).toBeNull();

      snapshot.connected = true;
      listener?.(snapshot);
      await page.updateComplete;
      expect(bundledViewHost(page)).not.toBe(disconnectedHost);
      await vi.waitFor(() => expect(getLogbookState(bundledViewHost(page)).status).not.toBeNull());
    } finally {
      page.remove();
    }
  });

  it("does not install an earlier bundled view after switching away and back", async () => {
    const firstWorkspaceLoad = deferred<TestBundledView>();
    const currentWorkspaceLoad = deferred<TestBundledView>();
    const logbookLoad = deferred<TestBundledView>();
    const hello: GatewayHelloOk = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.write"] },
      controlUiTabs: [
        { pluginId: "workspaces", id: "workspaces", label: "Workspaces" },
        { pluginId: "logbook", id: "logbook", label: "Logbook" },
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
      ["workspaces/workspaces", [firstWorkspaceLoad.promise, currentWorkspaceLoad.promise]],
      ["logbook/logbook", [logbookLoad.promise]],
    ]);
    page.pluginId = "workspaces";
    page.tabId = "workspaces";
    (page as unknown as { context: ApplicationContext<RouteId> }).context = {
      gateway: { snapshot, subscribe: () => () => undefined },
    } as unknown as ApplicationContext<RouteId>;

    document.body.append(page);
    try {
      await page.updateComplete;
      page.pluginId = "logbook";
      page.tabId = "logbook";
      await page.updateComplete;
      page.pluginId = "workspaces";
      page.tabId = "workspaces";
      await page.updateComplete;

      currentWorkspaceLoad.resolve({ render: () => "current workspace view", stop: vi.fn() });
      await vi.waitFor(() => expect(page.textContent).toContain("current workspace view"));

      firstWorkspaceLoad.resolve({ render: () => "stale workspace view", stop: vi.fn() });
      await Promise.resolve();
      await page.updateComplete;
      expect(page.textContent).not.toContain("stale workspace view");
      expect(page.textContent).toContain("current workspace view");
      logbookLoad.resolve({ render: () => "stale Logbook view", stop: vi.fn() });
    } finally {
      page.remove();
    }
  });
});
