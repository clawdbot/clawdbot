import { afterEach, describe, expect, it, vi } from "vitest";
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

function preamble(host: ReturnType<typeof createHost>, itemId: string, text: string, seq: number) {
  handleAgentEvent(host, {
    runId: "run-1",
    seq,
    stream: "item",
    ts: TOOL_STREAM_TEST_NOW + seq,
    sessionKey: "main",
    data: { kind: "preamble", itemId, progressText: text },
  });
}

describe("keyed commentary after an unphased live stream", () => {
  afterEach(() => vi.useRealTimers());
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
  it.each([
    "First paragraph.\n\nSecond paragraph.",
    "- first\n- second",
    "```python\nif ready:\n    run()\n```",
  ])("preserves complete formatting when the keyed projection flattens %j", (text) => {
    const host = createHost({ chatRunId: "run-1", chatStream: `${text}\n\n` });
    const flattened = text.replace(/\s+/gu, " ");
    preamble(host, "item-a", flattened, 1);
    preamble(host, "item-a", flattened, 2);
    expect(visibleParts(host)).toEqual([{ text, itemId: "item-a" }]);
  });

  it.each([`${COMMENTARY} More detail.`, `Before. ${COMMENTARY}`, "Different text."])(
    "does not retire a different complete occurrence: %s",
    (text) => {
      const host = createHost({ chatRunId: "run-1", chatStream: text });
      preamble(host, "item-a", COMMENTARY, 1);
      expect(visibleParts(host)).toEqual([
        { text: COMMENTARY, itemId: "item-a" },
        { text, itemId: undefined },
      ]);
    },
  );

  it("does not let a late item update consume a later identical occurrence", () => {
    const host = createHost({ chatRunId: "run-1", chatStream: `${COMMENTARY}\n\n` });
    preamble(host, "item-a", COMMENTARY, 1);
    host.chatStream += `${COMMENTARY}\n\n`;
    preamble(host, "item-a", COMMENTARY, 2);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: undefined },
    ]);
    preamble(host, "item-b", COMMENTARY, 3);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: "item-b" },
    ]);
  });

  it("retires a saved owner's first occurrence only, including delayed updates", () => {
    const saved = {
      role: "assistant",
      content: COMMENTARY,
      __openclaw: { id: "saved-a", seq: 1, runId: "run-1" },
      openclawStreamFallback: { itemId: "item-a", source: "segment" },
    };
    const host = createHost({
      chatRunId: "run-1",
      chatMessages: [saved],
      chatStream: `${COMMENTARY}\n\n`,
    });
    preamble(host, "item-a", COMMENTARY, 1);
    expect(visibleParts(host)).toEqual([]);
    expect(host.chatMessages).toEqual([saved]);
    host.chatStream += COMMENTARY;
    preamble(host, "item-a", COMMENTARY, 2);
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: undefined }]);
  });

  it("transfers the rolled-over occurrence without changing its tool boundary", () => {
    useToolStreamFakeTimers();
    const host = createHost({ chatRunId: "run-1", chatStream: `${COMMENTARY}\n\n` });
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: TOOL_STREAM_TEST_NOW,
      sessionKey: "main",
      data: { phase: "start", toolCallId: "call_1", name: "list_files", args: {} },
    });
    preamble(host, "item-a", COMMENTARY, 2);
    expect(visibleParts(host)).toEqual([{ text: COMMENTARY, itemId: "item-a" }]);
    host.chatStream = `${COMMENTARY}\n\nLater text.`;
    preamble(host, "item-a", COMMENTARY, 3);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: "Later text.", itemId: undefined },
    ]);
  });

  it("keeps leading code indentation on a later cumulative occurrence", () => {
    const code = "    execute()\n    finish()";
    const host = createHost({ chatRunId: "run-1", chatStream: `${COMMENTARY}\n\n` });
    preamble(host, "item-a", COMMENTARY, 1);
    host.chatStream += code;
    preamble(host, "item-b", "execute() finish()", 2);
    const parts = visibleAssistantStreamParts(host, {
      includeCurrent: true,
      isHiddenStreamText: isHiddenAssistantStreamText,
    });
    expect(parts.map((part) => part.text)).toEqual([COMMENTARY, code]);
  });

  it("does not reacquire an occurrence after an item is cleared", () => {
    const host = createHost({ chatRunId: "run-1", chatStream: `${COMMENTARY}\n\n` });
    preamble(host, "item-a", COMMENTARY, 1);
    preamble(host, "item-a", "", 2);
    host.chatStream += COMMENTARY;
    preamble(host, "item-a", COMMENTARY, 3);
    expect(visibleParts(host)).toEqual([
      { text: COMMENTARY, itemId: "item-a" },
      { text: COMMENTARY, itemId: undefined },
    ]);
  });
  it("keeps earlier different cumulative text visible when a later occurrence becomes keyed", () => {
    useToolStreamFakeTimers();
    const earlier = "The first observation stays visible.";
    const host = createHost({ chatRunId: "run-1", chatStream: `${earlier}\n\n` });
    handleAgentEvent(host, {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: TOOL_STREAM_TEST_NOW,
      sessionKey: "main",
      data: { phase: "start", toolCallId: "call_1", name: "list_files", args: {} },
    });
    host.chatStream = `${earlier}\n\n${COMMENTARY}\n\n`;
    preamble(host, "item-a", COMMENTARY, 2);
    expect(visibleParts(host)).toEqual([
      { text: earlier, itemId: undefined },
      { text: COMMENTARY, itemId: "item-a" },
    ]);
  });
  it("completes a keyed handoff when the last chat chunk arrives between update and end", () => {
    const text =
      "Commentary formatting proof.\n\n- first file\n- second file\n\n```python\nif ready:\n    execute()\n```";
    const host = createHost({ chatRunId: "run-1", chatStream: text.slice(0, -4) });
    const progress = text.replace(/\s+/gu, " ");
    preamble(host, "item-a", progress, 1);
    host.chatStream = text;
    preamble(host, "item-a", progress, 2);
    expect(visibleParts(host)).toEqual([{ text, itemId: "item-a" }]);
    host.chatStream += "\n\nA later observation.";
    preamble(host, "item-a", progress, 3);
    expect(visibleParts(host)).toEqual([
      { text, itemId: "item-a" },
      { text: "A later observation.", itemId: undefined },
    ]);
  });
});
