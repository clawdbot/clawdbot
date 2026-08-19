/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-page-retained.test/"} */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./chat-pane.ts", () => ({}));
vi.mock("../../app/native-gateways.runtime.ts", () => ({
  nativeGatewaysCapability: () => null,
}));

import type { ApplicationContext } from "../../app/context.ts";
import { SESSION_NAVIGATION_INTENT_EVENT } from "../../lib/sessions/navigation-handoff.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ChatPage } from "./chat-page.ts";

type RenderedPane = HTMLElement & {
  active: boolean;
  focusComposer: boolean;
  onFaceChange?: (paneId: string, sessionKey: string, face: "chat" | "dashboard") => void;
  onPaneSessionChange?: (
    paneId: string,
    nextSessionKey: string,
    options?: { replace?: boolean },
  ) => boolean | void;
  onSessionDeleted?: (paneId: string, sessionKey: string, replacementSessionKey: string) => void;
  paneId: string;
  presentationId: string;
  presented: boolean;
  sessionKey: string;
};

function setNavigationContext(page: ChatPage) {
  const navigate = vi.fn();
  const replace = vi.fn();
  const patch = vi.fn(async () => null);
  const agentSelectionState = { selectedId: "main" };
  const chatAttachmentHandoff = {
    prepare: vi.fn(),
    consume: vi.fn(() => null),
    clearPane: vi.fn(),
    dispose: vi.fn(),
  };
  const context = {
    basePath: "",
    sessions: { state: { result: null }, subscribe: () => () => undefined, patch },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    gateway: { snapshot: { hello: null }, subscribe: () => () => undefined },
    navigate,
    replace,
    agentSelection: {
      state: agentSelectionState,
      set: vi.fn((agentId: string) => {
        agentSelectionState.selectedId = agentId;
      }),
    },
    chatAttachmentHandoff,
  } as unknown as ApplicationContext;
  (page as unknown as { context: ApplicationContext }).context = context;
  return { chatAttachmentHandoff, navigate, patch, replace };
}

function stubMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
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

async function showSession(page: ChatPage, sessionKey: string): Promise<void> {
  page.data = { sessionKey };
  await page.updateComplete;
  await page.updateComplete;
}

async function mountRetainedPage(sessionKey: string, ...warmSessionKeys: string[]) {
  const page = new ChatPage();
  const navigation = setNavigationContext(page);
  page.data = { sessionKey };
  document.body.append(page);
  await page.updateComplete;
  for (const key of warmSessionKeys) {
    await showSession(page, key);
  }
  const panes = () => [...page.querySelectorAll<RenderedPane>("openclaw-chat-pane")];
  const paneFor = (key: string) => panes().find((pane) => pane.sessionKey === key);
  return { navigation, page, paneFor, panes };
}

describe("chat page retained sessions", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    localStorage.clear();
    stubMatchMedia();
  });

  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("retains three session panes and reactivates them without remounting", async () => {
    const { page, paneFor, panes } = await mountRetainedPage("agent:main:a");
    const paneA = paneFor("agent:main:a");
    expect(paneA).toBeDefined();

    await showSession(page, "agent:main:b");
    const paneB = paneFor("agent:main:b");
    expect(paneB).toBeDefined();
    expect(paneB?.presentationId).not.toBe(paneA?.presentationId);
    expect(paneA?.active).toBe(false);
    expect(paneA?.presented).toBe(false);
    expect(paneA?.hasAttribute("inert")).toBe(true);
    expect(paneA?.getAttribute("aria-hidden")).toBe("true");
    expect(paneB?.active).toBe(true);
    expect(paneB?.presented).toBe(true);
    expect(paneB?.hasAttribute("inert")).toBe(false);

    await showSession(page, "agent:main:a");
    expect(paneFor("agent:main:a")).toBe(paneA);
    expect(paneFor("agent:main:b")).toBe(paneB);

    await showSession(page, "agent:main:c");
    await showSession(page, "agent:main:d");
    expect(
      panes()
        .map((pane) => pane.sessionKey)
        .toSorted(),
    ).toEqual(["agent:main:a", "agent:main:c", "agent:main:d"]);
    expect(paneB?.isConnected).toBe(false);
  });

  it("hands route-owned focus to the final page across pane replacement", async () => {
    const sourcePage = new ChatPage();
    setNavigationContext(sourcePage);
    sourcePage.data = {
      sessionKey: "main",
      draft: "What can you do?",
      focusComposer: true,
    };
    const page = new ChatPage();
    setNavigationContext(page);
    page.data = { sessionKey: "main" };

    vi.useFakeTimers();
    try {
      document.body.append(sourcePage);
      await sourcePage.updateComplete;
      await Promise.resolve();

      document.body.append(page);
      await page.updateComplete;
      const pane = expectDefined(
        page.querySelector<RenderedPane>("openclaw-chat-pane"),
        "retained chat pane",
      );
      expect(pane.focusComposer).toBe(true);

      const combobox = document.createElement("div");
      combobox.className = "agent-chat__composer-combobox";
      const textarea = document.createElement("textarea");
      combobox.append(textarea);
      pane.append(combobox);
      vi.advanceTimersByTime(250);
      expect(document.activeElement).toBe(textarea);

      const replacementPane = document.createElement("openclaw-chat-pane") as RenderedPane;
      replacementPane.active = true;
      replacementPane.sessionKey = "main";
      const replacementCombobox = document.createElement("div");
      replacementCombobox.className = "agent-chat__composer-combobox";
      const replacementTextarea = document.createElement("textarea");
      replacementCombobox.append(replacementTextarea);
      replacementPane.append(replacementCombobox);
      pane.replaceWith(replacementPane);

      vi.advanceTimersByTime(250);
      expect(document.activeElement).toBe(replacementTextarea);

      const userTarget = document.createElement("button");
      document.body.append(userTarget);
      userTarget.focus();
      vi.advanceTimersByTime(250);
      expect(document.activeElement).toBe(userTarget);
    } finally {
      sourcePage.remove();
      page.remove();
      vi.useRealTimers();
    }
  });

  it("rejects navigation and face changes from a hidden retained session", async () => {
    const { navigation, page, paneFor } = await mountRetainedPage("agent:main:a", "agent:main:b");
    const paneA = paneFor("agent:main:a");
    navigation.navigate.mockClear();
    navigation.patch.mockClear();

    expect(paneA?.onPaneSessionChange?.("p1", "agent:main:stale-result")).toBe(false);
    paneA?.onFaceChange?.("p1", "agent:main:a", "dashboard");

    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.patch).not.toHaveBeenCalled();
    expect(page.data.sessionKey).toBe("agent:main:b");

    page.remove();
    expect(navigation.chatAttachmentHandoff.clearPane).not.toHaveBeenCalled();
  });

  it("rejects a pane callback while a newer browser route is loading", async () => {
    const { navigation, page } = await mountRetainedPage("main");
    const pane = page.querySelector<RenderedPane>("openclaw-chat-pane");
    const previousHref = window.location.href;

    try {
      history.pushState(null, "", "/chat/main?catalog=pi&host=node&thread=next");

      expect(pane?.onPaneSessionChange?.("p1", "agent:main:main", { replace: true })).toBe(false);
      expect(navigation.replace).not.toHaveBeenCalled();
    } finally {
      history.replaceState(null, "", previousHref);
    }
  });

  it("presents a retained sidebar destination before route data resolves", async () => {
    const { page, paneFor, panes } = await mountRetainedPage(
      "agent:main:a",
      "agent:main:b",
      "agent:main:a",
    );
    const paneA = paneFor("agent:main:a");
    const paneB = paneFor("agent:main:b");

    const intent = new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
      cancelable: true,
      detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
    });
    window.dispatchEvent(intent);

    expect(intent.defaultPrevented).toBe(true);
    expect(page.data.sessionKey).toBe("agent:main:a");
    expect(paneA?.classList.contains("chat-pane-cache__pane--visible")).toBe(false);
    expect(paneA?.presented).toBe(true);
    expect(paneA?.hasAttribute("inert")).toBe(true);
    expect(paneA?.getAttribute("aria-hidden")).toBe("false");
    expect(paneB?.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
    expect(paneB?.presented).toBe(false);
    expect(paneB?.hasAttribute("inert")).toBe(true);
    expect(paneB?.getAttribute("aria-hidden")).toBe("true");
    expect(paneA?.active).toBe(true);
    expect(paneB?.active).toBe(false);

    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:a" },
      }),
    );
    expect(paneA?.classList.contains("chat-pane-cache__pane--visible")).toBe(true);
    expect(paneA?.presented).toBe(true);
    expect(paneA?.hasAttribute("inert")).toBe(false);
    expect(paneB?.classList.contains("chat-pane-cache__pane--visible")).toBe(false);
    expect(paneB?.presented).toBe(false);
    expect(paneB?.hasAttribute("inert")).toBe(true);

    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
      }),
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(paneA?.presented).toBe(true);
    expect(paneB?.presented).toBe(false);

    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
      }),
    );
    page.data = { sessionKey: "agent:main:b" };
    await page.updateComplete;
    await page.updateComplete;
    expect(panes().find((pane) => pane.sessionKey === "agent:main:b")).toBe(paneB);
    expect(paneA?.active).toBe(false);
    expect(paneA?.presented).toBe(false);
    expect(paneA?.hasAttribute("inert")).toBe(true);
    expect(paneB?.active).toBe(true);
    expect(paneB?.presented).toBe(true);
    expect(paneB?.hasAttribute("inert")).toBe(false);
  });

  it("evicts a deleted inactive retained session without redirecting the active pane", async () => {
    const { navigation, page, paneFor, panes } = await mountRetainedPage(
      "agent:main:a",
      "agent:main:b",
    );
    const paneA = paneFor("agent:main:a");
    navigation.navigate.mockClear();

    paneA?.onSessionDeleted?.("p1", "agent:main:a", "agent:main:main");
    await page.updateComplete;

    expect(panes().some((pane) => pane.sessionKey === "agent:main:a")).toBe(false);
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(page.data.sessionKey).toBe("agent:main:b");
  });

  it("rolls a retained preview back when authoritative navigation never commits", async () => {
    vi.useFakeTimers();
    try {
      const { paneFor } = await mountRetainedPage("agent:main:a", "agent:main:b", "agent:main:a");
      const paneA = paneFor("agent:main:a");
      const paneB = paneFor("agent:main:b");

      window.dispatchEvent(
        new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
          cancelable: true,
          detail: { commit: () => true, face: "chat", sessionKey: "agent:main:b" },
        }),
      );
      expect(paneA?.presented).toBe(true);
      expect(paneA?.hasAttribute("inert")).toBe(true);
      expect(paneB?.presented).toBe(false);
      expect(paneB?.hasAttribute("inert")).toBe(true);
      vi.advanceTimersByTime(5_000);

      expect(paneA?.presented).toBe(true);
      expect(paneA?.hasAttribute("inert")).toBe(false);
      expect(paneB?.presented).toBe(false);
      expect(paneB?.hasAttribute("inert")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot commit a retained navigation after supersession or page disposal", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
      frames.delete(frame);
    });
    const { page } = await mountRetainedPage(
      "agent:main:a",
      "agent:main:b",
      "agent:main:c",
      "agent:main:a",
    );
    const commitB = vi.fn(() => true);
    const commitC = vi.fn(() => true);

    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: commitB, face: "chat", sessionKey: "agent:main:b" },
      }),
    );
    frames.get(1)?.(0);
    const staleSecondFrame = frames.get(2);
    window.dispatchEvent(
      new CustomEvent(SESSION_NAVIGATION_INTENT_EVENT, {
        cancelable: true,
        detail: { commit: commitC, face: "chat", sessionKey: "agent:main:c" },
      }),
    );
    staleSecondFrame?.(16);
    frames.get(3)?.(16);
    const disposedSecondFrame = frames.get(4);

    expect(commitB).not.toHaveBeenCalled();
    page.remove();
    disposedSecondFrame?.(32);
    expect(commitC).not.toHaveBeenCalled();
  });
});
