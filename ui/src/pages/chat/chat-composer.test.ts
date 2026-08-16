/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { icons } from "../../components/icons.ts";
import { i18n, t } from "../../i18n/index.ts";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.ts";
import * as realtimeTalkInput from "./realtime-talk-input.ts";

const discoverRealtimeTalkInputsMock = vi.fn();
const openRealtimeTalkInputMock = vi.fn();

type ComposerProps = Parameters<typeof renderChatComposer>[0];

function iconMarkup(icon: unknown): string | undefined {
  const container = document.createElement("div");
  render(icon, container);
  return container.querySelector("svg")?.innerHTML;
}

function props(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    paneId: crypto.randomUUID(),
    sessionKey: "main",
    currentAgentId: "main",
    connected: true,
    canSend: true,
    disabledReason: null,
    sending: false,
    messages: [],
    stream: null,
    queue: [],
    draft: "",
    sessions: null,
    assistantName: "OpenClaw",
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onQueueRemove: vi.fn(),
    onNewSession: vi.fn(),
    ...overrides,
  };
}

function renderComposer(overrides: Partial<ComposerProps> = {}) {
  const container = document.createElement("div");
  const composerProps = props(overrides);
  render(renderChatComposer(composerProps), container);
  return { container, props: composerProps };
}

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
    expect(onTypingChange).toHaveBeenNthCalledWith(1, true);
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

function button(container: Element, label: string): HTMLButtonElement {
  const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!result) {
    throw new Error(`expected button ${label}`);
  }
  return result;
}

function primaryButton(container: Element): HTMLButtonElement {
  const actions = container.querySelector(".agent-chat__composer-actions");
  const result = actions?.querySelector<HTMLButtonElement>(":scope > openclaw-tooltip > button");
  if (!result) {
    throw new Error("expected one primary composer button");
  }
  expect(actions?.querySelectorAll(":scope > openclaw-tooltip > button")).toHaveLength(1);
  return result;
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

function dictationPointerDown(pointerId: number): PointerEvent {
  const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
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
  resetChatComposerState();
  discoverRealtimeTalkInputsMock.mockReset();
  openRealtimeTalkInputMock.mockReset();
  localStorage.clear();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await i18n.setLocale("en");
  vi.restoreAllMocks();
});

describe("renderChatComposer controls", () => {
  it("keeps composing enabled and explains queued delivery while offline", () => {
    const { container } = renderComposer({
      offline: true,
      queuedOutboxCount: 3,
      draft: "Queue this message",
    });

    expect(container.querySelector(".agent-chat__input--offline")).not.toBeNull();
    expect(container.querySelector(".agent-chat__offline-hint")?.textContent?.trim()).toBe(
      "Offline — 3 queued; messages send when the connection returns.",
    );
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
    expect(button(container, t("chat.runControls.sendMessage")).disabled).toBe(false);

    const empty = renderComposer({ offline: true, queuedOutboxCount: 0 });
    expect(empty.container.querySelector(".agent-chat__offline-hint")?.textContent?.trim()).toBe(
      "Offline — messages will be queued and sent when the connection returns.",
    );

    const online = renderComposer({ queuedOutboxCount: 3 });
    expect(online.container.querySelector(".agent-chat__offline-hint")).toBeNull();
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
      typingActors: [{ id: "ayaan", label: "Ayaan" }],
    });

    const banner = container.querySelector(".agent-chat__disabled-banner");
    expect(banner?.textContent).toContain("This session is archived.");
    expect(container.querySelector(".agent-chat__input")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector(".agent-chat__typing-indicator--outside")).toBeNull();
    banner?.querySelector<HTMLButtonElement>("button")?.click();
    expect(onAction).toHaveBeenCalledOnce();
    button(container, t("chat.runControls.stopGenerating")).click();
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
    expect(container.querySelector(".agent-chat__disabled-reason")?.textContent).toContain(reason);
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
  });

  it.each([
    {
      name: "empty idle",
      overrides: {},
      label: "Write a message to send.",
      disabled: true,
      stop: false,
    },
    {
      name: "empty abortable",
      overrides: { canAbort: true, onAbort: vi.fn() },
      label: t("chat.runControls.stopGenerating"),
      disabled: false,
      stop: true,
    },
    {
      name: "queued follow-up",
      overrides: {
        canAbort: true,
        draft: "Follow up later",
        followUpMode: "queue" as const,
        onAbort: vi.fn(),
      },
      label: t("chat.runControls.queueMessage"),
      disabled: false,
      stop: false,
    },
    {
      name: "steered follow-up",
      overrides: {
        canAbort: true,
        draft: "Steer this run",
        followUpMode: "steer" as const,
        onAbort: vi.fn(),
      },
      label: t("chat.followUpModeSteer"),
      disabled: false,
      stop: false,
    },
    {
      name: "draft idle",
      overrides: { draft: "Send this" },
      label: t("chat.runControls.sendMessage"),
      disabled: false,
      stop: false,
    },
  ])(
    "renders one primary action with a separate mic for $name",
    ({ overrides, label, disabled, stop }) => {
      const view = renderComposer({ ...overrides, onToggleRealtimeTalk: vi.fn() });
      const primary = primaryButton(view.container);

      expect(primary.getAttribute("aria-label")).toBe(label);
      expect(primary.disabled).toBe(disabled);
      expect(primary.classList.contains("chat-send-btn--stop")).toBe(stop);
      expect(view.container.querySelectorAll(".chat-send-btn--stop")).toHaveLength(stop ? 1 : 0);
      expect(button(view.container, t("chat.composer.startVoiceInput"))).not.toBe(primary);
    },
  );

  it.each([
    [undefined, "Tap to talk · Hold to dictate"],
    [false, t("chat.composer.startVoiceInput")],
  ])(
    "uses the gesture hint only when hold-to-dictate is available",
    (composerHoldToRecord, tooltipContent) => {
      const { container } = renderComposer({
        composerHoldToRecord,
        onToggleRealtimeTalk: vi.fn(),
      });
      const voice = button(container, t("chat.composer.startVoiceInput"));
      const tooltip = voice.closest("openclaw-tooltip") as
        | (HTMLElement & {
            content?: string;
          })
        | null;

      expect(voice.getAttribute("aria-label")).toBe(t("chat.composer.startVoiceInput"));
      expect(tooltip?.content).toBe(tooltipContent);
    },
  );

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
    expect(items.find((item) => item.value === "studio-mic")?.querySelector("svg")?.innerHTML).toBe(
      iconMarkup(icons.check),
    );

    items.find((item) => item.value === "headset")?.click();
    await dropdown?.updateComplete;
    expect(loadSettings().realtimeTalkInputDeviceId).toBe("headset");
    expect(dropdown?.open).toBe(false);

    button(container, t("chat.composer.microphoneInput")).click();
    await vi.waitFor(() => expect(discoverRealtimeTalkInputsMock).toHaveBeenCalledTimes(2));
    expect(dropdown?.open).toBe(true);
  });

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
    expect(items.map((item) => item.querySelectorAll("svg").length)).toEqual([1, 0]);
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

  it("offers camera only inside a video-capable active talk session", () => {
    const onToggleRealtimeCamera = vi.fn();
    const { container } = renderComposer({
      onToggleRealtimeTalk: vi.fn(),
      onToggleRealtimeCamera,
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
      realtimeTalkVideoCapable: true,
    });

    button(container, t("chat.composer.turnCameraOn")).click();
    expect(onToggleRealtimeCamera).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-label="Start video talk"]')).toBeNull();

    const failed = renderComposer({
      onToggleRealtimeTalk: vi.fn(),
      onToggleRealtimeCamera,
      realtimeTalkActive: true,
      realtimeTalkStatus: "error",
      realtimeTalkVideoCapable: true,
    });
    expect(button(failed.container, t("chat.composer.turnCameraOn")).disabled).toBe(true);
  });

  it("renders the camera-off glyph while the talk camera is enabled", () => {
    const { container } = renderComposer({
      onToggleRealtimeTalk: vi.fn(),
      onToggleRealtimeCamera: vi.fn(),
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
      realtimeTalkVideoCapable: true,
      realtimeTalkVideoStream: {} as MediaStream,
    });

    const cameraToggle = button(container, t("chat.composer.turnCameraOff"));
    expect(cameraToggle.querySelector("svg")?.innerHTML).toBe(iconMarkup(icons.cameraOff));
    expect(cameraToggle.querySelector("svg")?.innerHTML).not.toBe(iconMarkup(icons.camera));
  });

  it("offers camera switching only for a live preview with multiple cameras", () => {
    const onSwitchRealtimeCamera = vi.fn();
    const stream = {
      getVideoTracks: () => [
        {
          getSettings: () => ({ facingMode: "user" }),
        } as MediaStreamTrack,
      ],
    } as unknown as MediaStream;
    const { container } = renderComposer({
      realtimeTalkVideoStream: stream,
      realtimeTalkCameraDevices: [
        { deviceId: "front", label: "Front Camera" },
        { deviceId: "back", label: "Back Camera" },
      ],
      onSwitchRealtimeCamera,
    });

    button(container, t("chat.composer.switchCamera")).click();
    expect(onSwitchRealtimeCamera).toHaveBeenCalledOnce();
    expect(container.querySelector("video")?.classList).toContain(
      "agent-chat__video-preview-mirrored",
    );

    const singleCamera = renderComposer({
      realtimeTalkVideoStream: stream,
      realtimeTalkCameraDevices: [{ deviceId: "front", label: "Front Camera" }],
      onSwitchRealtimeCamera,
    });
    expect(
      singleCamera.container.querySelector(
        `button[aria-label="${t("chat.composer.switchCamera")}"]`,
      ),
    ).toBeNull();
  });

  it("does not mirror an environment-facing camera preview", () => {
    const stream = {
      getVideoTracks: () => [
        {
          getSettings: () => ({ facingMode: "environment" }),
        } as MediaStreamTrack,
      ],
    } as unknown as MediaStream;
    const { container } = renderComposer({ realtimeTalkVideoStream: stream });

    expect(container.querySelector("video")?.classList).not.toContain(
      "agent-chat__video-preview-mirrored",
    );
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

  it("keeps the captured dictation button through the hold-start rerender", async () => {
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

    capturedButton!.dispatchEvent(dictationPointerDown(9));
    expect(capturedButton!.hasPointerCapture(9)).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const rerenderedButton = container.querySelector<HTMLButtonElement>(
      ".chat-talk-control > openclaw-tooltip > button",
    );
    expect(request).toHaveBeenCalledWith("talk.session.create", expect.anything());
    expect(rerenderedButton).toBe(capturedButton);
    expect(rerenderedButton?.hasPointerCapture(9)).toBe(true);
  });

  it("keeps voice and generation stop controls distinct when both are active", () => {
    const onAbort = vi.fn();
    const onToggleRealtimeTalk = vi.fn();
    const { container } = renderComposer({
      canAbort: true,
      onAbort,
      onToggleRealtimeTalk,
      realtimeTalkActive: true,
    });

    const stopVoice = button(container, t("chat.composer.stopVoiceInput"));
    const stopGeneration = button(container, t("chat.runControls.stopGenerating"));
    expect(stopVoice.classList.contains("chat-send-btn--voice-live")).toBe(true);
    expect(stopVoice.classList.contains("chat-send-btn--stop")).toBe(false);
    expect(stopGeneration.classList.contains("chat-send-btn--stop")).toBe(true);
    expect(container.querySelectorAll(".chat-send-btn--stop")).toHaveLength(1);
    stopVoice.click();
    stopGeneration.click();
    expect(onToggleRealtimeTalk).toHaveBeenCalledOnce();
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("queues ordinary drafts offline but disables live voice", () => {
    const onSend = vi.fn();
    let view = renderComposer({ connected: false, draft: "queue this", onSend });
    const send = button(view.container, t("chat.runControls.sendMessage"));
    expect(send.disabled).toBe(false);
    send.click();
    expect(onSend).toHaveBeenCalledOnce();

    view = renderComposer({ connected: false, onToggleRealtimeTalk: vi.fn() });
    expect(button(view.container, t("chat.composer.startVoiceInput")).disabled).toBe(true);
  });

  it("keeps Stop available while disconnected for an abortable run", () => {
    const onAbort = vi.fn();
    const { container } = renderComposer({ connected: false, canAbort: true, onAbort });
    const stop = button(container, t("chat.runControls.stopGenerating"));
    expect(stop.disabled).toBe(false);
    stop.click();
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("offers Steer only for eligible queued messages during an active run", () => {
    const onQueueSteer = vi.fn();
    const { container } = renderComposer({
      canAbort: true,
      onAbort: vi.fn(),
      onQueueSteer,
      queue: [
        { id: "queued-1", text: "tighten the plan", createdAt: 1 },
        { id: "steered-1", text: "already sent", createdAt: 2, kind: "steered" },
        { id: "local-1", text: "/status", createdAt: 3, localCommandName: "status" },
        {
          id: "waiting-idle-1",
          text: "queued during the run",
          createdAt: 4,
          sendState: "waiting-idle",
        },
      ],
    });
    const steer = [...container.querySelectorAll<HTMLButtonElement>(".chat-queue__steer")];
    expect(steer).toHaveLength(2);
    steer[0]?.click();
    steer[1]?.click();
    expect(onQueueSteer.mock.calls).toEqual([["queued-1"], ["waiting-idle-1"]]);
  });

  it("steers the oldest eligible current-session message when Enter is pressed on empty", () => {
    const onQueueSteer = vi.fn();
    const onSend = vi.fn();
    const { container } = renderComposer({
      canAbort: true,
      onAbort: vi.fn(),
      onQueueSteer,
      onSend,
      queue: [
        { id: "later", text: "later", createdAt: 30, sessionKey: "main" },
        { id: "other-session", text: "other", createdAt: 1, sessionKey: "other" },
        { id: "oldest", text: "oldest", createdAt: 20, sessionKey: "main" },
        {
          id: "failed",
          text: "failed",
          createdAt: 2,
          sessionKey: "main",
          sendState: "failed",
        },
      ],
    });
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });

    container.querySelector("textarea")?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onQueueSteer).toHaveBeenCalledWith("oldest");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps empty Enter inert when no queued message can be steered", () => {
    const onQueueSteer = vi.fn();
    const onSend = vi.fn();
    const { container } = renderComposer({
      canAbort: true,
      onAbort: vi.fn(),
      onQueueSteer,
      onSend,
      queue: [{ id: "failed", text: "failed", createdAt: 1, sendState: "failed" }],
    });

    expect(() =>
      container
        .querySelector("textarea")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        ),
    ).not.toThrow();
    expect(onQueueSteer).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("stops an abortable run with Escape unless reply or menu precedence owns it", () => {
    const onAbort = vi.fn();
    let view = renderComposer({ canAbort: true, onAbort });
    let event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    view.container.querySelector("textarea")?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onAbort).toHaveBeenCalledOnce();

    onAbort.mockClear();
    view = renderComposer({
      canAbort: true,
      onAbort,
      replyTarget: { messageId: "reply-1", text: "Original message" },
    });
    event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    view.container.querySelector("textarea")?.dispatchEvent(event);
    expect(onAbort).not.toHaveBeenCalled();

    view = renderComposer({ canAbort: true, onAbort });
    const textarea = view.container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "/";
    textarea.dispatchEvent(new InputEvent("beforeinput", { bubbles: true }));
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("renders the queued author's avatar before the turn is submitted", async () => {
    const { container } = renderComposer({
      queue: [
        {
          id: "waiting-idle-1",
          text: "queued during the run",
          createdAt: 4,
          sendState: "waiting-idle",
          sender: { id: "profile_123", name: "Alice Example" },
        },
      ],
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector(".chat-queue__item .chat-author-avatar__initials")?.textContent,
      ).toContain("AE");
    });
  });

  it("renders reconnect waits as quiet status without the raw transport error", () => {
    const { container } = renderComposer({
      queue: [
        {
          id: "reconnect-1",
          text: "send me once the gateway is back",
          createdAt: 1,
          sendError: "chat.send unavailable during gateway restart",
          sendState: "waiting-reconnect",
        },
      ],
    });
    const item = container.querySelector(".chat-queue__item");
    expect(item?.classList.contains("chat-queue__item--reconnect")).toBe(true);
    expect(item?.querySelector(".chat-queue__dot")).not.toBeNull();
    expect(item?.querySelector(".chat-queue__icon")).toBeNull();
    expect(item?.querySelector(".chat-queue__error")).toBeNull();
    const badge = item?.querySelector(".chat-queue__badge");
    expect(badge?.textContent?.trim()).toBe("Waiting for reconnect");
    expect(badge?.getAttribute("title")).toBe("chat.send unavailable during gateway restart");
  });

  it("renders failed sends as retryable and running commands as inert", () => {
    const onQueueRetry = vi.fn();
    let view = renderComposer({
      onQueueRetry,
      queue: [
        {
          id: "failed-1",
          text: "still recoverable",
          createdAt: 1,
          sendError: "send blocked by session policy",
          sendRunId: "run-failed-1",
          sendState: "failed",
        },
      ],
    });
    expect(view.container.querySelector(".chat-queue__badge")?.textContent?.trim()).toBe("Failed");
    expect(view.container.querySelector(".chat-queue__error")?.textContent).toContain(
      "send blocked by session policy",
    );
    view.container.querySelector<HTMLButtonElement>(".chat-queue__retry")?.click();
    expect(onQueueRetry).toHaveBeenCalledWith("failed-1");

    view = renderComposer({
      queue: [
        {
          id: "running-command",
          text: "/compact",
          createdAt: 1,
          localCommandName: "compact",
          sendState: "executing-command",
        },
      ],
    });
    expect(view.container.querySelector(".chat-queue__badge")?.textContent?.trim()).toBe(
      "Running command",
    );
    expect(view.container.querySelector(".chat-queue__retry")).toBeNull();
    expect(view.container.querySelector(".chat-queue__remove")).toBeNull();
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
      typingActors: [{ id: "ayaan", label: "Ayaan" }],
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
    };
    await panel.updateComplete;
    expect(container.querySelector(".agent-chat__input")).toBeNull();
    expect(container.querySelector(".agent-chat__composer-footer")).toBeNull();
    expect(container.querySelector(".agent-chat__typing-indicator--outside")).toBeNull();
    expect(document.activeElement).toBe(panel.querySelector(".chat-question-panel"));
    expect(composerProps.draft).toBe("Keep this draft while composing");

    composerProps.draft = "Host updated this draft while the question was open";

    panel.querySelector<HTMLButtonElement>(".chat-question-panel__collapse")?.click();
    draw();
    await Promise.resolve();
    let textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toBe("Host updated this draft while the question was open");
    expect(document.activeElement).toBe(textarea);

    panel = container.querySelector("openclaw-chat-question-panel") as typeof panel;
    panel.querySelector<HTMLButtonElement>(".chat-question-panel__collapsed-button")?.click();
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
  it("renders only a fresh interrupted run as visible status chrome", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let view = renderComposer({
      runStatus: { phase: "done", runId: "run-0", sessionKey: "main", occurredAt: 900 },
    });
    expect(view.container.querySelector(".agent-chat__run-status")).toBeNull();

    view = renderComposer({
      runStatus: { phase: "interrupted", runId: "run-1", sessionKey: "main", occurredAt: 900 },
      composerControls: html`<button type="button">Settings</button>`,
    });
    expect(
      view.container.querySelector(".agent-chat__run-status--interrupted")?.textContent,
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

  it("renders an expandable live plan checklist and hides it when idle", () => {
    const planStatus = {
      explanation: "Keep the change focused",
      steps: [
        { step: "Inspect the route", status: "completed" as const },
        { step: "Wire the checklist", status: "in_progress" as const },
        { step: "Run focused tests", status: "pending" as const },
      ],
    };
    const { container } = renderComposer({
      canAbort: true,
      onAbort: vi.fn(),
      planStatus,
    });

    const checklist = container.querySelector<HTMLDetailsElement>(".plan-checklist");
    expect(checklist?.open).toBe(false);
    expect(checklist?.querySelector(".plan-checklist__current")?.textContent).toBe(
      "Wire the checklist",
    );
    expect(checklist?.querySelector(".plan-checklist__count")?.textContent).toBe("1/3");
    expect(
      [...(checklist?.querySelectorAll(".plan-checklist__step-marker") ?? [])].map((marker) =>
        marker.textContent?.trim(),
      ),
    ).toEqual(["✓", "▸", "▢"]);
    expect(checklist?.querySelector(".plan-checklist__explanation")?.textContent).toBe(
      "Keep the change focused",
    );

    const idle = renderComposer({ planStatus });
    expect(idle.container.querySelector(".plan-checklist")).toBeNull();
  });
});
