import { render } from "lit";
import { describe, expect, it } from "vitest";
import { t } from "../i18n/index.ts";
import { renderChatControls } from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";

function createState(overrides: Partial<AppViewState> = {}) {
  return {
    connected: true,
    chatLoading: false,
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
    ...overrides,
  } as unknown as AppViewState;
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
});
