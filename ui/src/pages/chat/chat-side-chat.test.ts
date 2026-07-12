/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ChatSideResult } from "../../lib/chat/side-result.ts";
import { renderSideChatPanel } from "./components/chat-side-chat.ts";

vi.mock("../../components/icons.ts", () => ({
  icons: {},
}));

vi.mock("../../components/markdown.ts", () => ({
  toSanitizedMarkdownHtml: (value: string) => value,
}));

function turn(overrides: Partial<ChatSideResult> = {}): ChatSideResult {
  return {
    kind: "btw",
    runId: "btw-run-1",
    sessionKey: "main",
    question: "what changed?",
    text: "The web UI now renders side chats separately.",
    isError: false,
    ts: 2,
    ...overrides,
  };
}

describe("side chat panel render", () => {
  it("renders turns, header actions, and the follow-up composer", () => {
    const container = document.createElement("div");
    const onClose = vi.fn();
    const onClear = vi.fn();

    render(
      renderSideChatPanel({
        turns: [turn(), turn({ runId: "btw-run-2", question: "and why?", text: "Because." })],
        pending: null,
        hidden: false,
        canFollowUp: true,
        onFollowUp: vi.fn(),
        onClose,
        onClear,
      }),
      container,
    );

    const panel = container.querySelector<HTMLElement>(".chat-side-chat");
    expect(panel).toBeInstanceOf(HTMLElement);
    expect(panel!.getAttribute("aria-label")).toBe("Side chat");
    expect(panel!.querySelector(".chat-side-chat__title")?.textContent).toBe("Side chat");
    expect(panel!.querySelector(".chat-side-chat__meta")?.textContent).toBe(
      "Not saved to chat history",
    );
    const turns = panel!.querySelectorAll(".chat-side-chat__turn");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.querySelector(".chat-side-chat__question")?.textContent).toBe("and why?");
    expect(turns[1]?.querySelector(".chat-side-chat__answer")?.textContent?.trim()).toBe(
      "Because.",
    );
    expect(panel!.querySelector(".chat-side-chat__input")).toBeInstanceOf(HTMLInputElement);

    panel!.querySelector<HTMLButtonElement>('[aria-label="Close side chat"]')?.click();
    expect(onClose).toHaveBeenCalledTimes(1);
    panel!.querySelector<HTMLButtonElement>('[aria-label="Clear side chat"]')?.click();
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("marks error turns and shows a thinking row while a question is pending", () => {
    const container = document.createElement("div");

    render(
      renderSideChatPanel({
        turns: [turn({ isError: true, text: "The side question failed." })],
        pending: { question: "what failed?", ts: 3 },
        hidden: false,
        canFollowUp: false,
      }),
      container,
    );

    expect(container.querySelector(".chat-side-chat__turn--error")).not.toBeNull();
    const pending = container.querySelector(".chat-side-chat__turn--pending");
    expect(pending?.querySelector(".chat-side-chat__question")?.textContent).toBe("what failed?");
    expect(pending?.querySelector(".chat-side-chat__thinking")?.textContent).toBe("Thinking…");
    // Archived sessions render the transcript without the follow-up composer.
    expect(container.querySelector(".chat-side-chat__composer")).toBeNull();
  });

  it("disables the follow-up input while a question is pending", () => {
    const container = document.createElement("div");

    render(
      renderSideChatPanel({
        turns: [turn()],
        pending: { question: "and why?", ts: 3 },
        hidden: false,
        canFollowUp: true,
        onFollowUp: vi.fn(),
      }),
      container,
    );

    const input = container.querySelector<HTMLInputElement>(".chat-side-chat__input");
    // A new /btw while one is pending would retire the in-flight run and
    // silently drop its answer.
    expect(input?.disabled).toBe(true);
    expect(input?.placeholder).toBe("Thinking…");
    expect(container.querySelector<HTMLButtonElement>(".chat-side-chat__send")?.disabled).toBe(
      true,
    );
  });

  it("renders nothing while hidden or empty", () => {
    const container = document.createElement("div");

    render(
      renderSideChatPanel({
        turns: [turn()],
        pending: null,
        hidden: true,
        canFollowUp: true,
      }),
      container,
    );
    expect(container.querySelector(".chat-side-chat")).toBeNull();

    render(
      renderSideChatPanel({ turns: [], pending: null, hidden: false, canFollowUp: true }),
      container,
    );
    expect(container.querySelector(".chat-side-chat")).toBeNull();
  });

  it("sends follow-ups carrying the last non-error turn as context", () => {
    const container = document.createElement("div");
    // Restore-on-rejection only touches inputs still attached to the document.
    document.body.append(container);
    const onFollowUp = vi.fn();

    render(
      renderSideChatPanel({
        turns: [
          turn({ text: "First answer." }),
          turn({ runId: "btw-run-2", isError: true, text: "It broke." }),
        ],
        pending: null,
        hidden: false,
        canFollowUp: true,
        onFollowUp,
      }),
      container,
    );

    const input = container.querySelector<HTMLInputElement>(".chat-side-chat__input");
    expect(input).toBeInstanceOf(HTMLInputElement);
    input!.value = "tell me more";
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onFollowUp).toHaveBeenCalledWith(
      '/btw Context — the previous side question "what changed?" was answered: "First answer.". Follow-up question: tell me more',
      "tell me more",
      expect.any(Function),
    );
    expect(input!.value).toBe("");

    // A rejected detached send restores the typed follow-up.
    const onSendRejected = onFollowUp.mock.calls[0]?.[2] as () => void;
    onSendRejected();
    expect(input!.value).toBe("tell me more");

    // ...unless the user already typed something new.
    input!.value = "different draft";
    onSendRejected();
    expect(input!.value).toBe("different draft");

    input!.value = "";
    // Empty input must not send.
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onFollowUp).toHaveBeenCalledTimes(1);
    container.remove();
  });
});
