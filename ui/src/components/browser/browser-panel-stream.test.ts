import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  createInspectedNode,
  flushBrowserResponses,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "./browser-panel-controller.ts";
import { screencastFrame, TestScreencastSocket } from "./browser-screencast-test-support.ts";

const PAGE_URL = "https://example.test/page";
const NEXT_URL = "https://example.test/next";
const controllers: BrowserPanelController[] = [];
let sockets: TestScreencastSocket[];
let createdUrls: string[];
let revokedUrls: string[];

setupBrowserPanelTestCleanup();
beforeEach(() => {
  vi.useFakeTimers();
  stubScreenshotMedia();
  sockets = [];
  createdUrls = [];
  revokedUrls = [];
  vi.stubGlobal(
    "WebSocket",
    class extends TestScreencastSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    },
  );
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    const url = `blob:frame-${createdUrls.length}`;
    createdUrls.push(url);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => revokedUrls.push(url));
});
afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.hostDisconnected();
  }
});

async function flush(): Promise<void> {
  await flushBrowserResponses();
  await flushBrowserResponses();
  await flushBrowserResponses();
}

function setup(handle?: (envelope: BrowserRequestEnvelope) => Promise<unknown>) {
  const gateway = createBrowserClient(
    async (envelope) => {
      if (handle) {
        const result = await handle(envelope);
        if (result !== undefined) {
          return result;
        }
      }
      switch (envelope.path) {
        case "/tabs":
          return { running: true, tabs: [createBrowserPanelTestTab("tab-a", PAGE_URL, "Page")] };
        case "/screencast":
          return {
            token: "token",
            wsPath: "/browser/screencast?token=token",
            targetId: "raw-a",
            url: PAGE_URL,
          };
        case "/screenshot":
          return { path: "/fresh.png", targetId: "raw-a", url: PAGE_URL };
        case "/act":
          return createBrowserPanelTestMetrics(PAGE_URL);
        default:
          return { ok: true };
      }
    },
    { screencast: true },
  );
  const host = new TestBrowserPanelHost(gateway.client);
  const controller = new BrowserPanelController(host);
  controller.synchronizeClient();
  controllers.push(controller);
  const calls = (path: string) =>
    gateway.request.mock.calls.filter(
      ([, params]) => (params as BrowserRequestEnvelope).path === path,
    );
  return { ...gateway, host, controller, calls };
}

async function start(controller: BrowserPanelController) {
  const pending = controller.refreshAll();
  await flush();
  const socket = sockets.at(-1)!;
  socket.receive(
    JSON.stringify({ type: "ready", targetId: "raw-a", url: PAGE_URL, title: "Page" }),
  );
  socket.receive(screencastFrame());
  await pending;
  await flush();
  return socket;
}

describe("Browser panel stream ownership", () => {
  it.each(["annotate", "inspect"] as const)(
    "pins the captured image and URL during %s and presents the latest frame on exit",
    async (mode) => {
      const { controller } = setup();
      const socket = await start(controller);
      controller.setMode(mode);
      controller.setState("strokes", [{ points: [{ x: 0.1, y: 0.2 }] }]);
      controller.setState("inspected", createInspectedNode("Original button"));
      const pinnedView = controller.view;
      socket.receive(screencastFrame(NEXT_URL, 200, 100));
      socket.receive(screencastFrame(NEXT_URL, 300, 100));
      socket.receive(JSON.stringify({ type: "meta", url: NEXT_URL, title: "Next" }));
      await flush();
      expect(controller.view).toBe(pinnedView);
      expect(controller.view).toMatchObject({ dataUrl: "blob:frame-0", url: PAGE_URL });
      expect(controller.tabs[0]).toMatchObject({ url: NEXT_URL, title: "Next" });
      expect(controller.urlDraft).toBe(NEXT_URL);
      expect(controller.strokes).toHaveLength(1);
      expect(controller.inspected?.name).toBe("Original button");

      controller.exitCaptureModes();
      await flush();
      expect(controller.view).toMatchObject({
        dataUrl: "blob:frame-1",
        url: NEXT_URL,
        metrics: { cssWidth: 300, title: "Next", url: NEXT_URL },
      });
      expect(controller.strokes).toEqual([]);
      expect(controller.inspected).toBeNull();
      expect(revokedUrls).toEqual(["blob:frame-0"]);
    },
  );

  it("reconnects while a fallback screenshot is still pending", async () => {
    const screenshot = createDeferred<unknown>();
    const { controller, calls } = setup(async (envelope) =>
      envelope.path === "/screenshot" ? screenshot.promise : undefined,
    );
    const socket = await start(controller);
    socket.disconnect(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("/screenshot")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls("/screencast")).toHaveLength(2);
    sockets[1]!.receive(screencastFrame(NEXT_URL));
    await flush();
    const recovered = controller.view;
    expect(recovered?.url).toBe(NEXT_URL);
    screenshot.resolve({ path: "/old.png", targetId: "raw-a", url: PAGE_URL });
    await flush();
    expect(controller.view).toBe(recovered);
  });

  it("keeps a pending fallback screenshot when the reconnect fails", async () => {
    const screenshot = createDeferred<unknown>();
    const { controller, calls } = setup(async (envelope) =>
      envelope.path === "/screenshot" ? screenshot.promise : undefined,
    );
    const socket = await start(controller);
    socket.disconnect(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("/screenshot")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls("/screencast")).toHaveLength(2);
    sockets[1]!.disconnect(1006);
    await flush();
    expect(calls("/screenshot")).toHaveLength(1);
    screenshot.resolve({ path: "/fresh.png", targetId: "raw-a", url: PAGE_URL });
    await flush();
    expect(controller.view?.dataUrl).toMatch(/^data:/);
    expect(controller.loading).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls("/screencast")).toHaveLength(3);
    sockets[2]!.disconnect(1006);
    await flush();
    expect(calls("/screenshot")).toHaveLength(2);
  });

  it.each(["annotate", "inspect"] as const)(
    "defers a resize restart until %s ends",
    async (mode) => {
      const { controller, host, calls } = setup();
      let width = 500;
      const stage = host.renderRoot.querySelector<HTMLElement>(".bp-stage")!;
      Object.defineProperty(stage, "clientWidth", { get: () => width });
      controller.handleViewportResize(width, 300);
      const socket = await start(controller);
      controller.setMode(mode);
      const pinned = controller.view;
      width = 800;
      controller.handleViewportResize(width, 300);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(socket.close).not.toHaveBeenCalled();
      expect(calls("/screencast")).toHaveLength(1);
      expect(controller.view).toBe(pinned);

      controller.exitCaptureModes();
      await vi.advanceTimersByTimeAsync(500);
      expect(socket.close).toHaveBeenCalledOnce();
      expect(calls("/screencast")).toHaveLength(2);
      expect(calls("/screencast")[1]?.[1]).toMatchObject({ body: { maxWidth: 800 } });
      sockets[1]!.receive(screencastFrame(PAGE_URL, 800, 300));
      await flush();
      expect(controller.view?.dataUrl).toBe("blob:frame-1");
      expect(calls("/screenshot")).toHaveLength(0);
    },
  );

  it("recaptures when a late first frame closes before decoding", async () => {
    const screenshot = createDeferred<unknown>();
    let captures = 0;
    const { controller, calls } = setup(async (envelope) =>
      envelope.path === "/screenshot" && captures++ === 0 ? screenshot.promise : undefined,
    );
    const initial = controller.refreshAll();
    await flush();
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls("/screenshot")).toHaveLength(1);
    const images: EventTarget[] = [];
    vi.stubGlobal(
      "Image",
      class extends EventTarget {
        constructor() {
          super();
          images.push(this);
        }
        src = "";
      },
    );
    sockets[0]!.receive(screencastFrame());
    sockets[0]!.disconnect(1006);
    screenshot.resolve({ path: "/old.png", targetId: "raw-a", url: PAGE_URL });
    await initial;
    stubScreenshotMedia();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("/screenshot")).toHaveLength(2);
    const fallback = controller.view;
    expect(fallback?.dataUrl).toMatch(/^data:/);
    images[0]!.dispatchEvent(new Event("load"));
    await flush();
    expect(controller.view).toBe(fallback);
  });

  it("keeps annotation context on the displayed frame when navigation metadata arrives first", async () => {
    const { controller } = setup();
    const socket = await start(controller);
    socket.receive(JSON.stringify({ type: "meta", url: NEXT_URL, title: "Next" }));
    controller.setMode("annotate");

    expect(controller.mode).toBe("annotate");
    expect(controller.view).toMatchObject({
      dataUrl: "blob:frame-0",
      url: PAGE_URL,
      metrics: { title: "Page", url: PAGE_URL },
    });
    expect(controller.tabs[0]).toMatchObject({ title: "Next", url: NEXT_URL });
    expect(controller.urlDraft).toBe(NEXT_URL);
  });

  it("holds a frame whose decode finishes after capture mode begins", async () => {
    const { controller } = setup();
    const socket = await start(controller);
    const images: EventTarget[] = [];
    vi.stubGlobal(
      "Image",
      class extends EventTarget {
        constructor() {
          super();
          images.push(this);
        }
        src = "";
      },
    );
    socket.receive(screencastFrame(NEXT_URL));
    controller.setMode("annotate");
    socket.receive(JSON.stringify({ type: "meta", url: NEXT_URL, title: "Next" }));
    images[0]!.dispatchEvent(new Event("load"));
    await flush();
    expect(controller.view).toMatchObject({ dataUrl: "blob:frame-0", url: PAGE_URL });
    expect(revokedUrls).toEqual(["blob:frame-1"]);

    controller.exitCaptureModes();
    images[1]!.dispatchEvent(new Event("load"));
    await flush();
    expect(controller.view).toMatchObject({ dataUrl: "blob:frame-2", url: NEXT_URL });
  });

  it("lets frames own the view and skips screenshot refreshes while live", async () => {
    const { controller, calls } = setup();
    const socket = await start(controller);
    expect(controller.view).toMatchObject({
      targetId: "tab-a",
      dataUrl: "blob:frame-0",
      metrics: { cssWidth: 100, cssHeight: 100 },
    });
    await controller.refreshAll();
    expect(calls("/screenshot")).toHaveLength(0);
    expect(calls("/screencast")).toHaveLength(1);
    expect(controller.loading).toBe(false);
    socket.receive(JSON.stringify({ type: "meta", url: NEXT_URL, title: "Next" }));
    expect(controller.view).toMatchObject({
      dataUrl: "blob:frame-0",
      url: PAGE_URL,
      metrics: { title: "Page", url: PAGE_URL },
    });
    expect(controller.tabs[0]).toMatchObject({ title: "Next", url: NEXT_URL });
    expect(controller.urlDraft).toBe(NEXT_URL);
    socket.receive(screencastFrame(NEXT_URL));
    await flush();
    expect(controller.view).toMatchObject({
      dataUrl: "blob:frame-1",
      url: NEXT_URL,
      metrics: { title: "Next", url: NEXT_URL },
    });
    controller.setUrlDraftEditing(true);
    controller.setUrlDraft("editing");
    socket.receive(JSON.stringify({ type: "meta", url: PAGE_URL, title: "Page again" }));
    expect(controller.urlDraft).toBe("editing");
  });

  it.each([false, true])(
    "discards a fallback screenshot overtaken by a frame (socket then closes: %s)",
    async (closes) => {
      const screenshot = createDeferred<unknown>();
      const { controller, calls } = setup(async (envelope) =>
        envelope.path === "/screenshot" ? screenshot.promise : undefined,
      );
      const pending = controller.refreshAll();
      await flush();
      await vi.advanceTimersByTimeAsync(1499);
      expect(calls("/screenshot")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls("/screenshot")).toHaveLength(1);
      sockets[0]!.receive(screencastFrame());
      await flush();
      const streamedView = controller.view;
      expect(streamedView?.dataUrl).toBe("blob:frame-0");
      expect(controller.loading).toBe(false);
      if (closes) {
        sockets[0]!.disconnect(1006);
      }
      screenshot.resolve({ path: "/old.png", targetId: "raw-a", url: PAGE_URL });
      await pending;
      expect(controller.view).toBe(streamedView);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("marks navigation-blocked tabs unavailable and releases the visible frame", async () => {
    const { controller } = setup();
    const socket = await start(controller);
    socket.disconnect(4003, "navigation_blocked");
    expect(controller.tabs[0]).toMatchObject({
      url: "",
      urlUnavailableReason: "navigation_blocked",
    });
    expect(controller.view).toBeNull();
    expect(controller.urlDraft).toBe("");
    expect(revokedUrls).toEqual(["blob:frame-0"]);
  });

  it("reconciles the tab list when the streamed page closes", async () => {
    let closed = false;
    const { controller, calls } = setup(async (envelope) =>
      envelope.path === "/tabs" && closed ? { running: true, tabs: [] } : undefined,
    );
    const socket = await start(controller);
    closed = true;
    socket.disconnect(4004, "target_closed");
    await flush();
    expect(calls("/tabs")).toHaveLength(2);
    expect(controller.activeTargetId).toBeNull();
    expect(controller.view).toBeNull();
  });

  it("remembers unsupported streaming until the route or client changes", async () => {
    const { controller, calls, host } = setup(async (envelope) => {
      if (envelope.path === "/screencast") {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Unsupported",
          details: { code: "SCREENCAST_UNSUPPORTED", reason: "node" },
        });
      }
    });
    await controller.refreshAll();
    await vi.advanceTimersByTimeAsync(20_000);
    await controller.refreshAll();
    expect(calls("/screencast")).toHaveLength(1);
    expect(calls("/screenshot")).toHaveLength(2);
    controller.operations.resetRoute({ target: "host", profile: "another" });
    controller.resetBrowserState();
    await controller.refreshAll();
    expect(calls("/screencast")).toHaveLength(2);
    const replacement = createBrowserClient(async () => ({
      running: true,
      tabs: [createBrowserPanelTestTab("tab-a", PAGE_URL, "Page")],
    }));
    host.client = replacement.client;
    controller.synchronizeClient();
    await controller.refreshAll();
    expect(
      replacement.request.mock.calls.some(
        ([, params]) => (params as BrowserRequestEnvelope).path === "/screencast",
      ),
    ).toBe(true);
  });

  it("automatically falls back after socket failure and rate-limits reconnects", async () => {
    const { controller, calls } = setup();
    const socket = await start(controller);
    socket.disconnect(1006);
    expect(controller.view?.dataUrl).toBe("blob:frame-0");
    expect(revokedUrls).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.view?.dataUrl).toMatch(/^data:/);
    expect(revokedUrls).toEqual(["blob:frame-0"]);
    expect(calls("/screencast")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(calls("/screencast")).toHaveLength(2);
    sockets[1]!.disconnect(1006);
    await flush();
    expect(calls("/screenshot")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(9999);
    expect(calls("/screencast")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls("/screencast")).toHaveLength(3);
    sockets[2]!.receive(screencastFrame(NEXT_URL));
    await flush();
    expect(controller.view?.url).toBe(NEXT_URL);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls("/screencast")).toHaveLength(3);
  });

  it.each(["annotate", "inspect"] as const)(
    "defers socket recovery until %s ends",
    async (mode) => {
      const { controller, calls } = setup();
      const socket = await start(controller);
      controller.setMode(mode);
      controller.setState("strokes", [{ points: [{ x: 0.1, y: 0.2 }] }]);
      controller.setState("inspected", createInspectedNode("Pinned button"));
      const pinned = controller.view;
      socket.disconnect(1006);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(controller.view).toBe(pinned);
      expect(controller.strokes).toHaveLength(1);
      expect(controller.inspected?.name).toBe("Pinned button");
      expect(calls("/screenshot")).toHaveLength(0);
      expect(calls("/screencast")).toHaveLength(1);

      controller.exitCaptureModes();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls("/screencast")).toHaveLength(2);
      sockets[1]!.receive(screencastFrame(NEXT_URL));
      await flush();
      expect(controller.view?.url).toBe(NEXT_URL);
    },
  );

  it("does not replace a capture entered while the recovery screenshot is pending", async () => {
    const screenshot = createDeferred<unknown>();
    const { controller, calls } = setup(async (envelope) =>
      envelope.path === "/screenshot" ? screenshot.promise : undefined,
    );
    const socket = await start(controller);
    socket.disconnect(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls("/screenshot")).toHaveLength(1);
    controller.setMode("annotate");
    const pinned = controller.view;
    screenshot.resolve({ path: "/fresh.png", targetId: "raw-a", url: PAGE_URL });
    await flush();
    expect(controller.view).toBe(pinned);
    expect(revokedUrls).toEqual([]);
    controller.exitCaptureModes();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.view?.dataUrl).toMatch(/^data:/);
  });

  it.each(["disconnect", "reset", "tab", "client", "route", "hidden", "unavailable"])(
    "does not recover a stream after %s invalidates its owner",
    async (kind) => {
      const { controller, host, calls } = setup();
      const socket = await start(controller);
      socket.disconnect(1006);
      await vi.advanceTimersByTimeAsync(0);
      const screenshots = calls("/screenshot").length;
      if (kind === "disconnect") {
        controller.hostDisconnected();
      } else if (kind === "reset") {
        controller.resetBrowserState();
      } else if (kind === "tab") {
        controller.setState("activeTargetId", "tab-b");
      } else if (kind === "client") {
        host.client = null;
      } else if (kind === "route") {
        controller.operations.resetRoute({ target: "host", profile: "other" });
      } else if (kind === "hidden") {
        host.open = false;
      } else {
        host.available = false;
      }
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls("/screencast")).toHaveLength(1);
      expect(calls("/screenshot")).toHaveLength(screenshots);
    },
  );

  it("falls back and backs off malformed mint responses without opening a socket", async () => {
    const { controller, calls } = setup(async (envelope) =>
      envelope.path === "/screencast" ? {} : undefined,
    );
    const pending = controller.refreshAll();
    await flush();
    expect(sockets).toHaveLength(0);
    await pending;
    expect(controller.view?.dataUrl).toMatch(/^data:/);
    await controller.refreshAll();
    expect(calls("/screencast")).toHaveLength(1);
    expect(calls("/screenshot")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await controller.refreshAll();
    expect(calls("/screencast")).toHaveLength(2);
    expect(sockets).toHaveLength(0);
  });

  it.each([false, true])(
    "restarts streaming after navigation (previous stream failed: %s)",
    async (failed) => {
      const { controller, calls } = setup(async (envelope) =>
        envelope.path === "/navigate" ? { targetId: "raw-a", url: NEXT_URL } : undefined,
      );
      const initialSocket = await start(controller);
      if (failed) {
        initialSocket.disconnect(1006);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(calls("/screencast")).toHaveLength(1);
      const navigation = controller.openUrl(NEXT_URL, { newTab: false });
      await flush();
      expect(calls("/screencast")).toHaveLength(2);
      const socket = sockets.at(-1)!;
      socket.receive(
        JSON.stringify({ type: "ready", targetId: "raw-a", url: NEXT_URL, title: "Next" }),
      );
      socket.receive(screencastFrame(NEXT_URL));
      await navigation;
      await flush();
      expect(controller.view?.dataUrl).toBe("blob:frame-1");
      expect(controller.view?.url).toBe(NEXT_URL);
      expect(calls("/screenshot")).toHaveLength(failed ? 1 : 0);
    },
  );

  it.each(["disconnect", "reset", "tab"])("closes and revokes on %s teardown", async (kind) => {
    const { controller } = setup();
    const socket = await start(controller);
    if (kind === "disconnect") {
      controller.hostDisconnected();
    } else if (kind === "reset") {
      controller.resetBrowserState();
    } else {
      controller.setState("activeTargetId", "tab-b");
    }
    expect(socket.close).toHaveBeenCalledOnce();
    expect(revokedUrls).toEqual(["blob:frame-0"]);
  });

  it("coalesces decoding frames and never publishes a frame overtaken by navigation metadata", async () => {
    const { controller } = setup();
    const socket = await start(controller);
    const images: EventTarget[] = [];
    vi.stubGlobal(
      "Image",
      class extends EventTarget {
        constructor() {
          super();
          images.push(this);
        }
        src = "";
      },
    );
    socket.receive(screencastFrame());
    socket.receive(JSON.stringify({ type: "meta", url: NEXT_URL, title: "Next" }));
    socket.receive(screencastFrame(NEXT_URL, 200, 100));
    socket.receive(screencastFrame(NEXT_URL, 300, 100));
    expect(images).toHaveLength(1);
    images[0]!.dispatchEvent(new Event("load"));
    await flush();
    expect(controller.view).toMatchObject({
      dataUrl: "blob:frame-0",
      url: PAGE_URL,
      metrics: { title: "Page", url: PAGE_URL },
    });
    expect(images).toHaveLength(2);
    expect(revokedUrls).toContain("blob:frame-1");
    images[1]!.dispatchEvent(new Event("load"));
    await flush();
    expect(controller.view).toMatchObject({
      dataUrl: "blob:frame-2",
      url: NEXT_URL,
      metrics: { cssWidth: 300, title: "Next", url: NEXT_URL },
    });
    expect(revokedUrls).toContain("blob:frame-0");
    expect(createdUrls.filter((url) => !revokedUrls.includes(url))).toEqual(["blob:frame-2"]);
  });

  it("does not let continuous mismatched frames postpone the debounced viewport sync", async () => {
    const { controller, calls } = setup();
    controller.handleViewportResize(500, 300);
    const schedule = vi.spyOn(controller, "scheduleViewportSync");
    const socket = await start(controller);
    expect(schedule).toHaveBeenCalledTimes(1);
    for (let elapsed = 100; elapsed <= 600; elapsed += 100) {
      socket.receive(screencastFrame(PAGE_URL, 100, 100));
      await vi.advanceTimersByTimeAsync(100);
    }
    const resizes = () =>
      calls("/act").filter(
        ([, params]) => (params as BrowserRequestEnvelope).body?.kind === "resize",
      );
    // The sync fired at 300 ms and 600 ms despite a frame every 100 ms; frames
    // arriving while a sync was pending joined it instead of postponing it.
    expect(resizes()).toHaveLength(1);
    expect(resizes()[0]?.[1]).toMatchObject({ body: { width: 500, height: 300 } });
    expect(schedule).toHaveBeenCalledTimes(2);
    socket.receive(screencastFrame(PAGE_URL, 100, 100));
    await flush();
    expect(schedule).toHaveBeenCalledTimes(3);
  });

  it("negotiates pixel density and restarts only after a large debounced width change", async () => {
    const { controller, host, calls } = setup();
    vi.stubGlobal("devicePixelRatio", 2);
    let width = 500;
    const stage = host.renderRoot.querySelector<HTMLElement>(".bp-stage")!;
    Object.defineProperty(stage, "clientWidth", { get: () => width });
    controller.handleViewportResize(width, 300);
    await start(controller);
    expect(calls("/screencast")[0]?.[1]).toMatchObject({
      body: { maxWidth: 1000, maxHeight: 1000 },
    });
    width = 640;
    controller.handleViewportResize(width, 300);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls("/screencast")).toHaveLength(1);
    width = 800;
    controller.handleViewportResize(width, 1200);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls("/screencast")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9400);
    expect(calls("/screencast")).toHaveLength(2);
    expect(calls("/screencast")[1]?.[1]).toMatchObject({
      body: { maxWidth: 1600, maxHeight: 2000 },
    });
    sockets[1]!.receive(screencastFrame(PAGE_URL, 800, 1200));
    await flush();
  });

  it("does not let a retired decoder replace or revoke the new stream's frame", async () => {
    const { controller } = setup();
    await start(controller);
    const images: EventTarget[] = [];
    vi.stubGlobal(
      "Image",
      class extends EventTarget {
        constructor() {
          super();
          images.push(this);
        }
        src = "";
      },
    );
    sockets[0]!.receive(screencastFrame());
    controller.resetBrowserState();
    await vi.advanceTimersByTimeAsync(10_000);
    const restarted = controller.refreshAll();
    await flush();
    sockets[1]!.receive(screencastFrame(NEXT_URL));
    images[1]!.dispatchEvent(new Event("load"));
    await restarted;
    images[0]!.dispatchEvent(new Event("load"));
    await flush();
    expect(controller.view?.dataUrl).toBe("blob:frame-2");
    expect(revokedUrls).toEqual(["blob:frame-0", "blob:frame-1"]);
    sockets[1]!.receive(screencastFrame(NEXT_URL));
    expect(images).toHaveLength(3);
  });
});
