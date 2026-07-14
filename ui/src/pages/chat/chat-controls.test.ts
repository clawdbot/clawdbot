/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { UiSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { renderChatControls } from "./components/chat-controls.ts";

type ChatControlsProps = Parameters<typeof renderChatControls>[0];

vi.mock("../../components/icons.ts", () => ({
  icons: {},
}));

function createSettings(): UiSettings {
  return {
    gatewayUrl: "ws://localhost:18789",
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "dark",
    chatShowThinking: true,
    chatShowToolCalls: true,
    chatPersistCommentary: false,
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: 280,
    sidebarPinnedRoutes: ["workboard", "tasks"],
  };
}

function createProps(overrides: Record<string, unknown> = {}): ChatControlsProps {
  return {
    paneId: "test-pane",
    model: {
      activeRunId: null,
      connected: true,
      gatewayAvailable: true,
      loading: false,
      modelCatalog: [],
      modelSwitching: false,
      sending: false,
      sessionKey: "main",
      sessionsResult: null,
      stream: null,
    },
    onboarding: false,
    settings: createSettings(),
    viewMenuOpen: true,
    onSettingsChange: () => undefined,
    onViewMenuOpenChange: () => undefined,
    ...overrides,
  } as unknown as ChatControlsProps;
}

function menuItems(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement & { checked: boolean; disabled: boolean }>(
      ".chat-view-menu__item",
    ),
  );
}

describe("chat composer view menu", () => {
  it("renders the three display rows with their checked state", () => {
    const container = document.createElement("div");
    render(renderChatControls(createProps()), container);

    const items = menuItems(container);
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      t("chat.view.reasoning"),
      t("chat.view.toolCalls"),
      t("chat.view.commentary"),
    ]);
    expect(items.map((item) => item.checked)).toEqual([true, true, false]);
  });

  it("toggles settings from the menu rows", () => {
    const container = document.createElement("div");
    const onSettingsChange = vi.fn();
    render(renderChatControls(createProps({ onSettingsChange })), container);

    const [reasoning, toolCalls, commentary] = menuItems(container);
    const dropdown = container.querySelector("wa-dropdown");
    const select = (item: HTMLElement) =>
      dropdown?.dispatchEvent(
        new CustomEvent("wa-select", {
          bubbles: true,
          cancelable: true,
          composed: true,
          detail: { item },
        }),
      );
    select(reasoning!);
    expect(onSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatShowThinking: false }),
    );
    select(toolCalls!);
    expect(onSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatShowToolCalls: false }),
    );
    select(commentary!);
    expect(onSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatPersistCommentary: true }),
    );
  });

  it("disables the rows and pins display state during onboarding", () => {
    const container = document.createElement("div");
    const onSettingsChange = vi.fn();
    render(renderChatControls(createProps({ onboarding: true, onSettingsChange })), container);

    const items = menuItems(container);
    expect(items.every((item) => item.disabled)).toBe(true);
    // Onboarding forces thinking hidden and tool calls visible.
    expect(items.map((item) => item.checked)).toEqual([false, true, false]);
    container.querySelector("wa-dropdown")?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        cancelable: true,
        composed: true,
        detail: { item: items[0] },
      }),
    );
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("keeps the composer control cluster limited to the view menu and model controls", () => {
    const container = document.createElement("div");
    render(renderChatControls(createProps()), container);

    expect(Array.from(container.children).map((node) => node.className)).toEqual([
      "chat-view-menu-wrapper",
      "chat-composer-model-control",
    ]);
    expect(container.querySelector('[data-chat-provider-usage="true"]')).toBeNull();
  });
});
