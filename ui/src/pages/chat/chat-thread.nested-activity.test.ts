// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { buildChatItems } from "./chat-thread-build.ts";

const user = {
  role: "user",
  content: "Run the task",
  timestamp: 1,
  __openclaw: { id: "user", seq: 1, transcriptPosition: { source: "snapshot", rawSeq: 0 } },
};

function completedCall(
  id: string,
  name: string,
  rawSeq: number,
  activity?: { afterRawSeq: number; startOrder: number },
) {
  return {
    role: "assistant",
    runId: "run",
    timestamp: 1,
    content: [
      { type: "toolCall", id, name, arguments: {} },
      { type: "toolResult", toolCallId: id, name, content: [{ type: "text", text: "done" }] },
    ],
    __openclaw: {
      id,
      seq: rawSeq + 1,
      transcriptPosition: {
        source: "snapshot",
        rawSeq,
        ...(activity ? { activity: { ...activity, scopeId: "attempt" } } : {}),
      },
    },
  };
}

function renderedToolIds(messages: unknown[], toolMessages: unknown[] = []) {
  const items = buildChatItems({
    paneId: "nested-activity",
    sessionKey: "agent:main:main",
    runId: "run",
    messages,
    toolMessages,
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
  });
  return items.flatMap((item) =>
    item.kind === "group"
      ? item.messages.flatMap(({ message }) =>
          extractToolCardsCached(message).map((card) => card.id),
        )
      : [],
  );
}

describe("durable nested activity composition", () => {
  it("repositions separately arriving completions without changing raw history", () => {
    const exec = completedCall("exec", "exec", 1);
    const second = completedCall("second", "read", 3, { afterRawSeq: 1, startOrder: 1 });
    expect(renderedToolIds([user, exec, second])).toEqual(["tool:exec", "tool:second"]);

    const wait = completedCall("wait", "wait", 4);
    const first = completedCall("first", "read", 5, { afterRawSeq: 1, startOrder: 0 });
    const third = completedCall("third", "read", 6, { afterRawSeq: 4, startOrder: 2 });
    const history = [user, exec, second, wait, first, third];
    const original = structuredClone(history);
    expect(renderedToolIds(history)).toEqual([
      "tool:exec",
      "tool:first",
      "tool:second",
      "tool:wait",
      "tool:third",
    ]);
    expect(history).toEqual(original);
  });

  it("keeps durable placement when an earlier live echo is coalesced", () => {
    const exec = completedCall("exec", "exec", 1);
    const first = completedCall("first", "read", 5, { afterRawSeq: 1, startOrder: 0 });
    const wait = completedCall("wait", "wait", 4);
    const live = {
      ...first,
      __openclaw: undefined,
      __openclawToolStreamLive: true,
      __openclawToolStreamResultReceived: true,
      timestamp: 0,
    };
    expect(renderedToolIds([user, exec, wait, first], [live])).toEqual([
      "tool:exec",
      "tool:first",
      "tool:wait",
    ]);
  });

  it.each([
    { label: "single call", ids: ["first"] },
    { label: "bundled calls", ids: ["first", "second"] },
  ])("keeps durable $label after exec across an early live echo and stream", ({ ids }) => {
    const exec = completedCall("exec", "exec", 1);
    const wait = completedCall("wait", "wait", 4);
    const children = ids.map((id, startOrder) =>
      completedCall(id, "read", 5, { afterRawSeq: 1, startOrder }),
    );
    for (const child of children) {
      for (const block of child.content) {
        Object.assign(block, { parentToolCallId: "exec" });
      }
    }
    const durable = {
      ...children[0],
      content: children.flatMap((child) => child.content),
    };
    const history = [user, exec, wait, durable];
    const original = structuredClone(history);
    const items = buildChatItems({
      paneId: "nested-activity-stream",
      sessionKey: "agent:main:main",
      runId: "run",
      messages: history,
      toolMessages: children.map((child) => ({
        role: child.role,
        runId: child.runId,
        __openclawToolStreamLive: true,
        __openclawToolStreamResultReceived: false,
        timestamp: 0,
        content: structuredClone(child.content.filter((block) => block.type === "toolCall")),
      })),
      streamSegments: [{ text: "Still working", ts: 0.5, runId: "run" }],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    });
    const visibleOrder = items.flatMap((item) => {
      if (item.kind !== "group") {
        return [item.kind];
      }
      return item.messages.flatMap(({ message }) => {
        const cards = extractToolCardsCached(message);
        return cards.length > 0 ? cards.map((card) => card.id) : [item.role];
      });
    });
    expect(visibleOrder).toEqual([
      "user",
      "stream",
      "tool:exec",
      ...ids.map((id) => `tool:${id}`),
      "tool:wait",
    ]);
    const rendered = items.flatMap((item) =>
      item.kind === "group" ? item.messages.map(({ message }) => message) : [],
    );
    expect(rendered).toContainEqual(
      expect.objectContaining({
        content: expect.arrayContaining(
          ids.map((id) =>
            expect.objectContaining({ type: "toolCall", id, parentToolCallId: "exec" }),
          ),
        ),
      }),
    );
    expect(
      rendered
        .flatMap((message) => extractToolCardsCached(message))
        .filter((card) => ids.includes(card.callId ?? "")),
    ).toEqual(
      ids.map((id) => expect.objectContaining({ callId: id, completed: true, outputText: "done" })),
    );
    expect(history).toEqual(original);
  });

  it("keeps earliest-echo placement when activity positioning is malformed", () => {
    const exec = completedCall("exec", "exec", 1);
    const wait = completedCall("wait", "wait", 4);
    const first = completedCall("first", "read", 5, { afterRawSeq: 5, startOrder: 0 });
    const live = {
      ...first,
      __openclaw: undefined,
      __openclawToolStreamLive: true,
      __openclawToolStreamResultReceived: true,
      timestamp: 0,
    };
    expect(renderedToolIds([user, exec, wait, first], [live])).toEqual([
      "tool:first",
      "tool:exec",
      "tool:wait",
    ]);
  });

  it("uses a completed anchor's physical position rather than its relocated start", () => {
    const exec = completedCall("exec", "exec", 1);
    const wait = completedCall("wait", "wait", 4);
    const earlier = completedCall("earlier", "read", 5, { afterRawSeq: 1, startOrder: 0 });
    const later = completedCall("later", "read", 6, { afterRawSeq: 5, startOrder: 1 });
    expect(renderedToolIds([user, exec, wait, earlier, later])).toEqual([
      "tool:exec",
      "tool:earlier",
      "tool:wait",
      "tool:later",
    ]);
  });
});
