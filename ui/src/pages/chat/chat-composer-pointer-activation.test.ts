/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import { createComposerProps } from "./chat-composer.test-support.ts";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.ts";

type ComposerProps = Parameters<typeof renderChatComposer>[0];

function renderComposer(overrides: Partial<ComposerProps> = {}): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderChatComposer(createComposerProps(overrides)), container);
  return container;
}

function button(container: Element, label: string): HTMLButtonElement {
  const result = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!result) {
    throw new Error(`expected button ${label}`);
  }
  return result;
}

function textarea(container: Element): HTMLTextAreaElement {
  const result = container.querySelector<HTMLTextAreaElement>("textarea");
  if (!result) {
    throw new Error("expected composer textarea");
  }
  return result;
}

function primaryPointerDown(): MouseEvent {
  return new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
}

function markComposerAtFocusInset(container: HTMLElement): void {
  const shell = container.querySelector<HTMLElement>(".agent-chat__composer-shell");
  expect(shell).not.toBeNull();
  shell?.style.setProperty("margin-bottom", "0px");
}

afterEach(async () => {
  resetChatComposerState();
  document.body.replaceChildren();
  await i18n.setLocale("en");
  vi.restoreAllMocks();
});

describe("chat composer pointer activation", () => {
  it("preserves only its own textarea focus during primary pointer actions", () => {
    const sendContainer = renderComposer({
      canAbort: true,
      draft: "Follow up",
      onAbort: vi.fn(),
      onSend: vi.fn(),
    });
    const sendInput = textarea(sendContainer);
    const send = button(sendContainer, t("chat.runControls.sendMessage"));
    markComposerAtFocusInset(sendContainer);

    sendInput.focus();
    const sendPointerDown = primaryPointerDown();
    send.dispatchEvent(sendPointerDown);
    expect(sendPointerDown.defaultPrevented).toBe(true);

    const stopContainer = renderComposer({ canAbort: true, onAbort: vi.fn() });
    const stopInput = textarea(stopContainer);
    const stop = button(stopContainer, t("chat.runControls.stopGenerating"));
    markComposerAtFocusInset(stopContainer);
    stopInput.focus();
    const stopPointerDown = primaryPointerDown();
    stop.dispatchEvent(stopPointerDown);
    expect(stopPointerDown.defaultPrevented).toBe(true);

    const shell = sendContainer.querySelector<HTMLElement>(".agent-chat__composer-shell")!;
    shell.style.marginBottom = "14px";
    sendInput.focus();
    const stableLayoutPointerDown = primaryPointerDown();
    send.dispatchEvent(stableLayoutPointerDown);
    expect(stableLayoutPointerDown.defaultPrevented).toBe(false);

    const unrelatedInput = document.createElement("input");
    document.body.append(unrelatedInput);
    unrelatedInput.focus();
    const unrelatedPointerDown = primaryPointerDown();
    send.dispatchEvent(unrelatedPointerDown);
    expect(unrelatedPointerDown.defaultPrevented).toBe(false);
  });

  it("retains focus while Send clears the draft and Stop preserves it", () => {
    let sendDraft = "Send this";
    const onSend = vi.fn(() => {
      sendDraft = "";
    });
    const onSendTypingChange = vi.fn();
    const sendContainer = renderComposer({
      draft: sendDraft,
      getDraft: () => sendDraft,
      onDraftChange: (value) => {
        sendDraft = value;
      },
      onSend,
      onTypingChange: onSendTypingChange,
    });
    const sendTextarea = textarea(sendContainer);
    const send = button(sendContainer, t("chat.runControls.sendMessage"));
    markComposerAtFocusInset(sendContainer);
    sendTextarea.focus();
    send.dispatchEvent(primaryPointerDown());
    send.click();

    expect(onSend).toHaveBeenCalledOnce();
    expect(onSendTypingChange).toHaveBeenLastCalledWith(false);
    expect(sendTextarea.value).toBe("");
    expect(document.activeElement).toBe(sendTextarea);

    const onAbort = vi.fn();
    const onStopTypingChange = vi.fn();
    const stopContainer = renderComposer({
      canAbort: true,
      onAbort,
      onTypingChange: onStopTypingChange,
    });
    const stopTextarea = textarea(stopContainer);
    const stop = button(stopContainer, t("chat.runControls.stopGenerating"));
    markComposerAtFocusInset(stopContainer);
    stopTextarea.focus();
    stop.dispatchEvent(primaryPointerDown());
    stop.click();

    expect(onAbort).toHaveBeenCalledOnce();
    expect(stopTextarea.value).toBe("");
    expect(document.activeElement).toBe(stopTextarea);
    expect(onStopTypingChange).not.toHaveBeenCalled();
  });

  it.each([
    ["queue", t("chat.runControls.queueMessage")],
    ["steer", t("chat.followUpModeSteer")],
    ["interrupt", t("chat.runControls.sendMessage")],
  ] as const)("preserves focus for the %s active-run action", (followUpMode, label) => {
    const container = renderComposer({
      canAbort: true,
      draft: "Follow up",
      followUpMode,
      onAbort: vi.fn(),
      onSend: vi.fn(),
    });
    const input = textarea(container);
    markComposerAtFocusInset(container);
    input.focus();
    const event = primaryPointerDown();
    button(container, label).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not leave composition state stuck after pointer Send", () => {
    let draft = "構成中";
    const onSend = vi.fn(() => {
      draft = "";
    });
    const container = renderComposer({
      draft,
      getDraft: () => draft,
      onDraftChange: (value) => {
        draft = value;
      },
      onSend,
    });
    const input = textarea(container);
    input.focus();
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const send = button(container, t("chat.runControls.sendMessage"));
    send.dispatchEvent(primaryPointerDown());
    send.click();
    expect(onSend).toHaveBeenCalledOnce();

    input.value = "next";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
    );
    expect(onSend).toHaveBeenCalledTimes(2);
  });
});
