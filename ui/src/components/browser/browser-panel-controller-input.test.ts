import { nothing, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
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
import { renderBrowserPanelChrome } from "./browser-panel-render.ts";

setupBrowserPanelTestCleanup();

describe("BrowserPanelController capture and input ownership", () => {
  it("restores the prior selected screenshot when tab focus is rejected", async () => {
    const previousCapture = createDeferred<unknown>();
    const focus = createDeferred<unknown>();
    const initialUrl = "https://example.test/initial";
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        return {
          running: true,
          tabs: [{ tabId: "active-tab", targetId: "raw-active", title: "Page", url: initialUrl }],
        };
      }
      if (envelope.path === "/screenshot") {
        return await previousCapture.promise;
      }
      if (envelope.path === "/tabs/focus") {
        return await focus.promise;
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "active-tab", initialUrl);
    const previousView = controller.view;
    const pendingCapture = controller.refreshAll();
    await flushBrowserResponses();

    const pendingSelection = controller.selectTab("next-tab");
    focus.reject(new Error("Tab focus rejected"));
    await pendingSelection;
    previousCapture.resolve({ path: "/old.png", targetId: "raw-active", url: initialUrl });
    await pendingCapture;

    expect(controller.activeTargetId).toBe("active-tab");
    expect(controller.view).toBe(previousView);
    expect(controller.errorText).toBe("Browser request failed: Tab focus rejected");
    expect(controller.loading).toBe(false);
  });

  it.each(["navigation", "focus rejection"] as const)(
    "does not restore a stale view when %s settles first",
    async (first) => {
      const navigation = createDeferred<{ ok: boolean }>();
      const focus = createDeferred<{ ok: boolean }>();
      const initialUrl = "https://example.test/initial";
      const destinationUrl = "https://example.test/destination";
      const { client, request } = createBrowserClient(async (envelope) => {
        if (envelope.path === "/navigate") {
          return await navigation.promise;
        }
        if (envelope.path === "/tabs/focus") {
          return await focus.promise;
        }
        throw new Error(`Unexpected browser route: ${envelope.path}`);
      });
      const controller = createBrowserPanelTestController(client, "tab-a", initialUrl);
      controller.tabs = [
        { id: "tab-a", targetId: "raw-a", title: "Initial", url: initialUrl },
        {
          id: "tab-b",
          targetId: "raw-b",
          title: "Selected",
          url: "https://example.test/selected",
        },
      ];

      const pendingNavigation = controller.openUrl(destinationUrl, { newTab: false });
      await flushBrowserResponses();
      const pendingSelection = controller.selectTab("tab-b");
      if (first === "navigation") {
        navigation.resolve({ ok: true });
        await pendingNavigation;
        focus.reject(new Error("Tab focus rejected"));
        await pendingSelection;
      } else {
        focus.reject(new Error("Tab focus rejected"));
        await pendingSelection;
        navigation.resolve({ ok: true });
        await pendingNavigation;
      }

      expect(controller.activeTargetId).toBeNull();
      expect(controller.view).toBeNull();
      expect(controller.urlDraft).toBe("");
      expect(controller.errorText).toBe("Browser request failed: Tab focus rejected");
      expect(
        request.mock.calls.filter(([, envelope]) => {
          return (envelope as BrowserRequestEnvelope).path === "/tabs";
        }),
      ).toEqual([]);
    },
  );

  it("retains a newly opened tab after its original active tab closes", async () => {
    stubScreenshotMedia();
    const newUrl = "https://example.test/new";
    const activeUrl = "https://example.test/active";
    const fallbackUrl = "https://example.test/fallback";
    const openedTab = createDeferred<ReturnType<typeof createBrowserPanelTestTab>>();
    let visibleTabs = [
      createBrowserPanelTestTab("active-tab", activeUrl, "Active"),
      createBrowserPanelTestTab("fallback-tab", fallbackUrl, "Fallback"),
    ];
    let screenshotCount = 0;
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs/open") {
        const tab = await openedTab.promise;
        visibleTabs.push(tab);
        return tab;
      }
      if (envelope.method === "DELETE" && envelope.path === "/tabs/active-tab") {
        visibleTabs = visibleTabs.filter((tab) => tab.tabId !== "active-tab");
        return { ok: true };
      }
      if (envelope.path === "/tabs") {
        return { running: true, tabs: [...visibleTabs] };
      }
      if (envelope.path === "/screenshot") {
        screenshotCount += 1;
        return { path: "/fresh.png", targetId: "raw-fallback", url: fallbackUrl };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(fallbackUrl, "Fallback");
      }
      throw new Error(`Unexpected browser route: ${envelope.method} ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "active-tab", activeUrl);

    const opening = controller.openUrl(newUrl, { newTab: true });
    await flushBrowserResponses();
    await controller.closeTab("active-tab");
    const fallbackView = controller.view;
    openedTab.resolve(createBrowserPanelTestTab("new-tab", newUrl, "New"));
    await opening;

    expect(controller.tabs.map((tab) => tab.id)).toEqual(["fallback-tab", "new-tab"]);
    expect(controller.activeTargetId).toBe("fallback-tab");
    expect(controller.view).toBe(fallbackView);
    expect(screenshotCount).toBe(1);
    expect(controller.loading).toBe(false);
  });

  it("reconciles a background tab closed while it becomes selected", async () => {
    stubScreenshotMedia();
    const closing = createDeferred<{ ok: boolean }>();
    const activeUrl = "https://example.test/active";
    let closed = false;
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.method === "DELETE" && envelope.path === "/tabs/background-tab") {
        const result = await closing.promise;
        closed = true;
        return result;
      }
      if (envelope.path === "/tabs/focus") {
        return { ok: true };
      }
      if (envelope.path === "/tabs") {
        const tabs = [
          { tabId: "active-tab", targetId: "raw-active", title: "Active", url: activeUrl },
        ];
        if (!closed) {
          tabs.push({
            tabId: "background-tab",
            targetId: "raw-background",
            title: "Background",
            url: "https://example.test/background",
          });
        }
        return { running: true, tabs };
      }
      if (envelope.path === "/screenshot") {
        const background = envelope.body?.targetId === "background-tab";
        return {
          path: "/fresh.png",
          targetId: background ? "raw-background" : "raw-active",
          url: background ? "https://example.test/background" : activeUrl,
        };
      }
      if (envelope.path === "/act") {
        const background = envelope.body?.targetId === "background-tab";
        return createBrowserPanelTestMetrics(
          background ? "https://example.test/background" : activeUrl,
          background ? "Background" : "Active",
        );
      }
      throw new Error(`Unexpected browser route: ${envelope.method} ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "active-tab", activeUrl);

    const pendingClose = controller.closeTab("background-tab");
    await flushBrowserResponses();
    await controller.selectTab("background-tab");
    closing.resolve({ ok: true });
    await pendingClose;

    expect(closed).toBe(true);
    expect(controller.tabs.map((tab) => tab.id)).toEqual(["active-tab"]);
    expect(controller.activeTargetId).toBe("active-tab");
    expect(controller.view?.url).toBe(activeUrl);
    expect(controller.loading).toBe(false);
  });

  it("captures a successfully navigated document when its tab snapshot fails", async () => {
    stubScreenshotMedia();
    const navigation = createDeferred<{ ok: boolean }>();
    const initialUrl = "https://example.test/initial";
    const destinationUrl = "https://example.test/destination";
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/navigate") {
        return await navigation.promise;
      }
      if (envelope.path === "/tabs") {
        throw new Error("Temporary tab-list failure");
      }
      if (envelope.path === "/screenshot") {
        return { path: "/fresh.png", targetId: "raw-stable", url: destinationUrl };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(destinationUrl);
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "stable-tab", initialUrl);

    const pendingNavigation = controller.openUrl(destinationUrl, { newTab: false });
    await flushBrowserResponses();
    navigation.resolve({ ok: true });
    await pendingNavigation;

    expect(request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        method: "POST",
        path: "/screenshot",
        body: expect.objectContaining({ targetId: "stable-tab" }),
      }),
    );
    expect(controller.activeTargetId).toBe("stable-tab");
    expect(controller.view?.url).toBe(destinationUrl);
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.loading).toBe(false);
  });

  it("settles loading when a non-active close supersedes a full refresh", async () => {
    const previousSnapshot = createDeferred<unknown>();
    const activeUrl = "https://example.test/active";
    const activeTab = {
      tabId: "active-tab",
      targetId: "raw-active",
      title: "Active",
      url: activeUrl,
    };
    let snapshotCount = 0;
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.method === "DELETE" && envelope.path === "/tabs/background-tab") {
        return { ok: true };
      }
      if (envelope.path === "/tabs") {
        snapshotCount += 1;
        if (snapshotCount === 1) {
          return await previousSnapshot.promise;
        }
        return { running: true, tabs: [activeTab] };
      }
      throw new Error(`Unexpected browser route: ${envelope.method} ${envelope.path}`);
    });
    const controller = new BrowserPanelController(new TestBrowserPanelHost(client));
    controller.activeTargetId = "active-tab";
    const activeView = createView("active-tab", activeUrl);
    controller.view = activeView;
    controller.tabs = [
      { id: "active-tab", targetId: "raw-active", title: "Active", url: activeUrl },
      {
        id: "background-tab",
        targetId: "raw-background",
        title: "Background",
        url: "https://example.test/background",
      },
    ];

    const pendingRefresh = controller.refreshAll();
    await flushBrowserResponses();
    expect(controller.loading).toBe(true);
    await controller.closeTab("background-tab");

    expect(request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({ method: "DELETE", path: "/tabs/background-tab" }),
    );
    expect(controller.activeTargetId).toBe("active-tab");
    expect(controller.tabs.map((tab) => tab.id)).toEqual(["active-tab"]);
    expect(controller.view).toBe(activeView);
    expect(controller.loading).toBe(false);

    previousSnapshot.resolve({ running: true, tabs: [activeTab] });
    await pendingRefresh;
    expect(controller.loading).toBe(false);
    expect(controller.view).toBe(activeView);
  });

  it("keeps loading while closing a background tab during an owned capture", async () => {
    stubScreenshotMedia();
    const pendingCapture = createDeferred<{
      path: string;
      targetId: string;
      url: string;
    }>();
    const activeUrl = "https://example.test/active";
    const activeTab = {
      tabId: "active-tab",
      targetId: "raw-active",
      title: "Active",
      url: activeUrl,
    };
    let snapshotCount = 0;
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.method === "DELETE" && envelope.path === "/tabs/background-tab") {
        return { ok: true };
      }
      if (envelope.path === "/tabs") {
        snapshotCount += 1;
        const tabs =
          snapshotCount === 1
            ? [
                activeTab,
                {
                  tabId: "background-tab",
                  targetId: "raw-background",
                  title: "Background",
                  url: "https://example.test/background",
                },
              ]
            : [activeTab];
        return { running: true, tabs };
      }
      if (envelope.path === "/screenshot") {
        return await pendingCapture.promise;
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(activeUrl, "Active");
      }
      throw new Error(`Unexpected browser route: ${envelope.method} ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "active-tab", activeUrl);

    const capture = controller.refreshAll();
    await flushBrowserResponses();
    expect(controller.loading).toBe(true);

    await controller.closeTab("background-tab");
    expect(controller.loading).toBe(true);

    pendingCapture.resolve({ path: "/fresh.png", targetId: "raw-active", url: activeUrl });
    await capture;

    expect(controller.view?.url).toBe(activeUrl);
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.loading).toBe(false);
  });

  it("finishes same-tab navigation after a passive refresh overtakes it", async () => {
    stubScreenshotMedia();
    const navigation = createDeferred<{ ok: boolean }>();
    const initialUrl = "https://example.test/initial";
    const destinationUrl = "https://example.test/destination";
    let documentUrl = initialUrl;
    let screenshotCount = 0;
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/navigate") {
        const result = await navigation.promise;
        documentUrl = destinationUrl;
        return result;
      }
      if (envelope.path === "/tabs") {
        return {
          running: true,
          tabs: [{ tabId: "stable-tab", targetId: "raw-stable", title: "Page", url: documentUrl }],
        };
      }
      if (envelope.path === "/screenshot") {
        screenshotCount += 1;
        return {
          path: documentUrl === destinationUrl ? "/fresh.png" : "/old.png",
          targetId: "raw-stable",
          url: documentUrl,
        };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(documentUrl);
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "stable-tab", initialUrl);

    const pendingNavigation = controller.openUrl(destinationUrl, { newTab: false });
    await flushBrowserResponses();
    await controller.refreshAll();
    navigation.resolve({ ok: true });
    await pendingNavigation;

    expect(request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        method: "POST",
        path: "/navigate",
        body: { targetId: "stable-tab", url: destinationUrl },
      }),
    );
    expect(controller.activeTargetId).toBe("stable-tab");
    expect(controller.tabs[0]?.url).toBe(destinationUrl);
    expect(controller.view?.url).toBe(destinationUrl);
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(screenshotCount).toBe(2);
    expect(controller.loading).toBe(false);
  });

  it("does not poll tab metadata after a committed background navigation", async () => {
    stubScreenshotMedia();
    const navigation = createDeferred<{ ok: boolean }>();
    const initialUrl = "https://example.test/initial";
    const destinationUrl = "https://example.test/destination";
    const selectedUrl = "https://example.test/selected";
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/navigate") {
        return await navigation.promise;
      }
      if (envelope.path === "/tabs/focus") {
        return { ok: true };
      }
      if (envelope.path === "/screenshot") {
        return { path: "/selected.png", targetId: "raw-b", url: selectedUrl };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(selectedUrl, "Selected");
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a", initialUrl);
    controller.tabs = [
      { id: "tab-a", targetId: "raw-a", title: "Initial", url: initialUrl },
      { id: "tab-b", targetId: "raw-b", title: "Selected", url: selectedUrl },
    ];

    const pendingNavigation = controller.openUrl(destinationUrl, { newTab: false });
    await flushBrowserResponses();
    await controller.selectTab("tab-b");
    navigation.resolve({ ok: true });
    await pendingNavigation;

    expect(controller.activeTargetId).toBe("tab-b");
    expect(controller.view?.targetId).toBe("tab-b");
    expect(controller.view?.url).toBe(selectedUrl);
    expect(controller.tabs.find((tab) => tab.id === "tab-a")).toMatchObject({
      title: "Initial",
      url: initialUrl,
    });
    expect(
      request.mock.calls.filter(([, envelope]) => {
        return (envelope as BrowserRequestEnvelope).path === "/tabs";
      }),
    ).toEqual([]);
    expect(
      request.mock.calls.filter(([, envelope]) => {
        const browserRequest = envelope as BrowserRequestEnvelope;
        return browserRequest.path === "/screenshot" && browserRequest.body?.targetId === "tab-a";
      }),
    ).toEqual([]);
  });

  it("selects a new tab after a passive refresh overtakes its creation", async () => {
    stubScreenshotMedia();
    const initialUrl = "https://example.test/initial";
    const destinationUrl = "https://example.test/destination";
    const openedTab = createDeferred<ReturnType<typeof createBrowserPanelTestTab>>();
    const visibleTabs = [
      { tabId: "initial-tab", targetId: "raw-initial", title: "Initial", url: initialUrl },
    ];
    let screenshotCount = 0;
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs/open") {
        const tab = await openedTab.promise;
        visibleTabs.push(tab);
        return tab;
      }
      if (envelope.path === "/tabs") {
        return { running: true, tabs: [...visibleTabs] };
      }
      if (envelope.path === "/screenshot") {
        screenshotCount += 1;
        const latest = envelope.body?.targetId === "destination-tab";
        return {
          path: latest ? "/fresh.png" : "/old.png",
          targetId: latest ? "raw-destination" : "raw-initial",
          url: latest ? destinationUrl : initialUrl,
        };
      }
      if (envelope.path === "/act") {
        const latest = envelope.body?.targetId === "destination-tab";
        return createBrowserPanelTestMetrics(
          latest ? destinationUrl : initialUrl,
          latest ? "Destination" : "Initial",
        );
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "initial-tab", initialUrl);

    const pendingNavigation = controller.openUrl(destinationUrl, { newTab: true });
    await flushBrowserResponses();
    await controller.refreshAll();
    openedTab.resolve({
      tabId: "destination-tab",
      targetId: "raw-destination",
      title: "Destination",
      url: destinationUrl,
    });
    await pendingNavigation;

    expect(request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        method: "POST",
        path: "/tabs/open",
        body: { url: destinationUrl },
      }),
    );
    expect(controller.activeTargetId).toBe("destination-tab");
    expect(controller.tabs.map((tab) => tab.id)).toEqual(["initial-tab", "destination-tab"]);
    expect(controller.view?.url).toBe(destinationUrl);
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(screenshotCount).toBe(2);
    expect(controller.loading).toBe(false);
  });

  it("clears stale inspected elements and owned errors across a failed inspection retry", async () => {
    vi.useFakeTimers({ now: 1_000 });
    let inspections = 0;
    const initialNode = createInspectedNode("initial");
    const recoveredNode = createInspectedNode("recovered");
    const { client } = createBrowserClient(async () => {
      inspections += 1;
      if (inspections === 2) {
        throw new Error("Browser connection temporarily unavailable");
      }
      return { result: inspections === 1 ? initialNode : recoveredNode };
    });
    const controller = createBrowserPanelTestController(client, "tab-a");
    controller.setMode("inspect");

    controller.handleOverlayPointerMove(createPointer(10, 20));
    await flushBrowserResponses();
    expect(controller.inspected).toEqual(initialNode);

    await vi.advanceTimersByTimeAsync(120);
    controller.handleOverlayPointerMove(createPointer(30, 40));
    expect(controller.inspected).toBeNull();
    await flushBrowserResponses();

    expect(controller.errorText).toBe(
      "Browser request failed: Browser connection temporarily unavailable",
    );
    expect(controller.mode).toBe("inspect");
    expect(controller.evaluateUnavailable).toBe(false);
    expect(controller.inspected).toBeNull();
    const renderedPanel = document.createElement("div");
    const renderPanel = () =>
      render(
        renderBrowserPanelChrome(
          controller,
          "right",
          400,
          400,
          () => {},
          () => {},
          nothing,
        ),
        renderedPanel,
      );
    renderPanel();
    expect(renderedPanel.querySelector('[role="alert"]')?.textContent).toBe(
      "Browser request failed: Browser connection temporarily unavailable",
    );

    await vi.advanceTimersByTimeAsync(120);
    controller.handleOverlayPointerMove(createPointer(70, 80));
    await flushBrowserResponses();

    expect(controller.inspected).toEqual(recoveredNode);
    expect(controller.errorText).toBeNull();
    expect(controller.inspectPointer).toEqual({ x: 0.7, y: 0.8 });
    renderPanel();
    expect(renderedPanel.querySelector('[role="alert"]')).toBeNull();
    expect(
      renderedPanel.querySelector<HTMLButtonElement>('button[aria-label="Inspect element"]')
        ?.disabled,
    ).toBe(false);
  });

  it.each([
    {
      name: "structured action code",
      message: "evaluation disabled",
      details: { code: "ACT_EVALUATE_DISABLED" },
      expected: true,
    },
    {
      name: "legacy Browser node message without an action code",
      message: "403: act:evaluate is disabled by config (browser.evaluateEnabled=false).",
      details: { nodeError: { message: "legacy Browser node" } },
      expected: true,
    },
    {
      name: "unknown action code with matching prose",
      message: "act:evaluate is disabled by config (browser.evaluateEnabled=false).",
      details: { code: "ACT_UNKNOWN" },
      expected: false,
    },
    {
      name: "sanitized unknown action code with matching prose",
      message: "act:evaluate is disabled by config (browser.evaluateEnabled=false).",
      details: { unrecognizedCode: true },
      expected: false,
    },
  ])(
    "classifies $name without reinterpreting structured errors",
    async ({ message, details, expected }) => {
      const { client } = createBrowserClient(async () => {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message,
          details,
        });
      });
      const controller = createBrowserPanelTestController(client, "tab-a");
      controller.setMode("inspect");

      controller.handleOverlayPointerMove(createPointer(10, 20));
      await flushBrowserResponses();

      expect(controller.evaluateUnavailable).toBe(expected);
      expect(controller.mode).toBe(expected ? "interact" : "inspect");
      expect(controller.errorText).toBeTruthy();
      expect(controller.errorText?.includes("Browser request failed")).toBe(!expected);
    },
  );

  it("keeps the newest inspected element when pointer responses finish out of order", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const evaluations = [first, second];
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/act" && envelope.body?.kind === "evaluate") {
        const evaluation = evaluations.shift();
        if (!evaluation) {
          throw new Error("Unexpected browser inspection");
        }
        return await evaluation.promise;
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a");
    controller.setMode("inspect");

    controller.handleOverlayPointerMove(createPointer(10, 20));
    await vi.advanceTimersByTimeAsync(120);
    controller.handleOverlayPointerMove(createPointer(70, 80));
    expect(request).toHaveBeenCalledTimes(2);

    const latestNode = createInspectedNode("latest");
    second.resolve({ result: latestNode });
    await flushBrowserResponses();
    expect(controller.inspected).toEqual(latestNode);

    first.resolve({ result: createInspectedNode("stale") });
    await flushBrowserResponses();

    expect(controller.inspected).toEqual(latestNode);
    expect(controller.inspectPointer).toEqual({ x: 0.7, y: 0.8 });
  });

  it("inspects the latest pointer after coalescing throttled moves", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const latestInspection = createDeferred<unknown>();
    let inspectionCount = 0;
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/act" && envelope.body?.kind === "evaluate") {
        inspectionCount += 1;
        if (inspectionCount === 1) {
          return { result: createInspectedNode("initial") };
        }
        return await latestInspection.promise;
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a");
    controller.setMode("inspect");

    controller.handleOverlayPointerMove(createPointer(10, 20));
    await flushBrowserResponses();
    controller.handleOverlayPointerMove(createPointer(30, 40));
    controller.handleOverlayPointerMove(createPointer(70, 80));
    expect(inspectionCount).toBe(1);

    await vi.advanceTimersByTimeAsync(120);

    expect(inspectionCount).toBe(2);
    expect(request).toHaveBeenLastCalledWith(
      "browser.request",
      expect.objectContaining({
        method: "POST",
        path: "/act",
        body: expect.objectContaining({
          kind: "evaluate",
          targetId: "tab-a",
          fn: expect.stringContaining("document.elementFromPoint(70, 80)"),
        }),
      }),
    );
    const latestNode = createInspectedNode("latest-coalesced");
    latestInspection.resolve({ result: latestNode });
    await flushBrowserResponses();

    expect(controller.inspected).toEqual(latestNode);
    expect(controller.inspectPointer).toEqual({ x: 0.7, y: 0.8 });
  });

  it("drops a pending inspection after the user selects and inspects another tab", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const previousInspection = createDeferred<unknown>();
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/act") {
        return await previousInspection.promise;
      }
      if (envelope.path === "/tabs/focus") {
        return { ok: true };
      }
      if (envelope.path === "/screenshot") {
        return await new Promise<never>(() => {});
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a");
    controller.setMode("inspect");

    controller.handleOverlayPointerMove(createPointer(10, 20));
    void controller.selectTab("tab-b");
    controller.view = createView("tab-b");
    controller.setMode("inspect");
    previousInspection.resolve({ result: createInspectedNode("foreign-tab") });
    await flushBrowserResponses();

    expect(controller.activeTargetId).toBe("tab-b");
    expect(controller.inspected).toBeNull();
  });

  it("cancels an old tab's throttled inspection after a tab switch", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const inFlightInspection = createDeferred<unknown>();
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/act") {
        return await inFlightInspection.promise;
      }
      if (envelope.path === "/tabs/focus") {
        return { ok: true };
      }
      if (envelope.path === "/screenshot") {
        return await new Promise<never>(() => {});
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a");
    controller.setMode("inspect");

    controller.handleOverlayPointerMove(createPointer(10, 20));
    controller.handleOverlayPointerMove(createPointer(30, 40));
    void controller.selectTab("tab-b");
    controller.view = createView("tab-b");
    controller.setMode("inspect");
    await vi.advanceTimersByTimeAsync(120);

    const inspections = request.mock.calls.filter(([, envelope]) => {
      const browserRequest = envelope as BrowserRequestEnvelope;
      return browserRequest.path === "/act" && browserRequest.body?.kind === "evaluate";
    });
    expect(inspections).toHaveLength(1);
    expect(inspections[0]?.[1]).toMatchObject({ body: { targetId: "tab-a" } });
  });

  it("reconciles selected tab metadata from the captured history document", async () => {
    vi.useFakeTimers();
    stubScreenshotMedia();
    const currentUrl = "https://example.test/current";
    const previousUrl = "https://example.test/previous";
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/act") {
        const fn = typeof envelope.body?.fn === "string" ? envelope.body.fn : "";
        return fn.includes("history.go")
          ? { result: true }
          : createBrowserPanelTestMetrics(previousUrl, "Previous");
      }
      if (envelope.path === "/screenshot") {
        return { path: "/fresh.png", targetId: "raw-a", url: previousUrl };
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a", currentUrl);
    controller.tabs = [
      { id: "tab-a", targetId: "raw-a", title: "Current", url: currentUrl },
      {
        id: "tab-b",
        targetId: "raw-b",
        title: "Background",
        url: "https://example.test/background",
      },
    ];

    controller.goHistory(-1);
    await flushBrowserResponses();
    await vi.advanceTimersByTimeAsync(350);
    await flushBrowserResponses();
    await vi.runAllTimersAsync();
    await flushBrowserResponses();

    expect(controller.tabs).toEqual([
      { id: "tab-a", targetId: "raw-a", title: "Previous", url: previousUrl },
      {
        id: "tab-b",
        targetId: "raw-b",
        title: "Background",
        url: "https://example.test/background",
      },
    ]);
    expect(controller.urlDraft).toBe(previousUrl);
    expect(
      request.mock.calls.filter(([, envelope]) => {
        return (envelope as BrowserRequestEnvelope).path === "/tabs";
      }),
    ).toEqual([]);
  });

  it("never forwards a queued wheel action to a newly selected tab", async () => {
    vi.useFakeTimers();
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs/focus") {
        return { ok: true };
      }
      if (envelope.path === "/screenshot") {
        return await new Promise<never>(() => {});
      }
      if (envelope.path === "/act") {
        return { result: true };
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a");

    controller.handleWheel(new WheelEvent("wheel", { deltaY: 60, cancelable: true }));
    void controller.selectTab("tab-b");
    await vi.advanceTimersByTimeAsync(150);

    const actions = request.mock.calls.filter(([, envelope]) => {
      return (envelope as BrowserRequestEnvelope).path === "/act";
    });
    expect(actions).toEqual([]);
  });

  it("keeps the latest screenshot when same-tab captures finish out of order", async () => {
    stubScreenshotMedia();
    const oldCapture = createDeferred<unknown>();
    const freshCapture = createDeferred<unknown>();
    const captures = [oldCapture, freshCapture];
    const url = "https://example.test/page";
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        return {
          running: true,
          tabs: [{ tabId: "tab-a", targetId: "raw-a", title: "Page", url }],
        };
      }
      if (envelope.path === "/screenshot") {
        const capture = captures.shift();
        if (!capture) {
          throw new Error("Unexpected screenshot capture");
        }
        return await capture.promise;
      }
      if (envelope.path === "/act") {
        return { result: { cssWidth: 100, cssHeight: 100, title: "Page", url } };
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const host = new TestBrowserPanelHost(client);
    const controller = new BrowserPanelController(host);
    controller.activeTargetId = "tab-a";

    const oldRefresh = controller.refreshAll();
    const freshRefresh = controller.refreshAll();
    await flushBrowserResponses();
    expect(
      request.mock.calls.filter(([, envelope]) => {
        return (envelope as BrowserRequestEnvelope).path === "/screenshot";
      }),
    ).toHaveLength(2);

    freshCapture.resolve({ path: "/fresh.png", targetId: "raw-a", url });
    await freshRefresh;
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));

    oldCapture.resolve({ path: "/old.png", targetId: "raw-a", url });
    await oldRefresh;

    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.view?.targetId).toBe("tab-a");
  });

  it("does not combine a screenshot with another document's metrics", async () => {
    stubScreenshotMedia();
    const capturedUrl = "https://example.test/captured";
    const navigatedUrl = "https://example.test/navigated";
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        return {
          running: true,
          tabs: [{ tabId: "tab-a", targetId: "raw-a", title: "Captured", url: capturedUrl }],
        };
      }
      if (envelope.path === "/screenshot") {
        return { path: "/fresh.png", targetId: "raw-a", url: capturedUrl };
      }
      if (envelope.path === "/act") {
        return {
          result: {
            cssWidth: 200,
            cssHeight: 300,
            title: "Different document",
            url: navigatedUrl,
          },
        };
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const host = new TestBrowserPanelHost(client);
    const controller = new BrowserPanelController(host);
    controller.activeTargetId = "tab-a";

    await controller.refreshAll();

    expect(controller.view?.url).toBe(capturedUrl);
    expect(controller.view?.metrics).toBeNull();
  });
});
