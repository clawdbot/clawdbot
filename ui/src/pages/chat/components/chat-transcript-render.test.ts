/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../../api/types.ts";
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

  it.each([true, false])(
    "keeps browser cards visible with capture limited to the active pane (%s)",
    async (active) => {
      const messages = [
        { role: "user", content: "Open the example", timestamp: 1_000 },
        {
          role: "toolResult",
          toolCallId: "browser-call",
          toolName: "browser",
          timestamp: 2_000,
          content: "Opened",
          details: {
            browserTab: { profile: "managed", target: "host", targetId: "tab-1", title: "Example" },
          },
        },
        { role: "assistant", content: "Done.", timestamp: 3_000 },
      ];
      const props = {
        ...threadProps("pane-browser-work", "agent:main:dashboard:browser", messages),
        browserTabPreviewsActive: active,
        showToolCalls: true,
      };
      const transcript = createTestTranscript();
      const container = document.body.appendChild(document.createElement("div"));
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
      transcript.hostConnected();
      await flushDeferredRowPrune();
      expect(container.querySelector(".chat-work-group")).not.toBeNull();
      expect(container.querySelectorAll("openclaw-browser-tab-card")).toHaveLength(1);
      expect(container.querySelector("openclaw-browser-tab-card")?.latest).toBe(active);
      transcript.hostDisconnected();
    },
  );

  it("renders canonical archive attribution as a timestamped notice without a speech bubble", async () => {
    const sessionKey = "agent:main:archived-notice";
    const archivedSession: GatewaySessionRow = {
      key: sessionKey,
      kind: "direct",
      updatedAt: 2_000,
      archived: true,
      archivedAt: 2_000,
      archivedBy: { type: "human", id: "profile-ada", label: "Ada" },
    };
    const sessions: SessionsListResult = {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [archivedSession],
    };
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = {
      ...threadProps("pane-archived-notice", sessionKey, [
        { role: "user", content: "Before archive", timestamp: 1_000 },
        { role: "assistant", content: "After archive", timestamp: 3_000 },
      ]),
      sessions,
    };
    const rerender = () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
    };
    rerender();
    transcript.hostConnected();
    await flushDeferredRowPrune();

    const notice = requireElement(container, ".chat-notice");
    expect(notice.textContent).toContain("Archived by Ada");
    expect(notice.dataset.ts).toBe("2000");
    expect(notice.querySelector(".chat-bubble")).toBeNull();
    expect(container.querySelectorAll(".chat-bubble")).toHaveLength(2);
    expect(
      [...container.querySelectorAll(".chat-virtual-row")].map((row) =>
        row.querySelector(".chat-notice") ? "notice" : "message",
      ),
    ).toEqual(["message", "notice", "message"]);

    sessions.sessions[0] = {
      ...archivedSession,
      archivedBy: { type: "human", id: "profile-bob" },
    };
    rerender();
    expect(requireElement(container, ".chat-notice").textContent).toContain(
      "Archived by profile-bob",
    );

    sessions.sessions[0] = { ...archivedSession, archivedBy: undefined };
    rerender();
    expect(container.querySelector(".chat-notice")).toBeNull();

    sessions.sessions[0] = {
      ...archivedSession,
      archived: false,
      archivedAt: undefined,
      archivedBy: undefined,
    };
    rerender();
    expect(container.querySelector(".chat-notice")).toBeNull();
    transcript.hostDisconnected();
  });

  it("leaves interrupted status to the composer after a partial assistant reply", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = {
      ...threadProps("pane-interrupted", "agent:main:main", [
        {
          role: "user",
          content: "Start the task",
          timestamp: 1_000,
          __openclaw: { idempotencyKey: "run-1:user" },
        },
        { role: "assistant", content: "Partial response", timestamp: 2_000 },
      ]),
      runStatus: {
        phase: "interrupted" as const,
        runId: "run-1",
        sessionKey: "agent:main:main",
        occurredAt: 3_000,
      },
    };

    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    expect(container.querySelector(".chat-turn-terminal-status--interrupted")).toBeNull();
    transcript.hostDisconnected();
  });

  it("leaves interrupted status to the composer when a turn has no assistant reply", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = {
      ...threadProps("pane-interrupted-empty", "agent:main:main", [
        { role: "user", content: "Earlier task", timestamp: 1_000 },
        { role: "assistant", content: "Earlier reply", timestamp: 2_000 },
        {
          role: "user",
          content: "Stop this task",
          timestamp: 3_000,
          __openclaw: { idempotencyKey: "run-2:user" },
        },
      ]),
      runStatus: {
        phase: "interrupted" as const,
        runId: "run-2",
        sessionKey: "agent:main:main",
        occurredAt: 4_000,
      },
    };

    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    expect(container.querySelector(".chat-turn-terminal-status--interrupted")).toBeNull();
    transcript.hostDisconnected();
  });

  it("keeps live metadata absent while revealing stored metadata within each transcript", async () => {
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
    expect(streamGroup.querySelector(".chat-group-footer")).toBeNull();

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
          __openclaw: { id: "assistant-full-1", truncated: true },
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
          __openclaw: { id: "assistant-retry-1", truncated: true },
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

  it.each(["click", "Enter"])("SPA-routes transcript session hrefs with %s", async (action) => {
    const transcript = createTestTranscript();
    const onOpenSessionLink = vi.fn();
    const onHistoryIntent = vi.fn();
    const literalUuid = "12345678-90ab-cdef-1234-567890abcdef";
    const href = `/control/chat/main/~key/${literalUuid}?view=full#latest`;
    const container = document.body.appendChild(document.createElement("div"));
    const props = {
      ...threadProps("pane-session-href", "agent:main:main", [
        { role: "assistant", content: `[Open session](${href})`, timestamp: 1_000 },
      ]),
      basePath: "/control",
      onOpenSessionLink,
      onHistoryIntent,
    };
    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    const link = container.querySelector<HTMLAnchorElement>(`a[href^="/control/chat/"]`);
    const event =
      action === "click"
        ? new MouseEvent("click", { bubbles: true, button: 0, cancelable: true })
        : new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    link?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onOpenSessionLink).toHaveBeenCalledWith({
      namespace: "chat",
      pathname: `/control/chat/main/~key/${literalUuid}`,
      search: "?view=full",
      hash: "#latest",
    });
    expect(onHistoryIntent).not.toHaveBeenCalled();
    transcript.hostDisconnected();
  });

  it("leaves external transcript hrefs to the browser", async () => {
    const transcript = createTestTranscript();
    const onOpenSessionLink = vi.fn();
    const container = document.body.appendChild(document.createElement("div"));
    const props = {
      ...threadProps("pane-external-href", "agent:main:main", [
        {
          role: "assistant",
          content: "[External session](https://example.com/chat/main/~key/12345678)",
          timestamp: 1_000,
        },
      ]),
      onOpenSessionLink,
    };
    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    const link = container.querySelector<HTMLAnchorElement>('a[href^="https://example.com/"]');
    const event = new MouseEvent("click", { bubbles: true, button: 0, cancelable: true });
    link?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onOpenSessionLink).not.toHaveBeenCalled();
    transcript.hostDisconnected();
  });
});
