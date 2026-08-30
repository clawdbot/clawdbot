/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import {
  createComposerProps as props,
  findComposerButton as button,
  renderComposerFixture as renderComposer,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
import * as realtimeTalkInput from "./realtime-talk-input.ts";

const discoverRealtimeTalkInputsMock = vi.fn();
const openRealtimeTalkInputMock = vi.fn();

describe("suggestion composer", () => {
  it("labels the send action as Suggest and emits ephemeral typing state", () => {
    const onTypingChange = vi.fn();
    const view = renderComposer({
      suggestionComposer: true,
      draft: "Suggest this",
      onTypingChange,
    });
    expect(view.container.querySelector(".agent-chat__control-label")?.textContent).toContain(
      "Suggest",
    );
    expect(
      view.container.querySelector<HTMLButtonElement>('button[aria-label="Add attachment"]')
        ?.disabled,
    ).toBe(true);

    const textarea = view.container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    if (!textarea) {
      return;
    }
    textarea.value = "hello";
    textarea.dispatchEvent(new InputEvent("beforeinput", { bubbles: true }));
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    textarea.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    expect(onTypingChange).toHaveBeenNthCalledWith(1, true, "hello");
    expect(onTypingChange).toHaveBeenLastCalledWith(false);
  });
});

function questionPrompt(id: string, question: string): QuestionPrompt {
  return {
    id,
    questions: [
      {
        questionId: "choice",
        header: "Choice",
        question,
        options: [{ label: "Yes" }, { label: "No" }],
        isOther: false,
      },
    ],
    sessionKey: "queue-test",
    createdAtMs: 1_000,
    expiresAtMs: Date.now() + 60_000,
    status: "pending",
    answeredElsewhere: false,
    localResolutionConfirmed: false,
    locallyExpired: false,
    submitting: false,
    error: null,
    drafts: new Map(),
    revision: 1,
  };
}

class DictationAudioContext {
  readonly destination = {};
  readonly sampleRate = 8000;
  readonly close = vi.fn(async () => undefined);

  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  createScriptProcessor() {
    return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
  }

  createGain() {
    return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0),
    };
  }
}

function dictationPointer(type: "pointerdown" | "pointerup", pointerId: number): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event as PointerEvent;
}

beforeEach(() => {
  // ESM imports remain live when the composer was cached by another test file.
  // Patch the shared dependencies instead of clearing isolate:false's registry.
  vi.spyOn(realtimeTalkInput, "discoverRealtimeTalkInputs").mockImplementation(
    discoverRealtimeTalkInputsMock,
  );
  vi.spyOn(realtimeTalkInput, "openRealtimeTalkInput").mockImplementation(
    openRealtimeTalkInputMock,
  );
});

afterEach(async () => {
  await resetComposerFixture(() => {
    discoverRealtimeTalkInputsMock.mockReset();
    openRealtimeTalkInputMock.mockReset();
  });
});

describe("renderChatComposer controls", () => {
  it("labels the message input independently of its placeholder", () => {
    const { container } = renderComposer();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");

    expect(textarea?.getAttribute("aria-label")).toBe(
      t("chat.composer.placeholder", { name: "OpenClaw" }),
    );
  });

  it("keeps the immersive voice canvas and multimodal composer in one live surface", () => {
    const onToggleRealtimeTalk = vi.fn();
    const { container } = renderComposer({
      onToggleRealtimeTalk,
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
    });
    const composer = container.querySelector(".agent-chat__input");
    const canvas = container.querySelector(".agent-chat__voice-canvas");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");

    expect(composer?.classList.contains("agent-chat__input--voice-active")).toBe(true);
    expect(canvas?.getAttribute("aria-label")).toBe(t("chat.composer.voiceCanvasLabel"));
    expect(canvas?.querySelector("img")?.getAttribute("src")).toBe("/app-art/voice-orb.webp");
    expect(textarea?.placeholder).toBe(t("chat.composer.voiceActivePlaceholder"));
    expect(button(container, t("chat.composer.addAttachment")).disabled).toBe(false);
    button(container, t("chat.composer.endVoiceConversation")).click();
    expect(onToggleRealtimeTalk).toHaveBeenCalledOnce();
  });

  it("clears a whitespace-only draft on blur so the native placeholder returns", () => {
    const onDraftChange = vi.fn();
    const { container } = renderComposer({ draft: "saved", onDraftChange });
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) {
      throw new Error("expected composer textarea");
    }

    textarea.value = "  \n  ";
    textarea.dispatchEvent(new FocusEvent("blur", { bubbles: true }));

    expect(textarea.value).toBe("");
    expect(onDraftChange).toHaveBeenLastCalledWith("");
    expect(textarea.matches(":placeholder-shown")).toBe(true);
  });

  it("keeps an unsaved queued-row edit open when normal composer text is double-clicked", () => {
    const onCancel = vi.fn();
    const { container } = renderComposer({
      draft: "select this composer text",
      queue: [{ id: "queued", text: "original queued text", createdAt: 1 }],
      queuedEdit: {
        editingId: "queued",
        editingText: "unsaved queued edit",
        onCancel,
      },
    });
    const composer = container.querySelector<HTMLTextAreaElement>(
      ".agent-chat__composer-combobox textarea",
    );

    composer?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    expect(onCancel).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLTextAreaElement>(".chat-queue__edit-input")?.value).toBe(
      "unsaved queued edit",
    );
  });

  it("keeps composing enabled and explains queued delivery while offline", () => {
    const { container } = renderComposer({
      offline: true,
      queuedOutboxCount: 3,
      draft: "Queue this message",
    });

    expect(container.querySelector(".agent-chat__input--offline")).not.toBeNull();
    expect(container.querySelector(".agent-chat__composer-status-band")?.textContent?.trim()).toBe(
      "Offline — 3 queued; messages send when the connection returns.",
    );
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
    expect(button(container, t("chat.runControls.sendMessage")).disabled).toBe(false);

    const empty = renderComposer({ offline: true, queuedOutboxCount: 0 });
    expect(
      empty.container.querySelector(".agent-chat__composer-status-band")?.textContent?.trim(),
    ).toBe("Offline — messages will be queued and sent when the connection returns.");

    const online = renderComposer({ queuedOutboxCount: 3 });
    expect(online.container.querySelector(".agent-chat__composer-status-band")).toBeNull();
  });

  it("replaces the composer with the archived-session notice", () => {
    const onAction = vi.fn();
    const onAbort = vi.fn();
    const { container } = renderComposer({
      canSend: false,
      canAbort: true,
      onAbort,
      disabledBanner: {
        kind: "composer-replacement",
        text: "This session is archived. Unarchive it to continue the conversation.",
        actionLabel: "Unarchive",
        onAction,
      },
    });

    const banner = container.querySelector(".agent-chat__disabled-banner");
    expect(banner?.textContent).toContain("This session is archived.");
    expect(container.querySelector(".agent-chat__input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector(".agent-chat__typing-indicator--outside")).toBeNull();
    banner?.querySelector<HTMLButtonElement>("button")?.click();
    expect(onAction).toHaveBeenCalledOnce();
    const stop = container.querySelector<HTMLButtonElement>(
      `[aria-label="${t("chat.runControls.stopGenerating")}"]`,
    );
    expect(stop).not.toBeNull();
    stop?.click();
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("keeps the disabled composer mounted for a catalog read-only state", () => {
    const { container } = renderComposer({
      canSend: false,
      disabledReason: "This catalog session is read-only.",
    });

    expect(container.querySelector(".agent-chat__disabled-banner")).toBeNull();
    expect(container.querySelector(".agent-chat__input")).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
  });

  it("shows the disabled reason even when draft text hides the placeholder", () => {
    const reason = "This session is read-only.";
    const { container } = renderComposer({
      canSend: false,
      disabledReason: reason,
      draft: "a draft that hides the placeholder",
    });

    // The placeholder carries the reason only for an empty composer; the
    // dedicated reason row must keep the explanation visible alongside a draft.
    expect(container.querySelector(".agent-chat__composer-status-band")?.textContent).toContain(
      reason,
    );
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
  });

  it("opens the microphone picker, marks the selected input, and persists a selection", async () => {
    discoverRealtimeTalkInputsMock.mockResolvedValue({
      devices: [
        { deviceId: "studio-mic", label: "Studio microphone" },
        { deviceId: "headset", label: "USB headset" },
      ],
      issue: null,
    });
    patchSettings({ realtimeTalkInputDeviceId: "studio-mic" });
    const container = document.createElement("div");
    document.body.append(container);
    const composerProps = props({ onToggleRealtimeTalk: vi.fn() });
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();

    const dropdown = container.querySelector<
      HTMLElement & { open: boolean; updateComplete: Promise<unknown> }
    >("wa-dropdown.chat-talk-input-picker");
    await dropdown?.updateComplete;
    button(container, t("chat.composer.microphoneInput")).click();
    await dropdown?.updateComplete;

    expect(dropdown?.open).toBe(true);
    await vi.waitFor(() => expect(discoverRealtimeTalkInputsMock).toHaveBeenCalledWith(true));
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(3),
    );
    const items = [
      ...container.querySelectorAll<HTMLElement & { value: string }>(
        ".chat-talk-input-picker__item",
      ),
    ];
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      t("chat.composer.systemDefaultMicrophone"),
      "Studio microphone",
      "USB headset",
    ]);
    expect(items.map((item) => item.getAttribute("role"))).toEqual([
      "menuitemradio",
      "menuitemradio",
      "menuitemradio",
    ]);
    expect(items.find((item) => item.value === "studio-mic")?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      items
        .find((item) => item.value === "studio-mic")
        ?.querySelector(".chat-talk-input-picker__check"),
    ).not.toBeNull();

    items.find((item) => item.value === "headset")?.click();
    await dropdown?.updateComplete;
    expect(loadSettings().realtimeTalkInputDeviceId).toBe("headset");
    expect(dropdown?.open).toBe(false);

    button(container, t("chat.composer.microphoneInput")).click();
    await vi.waitFor(() => expect(discoverRealtimeTalkInputsMock).toHaveBeenCalledTimes(2));
    expect(dropdown?.open).toBe(true);
  });

  it("keeps the controlled hold-to-dictate preference in sync after toggling", async () => {
    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    const container = document.createElement("div");
    document.body.append(container);
    const onComposerHoldToRecordChange = vi.fn((enabled: boolean) => {
      composerProps.composerHoldToRecord = patchSettings({
        composerHoldToRecord: enabled,
      }).composerHoldToRecord;
      draw();
    });
    const composerProps = props({
      composerHoldToRecord: true,
      onComposerHoldToRecordChange,
      onToggleRealtimeTalk: vi.fn(),
    });
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();

    const dropdown = container.querySelector<
      HTMLElement & { open: boolean; updateComplete: Promise<unknown> }
    >("wa-dropdown.chat-talk-input-picker");
    await dropdown?.updateComplete;
    button(container, t("chat.composer.microphoneInput")).click();
    await dropdown?.updateComplete;

    const preference = container.querySelector<HTMLButtonElement>(
      '.chat-talk-input-picker__preference [role="switch"]',
    );
    expect(preference?.getAttribute("aria-checked")).toBe("true");
    preference?.click();
    await dropdown?.updateComplete;

    expect(onComposerHoldToRecordChange).toHaveBeenCalledWith(false);
    expect(loadSettings().composerHoldToRecord).toBe(false);
    expect(dropdown?.open).toBe(true);
    expect(
      container
        .querySelector<HTMLButtonElement>('.chat-talk-input-picker__preference [role="switch"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("gates unavailable voice capabilities before starting and routes to Talk Settings", async () => {
    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    const request = vi.fn(async (method: string) => {
      if (method === "talk.catalog") {
        return {
          realtime: { ready: false, providers: [] },
          transcription: { ready: false, providers: [] },
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const gatewayClient = { request } as unknown as GatewayBrowserClient;
    const onToggleRealtimeTalk = vi.fn();
    const onOpenTalkSettings = vi.fn();
    const onOpenDictationSettings = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const composerProps = props({
      gatewayClient,
      onOpenTalkSettings,
      onOpenDictationSettings,
      onToggleRealtimeTalk,
    });
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();

    await vi.waitFor(() =>
      expect(
        container.querySelectorAll('[data-chat-talk-capability][data-status="unavailable"]'),
      ).toHaveLength(2),
    );
    const voiceTooltip = container.querySelector<HTMLElement & { content?: string }>(
      ".chat-talk-control > openclaw-tooltip",
    );
    expect(container.querySelector(".chat-talk-control__capability-alert")).toBeNull();
    expect(voiceTooltip?.content).toBe(t("chat.composer.voiceGestureHint"));
    const capabilityAlerts = [
      ...container.querySelectorAll<HTMLElement>(
        '.chat-talk-input-picker__capability[data-status="unavailable"] .chat-talk-input-picker__capability-alert',
      ),
    ];
    expect(capabilityAlerts).toHaveLength(2);
    expect(
      capabilityAlerts.every((alert) =>
        alert.parentElement?.matches(".chat-talk-input-picker__capability-copy strong"),
      ),
    ).toBe(true);
    button(container, t("chat.composer.startVoiceInput")).click();
    const dropdown = container.querySelector<HTMLElement & { open: boolean }>(
      "wa-dropdown.chat-talk-input-picker",
    );
    await vi.waitFor(() => expect(dropdown?.open).toBe(true));

    expect(onToggleRealtimeTalk).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("talk.catalog", {});
    expect(request).not.toHaveBeenCalledWith("talk.client.create", expect.anything());
    expect(container.textContent).toContain(t("chat.composer.realtimeTalkProviderUnavailable"));
    expect(container.textContent).toContain(t("chat.composer.dictationProviderUnavailableShort"));

    const settingsButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(".chat-talk-input-picker__settings"),
    ];
    expect(settingsButtons.map((entry) => entry.textContent?.trim())).toEqual([
      t("chat.composer.configureCapability"),
      t("chat.composer.configureCapability"),
    ]);
    expect(settingsButtons.every((entry) => entry.querySelector("svg") !== null)).toBe(true);
    settingsButtons[0]?.click();
    expect(onOpenTalkSettings).toHaveBeenCalledOnce();
    expect(onOpenDictationSettings).not.toHaveBeenCalled();
    settingsButtons[1]?.click();
    expect(onOpenDictationSettings).toHaveBeenCalledOnce();
  });

  it.each([
    ["no providers", false, false, ["realtime", "dictation"]],
    ["voice only", true, false, ["dictation"]],
    ["transcription only", false, true, ["realtime"]],
    ["voice and transcription", true, true, []],
  ] as const)(
    "maps the %s catalog to independent visible capability outcomes",
    async (_name, realtimeReady, transcriptionReady, unavailableCapabilities) => {
      discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
      const request = vi.fn(async (method: string) => {
        if (method === "talk.catalog") {
          return {
            realtime: { ready: realtimeReady, providers: [] },
            transcription: { ready: transcriptionReady, providers: [] },
          };
        }
        throw new Error(`unexpected request: ${method}`);
      });
      const container = document.createElement("div");
      document.body.append(container);
      const composerProps = props({
        gatewayClient: { request } as unknown as GatewayBrowserClient,
        onToggleRealtimeTalk: vi.fn(),
      });
      const draw = () => render(renderChatComposer(composerProps), container);
      composerProps.onRequestUpdate = draw;
      draw();

      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("talk.catalog", {}));
      await vi.waitFor(() =>
        expect(
          [...container.querySelectorAll<HTMLElement>("[data-chat-talk-capability]")].map(
            (entry) => entry.dataset.chatTalkCapability,
          ),
        ).toEqual(unavailableCapabilities),
      );
    },
  );

  it.each([
    ["none-found", "chat.composer.microphoneNoneFound", false],
    ["list-unsupported", "chat.composer.microphoneListUnsupported", false],
    ["permission-blocked", "chat.composer.microphonePermissionBlocked", true],
    ["busy", "chat.composer.microphoneBusy", true],
    ["page-inactive", "chat.composer.microphonePageInactive", true],
    ["failed", "chat.composer.microphoneAccessFailed", true],
  ] as const)(
    "renders %s as one empty state with no claimed selection",
    async (issue, messageKey, fault) => {
      discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue });
      const container = document.createElement("div");
      document.body.append(container);
      const composerProps = props({
        onToggleRealtimeTalk: vi.fn(),
        realtimeTalkActive: true,
        realtimeTalkStatus: "listening",
      });
      const draw = () => render(renderChatComposer(composerProps), container);
      composerProps.onRequestUpdate = draw;
      draw();

      const dropdown = container.querySelector<
        HTMLElement & { open: boolean; updateComplete: Promise<unknown> }
      >("wa-dropdown.chat-talk-input-picker");
      await dropdown?.updateComplete;
      button(container, t("chat.composer.microphoneInput")).click();
      const empty = await vi.waitFor(() => {
        const node = container.querySelector(".chat-talk-input-picker__empty");
        expect(node?.textContent?.trim()).toBe(t(messageKey));
        return node;
      });

      // One designed state: never a checked System default row, a second
      // negative note, or a hint about a selection that cannot be made.
      expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(0);
      expect(container.querySelector(".chat-talk-input-picker__note")).toBeNull();
      expect(container.querySelector(".chat-talk-input-picker__warning")).toBeNull();
      expect(container.querySelector(".chat-talk-input-picker__hint")).toBeNull();
      expect(container.querySelectorAll(".chat-talk-input-picker__empty")).toHaveLength(1);
      expect(empty?.getAttribute("role")).toBe("status");
      expect(empty?.classList.contains("chat-talk-input-picker__empty--fault")).toBe(fault);
    },
  );

  it("keeps the list plus one warning when inputs exist but discovery reported an issue", async () => {
    discoverRealtimeTalkInputsMock.mockResolvedValue({
      devices: [{ deviceId: "headset", label: "USB headset" }],
      issue: "busy",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const composerProps = props({
      onToggleRealtimeTalk: vi.fn(),
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
    });
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();

    const dropdown = container.querySelector<
      HTMLElement & { open: boolean; updateComplete: Promise<unknown> }
    >("wa-dropdown.chat-talk-input-picker");
    await dropdown?.updateComplete;
    button(container, t("chat.composer.microphoneInput")).click();
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(2),
    );

    expect(container.querySelector(".chat-talk-input-picker__warning")?.textContent?.trim()).toBe(
      t("chat.composer.microphoneBusy"),
    );
    expect(container.querySelector(".chat-talk-input-picker__empty")).toBeNull();
    expect(container.querySelector(".chat-talk-input-picker__hint")?.textContent).toContain(
      t("chat.composer.microphoneAppliesNextSession"),
    );

    dropdown?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await dropdown?.updateComplete;
    expect(dropdown?.open).toBe(false);
  });

  it("marks the selected input with a single trailing check", async () => {
    discoverRealtimeTalkInputsMock.mockResolvedValue({
      devices: [{ deviceId: "headset", label: "USB headset" }],
      issue: null,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const composerProps = props({ onToggleRealtimeTalk: vi.fn() });
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();

    const dropdown = container.querySelector<
      HTMLElement & { open: boolean; updateComplete: Promise<unknown> }
    >("wa-dropdown.chat-talk-input-picker");
    await dropdown?.updateComplete;
    button(container, t("chat.composer.microphoneInput")).click();
    const items = await vi.waitFor(() => {
      const rows = [...container.querySelectorAll(".chat-talk-input-picker__item")];
      expect(rows).toHaveLength(2);
      return rows;
    });

    // type="checkbox" would make wa-dropdown-item paint its own leading check
    // and toggle it on click, so the row would show two disagreeing marks.
    expect(items.map((item) => item.getAttribute("type"))).toEqual(["normal", "normal"]);
    expect(items[0]?.querySelector(".chat-talk-input-picker__check")?.getAttribute("slot")).toBe(
      "details",
    );
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("follows devicechange while open and stops listening once closed", async () => {
    const mediaDevices = new EventTarget();
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });
    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    const container = document.createElement("div");
    document.body.append(container);
    const composerProps = props({ onToggleRealtimeTalk: vi.fn() });
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();

    const dropdown = container.querySelector<
      HTMLElement & { open: boolean; updateComplete: Promise<unknown> }
    >("wa-dropdown.chat-talk-input-picker");
    await dropdown?.updateComplete;
    button(container, t("chat.composer.microphoneInput")).click();
    await vi.waitFor(() =>
      expect(container.querySelector(".chat-talk-input-picker__empty")?.textContent?.trim()).toBe(
        t("chat.composer.microphoneNoneFound"),
      ),
    );

    // The empty state promises the list keeps up, so plugging in has to land
    // without reopening the popover.
    discoverRealtimeTalkInputsMock.mockResolvedValue({
      devices: [{ deviceId: "usb", label: "USB Audio Interface" }],
      issue: null,
    });
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(2),
    );
    expect(container.querySelector(".chat-talk-input-picker__empty")).toBeNull();

    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await vi.waitFor(() =>
      expect(container.querySelectorAll(".chat-talk-input-picker__item")).toHaveLength(0),
    );

    dropdown?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await dropdown?.updateComplete;
    const callsWhileClosed = discoverRealtimeTalkInputsMock.mock.calls.length;
    mediaDevices.dispatchEvent(new Event("devicechange"));
    await Promise.resolve();
    expect(discoverRealtimeTalkInputsMock.mock.calls.length).toBe(callsWhileClosed);
  });

  it("keeps send and dictation distinct for attachment-only drafts", () => {
    const onSend = vi.fn();
    const onToggleRealtimeTalk = vi.fn();
    const { container } = renderComposer({
      attachments: [{ id: "image-1", mimeType: "image/png", fileName: "proof.png" }],
      onSend,
      onToggleRealtimeTalk,
    });

    button(container, t("chat.runControls.sendMessage")).click();
    expect(onSend).toHaveBeenCalledOnce();
    expect(onToggleRealtimeTalk).not.toHaveBeenCalled();
    expect(
      container.querySelector(`button[aria-label="${t("chat.composer.startVoiceInput")}"]`),
    ).not.toBeNull();
  });

  it("keeps the dictation button stable through hold progress and latch", async () => {
    vi.useFakeTimers();
    openRealtimeTalkInputMock.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    vi.stubGlobal("AudioContext", DictationAudioContext);
    const request = vi.fn(async (method: string) => {
      if (method === "talk.catalog") {
        return { transcription: { ready: true } };
      }
      if (method === "talk.session.create") {
        return {
          sessionId: "dictation-1",
          transcriptionSessionId: "dictation-1",
          audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
        };
      }
      return { ok: true };
    });
    const gatewayClient = {
      addEventListener: vi.fn(() => () => undefined),
      request,
    } as unknown as GatewayBrowserClient;
    const container = document.createElement("div");
    document.body.append(container);
    const composerProps = props({
      draft: "Keep this text",
      gatewayClient,
      onToggleRealtimeTalk: vi.fn(),
    });
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("talk.catalog", {}));
    await vi.waitFor(() =>
      expect(container.querySelector('[data-chat-talk-capability="dictation"]')).toBeNull(),
    );

    const capturedButton = container.querySelector<HTMLButtonElement>(
      ".chat-talk-control > openclaw-tooltip > button",
    );
    expect(capturedButton).not.toBeNull();
    const captures = new Set<number>();
    Object.defineProperties(capturedButton!, {
      setPointerCapture: { value: (pointerId: number) => captures.add(pointerId) },
      hasPointerCapture: { value: (pointerId: number) => captures.has(pointerId) },
      releasePointerCapture: { value: (pointerId: number) => captures.delete(pointerId) },
    });

    capturedButton!.dispatchEvent(dictationPointer("pointerdown", 9));
    expect(capturedButton!.hasPointerCapture(9)).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(capturedButton?.classList.contains("chat-send-btn--dictation-arming")).toBe(true);
    const holdingControl = capturedButton?.closest(".chat-talk-control");
    expect(holdingControl?.classList.contains("chat-talk-control--holding")).toBe(true);
    expect(holdingControl?.querySelector(".chat-talk-input-picker")).not.toBeNull();
    expect(capturedButton!.hasPointerCapture(9)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);

    const rerenderedButton = container.querySelector<HTMLButtonElement>(
      ".chat-talk-control > openclaw-tooltip > button",
    );
    expect(request).toHaveBeenCalledWith("talk.session.create", expect.anything());
    expect(rerenderedButton).toBe(capturedButton);
    expect(rerenderedButton?.classList.contains("chat-send-btn--dictating")).toBe(true);
    expect(
      container.querySelector(".agent-chat__dictation-phase--listening")?.textContent?.trim(),
    ).toBe(t("chat.composer.dictationListening"));
    expect(rerenderedButton?.hasPointerCapture(9)).toBe(false);
  });

  it("keeps the microphone picker open without leaking an unavailable hold into Talk", async () => {
    vi.useFakeTimers();
    discoverRealtimeTalkInputsMock.mockResolvedValue({ devices: [], issue: "none-found" });
    const request = vi.fn(async (method: string) => {
      if (method === "talk.catalog") {
        return { realtime: { ready: true }, transcription: { ready: false } };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const onToggleRealtimeTalk = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const composerProps = props({
      gatewayClient: { request } as unknown as GatewayBrowserClient,
      onToggleRealtimeTalk,
    });
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("talk.catalog", {}));
    await vi.waitFor(() =>
      expect(
        container.querySelector(
          '[data-chat-talk-capability="dictation"][data-status="unavailable"]',
        ),
      ).not.toBeNull(),
    );

    const microphone = button(container, t("chat.composer.startVoiceInput"));
    microphone.dispatchEvent(dictationPointer("pointerdown", 10));
    await vi.advanceTimersByTimeAsync(801);
    const dropdown = container.querySelector<HTMLElement & { open: boolean }>(
      "wa-dropdown.chat-talk-input-picker",
    );
    expect(dropdown?.open).toBe(true);

    document.dispatchEvent(dictationPointer("pointerup", 10));
    microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(dropdown?.open).toBe(true);
    expect(onToggleRealtimeTalk).not.toHaveBeenCalled();

    microphone.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onToggleRealtimeTalk).toHaveBeenCalledOnce();
  });

  it("shows an actionable error underlap and returns the microphone to idle on startup failure", async () => {
    vi.useFakeTimers();
    openRealtimeTalkInputMock.mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
    const request = vi.fn(async (method: string) => {
      if (method === "talk.catalog") {
        return { realtime: { ready: true }, transcription: { ready: true } };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const container = document.createElement("div");
    document.body.append(container);
    const composerProps = props({
      gatewayClient: { request } as unknown as GatewayBrowserClient,
      onToggleRealtimeTalk: vi.fn(),
    });
    const draw = () => render(renderChatComposer(composerProps), container);
    composerProps.onRequestUpdate = draw;
    draw();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("talk.catalog", {}));

    const microphone = button(container, t("chat.composer.startVoiceInput"));
    microphone.dispatchEvent(dictationPointer("pointerdown", 12));
    await vi.advanceTimersByTimeAsync(800);
    await vi.waitFor(() =>
      expect(
        container.querySelector('.agent-chat__composer-underlaps[data-tone="danger"]'),
      ).not.toBeNull(),
    );

    const underlap = container.querySelector('.agent-chat__composer-underlaps[data-tone="danger"]');
    expect(underlap?.getAttribute("role")).toBeNull();
    expect(underlap?.querySelector('[role="alert"]')?.textContent).toContain(
      t("chat.composer.microphonePermissionBlocked"),
    );
    expect(underlap?.textContent).toContain(t("chat.composer.dictationStartRecovery"));
    expect(container.querySelector(".chat-send-btn--dictating")).toBeNull();
    expect(container.querySelector(".chat-send-btn--voice")).not.toBeNull();
  });
});

describe("renderChatComposer status", () => {
  it("swaps the expanded question with the composer and restores its draft and focus", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const prompt = questionPrompt("question-swap", "Choose a release target");
    const composerProps = props({
      paneId: "question-swap-pane",
      sessionKey: "queue-test",
      draft: "Keep this draft",
      gatewayQuestionPrompts: [],
      composerControls: html`<button type="button">Model</button>`,
      onRequestUpdate: vi.fn(),
    });
    composerProps.onDraftChange = (next) => {
      composerProps.draft = next;
    };
    const draw = () => render(renderChatComposer(composerProps), container);

    draw();
    const initialTextarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    initialTextarea.focus();
    expect(document.activeElement).toBe(initialTextarea);
    initialTextarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    initialTextarea.value = "Keep this draft while composing";
    initialTextarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }),
    );

    composerProps.gatewayQuestionPrompts = [prompt];
    draw();
    let panel = container.querySelector("openclaw-chat-question-panel") as HTMLElement & {
      updateComplete: Promise<unknown>;
      props: { onCollapsedChange: (collapsed: boolean) => void };
    };
    await panel.updateComplete;
    expect(container.querySelector(".agent-chat__input")).toBeNull();
    expect(container.querySelector(".agent-chat__composer-footer")).toBeNull();
    expect(container.querySelector(".agent-chat__typing-indicator--outside")).toBeNull();
    expect(document.activeElement).toBe(panel.querySelector(".chat-question-panel"));
    expect(composerProps.draft).toBe("Keep this draft while composing");

    composerProps.draft = "Host updated this draft while the question was open";

    panel.props.onCollapsedChange(true);
    draw();
    await Promise.resolve();
    let textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toBe("Host updated this draft while the question was open");
    expect(document.activeElement).toBe(textarea);

    panel = container.querySelector("openclaw-chat-question-panel") as typeof panel;
    panel.props.onCollapsedChange(false);
    draw();
    await panel.updateComplete;
    expect(container.querySelector(".agent-chat__input")).toBeNull();
    expect(document.activeElement).toBe(panel.querySelector(".chat-question-panel"));

    prompt.status = "answered";
    draw();
    await Promise.resolve();
    textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toBe("Host updated this draft while the question was open");
    expect(document.activeElement).toBe(textarea);
    expect(container.querySelector("openclaw-chat-question-panel")).toBeNull();

    container.remove();
  });

  it("keeps every concurrent gateway question reachable", async () => {
    const container = document.createElement("div");
    const onRequestUpdate = vi.fn();
    const composerProps = props({
      sessionKey: "queue-test",
      gatewayQuestionPrompts: [
        questionPrompt("question-1", "First prompt"),
        questionPrompt("question-2", "Second prompt"),
      ],
      onRequestUpdate,
    });

    render(renderChatComposer(composerProps), container);
    let panel = container.querySelector("openclaw-chat-question-panel") as HTMLElement & {
      props: {
        model: { questions: Array<{ question: string }>; requestPosition?: unknown };
        onNextRequest?: () => void;
      };
    };
    expect(panel.props.model.questions[0]?.question).toBe("First prompt");
    expect(panel.props.model.requestPosition).toEqual({ current: 1, total: 2 });

    panel.props.onNextRequest?.();
    expect(onRequestUpdate).toHaveBeenCalledOnce();
    render(renderChatComposer(composerProps), container);
    panel = container.querySelector("openclaw-chat-question-panel") as typeof panel;
    expect(panel.props.model.questions[0]?.question).toBe("Second prompt");
    expect(panel.props.model.requestPosition).toEqual({ current: 2, total: 2 });
  });

  it("keeps unscoped and other-session gateway questions out of the composer", () => {
    const unscopedPrompt = questionPrompt("question-1", "Unscoped prompt");
    unscopedPrompt.sessionKey = undefined;
    const otherSessionPrompt = questionPrompt("question-2", "Other prompt");
    otherSessionPrompt.sessionKey = "agent:other:main";

    const view = renderComposer({
      sessionKey: "queue-test",
      gatewayQuestionPrompts: [unscopedPrompt, otherSessionPrompt],
    });

    expect(view.container.querySelector("openclaw-chat-question-panel")).toBeNull();
  });
  it("floats a fresh interrupted status above the composer", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let view = renderComposer({
      runStatus: { phase: "done", runId: "run-0", sessionKey: "main", occurredAt: 900 },
    });
    expect(view.container.querySelector(".agent-chat__run-status")).toBeNull();

    view = renderComposer({
      runStatus: { phase: "interrupted", runId: "run-1", sessionKey: "main", occurredAt: 900 },
      composerControls: html`<button type="button">Settings</button>`,
    });
    const interrupted = view.container.querySelector(".agent-chat__run-status--interrupted");
    expect(interrupted).not.toBeNull();
    expect(interrupted?.closest(".agent-chat__composer-run-status")).not.toBeNull();
    expect(interrupted?.querySelector("rect")?.getAttribute("width")).toBe("18");
    expect(
      view.container.querySelector(".agent-chat__run-status-announcement")?.textContent,
    ).toContain("Interrupted");

    now.mockReturnValue(7_000);
    view = renderComposer({
      runStatus: { phase: "interrupted", runId: "run-1", sessionKey: "main", occurredAt: 1_000 },
      composerControls: html`<button type="button">Settings</button>`,
    });
    expect(view.container.querySelector(".agent-chat__run-status--interrupted")).toBeNull();
  });

  it("renders fresh compaction and fallback status", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { container } = renderComposer({
      compactionStatus: {
        phase: "active",
        runId: "run-1",
        startedAt: 1_000,
        completedAt: null,
      },
      fallbackStatus: {
        selected: "fireworks/minimax-m2p5",
        active: "deepinfra/moonshotai/Kimi-K2.5",
        attempts: ["fireworks/minimax-m2p5: rate limit"],
        occurredAt: 900,
      },
    });
    expect(container.querySelector(".compaction-indicator--active")?.textContent?.trim()).toBe(
      "Compacting context...",
    );
    expect(container.querySelector(".compaction-indicator--fallback")?.textContent?.trim()).toBe(
      "Fallback active: deepinfra/moonshotai/Kimi-K2.5",
    );
    expect(
      container.querySelector(".compaction-indicator--fallback")?.getAttribute("aria-label"),
    ).toBe(
      "Selected: fireworks/minimax-m2p5 • Active: deepinfra/moonshotai/Kimi-K2.5 • Attempts: fireworks/minimax-m2p5: rate limit",
    );
  });
});
