import { describe, expect, it, vi } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  createDeferred,
  createInspectedNode,
  createPointer,
  createView,
  flushBrowserResponses,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "./browser-panel-controller.ts";

setupBrowserPanelTestCleanup();

describe("BrowserPanelController tab and lifecycle ownership", () => {
  it.each(["reject", "resolve"] as const)(
    "preserves pending new-tab ownership when the previous capture %ss",
    async (completion) => {
      stubScreenshotMedia();
      const previousCapture = createDeferred<unknown>();
      const openedTab = createDeferred<ReturnType<typeof createBrowserPanelTestTab>>();
      const activeUrl = "https://example.test/active";
      const newUrl = "https://example.test/new";
      const tabs = [createBrowserPanelTestTab("active-tab", activeUrl, "Active")];
      const { client } = createBrowserClient(async (envelope) => {
        if (envelope.path === "/tabs") {
          return { running: true, tabs: [...tabs] };
        }
        if (envelope.path === "/tabs/open") {
          const tab = await openedTab.promise;
          tabs.push(tab);
          return tab;
        }
        if (envelope.path === "/screenshot") {
          if (envelope.body?.targetId === "active-tab") {
            return await previousCapture.promise;
          }
          return { path: "/fresh.png", targetId: "raw-new", url: newUrl };
        }
        if (envelope.path === "/act") {
          return createBrowserPanelTestMetrics(newUrl, "New");
        }
        throw new Error(`Unexpected browser route: ${envelope.path}`);
      });
      const controller = createBrowserPanelTestController(client, "active-tab", activeUrl);
      const previousView = controller.view;

      const capture = controller.refreshAll();
      await flushBrowserResponses();
      const opening = controller.openUrl(newUrl, { newTab: true });
      expect(controller.loading).toBe(true);
      expect(controller.view).toBe(previousView);

      if (completion === "reject") {
        previousCapture.reject(new Error("Superseded capture failed"));
      } else {
        previousCapture.resolve({ path: "/old.png", targetId: "raw-active", url: activeUrl });
      }
      await capture;

      expect(controller.loading).toBe(true);
      expect(controller.errorText).toBeNull();
      expect(controller.view).toBe(previousView);

      openedTab.resolve(createBrowserPanelTestTab("new-tab", newUrl, "New"));
      await opening;

      expect(controller.activeTargetId).toBe("new-tab");
      expect(controller.view?.url).toBe(newUrl);
      expect(controller.loading).toBe(false);
      expect(controller.errorText).toBeNull();
    },
  );

  it("preserves the current screenshot when same-tab navigation is rejected", async () => {
    const previousCapture = createDeferred<unknown>();
    const navigation = createDeferred<unknown>();
    const initialUrl = "https://example.test/initial";
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        return {
          running: true,
          tabs: [{ tabId: "stable-tab", targetId: "raw-stable", title: "Page", url: initialUrl }],
        };
      }
      if (envelope.path === "/screenshot") {
        return await previousCapture.promise;
      }
      if (envelope.path === "/navigate") {
        return await navigation.promise;
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "stable-tab", initialUrl);
    const previousView = controller.view;
    const pendingCapture = controller.refreshAll();
    await flushBrowserResponses();

    const pendingNavigation = controller.openUrl("https://example.test/rejected", {
      newTab: false,
    });
    navigation.reject(new Error("Navigation rejected"));
    await pendingNavigation;
    previousCapture.resolve({ path: "/old.png", targetId: "raw-stable", url: initialUrl });
    await pendingCapture;

    expect(controller.activeTargetId).toBe("stable-tab");
    expect(controller.view).toBe(previousView);
    expect(controller.errorText).toBe("Browser request failed: Navigation rejected");
    expect(controller.loading).toBe(false);
  });

  it("keeps the newest document when overlapping same-tab navigations complete", async () => {
    stubScreenshotMedia();
    const initialUrl = "https://example.test/initial";
    const previousUrl = "https://example.test/previous";
    const latestUrl = "https://example.test/latest";
    const previous = createDeferred<{ targetId: string; url: string }>();
    const latest = createDeferred<{ targetId: string; url: string }>();
    let documentUrl = initialUrl;
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/navigate") {
        const result = await (envelope.body?.url === latestUrl ? latest : previous).promise;
        documentUrl = result.url;
        return result;
      }
      if (envelope.path === "/tabs") {
        return {
          running: true,
          tabs: [{ tabId: "stable-tab", targetId: "raw-stable", title: "Page", url: documentUrl }],
        };
      }
      if (envelope.path === "/screenshot") {
        return { path: "/fresh.png", targetId: "raw-stable", url: documentUrl };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(documentUrl);
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "stable-tab", initialUrl);

    const previousNavigation = controller.openUrl(previousUrl, { newTab: false });
    await flushBrowserResponses();
    const latestNavigation = controller.openUrl(latestUrl, { newTab: false });
    latest.resolve({ targetId: "raw-stable", url: latestUrl });
    await flushBrowserResponses();
    previous.resolve({ targetId: "raw-stable", url: previousUrl });
    await Promise.all([previousNavigation, latestNavigation]);

    expect(documentUrl).toBe(latestUrl);
    expect(controller.activeTargetId).toBe("stable-tab");
    expect(controller.view?.url).toBe(latestUrl);
    expect(controller.tabs[0]?.url).toBe(latestUrl);
    expect(
      request.mock.calls.filter(([, envelope]) => {
        return (envelope as BrowserRequestEnvelope).path === "/navigate";
      }),
    ).toHaveLength(2);
    expect(controller.loading).toBe(false);
  });

  it.each([
    { scenario: "a changed document URL", committedUrl: "https://example.test/committed" },
    { scenario: "the same document URL", committedUrl: "https://example.test/initial" },
  ])("recovers $scenario when a queued navigation is rejected", async ({ committedUrl }) => {
    stubScreenshotMedia();
    const initialUrl = "https://example.test/initial";
    const rejectedUrl = "https://example.test/rejected";
    const committedNavigation = createDeferred<{ targetId: string; url: string }>();
    let documentUrl = initialUrl;
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/navigate") {
        if (envelope.body?.url === rejectedUrl) {
          throw new Error("Latest navigation rejected");
        }
        const result = await committedNavigation.promise;
        documentUrl = result.url;
        return result;
      }
      if (envelope.path === "/tabs") {
        return {
          running: true,
          tabs: [{ tabId: "stable-tab", targetId: "raw-stable", title: "Page", url: documentUrl }],
        };
      }
      if (envelope.path === "/screenshot") {
        return { path: "/fresh.png", targetId: "raw-stable", url: documentUrl };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(documentUrl);
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "stable-tab", initialUrl);

    const previous = controller.openUrl(committedUrl, { newTab: false });
    await flushBrowserResponses();
    const latest = controller.openUrl(rejectedUrl, { newTab: false });
    committedNavigation.resolve({ targetId: "raw-stable", url: committedUrl });
    await Promise.all([previous, latest]);

    expect(controller.activeTargetId).toBe("stable-tab");
    expect(controller.tabs[0]?.url).toBe(committedUrl);
    expect(controller.view?.url).toBe(committedUrl);
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.errorText).toBe("Browser request failed: Latest navigation rejected");
    expect(controller.loading).toBe(false);
    expect(
      request.mock.calls.filter(([, envelope]) => {
        return (envelope as BrowserRequestEnvelope).path === "/navigate";
      }),
    ).toHaveLength(2);
  });

  it("recovers a committed document after its predecessor leaves the navigation queue", async () => {
    stubScreenshotMedia();
    const initialUrl = "https://example.test/initial";
    const committedUrl = "https://example.test/committed";
    const previousSnapshot = createDeferred<unknown>();
    let documentUrl = initialUrl;
    let snapshotCount = 0;
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/navigate") {
        if (envelope.body?.url === "https://example.test/rejected") {
          throw new Error("Latest navigation rejected");
        }
        documentUrl = committedUrl;
        return { targetId: "raw-stable", url: committedUrl };
      }
      if (envelope.path === "/tabs") {
        snapshotCount += 1;
        if (snapshotCount === 1) {
          return await previousSnapshot.promise;
        }
        return {
          running: true,
          tabs: [{ tabId: "stable-tab", targetId: "raw-stable", title: "Page", url: documentUrl }],
        };
      }
      if (envelope.path === "/screenshot") {
        return { path: "/fresh.png", targetId: "raw-stable", url: documentUrl };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(documentUrl);
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "stable-tab", initialUrl);

    const previous = controller.openUrl(committedUrl, { newTab: false });
    await flushBrowserResponses();
    expect(snapshotCount).toBe(1);
    const latest = controller.openUrl("https://example.test/rejected", { newTab: false });
    await latest;

    expect(controller.view?.url).toBe(committedUrl);
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.errorText).toBe("Browser request failed: Latest navigation rejected");

    previousSnapshot.resolve({ running: true, tabs: [] });
    await previous;
    expect(controller.loading).toBe(false);
  });

  it.each(["tabs", "screenshot"] as const)(
    "keeps the original navigation error when best-effort %s recovery fails",
    async (failedRecovery) => {
      const initialUrl = "https://example.test/initial";
      const committedUrl = "https://example.test/committed";
      const committedNavigation = createDeferred<{ targetId: string; url: string }>();
      const { client } = createBrowserClient(async (envelope) => {
        if (envelope.path === "/navigate") {
          if (envelope.body?.url === "https://example.test/rejected") {
            throw new Error("Original navigation rejected");
          }
          return await committedNavigation.promise;
        }
        if (envelope.path === "/tabs") {
          if (failedRecovery === "tabs") {
            throw new Error("Best-effort tab recovery failed");
          }
          return {
            running: true,
            tabs: [
              { tabId: "stable-tab", targetId: "raw-stable", title: "Page", url: committedUrl },
            ],
          };
        }
        if (envelope.path === "/screenshot") {
          throw new Error("Best-effort screenshot recovery failed");
        }
        throw new Error(`Unexpected browser route: ${envelope.path}`);
      });
      const controller = createBrowserPanelTestController(client, "stable-tab", initialUrl);

      const previous = controller.openUrl(committedUrl, { newTab: false });
      await flushBrowserResponses();
      const latest = controller.openUrl("https://example.test/rejected", { newTab: false });
      committedNavigation.resolve({ targetId: "raw-stable", url: committedUrl });
      await expect(Promise.all([previous, latest])).resolves.toEqual([undefined, undefined]);

      expect(controller.errorText).toBe("Browser request failed: Original navigation rejected");
      expect(controller.loading).toBe(false);
    },
  );

  it("does not capture a navigation target removed during failure reconciliation", async () => {
    const initialUrl = "https://example.test/initial";
    const committedUrl = "https://example.test/committed";
    const committedNavigation = createDeferred<{ targetId: string; url: string }>();
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/navigate") {
        if (envelope.body?.url === "https://example.test/rejected") {
          throw new Error("Original navigation rejected");
        }
        return await committedNavigation.promise;
      }
      if (envelope.path === "/tabs") {
        return { running: true, tabs: [] };
      }
      if (envelope.path === "/screenshot") {
        throw new Error("Removed tab must never be captured");
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "stable-tab", initialUrl);

    const previous = controller.openUrl(committedUrl, { newTab: false });
    await flushBrowserResponses();
    const latest = controller.openUrl("https://example.test/rejected", { newTab: false });
    committedNavigation.resolve({ targetId: "raw-stable", url: committedUrl });
    await expect(Promise.all([previous, latest])).resolves.toEqual([undefined, undefined]);

    expect(controller.tabs).toEqual([]);
    expect(controller.errorText).toBe("Browser request failed: Original navigation rejected");
    expect(controller.loading).toBe(false);
    expect(
      request.mock.calls.some(([, envelope]) => {
        return (envelope as BrowserRequestEnvelope).path === "/screenshot";
      }),
    ).toBe(false);
  });

  it("reconciles a late-created tab without replacing the newest selected tab", async () => {
    stubScreenshotMedia();
    const previousOpen = createDeferred<ReturnType<typeof createBrowserPanelTestTab>>();
    const latestOpen = createDeferred<ReturnType<typeof createBrowserPanelTestTab>>();
    const latestUrl = "https://example.test/latest";
    const visibleTabs = [
      createBrowserPanelTestTab("initial-tab", "https://example.test/initial", "Initial"),
    ];
    let screenshotCount = 0;
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs/open") {
        const tab = await (envelope.body?.url === latestUrl ? latestOpen : previousOpen).promise;
        visibleTabs.push(tab);
        return tab;
      }
      if (envelope.path === "/tabs") {
        return { running: true, tabs: [...visibleTabs] };
      }
      if (envelope.path === "/screenshot") {
        screenshotCount += 1;
        return { path: "/fresh.png", targetId: "raw-latest", url: latestUrl };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(latestUrl, "Latest");
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "initial-tab");

    const previousNavigation = controller.openUrl("https://example.test/previous", {
      newTab: true,
    });
    const latestNavigation = controller.openUrl(latestUrl, { newTab: true });
    latestOpen.resolve(createBrowserPanelTestTab("latest-tab", latestUrl, "Latest"));
    await latestNavigation;
    const latestView = controller.view;
    previousOpen.resolve(
      createBrowserPanelTestTab("previous-tab", "https://example.test/previous", "Previous"),
    );
    await previousNavigation;

    expect(controller.tabs.map((tab) => tab.id)).toEqual([
      "initial-tab",
      "latest-tab",
      "previous-tab",
    ]);
    expect(controller.activeTargetId).toBe("latest-tab");
    expect(controller.view).toBe(latestView);
    expect(screenshotCount).toBe(1);
    expect(controller.loading).toBe(false);
    expect(controller.errorText).toBeNull();
  });

  it("rejects an old tab-open snapshot after a newer full refresh", async () => {
    stubScreenshotMedia();
    const previousSnapshot = createDeferred<unknown>();
    const latestUrl = "https://example.test/latest";
    const previousUrl = "https://example.test/previous";
    let snapshotCount = 0;
    let screenshotCount = 0;
    let screenshotUrl = latestUrl;
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs/open") {
        return createBrowserPanelTestTab("opened-tab", latestUrl, "Opened");
      }
      if (envelope.path === "/tabs") {
        snapshotCount += 1;
        if (snapshotCount === 1) {
          return await previousSnapshot.promise;
        }
        return {
          running: true,
          tabs: [
            { tabId: "opened-tab", targetId: "raw-opened", title: "Opened", url: latestUrl },
            { tabId: "latest-tab", targetId: "raw-latest", title: "Latest", url: latestUrl },
          ],
        };
      }
      if (envelope.path === "/screenshot") {
        screenshotCount += 1;
        screenshotUrl = screenshotCount === 1 ? latestUrl : previousUrl;
        return {
          path: screenshotCount === 1 ? "/fresh.png" : "/old.png",
          targetId: "raw-opened",
          url: screenshotUrl,
        };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(screenshotUrl, "Opened");
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "initial-tab");

    const previousNavigation = controller.openUrl(latestUrl, { newTab: true });
    await flushBrowserResponses();
    const latestRefresh = controller.refreshAll();
    await latestRefresh;
    previousSnapshot.resolve({
      running: true,
      tabs: [
        { tabId: "opened-tab", targetId: "raw-opened", title: "Previous", url: previousUrl },
        createBrowserPanelTestTab("previous-tab", previousUrl, "Previous tab"),
      ],
    });
    await previousNavigation;

    expect(controller.activeTargetId).toBe("opened-tab");
    expect(controller.tabs.map((tab) => tab.id)).toEqual(["opened-tab", "latest-tab"]);
    expect(controller.view?.url).toBe(latestUrl);
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(screenshotCount).toBe(1);
    expect(controller.loading).toBe(false);
  });

  it("keeps the newest tab snapshot when overlapping refreshes finish out of order", async () => {
    stubScreenshotMedia();
    const previousSnapshot = createDeferred<unknown>();
    const latestSnapshot = createDeferred<unknown>();
    const snapshots = [previousSnapshot, latestSnapshot];
    const latestUrl = "https://example.test/latest";
    const previousUrl = "https://example.test/previous";
    let screenshotCount = 0;
    let screenshotUrl = latestUrl;
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        const snapshot = snapshots.shift();
        if (!snapshot) {
          throw new Error("Unexpected browser snapshot");
        }
        return await snapshot.promise;
      }
      if (envelope.path === "/screenshot") {
        screenshotCount += 1;
        screenshotUrl = screenshotCount === 1 ? latestUrl : previousUrl;
        return {
          path: screenshotCount === 1 ? "/fresh.png" : "/old.png",
          targetId: "raw-stable",
          url: screenshotUrl,
        };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(screenshotUrl, "Stable");
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "stable-tab");

    const previousRefresh = controller.refreshAll();
    const latestRefresh = controller.refreshAll();
    latestSnapshot.resolve({
      running: true,
      tabs: [
        { tabId: "stable-tab", targetId: "raw-stable", title: "Latest", url: latestUrl },
        { tabId: "latest-tab", targetId: "raw-latest", title: "Latest tab", url: latestUrl },
      ],
    });
    await latestRefresh;
    previousSnapshot.resolve({
      running: true,
      tabs: [
        { tabId: "stable-tab", targetId: "raw-stable", title: "Previous", url: previousUrl },
        createBrowserPanelTestTab("previous-tab", previousUrl, "Previous tab"),
      ],
    });
    await previousRefresh;

    expect(controller.tabs.map((tab) => tab.id)).toEqual(["stable-tab", "latest-tab"]);
    expect(controller.activeTargetId).toBe("stable-tab");
    expect(controller.view?.url).toBe(latestUrl);
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(screenshotCount).toBe(1);
    expect(controller.loading).toBe(false);
  });

  it("keeps a newer tab open when an older snapshot would replace the active tab", async () => {
    stubScreenshotMedia();
    const previousSnapshot = createDeferred<unknown>();
    const latestOpen = createDeferred<ReturnType<typeof createBrowserPanelTestTab>>();
    const latestUrl = "https://example.test/latest";
    let snapshotCount = 0;
    let visibleTab = createBrowserPanelTestTab(
      "initial-tab",
      "https://example.test/initial",
      "Initial",
    );
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        snapshotCount += 1;
        if (snapshotCount === 1) {
          return await previousSnapshot.promise;
        }
        return { running: true, tabs: [visibleTab] };
      }
      if (envelope.path === "/tabs/open") {
        visibleTab = await latestOpen.promise;
        return visibleTab;
      }
      if (envelope.path === "/screenshot") {
        const latest = envelope.body?.targetId === "latest-tab";
        return {
          path: latest ? "/fresh.png" : "/old.png",
          targetId: latest ? "raw-latest" : "raw-previous",
          url: latest ? latestUrl : "https://example.test/previous",
        };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(visibleTab.url, visibleTab.title);
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "initial-tab", visibleTab.url);

    const previousRefresh = controller.refreshAll();
    const latestNavigation = controller.openUrl(latestUrl, { newTab: true });
    previousSnapshot.resolve({
      running: true,
      tabs: [
        createBrowserPanelTestTab("previous-tab", "https://example.test/previous", "Previous"),
      ],
    });
    await previousRefresh;
    expect(controller.loading).toBe(true);
    latestOpen.resolve(createBrowserPanelTestTab("latest-tab", latestUrl, "Latest"));
    await latestNavigation;

    expect(controller.activeTargetId).toBe("latest-tab");
    expect(controller.tabs.map((tab) => tab.id)).toEqual(["latest-tab"]);
    expect(controller.view?.url).toBe(latestUrl);
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.loading).toBe(false);
  });

  it("keeps the newest new-tab invocation when the older open resolves first", async () => {
    stubScreenshotMedia();
    const previousOpen = createDeferred<ReturnType<typeof createBrowserPanelTestTab>>();
    const latestOpen = createDeferred<ReturnType<typeof createBrowserPanelTestTab>>();
    const latestUrl = "https://example.test/latest";
    let visibleTab = createBrowserPanelTestTab(
      "initial-tab",
      "https://example.test/initial",
      "Initial",
    );
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs/open") {
        visibleTab = await (envelope.body?.url === latestUrl ? latestOpen : previousOpen).promise;
        return visibleTab;
      }
      if (envelope.path === "/tabs") {
        return { running: true, tabs: [visibleTab] };
      }
      if (envelope.path === "/screenshot") {
        return {
          path: visibleTab.tabId === "latest-tab" ? "/fresh.png" : "/old.png",
          targetId: visibleTab.targetId,
          url: visibleTab.url,
        };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(visibleTab.url, visibleTab.title);
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "initial-tab", visibleTab.url);

    const previousNavigation = controller.openUrl("https://example.test/previous", {
      newTab: true,
    });
    const latestNavigation = controller.openUrl(latestUrl, { newTab: true });
    previousOpen.resolve(
      createBrowserPanelTestTab("previous-tab", "https://example.test/previous", "Previous"),
    );
    await previousNavigation;
    expect(controller.loading).toBe(true);
    latestOpen.resolve(createBrowserPanelTestTab("latest-tab", latestUrl, "Latest"));
    await latestNavigation;

    expect(controller.activeTargetId).toBe("latest-tab");
    expect(controller.tabs.map((tab) => tab.id)).toEqual(["latest-tab"]);
    expect(controller.view?.url).toBe(latestUrl);
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.loading).toBe(false);
    expect(
      request.mock.calls.filter(([, envelope]) => {
        return (envelope as BrowserRequestEnvelope).path === "/tabs/open";
      }),
    ).toHaveLength(2);
  });

  it("clears loading when the final active tab is closed", async () => {
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.method === "DELETE" && envelope.path === "/tabs/tab-a") {
        return { ok: true };
      }
      if (envelope.method === "GET" && envelope.path === "/tabs") {
        return { running: true, tabs: [] };
      }
      throw new Error(`Unexpected browser route: ${envelope.method} ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a");
    controller.loading = true;

    await controller.closeTab("tab-a");

    expect(request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ method: "DELETE", path: "/tabs/tab-a" }),
    );
    expect(request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ method: "GET", path: "/tabs" }),
    );
    expect(controller.activeTargetId).toBeNull();
    expect(controller.view).toBeNull();
    expect(controller.loading).toBe(false);
  });

  it("invalidates old-document inspection and wheel input before same-tab navigation", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const previousInspection = createDeferred<unknown>();
    const firstNavigation = createDeferred<unknown>();
    const inspected = createBrowserClient(async (envelope) => {
      if (envelope.path === "/act") {
        return await previousInspection.promise;
      }
      if (envelope.path === "/navigate") {
        return await firstNavigation.promise;
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const inspectedHost = new TestBrowserPanelHost(inspected.client);
    const inspectedController = new BrowserPanelController(inspectedHost);
    inspectedController.activeTargetId = "stable-tab";
    inspectedController.view = createView("stable-tab");
    inspectedController.setMode("inspect");

    inspectedController.handleOverlayPointerMove(createPointer(10, 20));
    void inspectedController.openUrl("https://example.test/destination", { newTab: false });
    previousInspection.resolve({ result: createInspectedNode("previous-document") });
    await flushBrowserResponses();

    expect(inspected.request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        method: "POST",
        path: "/navigate",
        body: { url: "https://example.test/destination", targetId: "stable-tab" },
      }),
    );
    expect(inspectedController.activeTargetId).toBe("stable-tab");
    expect(inspectedController.inspected).toBeNull();

    const secondNavigation = createDeferred<unknown>();
    const wheeled = createBrowserClient(async (envelope) => {
      if (envelope.path === "/navigate") {
        return await secondNavigation.promise;
      }
      if (envelope.path === "/act") {
        return { result: true };
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const wheeledHost = new TestBrowserPanelHost(wheeled.client);
    const wheeledController = new BrowserPanelController(wheeledHost);
    wheeledController.activeTargetId = "stable-tab";
    wheeledController.view = createView("stable-tab");
    wheeledController.handleWheel(new WheelEvent("wheel", { deltaY: 60, cancelable: true }));

    void wheeledController.openUrl("https://example.test/destination", { newTab: false });
    await vi.advanceTimersByTimeAsync(150);

    expect(wheeledController.activeTargetId).toBe("stable-tab");
    expect(
      wheeled.request.mock.calls.filter(([, envelope]) => {
        return (envelope as BrowserRequestEnvelope).path === "/act";
      }),
    ).toHaveLength(0);
  });

  it("clears loading and rejects an in-flight refresh after disconnection", async () => {
    const previousCapture = createDeferred<unknown>();
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        return {
          running: true,
          tabs: [
            {
              tabId: "stable-tab",
              targetId: "raw-tab",
              title: "Previous",
              url: "https://example.test/previous",
            },
          ],
        };
      }
      if (envelope.path === "/screenshot") {
        return await previousCapture.promise;
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const host = new TestBrowserPanelHost(client);
    const controller = new BrowserPanelController(host);
    const previousView = createView("stable-tab", "https://example.test/previous");
    controller.activeTargetId = "stable-tab";
    controller.view = previousView;

    const pendingRefresh = controller.refreshAll();
    await flushBrowserResponses();
    expect(controller.loading).toBe(true);

    host.isConnected = false;
    controller.hostDisconnected();
    expect(controller.loading).toBe(false);

    host.isConnected = true;
    previousCapture.resolve({
      path: "/old.png",
      targetId: "raw-tab",
      url: "https://example.test/previous",
    });
    await pendingRefresh;

    expect(controller.activeTargetId).toBe("stable-tab");
    expect(controller.view).toBe(previousView);
    expect(controller.loading).toBe(false);
  });

  it("keeps the latest tab capture when an older focus resolves afterward", async () => {
    stubScreenshotMedia();
    const previousFocus = createDeferred<unknown>();
    const latestFocus = createDeferred<unknown>();
    const latestCapture = createDeferred<unknown>();
    const latestUrl = "https://example.test/latest";
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs/focus") {
        return await (envelope.body?.targetId === "tab-a" ? previousFocus : latestFocus).promise;
      }
      if (envelope.path === "/screenshot") {
        if (envelope.body?.targetId === "tab-b") {
          return await latestCapture.promise;
        }
        return {
          path: "/old.png",
          targetId: "raw-a",
          url: "https://example.test/old",
        };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(latestUrl, "Latest");
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-initial");

    const previousSelection = controller.selectTab("tab-a");
    const latestSelection = controller.selectTab("tab-b");
    latestFocus.resolve({ ok: true });
    await flushBrowserResponses();
    previousFocus.resolve({ ok: true });
    await previousSelection;
    latestCapture.resolve({ path: "/fresh.png", targetId: "raw-b", url: latestUrl });
    await latestSelection;

    expect(controller.activeTargetId).toBe("tab-b");
    expect(controller.view?.targetId).toBe("tab-b");
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.loading).toBe(false);
    const screenshots = request.mock.calls.filter(([, envelope]) => {
      return (envelope as BrowserRequestEnvelope).path === "/screenshot";
    });
    expect(screenshots).toHaveLength(1);
    expect(screenshots[0]?.[1]).toMatchObject({ body: { targetId: "tab-b" } });
  });

  it("does not disable a replacement gateway after an old inspection rejects", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const previousInspection = createDeferred<unknown>();
    const previous = createBrowserClient(async () => await previousInspection.promise);
    const replacement = createBrowserClient(async () => ({ running: true, tabs: [] }));
    const host = new TestBrowserPanelHost(previous.client);
    const controller = new BrowserPanelController(host);
    controller.activeTargetId = "tab-a";
    controller.view = createView("tab-a");
    controller.setMode("inspect");
    controller.handleOverlayPointerMove(createPointer(10, 20));

    host.open = false;
    host.client = replacement.client;
    controller.synchronizeHostProperties(new Map([["client", previous.client]]));
    host.open = true;
    controller.activeTargetId = "tab-b";
    controller.view = createView("tab-b");
    controller.setMode("inspect");
    previousInspection.reject(new Error("browser evaluateEnabled=false"));
    await flushBrowserResponses();

    expect(controller.evaluateUnavailable).toBe(false);
    expect(controller.mode).toBe("inspect");
    expect(controller.errorText).toBeNull();
  });
  it("preserves normal coalesced wheel actions on their original tab", async () => {
    vi.useFakeTimers();
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/act") {
        return { result: true };
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a");

    controller.handleWheel(new WheelEvent("wheel", { deltaX: 2, deltaY: 10, cancelable: true }));
    controller.handleWheel(new WheelEvent("wheel", { deltaX: 3, deltaY: 20, cancelable: true }));
    await vi.advanceTimersByTimeAsync(150);

    expect(request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        method: "POST",
        path: "/act",
        body: expect.objectContaining({
          kind: "evaluate",
          targetId: "tab-a",
          fn: expect.stringContaining("window.scrollBy(5, 30)"),
        }),
      }),
    );
  });
});
