/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { renderTranscriptSearch, toggleTranscriptSearch } from "./chat-thread-interactions.ts";
import { renderChatThread } from "./chat-thread.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function requireElement(container: ParentNode, selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) {
    throw new Error(`expected ${selector}`);
  }
  return element;
}

function requireClosest(element: Element, selector: string): HTMLElement {
  const closest = element.closest<HTMLElement>(selector);
  if (!closest) {
    throw new Error(`expected closest ${selector}`);
  }
  return closest;
}

function touchPointerUp(element: Element): void {
  const event = new Event("pointerup", { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  element.dispatchEvent(event);
}

describe("chat transcript rendering", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("reveals touched metadata across stored and live groups within one transcript", async () => {
    const firstTranscript = createTestTranscript();
    const secondTranscript = createTestTranscript();
    const firstContainer = document.body.appendChild(document.createElement("div"));
    const secondContainer = document.body.appendChild(document.createElement("div"));
    const firstProps = {
      ...threadProps("pane-touch-first", "agent:main:first", [
        { role: "user", content: "Stored message", timestamp: 1_000 },
      ]),
      stream: "Live reply",
      streamStartedAt: 2_000,
    };
    const secondProps = threadProps("pane-touch-second", "agent:main:second", [
      { role: "assistant", content: "Other transcript", timestamp: 3_000 },
    ]);
    render(renderChatThread(firstProps, firstTranscript), firstContainer);
    render(renderChatThread(secondProps, secondTranscript), secondContainer);
    firstTranscript.hostConnected();
    secondTranscript.hostConnected();
    firstTranscript.hostUpdated();
    secondTranscript.hostUpdated();
    await flushDeferredRowPrune();

    const storedGroup = requireElement(firstContainer, ".chat-group.user");
    const storedBubble = requireElement(storedGroup, ".chat-bubble");
    const streamBubble = requireElement(firstContainer, ".chat-bubble.streaming");
    const streamGroup = requireClosest(streamBubble, ".chat-group--with-footer");
    const secondGroup = requireElement(secondContainer, ".chat-group.assistant");

    storedBubble.dispatchEvent(new Event("pointerup", { bubbles: true }));
    expect(storedGroup.classList.contains("chat-group--meta-revealed")).toBe(false);

    touchPointerUp(storedBubble);
    expect(storedGroup.classList.contains("chat-group--meta-revealed")).toBe(true);

    touchPointerUp(streamBubble);
    expect(storedGroup.classList.contains("chat-group--meta-revealed")).toBe(false);
    expect(streamGroup.classList.contains("chat-group--meta-revealed")).toBe(true);

    touchPointerUp(requireElement(secondGroup, ".chat-bubble"));
    expect(secondGroup.classList.contains("chat-group--meta-revealed")).toBe(true);
    expect(streamGroup.classList.contains("chat-group--meta-revealed")).toBe(true);

    touchPointerUp(requireElement(secondGroup, ".chat-copy-btn"));
    expect(secondGroup.classList.contains("chat-group--meta-revealed")).toBe(true);

    touchPointerUp(requireElement(secondGroup, ".chat-bubble"));
    expect(secondGroup.classList.contains("chat-group--meta-revealed")).toBe(false);
    firstTranscript.hostDisconnected();
    secondTranscript.hostDisconnected();
  });

  it("resolves persisted replies to their source and highlights it on click", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = threadProps("pane-reply-preview", "agent:main:main", [
      {
        role: "assistant",
        content: "The original answer",
        __openclaw: { id: "source-message" },
        timestamp: 1_000,
      },
      {
        role: "user",
        content: "Follow up",
        __openclaw: { id: "reply-message", replyToId: "source-message" },
        timestamp: 2_000,
      },
    ]);
    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    const preview = container.querySelector<HTMLButtonElement>(".chat-reply-preview--message");
    expect(preview?.textContent).toContain("Replying to Molty");
    expect(preview?.textContent).toContain("The original answer");
    expect(preview?.textContent).not.toContain("source-message");

    preview?.click();
    await Promise.resolve();

    const sourceBubble = [...container.querySelectorAll<HTMLElement>(".chat-bubble")].find(
      (bubble) => bubble.dataset.entryId === "source-message",
    );
    expect(sourceBubble?.classList.contains("chat-bubble--reply-target")).toBe(true);
    transcript.hostDisconnected();
  });

  it("hydrates an unloaded reply preview without inserting its source row", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    let resolvedMessage: unknown = undefined;
    const request = vi.fn();
    const open = vi.fn();
    const props = {
      ...threadProps("pane-reply-hydration", "agent:main:main", [
        {
          role: "user",
          content: "Follow up",
          __openclaw: { id: "reply-message", replyToId: "source-message" },
          timestamp: 2_000,
        },
      ]),
      replyMessageAccess: {
        revision: 0,
        navigationId: null,
        read: () => resolvedMessage,
        request,
        open,
      },
    };
    const rerender = () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    };
    rerender();
    transcript.hostConnected();
    await flushDeferredRowPrune();

    expect(request).toHaveBeenCalledWith("source-message");
    expect(container.querySelector("[data-entry-id='source-message']")).toBeNull();

    resolvedMessage = {
      role: "assistant",
      content: "The original answer",
      __openclaw: { id: "source-message" },
      timestamp: 1_000,
    };
    props.replyMessageAccess.revision += 1;
    rerender();

    const preview = container.querySelector<HTMLButtonElement>(".chat-reply-preview--message");
    expect(preview?.textContent).toContain("Replying to Molty");
    expect(preview?.textContent).toContain("The original answer");
    preview?.click();
    expect(open).toHaveBeenCalledWith("source-message");
    transcript.hostDisconnected();
  });

  it("clears search before navigating to a filtered reply target", async () => {
    const transcript = createTestTranscript();
    const searchContainer = document.body.appendChild(document.createElement("div"));
    const threadContainer = document.body.appendChild(document.createElement("div"));
    const open = vi.fn();
    const paneId = "pane-filtered-reply-navigation";
    const props = {
      ...threadProps(paneId, "agent:main:main", [
        {
          role: "assistant",
          content: "The original answer",
          __openclaw: { id: "source-message" },
          timestamp: 1_000,
        },
        {
          role: "user",
          content: "Follow up",
          __openclaw: {
            id: "reply-message",
            replyToId: "source-message",
            replyToPreview: { text: "The original answer", senderLabel: "Molty" },
          },
          timestamp: 2_000,
        },
      ]),
      replyMessageAccess: {
        revision: 0,
        navigationId: null,
        read: () => undefined,
        request: vi.fn(),
        open,
      },
    };
    const rerender = () => {
      render(renderTranscriptSearch(paneId, rerender), searchContainer);
      render(
        renderChatThread({ ...props, onRequestUpdate: rerender }, transcript),
        threadContainer,
      );
      transcript.hostUpdated();
    };
    toggleTranscriptSearch(paneId, rerender);
    rerender();
    transcript.hostConnected();
    const input = searchContainer.querySelector<HTMLInputElement>("input");
    expect(input).not.toBeNull();
    input!.value = "Follow up";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushDeferredRowPrune();

    expect(threadContainer.querySelector("[data-entry-id='source-message']")).toBeNull();
    const preview = threadContainer.querySelector<HTMLButtonElement>(
      ".chat-reply-preview--message",
    );
    expect(preview).not.toBeNull();
    preview!.click();

    expect(open).toHaveBeenCalledWith("source-message");
    expect(searchContainer.querySelector("input")).toBeNull();
    transcript.hostDisconnected();
  });

  it("loads a truncated assistant message once and keeps the full text visible", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const loadFullAssistantMessage = vi.fn().mockResolvedValue({
      ok: true,
      message: { role: "assistant", content: "Complete assistant content." },
    });
    function rerender() {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    }
    const props = {
      ...threadProps("pane-assistant-expand", "agent:work:main", [
        {
          role: "assistant",
          content: "Preview\n...(truncated)...",
          __openclaw: { id: "assistant-full-1" },
          timestamp: 1_000,
        },
      ]),
      fullMessageAgentId: "work",
      loadFullAssistantMessage,
      onRequestUpdate: rerender,
    };
    rerender();
    transcript.hostConnected();
    transcript.hostUpdated();

    await vi.waitFor(() => expect(container.textContent).toContain("Complete assistant content."));
    expect(loadFullAssistantMessage).toHaveBeenCalledOnce();
    expect(loadFullAssistantMessage).toHaveBeenCalledWith({
      sessionKey: "agent:work:main",
      agentId: "work",
      messageId: "assistant-full-1",
      kind: "assistant_message",
    });

    expect(container.querySelector(".chat-message-disclosure__toggle")).toBeNull();
    expect(container.textContent).toContain("Complete assistant content.");
    expect(loadFullAssistantMessage).toHaveBeenCalledOnce();
    transcript.hostDisconnected();
  });

  it("keeps transport-cut assistant text as received when full content is unavailable", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const loadFullAssistantMessage = vi.fn().mockRejectedValue(new Error("offline"));
    function rerender() {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    }
    const props = {
      ...threadProps("pane-assistant-retry", "agent:main:main", [
        {
          role: "assistant",
          content: "Preview\n...(truncated)...",
          __openclaw: { id: "assistant-retry-1" },
          timestamp: 1_000,
        },
      ]),
      loadFullAssistantMessage,
      onRequestUpdate: rerender,
    };
    rerender();
    transcript.hostConnected();
    transcript.hostUpdated();

    await vi.waitFor(() => expect(loadFullAssistantMessage).toHaveBeenCalledOnce());
    expect(container.textContent).toContain("Preview");
    expect(container.textContent).toContain("...(truncated)...");
    expect(container.querySelector(".chat-message-disclosure__toggle")).toBeNull();
    transcript.hostDisconnected();
  });

  it.each(["Enter", " "])("opens focused transcript file links with %j", async (key) => {
    const transcript = createTestTranscript();
    const onOpenWorkspaceFile = vi.fn();
    const onHistoryIntent = vi.fn();
    const container = document.body.appendChild(document.createElement("div"));
    const props = {
      ...threadProps("pane-file-link", "agent:main:main", [
        { role: "assistant", content: "Inspect `src/chat.ts:17`", timestamp: 1_000 },
      ]),
      onOpenWorkspaceFile,
      onHistoryIntent,
    };
    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    const link = container.querySelector<HTMLAnchorElement>("a.markdown-file-link");
    link?.focus();
    expect(document.activeElement).toBe(link);
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    link?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onOpenWorkspaceFile).toHaveBeenCalledWith({ path: "src/chat.ts", line: 17 });
    expect(onHistoryIntent).not.toHaveBeenCalled();
    transcript.hostDisconnected();
  });

  it.each(["click", "Ctrl+click", "Enter", " "])(
    "handles transcript session links with %j",
    async (action) => {
      const transcript = createTestTranscript();
      const onOpenSessionLink = vi.fn();
      const onHistoryIntent = vi.fn();
      const sessionKey = "agent:roboclaw:dashboard:2139bddb-3211-4641-b993-10f619f124e6";
      const container = document.body.appendChild(document.createElement("div"));
      const props = {
        ...threadProps("pane-session-link", "agent:main:main", [
          { role: "assistant", content: `Open \`${sessionKey}\``, timestamp: 1_000 },
        ]),
        onOpenSessionLink,
        onHistoryIntent,
      };
      render(renderChatThread(props, transcript), container);
      transcript.hostConnected();
      transcript.hostUpdated();
      await flushDeferredRowPrune();

      const link = container.querySelector<HTMLAnchorElement>("a.markdown-session-link");
      if (action === "click" || action === "Ctrl+click") {
        link?.setAttribute("href", "/chat/roboclaw/2139bddb");
        const modified = action === "Ctrl+click";
        const event = new MouseEvent("click", {
          bubbles: true,
          button: 0,
          cancelable: true,
          ctrlKey: modified,
        });
        link?.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(!modified);
        if (modified) {
          expect(onOpenSessionLink).not.toHaveBeenCalled();
          transcript.hostDisconnected();
          return;
        }
      } else {
        link?.focus();
        const event = new KeyboardEvent("keydown", {
          key: action,
          bubbles: true,
          cancelable: true,
        });
        link?.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(onHistoryIntent).not.toHaveBeenCalled();
      }

      expect(onOpenSessionLink).toHaveBeenCalledWith({ sessionKey, agentId: "roboclaw" });
      transcript.hostDisconnected();
    },
  );
});
