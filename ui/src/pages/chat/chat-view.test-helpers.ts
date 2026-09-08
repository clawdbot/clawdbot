import type { ReactiveControllerHost } from "lit";
import { vi } from "vitest";
import { resolveMessageActionDetails } from "./components/chat-message-markdown.ts";
import { ChatTranscriptController } from "./components/chat-transcript-controller.ts";

export function createTestTranscript(): ChatTranscriptController {
  return new ChatTranscriptController({
    addController: () => undefined,
    removeController: () => undefined,
    requestUpdate: () => undefined,
    updateComplete: Promise.resolve(true),
  } satisfies ReactiveControllerHost);
}

export function createPasteEvent(
  text: string,
  itemTypes: readonly string[] = ["text/plain"],
  extraData: Readonly<Record<string, string>> = {},
): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: Object.assign(Object.fromEntries(itemTypes.map((type, index) => [index, { type }])), {
        length: itemTypes.length,
      }),
      getData: (type: string) => (type === "text/plain" ? text : (extraData[type] ?? "")),
    },
  });
  return event;
}

export function appendChatBubble(
  container: Element,
  options: {
    entryId?: string;
    groupClass?: string;
    messageId?: string;
    senderLabel?: string;
    text?: string;
  } = {},
) {
  const group = document.createElement("div");
  group.className = options.groupClass ?? "chat-group";
  const bubble = Object.assign(document.createElement("div"), {
    messageActions: resolveMessageActionDetails({
      message: {
        role: "user",
        content: options.text ?? "",
        ...(options.entryId ? { __openclaw: { id: options.entryId } } : {}),
      },
      messageId: options.messageId ?? "test-message",
      senderLabel: options.senderLabel ?? "User",
      onReply: () => undefined,
    }),
  });
  bubble.className = "chat-bubble";
  if (options.entryId) {
    bubble.dataset.entryId = options.entryId;
  }
  if (options.messageId) {
    bubble.dataset.messageId = options.messageId;
  }
  if (options.text) {
    bubble.dataset.messageText = options.text;
  }
  if (options.senderLabel) {
    const sender = document.createElement("span");
    sender.className = "chat-sender-name";
    sender.textContent = options.senderLabel;
    group.append(sender);
  }
  group.append(bubble);
  container.querySelector(".chat-thread-inner")?.append(group);
  return { bubble, group };
}

export function stubAnimationFrames() {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }),
  );
  return () => {
    for (const callback of callbacks.splice(0)) {
      callback(0);
    }
  };
}
