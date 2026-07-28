/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page.test/"} */

import { expectDefined } from "@openclaw/normalization-core";
import type { RouteLocation } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeGateways = vi.hoisted(() => ({ current: null as NativeGatewaysCapability | null }));

// The dedicated unit-mock-registry project keeps this complete, side-effect-only
// module mock from sharing a worker's mock registry with component tests.
vi.mock("./chat-pane.ts", () => ({}));
vi.mock("../../app/native-gateways.runtime.ts", () => ({
  nativeGatewaysCapability: () => nativeGateways.current,
}));

import type { ApplicationContext } from "../../app/context.ts";
import type {
  NativeGatewaysCapability,
  NativeGatewaysSnapshot,
} from "../../app/native-gateways.runtime.ts";
import { loadSettings } from "../../app/settings.ts";
import { UI_COMMAND_EVENT } from "../../components/panel-toggle-contract.ts";
import {
  buildCatalogSessionKey,
  catalogSessionSearch,
  type CatalogSessionKey,
} from "../../lib/sessions/catalog-key.ts";
import { SESSION_DRAG_MIME } from "../../lib/sessions/drag.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ChatPage } from "./chat-page.ts";
import { loadChatRoute } from "./route-loader.ts";

const WORK_SESSION_KEY = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const CATALOG_KEY = {
  catalogId: "claude",
  hostId: "gateway:local",
  threadId: "thread-1",
} satisfies CatalogSessionKey;
const CATALOG_SESSION_KEY = buildCatalogSessionKey(CATALOG_KEY);
const sessionPath = (sessionKey: string) =>
  sessionNavigationTarget({ face: "chat", sessionKey, fallbackAgentId: "main" }).options.pathname;
import type { ChatMessageCache } from "./session-message-cache.ts";
import type { SplitDropZone } from "./split-drop-zone.ts";
import { insertPane, type ChatSplitLayout } from "./split-layout.ts";

type RenderedPane = HTMLElement & {
  paneId: string;
  chatMessagesBySession: ChatMessageCache;
  sessionKey: string;
  active: boolean;
  paneTitle: string;
  narrow: boolean;
  mergedChrome: boolean;
  nativeGateways: NativeGatewaysCapability | null;
  gatewaysSnapshot: NativeGatewaysSnapshot | null;
  onOpenSplitView?: () => void;
  onClosePane?: (paneId: string) => void;
  onFaceChange?: (face: "chat" | "dashboard") => void;
};

type RenderedDivider = HTMLElement & { orientation: "horizontal" | "vertical" };

function createSplitLayout(sessionKey: string): ChatSplitLayout {
  const singlePane: ChatSplitLayout = {
    columns: [{ id: "c1", panes: [{ id: "p1", sessionKey }], paneWeights: [1] }],
    columnWeights: [1],
    activePaneId: "p1",
  };
  return insertPane(singlePane, "p1", sessionKey, "right");
}

function itemAt<T>(items: ArrayLike<T>, index: number, label: string): T {
  return expectDefined(items[index], `${label} ${index}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function setLayout(page: ChatPage, layout: ChatSplitLayout | undefined) {
  (page as unknown as { layout: ChatSplitLayout | undefined }).layout = layout;
}

function getLayout(page: ChatPage): ChatSplitLayout | undefined {
  return (page as unknown as { layout: ChatSplitLayout | undefined }).layout;
}

function setNarrow(page: ChatPage, narrow: boolean) {
  (page as unknown as { narrow: boolean }).narrow = narrow;
  page.requestUpdate();
}

function getRouteDraftForActivePane(page: ChatPage): string | undefined {
  return (
    page as unknown as {
      routeDraftForActivePane: () => string | undefined;
    }
  ).routeDraftForActivePane();
}

function applySessionDrop(page: ChatPage, sessionKey: string, paneId: string, zone: SplitDropZone) {
  (
    page as unknown as {
      applySessionDrop: (sessionKey: string, paneId: string, zone: SplitDropZone) => void;
    }
  ).applySessionDrop(sessionKey, paneId, zone);
}

function handleDrop(page: ChatPage, event: DragEvent) {
  (page as unknown as { handleDrop: (event: DragEvent) => void }).handleDrop(event);
}

function handleDragOver(page: ChatPage, event: DragEvent) {
  (page as unknown as { handleDragOver: (event: DragEvent) => void }).handleDragOver(event);
}

function getDropIndicator(page: ChatPage) {
  return (
    page as unknown as {
      dropIndicator: { paneId: string; zone: SplitDropZone } | null;
    }
  ).dropIndicator;
}

function setNavigationContext(page: ChatPage) {
  const navigate = vi.fn();
  const replace = vi.fn();
  const patch = vi.fn(async () => null);
  const agentSelectionState = { selectedId: "main" };
  const setAgent = vi.fn((agentId: string) => {
    agentSelectionState.selectedId = agentId;
  });
  const context = {
    basePath: "",
    sessions: { state: { result: null }, subscribe: () => () => undefined, patch },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    gateway: { snapshot: { hello: null } },
    navigate,
    replace,
    agentSelection: { state: agentSelectionState, set: setAgent },
  } as unknown as ApplicationContext;
  (page as unknown as { context: ApplicationContext }).context = context;
  return { context, navigate, replace, setAgent, patch };
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe("chat page split layout host", () => {
  beforeEach(() => {
    nativeGateways.current = null;
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    localStorage.clear();
    stubMatchMedia(false);
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("selects the path agent for a synthetic catalog session", () => {
    const page = new ChatPage();
    const { setAgent } = setNavigationContext(page);
    page.data = {
      sessionKey: "catalog:claude:gateway%3Alocal:thread-1",
      agentId: "research",
    };

    document.body.append(page);

    expect(setAgent).toHaveBeenCalledWith("research");
  });

  it("renders one chrome-free active pane in classic mode", async () => {
    const page = new ChatPage();
    setNavigationContext(page);
    page.data = { sessionKey: "main", draft: "hello" };
    document.body.append(page);
    await page.updateComplete;

    const panes = page.querySelectorAll<RenderedPane>("openclaw-chat-pane");
    expect(panes).toHaveLength(1);
    expect(itemAt(panes, 0, "rendered pane").paneId).toBe("p1");
    expect(itemAt(panes, 0, "rendered pane").sessionKey).toBe("main");
    expect(itemAt(panes, 0, "rendered pane").active).toBe(true);
    expect(itemAt(panes, 0, "rendered pane").mergedChrome).toBe(false);
    expect(itemAt(panes, 0, "rendered pane").classList.contains("chat-split-view__pane")).toBe(
      false,
    );
    expect(page.querySelector("resizable-divider")).toBeNull();
    // The always-on pane header owns the classic split-view opener.
    expect(typeof itemAt(panes, 0, "rendered pane").onOpenSplitView).toBe("function");
  });

  it("passes the chat-owned gateway capability only to the rightmost pane", async () => {
    const gatewaySnapshot: NativeGatewaysSnapshot = {
      gateways: [],
      currentId: "primary",
    };
    nativeGateways.current = {
      snapshot: gatewaySnapshot,
      subscribe: () => () => undefined,
      select: vi.fn(),
      openWindow: vi.fn(),
      setPrimary: vi.fn(),
      openSettings: vi.fn(),
    };
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    await page.updateComplete;

    const panes = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
    expect(panes).toHaveLength(2);
    expect(panes[0]?.nativeGateways).toBeNull();
    expect(panes[0]?.gatewaysSnapshot).toBeNull();
    expect(panes[1]?.nativeGateways).toBe(nativeGateways.current);
    expect(panes[1]?.gatewaysSnapshot).toBe(gatewaySnapshot);
  });

  it("passes merged chrome from the shared mobile-nav query", async () => {
    stubMatchMedia(true);
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    await page.updateComplete;

    const pane = itemAt(page.querySelectorAll<RenderedPane>("openclaw-chat-pane"), 0, "pane");
    expect(pane.mergedChrome).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 1099px)");
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 1100px)");
  });

  it("retains the classic pane element while split view opens and closes", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    await page.updateComplete;

    const classicPane = itemAt(
      page.querySelectorAll<RenderedPane>("openclaw-chat-pane"),
      0,
      "classic pane",
    );
    classicPane.onOpenSplitView?.();
    await page.updateComplete;

    const splitPanes = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
    expect(splitPanes).toHaveLength(2);
    expect(splitPanes[0]).toBe(classicPane);
    expect(classicPane.classList.contains("chat-split-view__pane")).toBe(true);
    const addedPane = itemAt(splitPanes, 1, "added split pane");
    addedPane.onClosePane?.(addedPane.paneId);
    await page.updateComplete;

    const survivingPane = itemAt(
      page.querySelectorAll<RenderedPane>("openclaw-chat-pane"),
      0,
      "surviving pane",
    );
    expect(survivingPane).toBe(classicPane);
    expect(survivingPane.classList.contains("chat-split-view__pane")).toBe(false);
  });

  it("applies mounted UI split, focus, and close commands", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    const navigation = setNavigationContext(page);
    document.body.append(page);

    const split = new CustomEvent(UI_COMMAND_EVENT, {
      detail: {
        command: { kind: "split", direction: "right", sessionKey: WORK_SESSION_KEY },
        sessionKey: "main",
      },
      cancelable: true,
    });
    window.dispatchEvent(split);
    expect(split.defaultPrevented).toBe(true);
    expect(getLayout(page)?.columns.at(1)?.panes.at(0)?.sessionKey).toBe(WORK_SESSION_KEY);
    expect(navigation.replace).toHaveBeenLastCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
    });

    window.dispatchEvent(
      new CustomEvent(UI_COMMAND_EVENT, {
        detail: { command: { kind: "focus", sessionKey: "main" }, sessionKey: "main" },
        cancelable: true,
      }),
    );
    expect(getLayout(page)?.activePaneId).toBe("p1");

    window.dispatchEvent(
      new CustomEvent(UI_COMMAND_EVENT, {
        detail: {
          command: { kind: "close-pane", sessionKey: WORK_SESSION_KEY },
          sessionKey: "main",
        },
        cancelable: true,
      }),
    );
    expect(getLayout(page)).toBeUndefined();
  });

  it("leaves UI split commands unhandled on narrow viewports", () => {
    stubMatchMedia(true);
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    setNavigationContext(page);
    document.body.append(page);

    const split = new CustomEvent(UI_COMMAND_EVENT, {
      detail: {
        command: { kind: "split", direction: "right", sessionKey: WORK_SESSION_KEY },
        sessionKey: "main",
      },
      cancelable: true,
    });
    window.dispatchEvent(split);
    // Unhandled so the app host falls back to navigating to the session.
    expect(split.defaultPrevented).toBe(false);
    expect(getLayout(page)).toBeUndefined();
  });

  it("withholds the header split-view opener on narrow single-pane viewports", async () => {
    stubMatchMedia(true);
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    await page.updateComplete;

    // Narrow split view renders only the active pane, so offering the opener
    // there would silently hide the second pane it creates.
    const pane = page.querySelector<RenderedPane>("openclaw-chat-pane");
    expect(pane?.onOpenSplitView).toBeUndefined();
  });

  it("hands each route-provided draft to the active pane only once", async () => {
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    const firstRouteData = { sessionKey: "main", draft: "one-shot draft" };
    page.data = firstRouteData;
    expect(getRouteDraftForActivePane(page)).toBe("one-shot draft");

    document.body.append(page);
    await page.updateComplete;
    await Promise.resolve();
    await page.updateComplete;

    expect(getRouteDraftForActivePane(page)).toBeUndefined();
    expect(navigation.replace).toHaveBeenCalledOnce();
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionPath("main"),
    });
    page.data = { ...firstRouteData };
    expect(getRouteDraftForActivePane(page)).toBe("one-shot draft");
  });

  it("replaces a cold literal main route after canonical defaults resolve", async () => {
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    const canonicalLocation = deferred<RouteLocation | null>();
    page.data = {
      sessionKey: "agent:research:workspace",
      face: "chat",
      draft: "ship",
      canonicalLocationReady: canonicalLocation.promise,
    };
    document.body.append(page);
    await page.updateComplete;
    await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledOnce());
    navigation.replace.mockClear();

    canonicalLocation.resolve({
      pathname: "/chat/research",
      search: "?draft=ship&panel=details",
      hash: "",
    });
    await vi.waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("chat", {
        pathname: "/chat/research",
        search: "?panel=details",
        hash: "",
      }),
    );
  });

  it("replaces into the canonical face namespace without adding history", async () => {
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    // The loader resolved this session to its stored dashboard face while the route was
    // matched under /chat, so the replacement has to be routed by the resolved face.
    page.data = {
      sessionKey: WORK_SESSION_KEY,
      face: "dashboard",
      canonicalLocation: {
        pathname: "/dashboard/main/deploy-monitor-12345678",
        search: "",
        hash: "",
      },
    };
    document.body.append(page);
    await page.updateComplete;

    expect(navigation.replace).toHaveBeenCalledWith("dashboard", {
      pathname: "/dashboard/main/deploy-monitor-12345678",
      search: "",
      hash: "",
    });
  });

  it("keeps catalog identity when consuming a route draft", async () => {
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    page.data = {
      sessionKey: CATALOG_SESSION_KEY,
      agentId: "research",
      draft: "one-shot catalog draft",
    };
    document.body.append(page);
    await page.updateComplete;
    await Promise.resolve();
    await page.updateComplete;

    const expectedSearch = catalogSessionSearch(CATALOG_KEY);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: "/chat/research",
      search: expectedSearch,
    });
    await expect(
      loadChatRoute(
        navigation.context,
        { pathname: "/chat/research", search: expectedSearch, hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: "session", sessionKey: CATALOG_SESSION_KEY });
  });

  it("keeps catalog identity while switching faces", async () => {
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    page.data = { sessionKey: CATALOG_SESSION_KEY, agentId: "research", face: "chat" };
    document.body.append(page);
    await page.updateComplete;

    const pane = page.querySelector<RenderedPane>("openclaw-chat-pane");
    pane?.onFaceChange?.("dashboard");
    const expectedSearch = catalogSessionSearch(CATALOG_KEY);
    expect(navigation.navigate).toHaveBeenCalledWith("dashboard", {
      pathname: "/dashboard/research",
      search: expectedSearch,
    });
    await expect(
      loadChatRoute(
        navigation.context,
        { pathname: "/dashboard/research", search: expectedSearch, hash: "" },
        "dashboard",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: "session", sessionKey: CATALOG_SESSION_KEY });
  });

  it("preserves a resolved long prefix through drafts and face changes", async () => {
    const page = new ChatPage();
    const navigation = setNavigationContext(page);
    page.data = {
      sessionKey: WORK_SESSION_KEY,
      shortId: "1234567890",
      draft: "ship",
      face: "chat",
    };
    document.body.append(page);
    await page.updateComplete;
    await Promise.resolve();
    await page.updateComplete;

    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: "/chat/main/1234567890",
    });
    navigation.navigate.mockClear();
    const pane = page.querySelector<RenderedPane>("openclaw-chat-pane");
    pane?.onFaceChange?.("dashboard");
    expect(navigation.navigate).toHaveBeenCalledWith("dashboard", {
      pathname: "/dashboard/main/1234567890",
    });
    expect(navigation.patch).toHaveBeenCalledWith(
      WORK_SESSION_KEY,
      { boardFace: "dashboard" },
      { agentId: "main" },
    );
  });

  it("passes an empty session key while route data is still unresolved", async () => {
    // Regression: a fabricated fallback key here made the pane canonicalize
    // against it and skip gateway startup entirely (chat.startup never sent).
    const page = new ChatPage();
    document.body.append(page);
    await page.updateComplete;

    const pane = page.querySelector<RenderedPane>("openclaw-chat-pane");
    expect(pane?.sessionKey).toBe("");
    expect(pane?.active).toBe(true);
  });

  it("renders keyed panes and a divider for a two-column split", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    await page.updateComplete;

    const panes = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
    const dividers = page.querySelectorAll<RenderedDivider>("resizable-divider");
    expect(panes.map((pane) => pane.paneId)).toEqual(["p1", "p2"]);
    expect(panes.map((pane) => pane.active)).toEqual([false, true]);
    expect(dividers).toHaveLength(1);
    expect(itemAt(dividers, 0, "split divider").orientation).toBe("vertical");
    expect(
      page
        .querySelector(".chat-split-view__cell--active")
        ?.contains(itemAt(panes, 1, "rendered pane")),
    ).toBe(true);
    expect(panes.every((pane) => pane.onOpenSplitView === undefined)).toBe(true);
    expect(panes[0]?.chatMessagesBySession).toBe(panes[1]?.chatMessagesBySession);
  });

  it("renders only the active pane from a preserved split on narrow viewports", async () => {
    stubMatchMedia(true);
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    await page.updateComplete;

    const panes = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
    expect(panes.map((pane) => pane.paneId)).toEqual(["p2"]);
    expect(itemAt(panes, 0, "rendered pane").active).toBe(true);
    expect(itemAt(panes, 0, "rendered pane").narrow).toBe(true);
    expect(page.querySelector("resizable-divider")).toBeNull();
  });

  it("retains the active pane element across wide and narrow layouts", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    await page.updateComplete;

    const activePane = itemAt(
      page.querySelectorAll<RenderedPane>("openclaw-chat-pane"),
      1,
      "active wide pane",
    );
    setNarrow(page, true);
    await page.updateComplete;

    const narrowPane = itemAt(
      page.querySelectorAll<RenderedPane>("openclaw-chat-pane"),
      0,
      "active narrow pane",
    );
    expect(narrowPane).toBe(activePane);
    expect(narrowPane.narrow).toBe(true);

    setNarrow(page, false);
    await page.updateComplete;
    expect(
      itemAt(page.querySelectorAll<RenderedPane>("openclaw-chat-pane"), 1, "active restored pane"),
    ).toBe(activePane);
  });

  it("refreshes split toolbar titles after the shared list loads", async () => {
    const page = new ChatPage();
    const cleanup = vi.fn();
    const sessionsState: {
      result: { sessions: Array<{ key: string; displayName?: string }> } | null;
    } = {
      result: null,
    };
    let notify = () => {};
    (page as unknown as { context: unknown }).context = {
      sessions: {
        state: sessionsState,
        subscribe: (listener: () => void) => {
          notify = listener;
          return cleanup;
        },
      },
    };
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    await page.updateComplete;

    const paneTitles = () =>
      [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")].map((pane) => pane.paneTitle);
    expect(paneTitles()).toEqual(["Main Thread", "Main Thread"]);

    // Rows arrive under the canonical agent key while the route still says
    // "main"; hello-default resolution plus equivalence matching must find
    // the label anyway — including non-default agent ids.
    (page as unknown as { context: { gateway?: unknown; sessions: unknown } }).context.gateway = {
      snapshot: {
        hello: {
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "dev",
              mainKey: "main",
              mainSessionKey: "agent:dev:main",
            },
          },
        },
      },
    };
    sessionsState.result = {
      sessions: [{ key: "agent:dev:main", displayName: "Main desk" }],
    };
    notify();
    await page.updateComplete;

    expect(paneTitles()).toEqual(["Main desk", "Main desk"]);

    page.remove();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("moves session updates to a replacement context source", async () => {
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    let notifyFirst = () => {};
    let notifySecond = () => {};
    const firstSessions = {
      state: { result: null },
      subscribe: vi.fn((listener: () => void) => {
        notifyFirst = listener;
        return firstCleanup;
      }),
    };
    const secondSessions = {
      state: { result: null },
      subscribe: vi.fn((listener: () => void) => {
        notifySecond = listener;
        return secondCleanup;
      }),
    };
    const page = new ChatPage();
    (page as unknown as { context: unknown }).context = { sessions: firstSessions };
    document.body.append(page);
    await page.updateComplete;

    expect(firstSessions.subscribe).toHaveBeenCalledOnce();
    (page as unknown as { context: unknown }).context = { sessions: secondSessions };
    page.requestUpdate();
    await page.updateComplete;

    expect(firstCleanup).toHaveBeenCalledOnce();
    expect(secondSessions.subscribe).toHaveBeenCalledOnce();

    const requestUpdate = vi.spyOn(page, "requestUpdate");
    notifyFirst();
    expect(requestUpdate).not.toHaveBeenCalled();
    notifySecond();
    expect(requestUpdate).toHaveBeenCalledOnce();

    page.remove();
    expect(secondCleanup).toHaveBeenCalledOnce();
  });

  it("routes a classic-mode center drop without creating a layout", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    const navigation = setNavigationContext(page);

    applySessionDrop(page, WORK_SESSION_KEY, "single", { kind: "center" });

    expect(getLayout(page)).toBeUndefined();
    expect(loadSettings().chatSplitLayout).toBeUndefined();
    expect(navigation.navigate).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
    });
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("creates and persists a classic-mode edge drop on the chosen side", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    const navigation = setNavigationContext(page);

    applySessionDrop(page, WORK_SESSION_KEY, "single", { kind: "edge", edge: "left" });

    const layout = getLayout(page);
    expect(layout?.columns.map((column) => column.panes.map((pane) => pane.sessionKey))).toEqual([
      [WORK_SESSION_KEY],
      ["main"],
    ]);
    expect(layout?.activePaneId).toBe("p2");
    expect(loadSettings().chatSplitLayout).toEqual(layout);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
    });
  });

  it("inserts and persists a dropped session at a layout edge", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    setLayout(page, createSplitLayout("main"));
    const navigation = setNavigationContext(page);

    applySessionDrop(page, WORK_SESSION_KEY, "p1", { kind: "edge", edge: "down" });

    const layout = getLayout(page);
    expect(layout?.columns.at(0)?.panes.map((pane) => pane.sessionKey)).toEqual([
      "main",
      WORK_SESSION_KEY,
    ]);
    expect(layout?.activePaneId).toBe("p3");
    expect(loadSettings().chatSplitLayout).toEqual(layout);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
    });
  });

  it("replaces and activates the pane under a layout center drop", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    setLayout(page, createSplitLayout("main"));
    const navigation = setNavigationContext(page);

    applySessionDrop(page, WORK_SESSION_KEY, "p1", { kind: "center" });

    const layout = getLayout(page);
    expect(layout?.columns.at(0)?.panes.at(0)?.sessionKey).toBe(WORK_SESSION_KEY);
    expect(layout?.activePaneId).toBe("p1");
    expect(loadSettings().chatSplitLayout).toEqual(layout);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
    });
  });

  it("leaves a same-session center drop unchanged", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    const layout = createSplitLayout("main");
    setLayout(page, layout);
    const navigation = setNavigationContext(page);

    applySessionDrop(page, "main", "p1", { kind: "center" });

    expect(getLayout(page)).toBe(layout);
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("resolves the pane and zone from the drop event", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    setLayout(page, createSplitLayout("main"));
    const navigation = setNavigationContext(page);
    await page.updateComplete;

    const pane = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")].find(
      (candidate) => candidate.paneId === "p1",
    );
    const container = page.querySelector<HTMLElement>(".chat-split-view__drop-container");
    expect(pane).toBeDefined();
    expect(container).not.toBeNull();
    const paneRect = { left: 100, top: 50, width: 200, height: 100 } as DOMRect;
    const containerRect = { left: 100, top: 50, width: 400, height: 100 } as DOMRect;
    vi.spyOn(pane!, "getBoundingClientRect").mockReturnValue(paneRect);
    vi.spyOn(container!, "getBoundingClientRect").mockReturnValue(containerRect);
    const preventDefault = vi.fn();

    handleDrop(page, {
      target: pane,
      clientX: 105,
      clientY: 100,
      preventDefault,
      dataTransfer: {
        types: [SESSION_DRAG_MIME],
        getData: (type: string) => (type === SESSION_DRAG_MIME ? WORK_SESSION_KEY : ""),
      } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(getLayout(page)?.columns.map((column) => column.panes.at(0)?.sessionKey)).toEqual([
      WORK_SESSION_KEY,
      "main",
      "main",
    ]);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
    });
  });

  it("accepts an owned header drop and ignores unrelated targets", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    document.body.append(page);
    const layout = createSplitLayout("main");
    setLayout(page, layout);
    const navigation = setNavigationContext(page);
    await page.updateComplete;

    const pane = [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")].find(
      (candidate) => candidate.paneId === "p1",
    );
    const container = page.querySelector<HTMLElement>(".chat-split-view__drop-container");
    expect(pane).toBeDefined();
    expect(container).not.toBeNull();
    // This host test stubs the stateful chat pane; mirror its exact light-DOM
    // header ownership while the E2E test proves the real component output.
    const header = document.createElement("div");
    header.className = "chat-pane__header";
    pane!.prepend(header);
    expect(header.closest("openclaw-chat-pane")).toBe(pane);
    const paneRect = { left: 100, top: 50, width: 200, height: 100 } as DOMRect;
    const containerRect = { left: 100, top: 50, width: 400, height: 100 } as DOMRect;
    vi.spyOn(pane!, "getBoundingClientRect").mockReturnValue(paneRect);
    vi.spyOn(container!, "getBoundingClientRect").mockReturnValue(containerRect);
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    const dataTransfer = {
      dropEffect: "none",
      getData: (type: string) => (type === SESSION_DRAG_MIME ? WORK_SESSION_KEY : ""),
      types: [SESSION_DRAG_MIME],
    } as unknown as DataTransfer;

    const unrelatedTarget = page.querySelector(".chat-split-view");
    expect(getDropIndicator(page)).toBeNull();
    handleDragOver(page, {
      target: unrelatedTarget,
      clientX: 200,
      clientY: 100,
      preventDefault: vi.fn(),
      dataTransfer,
    } as unknown as DragEvent);
    handleDrop(page, {
      target: unrelatedTarget,
      clientX: 200,
      clientY: 100,
      preventDefault: vi.fn(),
      dataTransfer,
    } as unknown as DragEvent);
    expect(getDropIndicator(page)).toBeNull();
    expect(getLayout(page)).toBe(layout);
    expect(navigation.replace).not.toHaveBeenCalled();

    handleDragOver(page, {
      target: header,
      clientX: 200,
      clientY: 100,
      preventDefault: vi.fn(),
      dataTransfer,
    } as unknown as DragEvent);
    frame?.(0);

    expect(getDropIndicator(page)?.paneId).toBe("p1");
    expect(getDropIndicator(page)?.zone).toEqual({ kind: "center" });

    handleDrop(page, {
      target: header,
      clientX: 200,
      clientY: 100,
      preventDefault: vi.fn(),
      dataTransfer,
    } as unknown as DragEvent);

    expect(getLayout(page)?.columns.at(0)?.panes.at(0)?.sessionKey).toBe(WORK_SESSION_KEY);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      pathname: sessionPath(WORK_SESSION_KEY),
    });
  });
});
