import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type {
  NativeBrowserMessage,
  NativeBrowserState,
  NativeBrowserTab,
} from "../../app/native-browser-bridge.ts";
import { startNativeLinkRouting } from "../../app/native-link-routing.ts";
import { acquireNativeOverlayOcclusion } from "../../lib/native-overlay-occlusion.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createBrowserClient,
  createInspectedNode,
  createPointer,
  flushBrowserResponses,
  stubScreenshotMedia,
  TestBrowserPanelHost,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "./browser-panel-controller.ts";
import "./browser-panel.ts";

const nativeTab = (id: string, url = "https://example.test/page"): NativeBrowserTab => ({
  id,
  url,
  title: "Example page",
  loading: false,
  canGoBack: true,
  canGoForward: false,
  openedBy: "web",
});

function fakeNativeBrowser(tabs: NativeBrowserTab[] = []) {
  let state: NativeBrowserState = { revision: 0, tabs };
  const publish = (nextTabs: NativeBrowserTab[]) => {
    state = { revision: state.revision + 1, tabs: nextTabs };
    vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", state);
    window.dispatchEvent(new CustomEvent("openclaw:native-browser-state", { detail: state }));
  };
  const postMessage = vi.fn(async (message: NativeBrowserMessage) => {
    switch (message.type) {
      case "open":
        publish([...state.tabs, nativeTab(message.tabId, message.url)]);
        return { ok: true, tabId: message.tabId };
      case "close":
        publish(state.tabs.filter((tab) => tab.id !== message.tabId));
        break;
      case "snapshot":
        return {
          ok: true,
          dataUrl: "data:image/png;base64,c2NyZWVuc2hvdA==",
          cssWidth: 100,
          cssHeight: 100,
        };
      case "inspect":
        return { ok: true, node: createInspectedNode("Save") };
      case "back":
      case "forward":
      case "navigate":
      case "present":
      case "release-scope":
      case "reload":
      case "stop":
        break;
    }
    return { ok: true };
  });
  vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage } } });
  vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", state);
  return {
    publish,
    postMessage,
    messages: () => postMessage.mock.calls.map(([message]) => message),
  };
}

const controllers: BrowserPanelController[] = [];
let hit: Element | null;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function controllerFixture() {
  let remoteOpen = true;
  const { client, request } = createBrowserClient(async (envelope) => {
    if (envelope.method === "DELETE" && envelope.path === "/tabs/remote") {
      remoteOpen = false;
      return { ok: true };
    }
    if (envelope.path === "/tabs" && !remoteOpen) {
      return { running: true, tabs: [] };
    }
    if (envelope.path === "/tabs") {
      return {
        running: true,
        tabs: [
          { tabId: "remote", targetId: "remote", title: "Remote", url: "https://remote.test/" },
        ],
      };
    }
    if (envelope.path === "/screenshot") {
      return { path: "/fresh.png", targetId: "remote", url: "https://remote.test/" };
    }
    if (envelope.path === "/act") {
      return {
        result: { cssWidth: 100, cssHeight: 100, title: "Remote", url: "https://remote.test/" },
      };
    }
    return { ok: true };
  });
  const host = new TestBrowserPanelHost(client);
  document.body.append(host.renderRoot);
  hit = host.renderRoot.querySelector(".bp-stage");
  const controller = new BrowserPanelController(host);
  controllers.push(controller);
  controller.hostConnected();
  return { controller, host, request };
}

function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  for (const frame of pending) {
    frame(0);
  }
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  hit = null;
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("ResizeObserver", undefined);
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
  stubScreenshotMedia();
});

afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.hostDisconnected();
  }
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementFromPoint");
});

describe("native Browser panel ownership", () => {
  it.each([true, false])(
    "selects a reused tab from the open reply when state arrives before the reply: %s",
    async (stateBeforeReply) => {
      const native = fakeNativeBrowser([nativeTab("mac-other", "https://example.test/other")]);
      const { controller } = controllerFixture();
      const existing = nativeTab("mac-existing", "https://example.test/final");
      const state = [nativeTab("mac-other", "https://example.test/other"), existing];
      native.postMessage.mockImplementationOnce(async () => {
        if (stateBeforeReply) {
          native.publish(state);
        }
        return { ok: true, tabId: existing.id };
      });

      await controller.openUrl("https://example.test/short", { newTab: true, native: true });
      if (!stateBeforeReply) {
        expect(controller.activeTargetId).toBe("mac-other");
        native.publish(state);
      }

      expect(controller.activeTargetId).toBe(existing.id);
      expect(controller.urlDraft).toBe(existing.url);
      expect(controller.tabs.map((tab) => tab.id)).toEqual(["mac-other", "mac-existing"]);
    },
  );

  it.each(["state-first", "reply-first", "reused-tab"] as const)(
    "keeps an explicit tab selection when a pending open completes: %s",
    async (completion) => {
      const tabs = [nativeTab("mac-one"), nativeTab("mac-two")];
      const native = fakeNativeBrowser(tabs);
      const { controller } = controllerFixture();
      const reply = createDeferred<{ ok: true; tabId: string }>();
      native.postMessage.mockImplementationOnce(() => reply.promise);
      const opening = controller.openUrl("https://example.test/new", {
        newTab: true,
        native: true,
      });
      const message = native.messages().find((candidate) => candidate.type === "open");
      expect(message?.type).toBe("open");
      if (message?.type !== "open") {
        throw new Error("Expected a native open request");
      }
      await controller.selectTab("mac-two");
      const openedId = completion === "reused-tab" ? "mac-one" : message.tabId;
      const nextTabs = completion === "reused-tab" ? tabs : [...tabs, nativeTab(openedId)];
      if (completion === "state-first") {
        native.publish(nextTabs);
        expect(controller.activeTargetId).toBe("mac-two");
      }
      reply.resolve({ ok: true, tabId: openedId });
      await opening;
      if (completion !== "state-first") {
        native.publish(nextTabs);
      }
      expect(controller.activeTargetId).toBe("mac-two");
      flushFrames();
      expect(native.messages().at(-1)).toMatchObject({
        type: "present",
        tabId: "mac-two",
        visible: true,
      });
    },
  );

  it("opens and presents a user link through the actual panel when the old preference is off", async () => {
    const native = fakeNativeBrowser();
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.remoteAvailable = false;
    document.body.append(panel);
    const routing = startNativeLinkRouting({ shouldOpenInControlUiBrowser: () => false });
    const link = document.createElement("a");
    link.href = "https://example.test/article";
    document.body.append(link);
    try {
      link.click();
      await flushBrowserResponses();
      await panel.updateComplete;
      const stage = panel.shadowRoot?.querySelector<HTMLElement>(".bp-stage--native");
      expect(stage).not.toBeNull();
      vi.spyOn(stage!, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 500, 300));
      hit = panel;
      flushFrames();
      expect(native.messages()).toContainEqual(
        expect.objectContaining({ type: "open", url: link.href }),
      );
      expect(native.messages()).toContainEqual(
        expect.objectContaining({
          type: "present",
          visible: true,
          rect: { x: 10, y: 20, width: 500, height: 300 },
        }),
      );
      expect(panel.shadowRoot?.querySelector(".bp-shot")).toBeNull();
    } finally {
      routing.dispose();
      panel.remove();
    }
  });

  it.each(["presented", "suppressed"] as const)(
    "hides the embedded native view when %s changes",
    async (property) => {
      const native = fakeNativeBrowser([nativeTab("mac-one")]);
      const panel = document.createElement("openclaw-browser-panel");
      panel.available = true;
      panel.remoteAvailable = false;
      panel.embedded = true;
      panel.presented = true;
      document.body.append(panel);
      await panel.updateComplete;
      const stage = panel.shadowRoot?.querySelector<HTMLElement>(".bp-stage--native");
      expect(stage).not.toBeNull();
      vi.spyOn(stage!, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 500, 300));
      hit = panel;
      window.dispatchEvent(new Event("resize"));
      flushFrames();
      expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: true });
      if (property === "presented") {
        panel.presented = false;
      } else {
        panel.suppressed = true;
      }
      await panel.updateComplete;
      expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: false });
      panel.remove();
      expect(native.messages().at(-1)).toMatchObject({ type: "release-scope" });
    },
  );

  it("lists window tabs before remote tabs and closes only the requested native tab", async () => {
    const native = fakeNativeBrowser([nativeTab("mac-one"), nativeTab("mac-two")]);
    const { controller } = controllerFixture();
    await controller.refreshAll();
    expect(controller.tabs.map((tab) => [tab.id, tab.kind])).toEqual([
      ["mac-one", "native"],
      ["mac-two", "native"],
      ["remote", "remote"],
    ]);
    await controller.selectTab("mac-two");
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({
      type: "present",
      tabId: "mac-two",
      visible: true,
    });
    await controller.closeTab("mac-two");
    expect(controller.activeTargetId).toBe("mac-one");
    expect(controller.tabs.map((tab) => tab.id)).toEqual(["mac-one", "remote"]);
  });

  it("builds panels and opens Mac tabs without crypto.randomUUID (insecure origins)", async () => {
    const secureCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => secureCrypto.getRandomValues(array),
    });
    const native = fakeNativeBrowser();
    const { controller } = controllerFixture();
    await controller.openUrl("https://example.test/new", { newTab: true, native: true });
    const message = native.messages().find((candidate) => candidate.type === "open");
    expect(message?.type).toBe("open");
    if (message?.type !== "open") {
      throw new Error("Expected a native open request");
    }
    expect(message.tabId).toMatch(/^mac-[0-9a-f-]{36}$/);
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({ type: "present", tabId: message.tabId });
  });

  it("focuses a cleared address field once a new tab becomes the selection", async () => {
    fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller } = controllerFixture();
    await controller.refreshAll();
    const input = document.createElement("input");
    input.className = "bp-url";
    controller.host.renderRoot.append(input);
    const focus = vi.spyOn(input, "focus");
    await controller.native.beginNewTab();
    expect(controller.activeTargetId).toMatch(/^mac-[0-9a-f-]{36}$/);
    expect(controller.urlDraft).toBe("");
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("keeps the selected tab's address when a new-tab request is superseded", async () => {
    const tabs = [
      nativeTab("mac-one", "https://example.test/one"),
      nativeTab("mac-two", "https://example.test/two"),
    ];
    const native = fakeNativeBrowser(tabs);
    const { controller } = controllerFixture();
    await controller.refreshAll();
    const input = document.createElement("input");
    input.className = "bp-url";
    controller.host.renderRoot.append(input);
    const focus = vi.spyOn(input, "focus");
    const reply = createDeferred<{ ok: true; tabId: string }>();
    native.postMessage.mockImplementationOnce(() => reply.promise);
    const opening = controller.native.beginNewTab();
    const message = native.messages().find((candidate) => candidate.type === "open");
    if (message?.type !== "open") {
      throw new Error("Expected a native open request");
    }
    await controller.selectTab("mac-two");
    native.publish([...tabs, nativeTab(message.tabId, "about:blank")]);
    reply.resolve({ ok: true, tabId: message.tabId });
    await opening;
    expect(controller.activeTargetId).toBe("mac-two");
    expect(controller.urlDraft).toBe("https://example.test/two");
    expect(focus).not.toHaveBeenCalled();
  });

  it("clears the address bar when the last tab closes without a successor", async () => {
    fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller } = controllerFixture();
    await controller.refreshAll();
    await controller.closeTab("remote");
    await controller.selectTab("mac-one");
    expect(controller.urlDraft).toBe("https://example.test/page");
    await controller.closeTab("mac-one");
    expect(controller.activeTargetId).toBeNull();
    expect(controller.tabs).toEqual([]);
    expect(controller.urlDraft).toBe("");
  });

  it("deduplicates presentations, hides a covered stage, and restores only after every occluder closes", () => {
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller } = controllerFixture();
    flushFrames();
    native.postMessage.mockClear();
    controller.hostUpdated();
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("scroll"));
    flushFrames();
    expect(native.postMessage).not.toHaveBeenCalled();
    const first = acquireNativeOverlayOcclusion();
    const second = acquireNativeOverlayOcclusion();
    expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: false });
    first();
    flushFrames();
    expect(
      native.messages().filter((message) => message.type === "present" && message.visible),
    ).toHaveLength(0);
    second();
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: true });
    hit = document.body;
    window.dispatchEvent(new Event("resize"));
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: false });
  });

  it("hides on presentation loss and releases its scope without closing window tabs", () => {
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller, host } = controllerFixture();
    flushFrames();
    host.open = false;
    controller.hostUpdated();
    expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: false });
    host.open = true;
    controller.hostUpdated();
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: true });
    controller.hostDisconnected();
    expect(native.messages().at(-1)).toMatchObject({ type: "release-scope" });
    expect(native.messages().some((message) => message.type === "close")).toBe(false);
  });

  it("keeps remote screenshots, viewport resizing, and forwarded input off a native tab", async () => {
    vi.useFakeTimers();
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller, request } = controllerFixture();
    await controller.refreshAll();
    controller.handleViewportResize(800, 600);
    controller.handleStageClick(new MouseEvent("click", { clientX: 10, clientY: 20 }));
    controller.handleWheel(new WheelEvent("wheel", { deltaY: 50 }));
    controller.handleViewportKeydown(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(request.mock.calls.map(([, envelope]) => (envelope as { path: string }).path)).toEqual([
      "/tabs",
    ]);
    await controller.selectTab("remote");
    expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: false });
    expect(
      request.mock.calls.some(
        ([, envelope]) => (envelope as { path: string }).path === "/screenshot",
      ),
    ).toBe(true);
  });

  it.each(["annotate", "inspect"] as const)(
    "captures native %s without a Gateway route, then restores the live view",
    async (mode) => {
      const native = fakeNativeBrowser([nativeTab("mac-one")]);
      const { controller } = controllerFixture();
      flushFrames();
      controller.setMode(mode);
      await flushBrowserResponses();
      expect(controller.mode).toBe(mode);
      expect(controller.view).toMatchObject({
        kind: "native",
        targetId: "mac-one",
        metrics: {
          cssWidth: 100,
          cssHeight: 100,
          title: "Example page",
          url: "https://example.test/page",
        },
      });
      expect(controller.view?.browserTab).toBeUndefined();
      expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: false });
      controller.exitCaptureModes();
      flushFrames();
      expect(controller.view).toBeNull();
      expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: true });
    },
  );

  it.each(["annotate", "inspect"] as const)(
    "invalidates a held %s capture when its tab URL changes",
    async (mode) => {
      const native = fakeNativeBrowser([nativeTab("mac-one"), nativeTab("mac-two")]);
      const { controller } = controllerFixture();
      flushFrames();
      controller.setMode(mode);
      await flushBrowserResponses();
      const capture = controller.view;
      expect(capture?.url).toBe("https://example.test/page");
      native.publish([nativeTab("mac-one"), nativeTab("mac-two", "https://example.test/other")]);
      expect(controller.view).toBe(capture);
      expect(controller.mode).toBe(mode);
      native.publish([nativeTab("mac-one", "https://example.test/new"), nativeTab("mac-two")]);
      expect(controller.mode).toBe("interact");
      expect(controller.view).toBeNull();
      expect(controller.urlDraft).toBe("https://example.test/new");
      flushFrames();
      expect(native.messages().at(-1)).toMatchObject({
        type: "present",
        tabId: "mac-one",
        visible: true,
      });
    },
  );

  it("discards an inspect reply from the document preceding a native URL change", async () => {
    vi.useFakeTimers();
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller } = controllerFixture();
    controller.setMode("inspect");
    await flushBrowserResponses();
    const reply = createDeferred<{ ok: true; node: ReturnType<typeof createInspectedNode> }>();
    native.postMessage.mockImplementationOnce(() => reply.promise);
    controller.handleOverlayPointerMove(createPointer(25, 50));
    await vi.advanceTimersByTimeAsync(120);
    expect(native.messages().at(-1)).toMatchObject({ type: "inspect" });
    native.publish([nativeTab("mac-one", "https://example.test/new")]);
    reply.resolve({ ok: true, node: createInspectedNode("Old document") });
    await flushBrowserResponses();
    expect(controller.inspected).toBeNull();
    expect(controller.inspectPointer).toBeNull();
  });

  it.each([
    { mode: "annotate", action: "reload" },
    { mode: "inspect", action: "back" },
    { mode: "annotate", action: "forward" },
    { mode: "inspect", action: "stop" },
  ] as const)("leaves $mode capture before native $action", async ({ mode, action }) => {
    const native = fakeNativeBrowser([{ ...nativeTab("mac-one"), loading: action === "stop" }]);
    const { controller } = controllerFixture();
    flushFrames();
    controller.setMode(mode);
    await flushBrowserResponses();
    expect(controller.mode).toBe(mode);
    controller.strokes = [{ points: [{ x: 0.25, y: 0.5 }] }];
    if (action === "back" || action === "forward") {
      controller.goHistory(action === "back" ? -1 : 1);
    } else {
      controller.reloadPage();
    }
    expect(native.messages()).toContainEqual({ type: action, tabId: "mac-one" });
    expect(controller.mode).toBe("interact");
    expect(controller.view).toBeNull();
    expect(controller.strokes).toEqual([]);
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({
      type: "present",
      tabId: "mac-one",
      visible: true,
    });
  });

  it("selects the native successor's URL and live view after closing the active remote tab", async () => {
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller, request } = controllerFixture();
    await controller.refreshAll();
    await controller.selectTab("remote");
    expect(controller.urlDraft).toBe("https://remote.test/");
    request.mockClear();
    await controller.closeTab("remote");
    expect(controller.activeTargetId).toBe("mac-one");
    expect(controller.urlDraft).toBe("https://example.test/page");
    expect(controller.view).toBeNull();
    expect(controller.tabs.map((tab) => tab.id)).toEqual(["mac-one"]);
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({
      type: "present",
      tabId: "mac-one",
      visible: true,
    });
    expect(request.mock.calls.map(([, envelope]) => (envelope as { path: string }).path)).toEqual([
      "/tabs/remote",
      "/tabs",
    ]);
  });

  it("inspects a native snapshot through the native message with CSS coordinates", async () => {
    vi.useFakeTimers();
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller, request } = controllerFixture();
    controller.setMode("inspect");
    await flushBrowserResponses();
    controller.handleOverlayPointerMove(createPointer(25, 50));
    await vi.advanceTimersByTimeAsync(120);
    expect(native.messages()).toContainEqual({ type: "inspect", tabId: "mac-one", x: 25, y: 50 });
    expect(controller.inspected?.name).toBe("Save");
    expect(request).not.toHaveBeenCalled();
  });

  it("activates a page popup only in the scope presenting its opener", async () => {
    const native = fakeNativeBrowser([nativeTab("mac-one"), nativeTab("mac-two")]);
    const first = controllerFixture();
    flushFrames();
    const second = controllerFixture();
    await second.controller.selectTab("mac-two");
    flushFrames();
    native.publish([
      nativeTab("mac-one"),
      nativeTab("mac-two"),
      {
        ...nativeTab("mac-popup"),
        openedBy: "native",
        openerTabId: "mac-one",
      },
    ]);
    expect(first.controller.activeTargetId).toBe("mac-popup");
    expect(second.controller.activeTargetId).toBe("mac-two");
  });
});
