import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { PluginPage } from "./plugin-page.ts";

type TestBundledView = {
  render: () => unknown;
  stop: (host: object) => void;
};

class RejectedPluginPage extends PluginPage {
  loads: Promise<TestBundledView>[] = [];

  protected override loadBundledView(): Promise<TestBundledView> {
    const load = this.loads.shift();
    if (!load) {
      throw new Error("Unexpected bundled view load");
    }
    return load;
  }
}

const rejectedPluginPageTag = "openclaw-rejected-plugin-page-test";
if (!customElements.get(rejectedPluginPageTag)) {
  customElements.define(rejectedPluginPageTag, RejectedPluginPage);
}

function createPage(loads: Promise<TestBundledView>[], includeExternal = false) {
  const hello: GatewayHelloOk = {
    type: "hello-ok",
    protocol: 3,
    auth: { role: "operator", scopes: ["operator.write"] },
    controlUiTabs: [
      { pluginId: "logbook", id: "logbook", label: "Logbook" },
      ...(includeExternal
        ? [{ pluginId: "external-plugin", id: "panel", label: "External panel" }]
        : []),
    ],
  };
  const snapshot: ApplicationGatewaySnapshot = {
    client: null,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const page = document.createElement(rejectedPluginPageTag) as RejectedPluginPage;
  page.loads = loads;
  page.pluginId = "logbook";
  page.tabId = "logbook";
  (page as unknown as { context: ApplicationContext<RouteId> }).context = {
    gateway: { snapshot, subscribe: () => () => undefined },
  } as unknown as ApplicationContext<RouteId>;
  return page;
}

describe("PluginPage bundled view load failures", () => {
  it("shows the current rejection and recovers when Retry succeeds", async () => {
    const failedLoad = createDeferred<TestBundledView>();
    const retryLoad = createDeferred<TestBundledView>();
    const page = createPage([failedLoad.promise, retryLoad.promise]);
    document.body.append(page);
    try {
      await waitForFast(() => expect(page.querySelector('[role="status"]')).not.toBeNull());
      failedLoad.reject(new Error("Logbook chunk failed"));
      await waitForFast(() =>
        expect(page.querySelector('[role="alert"]')?.textContent).toContain("Logbook chunk failed"),
      );

      page.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
      await waitForFast(() => expect(page.querySelector('[role="status"]')).not.toBeNull());
      retryLoad.resolve({ render: () => "recovered Logbook view", stop: vi.fn() });
      await waitForFast(() => expect(page.textContent).toContain("recovered Logbook view"));
      expect(page.querySelector('[role="alert"]')).toBeNull();
    } finally {
      page.remove();
    }
  });

  it("ignores a stale rejection after switching away and back", async () => {
    const staleLoad = createDeferred<TestBundledView>();
    const currentLoad = createDeferred<TestBundledView>();
    const page = createPage([staleLoad.promise, currentLoad.promise], true);
    document.body.append(page);
    try {
      await page.updateComplete;
      page.pluginId = "external-plugin";
      page.tabId = "panel";
      await page.updateComplete;
      page.pluginId = "logbook";
      page.tabId = "logbook";
      await page.updateComplete;

      currentLoad.resolve({ render: () => "current Logbook view", stop: vi.fn() });
      await waitForFast(() => expect(page.textContent).toContain("current Logbook view"));
      staleLoad.reject(new Error("Failed to fetch dynamically imported module"));
      await Promise.resolve();
      await page.updateComplete;

      expect(page.querySelector('[role="alert"]')).toBeNull();
      expect(page.textContent).toContain("current Logbook view");
    } finally {
      page.remove();
    }
  });
});
