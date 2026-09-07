import { describe, expect, it, vi } from "vitest";
import { isHiddenAssistantStreamText } from "../../lib/chat/message-visibility.ts";
import { visibleAssistantStreamParts } from "./stream-reconciliation.ts";
import {
  createHost,
  TOOL_STREAM_TEST_NOW,
  useToolStreamFakeTimers,
} from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const COMMENTARY = "I'll list the workspace files first.";

function visibleParts(host: ReturnType<typeof createHost>) {
  return visibleAssistantStreamParts(host, {
    includeCurrent: true,
    isHiddenStreamText: isHiddenAssistantStreamText,
  }).map((part) => ({ text: part.text.trim(), itemId: part.itemId }));
}

describe("keyed commentary after an unphased live stream", () => {
  it("renders tool-boundary commentary once across item and chat stream", () => {
    useToolStreamFakeTimers();
    const host = createHost({ chatRunId: "run-1" });
    // openai-completions/anthropic stream the text unphased first (chat delta).
    host.chatStream = `${COMMENTARY}\n\n`;
    host.chatStreamStartedAt = TOOL_STREAM_TEST_NOW - 50;
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: undefined }]);

    // The phase tagger then keys the same text as commentary at the tool boundary.
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 2,
      stream: "item",
      ts: TOOL_STREAM_TEST_NOW,
      sessionKey: "main",
      data: { kind: "preamble", itemId: "sig-1", progressText: COMMENTARY },
    });
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: "sig-1" }]);

    // Tool start rolls the chat stream into an indexed segment; it must stay retired.
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 3,
      stream: "tool",
      ts: TOOL_STREAM_TEST_NOW + 1,
      sessionKey: "main",
      data: { phase: "start", toolCallId: "call_1", name: "list_files", args: {} },
    });
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: "sig-1" }]);

    // The next cumulative chat snapshot still trims the retired prefix.
    host.chatStream = `${COMMENTARY}\n\nFound a match, now let me read the file`;
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "sig-1" },
      { text: "Found a match, now let me read the file", itemId: undefined },
    ]);
    vi.useRealTimers();
  });
});
