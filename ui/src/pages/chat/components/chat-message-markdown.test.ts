/* @vitest-environment jsdom */
// Contract for the full-message fetch flag: the Gateway marks every display-
// capped projection; pending inputs share assistant expansion without gaining
// transcript mutation actions.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { renderUserMessageMarkdown, resolveMessageActionDetails } from "./chat-message-markdown.ts";

const cappedMeta = { id: "msg-1", truncated: true, reason: "display-cap" };

describe("resolveMessageActionDetails full-message fetch flag", () => {
  it.each([
    { role: "assistant", id: "msg-1", shouldFetch: true },
    { role: "user", id: "msg-1", shouldFetch: false },
    { role: "user", id: "pending:input-1", shouldFetch: true },
  ])(
    "role=$role capped by metadata -> shouldFetchFullMessage=$shouldFetch",
    ({ role, id, shouldFetch }) => {
      const details = resolveMessageActionDetails({
        message: { role, content: "Preview\n...(truncated)...", __openclaw: { ...cappedMeta, id } },
        messageId: "msg-1",
        canFetchFullMessage: true,
        onReply: () => {},
        senderLabel: role,
      });
      expect(details?.shouldFetchFullMessage).toBe(shouldFetch);
    },
  );

  it("expands accepted user text without granting transcript reply or rewind identity", () => {
    const message = {
      role: "user",
      content: "Preview",
      __openclaw: { ...cappedMeta, id: "pending:input-1" },
    };
    const details = resolveMessageActionDetails({
      message,
      messageId: "pending-render",
      canFetchFullMessage: true,
      getAssistantMessageExpansion: () => ({
        status: "loaded",
        markdown: "<think>literal user input</think>",
        revision: 1,
      }),
      onReply: vi.fn(),
      senderLabel: "user",
    });
    expect(details?.markdown).toBe("<think>literal user input</think>");
    expect(details?.replyTarget).toBeUndefined();
    expect(persistedMessageEntryId(message)).toBeNull();
  });

  it("does not fetch an assistant message that merely contains the sentinel text", () => {
    // The in-band "...(truncated)..." is ordinary Markdown to the UI; without the
    // Gateway's structural marker it is not evidence of a display cap.
    const details = resolveMessageActionDetails({
      message: {
        role: "assistant",
        content: "Quoting a log line:\n...(truncated)...\nand continuing normally.",
        __openclaw: { id: "msg-3" },
      },
      messageId: "msg-3",
      canFetchFullMessage: true,
      senderLabel: "assistant",
    });
    expect(details?.shouldFetchFullMessage).toBe(false);
  });

  it("does not fetch an untruncated assistant message", () => {
    const details = resolveMessageActionDetails({
      message: { role: "assistant", content: "Complete.", __openclaw: { id: "msg-2" } },
      messageId: "msg-2",
      canFetchFullMessage: true,
      senderLabel: "assistant",
    });
    expect(details?.shouldFetchFullMessage).toBe(false);
  });

  it("projects an oversized assistant marker to a notice without disabling recovery", () => {
    const message = {
      role: "assistant",
      content: "[chat.history omitted: message too large]",
      __openclaw: { id: "msg-oversized", truncated: true, reason: "oversized" },
    };
    const details = resolveMessageActionDetails({
      message,
      messageId: "msg-oversized",
      canFetchFullMessage: true,
      onReply: () => {},
      senderLabel: "assistant",
    });

    expect(details?.shouldFetchFullMessage).toBe(true);
    expect(details?.markdown).toBe("This message is too large to display here.");
    expect(details?.replyTarget?.text).toBe("This message is too large to display here.");

    const loaded = resolveMessageActionDetails({
      message,
      messageId: "msg-oversized",
      canFetchFullMessage: true,
      getAssistantMessageExpansion: () => ({
        status: "loaded",
        markdown: "Recovered full assistant content.",
        revision: 1,
      }),
      onReply: () => {},
      senderLabel: "assistant",
    });

    expect(loaded?.shouldFetchFullMessage).toBe(true);
    expect(loaded?.markdown).toBe("Recovered full assistant content.");
    expect(loaded?.replyTarget?.text).toBe("Recovered full assistant content.");
  });
});

describe("user message disclosure", () => {
  it.each([
    {
      name: "seven short lines",
      markdown: [
        "please re-review these:",
        "#127818",
        "#127826",
        "#127844",
        "#127881",
        "",
        "rerun the same session we had for these",
      ].join("\n"),
    },
    { name: "exactly 1200 UTF-16 code units", markdown: "a".repeat(1_200) },
    { name: "forty short lines", markdown: Array(40).fill("a").join("\n") },
  ])("keeps $name fully visible", ({ markdown }) => {
    const container = document.createElement("div");

    render(
      renderUserMessageMarkdown(
        markdown,
        "message",
        { isStreaming: false, onToggleUserMessageExpanded: vi.fn() },
        {},
      ),
      container,
    );

    expect(container.querySelector(".chat-message-disclosure")).toBeNull();
    for (const line of markdown.split("\n").filter(Boolean)) {
      expect(container.textContent).toContain(line);
    }
  });
});
