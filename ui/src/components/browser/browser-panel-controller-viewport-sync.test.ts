import { describe, expect, it, vi } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  createView,
  flushBrowserResponses,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "./browser-panel-controller.ts";

setupBrowserPanelTestCleanup();

function actionRequests(request: ReturnType<typeof createBrowserClient>["request"], kind: string) {
  return request.mock.calls
    .map(([, envelope]) => envelope as BrowserRequestEnvelope)
    .filter((envelope) => envelope.path === "/act" && envelope.body?.kind === kind);
}

function requestsForPath(request: ReturnType<typeof createBrowserClient>["request"], path: string) {
  return request.mock.calls
    .map(([, envelope]) => envelope as BrowserRequestEnvelope)
    .filter((envelope) => envelope.path === path);
}

describe("BrowserPanelController viewport sync", () => {
  it("waits for a successful view before resizing or recapturing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, request } = createBrowserClient(async () => ({ ok: true }));
    const host = new TestBrowserPanelHost(client);
    const controller = new BrowserPanelController(host);
    controller.activeTargetId = "tab-a";

    controller.handleViewportResize(640, 480);
    await vi.advanceTimersByTimeAsync(650);

    expect(actionRequests(request, "resize")).toHaveLength(0);
    expect(requestsForPath(request, "/screenshot")).toHaveLength(0);
  });

  it("debounces resize requests, clamps dimensions, and refreshes the screenshot", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stubScreenshotMedia();
    let remoteWidth = 100;
    let remoteHeight = 100;
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/act" && envelope.body?.kind === "resize") {
        remoteWidth = Number(envelope.body.width);
        remoteHeight = Number(envelope.body.height);
        return { ok: true };
      }
      if (envelope.path === "/screenshot") {
        return { path: "/fresh.png", targetId: "raw-a", url: "https://example.test/a" };
      }
      if (envelope.path === "/act") {
        return {
          result: {
            cssWidth: remoteWidth,
            cssHeight: remoteHeight,
            title: "A",
            url: "https://example.test/a",
          },
        };
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a");

    controller.handleViewportResize(400, 300);
    controller.handleViewportResize(99.4, 9_000.2);
    await vi.advanceTimersByTimeAsync(299);
    expect(actionRequests(request, "resize")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(actionRequests(request, "resize")).toEqual([
      expect.objectContaining({
        method: "POST",
        body: { kind: "resize", targetId: "tab-a", width: 100, height: 8192 },
      }),
    ]);

    await vi.advanceTimersByTimeAsync(349);
    expect(requestsForPath(request, "/screenshot")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flushBrowserResponses();

    expect(requestsForPath(request, "/screenshot")).toHaveLength(1);
  });

  it("does not repeat a requested size or resize an already matching viewport", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, request } = createBrowserClient(async () => ({ ok: true }));
    const controller = createBrowserPanelTestController(client, "tab-a");

    controller.handleViewportResize(640, 480);
    await vi.advanceTimersByTimeAsync(300);
    controller.handleViewportResize(640, 480);
    await vi.advanceTimersByTimeAsync(300);
    expect(actionRequests(request, "resize")).toHaveLength(1);
    request.mockClear();

    controller.view = {
      ...controller.view!,
      metrics: {
        cssWidth: 800,
        cssHeight: 600,
        title: "A",
        url: "https://example.test/a",
      },
    };
    controller.handleViewportResize(800.4, 599.6);
    await vi.advanceTimersByTimeAsync(300);

    expect(actionRequests(request, "resize")).toHaveLength(0);
  });

  it("syncs after mismatched refresh metrics without looping on an inexact remote", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stubScreenshotMedia();
    let screenshotCount = 0;
    const tab = createBrowserPanelTestTab("tab-a", "https://example.test/a", "A");
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        return { running: true, tabs: [tab] };
      }
      if (envelope.path === "/screenshot") {
        screenshotCount += 1;
        return { path: "/fresh.png", targetId: tab.targetId, url: tab.url };
      }
      if (envelope.path === "/act" && envelope.body?.kind === "resize") {
        return { ok: true };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(tab.url, tab.title);
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a", tab.url);

    controller.handleViewportResize(640, 480);
    const refresh = controller.refreshAll();
    await vi.advanceTimersByTimeAsync(0);
    await refresh;
    await vi.advanceTimersByTimeAsync(300);
    expect(actionRequests(request, "resize")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(350);
    await flushBrowserResponses();
    await vi.advanceTimersByTimeAsync(300);

    expect(screenshotCount).toBe(2);
    expect(actionRequests(request, "resize")).toHaveLength(1);
  });

  it("drops a debounced resize when the dock closes before it fires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, request } = createBrowserClient(async () => ({ ok: true }));
    const host = new TestBrowserPanelHost(client);
    const controller = new BrowserPanelController(host);
    controller.activeTargetId = "tab-a";
    controller.view = createView("tab-a");

    controller.handleViewportResize(640, 480);
    host.open = false;
    await vi.advanceTimersByTimeAsync(300);

    expect(actionRequests(request, "resize")).toHaveLength(0);
  });

  it("re-syncs a revisited tab after its document changed size elsewhere", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stubScreenshotMedia();
    // Tab A's viewport is changed remotely (e.g. by an agent) while B is
    // active; revisiting A must re-request the panel size even though it was
    // already requested once for A.
    let revisitedA = false;
    const metricsFor = (targetId: string) =>
      targetId === "tab-a" && revisitedA
        ? { result: { cssWidth: 900, cssHeight: 600, title: "A", url: "https://example.test/t" } }
        : { result: { cssWidth: 700, cssHeight: 500, title: "T", url: "https://example.test/t" } };
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs/focus") {
        return { ok: true };
      }
      if (envelope.path === "/screenshot") {
        const targetId = String(envelope.body?.targetId);
        return { path: "/fresh.png", targetId, url: "https://example.test/t" };
      }
      if (envelope.path === "/act" && envelope.body?.kind === "resize") {
        return { ok: true };
      }
      if (envelope.path === "/act") {
        return metricsFor(String(envelope.body?.targetId));
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a");

    controller.handleViewportResize(700, 500);
    await vi.advanceTimersByTimeAsync(300);
    expect(actionRequests(request, "resize")).toHaveLength(1);

    const toB = controller.selectTab("tab-b");
    await vi.advanceTimersByTimeAsync(0);
    await toB;
    await vi.advanceTimersByTimeAsync(300);

    revisitedA = true;
    const backToA = controller.selectTab("tab-a");
    await vi.advanceTimersByTimeAsync(0);
    await backToA;
    await vi.advanceTimersByTimeAsync(300);

    const resizes = actionRequests(request, "resize").map((envelope) => envelope.body);
    expect(resizes.at(-1)).toEqual({ kind: "resize", targetId: "tab-a", width: 700, height: 500 });
    expect(resizes.filter((body) => body?.targetId === "tab-a")).toHaveLength(2);
  });

  it("syncs the newly active tab to the observed panel size", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stubScreenshotMedia();
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs/focus") {
        return { ok: true };
      }
      if (envelope.path === "/screenshot") {
        return { path: "/fresh.png", targetId: "raw-b", url: "https://example.test/b" };
      }
      if (envelope.path === "/act" && envelope.body?.kind === "resize") {
        return { ok: true };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics("https://example.test/b", "B");
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a");

    controller.handleViewportResize(700, 500);
    await vi.advanceTimersByTimeAsync(300);
    const selection = controller.selectTab("tab-b");
    await vi.advanceTimersByTimeAsync(0);
    await selection;
    await vi.advanceTimersByTimeAsync(300);

    expect(actionRequests(request, "resize").map((envelope) => envelope.body)).toEqual([
      { kind: "resize", targetId: "tab-a", width: 700, height: 500 },
      { kind: "resize", targetId: "tab-b", width: 700, height: 500 },
    ]);
  });
});
