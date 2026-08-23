/* @vitest-environment jsdom */
// Contract for the full-message fetch flag: the Gateway marks every display-
// capped projection (user rows included), but the expander that consumes this
// flag renders loaded content for assistant rows alone.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderUserMessageMarkdown, resolveMessageActionDetails } from "./chat-message-markdown.ts";

const cappedMeta = { id: "msg-1", truncated: true, reason: "display-cap" };

describe("resolveMessageActionDetails full-message fetch flag", () => {
  it.each([
    { role: "assistant", shouldFetch: true },
    { role: "user", shouldFetch: false },
  ])(
    "role=$role capped by metadata -> shouldFetchFullMessage=$shouldFetch",
    ({ role, shouldFetch }) => {
      const details = resolveMessageActionDetails({
        message: { role, content: "Preview\n...(truncated)...", __openclaw: cappedMeta },
        messageId: "msg-1",
        canFetchFullMessage: true,
        onReply: () => {},
        senderLabel: role,
      });
      expect(details?.shouldFetchFullMessage).toBe(shouldFetch);
    },
  );

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
