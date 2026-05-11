import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { t } from "../i18n/index.ts";
import { renderChatControls, renderChatMobileToggle } from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import type { SessionsListResult } from "./types.ts";

type SessionRow = SessionsListResult["sessions"][number];

function row(overrides: Partial<SessionRow> & { key: string }): SessionRow {
  return { kind: "direct", updatedAt: 0, ...overrides };
}

function createState(overrides: Partial<AppViewState> = {}) {
  return {
    connected: true,
    chatLoading: false,
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    onboarding: false,
    sessionKey: "main",
    sessionsHideCron: true,
    sessionsResult: {
      ts: 0,
      path: "",
      count: 0,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [],
    },
    settings: {
      gatewayUrl: "",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navWidth: 280,
      navCollapsed: false,
      navGroupsCollapsed: {},
      borderRadius: 50,
      chatFocusMode: false,
      chatShowThinking: false,
      chatShowToolCalls: true,
    },
    applySettings: () => undefined,
    chatMobileControlsOpen: false,
    setChatMobileControlsOpen: () => undefined,
    chatModelCatalog: [],
    chatModelOverrides: {},
    chatModelsLoading: false,
    client: { request: vi.fn() },
    ...overrides,
  } as unknown as AppViewState;
}

function renderRefreshButton(overrides: Partial<AppViewState> = {}) {
  const container = document.createElement("div");
  render(renderChatControls(createState(overrides)), container);

  const button = container.querySelector<HTMLButtonElement>(
    `.chat-controls .btn--icon[data-tooltip="${t("chat.refreshTitle")}"]`,
  );
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Expected chat refresh button");
  }
  return button;
}

function requireButton(
  button: HTMLButtonElement | null | undefined,
  label: string,
): HTMLButtonElement {
  expect(button).toBeInstanceOf(HTMLButtonElement);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${label} button`);
  }
  return button;
}

function requireElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element).toBeInstanceOf(Element);
  if (!element) {
    throw new Error(`Expected ${label} element`);
  }
  return element;
}

describe("chat header controls (browser)", () => {
  it("renders explicit hover tooltip metadata for the top-right action buttons", async () => {
    const container = document.createElement("div");
    render(renderChatControls(createState()), container);
    await Promise.resolve();

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".chat-controls .btn--icon[data-tooltip]"),
    );

    expect(buttons).toHaveLength(5);

    const labels = buttons.map((button) => button.getAttribute("data-tooltip"));
    expect(labels).toEqual([
      t("chat.refreshTitle"),
      t("chat.thinkingToggle"),
      t("chat.toolCallsToggle"),
      t("chat.focusToggle"),
      t("chat.showCronSessions"),
    ]);

    for (const button of buttons) {
      expect(button.getAttribute("title")).toBe(button.getAttribute("data-tooltip"));
      expect(button.getAttribute("aria-label")).toBe(button.getAttribute("data-tooltip"));
    }
  });

  it.each([
    ["connected and idle", {}, false],
    ["chat history loading", { chatLoading: true }, true],
    ["chat send in flight", { chatSending: true }, true],
    ["active run", { chatRunId: "run-123" }, true],
    ["active stream", { chatStream: "streaming" }, true],
    ["disconnected", { connected: false }, true],
  ] as const)("sets refresh disabled state while %s", (_name, overrides, disabled) => {
    const button = renderRefreshButton(overrides);

    expect(button.disabled).toBe(disabled);
  });

  it("renders the cron session filter in the mobile dropdown controls", async () => {
    const state = createState({
      sessionKey: "agent:alpha:main",
      agentsList: {
        defaultId: "alpha",
        mainKey: "agent:alpha:main",
        scope: "all",
        agents: [
          { id: "alpha", name: "Alpha" },
          { id: "beta", name: "Beta" },
        ],
      },
      sessionsResult: {
        ts: 0,
        path: "",
        count: 3,
        defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
        sessions: [
          row({ key: "agent:alpha:main" }),
          row({ key: "agent:alpha:cron:daily-briefing" }),
          row({ key: "agent:beta:cron:nightly-check" }),
        ],
      },
    });
    const container = document.createElement("div");
    render(renderChatMobileToggle(state), container);
    await Promise.resolve();

    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".chat-controls__thinking .btn--icon"),
    );

    expect(buttons).toHaveLength(4);
    const cronButton = requireButton(buttons.at(-1), "cron sessions");
    expect(cronButton.classList.contains("active")).toBe(true);
    expect(cronButton.getAttribute("aria-pressed")).toBe("true");
    expect(cronButton.getAttribute("title")).toBe(t("chat.showCronSessionsHidden", { count: "1" }));

    cronButton.click();

    expect(state.sessionsHideCron).toBe(false);
  });

  it("uses the shared chat session controls in the mobile dropdown", async () => {
    const state = createState({
      sessionKey: "agent:alpha:main",
      chatMobileControlsOpen: true,
      agentsList: {
        defaultId: "alpha",
        mainKey: "agent:alpha:main",
        scope: "all",
        agents: [
          { id: "alpha", name: "Alpha" },
          { id: "beta", name: "Beta" },
        ],
      },
      sessionsResult: {
        ts: 0,
        path: "",
        count: 2,
        defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
        sessions: [
          row({ key: "agent:alpha:main" }),
          row({ key: "agent:beta:dashboard:recent", label: "Beta recent" }),
        ],
      },
    });
    const container = document.createElement("div");
    render(renderChatMobileToggle(state), container);
    await Promise.resolve();

    const sessionRows = container.querySelectorAll(".chat-controls__session-row");
    expect(sessionRows).toHaveLength(1);
    const selectDatasets = Array.from(container.querySelectorAll("select")).map(
      (select) => select.dataset,
    );
    expect(selectDatasets).toHaveLength(4);
    expect(selectDatasets[0]?.chatAgentFilter).toBe("true");
    expect(selectDatasets[1]?.chatSessionSelect).toBe("true");
    expect(selectDatasets[2]?.chatModelSelect).toBe("true");
    expect(selectDatasets[3]?.chatThinkingSelect).toBe("true");
  });

  it("renders the mobile dropdown from state instead of mutating DOM classes", async () => {
    const setChatMobileControlsOpen = vi.fn();
    const state = createState({
      chatMobileControlsOpen: false,
      setChatMobileControlsOpen,
    });
    const container = document.createElement("div");
    render(renderChatMobileToggle(state), container);
    await Promise.resolve();

    const toggle = requireButton(
      container.querySelector<HTMLButtonElement>(".chat-controls-mobile-toggle"),
      "mobile controls toggle",
    );
    const dropdown = requireElement(
      container.querySelector<HTMLElement>(".chat-controls-dropdown"),
      "mobile controls dropdown",
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("chat-mobile-controls-dropdown");
    expect(dropdown.id).toBe("chat-mobile-controls-dropdown");
    expect(dropdown.classList.contains("open")).toBe(false);

    toggle.click();

    expect(setChatMobileControlsOpen).toHaveBeenCalledWith(true, { trigger: toggle });
    expect(dropdown.classList.contains("open")).toBe(false);

    render(
      renderChatMobileToggle(
        createState({
          chatMobileControlsOpen: true,
          setChatMobileControlsOpen,
        }),
      ),
      container,
    );
    await Promise.resolve();

    const openToggle = requireButton(
      container.querySelector<HTMLButtonElement>(".chat-controls-mobile-toggle"),
      "open mobile controls toggle",
    );
    const openDropdown = requireElement(
      container.querySelector<HTMLElement>(".chat-controls-dropdown"),
      "open mobile controls dropdown",
    );
    expect(openToggle.getAttribute("aria-expanded")).toBe("true");
    expect(openDropdown.classList.contains("open")).toBe(true);
  });
});
