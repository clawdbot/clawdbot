/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteId } from "../app-route-paths.ts";
import { chatInputOwnerForContext } from "../app/chat-input-owner.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { publishChatWorkContext, type ChatWorkContext } from "../pages/chat/chat-work-context.ts";
import { createContext } from "../pages/custodian/custodian-page.test-harness.ts";
import { CustodianSessionStore } from "../pages/custodian/custodian-session-store.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT, HOME_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import "./assistant-panel.ts";

vi.mock("./home-session.runtime.ts", () => {
  if (!customElements.get("openclaw-home-session")) {
    customElements.define("openclaw-home-session", class extends HTMLElement {});
  }
  return {};
});

type TestAssistantPanel = HTMLElement & {
  custodianAvailable: boolean;
  homeAvailable: boolean;
  pageRouteId: RouteId;
  pageSessionKey: string;
  pageAgentId: string;
  assistantPanelOpen: boolean;
  minimizeRequestId: number;
  store: CustodianSessionStore;
  custodianSuppressed: boolean;
  updateComplete: Promise<boolean>;
};

async function mountPanel(options: { global?: boolean } = {}) {
  const request = vi.fn().mockResolvedValue({
    sessionId: "panel-session",
    reply: "Ready.",
    action: "none",
  });
  const { context: baseContext } = createContext(
    request,
    ["openclaw.chat", "chat.history", "chat.send"],
    {
      agentsList: {
        defaultId: "main",
        mainKey: "home",
        scope: options.global ? "global" : "per-sender",
        agents: [
          { id: "main", model: { primary: "openai/gpt-5.5" } },
          { id: "research" },
          { id: "care", kind: "system" },
        ],
      },
    },
  );
  const context = { ...baseContext, sessions: createSessionCapability(baseContext.gateway) };
  const provider = createApplicationContextProvider(context);
  const store = new CustodianSessionStore();
  const panel = document.createElement("openclaw-assistant-panel") as TestAssistantPanel;
  panel.store = store;
  panel.custodianAvailable = true;
  panel.custodianSuppressed = true;
  provider.append(panel);
  document.body.append(provider);
  await panel.updateComplete;
  return { context, panel, request, store };
}

describe("assistant panel", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.style.removeProperty("--oc-assistant-reserve-bottom");
    document.documentElement.style.removeProperty("--oc-assistant-reserve-right");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "follows the sidebar agent switcher and suppresses only the selected conversation (global=%s)",
    async (global) => {
      const { context, panel, store } = await mountPanel({ global });
      const refresh = vi.spyOn(store, "refreshTranscriptIfIdle");
      panel.homeAvailable = true;
      panel.custodianAvailable = false;
      panel.pageSessionKey = "agent:research:task";
      panel.pageAgentId = "research";
      panel.pageRouteId = "chat";
      await panel.updateComplete;
      window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
      await vi.dynamicImportSettled();
      await panel.updateComplete;
      const home = () =>
        panel.querySelector<HTMLElement & { sessionKey: string; agentId: string }>(
          "openclaw-home-session",
        );
      expect(home()?.sessionKey).toBe(global ? "global" : "agent:main:home");
      expect(home()?.agentId).toBe("main");
      expect(refresh).not.toHaveBeenCalled();
      expect(chatInputOwnerForContext(context).current).toBe("dock");
      // One switcher: the dock renders no agent selector of its own.
      expect(panel.querySelector("select")).toBeNull();

      // The dock follows the sidebar agent switcher.
      context.agentSelection.state.selectedId = "research";
      panel.pageSessionKey = "agent:research:other-task";
      await panel.updateComplete;
      expect(home()?.agentId).toBe("research");
      expect(home()?.sessionKey).toBe(global ? "global" : "agent:research:home");
      expect(panel.assistantPanelOpen).toBe(true);

      // System agents stay valid chat targets elsewhere but never become the dock target.
      context.agentSelection.state.selectedId = "care";
      panel.pageSessionKey = "agent:research:task";
      await panel.updateComplete;
      expect(home()?.agentId).toBe("main");
      context.agentSelection.state.selectedId = "research";

      // The selected agent's own Home page suppresses the dock; leaving restores it.
      panel.pageSessionKey = global ? "global" : "agent:research:home";
      await panel.updateComplete;
      expect(home()).toBeNull();
      expect(chatInputOwnerForContext(context).current).toBe("page");
      panel.pageRouteId = "appearance";
      await panel.updateComplete;
      expect(home()?.agentId).toBe("research");

      context.gateway.snapshot.phase = "offline";
      context.gateway.snapshot.hello = null;
      context.agents.state.agentsList = null;
      panel.pageSessionKey = "agent:research:offline-task";
      await panel.updateComplete;
      expect(home()?.sessionKey).toBe(global ? "global" : "agent:research:home");
      expect(home()?.agentId).toBe("research");
      window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT));
      await panel.updateComplete;
      expect(home()?.agentId).toBe("research");
      panel.remove();
      expect(chatInputOwnerForContext(context).current).toBe("page");
    },
  );

  it("prepares current route and pane context when Home opens and the visible work changes", async () => {
    const { context, panel } = await mountPanel({ global: true });
    context.sessions.state.result = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        { key: "global", agentId: "main", kind: "global", updatedAt: 0, label: "Personal Home" },
        {
          key: "global",
          agentId: "research",
          kind: "global",
          updatedAt: 0,
          label: "Parser work",
          sessionId: "research-incarnation",
          spawnedWorkspaceDir: "/worktrees/parser",
        },
      ],
    };
    panel.pageSessionKey = "global";
    panel.pageAgentId = "research";
    panel.homeAvailable = true;
    const pane = {};
    publishChatWorkContext(context, pane, {
      sessionKey: "global",
      agentId: "research",
      file: "src/parser.ts",
    });
    await panel.updateComplete;
    window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
    await vi.dynamicImportSettled();
    await panel.updateComplete;
    const workContext = () =>
      panel.querySelector<HTMLElement & { workContext: ChatWorkContext }>("openclaw-home-session")
        ?.workContext;
    const expected = {
      page: "chat",
      sessionKey: "global",
      agentId: "research",
      sessionId: "research-incarnation",
      title: "Parser work",
      workspace: "/worktrees/parser",
      file: "src/parser.ts",
    };
    expect(workContext()).toEqual(expected);
    panel.pageRouteId = "appearance";
    await panel.updateComplete;
    expect(workContext()).toEqual({ page: "appearance" });
    panel.pageRouteId = "chat";
    publishChatWorkContext(context, pane, {
      sessionKey: "global",
      agentId: "research",
      file: "src/tokenizer.ts",
    });
    await panel.updateComplete;
    expect(workContext()).toEqual({ ...expected, file: "src/tokenizer.ts" });
    publishChatWorkContext(context, pane);
    await panel.updateComplete;
    const { file: _file, ...withoutFile } = expected;
    expect(workContext()).toEqual(withoutFile);
  });

  it("restores the Home destination after remount and shares one dock with Ask", async () => {
    const { panel } = await mountPanel();
    panel.homeAvailable = true;
    panel.custodianSuppressed = false;
    await panel.updateComplete;
    window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
    await vi.dynamicImportSettled();
    await panel.updateComplete;
    expect(panel.querySelector("openclaw-home-session")).not.toBeNull();
    panel.remove();

    const { panel: replacement } = await mountPanel();
    replacement.homeAvailable = true;
    replacement.custodianSuppressed = false;
    await replacement.updateComplete;
    const home = replacement.querySelector<HTMLElement & { agentId: string }>(
      "openclaw-home-session",
    );
    expect(home?.agentId).toBe("main");
    expect(replacement.assistantPanelOpen).toBe(true);
    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT));
    await replacement.updateComplete;
    expect(replacement.querySelector("openclaw-home-session")).toBeNull();
    expect(replacement.querySelector("openclaw-custodian-surface")).not.toBeNull();
    expect(replacement.querySelectorAll(".assistant-panel")).toHaveLength(1);
  });

  it("minimizes a real page conversation into the dock on route leave", async () => {
    const { context, panel, request, store } = await mountPanel();
    store.connect(context, "caretaker");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    store.messages = [
      { id: 1, role: "assistant", text: "Ready.", at: 1, question: null, step: null },
      { id: 2, role: "user", text: "Check this system", at: 2, question: null, step: null },
    ];

    panel.custodianSuppressed = false;
    panel.minimizeRequestId = 1;
    await panel.updateComplete;

    expect(panel.assistantPanelOpen).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--oc-assistant-reserve-right")).toBe(
      "440px",
    );

    panel
      .querySelector<HTMLButtonElement>(
        ".assistant-panel-actions .assistant-panel-icon:last-child",
      )!
      .click();
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);

    panel.custodianSuppressed = true;
    await panel.updateComplete;

    panel.custodianSuppressed = false;
    panel.minimizeRequestId = 2;
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);
  });

  it("hides and restores the dock across full-page suppression", async () => {
    const { panel, store } = await mountPanel();
    store.messages = [
      { id: 1, role: "user", text: "Check this system", at: 1, question: null, step: null },
    ];

    panel.custodianSuppressed = false;
    panel.minimizeRequestId = 1;
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);

    panel.custodianSuppressed = true;
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);

    panel.custodianSuppressed = false;
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);

    panel.custodianSuppressed = true;
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
  });

  it("opens and closes from the global toggle event", async () => {
    const { panel, store } = await mountPanel();
    const refresh = vi.spyOn(store, "refreshTranscriptIfIdle");
    panel.custodianSuppressed = false;
    await panel.updateComplete;

    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT));
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);
    expect(refresh).toHaveBeenCalled();

    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT));
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
  });

  it.each(["right", "bottom"])("drags only passive header chrome when docked %s", async (dock) => {
    const { panel } = await mountPanel();
    panel.custodianSuppressed = false;
    await panel.updateComplete;
    window.dispatchEvent(
      new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true, dock } }),
    );
    await panel.updateComplete;

    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawWindowDrag: { postMessage } } });
    const cases = [
      [".assistant-panel-header", true],
      [".assistant-panel-title", true],
      [".assistant-panel-actions", true],
      [".assistant-panel-actions button:first-child", false],
      [".assistant-panel-actions button:first-child svg", false],
      [".assistant-panel-actions button:last-child", false],
      [".assistant-panel-actions button:last-child svg", false],
      ["openclaw-custodian-surface", false],
    ] as const;
    for (const [selector, draggable] of cases) {
      postMessage.mockClear();
      const target = panel.querySelector(selector);
      expect(target, selector).not.toBeNull();
      const event = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
      });
      target!.dispatchEvent(event);
      expect(postMessage, selector).toHaveBeenCalledTimes(draggable ? 1 : 0);
      if (draggable) {
        expect(postMessage).toHaveBeenCalledWith({ type: "window-drag" });
      }
      expect(event.defaultPrevented, selector).toBe(draggable);
    }

    panel.querySelector<HTMLButtonElement>(".assistant-panel-actions button:first-child")!.click();
    await panel.updateComplete;
    expect(
      panel.querySelector(`.assistant-panel--${dock === "right" ? "bottom" : "right"}`),
    ).not.toBeNull();
    panel.querySelector<HTMLButtonElement>(".assistant-panel-actions button:last-child")!.click();
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
  });

  it("ignores toggle requests while unavailable", async () => {
    const { panel } = await mountPanel();
    panel.custodianAvailable = false;
    panel.custodianSuppressed = false;
    await panel.updateComplete;

    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
    await panel.updateComplete;

    expect(panel.assistantPanelOpen).toBe(false);
  });

  it("honors a minimize request when chat becomes available after route leave", async () => {
    const { context, panel, request, store } = await mountPanel();
    store.connect(context, "caretaker");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    store.messages = [
      { id: 1, role: "user", text: "Check this system", at: 1, question: null, step: null },
    ];
    panel.custodianAvailable = false;
    panel.custodianSuppressed = false;
    panel.minimizeRequestId = 1;
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);

    panel.custodianAvailable = true;
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);
  });

  it("preserves an onboarding session variant when it minimizes into the dock", async () => {
    const { context, panel, request, store } = await mountPanel();
    store.connect(context, "onboarding");
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    store.messages = [
      {
        id: 1,
        role: "assistant",
        text: "Set up your system",
        at: 1,
        question: null,
        step: null,
      },
      { id: 2, role: "user", text: "Continue setup", at: 2, question: null, step: null },
    ];

    panel.custodianSuppressed = false;
    panel.minimizeRequestId = 1;
    await panel.updateComplete;
    const surface = panel.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-custodian-surface",
    );
    await surface?.updateComplete;

    expect(store.activeVariant).toBe("onboarding");
    expect(request).toHaveBeenCalledOnce();
    expect(panel.textContent).toContain("Continue setup");
  });

  it("updates the panel mascot mood with shared sending state", async () => {
    const { panel, store } = await mountPanel();
    store.messages = [
      { id: 1, role: "user", text: "Check this system", at: 1, question: null, step: null },
    ];
    panel.custodianSuppressed = false;
    panel.minimizeRequestId = 1;
    await panel.updateComplete;

    store.sending = true;
    store.setInput("status");
    await panel.updateComplete;

    expect(
      (
        panel.querySelector(".assistant-panel-title openclaw-mascot") as HTMLElement & {
          mood: string;
        }
      ).mood,
    ).toBe("thinking");
  });
});
