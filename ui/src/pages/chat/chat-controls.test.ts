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
    chatAutoScroll: "near-bottom",
    splitRatio: 0.6,
    navCollapsed: false,
    navWidth: 280,
    sidebarPinnedRoutes: ["overview", "workboard", "agents"],
    sidebarMoreExpanded: false,
  };
}

function createProps(overrides: Record<string, unknown> = {}): ChatControlsProps {
  return {
    paneId: "test-pane",
    agentsList: null,
    connected: true,
    hideCronSessions: true,
    loading: false,
    manualRefreshInFlight: false,
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
    runId: null,
    sending: false,
    settings: createSettings(),
    settingsOpen: true,
    sessionKey: "main",
    sessionsResult: null,
    stream: null,
    onRefresh: () => undefined,
    onSettingsChange: () => undefined,
    onSettingsOpenChange: () => undefined,
    realtimeTalkOptions: {
      model: "",
      voice: "marin",
      vadThreshold: "",
    },
    realtimeTalkInputDevices: [
      { deviceId: "built-in", label: "Built-in Microphone" },
      { deviceId: "usb", label: "USB Audio Interface" },
    ],
    realtimeTalkInputDeviceId: "built-in",
    onRealtimeTalkInputRefresh: () => undefined,
    onRealtimeTalkInputSelect: () => undefined,
    onRealtimeTalkOptionsChange: () => undefined,
    ...overrides,
  } as unknown as ChatControlsProps;
}

describe("chat composer settings", () => {
  it("combines chat and voice controls in one Settings menu", () => {
    const container = document.createElement("div");
    render(renderChatControls(createProps()), container);

    expect(container.querySelectorAll(`button[aria-label="${t("chat.settings")}"]`)).toHaveLength(
      1,
    );
    expect(container.querySelector('[aria-label="Talk settings"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll(".chat-settings-popover__label")).map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Chat", "Voice"]);
    expect(container.querySelector('[aria-label="Voice options"]')).not.toBeNull();
    expect(container.querySelector('[data-talk-select="microphone"] select')).not.toBeNull();
  });

  it("keeps voice options editable from Settings", () => {
    const container = document.createElement("div");
    const onRealtimeTalkOptionsChange = vi.fn();
    render(renderChatControls(createProps({ onRealtimeTalkOptionsChange })), container);

    const voice = container.querySelector<HTMLSelectElement>('[data-talk-select="voice"] select');
    expect(voice).toBeInstanceOf(HTMLSelectElement);
    if (!(voice instanceof HTMLSelectElement)) {
      throw new Error("expected voice select");
    }
    voice.value = "cedar";
    voice.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onRealtimeTalkOptionsChange).toHaveBeenCalledWith({ voice: "cedar" });
  });

  it("keeps microphone selection in Voice settings", () => {
    const container = document.createElement("div");
    const onRealtimeTalkInputSelect = vi.fn();
    render(renderChatControls(createProps({ onRealtimeTalkInputSelect })), container);

    const microphone = container.querySelector<HTMLSelectElement>(
      '[data-talk-select="microphone"] select',
    );
    expect(microphone).toBeInstanceOf(HTMLSelectElement);
    if (!(microphone instanceof HTMLSelectElement)) {
      throw new Error("expected microphone select");
    }
    expect(microphone.value).toBe("built-in");
    microphone.value = "usb";
    microphone.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onRealtimeTalkInputSelect).toHaveBeenCalledWith("usb");
  });

  it("refreshes microphone access from Voice settings", () => {
    const container = document.createElement("div");
    const onRealtimeTalkInputRefresh = vi.fn();
    render(renderChatControls(createProps({ onRealtimeTalkInputRefresh })), container);

    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh: Microphone input"]',
    );
    expect(refresh).toBeInstanceOf(HTMLButtonElement);
    refresh?.click();

    expect(onRealtimeTalkInputRefresh).toHaveBeenCalledOnce();
  });

  it("keeps the composer control cluster limited to model and Settings controls", () => {
    const container = document.createElement("div");
    render(renderChatControls(createProps()), container);

    expect(Array.from(container.children).map((node) => node.className)).toEqual([
      "chat-settings-popover-wrapper",
      "chat-composer-model-control",
    ]);
    expect(container.querySelector('[data-chat-provider-usage="true"]')).toBeNull();
  });
});
