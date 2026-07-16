// Control UI tests cover build chat items behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { extractToolCardsCached as extractToolCards } from "../../lib/chat/tool-cards.ts";
import {
  buildCachedChatItems,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
  getExpandedToolCards,
  resetChatThreadState,
  syncToolCardExpansionState,
} from "./chat-thread.ts";

type CachedChatItemsProps = Parameters<typeof buildCachedChatItems>[0];
type WorkGroupItem = Extract<
  ReturnType<typeof collapseCompletedTurnWork>[number],
  { kind: "work-group" }
>;

const SENDER_METADATA_BLOCK =
  'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui","id":"openclaw-control-ui"}\n```';

function createProps(overrides: Partial<CachedChatItemsProps> = {}): CachedChatItemsProps {
  return {
    paneId: "pane-a",
    sessionKey: "main",
    runId: null,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}

function messageGroups(props: Partial<CachedChatItemsProps>): MessageGroup[] {
  return buildCachedChatItems(createProps(props)).filter((item) => item.kind === "group");
}

function firstMessageContent(group: MessageGroup): unknown[] {
  const message = group.messages[0]?.message as { content?: unknown };
  return Array.isArray(message.content) ? message.content : [];
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function requireGroup(value: unknown): MessageGroup {
  const record = requireRecord(value);
  expect(record.kind).toBe("group");
  return value as MessageGroup;
}

function groupAt(groups: readonly MessageGroup[], index: number): MessageGroup {
  return expectDefined(groups[index], `message group ${index}`);
}

function messageAt(group: MessageGroup, index: number) {
  return expectDefined(group.messages[index], `message ${index} in group ${group.key}`);
}

function messageRecord(group: MessageGroup, index = 0): Record<string, unknown> {
  return requireRecord(group.messages[index]?.message);
}

describe("collapseCompletedTurnWork", () => {
  const collapsedItems = (props: Partial<CachedChatItemsProps>, runWorking = false) =>
    collapseCompletedTurnWork(coalesceStreamRuns(buildCachedChatItems(createProps(props))), {
      runWorking,
    });

  function requireWorkGroup(value: unknown): WorkGroupItem {
    const record = requireRecord(value);
    expect(record.kind).toBe("work-group");
    return value as WorkGroupItem;
  }

  const toolResult = (id: string, timestamp: number, isError = false) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    isError,
    content: isError ? "boom" : "ok",
    timestamp,
  });

  it("collapses a completed turn's work behind one worked-for rollup", () => {
    const items = collapsedItems({
      messages: [
        { role: "user", content: "do it", timestamp: 1_000 },
        { role: "assistant", content: "Checking…", timestamp: 2_000 },
        toolResult("call-1", 3_000),
        { role: "assistant", content: "All done.", timestamp: 10_000 },
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(["group", "work-group", "group"]);
    const work = requireWorkGroup(items[1]);
    expect(work.groups).toHaveLength(2);
    expect(work.durationMs).toBe(9_000);
    expect(work.hasError).toBe(false);
    expect(requireGroup(items[2]).role).toBe("assistant");
  });

  it("keeps the trailing turn expanded while the run works", () => {
    const items = collapsedItems(
      {
        runWorking: true,
        messages: [
          { role: "user", content: "do it", timestamp: 1_000 },
          toolResult("call-1", 2_000),
        ],
      },
      true,
    );

    expect(items.some((item) => item.kind === "work-group")).toBe(false);
  });

  it("keeps reply-less turns expanded after the run finishes", () => {
    const messages = [
      { role: "user", content: "do it", timestamp: 1_000 },
      toolResult("call-1", 2_000),
    ];

    // A reply-less executing turn stays expanded while live and remains visible
    // after completion instead of becoming an opaque worked-for rollup.
    expect(collapsedItems({ messages }, true).some((item) => item.kind === "work-group")).toBe(
      false,
    );

    const idle = collapsedItems({ messages });
    expect(idle.map((item) => item.kind)).toEqual(["group", "group"]);
    expect(requireGroup(idle[1]).role).toBe("tool");
  });

  it("keeps failed work visible in turns that never replied", () => {
    const items = collapsedItems({
      messages: [
        { role: "user", content: "go", timestamp: 1_000 },
        toolResult("call-1", 2_000, true),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(["group", "group"]);
    expect(requireGroup(items[1]).role).toBe("tool");
  });

  it("does not flag errors once the turn recovered with a reply", () => {
    const items = collapsedItems({
      messages: [
        { role: "user", content: "go", timestamp: 1_000 },
        toolResult("call-1", 2_000, true),
        { role: "assistant", content: "Recovered via another route.", timestamp: 3_000 },
      ],
    });

    expect(requireWorkGroup(items[1]).hasError).toBe(false);
  });

  it("keeps work after the final reply visible", () => {
    const items = collapsedItems({
      messages: [
        { role: "user", content: "go", timestamp: 1_000 },
        toolResult("call-1", 2_000),
        { role: "assistant", content: "Done.", timestamp: 3_000 },
        toolResult("call-2", 4_000),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(["group", "work-group", "group", "group"]);
    expect(requireGroup(items[3]).role).toBe("tool");
  });

  it("does not collapse across dividers", () => {
    const items = collapsedItems({
      messages: [
        { role: "user", content: "go", timestamp: 1_000 },
        toolResult("call-1", 2_000),
        {
          role: "system",
          content: "",
          timestamp: 3_000,
          __openclaw: { kind: "compaction", id: "c1" },
        },
        { role: "assistant", content: "Done.", timestamp: 4_000 },
      ],
    });

    expect(items.some((item) => item.kind === "work-group")).toBe(false);
    expect(items.some((item) => item.kind === "divider")).toBe(true);
  });

  it("keeps attachment-only final replies outside the work rollup", () => {
    const items = collapsedItems({
      messages: [
        { role: "user", content: "render it", timestamp: 1_000 },
        toolResult("call-1", 2_000),
        {
          role: "assistant",
          content: [
            {
              type: "image",
              url: "/media/screenshot.png",
              source: { type: "url", url: "/media/screenshot.png" },
            },
          ],
          timestamp: 3_000,
        },
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(["group", "work-group", "group"]);
    expect(requireGroup(items[2]).role).toBe("assistant");
  });

  it("keeps search matches visible instead of folding them into a rollup", () => {
    const items = collapseCompletedTurnWork(
      coalesceStreamRuns(
        buildCachedChatItems(
          createProps({
            messages: [
              { role: "user", content: "do it", timestamp: 1_000 },
              toolResult("call-1", 2_000),
              { role: "assistant", content: "All done.", timestamp: 3_000 },
            ],
            searchOpen: true,
            searchQuery: "ok",
          }),
        ),
      ),
      { runWorking: false, searchActive: true },
    );

    expect(items.some((item) => item.kind === "work-group")).toBe(false);
  });

  it("collapses each completed turn independently", () => {
    const items = collapsedItems({
      messages: [
        { role: "user", content: "first", timestamp: 1_000 },
        toolResult("call-1", 2_000),
        { role: "assistant", content: "First done.", timestamp: 3_000 },
        { role: "user", content: "second", timestamp: 4_000 },
        toolResult("call-2", 5_000),
        { role: "assistant", content: "Second done.", timestamp: 6_000 },
      ],
    });

    const workGroups = items.filter((item) => item.kind === "work-group");
    expect(workGroups).toHaveLength(2);
    expect(new Set(workGroups.map((item) => item.key)).size).toBe(2);
  });

  it("collapses hidden-input runs independently without changing duration arithmetic", () => {
    const items = collapsedItems({
      messages: [
        {
          ...toolResult("call-1", 1_000),
          __openclaw: { id: "work-1", seq: 1, turnBoundary: true },
        },
        {
          role: "assistant",
          content: "First run done.",
          timestamp: 3_000,
          __openclaw: { id: "reply-1", seq: 2 },
        },
        {
          ...toolResult("call-2", 4_000),
          __openclaw: { id: "work-2", seq: 3, turnBoundary: true },
        },
        {
          role: "assistant",
          content: "Second run done.",
          timestamp: 9_000,
          __openclaw: { id: "reply-2", seq: 4 },
        },
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(["work-group", "group", "work-group", "group"]);
    expect(requireWorkGroup(items[0]).durationMs).toBe(2_000);
    expect(requireWorkGroup(items[2]).durationMs).toBe(5_000);
  });

  it("keeps a completed-work row keyed to its final reply as older work is prepended", () => {
    resetChatThreadState();
    const finalReply = {
      __openclaw: { id: "final-reply", seq: 3 },
      role: "assistant",
      content: "Done.",
      timestamp: 3_000,
    };
    const initial = collapsedItems({
      messages: [toolResult("call-1", 2_000), finalReply],
    });
    const initialWork = requireWorkGroup(initial[0]);

    const prepended = collapsedItems({
      messages: [
        {
          __openclaw: { id: "older-commentary", seq: 1 },
          role: "assistant",
          content: "Checking.",
          timestamp: 1_000,
        },
        toolResult("call-1", 2_000),
        finalReply,
      ],
    });
    const prependedWork = requireWorkGroup(prepended[0]);

    expect(prependedWork.key).toBe(initialWork.key);
    expect(prependedWork.durationMs).toBeGreaterThan(initialWork.durationMs ?? 0);
  });
});

describe("buildCachedChatItems row identity", () => {
  it("keeps a persistent message key across live-to-authoritative replacement", () => {
    resetChatThreadState();
    const initial = groupAt(
      messageGroups({
        messages: [
          {
            __openclaw: { id: "terminal-message" },
            role: "assistant",
            content: "Draft reply",
            timestamp: 1,
          },
        ],
      }),
      0,
    );
    const reconciled = groupAt(
      messageGroups({
        messages: [
          {
            __openclaw: { id: "terminal-message", seq: 42 },
            role: "assistant",
            content: "Final reply",
            timestamp: 2,
          },
        ],
      }),
      0,
    );

    expect(messageAt(reconciled, 0).key).toBe(messageAt(initial, 0).key);
  });

  it("keeps a persistent tool message key when its projected content changes", () => {
    resetChatThreadState();
    const initial = groupAt(
      messageGroups({
        messages: [
          {
            __openclaw: { id: "tool-message" },
            role: "assistant",
            toolCallId: "call-1",
            content: "Running",
            timestamp: 1,
          },
        ],
      }),
      0,
    );
    const reconciled = groupAt(
      messageGroups({
        messages: [
          {
            __openclaw: { id: "tool-message", seq: 43 },
            role: "assistant",
            toolCallId: "call-1",
            content: "Finished",
            timestamp: 2,
          },
        ],
      }),
      0,
    );

    expect(messageAt(reconciled, 0).key).toBe(messageAt(initial, 0).key);
  });

  it("preserves a same-role group key as messages are prepended and appended", () => {
    resetChatThreadState();
    const first = {
      __openclaw: { id: "assistant-1", seq: 2 },
      role: "assistant",
      content: "First",
      timestamp: 2,
    };
    const second = {
      __openclaw: { id: "assistant-2", seq: 3 },
      role: "assistant",
      content: "Second",
      timestamp: 3,
    };
    const initial = groupAt(messageGroups({ messages: [first, second] }), 0);
    const prepended = groupAt(
      messageGroups({
        messages: [
          {
            __openclaw: { id: "assistant-0", seq: 1 },
            role: "assistant",
            content: "Earlier",
            timestamp: 1,
          },
          first,
          second,
        ],
      }),
      0,
    );
    const appended = groupAt(
      messageGroups({
        messages: [
          ...prepended.messages.map((entry) => entry.message),
          {
            __openclaw: { id: "assistant-3", seq: 4 },
            role: "assistant",
            content: "Later",
            timestamp: 4,
          },
        ],
      }),
      0,
    );

    expect(prepended.key).toBe(initial.key);
    expect(appended.key).toBe(initial.key);
  });

  it("splits otherwise mergeable same-role messages at a projected turn boundary", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: { id: "assistant-1", seq: 1 },
          role: "assistant",
          content: "First run",
          timestamp: 1,
        },
        {
          __openclaw: { id: "assistant-2", seq: 2, turnBoundary: true },
          role: "assistant",
          content: "Second run",
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(groupAt(groups, 1).messages).toHaveLength(1);
  });

  it("does not reclaim a group key naturally owned by another reordered group", () => {
    resetChatThreadState();
    const first = {
      __openclaw: { id: "first", seq: 1 },
      role: "user",
      senderLabel: "same",
      content: "First",
      timestamp: 1,
    };
    const second = {
      __openclaw: { id: "second", seq: 2 },
      role: "user",
      senderLabel: "same",
      content: "Second",
      timestamp: 2,
    };
    expect(messageGroups({ messages: [first, second] })).toHaveLength(1);

    first.senderLabel = "different";
    first.timestamp = 3;
    const regrouped = messageGroups({ messages: [first, second] });

    expect(regrouped).toHaveLength(2);
    expect(new Set(regrouped.map((group) => group.key)).size).toBe(regrouped.length);
  });

  it("keeps a projected-sibling group stable after an unrelated prepend", () => {
    resetChatThreadState();
    const siblings = [
      {
        __openclaw: { seq: 2 },
        role: "assistant",
        content: "First projection",
        timestamp: 2,
      },
      {
        __openclaw: { seq: 2 },
        role: "assistant",
        content: "Second projection",
        timestamp: 2,
      },
    ];
    const initial = groupAt(messageGroups({ messages: siblings }), 0);
    const prepended = groupAt(
      messageGroups({
        messages: [
          {
            __openclaw: { id: "older-user", seq: 1 },
            role: "user",
            content: "Earlier",
            timestamp: 1,
          },
          {
            __openclaw: { seq: 2 },
            role: "assistant",
            content: "Earlier projection from the same record",
            timestamp: 2,
          },
          ...siblings.map((message) => ({
            __openclaw: { seq: message["__openclaw"].seq },
            role: message.role,
            content: message.content,
            timestamp: message.timestamp,
          })),
        ],
      }),
      1,
    );

    expect(new Set(initial.messages.map((entry) => entry.key)).size).toBe(2);
    expect(prepended.key).toBe(initial.key);
    expect(prepended.messages.slice(1).map((entry) => entry.key)).toEqual(
      initial.messages.map((entry) => entry.key),
    );
  });
});

describe("buildCachedChatItems working spark", () => {
  const hasReadingIndicator = (props: Partial<CachedChatItemsProps>) =>
    buildCachedChatItems(createProps(props)).some((item) => item.kind === "reading-indicator");
  const liveTool = (resultReceived: boolean) => ({
    role: "assistant",
    runId: "engine-run-1",
    toolCallId: "tool-1",
    content: [{ type: "toolcall", name: "exec", arguments: {} }],
    timestamp: 1_000,
    __openclawToolStreamLive: true,
    __openclawToolStreamResultReceived: resultReceived,
    __openclawToolStreamReceivedAt: 1_000,
  });

  it("shows the spark while a run works with nothing streaming", () => {
    expect(hasReadingIndicator({ runWorking: true })).toBe(true);
  });

  it("keeps the run start time on the working indicator", () => {
    const indicator = buildCachedChatItems(
      createProps({ runWorking: true, streamStartedAt: 42_000 }),
    ).find((item) => item.kind === "reading-indicator");

    expect(indicator).toMatchObject({ kind: "reading-indicator", startedAt: 42_000 });
  });

  it("keeps monotonic send timing out of wall-clock elapsed time", () => {
    const submittedAt = 1_784_000_000_000;
    const indicator = buildCachedChatItems(
      createProps({
        sessionKey: "agent:main:elapsed-clock-domain",
        runWorking: true,
        queue: [
          {
            id: "queued-send-1",
            text: "keep working",
            createdAt: submittedAt,
            sendSubmittedAtMs: 5_000,
            sendRequestStartedAtMs: 5_010,
            sendState: "sending",
          },
        ],
      }),
    ).find((item) => item.kind === "reading-indicator");

    expect(indicator).toMatchObject({ kind: "reading-indicator", startedAt: submittedAt });
  });

  it("keeps the elapsed start and trailing position after a tool flush", () => {
    const items = buildCachedChatItems(
      createProps({
        runWorking: true,
        streamStartedAt: null,
        streamSegments: [{ text: "progress", ts: 2_000 }],
        toolMessages: [liveTool(true)],
      }),
    );

    expect(items.at(-1)).toMatchObject({ kind: "reading-indicator", startedAt: 1_000 });
  });

  it("keeps the earliest browser-local start across run phases", () => {
    const sessionKey = "agent:main:elapsed-cache";
    buildCachedChatItems(
      createProps({ sessionKey, runId: "run-1", runWorking: true, streamStartedAt: 1_000 }),
    );
    const indicator = buildCachedChatItems(
      createProps({
        sessionKey,
        runId: "run-1",
        runWorking: true,
        streamStartedAt: null,
        streamSegments: [{ text: "later", ts: 2_000 }],
      }),
    ).find((item) => item.kind === "reading-indicator");

    expect(indicator).toMatchObject({ kind: "reading-indicator", startedAt: 1_000 });
  });

  it("keeps client and engine run identities separate", () => {
    const sessionKey = "agent:main:elapsed-run-namespaces";
    buildCachedChatItems(
      createProps({ sessionKey, runId: "client-run-1", runWorking: true, streamStartedAt: 500 }),
    );
    const indicator = buildCachedChatItems(
      createProps({
        sessionKey,
        runId: "client-run-1",
        runWorking: true,
        streamStartedAt: null,
        toolMessages: [liveTool(true)],
      }),
    ).find((item) => item.kind === "reading-indicator");

    expect(indicator).toMatchObject({ kind: "reading-indicator", startedAt: 500 });
  });

  it("starts fresh when a session advances to another run", () => {
    const sessionKey = "agent:main:elapsed-next-run";
    buildCachedChatItems(
      createProps({ sessionKey, runId: "run-1", runWorking: true, streamStartedAt: 1_000 }),
    );
    const indicator = buildCachedChatItems(
      createProps({ sessionKey, runId: "run-2", runWorking: true, streamStartedAt: 2_000 }),
    ).find((item) => item.kind === "reading-indicator");

    expect(indicator).toMatchObject({ kind: "reading-indicator", startedAt: 2_000 });
  });

  it("ignores gateway clock skew in tool timestamps", () => {
    const indicator = buildCachedChatItems(
      createProps({
        sessionKey: "agent:main:elapsed-clock",
        runWorking: true,
        toolMessages: [{ ...liveTool(true), timestamp: -60_000 }],
      }),
    ).find((item) => item.kind === "reading-indicator");

    expect(indicator).toMatchObject({ kind: "reading-indicator", startedAt: 1_000 });
  });

  it("keeps the spark during a background reload with visible content", () => {
    expect(
      hasReadingIndicator({
        runWorking: true,
        loading: true,
        messages: [{ role: "assistant", content: "answer", timestamp: 1 }],
      }),
    ).toBe(true);
  });

  it("yields to the initial-load skeleton on an empty thread", () => {
    expect(hasReadingIndicator({ runWorking: true, loading: true })).toBe(false);
  });

  it("does not stack the spark under a visible running tool row", () => {
    expect(hasReadingIndicator({ runWorking: true, toolMessages: [liveTool(false)] })).toBe(false);
  });

  it("returns the spark once the running tool resolves", () => {
    expect(hasReadingIndicator({ runWorking: true, toolMessages: [liveTool(true)] })).toBe(true);
  });

  it("keeps the spark when tool calls are hidden", () => {
    expect(
      hasReadingIndicator({
        runWorking: true,
        showToolCalls: false,
        toolMessages: [liveTool(false)],
      }),
    ).toBe(true);
  });
});

describe("buildCachedChatItems", () => {
  it("keeps consecutive user messages from different senders in separate groups", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: "first",
          senderLabel: "Iris",
          timestamp: 1000,
        },
        {
          role: "user",
          content: "second",
          senderLabel: "Joaquin De Rojas",
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.senderLabel)).toEqual(["Iris", "Joaquin De Rojas"]);
  });

  it("keeps differently cased user roles in one group", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: "first",
          timestamp: 1000,
        },
        {
          role: "User",
          content: "second",
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).role).toBe("user");
    expect(groupAt(groups, 0).messages).toHaveLength(2);
  });

  it("groups and hides top-level tool-use id results consistently", () => {
    const message = {
      role: "assistant",
      toolUseId: "provider-result",
      toolName: "bash",
      content: "Provider output",
      timestamp: 1000,
    };

    const visibleGroups = messageGroups({ messages: [message] });
    expect(visibleGroups).toHaveLength(1);
    expect(groupAt(visibleGroups, 0).role).toBe("tool");

    const hiddenGroups = messageGroups({ messages: [message], showToolCalls: false });
    expect(hiddenGroups).toHaveLength(0);
  });

  it("keeps forwarded assistant display messages separate from local assistant replies", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: "local reply",
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: "forwarded report",
          senderLabel: "Forwarded from main",
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.senderLabel)).toEqual([null, "Forwarded from main"]);
  });

  it("marks earlier tool groups as succeeded when the same turn has an assistant reply", () => {
    const groups = messageGroups({
      messages: [
        { role: "user", content: "search", timestamp: 1000 },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "web_search",
          isError: true,
          content: JSON.stringify({ error: "No matches" }),
          timestamp: 1001,
        },
        { role: "assistant", content: "I found another route.", timestamp: 1002 },
        { role: "user", content: "again", timestamp: 1003 },
        {
          role: "toolResult",
          toolCallId: "call-2",
          toolName: "web_search",
          isError: true,
          content: JSON.stringify({ error: "No matches" }),
          timestamp: 1004,
        },
      ],
    });

    const toolGroups = groups.filter((group) => group.role === "tool");
    expect(toolGroups.map((group) => group.turnSucceeded)).toEqual([true, false]);
  });

  it("coalesces adjacent tool calls and results into one activity item", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-shell",
              name: "bash",
              input: { command: "run openclaw doctor" },
            },
          ],
          timestamp: 1000,
        },
        {
          role: "toolResult",
          toolCallId: "call-shell",
          toolName: "bash",
          content: [
            { type: "text", text: "Doctor complete" },
            { type: "image", data: "fixture-image", mimeType: "image/png" },
          ],
          isError: false,
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).role).toBe("tool");
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    const cards = extractToolCards(messageAt(groupAt(groups, 0), 0).message, "coalesced");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      callId: "call-shell",
      name: "bash",
      outputText: "Doctor complete",
    });
    expect(firstMessageContent(groupAt(groups, 0))).toContainEqual({
      type: "image",
      data: "fixture-image",
      mimeType: "image/png",
    });
  });

  it("coalesces interleaved parallel call/result pairs by call id", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-a", name: "read", input: { path: "a.ts" } }],
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-b", name: "read", input: { path: "b.ts" } }],
          timestamp: 1001,
        },
        {
          role: "toolResult",
          toolCallId: "call-a",
          toolName: "read",
          content: [{ type: "toolResult", text: "contents of a" }],
          timestamp: 1002,
        },
        {
          role: "toolResult",
          toolCallId: "call-b",
          toolName: "read",
          content: [{ type: "toolResult", text: "contents of b" }],
          timestamp: 1003,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).role).toBe("tool");
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    const cards = groupAt(groups, 0).messages.flatMap((entry, index) =>
      extractToolCards(entry.message, `interleaved-${index}`),
    );
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ callId: "call-a", outputText: "contents of a" });
    expect(cards[1]).toMatchObject({ callId: "call-b", outputText: "contents of b" });
  });

  it("replaces a repeated unresolved single-call snapshot", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-x", name: "read", input: { path: "old.ts" } }],
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-x", name: "read", input: { path: "new.ts" } }],
          timestamp: 1001,
        },
        {
          role: "toolResult",
          toolCallId: "call-x",
          toolName: "read",
          content: [{ type: "text", text: "new contents" }],
          timestamp: 1002,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    const cards = extractToolCards(messageAt(groupAt(groups, 0), 0).message, "repeated-snapshot");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      callId: "call-x",
      args: { path: "new.ts" },
      outputText: "new contents",
    });
  });

  it("keeps more than sixteen parallel calls open by call id", () => {
    const groups = messageGroups({
      messages: [
        ...Array.from({ length: 17 }, (_, index) => ({
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `call-${index}`,
              name: "read",
              input: { path: `${index}.ts` },
            },
          ],
          timestamp: 1000 + index,
        })),
        {
          role: "toolResult",
          toolCallId: "call-0",
          toolName: "read",
          content: [{ type: "text", text: "first contents" }],
          timestamp: 1017,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(17);
    const cards = groupAt(groups, 0).messages.flatMap((entry, index) =>
      extractToolCards(entry.message, `many-open-${index}`),
    );
    expect(cards).toHaveLength(17);
    expect(cards.find((card) => card.callId === "call-0")).toMatchObject({
      outputText: "first contents",
    });
  });

  it("distributes one typed multi-result message across separate open calls", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-a", name: "read", input: { path: "a.ts" } }],
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-b", name: "read", input: { path: "b.ts" } }],
          timestamp: 1001,
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-a", content: "contents of a" },
            { type: "tool_result", tool_use_id: "call-b", content: "contents of b" },
          ],
          timestamp: 1002,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    const cards = groupAt(groups, 0).messages.flatMap((entry, index) =>
      extractToolCards(entry.message, `bundled-results-${index}`),
    );
    expect(cards.map((card) => [card.callId, card.outputText])).toEqual([
      ["call-a", "contents of a"],
      ["call-b", "contents of b"],
    ]);
  });

  it("coalesces a canonical multi-call assistant message with standalone results", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
            { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } },
          ],
          timestamp: 1000,
        },
        {
          role: "toolResult",
          toolCallId: "call-a",
          toolName: "read",
          content: [{ type: "text", text: "contents of a" }],
          timestamp: 1001,
        },
        {
          role: "toolResult",
          toolCallId: "call-b",
          toolName: "read",
          content: [{ type: "text", text: "contents of b" }],
          timestamp: 1002,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).role).toBe("tool");
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    const cards = extractToolCards(messageAt(groupAt(groups, 0), 0).message, "canonical-parallel");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      callId: "call-a",
      args: { path: "a.ts" },
      outputText: "contents of a",
    });
    expect(cards[1]).toMatchObject({
      callId: "call-b",
      args: { path: "b.ts" },
      outputText: "contents of b",
    });
  });

  it("coalesces canonical multi-call results delivered in one provider message", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call-a", name: "read", input: { path: "a.ts" } },
            { type: "tool_use", id: "call-b", name: "read", input: { path: "b.ts" } },
          ],
          timestamp: 1000,
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-a", content: "contents of a" },
            { type: "tool_result", tool_use_id: "call-b", content: "contents of b" },
          ],
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).role).toBe("tool");
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    const cards = extractToolCards(messageAt(groupAt(groups, 0), 0).message, "canonical-provider");
    expect(cards.map((card) => [card.callId, card.outputText])).toEqual([
      ["call-a", "contents of a"],
      ["call-b", "contents of b"],
    ]);
  });

  it("does not pair results across a user message boundary", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-x", name: "read", input: { path: "x.ts" } }],
          timestamp: 1000,
        },
        { role: "user", content: "never mind", timestamp: 1001 },
        {
          role: "toolResult",
          toolCallId: "call-x",
          toolName: "read",
          content: [{ type: "toolResult", text: "late result" }],
          timestamp: 1002,
        },
      ],
    });

    // Call and late result stay separate items around the user turn.
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.role)).toEqual(["tool", "user", "tool"]);
  });

  it("coalesces provider-shaped result blocks by canonical tool-use id", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolUseId: "provider-call",
              name: "bash",
              input: { command: "provider command" },
            },
          ],
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_result",
              tool_use_id: "provider-call",
              text: "Provider result",
            },
          ],
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    const cards = extractToolCards(messageAt(groupAt(groups, 0), 0).message, "provider-coalesced");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      callId: "provider-call",
      name: "bash",
      outputText: "Provider result",
    });
  });

  it("keeps adjacent tool messages separate when their call ids differ", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-a", name: "bash", input: { command: "one" } }],
          timestamp: 1000,
        },
        {
          role: "toolResult",
          toolCallId: "call-b",
          toolName: "bash",
          content: "Different call",
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
  });

  it("keeps empty forwarded assistant display groups", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          senderLabel: "Forwarded from main",
          timestamp: 1000,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).role).toBe("assistant");
    expect(groupAt(groups, 0).senderLabel).toBe("Forwarded from main");
    expect(groupAt(groups, 0).messages).toHaveLength(1);
  });

  it("collapses consecutive duplicate text messages into one rendered item with a count", () => {
    const groups = messageGroups({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Same update" }], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Same update" }], timestamp: 2 },
        { role: "assistant", content: [{ type: "text", text: "Same update" }], timestamp: 3 },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(messageAt(groupAt(groups, 0), 0).duplicateCount).toBe(3);
  });

  it("deduplicates relay-labeled assistant copies by source message id", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "reply-1",
          role: "assistant",
          content: [{ type: "text", text: "Parzival There it is." }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          id: "reply-1",
          role: "assistant",
          content: [{ type: "text", text: "There it is." }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).senderLabel).toBeNull();
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "text", text: "There it is." },
    ]);
  });

  it("deduplicates relay-labeled assistant copies by event messageId", () => {
    const groups = messageGroups({
      messages: [
        {
          messageId: "reply-2",
          role: "assistant",
          content: [{ type: "text", text: "Parzival Found it." }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          messageId: "reply-2",
          role: "assistant",
          content: [{ type: "text", text: "Found it." }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).senderLabel).toBeNull();
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "text", text: "Found it." },
    ]);
  });

  it("deduplicates relay-labeled assistant copies by OpenClaw transcript metadata id", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: { id: "reply-3" },
          role: "assistant",
          content: [{ type: "text", text: "Parzival On it." }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          __openclaw: { id: "reply-3" },
          role: "assistant",
          content: [{ type: "text", text: "On it." }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).senderLabel).toBeNull();
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "text", text: "On it." },
    ]);
  });

  it("deduplicates relay-labeled assistant copies by OpenClaw metadata before surface ids", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "relay-surface-copy",
          __openclaw: { id: "reply-4" },
          role: "assistant",
          content: [{ type: "text", text: "Parzival Ship it." }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          id: "native-surface-copy",
          __openclaw: { id: "reply-4" },
          role: "assistant",
          content: [{ type: "text", text: "Ship it." }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).senderLabel).toBeNull();
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "text", text: "Ship it." },
    ]);
  });

  it("keeps native assistant updates separate when source message id repeats with new text", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: { id: "reply-5" },
          role: "assistant",
          content: [{ type: "text", text: "Draft one" }],
          timestamp: 1,
        },
        {
          __openclaw: { id: "reply-5" },
          role: "assistant",
          content: [{ type: "text", text: "Draft two" }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    expect(messageRecord(groupAt(groups, 0), 0).content).toStrictEqual([
      { type: "text", text: "Draft one" },
    ]);
    expect(messageRecord(groupAt(groups, 0), 1).content).toStrictEqual([
      { type: "text", text: "Draft two" },
    ]);
  });

  it("keeps formatting-only assistant updates separate for the same source message", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: { id: "reply-formatted" },
          role: "assistant",
          content: [{ type: "text", text: "Parzival first\n\nsecond" }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          __openclaw: { id: "reply-formatted" },
          role: "assistant",
          content: [{ type: "text", text: "first second" }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "text", text: "Parzival first\n\nsecond" },
    ]);
    expect(messageRecord(groupAt(groups, 1)).content).toStrictEqual([
      { type: "text", text: "first second" },
    ]);
  });

  it("keeps differently cased sender text separate for the same source message", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: { id: "reply-case-change" },
          role: "assistant",
          content: [{ type: "text", text: "PARZIVAL answer" }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          __openclaw: { id: "reply-case-change" },
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "text", text: "PARZIVAL answer" },
    ]);
    expect(messageRecord(groupAt(groups, 1)).content).toStrictEqual([
      { type: "text", text: "answer" },
    ]);
  });

  it("keeps relay-labeled assistant updates separate when source message id repeats with new text", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: { id: "reply-6" },
          role: "assistant",
          content: [{ type: "text", text: "Parzival Draft one" }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          __openclaw: { id: "reply-6" },
          role: "assistant",
          content: [{ type: "text", text: "Parzival Draft two" }],
          senderLabel: "Parzival",
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).senderLabel).toBe("Parzival");
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    expect(messageRecord(groupAt(groups, 0), 0).content).toStrictEqual([
      { type: "text", text: "Parzival Draft one" },
    ]);
    expect(messageRecord(groupAt(groups, 0), 1).content).toStrictEqual([
      { type: "text", text: "Parzival Draft two" },
    ]);
  });

  it("keeps identical assistant text separate when source message ids differ", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "reply-7",
          role: "assistant",
          content: [{ type: "text", text: "Same update" }],
          senderLabel: "Parzival",
          timestamp: 1,
        },
        {
          id: "reply-8",
          role: "assistant",
          content: [{ type: "text", text: "Same update" }],
          senderLabel: "Parzival",
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    expect(messageAt(groupAt(groups, 0), 0).duplicateCount).toBeUndefined();
    expect(messageAt(groupAt(groups, 0), 1).duplicateCount).toBeUndefined();
  });

  it("keeps same-id user relay copies separate so sender identity is preserved", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: { id: "user-1" },
          role: "user",
          content: [{ type: "text", text: "Alice hello" }],
          senderLabel: "Alice",
          timestamp: 1,
        },
        {
          __openclaw: { id: "user-1" },
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.senderLabel)).toEqual(["Alice", null]);
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(groupAt(groups, 1).messages).toHaveLength(1);
  });

  it("suppresses assistant HEARTBEAT_OK acknowledgements before rendering history", () => {
    const groups = messageGroups({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "HEARTBEAT_OK" }], timestamp: 1 },
        { role: "assistant", content: "HEARTBEAT_OK", timestamp: 2 },
        { role: "user", content: [{ type: "text", text: "HEARTBEAT_OK" }], timestamp: 3 },
        { role: "assistant", content: [{ type: "text", text: "Visible reply" }], timestamp: 4 },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groupAt(groups, 0).role).toBe("user");
    expect(groupAt(groups, 1).role).toBe("assistant");
    expect(messageRecord(groupAt(groups, 1)).content).toStrictEqual([
      { type: "text", text: "Visible reply" },
    ]);
  });

  it("suppresses assistant HEARTBEAT_OK acknowledgements that carry hidden thinking blocks", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Checking scheduled work." },
            {
              type: "text",
              text: "HEARTBEAT_OK",
              textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
            },
          ],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [
            { id: "rs_1", type: "reasoning" },
            { type: "text", text: "HEARTBEAT_OK" },
          ],
          timestamp: 2,
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Useful hidden reasoning." },
            { type: "text", text: "Visible reply" },
          ],
          timestamp: 3,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "thinking", thinking: "Useful hidden reasoning." },
      { type: "text", text: "Visible reply" },
    ]);
  });

  it("keeps HEARTBEAT_OK turns that carry visible non-text content", () => {
    const canvasBlock = createAssistantCanvasBlock({ suffix: "heartbeat_visible_content" });
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "HEARTBEAT_OK" }, canvasBlock],
          timestamp: 1,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(canvasBlocksIn(groupAt(groups, 0))).toHaveLength(1);
  });

  it("suppresses active HEARTBEAT_OK streams before rendering", () => {
    const items = buildCachedChatItems(
      createProps({
        stream: "HEARTBEAT_OK",
        streamStartedAt: 1,
      }),
    );

    expect(items).toStrictEqual([]);
  });

  it("suppresses active sender metadata streams before rendering", () => {
    const items = buildCachedChatItems(
      createProps({
        stream: SENDER_METADATA_BLOCK,
        streamStartedAt: 1,
      }),
    );

    expect(items).toStrictEqual([]);
  });

  it("strips sender metadata from active stream text that has visible content", () => {
    const items = buildCachedChatItems(
      createProps({
        stream: `${SENDER_METADATA_BLOCK}\n\nVisible reply`,
        streamStartedAt: 1,
      }),
    );

    expect(items).toEqual([
      {
        kind: "stream",
        key: "stream:main:1",
        text: "Visible reply",
        startedAt: 1,
        isStreaming: true,
      },
    ]);
  });

  it("deduplicates accumulated stream snapshots around tool cards", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          { text: "First thought.", ts: 1 },
          { text: "First thought. After tool.", ts: 3 },
        ],
        toolMessages: [
          { role: "toolResult", content: "Tool one", timestamp: 2 },
          { role: "toolResult", content: "Tool two", timestamp: 4 },
        ],
        stream: "First thought. After tool. Final sentence.",
        streamStartedAt: 5,
      }),
    );

    expect(items.filter((item) => item.kind === "stream")).toMatchObject([
      { text: "First thought." },
      { text: "After tool." },
      { text: "Final sentence." },
    ]);
  });

  it("keeps distinct keyed preamble segments independent from accumulated stream snapshots", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          { text: "Checking workspace", ts: 0, itemId: "preamble-1" },
          { text: "Checking workspace", ts: 0, itemId: "preamble-2" },
          { text: "Checking workspace details", ts: 0, itemId: "preamble-3" },
        ],
        toolMessages: [{ role: "toolResult", content: "Tool output", timestamp: 1 }],
      }),
    );

    expect(items).toMatchObject([
      { kind: "stream", text: "Checking workspace", startedAt: 0 },
      { kind: "stream", text: "Checking workspace", startedAt: 0 },
      { kind: "stream", text: "Checking workspace details", startedAt: 0 },
      { kind: "group", role: "tool" },
    ]);
  });

  it("keeps already-visible tool cards before matching-timestamp keyed preambles", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [{ text: "Checking after the tool", ts: 1, itemId: "preamble-after-tool" }],
        toolMessages: [{ role: "toolResult", content: "Tool output", timestamp: 1 }],
      }),
    );

    expect(items).toMatchObject([
      { kind: "group", role: "tool" },
      { kind: "stream", text: "Checking after the tool", startedAt: 1 },
    ]);
  });

  it("orders a keyed preamble that arrived before a later tool above that tool", () => {
    // Regression: keyed commentary must merge into the timestamp ordering path
    // rather than render below every tool card. A preamble that arrived between
    // an earlier and a later tool should stay between them while the run is live.
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          { text: "Planning the next step", ts: 2, itemId: "preamble-between-tools" },
        ],
        toolMessages: [
          { role: "toolResult", content: "First tool", timestamp: 1 },
          { role: "toolResult", content: "Second tool", timestamp: 3 },
        ],
      }),
    );

    expect(items).toMatchObject([
      { kind: "group", role: "tool" },
      { kind: "stream", text: "Planning the next step", startedAt: 2 },
      { kind: "group", role: "tool" },
    ]);
    const streamItems = items.filter((item) => item.kind === "stream");
    expect(streamItems).toHaveLength(1);
  });

  it("keeps a live tool card after the stream segment that introduced it", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [{ text: "I will inspect the file.", ts: 2_000, toolCallId: "call-read" }],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: "file contents",
            timestamp: 1_000,
          },
        ],
      }),
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "stream",
      text: "I will inspect the file.",
    });
    expect(messageRecord(requireGroup(items[1])).toolCallId).toBe("call-read");
  });

  it("keeps same-millisecond stream segments interleaved with their matching tool cards", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          { text: "First tool.", ts: 2_000, toolCallId: "call-read" },
          { text: "First tool. Second tool.", ts: 2_000, toolCallId: "call-list" },
        ],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: "file contents",
            timestamp: 1_000,
          },
          {
            role: "toolResult",
            toolCallId: "call-list",
            toolName: "list",
            content: "file list",
            timestamp: 1_000,
          },
        ],
      }),
    );

    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ kind: "stream", text: "First tool." });
    expect(messageRecord(requireGroup(items[1])).toolCallId).toBe("call-read");
    expect(items[2]).toMatchObject({ kind: "stream", text: "Second tool." });
    expect(messageRecord(requireGroup(items[3])).toolCallId).toBe("call-list");
  });

  it("keeps a live tool card after its stream segment when an unkeyed preamble shifts indexes", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          { text: "Checking workspace", ts: 1_500 },
          {
            text: "Checking workspace I will inspect the file.",
            ts: 2_000,
            toolCallId: "call-read",
          },
        ],
        toolMessages: [
          {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: "file contents",
            timestamp: 1_000,
          },
        ],
      }),
    );

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      kind: "stream",
      text: "Checking workspace",
      startedAt: 1_500,
    });
    expect(items[1]).toMatchObject({
      kind: "stream",
      text: "I will inspect the file.",
    });
    expect(messageRecord(requireGroup(items[2])).toolCallId).toBe("call-read");
  });

  it("suppresses metadata-only history messages before grouping", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: SENDER_METADATA_BLOCK,
          senderLabel: "openclaw-control-ui",
          timestamp: 1,
        },
      ],
    });

    expect(groups).toStrictEqual([]);
  });

  it("renders all loaded history through one keyed row sequence", () => {
    const items = buildCachedChatItems(
      createProps({
        messages: Array.from({ length: 105 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message ${index}`,
          timestamp: index,
        })),
      }),
    );

    const groups = items.filter((item) => item.kind === "group");

    expect(groups).toHaveLength(105);
    expect(messageRecord(groupAt(groups, 0)).content).toBe("message 0");
    expect(groups.map((group) => messageRecord(group).content).at(-1)).toBe("message 104");
  });

  it("does not truncate loaded history by raw content size", () => {
    const largeOutput = "x".repeat(100_000);
    const items = buildCachedChatItems(
      createProps({
        messages: Array.from({ length: 6 }, (_, index) => ({
          role: "assistant",
          content: [
            {
              type: "tool_result",
              tool_use_id: `tool-${index}`,
              content: largeOutput,
            },
          ],
          timestamp: index,
        })),
      }),
    );
    const groups = items.filter((item) => item.kind === "group");

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(6);
    expect(messageRecord(groupAt(groups, 0), 0).timestamp).toBe(0);
    expect(messageRecord(groupAt(groups, 0), 5).timestamp).toBe(5);
  });

  it("does not crash when history contains malformed entries", () => {
    const items = buildCachedChatItems(
      createProps({
        messages: [
          null,
          undefined,
          {
            role: "assistant",
            content: "still visible",
            timestamp: 1,
          },
        ],
      }),
    );

    const groups = items.filter((item) => item.kind === "group");
    expect(groups).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).content).toBe("still visible");
  });

  it("does not collapse duplicate text messages separated by another message", () => {
    const groups = messageGroups({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "same" }], timestamp: 1 },
        { role: "user", content: [{ type: "text", text: "break" }], timestamp: 2 },
        { role: "assistant", content: [{ type: "text", text: "same" }], timestamp: 3 },
      ],
    });

    expect(groups).toHaveLength(3);
    expect(messageAt(groupAt(groups, 0), 0).duplicateCount).toBeUndefined();
    expect(messageAt(groupAt(groups, 2), 0).duplicateCount).toBeUndefined();
  });

  it("does not collapse messages that carry canvas previews", () => {
    const canvasBlock = createAssistantCanvasBlock({ suffix: "duplicate_guard" });
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "preview" }, canvasBlock],
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "preview" }, canvasBlock],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    expect(messageAt(groupAt(groups, 0), 0).duplicateCount).toBeUndefined();
  });

  it("orders live tool messages before newer history messages", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Newer history reply." }],
          timestamp: 2_000,
        },
      ],
      toolMessages: [
        {
          role: "tool",
          toolCallId: "call-older-tool",
          toolName: "shell",
          content: "Older live tool output.",
          timestamp: 1_000,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.role)).toEqual(["tool", "assistant"]);
    expect(messageRecord(groupAt(groups, 0)).content).toBe("Older live tool output.");
    expect(messageRecord(groupAt(groups, 1)).content).toStrictEqual([
      { type: "text", text: "Newer history reply." },
    ]);
  });

  it("orders completed stream segments before newer history messages", () => {
    const items = buildCachedChatItems(
      createProps({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Newer history reply." }],
            timestamp: 2_000,
          },
        ],
        streamSegments: [{ text: "Older streamed output.", ts: 1_000 }],
      }),
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "stream",
      text: "Older streamed output.",
      startedAt: 1_000,
      isStreaming: false,
    });
    expect(requireGroup(items[1]).role).toBe("assistant");
  });

  it("orders timestamped chat items before history messages without timestamps", () => {
    const items = buildCachedChatItems(
      createProps({
        messages: [{ role: "assistant", content: "Missing timestamp." }],
        streamSegments: [{ text: "Timestamped stream.", ts: Number.MAX_SAFE_INTEGER }],
      }),
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "stream",
      text: "Timestamped stream.",
      startedAt: Number.MAX_SAFE_INTEGER,
      isStreaming: false,
    });
    expect(messageRecord(requireGroup(items[1])).content).toBe("Missing timestamp.");
  });

  it("renders an active stream after the persisted user turn it answers", () => {
    const items = buildCachedChatItems(
      createProps({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Persisted prompt." }],
            timestamp: 2_000,
          },
        ],
        stream: "Visible partial answer.",
        streamStartedAt: 1_000,
      }),
    );

    expect(items).toHaveLength(2);
    expect(requireGroup(items[0]).role).toBe("user");
    expect(items[1]).toMatchObject({
      kind: "stream",
      text: "Visible partial answer.",
      startedAt: 2_001,
      isStreaming: true,
    });
  });

  it("renders submitted queued sends as user turns before chat.send ACK", () => {
    const groups = messageGroups({
      messages: [{ role: "assistant", content: "Ready.", timestamp: 1 }],
      queue: [
        {
          id: "pending-send-1",
          text: "first visible send",
          createdAt: 2,
          sendSubmittedAtMs: 10,
          sendState: "sending",
        },
      ],
    });

    expect(groups.map((group) => group.role)).toEqual(["assistant", "user"]);
    expect(messageRecord(groupAt(groups, 1)).content).toStrictEqual([
      { type: "text", text: "first visible send" },
    ]);
  });

  it("keeps restored in-flight sends visible without process-local timing", () => {
    const restored = {
      id: "restored-send-1",
      text: "stay visible across reconnect",
      createdAt: 2,
      sendAttempts: 1,
    };

    expect(
      messageGroups({
        queue: [{ ...restored, sendAttempts: 0, sendState: "waiting-reconnect" }],
      }),
    ).toStrictEqual([]);
    for (const sendState of ["waiting-reconnect", "sending"] as const) {
      const groups = messageGroups({ queue: [{ ...restored, sendState }] });
      expect(groups).toHaveLength(1);
      expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
        { type: "text", text: "stay visible across reconnect" },
      ]);
    }
  });

  it("keeps steerable queued sends out of the thread until sending starts", () => {
    const queued = {
      id: "pending-send-1",
      text: "wait above the composer",
      createdAt: 2,
      sendSubmittedAtMs: 10,
    };

    expect(messageGroups({ queue: [{ ...queued, sendState: "waiting-idle" }] })).toStrictEqual([]);

    const groups = messageGroups({ queue: [{ ...queued, sendState: "sending" }] });
    expect(groups).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "text", text: "wait above the composer" },
    ]);
  });

  it("renders submitted queued attachment sends with attachment blocks before chat.send ACK", () => {
    const groups = messageGroups({
      queue: [
        {
          id: "pending-attachment-send-1",
          text: "see attached",
          createdAt: 2,
          sendSubmittedAtMs: 10,
          sendState: "sending",
          attachments: [
            {
              id: "attachment-1",
              mimeType: "image/png",
              fileName: "screenshot.png",
              previewUrl: "/media/screenshot.png",
            },
          ],
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "text", text: "see attached" },
      {
        type: "image",
        url: "/media/screenshot.png",
        source: { type: "url", url: "/media/screenshot.png" },
      },
    ]);
  });

  it("does not collapse pending sends with matching history text", () => {
    const groups = messageGroups({
      messages: [{ role: "user", content: "same prompt", timestamp: 1 }],
      queue: [
        {
          id: "pending-send-1",
          text: "same prompt",
          createdAt: 2,
          sendSubmittedAtMs: 10,
          sendState: "sending",
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    expect(messageAt(groupAt(groups, 0), 0).duplicateCount).toBeUndefined();
    expect(messageAt(groupAt(groups, 0), 1).duplicateCount).toBeUndefined();
  });

  it("keeps failed queued sends out of the thread", () => {
    const groups = messageGroups({
      queue: [
        {
          id: "failed-send-1",
          text: "restore me to the composer",
          createdAt: 1,
          sendSubmittedAtMs: 10,
          sendState: "failed",
        },
      ],
    });

    expect(groups).toStrictEqual([]);
  });

  it("filters submitted queued sends while chat search is active", () => {
    const groups = messageGroups({
      searchOpen: true,
      searchQuery: "matching",
      queue: [
        {
          id: "pending-send-1",
          text: "matching prompt",
          createdAt: 1,
          sendSubmittedAtMs: 10,
          sendState: "sending",
        },
        {
          id: "pending-send-2",
          text: "unrelated prompt",
          createdAt: 2,
          sendSubmittedAtMs: 11,
          sendState: "sending",
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "text", text: "matching prompt" },
    ]);
  });

  it("attaches lifted canvas previews to the nearest assistant turn", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-with-canvas",
          role: "assistant",
          content: [{ type: "text", text: "First reply." }],
          timestamp: 1_000,
        },
        {
          id: "assistant-without-canvas",
          role: "assistant",
          content: [{ type: "text", text: "Later unrelated reply." }],
          timestamp: 2_000,
        },
      ],
      toolMessages: [
        {
          id: "tool-canvas-for-first-reply",
          role: "tool",
          toolCallId: "call-canvas-old",
          toolName: "canvas_render",
          content: JSON.stringify({
            kind: "canvas",
            view: {
              backend: "canvas",
              id: "cv_nearest_turn",
              url: "/__openclaw__/canvas/documents/cv_nearest_turn/index.html",
              title: "Nearest turn demo",
              preferred_height: 320,
            },
            presentation: {
              target: "assistant_message",
            },
          }),
          timestamp: 1_001,
        },
      ],
    });

    expect(canvasBlocksIn(groupAt(groups, 0))).toHaveLength(1);
    expect(canvasBlocksIn(groupAt(groups, 1))).toStrictEqual([]);
  });

  it("keeps a live App preview on an assistant search match", () => {
    const groups = messageGroups({
      messages: [{ role: "assistant", content: "Matching preview", timestamp: 1_000 }],
      toolMessages: [mcpAppResult("mcp-app-search", "call-search", 1_001)],
      searchOpen: true,
      searchQuery: "matching",
      showToolCalls: false,
    });

    expect(canvasBlocksIn(groupAt(groups, 0))).toHaveLength(1);
  });

  it("keeps a persisted App preview on an assistant search match", () => {
    for (const showToolCalls of [false, true]) {
      const groups = messageGroups({
        messages: [
          { role: "user", content: "Show the App", timestamp: 1_000 },
          mcpAppResult("mcp-app-persisted-search", "call-persisted-search", 1_001),
          { role: "assistant", content: "Matching preview", timestamp: 1_002 },
        ],
        toolMessages: [],
        searchOpen: true,
        searchQuery: "matching",
        showToolCalls,
      });

      const assistant = groups.find((group) => group.role === "assistant");
      expect(assistant).toBeDefined();
      expect(canvasBlocksIn(assistant as MessageGroup)).toHaveLength(1);
    }
  });

  it("preserves a metadata-only assistant anchor when lifting canvas previews", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-metadata-anchor",
          role: "assistant",
          content: SENDER_METADATA_BLOCK,
          timestamp: 1_000,
        },
      ],
      toolMessages: [
        {
          id: "tool-canvas-for-empty-anchor",
          role: "tool",
          toolCallId: "call-canvas-empty-anchor",
          toolName: "canvas_render",
          content: JSON.stringify({
            kind: "canvas",
            view: {
              backend: "canvas",
              id: "cv_empty_anchor",
              url: "/__openclaw__/canvas/documents/cv_empty_anchor/index.html",
              title: "Empty anchor demo",
              preferred_height: 320,
            },
            presentation: {
              target: "assistant_message",
            },
          }),
          timestamp: 1_001,
        },
      ],
    });

    expect(
      groups.some((group) => firstMessageContent(group).some((block) => isCanvasBlock(block))),
    ).toBe(true);
  });

  it("creates an assistant anchor for a silent App turn", () => {
    const groups = messageGroups({
      messages: [
        { role: "user", content: "First request", timestamp: 1_000 },
        { role: "assistant", content: "First response", timestamp: 1_001 },
        { role: "user", content: "Show the App", timestamp: 2_000 },
      ],
      toolMessages: [mcpAppResult("mcp-app-silent", "call-silent", 2_001)],
      queue: [
        {
          id: "queued-next-turn",
          text: "Next request",
          createdAt: 2_100,
          sendSubmittedAtMs: 2_100,
          sendState: "sending",
        },
      ],
      showToolCalls: false,
    });

    const assistants = groups.filter((group) => group.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(canvasBlocksIn(groupAt(assistants, 0))).toStrictEqual([]);
    expect(canvasBlocksIn(groupAt(assistants, 1))).toHaveLength(1);
  });

  it("keeps an earlier silent App preview before the next user turn", () => {
    const groups = messageGroups({
      messages: [
        { role: "user", content: "Show the App", timestamp: 1_000 },
        { role: "user", content: "Next request", timestamp: 2_000 },
      ],
      toolMessages: [mcpAppResult("mcp-app-earlier", "call-earlier", 1_001)],
      showToolCalls: false,
    });

    expect(groups.map((group) => group.role)).toEqual(["user", "assistant", "user"]);
    expect(canvasBlocksIn(groupAt(groups, 1))).toHaveLength(1);
  });

  it("places an App preview after its queued user prompt", () => {
    const groups = messageGroups({
      messages: [
        { role: "user", content: "First request", timestamp: 1_000 },
        { role: "assistant", content: "First response", timestamp: 1_001 },
      ],
      queue: [
        {
          id: "queued-app-turn",
          text: "Show the App",
          createdAt: 2_000,
          sendSubmittedAtMs: 2_000,
          sendState: "waiting-model",
        },
        {
          id: "queued-future-turn",
          text: "Later request",
          createdAt: 2_001,
          sendSubmittedAtMs: 2_001,
          sendState: "waiting-reconnect",
        },
      ],
      toolMessages: [mcpAppResult("mcp-app-queued", "call-queued", 2_002)],
      showToolCalls: false,
    });

    expect(groups.map((group) => group.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(canvasBlocksIn(groupAt(groups, 3))).toHaveLength(1);
  });

  it("restores a persisted App preview without the live tool cache", () => {
    for (const showToolCalls of [false, true]) {
      const groups = messageGroups({
        messages: [
          { role: "user", content: "Show the App", timestamp: 1_000 },
          mcpAppResult("mcp-app-persisted", "call-persisted", 1_001),
        ],
        toolMessages: [],
        showToolCalls,
      });

      const assistant = groups.find((group) => group.role === "assistant");
      expect(assistant).toBeDefined();
      expect(canvasBlocksIn(assistant as MessageGroup)).toHaveLength(1);
    }
  });

  it("deduplicates persisted and live copies of an App preview", () => {
    const result = mcpAppResult("mcp-app-overlap", "call-overlap", 1_001);
    const groups = messageGroups({
      messages: [{ role: "user", content: "Show the App", timestamp: 1_000 }, result],
      toolMessages: [result],
      showToolCalls: false,
    });

    const assistant = groups.find((group) => group.role === "assistant");
    expect(assistant).toBeDefined();
    expect(canvasBlocksIn(assistant as MessageGroup)).toHaveLength(1);
  });

  it("deduplicates timestamp-less persisted and live copies in the same turn", () => {
    const persisted = {
      ...mcpAppResult("mcp-app-untimestamped", "call-untimestamped", 1_001),
      timestamp: undefined,
    };
    const groups = messageGroups({
      messages: [{ role: "user", content: "Show the App", timestamp: 1_000 }, persisted],
      toolMessages: [mcpAppLiveResult("mcp-app-untimestamped", "call-untimestamped", 1_001)],
      showToolCalls: false,
    });

    expect(groups.flatMap((group) => canvasBlocksIn(group))).toHaveLength(1);
  });

  it("keeps distinct App previews when a tool-call ID is reused", () => {
    const first = {
      ...mcpAppResult("mcp-app-first", "call-reused", 1_001),
      timestamp: undefined,
    };
    const second = mcpAppLiveResult("mcp-app-second", "call-reused", undefined);
    const groups = messageGroups({
      messages: [
        { role: "user", content: "First App", timestamp: 1_000 },
        first,
        { role: "user", content: "Second App", timestamp: 2_000 },
      ],
      toolMessages: [second],
      showToolCalls: false,
    });

    expect(groups.map((group) => group.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(canvasBlocksIn(groupAt(groups, 1))).toHaveLength(1);
    expect(canvasBlocksIn(groupAt(groups, 3))).toHaveLength(1);
  });

  it("does not lift generic view handles from non-canvas payloads", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-generic-inline",
          role: "assistant",
          content: [{ type: "text", text: "Rendered the item inline." }],
          timestamp: 1000,
        },
      ],
      toolMessages: [
        {
          id: "tool-generic-inline",
          role: "tool",
          toolCallId: "call-generic-inline",
          toolName: "plugin_card_details",
          content: JSON.stringify({
            selected_item: {
              summary: {
                label: "Alpha",
                meaning: "Generic example",
              },
              view: {
                backend: "canvas",
                id: "cv_generic_inline",
                url: "/__openclaw__/canvas/documents/cv_generic_inline/index.html",
                title: "Inline generic preview",
                preferred_height: 420,
              },
            },
          }),
          timestamp: 1001,
        },
      ],
    });

    expect(canvasBlocksIn(groupAt(groups, 0))).toStrictEqual([]);
  });

  it("lifts streamed canvas toolresult blocks into the assistant bubble", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-streamed-artifact",
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          timestamp: 1000,
        },
      ],
      toolMessages: [
        {
          id: "tool-streamed-artifact",
          role: "assistant",
          toolCallId: "call_streamed_artifact",
          timestamp: 999,
          content: [
            {
              type: "toolcall",
              name: "canvas_render",
              arguments: { source: { type: "handle", id: "cv_streamed_artifact" } },
            },
            {
              type: "toolresult",
              name: "canvas_render",
              text: JSON.stringify({
                kind: "canvas",
                view: {
                  backend: "canvas",
                  id: "cv_streamed_artifact",
                  url: "/__openclaw__/canvas/documents/cv_streamed_artifact/index.html",
                  title: "Streamed demo",
                  preferred_height: 320,
                },
                presentation: {
                  target: "assistant_message",
                },
              }),
            },
          ],
        },
      ],
    });

    const assistantGroup = groups.find((group) => group.role === "assistant");
    expect(assistantGroup).toBeDefined();

    const canvasBlocks = canvasBlocksIn(assistantGroup as MessageGroup);
    expect(canvasBlocks).toHaveLength(1);
    const canvasBlock = requireRecord(canvasBlocks[0]);
    const preview = requireRecord(canvasBlock.preview);
    expect(preview.viewId).toBe("cv_streamed_artifact");
    expect(preview.title).toBe("Streamed demo");
  });

  it("explains compaction boundaries and exposes the checkpoint action", () => {
    const items = buildCachedChatItems(
      createProps({
        messages: [
          {
            role: "system",
            timestamp: 2_000,
            __openclaw: {
              kind: "compaction",
              id: "checkpoint-1",
            },
          },
        ],
      }),
    );

    expect(items).toHaveLength(1);
    const divider = requireRecord(items[0]);
    expect(divider.kind).toBe("divider");
    expect(divider.label).toBe("Compacted history");
    expect(divider.description).toBe(
      "The compacted transcript is preserved as a checkpoint. Open session checkpoints to branch or restore from that compacted view.",
    );
    const action = requireRecord(divider.action);
    expect(action.kind).toBe("session-checkpoints");
    expect(action.label).toBe("Open checkpoints");
  });

  it("shows the token savings recorded on a compaction boundary", () => {
    const items = buildCachedChatItems(
      createProps({
        messages: [
          {
            role: "system",
            timestamp: 2_000,
            __openclaw: {
              kind: "compaction",
              id: "checkpoint-with-metrics",
              tokensBefore: 900_000,
              tokensAfter: 24_700,
            },
          },
        ],
      }),
    );

    expect(items[0]).toMatchObject({
      kind: "divider",
      label: "Compacted history",
      metric: "saved 875.3k tokens",
    });
  });
});

describe("tool expansion state", () => {
  it("expands already-visible tool cards when auto-expand turns on", () => {
    resetChatThreadState();
    const group: MessageGroup = {
      kind: "group",
      key: "assistant-1",
      role: "assistant",
      messages: [
        {
          key: "assistant-1",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolcall",
                id: "call-1",
                name: "browser.open",
                arguments: { url: "https://example.com" },
              },
            ],
          },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };

    syncToolCardExpansionState("main", [group], false);
    expect(getExpandedToolCards("main").get("assistant-1:toolcard:0")).toBe(false);

    syncToolCardExpansionState("main", [group], true);
    expect(getExpandedToolCards("main").get("assistant-1:toolcard:0")).toBe(true);
  });

  it("auto-expands top-level tool-name result disclosures", () => {
    resetChatThreadState();
    const group: MessageGroup = {
      kind: "group",
      key: "tool-name-result",
      role: "tool",
      messages: [
        {
          key: "tool-name-result",
          message: {
            role: "assistant",
            toolName: "bash",
            content: "Tool output",
          },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };

    syncToolCardExpansionState("tool-name-session", [group], true);

    expect(getExpandedToolCards("tool-name-session").get("toolmsg:tool-name-result")).toBe(true);
  });
});

describe("thread item cache", () => {
  it("preserves stable transcript rows while the live stream changes", () => {
    resetChatThreadState();
    const messages = [{ role: "assistant", content: "ready" }];
    const toolMessages: unknown[] = [];
    const streamSegments: CachedChatItemsProps["streamSegments"] = [];
    const queue: NonNullable<CachedChatItemsProps["queue"]> = [];
    const input = createProps({ messages, toolMessages, streamSegments, queue });

    const first = buildCachedChatItems(input);
    expect(buildCachedChatItems({ ...input })).toBe(first);
    expect(buildCachedChatItems({ ...input, messages: [...messages] })).toBe(first);

    const streaming = buildCachedChatItems({
      ...input,
      stream: "partial reply",
      streamStartedAt: 10,
    });
    expect(streaming).not.toBe(first);
    expect(streaming.find((item) => item.key === first[0]?.key)).toBe(first[0]);

    expect(
      buildCachedChatItems({
        ...input,
        messages: [{ role: "assistant", content: "changed" }],
      }),
    ).not.toBe(first);
  });

  it("updates the live stream without rescanning retained history", () => {
    resetChatThreadState();
    const reads = { count: 0 };
    const messages = Array.from(
      { length: 1_000 },
      (_, index) =>
        new Proxy(
          { role: index % 2 === 0 ? "user" : "assistant", content: `message ${index}` },
          {
            get(target, property, receiver) {
              reads.count += 1;
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    );
    const input = createProps({
      messages,
      stream: "partial reply",
      streamStartedAt: 10,
    });
    const first = buildCachedChatItems(input);
    reads.count = 0;

    const updated = buildCachedChatItems({ ...input, stream: "complete reply" });

    expect(updated).toBe(first);
    expect(reads.count).toBe(0);
    expect(updated).toContainEqual(
      expect.objectContaining({
        kind: "stream",
        text: "complete reply",
        isStreaming: true,
      }),
    );
  });

  it("keeps same-session render caches isolated between panes", () => {
    resetChatThreadState();
    const messages = [
      { role: "assistant", content: "needle" },
      { role: "user", content: "other" },
    ];
    const paneA = createProps({
      paneId: "pane-a",
      messages,
      searchOpen: true,
      searchQuery: "needle",
    });
    const paneB = createProps({ paneId: "pane-b", messages });

    const paneAItems = buildCachedChatItems(paneA);
    const paneBItems = buildCachedChatItems(paneB);

    expect(buildCachedChatItems({ ...paneA })).toBe(paneAItems);
    expect(buildCachedChatItems({ ...paneB })).toBe(paneBItems);

    resetChatThreadState("pane-a");
    expect(buildCachedChatItems({ ...paneA })).not.toBe(paneAItems);
    expect(buildCachedChatItems({ ...paneB })).toBe(paneBItems);
  });
});

function canvasBlocksIn(group: MessageGroup): unknown[] {
  return firstMessageContent(group).filter((block) => isCanvasBlock(block));
}

function isCanvasBlock(block: unknown): boolean {
  return (
    Boolean(block) &&
    typeof block === "object" &&
    (block as { type?: unknown; preview?: { kind?: unknown } }).type === "canvas" &&
    (block as { preview?: { kind?: unknown } }).preview?.kind === "canvas"
  );
}

function createAssistantCanvasBlock(params: { suffix: string }) {
  const viewId = `cv_inline_${params.suffix}`;
  return {
    type: "canvas",
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId,
      title: "Inline demo",
      url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
      preferredHeight: 360,
    },
  };
}

function mcpAppResult(viewId: string, toolCallId: string, timestamp: number) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "demo__show",
    content: [{ type: "text", text: "ok" }],
    details: {
      mcpAppPreview: {
        kind: "canvas",
        view: { id: viewId, title: "Demo App" },
        presentation: { target: "assistant_message", sandbox: "scripts" },
        mcpApp: {
          viewId,
          serverName: "demo",
          toolName: "show",
          uiResourceUri: "ui://demo/app.html",
          toolCallId,
        },
      },
    },
    timestamp,
  };
}

function mcpAppLiveResult(viewId: string, toolCallId: string, timestamp: number | undefined) {
  const persisted = mcpAppResult(viewId, toolCallId, timestamp ?? 0);
  return {
    role: "assistant",
    toolCallId,
    runId: "run-live",
    content: [
      { type: "toolcall", name: "demo__show", arguments: {} },
      {
        type: "toolresult",
        name: "demo__show",
        text: "ok",
        details: persisted.details,
      },
    ],
    ...(timestamp == null ? {} : { timestamp }),
    __openclawToolStreamLive: true,
    __openclawToolStreamResultReceived: true,
  };
}

describe("tool turn outcome annotation (#89683)", () => {
  function failedTool(timestamp: number) {
    return {
      role: "toolResult",
      toolName: "shell",
      content: JSON.stringify({ status: "failed", exitCode: 1 }),
      isError: true,
      timestamp,
    };
  }
  function userMsg(text: string, timestamp: number) {
    return { role: "user", content: text, timestamp };
  }
  function assistantReply(text: string, timestamp: number) {
    return { role: "assistant", content: [{ type: "text", text }], timestamp };
  }
  function toolGroups(messages: unknown[]): MessageGroup[] {
    return messageGroups({ messages }).filter((group) => group.role === "tool");
  }

  it("marks a failed tool followed by an assistant reply as turnSucceeded", () => {
    const tools = toolGroups([
      userMsg("search foo", 1),
      failedTool(2),
      assistantReply("No matches found.", 3),
    ]);
    expect(tools).toHaveLength(1);
    expect(groupAt(tools, 0).turnSucceeded).toBe(true);
  });

  it("leaves a terminal failed tool (no assistant reply) as not-succeeded", () => {
    const tools = toolGroups([userMsg("search foo", 1), failedTool(2)]);
    expect(tools).toHaveLength(1);
    expect(groupAt(tools, 0).turnSucceeded).toBe(false);
  });

  it("does not count an assistant group without reply text as success", () => {
    const tools = toolGroups([
      userMsg("search foo", 1),
      failedTool(2),
      { role: "assistant", content: [], timestamp: 3 },
    ]);
    expect(groupAt(tools, 0).turnSucceeded).toBe(false);
  });

  it("scopes adjacent autonomous turns at an empty forwarded boundary", () => {
    const tools = toolGroups([
      failedTool(1),
      {
        role: "assistant",
        content: [],
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        senderLabel: "Forwarded from main",
        timestamp: 2,
      },
      failedTool(3),
      assistantReply("Recovered on the next autonomous turn.", 4),
    ]);
    expect(tools.map((group) => group.turnSucceeded)).toEqual([false, true]);
  });

  it("does not treat a forwarded message as the prior turn's reply", () => {
    const tools = toolGroups([
      failedTool(1),
      {
        role: "assistant",
        content: [{ type: "text", text: "Start the next autonomous task." }],
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        senderLabel: "Forwarded from main",
        timestamp: 2,
      },
      failedTool(3),
      assistantReply("Recovered on the next autonomous turn.", 4),
    ]);
    expect(tools.map((group) => group.turnSucceeded)).toEqual([false, true]);
  });

  it("treats an ordinary labeled assistant message as a reply", () => {
    const tools = toolGroups([
      userMsg("check the service", 1),
      failedTool(2),
      {
        role: "assistant",
        content: [{ type: "text", text: "Parzival recovered the service." }],
        senderLabel: "Parzival",
        timestamp: 3,
      },
    ]);
    expect(groupAt(tools, 0).turnSucceeded).toBe(true);
  });

  it("does not treat non-text assistant content as a turn boundary", () => {
    const tools = toolGroups([
      userMsg("make a preview", 1),
      failedTool(2),
      {
        role: "assistant",
        content: [createAssistantCanvasBlock({ suffix: "tool_turn_outcome" })],
        timestamp: 3,
      },
      failedTool(4),
      assistantReply("Done.", 5),
    ]);
    expect(tools.map((group) => group.turnSucceeded)).toEqual([true, true]);
  });

  it("scopes the outcome per turn at user boundaries", () => {
    const tools = toolGroups([
      userMsg("first", 1),
      failedTool(2),
      assistantReply("done", 3),
      userMsg("second", 4),
      failedTool(5),
    ]);
    expect(tools.map((group) => group.turnSucceeded)).toEqual([true, false]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
