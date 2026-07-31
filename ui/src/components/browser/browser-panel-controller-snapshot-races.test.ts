import { describe, expect, it } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  createDeferred,
  createView,
  flushBrowserResponses,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "./browser-panel-controller.ts";

setupBrowserPanelTestCleanup();

describe("BrowserPanelController superseded tab snapshots", () => {
  it.each([true, false])(
    "never reselects a closed active tab when refreshing the remaining tabs fails (fallback: %s)",
    async (hasFallback) => {
      stubScreenshotMedia();
      const activeUrl = "https://example.test/active";
      const fallbackUrl = "https://example.test/fallback";
      const { client, request } = createBrowserClient(async (envelope) => {
        if (envelope.method === "DELETE" && envelope.path === "/tabs/active-tab") {
          return { ok: true };
        }
        if (envelope.path === "/tabs") {
          throw new Error("Tab refresh failed after the active tab was closed");
        }
        if (envelope.path === "/screenshot" && envelope.body?.targetId === "fallback-tab") {
          return { path: "/fresh.png", targetId: "raw-fallback", url: fallbackUrl };
        }
        if (envelope.path === "/act") {
          return createBrowserPanelTestMetrics(fallbackUrl, "Fallback");
        }
        throw new Error(`Unexpected browser route: ${envelope.method} ${envelope.path}`);
      });
      const controller = createBrowserPanelTestController(client, "active-tab", activeUrl);
      controller.tabs = [
        { id: "active-tab", targetId: "raw-active", title: "Active", url: activeUrl },
        ...(hasFallback
          ? [
              {
                id: "fallback-tab",
                targetId: "raw-fallback",
                title: "Fallback",
                url: fallbackUrl,
              },
            ]
          : []),
      ];

      await controller.closeTab("active-tab");

      expect(controller.tabs.map((tab) => tab.id)).toEqual(hasFallback ? ["fallback-tab"] : []);
      expect(controller.activeTargetId).toBe(hasFallback ? "fallback-tab" : null);
      expect(controller.view?.targetId ?? null).toBe(hasFallback ? "fallback-tab" : null);
      expect(controller.loading).toBe(false);
      expect(
        request.mock.calls.some(([, envelope]) => {
          const browserRequest = envelope as { path?: string; body?: { targetId?: string } };
          return (
            browserRequest.path === "/screenshot" && browserRequest.body?.targetId === "active-tab"
          );
        }),
      ).toBe(false);
    },
  );

  it("rejects old-gateway snapshots before the replacement client synchronizes", async () => {
    const activeUrl = "https://example.test/active";
    const snapshot = createDeferred<{
      running: boolean;
      tabs: ReturnType<typeof createBrowserPanelTestTab>[];
    }>();
    const old = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        return await snapshot.promise;
      }
      throw new Error(`Unexpected old browser route: ${envelope.path}`);
    });
    const replacement = createBrowserClient(async (envelope) => {
      throw new Error(`Unexpected replacement browser route: ${envelope.path}`);
    });
    const host = new TestBrowserPanelHost(old.client);
    const controller = new BrowserPanelController(host);
    const originalView = createView("active-tab", activeUrl);
    controller.activeTargetId = "active-tab";
    controller.view = originalView;

    const refresh = controller.refreshAll();
    await flushBrowserResponses();
    host.client = replacement.client;
    snapshot.resolve({
      running: true,
      tabs: [createBrowserPanelTestTab("active-tab", activeUrl, "Active")],
    });
    await refresh;

    expect(controller.running).toBeNull();
    expect(controller.tabs).toEqual([]);
    expect(controller.view).toBe(originalView);
    expect(replacement.request).not.toHaveBeenCalled();
  });

  it.each(["before", "after"] as const)(
    "settles loading when a superseded refresh fails %s a background-close snapshot",
    async (olderFailureOrder) => {
      const activeUrl = "https://example.test/active";
      const previousSnapshot = createDeferred<unknown>();
      const closeSnapshot = createDeferred<unknown>();
      let snapshotCount = 0;
      const { client, request } = createBrowserClient(async (envelope) => {
        if (envelope.method === "DELETE" && envelope.path === "/tabs/background-tab") {
          return { ok: true };
        }
        if (envelope.path === "/tabs") {
          snapshotCount += 1;
          return await (snapshotCount === 1 ? previousSnapshot : closeSnapshot).promise;
        }
        throw new Error(`Unexpected browser route: ${envelope.method} ${envelope.path}`);
      });
      const controller = createBrowserPanelTestController(client, "active-tab", activeUrl);
      const previousView = controller.view;
      controller.tabs = [
        {
          id: "active-tab",
          targetId: "raw-active",
          title: "Active",
          url: activeUrl,
        },
        {
          id: "background-tab",
          targetId: "raw-background",
          title: "Background",
          url: "https://example.test/background",
        },
      ];

      const refresh = controller.refreshAll();
      await flushBrowserResponses();
      expect(controller.loading).toBe(true);

      const close = controller.closeTab("background-tab");
      await flushBrowserResponses();

      if (olderFailureOrder === "before") {
        previousSnapshot.reject(new Error("Superseded tab snapshot failed"));
        await refresh;
      }

      closeSnapshot.reject(new Error("Background close tab snapshot failed"));
      await close;

      expect(controller.activeTargetId).toBe("active-tab");
      expect(controller.view).toBe(previousView);
      expect(controller.loading).toBe(false);
      expect(controller.errorText).toBeNull();

      if (olderFailureOrder === "after") {
        previousSnapshot.reject(new Error("Superseded tab snapshot failed"));
        await refresh;
      }

      expect(snapshotCount).toBe(2);
      expect(controller.loading).toBe(false);
      expect(controller.errorText).toBeNull();
      expect(
        request.mock.calls.some(([, envelope]) => {
          return (envelope as { path?: string }).path === "/screenshot";
        }),
      ).toBe(false);
    },
  );

  it("does not let a failed background close clear a newer full refresh", async () => {
    const activeUrl = "https://example.test/active";
    const previousSnapshot = createDeferred<unknown>();
    const closeSnapshot = createDeferred<unknown>();
    const latestSnapshot = createDeferred<unknown>();
    let snapshotCount = 0;
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.method === "DELETE" && envelope.path === "/tabs/background-tab") {
        return { ok: true };
      }
      if (envelope.path === "/tabs") {
        const snapshot = [previousSnapshot, closeSnapshot, latestSnapshot][snapshotCount];
        snapshotCount += 1;
        if (!snapshot) {
          throw new Error("Unexpected additional tab snapshot");
        }
        return await snapshot.promise;
      }
      throw new Error(`Unexpected browser route: ${envelope.method} ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "active-tab", activeUrl);
    const previousView = controller.view;

    const previousRefresh = controller.refreshAll();
    await flushBrowserResponses();
    const close = controller.closeTab("background-tab");
    await flushBrowserResponses();
    const latestRefresh = controller.refreshAll();
    await flushBrowserResponses();

    closeSnapshot.reject(new Error("Superseded background close tab snapshot failed"));
    await close;

    expect(controller.loading).toBe(true);
    expect(controller.view).toBe(previousView);
    expect(controller.errorText).toBeNull();

    latestSnapshot.resolve({ running: true, tabs: [] });
    await latestRefresh;
    previousSnapshot.reject(new Error("Superseded first tab snapshot failed"));
    await previousRefresh;

    expect(snapshotCount).toBe(3);
    expect(controller.loading).toBe(false);
    expect(controller.errorText).toBeNull();
  });

  it.each(["reject", "resolve"] as const)(
    "does not let a stale snapshot start a capture that %ss during a new-tab mutation",
    async (completion) => {
      stubScreenshotMedia();
      const activeUrl = "https://example.test/active";
      const nextUrl = "https://example.test/new";
      const activeTab = createBrowserPanelTestTab("active-tab", activeUrl, "Active");
      const tabs = [activeTab];
      const previousSnapshot = createDeferred<{ running: boolean; tabs: typeof tabs }>();
      const openedTab = createDeferred<ReturnType<typeof createBrowserPanelTestTab>>();
      let snapshotCount = 0;
      const { client, request } = createBrowserClient(async (envelope) => {
        if (envelope.path === "/tabs") {
          snapshotCount += 1;
          return snapshotCount === 1
            ? await previousSnapshot.promise
            : { running: true, tabs: [...tabs] };
        }
        if (envelope.path === "/tabs/open") {
          const next = await openedTab.promise;
          tabs.push(next);
          return next;
        }
        if (envelope.path === "/screenshot") {
          if (envelope.body?.targetId === "active-tab") {
            if (completion === "reject") {
              throw new Error("Superseded snapshot capture failed");
            }
            return { path: "/old.png", targetId: "raw-active", url: activeUrl };
          }
          return { path: "/fresh.png", targetId: "raw-new", url: nextUrl };
        }
        if (envelope.path === "/act") {
          return createBrowserPanelTestMetrics(nextUrl, "New");
        }
        throw new Error(`Unexpected browser route: ${envelope.path}`);
      });
      const controller = createBrowserPanelTestController(client, "active-tab", activeUrl);
      const previousView = controller.view;

      const refresh = controller.refreshAll();
      await flushBrowserResponses();
      const opening = controller.openUrl(nextUrl, { newTab: true });
      previousSnapshot.resolve({ running: true, tabs: [activeTab] });
      await refresh;

      expect(controller.loading).toBe(true);
      expect(controller.errorText).toBeNull();
      expect(controller.view).toBe(previousView);
      expect(
        request.mock.calls.some(([, envelope]) => {
          const browserRequest = envelope as {
            path?: string;
            body?: { targetId?: string };
          };
          return (
            browserRequest.path === "/screenshot" && browserRequest.body?.targetId === "active-tab"
          );
        }),
      ).toBe(false);

      openedTab.resolve(createBrowserPanelTestTab("new-tab", nextUrl, "New"));
      await opening;

      expect(controller.activeTargetId).toBe("new-tab");
      expect(controller.view?.url).toBe(nextUrl);
      expect(controller.loading).toBe(false);
      expect(controller.errorText).toBeNull();
    },
  );
});
