/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderChatRunControls, type ChatRunControlsProps } from "./run-controls.ts";

function createProps(overrides: Partial<ChatRunControlsProps> = {}): ChatRunControlsProps {
  return {
    canAbort: false,
    connected: true,
    draft: "",
    hasMessages: false,
    isBusy: false,
    sending: false,
    onAbort: () => undefined,
    onExport: () => undefined,
    onNewSession: () => undefined,
    onSend: () => undefined,
    onStoreDraft: () => undefined,
    ...overrides,
  };
}

describe("chat run controls", () => {
  it("switches between idle and abort actions", () => {
    const container = document.createElement("div");
    const onAbort = vi.fn();
    render(
      renderChatRunControls(
        createProps({
          canAbort: true,
          sending: true,
          onAbort,
        }),
      ),
      container,
    );

    const stopButton = container.querySelector<HTMLButtonElement>('button[title="Stop"]');
    expect(stopButton).not.toBeNull();
    stopButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("New session");

    const onNewSession = vi.fn();
    const onSend = vi.fn();
    const onStoreDraft = vi.fn();
    render(
      renderChatRunControls(
        createProps({
          draft: " run this ",
          hasMessages: true,
          onNewSession,
          onSend,
          onStoreDraft,
        }),
      ),
      container,
    );

    const newSessionButton = container.querySelector<HTMLButtonElement>(
      'button[title="New session"]',
    );
    expect(newSessionButton).not.toBeNull();
    newSessionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onNewSession).toHaveBeenCalledTimes(1);

    const sendButton = container.querySelector<HTMLButtonElement>('button[title="Send"]');
    expect(sendButton).not.toBeNull();
    sendButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onStoreDraft).toHaveBeenCalledWith(" run this ");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Stop");
  });
});
