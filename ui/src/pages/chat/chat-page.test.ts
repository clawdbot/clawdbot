/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page.test/"} */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The dedicated jsdom context keeps this host-only mock from sharing the
// production tag registry with component tests.
vi.mock("./chat-pane.ts", () => ({}));

import { loadSettings } from "../../app/settings.ts";
import type { ResizableDivider } from "../../components/resizable-divider.ts";
import { SESSION_DRAG_MIME } from "../../lib/sessions/drag.ts";
import { searchForSession } from "../../lib/sessions/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ChatPage } from "./chat-page.ts";
import type { SplitDropZone } from "./split-drop-zone.ts";
import { createSplitLayout, type ChatSplitLayout } from "./split-layout.ts";

type RenderedPane = HTMLElement & {
  paneId: string;
  sessionKey: string;
  active: boolean;
};

function setLayout(page: ChatPage, layout: ChatSplitLayout | undefined) {
  (page as unknown as { layout: ChatSplitLayout | undefined }).layout = layout;
}

function getLayout(page: ChatPage): ChatSplitLayout | undefined {
  return (page as unknown as { layout: ChatSplitLayout | undefined }).layout;
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

function setNavigationContext(page: ChatPage) {
  const navigate = vi.fn();
  const replace = vi.fn();
  (page as unknown as { context: { navigate: typeof navigate; replace: typeof replace } }).context =
    {
      navigate,
      replace,
    };
  return { navigate, replace };
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches,
      media: "(max-width: 1099px)",
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

  it("renders one chrome-free active pane in classic mode", async () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main", draft: "hello" };
    document.body.append(page);
    await page.updateComplete;

    const panes = page.querySelectorAll<RenderedPane>("openclaw-chat-pane");
    expect(panes).toHaveLength(1);
    expect(panes[0].paneId).toBe("single");
    expect(panes[0].sessionKey).toBe("main");
    expect(panes[0].active).toBe(true);
    expect(page.querySelector("resizable-divider")).toBeNull();
    expect(page.querySelector(".chat-open-split-view")).toBeInstanceOf(HTMLButtonElement);
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
    const dividers = page.querySelectorAll<ResizableDivider>("resizable-divider");
    expect(panes.map((pane) => pane.paneId)).toEqual(["p1", "p2"]);
    expect(panes.map((pane) => pane.active)).toEqual([false, true]);
    expect(dividers).toHaveLength(1);
    expect(dividers[0].orientation).toBe("vertical");
    expect(page.querySelector(".chat-split-view__pane--active")).toBe(panes[1]);
    expect(page.querySelectorAll(".chat-split-toolbar__pane")).toHaveLength(2);
    expect(page.querySelector(".chat-split-toolbar__pane--active")).not.toBeNull();
    expect(page.querySelector(".chat-open-split-view")).toBeNull();
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
    expect(panes[0].active).toBe(true);
    expect(page.querySelectorAll(".chat-split-toolbar__pane")).toHaveLength(1);
    expect(page.querySelector("resizable-divider")).toBeNull();
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

    const titlesBefore = [...page.querySelectorAll(".chat-pane__session-title")];
    expect(titlesBefore.map((title) => title.textContent?.trim())).toEqual([
      "Main Session",
      "Main Session",
    ]);
    // The pane header is intentionally a static, non-interactive title: the
    // strip doubles as the Mac app titlebar drag area, so no form control may
    // sit there. Sessions change via the sidebar or drag-and-drop instead.
    expect(page.querySelector(".chat-split-toolbar select")).toBeNull();

    sessionsState.result = {
      sessions: [{ key: "main", displayName: "Main desk" }],
    };
    notify();
    await page.updateComplete;

    const titles = [...page.querySelectorAll(".chat-pane__session-title")];
    expect(titles.map((title) => title.textContent?.trim())).toEqual(["Main desk", "Main desk"]);

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

    applySessionDrop(page, "agent:main:work", "single", { kind: "center" });

    expect(getLayout(page)).toBeUndefined();
    expect(loadSettings().chatSplitLayout).toBeUndefined();
    expect(navigation.navigate).toHaveBeenCalledWith("chat", {
      search: searchForSession("agent:main:work"),
    });
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("creates and persists a classic-mode edge drop on the chosen side", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    const navigation = setNavigationContext(page);

    applySessionDrop(page, "agent:main:work", "single", { kind: "edge", edge: "left" });

    const layout = getLayout(page);
    expect(layout?.columns.map((column) => column.panes.map((pane) => pane.sessionKey))).toEqual([
      ["agent:main:work"],
      ["main"],
    ]);
    expect(layout?.activePaneId).toBe("p2");
    expect(loadSettings().chatSplitLayout).toEqual(layout);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      search: searchForSession("agent:main:work"),
    });
  });

  it("inserts and persists a dropped session at a layout edge", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    setLayout(page, createSplitLayout("main"));
    const navigation = setNavigationContext(page);

    applySessionDrop(page, "agent:main:work", "p1", { kind: "edge", edge: "down" });

    const layout = getLayout(page);
    expect(layout?.columns[0].panes.map((pane) => pane.sessionKey)).toEqual([
      "main",
      "agent:main:work",
    ]);
    expect(layout?.activePaneId).toBe("p3");
    expect(loadSettings().chatSplitLayout).toEqual(layout);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      search: searchForSession("agent:main:work"),
    });
  });

  it("replaces and activates the pane under a layout center drop", () => {
    const page = new ChatPage();
    page.data = { sessionKey: "main" };
    setLayout(page, createSplitLayout("main"));
    const navigation = setNavigationContext(page);

    applySessionDrop(page, "agent:main:work", "p1", { kind: "center" });

    const layout = getLayout(page);
    expect(layout?.columns[0].panes[0].sessionKey).toBe("agent:main:work");
    expect(layout?.activePaneId).toBe("p1");
    expect(loadSettings().chatSplitLayout).toEqual(layout);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      search: searchForSession("agent:main:work"),
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
        getData: (type: string) => (type === SESSION_DRAG_MIME ? "agent:main:work" : ""),
      } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(getLayout(page)?.columns.map((column) => column.panes[0].sessionKey)).toEqual([
      "agent:main:work",
      "main",
      "main",
    ]);
    expect(navigation.replace).toHaveBeenCalledWith("chat", {
      search: searchForSession("agent:main:work"),
    });
  });
});
