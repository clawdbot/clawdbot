/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/index.ts";
import {
  findComposerButton as button,
  findPrimaryButton as primaryButton,
  renderComposerFixture as renderComposer,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";

afterEach(async () => {
  await resetComposerFixture();
});

function pressComposerEnter(
  container: Element,
  modifiers: Pick<KeyboardEventInit, "altKey" | "ctrlKey" | "metaKey" | "shiftKey"> = {},
) {
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) {
    throw new Error("expected composer textarea");
  }
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Enter",
    ...modifiers,
  });
  textarea.dispatchEvent(event);
  return event;
}

describe("renderChatComposer controls", () => {
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
        { id: "pending-1", text: "already sent", createdAt: 2, pendingRunId: "run-1" },
        { id: "local-1", text: "/status", createdAt: 3, localCommandName: "status" },
        {
          id: "waiting-idle-1",
          text: "queued during the run",
          createdAt: 4,
          sendState: "waiting-idle",
        },
      ],
    });
    const steer = [...container.querySelectorAll<HTMLButtonElement>(".chat-queue__action")];
    expect(steer).toHaveLength(2);
    steer[0]?.click();
    steer[1]?.click();
    expect(onQueueSteer.mock.calls).toEqual([["queued-1"], ["waiting-idle-1"]]);
  });

  it("steers the oldest visible-queue message when Enter is pressed on empty", () => {
    const onQueueSteer = vi.fn();
    const onSend = vi.fn();
    const { container } = renderComposer({
      canAbort: true,
      onAbort: vi.fn(),
      onQueueSteer,
      onSend,
      queue: [
        { id: "later", text: "later", createdAt: 30, sessionKey: "main" },
        // Pending rows may omit sessionKey; the Enter path matches the queue
        // chip's visible surface, so this row stays eligible.
        { id: "pending-unscoped", text: "pending", createdAt: 10 },
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
    expect(onQueueSteer).toHaveBeenCalledWith("pending-unscoped");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not steer from Enter while offline, matching the hidden Steer chip", () => {
    const onQueueSteer = vi.fn();
    const { container } = renderComposer({
      canAbort: true,
      connected: false,
      onAbort: vi.fn(),
      onQueueSteer,
      queue: [{ id: "queued", text: "queued", createdAt: 1, sessionKey: "main" }],
    });

    container
      .querySelector("textarea")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    expect(onQueueSteer).not.toHaveBeenCalled();
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

  it.each([
    ["Meta+Enter with a rendered draft", { metaKey: true }, "Steer this now", undefined, undefined],
    [
      "Control+Enter with a rendered draft",
      { ctrlKey: true },
      "Steer this now",
      undefined,
      undefined,
    ],
    [
      "Control+Enter with attachment-only content",
      { ctrlKey: true },
      "",
      () => [{ id: "image-1", mimeType: "image/png", fileName: "proof.png" }],
      undefined,
    ],
    [
      "Control+Enter with live textarea content before the draft prop rerenders",
      { ctrlKey: true },
      "",
      undefined,
      "Steer the live textarea value",
    ],
  ] as const)(
    "uses %s to steer an active queued follow-up",
    (_name, modifiers, draft, getAttachments, liveDraft) => {
      const onSend = vi.fn();
      const { container } = renderComposer({
        canAbort: true,
        draft,
        followUpMode: "queue",
        getAttachments,
        onAbort: vi.fn(),
        onSend,
        sendShortcut: "enter",
      });
      const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
      if (textarea && liveDraft !== undefined) {
        textarea.value = liveDraft;
      }

      pressComposerEnter(container, modifiers);

      expect(onSend).toHaveBeenCalledOnce();
      expect(onSend).toHaveBeenCalledWith("steer");
    },
  );

  it.each([
    ["modifier-enter", true, "queue", false],
    ["enter", false, "queue", false],
    ["enter", true, "steer", false],
    ["enter", true, "queue", true],
  ] as const)(
    "keeps ordinary send semantics for shortcut=%s active=%s mode=%s alt=%s",
    (sendShortcut, active, followUpMode, altKey) => {
      const onSend = vi.fn();
      const { container } = renderComposer({
        canAbort: active,
        draft: "Keep the ordinary send path",
        followUpMode,
        onAbort: active ? vi.fn() : undefined,
        onSend,
        sendShortcut,
      });

      pressComposerEnter(container, { altKey, ctrlKey: true });

      expect(onSend.mock.calls).toEqual([[]]);
    },
  );

  it("keeps empty modified Enter on the existing empty-draft path", () => {
    const onSend = vi.fn();
    const { container } = renderComposer({
      canAbort: true,
      draft: "",
      followUpMode: "queue",
      onAbort: vi.fn(),
      onSend,
      sendShortcut: "enter",
    });

    pressComposerEnter(container, { ctrlKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps Shift+modified Enter as a newline", () => {
    const onSend = vi.fn();
    const { container } = renderComposer({
      canAbort: true,
      draft: "Keep editing",
      followUpMode: "queue",
      onAbort: vi.fn(),
      onSend,
      sendShortcut: "enter",
    });

    const event = pressComposerEnter(container, { ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("teaches the steer shortcut only when the force-steer action is available", () => {
    const available = renderComposer({
      canAbort: true,
      draft: "Follow up now",
      followUpMode: "queue",
      onAbort: vi.fn(),
      sendShortcut: "enter",
    });
    const availablePrimary = primaryButton(available.container);
    const availableTooltip = availablePrimary.closest("openclaw-tooltip") as
      | (HTMLElement & { content?: string })
      | null;
    expect(availablePrimary.getAttribute("aria-label")).toBe(t("chat.runControls.queueMessage"));
    expect(availableTooltip?.content).toBe("Queue ⏎ · Steer ⌘/Ctrl+Enter");

    const unavailable = [
      {
        overrides: {
          canAbort: true,
          draft: "Follow up later",
          followUpMode: "queue" as const,
          onAbort: vi.fn(),
          sendShortcut: "modifier-enter" as const,
        },
        tooltip: t("chat.runControls.queue"),
      },
      {
        overrides: {
          draft: "Send without an active run",
          followUpMode: "queue" as const,
          sendShortcut: "enter" as const,
        },
        tooltip: t("chat.runControls.send"),
      },
      {
        overrides: {
          canAbort: true,
          draft: "Already steering",
          followUpMode: "steer" as const,
          onAbort: vi.fn(),
          sendShortcut: "enter" as const,
        },
        tooltip: t("chat.queue.steer"),
      },
      {
        overrides: {
          canAbort: true,
          connected: false,
          draft: "Queue until the gateway reconnects",
          followUpMode: "queue" as const,
          onAbort: vi.fn(),
          sendShortcut: "enter" as const,
        },
        tooltip: t("chat.runControls.queue"),
      },
    ];
    for (const testCase of unavailable) {
      const view = renderComposer(testCase.overrides);
      const tooltip = primaryButton(view.container).closest("openclaw-tooltip") as
        | (HTMLElement & { content?: string })
        | null;
      expect(tooltip?.content).toBe(testCase.tooltip);
    }
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
