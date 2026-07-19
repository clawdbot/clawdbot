/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { i18n, t } from "../../i18n/index.ts";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.ts";

const discoverRealtimeTalkInputsMock = vi.hoisted(() => vi.fn());

vi.mock("./realtime-talk-input.ts", () => ({
  discoverRealtimeTalkInputs: discoverRealtimeTalkInputsMock,
}));

vi.mock("../../components/icons.ts", async () => {
  const { html: litHtml } = await import("lit");
  return {
    icons: {
      camera: litHtml`<svg data-icon="camera"></svg>`,
      cameraOff: litHtml`<svg data-icon="camera-off"></svg>`,
      switchCamera: litHtml`<svg data-icon="switch-camera"></svg>`,
      check: litHtml`<svg data-icon="check"></svg>`,
      chevronDown: litHtml`<svg data-icon="chevron-down"></svg>`,
    },
  };
});

type ComposerProps = Parameters<typeof renderChatComposer>[0];

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

function questionPrompt(id: string, question: string): QuestionPrompt {
  return {
    id,
    questions: [
      {
        id: "choice",
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

afterEach(async () => {
  resetChatComposerState();
  discoverRealtimeTalkInputsMock.mockReset();
  localStorage.clear();
  document.body.replaceChildren();
  await i18n.setLocale("en");
  vi.restoreAllMocks();
});

describe("renderChatComposer controls", () => {
  it("renders and invokes an action beside the disabled reason", () => {
    const onDisabledAction = vi.fn();
    const { container } = renderComposer({
      canSend: false,
      disabledReason: "This session is archived.",
      disabledActionLabel: "Restore",
      onDisabledAction,
    });

    const reason = container.querySelector(".agent-chat__disabled-reason");
    expect(reason?.textContent).toContain("This session is archived.");
    reason?.querySelector<HTMLButtonElement>("button")?.click();
    expect(onDisabledAction).toHaveBeenCalledOnce();
  });

  it("switches the primary action between voice, send, queue, and stop", () => {
    const onToggleRealtimeTalk = vi.fn();
    let view = renderComposer({ onToggleRealtimeTalk });
    button(view.container, t("chat.composer.startVoiceInput")).click();
    expect(onToggleRealtimeTalk).toHaveBeenCalledOnce();
    expect(view.container.querySelector('[aria-label="Start video talk"]')).toBeNull();

    const onSend = vi.fn();
    view = renderComposer({ draft: "Send this", onSend });
    button(view.container, t("chat.runControls.sendMessage")).click();
    expect(onSend).toHaveBeenCalledOnce();

    const onAbort = vi.fn();
    view = renderComposer({ canAbort: true, onAbort, draft: "Follow up" });
    expect(button(view.container, t("chat.runControls.sendMessage")).disabled).toBe(false);
    button(view.container, t("chat.runControls.stopGenerating")).click();
    expect(onAbort).toHaveBeenCalledOnce();

    view = renderComposer({
      canAbort: true,
      draft: "Steer this run",
      followUpMode: "steer",
      onAbort,
    });
    expect(button(view.container, t("chat.followUpModeSteer")).disabled).toBe(false);

    view = renderComposer({
      canAbort: true,
      draft: "Follow up later",
      followUpMode: "queue",
      onAbort,
    });
    expect(button(view.container, t("chat.runControls.queueMessage")).disabled).toBe(false);

    view = renderComposer({
      canAbort: true,
      draft: "Replace the current run",
      followUpMode: "interrupt",
      onAbort,
    });
    expect(button(view.container, t("chat.runControls.sendMessage")).disabled).toBe(false);
  });

  it("opens the microphone picker, marks the selected input, and persists a selection", async () => {
    discoverRealtimeTalkInputsMock.mockResolvedValue({
      devices: [
        { deviceId: "studio-mic", label: "Studio microphone" },
        { deviceId: "headset", label: "USB headset" },
      ],
      warning: null,
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
      items.find((item) => item.value === "studio-mic")?.querySelector('[data-icon="check"]'),
    ).not.toBeNull();

    items.find((item) => item.value === "headset")?.click();
    await dropdown?.updateComplete;
    expect(loadSettings().realtimeTalkInputDeviceId).toBe("headset");
    expect(dropdown?.open).toBe(false);

    button(container, t("chat.composer.microphoneInput")).click();
    await vi.waitFor(() => expect(discoverRealtimeTalkInputsMock).toHaveBeenCalledTimes(2));
    expect(dropdown?.open).toBe(true);
  });

  it("shows discovery warnings and the next-session hint during active Talk", async () => {
    discoverRealtimeTalkInputsMock.mockResolvedValue({
      devices: [],
      warning: "Microphone permission is blocked.",
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
      expect(container.querySelector(".chat-talk-input-picker__warning")?.textContent).toContain(
        "Microphone permission is blocked.",
      ),
    );

    expect(container.querySelector(".chat-talk-input-picker__warning")?.getAttribute("role")).toBe(
      "alert",
    );
    expect(container.querySelector(".chat-talk-input-picker__note")?.textContent).toContain(
      t("chat.composer.noMicrophones"),
    );
    expect(container.querySelector(".chat-talk-input-picker__hint")?.textContent).toContain(
      t("chat.composer.microphoneAppliesNextSession"),
    );

    dropdown?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await dropdown?.updateComplete;
    expect(dropdown?.open).toBe(false);
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
    expect(cameraToggle.querySelector('[data-icon="camera-off"]')).not.toBeNull();
    expect(cameraToggle.querySelector('[data-icon="camera"]')).toBeNull();
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

  it("sends attachment-only drafts instead of starting voice", () => {
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
    ).toBeNull();
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

  it("renders session context and plan usage through the full composer", () => {
    const { container } = renderComposer({
      sessions: {
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            totalTokens: 46_000,
            contextTokens: 200_000,
          },
        ],
        defaults: { contextTokens: 200_000 },
      } as never,
      providerUsage: {
        basePath: "/control",
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai", type: "oauth", status: "ok" }],
              usage: { providerId: "openai", windows: [{ label: "Week", usedPercent: 72 }] },
            },
          ],
        },
      },
    });
    expect(container.querySelector(".context-ring")?.getAttribute("aria-label")).toBe(
      "Thread context usage: 46k of 200k (23%)",
    );
    expect(container.querySelector(".context-usage__plan-header")?.textContent).toContain(
      "Plan usage",
    );
    expect(container.querySelector(".context-usage__limit")?.textContent).toContain("72%");
  });

  it("renders plan usage before session metrics arrive", () => {
    const { container } = renderComposer({
      sessions: null,
      providerUsage: {
        basePath: "/control",
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              status: "ok",
              profiles: [{ profileId: "openai", type: "oauth", status: "ok" }],
              usage: { providerId: "openai", windows: [{ label: "Week", usedPercent: 72 }] },
            },
          ],
        },
      },
    });

    expect(container.querySelector(".context-ring")?.getAttribute("aria-label")).toBe(
      "Usage Remaining",
    );
    expect(container.querySelector(".context-usage__bar")).toBeNull();
    expect(container.querySelector(".context-usage__limit")?.textContent).toContain("72%");
    expect(
      container
        .querySelector<HTMLAnchorElement>("[data-chat-provider-usage='true']")
        ?.getAttribute("href"),
    ).toBe("/control/usage");
  });

  it("deduplicates provider aliases and hides cost estimates for subscriptions", () => {
    const resetAt = Date.now() + 2 * 3_600_000 + 45_000;
    const usage = {
      providerId: "anthropic",
      plan: "Max (20x)",
      windows: [
        { label: "5h", usedPercent: 22, resetAt },
        { label: "Week", usedPercent: 25 },
        { label: "Fable", usedPercent: 92 },
      ],
      billing: [{ type: "budget" as const, used: 157.85, limit: 400, unit: "USD" }],
    };
    const { container } = renderComposer({
      messages: [{ role: "user", content: "hi" }],
      sessions: {
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 78_700,
            contextTokens: 1_000_000,
            estimatedCostUsd: 0.02,
            model: "claude-fable-5",
            modelProvider: "anthropic",
          },
        ],
        defaults: { contextTokens: 1_000_000 },
      } as never,
      providerUsage: {
        modelAuthStatusResult: {
          ts: Date.now(),
          providers: [
            {
              provider: "anthropic",
              displayName: "Claude",
              status: "ok",
              profiles: [{ profileId: "anthropic:oauth", type: "oauth", status: "ok" }],
              usage,
            },
            {
              provider: "claude-cli",
              displayName: "Claude",
              status: "ok",
              profiles: [{ profileId: "claude-cli", type: "oauth", status: "ok" }],
              usage,
            },
          ],
        },
      },
    });

    expect(container.querySelectorAll(".context-usage__plan-header")).toHaveLength(1);
    expect(container.querySelector(".context-usage__plan-badge")?.textContent).toBe("Max (20x)");
    expect(
      [...container.querySelectorAll(".context-usage__limit")].map((row) =>
        row.textContent?.replace(/\s+/g, " ").trim(),
      ),
    ).toEqual([
      "5-hour limit Resets 2h 22%",
      "Weekly · all models 25%",
      "Fable 92%",
      "Usage credits $157.85 of $400.00",
    ]);
    expect(container.querySelector(".context-usage__stats")).not.toBeNull();
    expect(container.querySelector(".context-usage__stats--cost")).toBeNull();
    expect(container.textContent).not.toContain("Est. cost");
  });

  it("warns on fresh high usage but keeps stale usage approximate and nonactionable", () => {
    const onCompact = vi.fn();
    let view = renderComposer({
      onCompact,
      sessions: {
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            totalTokens: 190_000,
            contextTokens: 200_000,
          },
        ],
        defaults: { contextTokens: 200_000 },
      } as never,
    });
    expect(view.container.querySelector(".context-ring")?.textContent?.trim()).toBe("95%");
    expect(view.container.querySelector(".context-ring")?.classList).toContain(
      "context-ring--warning",
    );
    view.container.querySelector<HTMLButtonElement>(".context-ring__action")?.click();
    expect(onCompact).toHaveBeenCalledOnce();

    view = renderComposer({
      onCompact,
      sessions: {
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: null,
            totalTokens: 190_000,
            totalTokensFresh: false,
            contextTokens: 200_000,
          },
        ],
        defaults: { contextTokens: 200_000 },
      } as never,
    });
    expect(view.container.querySelector(".context-ring")?.textContent?.trim()).toBe("~95%");
    expect(view.container.querySelector(".context-ring")?.classList).not.toContain(
      "context-ring--warning",
    );
    expect(view.container.querySelector(".context-ring__action")).toBeNull();
  });
});
