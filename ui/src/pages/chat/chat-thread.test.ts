import { expectDefined } from "@openclaw/normalization-core";
// @vitest-environment node
// Control UI tests cover build chat items behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { markInboundContextLabel } from "../../../../src/auto-reply/reply/inbound-context-marker.js";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import * as toolCards from "../../lib/chat/tool-cards.ts";
import {
  assistantGroupCanOwnActiveRunStatus,
  buildCachedChatItems,
  coalesceActivityRuns,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
  getExpansionStateVersion,
  getExpandedToolCards,
  getExpandedUserMessages,
  persistedMessageEntryId,
  resetChatThreadState,
  setExpansionState,
  syncToolCardExpansionState,
} from "./chat-thread.ts";
import { rememberLiveTerminalRun } from "./terminal-message-identity.ts";
import { resolveChatProjectionRunId } from "./tool-stream.ts";

const { extractToolCardsCached: extractToolCards } = toolCards;

describe("assistantGroupCanOwnActiveRunStatus", () => {
  const group = (message: Record<string, unknown>): MessageGroup => ({
    kind: "group",
    key: "assistant:1",
    role: "assistant",
    timestamp: 1,
    isStreaming: false,
    messages: [{ key: "message:1", message }],
  });

  it("accepts visible replies and rejects forwarded assistant input", () => {
    expect(assistantGroupCanOwnActiveRunStatus(group({ content: "Reply" }))).toBe(true);
    expect(
      assistantGroupCanOwnActiveRunStatus(
        group({
          content: "Forwarded input",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
        }),
      ),
    ).toBe(false);
  });
});

describe("persistedMessageEntryId", () => {
  it("rejects optimistic pending bubbles and accepts transcript identities", () => {
    expect(
      persistedMessageEntryId({
        role: "user",
        __openclaw: { id: "pending-send:1", kind: "pending-send" },
      }),
    ).toBeNull();
    expect(persistedMessageEntryId({ role: "user", __openclaw: { id: "entry-1", seq: 2 } })).toBe(
      "entry-1",
    );
  });
});

type CachedChatItemsProps = Parameters<typeof buildCachedChatItems>[0];
type ChatQueueItem = NonNullable<CachedChatItemsProps["queue"]>[number];
type WorkGroupItem = Extract<
  ReturnType<typeof collapseCompletedTurnWork>[number],
  { kind: "work-group" }
>;
type ActivityRunItem = Extract<
  ReturnType<typeof coalesceActivityRuns>[number],
  { kind: "activity-run" }
>;

// Inbound context blocks are stamped with the provenance marker; strippers key
// on the marker, so display fixtures must carry it to be recognized.
const SENDER_METADATA_BLOCK = `${markInboundContextLabel("Sender:")}\n\`\`\`json\n{"label":"openclaw-control-ui","id":"openclaw-control-ui"}\n\`\`\``;

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

function chatMessage(
  role: string,
  content: unknown,
  timestamp?: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role,
    content,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...overrides,
  };
}

function userMessage(
  content: unknown,
  timestamp?: number,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return chatMessage("user", content, timestamp, overrides);
}

function assistantMessage(
  content: unknown,
  timestamp?: number,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return chatMessage("assistant", content, timestamp, overrides);
}

function toolUseMessage(
  id: string,
  name: string,
  input: unknown,
  timestamp: number,
): Record<string, unknown> {
  return assistantMessage([{ type: "tool_use", id, name, input }], timestamp);
}

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: unknown,
  timestamp: number,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return chatMessage("toolResult", content, timestamp, { toolCallId, toolName, ...overrides });
}

function toolMessage(
  toolCallId: string,
  toolName: string,
  content: unknown,
  timestamp: number,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return chatMessage("tool", content, timestamp, { toolCallId, toolName, ...overrides });
}

function queuedSend(
  id: string,
  text: string,
  createdAt: number,
  sendState: ChatQueueItem["sendState"],
  overrides: Partial<ChatQueueItem> = {},
): ChatQueueItem {
  return { id, text, createdAt, sendState, ...overrides };
}

function compactionMessage(id: string, metrics: Record<string, unknown> = {}) {
  return {
    role: "system",
    timestamp: 2_000,
    __openclaw: { kind: "compaction", id, ...metrics },
  };
}

function resetMessage(id: string) {
  return {
    role: "system",
    timestamp: 2_000,
    __openclaw: { kind: "reset", id },
  };
}

function canvasToolOutput(viewId: string, title: string, preferredHeight: number): string {
  return JSON.stringify({
    kind: "canvas",
    view: {
      backend: "canvas",
      id: viewId,
      url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
      title,
      preferred_height: preferredHeight,
    },
    presentation: { target: "assistant_message" },
  });
}

function commentaryMessage(content: string, timestamp: number, itemId: string) {
  return assistantMessage(content, timestamp, {
    openclawStreamFallback: {
      replacementText: content,
      source: "segment",
      itemId,
    },
  });
}

function messageGroups(props: Partial<CachedChatItemsProps>): MessageGroup[] {
  return buildCachedChatItems(createProps(props)).filter((item) => item.kind === "group");
}

function firstMessageContent(group: MessageGroup): unknown[] {
  const message = group.messages[0]?.message as { content?: unknown };
  return Array.isArray(message.content) ? message.content : [];
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");

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

describe("assistant commentary grouping", () => {
  it("keeps user before assistant when the assistant timestamp lags the user timestamp", () => {
    // Regression for #112943: Gateway clock can lag behind the browser clock,
    // giving the assistant reply an earlier timestamp than the user prompt.
    // Stable transcript rows must stay in insertion order; only tool/stream
    // items get reordered by timestamp.
    const groups = messageGroups({
      messages: [userMessage("User prompt", 2_000), assistantMessage("Server reply.", 1_000)],
    });

    expect(groups.map((group) => group.role)).toEqual(["user", "assistant"]);
  });

  it("keeps a skewed live tool below its user boundary when it becomes stable", () => {
    const paneId = "clock-skew-tool-transition";
    const user = userMessage("User prompt", 2_000);
    const tool = toolResultMessage("call-clock-skew", "shell", "Tool output", 1_000, {
      runId: "run-active",
    });
    const liveGroups = messageGroups({
      paneId,
      runId: "run-active",
      messages: [user],
      toolMessages: [tool],
    });
    const stableGroups = messageGroups({ paneId, messages: [user, tool], toolMessages: [] });

    expect(liveGroups.map((group) => group.role)).toEqual(["user", "tool"]);
    expect(stableGroups.map((group) => group.role)).toEqual(["user", "tool"]);
    resetChatThreadState(paneId);
  });

  it("keeps current live work above a future queued user turn when it becomes stable", () => {
    const paneId = "clock-skew-future-queue-transition";
    const activeUser = userMessage("Active prompt", 2_000, {
      __openclaw: { idempotencyKey: "run-active:user" },
    });
    const liveTool = toolResultMessage("call-active", "shell", "Current tool output", 1_000, {
      runId: "run-active",
    });
    const activeSend = queuedSend("active-send", "Active prompt", 2_000, "waiting-model", {
      sendRunId: "run-active",
      sendSubmittedAtMs: 10,
    });
    const futureSend = queuedSend("future-send", "Future prompt", 3_000, "waiting-reconnect", {
      sendAttempts: 1,
      sendRunId: "run-future",
    });
    const liveGroups = messageGroups({
      paneId,
      runId: "run-active",
      queue: [activeSend, futureSend],
      toolMessages: [liveTool],
    });
    const stableGroups = messageGroups({
      paneId,
      messages: [activeUser, liveTool],
      queue: [futureSend],
      toolMessages: [],
    });

    expect(liveGroups.map((group) => group.role)).toEqual(["user", "tool", "user"]);
    expect(stableGroups.map((group) => group.role)).toEqual(["user", "tool", "user"]);
    resetChatThreadState(paneId);
  });

  it("keeps an active stream above a future queued user turn when it becomes stable", () => {
    const paneId = "clock-skew-stream-queue-transition";
    const activeUser = userMessage("Active prompt", 2_000, {
      __openclaw: { idempotencyKey: "run-active:user" },
    });
    const activeSend = queuedSend("active-send", "Active prompt", 2_000, "waiting-model", {
      sendRunId: "run-active",
      sendSubmittedAtMs: 10,
    });
    const futureSend = queuedSend("future-send", "Future prompt", 3_000, "waiting-reconnect", {
      sendAttempts: 1,
      sendRunId: "run-future",
    });
    const liveItems = buildCachedChatItems(
      createProps({
        paneId,
        queue: [activeSend, futureSend],
        stream: "Current partial reply",
        streamStartedAt: 1_000,
      }),
    );
    const stableItems = buildCachedChatItems(
      createProps({
        paneId,
        messages: [activeUser, assistantMessage("Current partial reply", 1_000)],
        queue: [futureSend],
      }),
    );
    const visibleKinds = (items: ReturnType<typeof buildCachedChatItems>) =>
      items.map((item) => (item.kind === "group" ? item.role : item.kind));

    expect(visibleKinds(liveItems)).toEqual(["user", "stream", "user"]);
    expect(visibleKinds(stableItems)).toEqual(["user", "assistant", "user"]);
    resetChatThreadState(paneId);
  });

  it("keeps current-run segments below their user boundary under clock skew", () => {
    const items = buildCachedChatItems(
      createProps({
        runId: "run-active",
        messages: [userMessage("Current prompt", 2_000)],
        streamSegments: [{ text: "Current progress", ts: 1_000, runId: "run-active" }],
      }),
    );

    expect(items.map((item) => (item.kind === "group" ? item.role : item.kind))).toEqual([
      "user",
      "stream",
    ]);
  });

  it("keeps same-run commentary on its causal side of a persisted steer", () => {
    const items = buildCachedChatItems(
      createProps({
        runId: "run-active",
        messages: [
          userMessage("Original prompt", 1_000, {
            __openclaw: {
              id: "original-user",
              seq: 1,
              idempotencyKey: "run-active:user",
            },
          }),
          userMessage("Please run autoreview here", 3_000, {
            __openclaw: {
              id: "steering-user",
              seq: 2,
              idempotencyKey: "steer-send:user",
            },
          }),
        ],
        streamSegments: [
          {
            text: "First progress update",
            ts: 2_000,
            runId: "run-active",
            itemId: "preamble-a",
          },
          {
            text: "Autoreview is running",
            ts: 4_000,
            runId: "run-active",
            itemId: "preamble-b",
          },
        ],
      }),
    );

    expect(items).toMatchObject([
      {
        kind: "group",
        role: "user",
        messages: [{ message: { content: "Original prompt" } }],
      },
      { kind: "stream", text: "First progress update" },
      {
        kind: "group",
        role: "user",
        messages: [{ message: { content: "Please run autoreview here" } }],
      },
      { kind: "stream", text: "Autoreview is running" },
    ]);
  });

  it("keeps replayed tool and commentary items inside their older turn", () => {
    const items = buildCachedChatItems(
      createProps({
        runId: "run-current",
        messages: [
          userMessage("Earlier prompt", 1_000, {
            __openclaw: { idempotencyKey: "run-earlier:user" },
          }),
          assistantMessage("Earlier reply", 1_300),
          userMessage("Current prompt", 2_000, {
            __openclaw: { idempotencyKey: "run-current:user" },
          }),
        ],
        streamSegments: [
          { text: "Earlier commentary", ts: 500, runId: "run-earlier", itemId: "earlier" },
          { text: "Current commentary", ts: 1_200, runId: "run-current", itemId: "current" },
        ],
        toolMessages: [
          toolResultMessage("call-earlier", "shell", "Earlier tool output", 3_000, {
            runId: "run-earlier",
          }),
        ],
      }),
    );

    expect(items.map((item) => (item.kind === "group" ? item.role : item.kind))).toEqual([
      "user",
      "stream",
      "assistant",
      "tool",
      "user",
      "stream",
    ]);
  });

  it("keeps unmatched legacy replay rows timestamped across older turns", () => {
    const items = buildCachedChatItems(
      createProps({
        runId: "run-current",
        messages: [
          userMessage("First prompt", 1_000),
          assistantMessage("First reply", 1_300),
          userMessage("Second prompt", 2_000),
          assistantMessage("Second reply", 2_300),
          userMessage("Current prompt", 3_000),
        ],
        toolMessages: [
          toolResultMessage("call-legacy", "shell", "Legacy tool output", 1_100, {
            runId: "legacy-unmatched-run",
          }),
        ],
      }),
    );

    expect(items.map((item) => (item.kind === "group" ? item.role : item.kind))).toEqual([
      "user",
      "tool",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("keeps a reconnecting current prompt above its retained stream", () => {
    const paneId = "clock-skew-reconnecting-current-turn";
    const reconnectingSend = queuedSend(
      "reconnecting-send",
      "Current prompt",
      2_000,
      "waiting-reconnect",
      {
        sendAttempts: 1,
        sendRunId: "run-active",
      },
    );
    const items = buildCachedChatItems(
      createProps({
        paneId,
        runId: "run-active",
        queue: [reconnectingSend],
        stream: "Retained partial reply",
        streamStartedAt: 1_000,
      }),
    );

    expect(items.map((item) => (item.kind === "group" ? item.role : item.kind))).toEqual([
      "user",
      "stream",
    ]);
    resetChatThreadState(paneId);
  });

  it("keeps a restored reconnect prompt above its active server tool projection", () => {
    const reconnectingSend = queuedSend(
      "reconnecting-send",
      "Current prompt",
      2_000,
      "waiting-reconnect",
      {
        sendAttempts: 1,
        sendRunId: "run-restored",
      },
    );
    const runId = resolveChatProjectionRunId({
      activeRunIds: ["run-restored"],
      queue: [reconnectingSend],
    });
    const items = buildCachedChatItems(
      createProps({
        runId,
        queue: [reconnectingSend],
        toolMessages: [
          toolResultMessage("call-restored", "shell", "Restored tool output", 1_000, {
            runId: "run-restored",
          }),
        ],
      }),
    );

    expect(items.map((item) => (item.kind === "group" ? item.role : item.kind))).toEqual([
      "user",
      "tool",
    ]);
  });

  it("keeps a queued current prompt before a terminal delivered ahead of its ACK", () => {
    const paneId = "terminal-before-send-ack";
    const terminal = rememberLiveTerminalRun(
      assistantMessage("Terminal reply", 1_000),
      "run-active",
    );
    const sending = queuedSend("sending-current", "Current prompt", 2_000, "sending", {
      sendAttempts: 1,
      sendRunId: "run-active",
    });
    const liveItems = buildCachedChatItems(
      createProps({ paneId, runId: "run-active", messages: [terminal], queue: [sending] }),
    );
    const stableItems = buildCachedChatItems(
      createProps({
        paneId,
        messages: [
          userMessage("Current prompt", 2_000, {
            __openclaw: { idempotencyKey: "run-active:user" },
          }),
          terminal,
        ],
      }),
    );
    const roles = (items: ReturnType<typeof buildCachedChatItems>) =>
      items.filter((item) => item.kind === "group").map((item) => item.role);

    expect(roles(liveItems)).toEqual(["user", "assistant"]);
    expect(roles(stableItems)).toEqual(["user", "assistant"]);
    resetChatThreadState(paneId);
  });

  it("keeps keyed commentary separate from the terminal assistant reply", () => {
    const groups = messageGroups({
      messages: [
        userMessage("do it", 1_000),
        commentaryMessage("Checking the workspace.", 2_000, "preamble-1"),
        commentaryMessage("Inspecting the result.", 3_000, "preamble-2"),
        assistantMessage("All done.", 4_000),
      ],
    });

    expect(groups.map((group) => group.role)).toEqual(["user", "assistant", "assistant"]);
    expect(groupAt(groups, 1).messages).toHaveLength(2);
    expect(groupAt(groups, 2).messages).toHaveLength(1);
  });

  it("hides durable commentary when the display preference is disabled", () => {
    const paneId = "commentary-visibility";
    const messages = [
      userMessage("do it", 1_000),
      commentaryMessage("Checking the workspace.", 2_000, "preamble-1"),
      assistantMessage("All done.", 3_000),
    ];

    const visible = buildCachedChatItems(createProps({ paneId, messages }));
    const hidden = buildCachedChatItems(
      createProps({ paneId, messages, persistCommentary: false }),
    );
    const restored = buildCachedChatItems(createProps({ paneId, messages }));

    expect(visible.filter((item) => item.kind === "group")).toHaveLength(3);
    expect(hidden.filter((item) => item.kind === "group")).toHaveLength(2);
    expect(restored.filter((item) => item.kind === "group")).toHaveLength(3);
    expect(messages).toHaveLength(3);
    resetChatThreadState(paneId);
  });
});

describe("collapseCompletedTurnWork", () => {
  const collapsedItems = (props: Partial<CachedChatItemsProps>, runWorking = false) =>
    collapseCompletedTurnWork(coalesceStreamRuns(buildCachedChatItems(createProps(props))), {
      sessionKey: "agent:main:dashboard:test-session",
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
        userMessage("do it", 1_000),
        assistantMessage("Checking…", 2_000),
        toolResult("call-1", 3_000),
        assistantMessage("All done.", 10_000),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(["group", "work-group", "group"]);
    const work = requireWorkGroup(items[1]);
    expect(work.groups).toHaveLength(2);
    expect(work.durationMs).toBe(9_000);
    expect(requireGroup(items[2]).role).toBe("assistant");
  });

  it.each([
    "agent:main:main",
    "agent:main:telegram:direct:42",
    "agent:main::dashboard:malformed",
    "agent:main:dashboard:session:extra",
  ])("keeps completed work expanded for non-dashboard session %s", (sessionKey) => {
    const items = coalesceStreamRuns(
      buildCachedChatItems(
        createProps({
          sessionKey,
          messages: [
            userMessage("do it", 1_000),
            assistantMessage("Checking…", 2_000),
            toolResult("call-1", 3_000),
            assistantMessage("All done.", 10_000),
          ],
        }),
      ),
    );

    const rendered = collapseCompletedTurnWork(items, { sessionKey, runWorking: false });

    expect(rendered.map((item) => item.kind)).toEqual(["group", "group", "group", "group"]);
  });

  it("keeps the trailing turn expanded while the run works", () => {
    const items = collapsedItems(
      {
        runWorking: true,
        messages: [userMessage("do it", 1_000), toolResult("call-1", 2_000)],
      },
      true,
    );

    expect(items.some((item) => item.kind === "work-group")).toBe(false);
  });

  it("keeps reply-less turns expanded after the run finishes", () => {
    const messages = [userMessage("do it", 1_000), toolResult("call-1", 2_000)];

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
      messages: [userMessage("go", 1_000), toolResult("call-1", 2_000, true)],
    });

    expect(items.map((item) => item.kind)).toEqual(["group", "group"]);
    expect(requireGroup(items[1]).role).toBe("tool");
  });

  it("collapses failed work once the turn recovered with a reply", () => {
    const items = collapsedItems({
      messages: [
        userMessage("go", 1_000),
        toolResult("call-1", 2_000, true),
        assistantMessage("Recovered via another route.", 3_000),
      ],
    });

    expect(requireWorkGroup(items[1]).groups).toHaveLength(1);
  });

  it("keeps work after the final reply visible", () => {
    const items = collapsedItems({
      messages: [
        userMessage("go", 1_000),
        toolResult("call-1", 2_000),
        assistantMessage("Done.", 3_000),
        toolResult("call-2", 4_000),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(["group", "work-group", "group", "group"]);
    expect(requireGroup(items[3]).role).toBe("tool");
  });

  it("does not collapse across dividers", () => {
    const items = collapsedItems({
      messages: [
        userMessage("go", 1_000),
        toolResult("call-1", 2_000),
        {
          role: "system",
          content: "",
          timestamp: 3_000,
          __openclaw: { kind: "compaction", id: "c1" },
        },
        assistantMessage("Done.", 4_000),
      ],
    });

    expect(items.some((item) => item.kind === "work-group")).toBe(false);
    expect(items.some((item) => item.kind === "divider")).toBe(true);
  });

  it("keeps attachment-only final replies outside the work rollup", () => {
    const items = collapsedItems({
      messages: [
        userMessage("render it", 1_000),
        toolResult("call-1", 2_000),
        assistantMessage(
          [
            {
              type: "image",
              url: "/media/screenshot.png",
              source: { type: "url", url: "/media/screenshot.png" },
            },
          ],
          3_000,
        ),
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
              userMessage("do it", 1_000),
              toolResult("call-1", 2_000),
              assistantMessage("All done.", 3_000),
            ],
            searchOpen: true,
            searchQuery: "ok",
          }),
        ),
      ),
      {
        sessionKey: "agent:main:dashboard:test-session",
        runWorking: false,
        searchActive: true,
      },
    );

    expect(items.some((item) => item.kind === "work-group")).toBe(false);
  });

  it("collapses each completed turn independently", () => {
    const items = collapsedItems({
      messages: [
        userMessage("first", 1_000),
        toolResult("call-1", 2_000),
        assistantMessage("First done.", 3_000),
        userMessage("second", 4_000),
        toolResult("call-2", 5_000),
        assistantMessage("Second done.", 6_000),
      ],
    });

    const workGroups = items.filter((item) => item.kind === "work-group");
    expect(workGroups).toHaveLength(2);
    expect(new Set(workGroups.map((item) => item.key)).size).toBe(2);
  });

  it("keeps recovery work separate when a system notice starts the next turn", () => {
    const items = collapsedItems({
      messages: [
        userMessage("first", 1_000),
        toolResult("call-1", 2_000),
        assistantMessage("First done.", 3_000),
        userMessage("[System] Continue the interrupted turn.", 4_000, {
          provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
        }),
        toolResult("call-2", 5_000),
        assistantMessage("Recovery done.", 6_000),
      ],
    });

    const workGroups = items.filter((item) => item.kind === "work-group");
    expect(workGroups).toHaveLength(2);
    expect(workGroups.map((item) => messageRecord(groupAt(item.groups, 0)).toolCallId)).toEqual([
      "call-1",
      "call-2",
    ]);
  });

  it("collapses hidden-input runs independently without changing duration arithmetic", () => {
    const items = collapsedItems({
      messages: [
        {
          ...toolResult("call-1", 1_000),
          __openclaw: { id: "work-1", seq: 1, turnBoundary: true },
        },
        assistantMessage("First run done.", 3_000, {
          __openclaw: { id: "reply-1", seq: 2 },
        }),
        {
          ...toolResult("call-2", 4_000),
          __openclaw: { id: "work-2", seq: 3, turnBoundary: true },
        },
        assistantMessage("Second run done.", 9_000, {
          __openclaw: { id: "reply-2", seq: 4 },
        }),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(["work-group", "group", "work-group", "group"]);
    expect(requireWorkGroup(items[0]).durationMs).toBe(2_000);
    expect(requireWorkGroup(items[2]).durationMs).toBe(5_000);
  });

  it("keeps a completed-work row keyed to its final reply as older work is prepended", () => {
    resetChatThreadState();
    const finalReply = assistantMessage("Done.", 3_000, {
      __openclaw: { id: "final-reply", seq: 3 },
    });
    const initial = collapsedItems({
      messages: [toolResult("call-1", 2_000), finalReply],
    });
    const initialWork = requireWorkGroup(initial[0]);

    const prepended = collapsedItems({
      messages: [
        assistantMessage("Checking.", 1_000, {
          __openclaw: { id: "older-commentary", seq: 1 },
        }),
        toolResult("call-1", 2_000),
        finalReply,
      ],
    });
    const prependedWork = requireWorkGroup(prepended[0]);

    expect(prependedWork.key).toBe(initialWork.key);
    expect(prependedWork.durationMs).toBeGreaterThan(initialWork.durationMs ?? 0);
  });
});

describe("coalesceActivityRuns", () => {
  const toolResult = (id: string, timestamp: number, overrides: Record<string, unknown> = {}) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: "ok",
    timestamp,
    ...overrides,
  });

  const projectedToolGroups = () =>
    buildCachedChatItems(
      createProps({
        paneId: "activity-run-projection",
        messages: [
          toolResult("call-1", 1_000, {
            __openclaw: { id: "tool-1", seq: 1, turnBoundary: true },
          }),
          toolResult("call-2", 2_000, {
            __openclaw: { id: "tool-2", seq: 2, turnBoundary: true },
          }),
          toolResult("call-3", 3_000, {
            __openclaw: { id: "tool-3", seq: 3, turnBoundary: true },
          }),
        ],
      }),
    ).filter((item): item is MessageGroup => item.kind === "group");

  function requireActivityRun(value: unknown): ActivityRunItem {
    expect(requireRecord(value).kind).toBe("activity-run");
    return value as ActivityRunItem;
  }

  it("combines projected-turn tool groups without rewriting their order or messages", () => {
    const groups = projectedToolGroups();
    const projected = coalesceActivityRuns(groups.slice(0, 2));
    const run = requireActivityRun(projected[0]);

    expect(projected).toHaveLength(1);
    expect(run.groups).toEqual([groups[0], groups[1]]);
    expect(run.groups[0]).toBe(groups[0]);
    expect(run.groups[1]).toBe(groups[1]);
    expect(run.groups.flatMap((group) => group.messages.map((entry) => entry.key))).toEqual(
      groups.slice(0, 2).flatMap((group) => group.messages.map((entry) => entry.key)),
    );
  });

  it("keeps the first-group key stable when live tool groups append", () => {
    const groups = projectedToolGroups();
    const initial = requireActivityRun(coalesceActivityRuns(groups.slice(0, 2))[0]);
    const appended = requireActivityRun(coalesceActivityRuns(groups)[0]);

    expect(initial.key).toBe(`activity:${groups[0]?.key}`);
    expect(appended.key).toBe(initial.key);
  });

  it("treats every non-tool item as a hard presentation boundary", () => {
    const groups = projectedToolGroups();
    const userBoundary: MessageGroup = {
      kind: "group",
      key: "group:user:boundary",
      role: "user",
      messages: [{ key: "user:boundary", message: userMessage("stop", 4_000) }],
      timestamp: 4_000,
      isStreaming: false,
    };
    const divider = {
      kind: "divider" as const,
      key: "divider:boundary",
      label: "Boundary",
      timestamp: 5_000,
    };
    const projected = coalesceActivityRuns([
      groups[0]!,
      userBoundary,
      groups[1]!,
      divider,
      groups[2]!,
    ]);

    expect(projected).toEqual([groups[0], userBoundary, groups[1], divider, groups[2]]);
  });

  it("leaves a single tool group unchanged and disables projection during search", () => {
    const groups = projectedToolGroups();
    const singleton = coalesceActivityRuns([groups[0]!]);
    const searchInput = groups.slice(0, 2);

    expect(singleton[0]).toBe(groups[0]);
    expect(coalesceActivityRuns(searchInput, { searchActive: true })).toBe(searchInput);
  });
});

describe("buildCachedChatItems row identity", () => {
  it("keeps an accepted initial send key across local-to-history replacement", () => {
    resetChatThreadState();
    const initial = groupAt(
      messageGroups({
        messages: [
          {
            __openclaw: { idempotencyKey: "initial-send:user", seq: 1 },
            role: "user",
            content: "Initial image prompt",
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
            __openclaw: {
              id: "persisted-user-message",
              idempotencyKey: "initial-send:user",
              seq: 1,
            },
            role: "user",
            content: "Initial image prompt",
            timestamp: 2,
          },
        ],
      }),
      0,
    );

    expect(messageAt(reconciled, 0).key).toBe(messageAt(initial, 0).key);
  });

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
  const readingIndicator = (props: Partial<CachedChatItemsProps>) =>
    buildCachedChatItems(createProps(props)).find((item) => item.kind === "reading-indicator");
  const hasReadingIndicator = (props: Partial<CachedChatItemsProps>) =>
    readingIndicator(props) !== undefined;
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

  it("adds the plan to the active stream run and removes it when the run stops", () => {
    const planStatus = {
      steps: [{ step: "Inspect the route", status: "in_progress" as const }],
    };
    const activeItems = buildCachedChatItems(
      createProps({ runActive: true, runWorking: true, planStatus }),
    );

    expect(coalesceStreamRuns(activeItems)).toMatchObject([
      { kind: "stream-run", parts: [{ kind: "reading-indicator" }, { kind: "plan" }] },
    ]);

    const idleItems = buildCachedChatItems(
      createProps({ runActive: false, runWorking: false, planStatus }),
    );
    expect(idleItems.some((item) => item.kind === "plan")).toBe(false);
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

  it("keeps one working row from optimistic send through acknowledgement", () => {
    resetChatThreadState();
    const sessionKey = "agent:main:working-row";
    const pendingItems = buildCachedChatItems(
      createProps({
        sessionKey,
        queue: [
          {
            id: "queued-send-1",
            text: "keep the row stable",
            createdAt: 1_000,
            sendRunId: "run-1",
            sendState: "sending",
            sendSubmittedAtMs: 10,
          },
        ],
        runWorking: true,
      }),
    );
    const pendingIndicator = expectDefined(
      pendingItems.find((item) => item.kind === "reading-indicator"),
      "pending working indicator",
    );
    const pendingRun = expectDefined(
      coalesceStreamRuns(pendingItems).find((item) => item.kind === "stream-run"),
      "pending stream run",
    );

    const acknowledgedItems = buildCachedChatItems(
      createProps({
        sessionKey,
        runId: "run-1",
        runWorking: true,
        stream: "",
        streamStartedAt: 2_000,
      }),
    );
    const acknowledgedIndicator = expectDefined(
      acknowledgedItems.find((item) => item.kind === "reading-indicator"),
      "acknowledged working indicator",
    );
    const acknowledgedRun = expectDefined(
      coalesceStreamRuns(acknowledgedItems).find((item) => item.kind === "stream-run"),
      "acknowledged stream run",
    );

    expect(acknowledgedIndicator).toMatchObject({
      key: pendingIndicator.key,
      startedAt: pendingIndicator.startedAt,
    });
    expect(acknowledgedRun.key).toBe(pendingRun.key);

    const streamingItems = buildCachedChatItems(
      createProps({
        sessionKey,
        runId: "run-1",
        runWorking: true,
        stream: "The reply has started.",
        streamStartedAt: 2_000,
      }),
    );
    const visibleStream = expectDefined(
      streamingItems.find((item) => item.kind === "stream" && item.isStreaming),
      "visible live stream",
    );
    const streamingIndicator = expectDefined(
      streamingItems.find((item) => item.kind === "reading-indicator"),
      "streaming working indicator",
    );
    const streamingRun = expectDefined(
      coalesceStreamRuns(streamingItems).find((item) => item.kind === "stream-run"),
      "streaming run",
    );

    expect(visibleStream.key).toBe(pendingIndicator.key);
    expect(streamingIndicator.key).toBe(pendingIndicator.key);
    expect(streamingRun).toMatchObject({
      key: pendingRun.key,
      parts: [{ kind: "stream" }, { kind: "reading-indicator" }],
    });

    const nextRunIndicator = expectDefined(
      readingIndicator({
        sessionKey,
        runId: "run-2",
        runWorking: true,
        stream: "",
        streamStartedAt: 3_000,
      }),
      "next run working indicator",
    );
    const otherSessionIndicator = expectDefined(
      readingIndicator({
        sessionKey: "agent:other:working-row",
        runId: "run-1",
        runWorking: true,
        stream: "",
        streamStartedAt: 2_000,
      }),
      "other session working indicator",
    );

    expect(nextRunIndicator.key).not.toBe(pendingIndicator.key);
    expect(otherSessionIndicator.key).not.toBe(pendingIndicator.key);
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
        messages: [assistantMessage("answer", 1)],
      }),
    ).toBe(true);
  });

  it("yields to the initial-load skeleton on an empty thread", () => {
    expect(hasReadingIndicator({ runWorking: true, loading: true })).toBe(false);
  });

  it("keeps the non-null empty-stream fallback during initial history loading", () => {
    expect(hasReadingIndicator({ stream: "", loading: true })).toBe(true);
  });

  it("does not suppress active telemetry once a live stream exists", () => {
    const items = buildCachedChatItems(
      createProps({ runWorking: true, loading: true, stream: "The reply has started." }),
    );

    expect(items.filter((item) => item.kind === "stream")).toHaveLength(1);
    expect(items.filter((item) => item.kind === "reading-indicator")).toHaveLength(1);
  });

  it("keeps the telemetry row beside a visible running tool", () => {
    expect(hasReadingIndicator({ runWorking: true, toolMessages: [liveTool(false)] })).toBe(true);
  });

  it("keeps the telemetry row once the running tool resolves", () => {
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
        userMessage("first", 1000, {
          senderLabel: "Iris",
          __openclaw: { senderId: "iris", senderName: "Iris" },
        }),
        userMessage("second", 1001, {
          senderLabel: "Joaquin De Rojas",
          __openclaw: { senderId: "joaquin", senderName: "Joaquin De Rojas" },
        }),
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.senderLabel)).toEqual(["Iris", "Joaquin De Rojas"]);
    expect(groups.map((group) => group.sender?.id)).toEqual(["iris", "joaquin"]);
  });

  it("renders non-compaction system messages as notices and skips empty output", () => {
    const items = buildCachedChatItems(
      createProps({
        messages: [
          { role: "system", content: "Command output\n  indented", timestamp: 1000 },
          { role: "system", content: "  \n", timestamp: 1001 },
        ],
      }),
    );

    expect(items).toEqual([
      {
        kind: "notice",
        key: expect.any(String),
        text: "Command output\n  indented",
        timestamp: 1000,
      },
    ]);
  });

  it("maps known system notices and preserves the generic fallback and search visibility", () => {
    const messages = [
      userMessage("before", 999),
      userMessage("[System] Continue the interrupted turn.", 1000, {
        provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
      }),
      userMessage("[System] Gateway restarted during update 2026.8.2 -> 2026.8.3.", 1001, {
        provenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
      }),
      userMessage("[System] Keep the raw fallback copy.", 1002, {
        provenance: { kind: "internal_system", sourceTool: "session-companion" },
      }),
      userMessage("after", 1003),
    ];
    const items = buildCachedChatItems(createProps({ messages }));

    expect(items.map((item) => item.kind)).toEqual([
      "group",
      "notice",
      "notice",
      "notice",
      "group",
    ]);
    expect(items[1]).toMatchObject({
      kind: "notice",
      icon: "cpu",
      label: "System · restart recovery",
      text: "Turn interrupted by a gateway restart — asked the agent to resume and finish the response.",
      timestamp: 1000,
    });
    // Summary-less kinds keep the producer's informative text under the label.
    expect(items[2]).toMatchObject({
      kind: "notice",
      icon: "cpu",
      label: "System · gateway restarted",
      text: "Gateway restarted during update 2026.8.2 -> 2026.8.3.",
      timestamp: 1001,
    });
    expect(items[3]).toMatchObject({
      kind: "notice",
      icon: "cpu",
      label: "System",
      text: "Keep the raw fallback copy.",
      timestamp: 1002,
    });

    const filtered = buildCachedChatItems(
      createProps({ messages, searchOpen: true, searchQuery: "after" }),
    );
    expect(filtered.some((item) => item.kind === "notice")).toBe(false);
  });

  it("attributes assistant groups to the latest user in multi-sender threads", () => {
    const groups = messageGroups({
      messages: [
        userMessage("Alice asks", 1000, {
          __openclaw: { senderId: "alice", senderName: "Alice" },
        }),
        assistantMessage("For Alice", 1001),
        userMessage("Bob asks", 1002, {
          __openclaw: { senderId: "bob", senderName: "Bob" },
        }),
        userMessage("Local follow-up", 1003),
        assistantMessage("For Bob", 1004),
      ],
    });

    const assistantGroups = groups.filter((group) => group.role === "assistant");
    expect(assistantGroups.map((group) => group.replyToSender)).toEqual([
      { id: "alice", name: "Alice" },
      undefined,
    ]);
  });

  it("does not add reply attribution in a single-sender thread", () => {
    const groups = messageGroups({
      messages: [
        userMessage("Alice asks", 1000, {
          __openclaw: { senderId: "alice", senderName: "Alice" },
        }),
        assistantMessage("For Alice", 1001),
      ],
    });

    expect(groups.find((group) => group.role === "assistant")?.replyToSender).toBeUndefined();
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
        assistantMessage("local reply", 1000),
        assistantMessage("forwarded report", 1001, {
          senderLabel: "Forwarded from main",
        }),
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.senderLabel)).toEqual([null, "Forwarded from main"]);
  });

  it("coalesces adjacent tool calls and results into one activity item", () => {
    const groups = messageGroups({
      messages: [
        toolUseMessage("call-shell", "bash", { command: "run openclaw doctor" }, 1000),
        toolResultMessage(
          "call-shell",
          "bash",
          [
            { type: "text", text: "Doctor complete" },
            { type: "image", data: "fixture-image", mimeType: "image/png" },
          ],
          1001,
          { isError: false },
        ),
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

  it("coalesces a native tool result that sorts before its call", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-native",
              name: "example_tool",
              arguments: { query: "example" },
            },
          ],
          timestamp: 2000,
        },
        {
          role: "toolResult",
          toolCallId: "call-native",
          toolName: "example_tool",
          content: [{ type: "text", text: "Native result" }],
          timestamp: 1000,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    const cards = extractToolCards(messageAt(groupAt(groups, 0), 0).message, "native-reversed");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      callId: "call-native",
      args: { query: "example" },
      outputText: "Native result",
    });
  });

  it("pairs earlier-sorted same-name tool results by call id", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "toolResult",
          toolCallId: "call-a",
          toolName: "read",
          content: [{ type: "text", text: "contents of a" }],
          timestamp: 1000,
        },
        {
          role: "toolResult",
          toolCallId: "call-b",
          toolName: "read",
          content: [{ type: "text", text: "contents of b" }],
          timestamp: 1001,
        },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } },
            { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
          ],
          timestamp: 1002,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    const cards = groupAt(groups, 0).messages.flatMap((entry, index) =>
      extractToolCards(entry.message, `native-same-name-${index}`),
    );
    expect(cards).toHaveLength(2);
    expect(cards.find((card) => card.callId === "call-a")).toMatchObject({
      args: { path: "a.ts" },
      outputText: "contents of a",
    });
    expect(cards.find((card) => card.callId === "call-b")).toMatchObject({
      args: { path: "b.ts" },
      outputText: "contents of b",
    });
  });

  it("pairs an earlier bundled result message with later calls", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-a", content: "contents of a" },
            { type: "tool_result", tool_use_id: "call-b", content: "contents of b" },
          ],
          timestamp: 1000,
        },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call-a", name: "read", input: { path: "a.ts" } },
            { type: "tool_use", id: "call-b", name: "read", input: { path: "b.ts" } },
          ],
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    const cards = extractToolCards(messageAt(groupAt(groups, 0), 0).message, "bundled-reversed");
    expect(cards.map((card) => [card.callId, card.args, card.outputText])).toEqual([
      ["call-a", { path: "a.ts" }, "contents of a"],
      ["call-b", { path: "b.ts" }, "contents of b"],
    ]);
  });

  it("preserves mixed content in an earlier bundled result message", () => {
    const mixedContent = [
      { type: "text", text: "Keep this explanation" },
      { type: "tool_result", tool_use_id: "call-a", content: "contents of a" },
      { type: "tool_result", tool_use_id: "call-b", content: "contents of b" },
    ];
    const groups = messageGroups({
      messages: [
        { role: "user", content: mixedContent, timestamp: 1000 },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call-a", name: "read", input: { path: "a.ts" } },
            { type: "tool_use", id: "call-b", name: "read", input: { path: "b.ts" } },
          ],
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    expect(firstMessageContent(groupAt(groups, 0))).toEqual(mixedContent);
  });

  it("coalesces interleaved parallel call/result pairs by call id", () => {
    const groups = messageGroups({
      messages: [
        toolUseMessage("call-a", "read", { path: "a.ts" }, 1000),
        toolUseMessage("call-b", "read", { path: "b.ts" }, 1001),
        toolResultMessage("call-a", "read", [{ type: "toolResult", text: "contents of a" }], 1002),
        toolResultMessage("call-b", "read", [{ type: "toolResult", text: "contents of b" }], 1003),
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
        toolUseMessage("call-x", "read", { path: "old.ts" }, 1000),
        toolUseMessage("call-x", "read", { path: "new.ts" }, 1001),
        toolResultMessage("call-x", "read", [{ type: "text", text: "new contents" }], 1002),
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
        ...Array.from({ length: 17 }, (_, index) =>
          toolUseMessage(`call-${index}`, "read", { path: `${index}.ts` }, 1000 + index),
        ),
        toolResultMessage("call-0", "read", [{ type: "text", text: "first contents" }], 1017),
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
        toolUseMessage("call-a", "read", { path: "a.ts" }, 1000),
        toolUseMessage("call-b", "read", { path: "b.ts" }, 1001),
        userMessage(
          [
            { type: "tool_result", tool_use_id: "call-a", content: "contents of a" },
            { type: "tool_result", tool_use_id: "call-b", content: "contents of b" },
          ],
          1002,
        ),
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
        assistantMessage(
          [
            { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
            { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } },
          ],
          1000,
        ),
        toolResultMessage("call-a", "read", [{ type: "text", text: "contents of a" }], 1001),
        toolResultMessage("call-b", "read", [{ type: "text", text: "contents of b" }], 1002),
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
        assistantMessage(
          [
            { type: "tool_use", id: "call-a", name: "read", input: { path: "a.ts" } },
            { type: "tool_use", id: "call-b", name: "read", input: { path: "b.ts" } },
          ],
          1000,
        ),
        userMessage(
          [
            { type: "tool_result", tool_use_id: "call-a", content: "contents of a" },
            { type: "tool_result", tool_use_id: "call-b", content: "contents of b" },
          ],
          1001,
        ),
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
        toolUseMessage("call-x", "read", { path: "x.ts" }, 1000),
        userMessage("never mind", 1001),
        toolResultMessage("call-x", "read", [{ type: "toolResult", text: "late result" }], 1002),
      ],
    });

    // Call and late result stay separate items around the user turn.
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.role)).toEqual(["tool", "user", "tool"]);
  });

  it("does not pair an earlier result across a user message boundary", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "toolResult",
          toolCallId: "call-x",
          toolName: "read",
          content: [{ type: "toolResult", text: "early result" }],
          timestamp: 1000,
        },
        { role: "user", content: "start a new turn", timestamp: 1001 },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-x", name: "read", input: { path: "x.ts" } }],
          timestamp: 1002,
        },
      ],
    });

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
        toolUseMessage("call-a", "bash", { command: "one" }, 1000),
        toolResultMessage("call-b", "bash", "Different call", 1001),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
  });

  it("keeps empty forwarded assistant display groups", () => {
    const groups = messageGroups({
      messages: [
        assistantMessage([{ type: "text", text: "" }], 1000, {
          senderLabel: "Forwarded from main",
        }),
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
        assistantMessage([{ type: "text", text: "Same update" }], 1),
        assistantMessage([{ type: "text", text: "Same update" }], 2),
        assistantMessage([{ type: "text", text: "Same update" }], 3),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(messageAt(groupAt(groups, 0), 0).duplicateCount).toBe(3);
  });

  it.each([
    {
      name: "deduplicates relay-labeled assistant copies by source message id",
      relayIdentity: { id: "reply-1" },
      nativeIdentity: { id: "reply-1" },
      relayText: "Parzival There it is.",
      nativeText: "There it is.",
    },
    {
      name: "deduplicates relay-labeled assistant copies by event messageId",
      relayIdentity: { messageId: "reply-2" },
      nativeIdentity: { messageId: "reply-2" },
      relayText: "Parzival Found it.",
      nativeText: "Found it.",
    },
    {
      name: "deduplicates relay-labeled assistant copies by OpenClaw transcript metadata id",
      relayIdentity: { __openclaw: { id: "reply-3" } },
      nativeIdentity: { __openclaw: { id: "reply-3" } },
      relayText: "Parzival On it.",
      nativeText: "On it.",
    },
    {
      name: "deduplicates relay-labeled assistant copies by OpenClaw metadata before surface ids",
      relayIdentity: { id: "relay-surface-copy", __openclaw: { id: "reply-4" } },
      nativeIdentity: { id: "native-surface-copy", __openclaw: { id: "reply-4" } },
      relayText: "Parzival Ship it.",
      nativeText: "Ship it.",
    },
  ])("$name", ({ relayIdentity, nativeIdentity, relayText, nativeText }) => {
    const groups = messageGroups({
      messages: [
        assistantMessage([{ type: "text", text: relayText }], 1, {
          ...relayIdentity,
          senderLabel: "Parzival",
        }),
        assistantMessage([{ type: "text", text: nativeText }], 2, nativeIdentity),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).senderLabel).toBeNull();
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "text", text: nativeText },
    ]);
  });

  it("keeps native assistant updates separate when source message id repeats with new text", () => {
    const groups = messageGroups({
      messages: [
        assistantMessage([{ type: "text", text: "Draft one" }], 1, {
          __openclaw: { id: "reply-5" },
        }),
        assistantMessage([{ type: "text", text: "Draft two" }], 2, {
          __openclaw: { id: "reply-5" },
        }),
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

  it.each([
    {
      name: "keeps formatting-only assistant updates separate for the same source message",
      id: "reply-formatted",
      relayText: "Parzival first\n\nsecond",
      nativeText: "first second",
    },
    {
      name: "keeps differently cased sender text separate for the same source message",
      id: "reply-case-change",
      relayText: "PARZIVAL answer",
      nativeText: "answer",
    },
  ])("$name", ({ id, relayText, nativeText }) => {
    const groups = messageGroups({
      messages: [
        assistantMessage([{ type: "text", text: relayText }], 1, {
          __openclaw: { id },
          senderLabel: "Parzival",
        }),
        assistantMessage([{ type: "text", text: nativeText }], 2, {
          __openclaw: { id },
        }),
      ],
    });

    expect(groups).toHaveLength(2);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "text", text: relayText },
    ]);
    expect(messageRecord(groupAt(groups, 1)).content).toStrictEqual([
      { type: "text", text: nativeText },
    ]);
  });

  it("keeps relay-labeled assistant updates separate when source message id repeats with new text", () => {
    const groups = messageGroups({
      messages: [
        assistantMessage([{ type: "text", text: "Parzival Draft one" }], 1, {
          __openclaw: { id: "reply-6" },
          senderLabel: "Parzival",
        }),
        assistantMessage([{ type: "text", text: "Parzival Draft two" }], 2, {
          __openclaw: { id: "reply-6" },
          senderLabel: "Parzival",
        }),
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
        assistantMessage([{ type: "text", text: "Same update" }], 1, {
          id: "reply-7",
          senderLabel: "Parzival",
        }),
        assistantMessage([{ type: "text", text: "Same update" }], 2, {
          id: "reply-8",
          senderLabel: "Parzival",
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    expect(messageAt(groupAt(groups, 0), 0).duplicateCount).toBeUndefined();
    expect(messageAt(groupAt(groups, 0), 1).duplicateCount).toBeUndefined();
  });

  it("keeps identical user prompts separate when canonical transcript identities differ", () => {
    const groups = messageGroups({
      messages: [
        {
          __openclaw: {
            id: "canonical-web-user",
            idempotencyKey: "web-same-text-run:user",
            seq: 1,
          },
          role: "user",
          content: [{ type: "text", text: "Both clients independently sent the same prompt." }],
          timestamp: 1,
        },
        {
          __openclaw: {
            id: "canonical-tui-user",
            idempotencyKey: "tui-same-text-run:user",
            seq: 2,
          },
          role: "user",
          content: [{ type: "text", text: "Both clients independently sent the same prompt." }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).role).toBe("user");
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    expect(messageRecord(groupAt(groups, 0), 0)["__openclaw"]).toMatchObject({
      id: "canonical-web-user",
    });
    expect(messageRecord(groupAt(groups, 0), 1)["__openclaw"]).toMatchObject({
      id: "canonical-tui-user",
    });
    expect(messageAt(groupAt(groups, 0), 0).duplicateCount).toBeUndefined();
    expect(messageAt(groupAt(groups, 0), 1).duplicateCount).toBeUndefined();
  });

  it("keeps imported prompts from distinct CLI sessions separate when provider IDs collide", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Imported clients sent the same prompt." }],
          timestamp: 1,
          __openclaw: {
            id: "provider-local-user",
            externalId: "provider-local-user",
            importedFrom: "claude-cli",
            cliSessionId: "first-cli-session",
            seq: 1,
          },
        },
        {
          role: "user",
          content: [{ type: "text", text: "Imported clients sent the same prompt." }],
          timestamp: 2,
          __openclaw: {
            id: "provider-local-user",
            externalId: "provider-local-user",
            importedFrom: "claude-cli",
            cliSessionId: "second-cli-session",
            seq: 2,
          },
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    expect(messageRecord(groupAt(groups, 0), 0)["__openclaw"]).toMatchObject({
      cliSessionId: "first-cli-session",
    });
    expect(messageRecord(groupAt(groups, 0), 1)["__openclaw"]).toMatchObject({
      cliSessionId: "second-cli-session",
    });
  });

  it("keeps a native prompt separate from a colliding imported provider ID", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Native and imported prompts coincide." }],
          timestamp: 1,
          __openclaw: { id: "colliding-user", seq: 1 },
        },
        {
          role: "user",
          content: [{ type: "text", text: "Native and imported prompts coincide." }],
          timestamp: 2,
          __openclaw: {
            id: "colliding-user",
            externalId: "colliding-user",
            importedFrom: "claude-cli",
            cliSessionId: "imported-cli-session",
            seq: 2,
          },
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    expect(messageRecord(groupAt(groups, 0), 0)["__openclaw"]).toEqual({
      id: "colliding-user",
      seq: 1,
    });
    expect(messageRecord(groupAt(groups, 0), 1)["__openclaw"]).toMatchObject({
      cliSessionId: "imported-cli-session",
    });
  });

  it("does not guess that incomplete imported source identities are duplicate prompts", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Incomplete imports can share provider IDs." }],
          timestamp: 1,
          __openclaw: {
            id: "incomplete-provider-user",
            externalId: "incomplete-provider-user",
            importedFrom: "claude-cli",
          },
        },
        {
          role: "user",
          content: [{ type: "text", text: "Incomplete imports can share provider IDs." }],
          timestamp: 2,
          __openclaw: {
            id: "incomplete-provider-user",
            externalId: "incomplete-provider-user",
            importedFrom: "claude-cli",
          },
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    expect(messageAt(groupAt(groups, 0), 0).duplicateCount).toBeUndefined();
    expect(messageAt(groupAt(groups, 0), 1).duplicateCount).toBeUndefined();
  });

  it("collapses a replay of the same canonical user prompt", () => {
    const metadata = {
      id: "canonical-replayed-user",
      idempotencyKey: "replayed-user-run:user",
      seq: 1,
    };
    const groups = messageGroups({
      messages: [
        {
          __openclaw: metadata,
          role: "user",
          content: [{ type: "text", text: "This prompt was delivered twice." }],
          timestamp: 1,
        },
        {
          __openclaw: { ...metadata },
          role: "user",
          content: [{ type: "text", text: "This prompt was delivered twice." }],
          timestamp: 2,
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).role).toBe("user");
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(messageAt(groupAt(groups, 0), 0).duplicateCount).toBe(2);
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
        assistantMessage([{ type: "text", text: "HEARTBEAT_OK" }], 1),
        assistantMessage("HEARTBEAT_OK", 2),
        userMessage([{ type: "text", text: "HEARTBEAT_OK" }], 3),
        assistantMessage([{ type: "text", text: "Visible reply" }], 4),
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
        assistantMessage(
          [
            { type: "thinking", thinking: "Checking scheduled work." },
            {
              type: "text",
              text: "HEARTBEAT_OK",
              textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
            },
          ],
          1,
        ),
        assistantMessage(
          [
            { id: "rs_1", type: "reasoning" },
            { type: "text", text: "HEARTBEAT_OK" },
          ],
          2,
        ),
        assistantMessage(
          [
            { type: "thinking", thinking: "Useful hidden reasoning." },
            { type: "text", text: "Visible reply" },
          ],
          3,
        ),
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
      messages: [assistantMessage([{ type: "text", text: "HEARTBEAT_OK" }, canvasBlock], 1)],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(canvasBlocksIn(groupAt(groups, 0))).toHaveLength(1);
  });

  it.each([
    {
      name: "suppresses active HEARTBEAT_OK streams before rendering",
      stream: "HEARTBEAT_OK",
    },
    {
      name: "suppresses active sender metadata streams before rendering",
      stream: SENDER_METADATA_BLOCK,
    },
  ])("$name", ({ stream }) => {
    const items = buildCachedChatItems(
      createProps({
        stream,
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

    expect(items).toMatchObject([
      {
        kind: "stream",
        text: "Visible reply",
        startedAt: 1,
        isStreaming: true,
      },
    ]);
  });

  it("keeps an unkeyed preamble from corrupting the accumulated prefix tracker", () => {
    // A standalone (itemId-less) preamble whose text is not part of the
    // cumulative run text must not become the prefix baseline — pre-fix the
    // next cumulative snapshot re-rendered every earlier segment's text.
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          { text: "First thought.", ts: 1, toolCallId: "call-1" },
          { text: "Standalone preamble", ts: 2 },
          { text: "First thought. After tool.", ts: 3, toolCallId: "call-2" },
        ],
        toolMessages: [
          chatMessage("toolResult", "Tool one", 2),
          chatMessage("toolResult", "Tool two", 4),
        ],
      }),
    );

    expect(items.filter((item) => item.kind === "stream")).toMatchObject([
      { text: "First thought." },
      { text: "Standalone preamble" },
      { text: "After tool." },
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
          chatMessage("toolResult", "Tool one", 2),
          chatMessage("toolResult", "Tool two", 4),
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
        toolMessages: [chatMessage("toolResult", "Tool output", 1)],
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
        toolMessages: [chatMessage("toolResult", "Tool output", 1)],
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
          chatMessage("toolResult", "First tool", 1),
          chatMessage("toolResult", "Second tool", 3),
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
        toolMessages: [toolResultMessage("call-read", "read", "file contents", 1_000)],
      }),
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "stream",
      text: "I will inspect the file.",
    });
    expect(messageRecord(requireGroup(items[1])).toolCallId).toBe("call-read");
  });

  it("renders one live card when active history contains the same tool call block", () => {
    const groups = messageGroups({
      runId: "run-live",
      messages: [
        userMessage("Read the file.", 1),
        assistantMessage(
          [
            { type: "text", text: "I will read it." },
            {
              type: "toolCall",
              id: "call-read",
              name: "read",
              arguments: { path: "README.md" },
            },
          ],
          2,
        ),
      ],
      toolMessages: [
        {
          role: "assistant",
          runId: "run-live",
          toolCallId: "call-read",
          content: [{ type: "toolcall", name: "read", arguments: { path: "README.md" } }],
          timestamp: 3,
        },
      ],
    });

    const cards = groups.flatMap((group, index) =>
      group.messages.flatMap((entry) => extractToolCards(entry.message, `restored-${index}`)),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ callId: "call-read", name: "read" });
    expect(
      groups.some((group) =>
        firstMessageContent(group).some((block) => requireRecord(block).text === "I will read it."),
      ),
    ).toBe(true);
  });

  it("keeps same-millisecond stream segments interleaved with their matching tool cards", () => {
    const items = buildCachedChatItems(
      createProps({
        streamSegments: [
          { text: "First tool.", ts: 2_000, toolCallId: "call-read" },
          { text: "First tool. Second tool.", ts: 2_000, toolCallId: "call-list" },
        ],
        toolMessages: [
          toolResultMessage("call-read", "read", "file contents", 1_000),
          toolResultMessage("call-list", "list", "file list", 1_000),
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
        toolMessages: [toolResultMessage("call-read", "read", "file contents", 1_000)],
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
        userMessage(SENDER_METADATA_BLOCK, 1, {
          senderLabel: "openclaw-control-ui",
        }),
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

  it("does not expose malformed tool stream entries to message rendering", () => {
    const items = buildCachedChatItems(
      createProps({
        toolMessages: [
          null,
          undefined,
          {
            role: "assistant",
            content: [{ type: "toolcall", name: "heartbeat_respond", arguments: {} }],
            timestamp: 1,
          },
        ],
      }),
    );

    const groups = items.filter((item) => item.kind === "group");
    expect(groups).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).role).toBe("assistant");
  });

  it("does not collapse duplicate text messages separated by another message", () => {
    const groups = messageGroups({
      messages: [
        assistantMessage([{ type: "text", text: "same" }], 1),
        userMessage([{ type: "text", text: "break" }], 2),
        assistantMessage([{ type: "text", text: "same" }], 3),
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
        assistantMessage([{ type: "text", text: "preview" }, canvasBlock], 1),
        assistantMessage([{ type: "text", text: "preview" }, canvasBlock], 2),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    expect(messageAt(groupAt(groups, 0), 0).duplicateCount).toBeUndefined();
  });

  it("orders live tool messages before newer history messages", () => {
    const groups = messageGroups({
      messages: [assistantMessage([{ type: "text", text: "Newer history reply." }], 2_000)],
      toolMessages: [toolMessage("call-older-tool", "shell", "Older live tool output.", 1_000)],
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
        messages: [assistantMessage([{ type: "text", text: "Newer history reply." }], 2_000)],
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
        messages: [userMessage([{ type: "text", text: "Persisted prompt." }], 2_000)],
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
      messages: [assistantMessage("Ready.", 1)],
      queue: [
        queuedSend("pending-send-1", "first visible send", 2, "sending", {
          sendSubmittedAtMs: 10,
          sender: { id: "alice@example.com", name: "Alice Example" },
        }),
      ],
    });

    expect(groups.map((group) => group.role)).toEqual(["assistant", "user"]);
    expect(groupAt(groups, 1).sender).toEqual({
      id: "alice@example.com",
      name: "Alice Example",
    });
    expect(messageRecord(groupAt(groups, 1)).content).toStrictEqual([
      { type: "text", text: "first visible send" },
    ]);
  });

  it("renders reply metadata on queued user turns before chat.send ACK", () => {
    const groups = messageGroups({
      messages: [assistantMessage("Ready.", 1)],
      queue: [
        queuedSend("pending-send-1", "follow up", 2, "sending", {
          replyToId: "transcript-123",
          sendSubmittedAtMs: 10,
        }),
      ],
    });

    expect(groupAt(groups, 1).messages[0]?.message).toMatchObject({
      __openclaw: { replyToId: "transcript-123" },
    });
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
        queuedSend("pending-attachment-send-1", "see attached", 2, "sending", {
          sendSubmittedAtMs: 10,
          attachments: [
            {
              id: "attachment-1",
              mimeType: "image/png",
              fileName: "screenshot.png",
              previewUrl: "/media/screenshot.png",
            },
          ],
        }),
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
      messages: [userMessage("same prompt", 1)],
      queue: [
        queuedSend("pending-send-1", "same prompt", 2, "sending", {
          sendSubmittedAtMs: 10,
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(2);
    expect(messageAt(groupAt(groups, 0), 0).duplicateCount).toBeUndefined();
    expect(messageAt(groupAt(groups, 0), 1).duplicateCount).toBeUndefined();
  });

  it("hides a pending send after history accepts its idempotency key", () => {
    const groups = messageGroups({
      messages: [
        userMessage("accepted prompt", 1, {
          __openclaw: { idempotencyKey: "accepted-run:user", seq: 1 },
        }),
      ],
      queue: [
        queuedSend("pending-send-1", "accepted prompt", 2, "sending", {
          sendRunId: "accepted-run",
          sendSubmittedAtMs: 10,
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0))["__openclaw"]).toMatchObject({
      idempotencyKey: "accepted-run:user",
      seq: 1,
    });
  });

  it("keeps failed queued sends out of the thread", () => {
    const groups = messageGroups({
      queue: [
        queuedSend("failed-send-1", "restore me to the composer", 1, "failed", {
          sendSubmittedAtMs: 10,
        }),
      ],
    });

    expect(groups).toStrictEqual([]);
  });

  it("filters submitted queued sends while chat search is active", () => {
    const groups = messageGroups({
      searchOpen: true,
      searchQuery: "matching",
      queue: [
        queuedSend("pending-send-1", "matching prompt", 1, "sending", {
          sendSubmittedAtMs: 10,
        }),
        queuedSend("pending-send-2", "unrelated prompt", 2, "sending", {
          sendSubmittedAtMs: 11,
        }),
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
        assistantMessage([{ type: "text", text: "First reply." }], 1_000, {
          id: "assistant-with-canvas",
        }),
        assistantMessage([{ type: "text", text: "Later unrelated reply." }], 2_000, {
          id: "assistant-without-canvas",
        }),
      ],
      toolMessages: [
        toolMessage(
          "call-canvas-old",
          "canvas_render",
          canvasToolOutput("cv_nearest_turn", "Nearest turn demo", 320),
          1_001,
          { id: "tool-canvas-for-first-reply" },
        ),
      ],
    });

    expect(canvasBlocksIn(groupAt(groups, 0))).toHaveLength(1);
    expect(canvasBlocksIn(groupAt(groups, 1))).toStrictEqual([]);
  });

  it("keeps a clock-skewed live App preview after the latest user boundary", () => {
    const groups = messageGroups({
      messages: [
        userMessage("Earlier request", 1_000),
        assistantMessage("Earlier response", 1_100),
        userMessage("Current request", 2_000),
      ],
      toolMessages: [
        { ...mcpAppResult("mcp-app-skewed", "call-skewed", 900), runId: "run-active" },
      ],
      runId: "run-active",
      showToolCalls: false,
    });

    expect(groups.map((group) => group.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(canvasBlocksIn(groupAt(groups, 1))).toStrictEqual([]);
    expect(canvasBlocksIn(groupAt(groups, 3))).toHaveLength(1);
  });

  it("keeps a live App preview in the recovery turn after a system notice", () => {
    const items = buildCachedChatItems(
      createProps({
        messages: [
          userMessage("Interrupted request", 1_000),
          assistantMessage("Interrupted reply", 2_000),
          userMessage("[System] Continue the interrupted turn.", 3_000, {
            provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
          }),
        ],
        toolMessages: [mcpAppResult("mcp-app-recovery", "call-recovery", 3_001)],
        showToolCalls: false,
      }),
    );

    expect(items.map((item) => (item.kind === "group" ? item.role : item.kind))).toEqual([
      "user",
      "assistant",
      "notice",
      "assistant",
    ]);
    const assistantGroups = items.filter(
      (item): item is MessageGroup => item.kind === "group" && item.role === "assistant",
    );
    expect(canvasBlocksIn(groupAt(assistantGroups, 0))).toStrictEqual([]);
    expect(canvasBlocksIn(groupAt(assistantGroups, 1))).toHaveLength(1);
  });

  it("keeps a live App preview on an assistant search match", () => {
    const groups = messageGroups({
      messages: [assistantMessage("Matching preview", 1_000)],
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
          userMessage("Show the App", 1_000),
          mcpAppResult("mcp-app-persisted-search", "call-persisted-search", 1_001),
          assistantMessage("Matching preview", 1_002),
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
        assistantMessage(SENDER_METADATA_BLOCK, 1_000, {
          id: "assistant-metadata-anchor",
        }),
      ],
      toolMessages: [
        toolMessage(
          "call-canvas-empty-anchor",
          "canvas_render",
          canvasToolOutput("cv_empty_anchor", "Empty anchor demo", 320),
          1_001,
          { id: "tool-canvas-for-empty-anchor" },
        ),
      ],
    });

    expect(
      groups.some((group) => firstMessageContent(group).some((block) => isCanvasBlock(block))),
    ).toBe(true);
  });

  it("creates an assistant anchor for a silent App turn", () => {
    const groups = messageGroups({
      messages: [
        userMessage("First request", 1_000),
        assistantMessage("First response", 1_001),
        userMessage("Show the App", 2_000),
      ],
      toolMessages: [mcpAppResult("mcp-app-silent", "call-silent", 2_001)],
      queue: [
        queuedSend("queued-next-turn", "Next request", 2_100, "sending", {
          sendSubmittedAtMs: 2_100,
        }),
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
      messages: [userMessage("Show the App", 1_000), userMessage("Next request", 2_000)],
      toolMessages: [mcpAppResult("mcp-app-earlier", "call-earlier", 1_001)],
      showToolCalls: false,
    });

    expect(groups.map((group) => group.role)).toEqual(["user", "assistant", "user"]);
    expect(canvasBlocksIn(groupAt(groups, 1))).toHaveLength(1);
  });

  it("places an App preview after its queued user prompt", () => {
    const groups = messageGroups({
      messages: [userMessage("First request", 1_000), assistantMessage("First response", 1_001)],
      queue: [
        queuedSend("queued-app-turn", "Show the App", 2_000, "waiting-model", {
          sendSubmittedAtMs: 2_000,
        }),
        queuedSend("queued-future-turn", "Later request", 2_001, "waiting-reconnect", {
          sendSubmittedAtMs: 2_001,
        }),
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
          userMessage("Show the App", 1_000),
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
      messages: [userMessage("Show the App", 1_000), result],
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
      messages: [userMessage("Show the App", 1_000), persisted],
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
      messages: [userMessage("First App", 1_000), first, userMessage("Second App", 2_000)],
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
        assistantMessage([{ type: "text", text: "Rendered the item inline." }], 1000, {
          id: "assistant-generic-inline",
        }),
      ],
      toolMessages: [
        toolMessage(
          "call-generic-inline",
          "plugin_card_details",
          JSON.stringify({
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
          1001,
          { id: "tool-generic-inline" },
        ),
      ],
    });

    expect(canvasBlocksIn(groupAt(groups, 0))).toStrictEqual([]);
  });

  it("lifts streamed canvas toolresult blocks into the assistant bubble", () => {
    const groups = messageGroups({
      messages: [
        assistantMessage([{ type: "text", text: "Done." }], 1000, {
          id: "assistant-streamed-artifact",
        }),
      ],
      toolMessages: [
        assistantMessage(
          [
            {
              type: "toolcall",
              name: "canvas_render",
              arguments: { source: { type: "handle", id: "cv_streamed_artifact" } },
            },
            {
              type: "toolresult",
              name: "canvas_render",
              text: canvasToolOutput("cv_streamed_artifact", "Streamed demo", 320),
            },
          ],
          999,
          {
            id: "tool-streamed-artifact",
            toolCallId: "call_streamed_artifact",
          },
        ),
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
        messages: [compactionMessage("checkpoint-1")],
      }),
    );

    expect(items).toHaveLength(1);
    const divider = requireRecord(items[0]);
    expect(divider.kind).toBe("divider");
    expect(divider.label).toBe("Compacted history");
    expect(divider.icon).toBe("foldVertical");
    expect(divider.description).toBe("The compacted transcript is preserved as a checkpoint.");
    const action = requireRecord(divider.action);
    expect(action.kind).toBe("session-checkpoints");
    expect(action.label).toBe("Open checkpoints");
  });

  it("shows the token savings recorded on a compaction boundary", () => {
    const items = buildCachedChatItems(
      createProps({
        messages: [
          compactionMessage("checkpoint-with-metrics", {
            tokensBefore: 900_000,
            tokensAfter: 24_700,
          }),
        ],
      }),
    );

    expect(items[0]).toMatchObject({
      kind: "divider",
      label: "Compacted history",
      metric: "saved 875.3k tokens",
    });
  });

  it("explains reset boundaries without compaction-only details", () => {
    const items = buildCachedChatItems(
      createProps({
        messages: [resetMessage("reset-1")],
      }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "divider",
      key: "divider:reset:reset-1",
      label: "Session reset",
      icon: "rotateCcw",
      description: "The earlier conversation was cleared.",
    });
    expect(items[0]).not.toHaveProperty("metric");
    expect(items[0]).not.toHaveProperty("action");
  });
});

describe("tool expansion state", () => {
  it("skips the tool-card walk when the item array identity is unchanged", () => {
    resetChatThreadState();
    const group: MessageGroup = {
      kind: "group",
      key: "assistant-stable",
      role: "assistant",
      messages: [
        {
          key: "assistant-stable",
          message: { role: "assistant", content: "No tools in this row" },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };
    const items = [group];
    const extractSpy = vi.spyOn(toolCards, "extractToolCardsCached");
    try {
      syncToolCardExpansionState("identity-stable", items, false);
      const callsAfterFirstSync = extractSpy.mock.calls.length;

      syncToolCardExpansionState("identity-stable", items, false);

      expect(callsAfterFirstSync).toBeGreaterThan(0);
      expect(extractSpy).toHaveBeenCalledTimes(callsAfterFirstSync);
    } finally {
      extractSpy.mockRestore();
    }
  });

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

describe("expansion-state render dependencies", () => {
  it("reads unchanged tool and user expansion maps without locale sorting", () => {
    resetChatThreadState();
    const tools = getExpandedToolCards("fast-session");
    const users = getExpandedUserMessages("fast-session");
    for (let index = 0; index < 128; index += 1) {
      setExpansionState(tools, `tool-${127 - index}`, index % 2 === 0);
      setExpansionState(users, `user-${127 - index}`, index % 2 === 0);
    }
    const compare = vi.spyOn(String.prototype, "localeCompare");
    try {
      for (let render = 0; render < 3; render += 1) {
        expect(getExpansionStateVersion(tools)).toBe(tools.size);
        expect(getExpansionStateVersion(users)).toBe(users.size);
      }
      expect(compare.mock.calls.length).toBe(0);
    } finally {
      compare.mockRestore();
    }
  });

  it("invalidates same-size toggles but keeps no-op updates stable", () => {
    resetChatThreadState();
    const cards = getExpandedToolCards("version-session");
    expect(getExpansionStateVersion(cards)).toBe(0);

    setExpansionState(cards, "card", false);
    const initializedVersion = getExpansionStateVersion(cards);
    expect(initializedVersion).toBe(1);

    setExpansionState(cards, "card", false);
    expect(getExpansionStateVersion(cards)).toBe(initializedVersion);

    setExpansionState(cards, "card", true);
    expect(getExpansionStateVersion(cards)).toBe(initializedVersion + 1);
    expect(getExpandedToolCards("version-session").size).toBe(1);
  });

  it("shares user-message render versions across equivalent session aliases", () => {
    resetChatThreadState();
    setExpansionState(getExpandedUserMessages("main"), "user-message", true);

    expect(getExpansionStateVersion(getExpandedUserMessages("main"))).toBe(1);
    expect(getExpansionStateVersion(getExpandedUserMessages("agent:main:main"))).toBe(1);

    setExpansionState(getExpandedUserMessages("agent:main:main"), "user-message", false);
    expect(getExpansionStateVersion(getExpandedUserMessages("main"))).toBe(2);
    expect(getExpandedUserMessages("main").get("user-message")).toBe(false);
  });

  it("keeps expanded disclosures while transcript search temporarily hides them", () => {
    resetChatThreadState();
    const sessionKey = "search-preserves-disclosures";
    const messages = [
      { role: "user", content: "hidden user prompt" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hidden assistant reply" },
          { type: "toolcall", id: "search-hidden-call", name: "browser.open" },
        ],
      },
      { role: "user", content: "needle" },
    ];
    const unfiltered = buildCachedChatItems(createProps({ sessionKey, messages }));
    syncToolCardExpansionState(sessionKey, unfiltered, false);
    const tools = getExpandedToolCards(sessionKey);
    const cardId = expectDefined(
      [...tools.keys()].find((key) => key.includes(":toolcard:")),
      "unfiltered transcript tool card",
    );
    setExpansionState(tools, cardId, true);
    const users = getExpandedUserMessages(sessionKey);
    const hiddenUserGroup = expectDefined(
      unfiltered.find(
        (item): item is MessageGroup => item.kind === "group" && item.role === "user",
      ),
      "unfiltered transcript user group",
    );
    const hiddenUserId = expectDefined(hiddenUserGroup.messages[0]?.key, "hidden user message");
    setExpansionState(users, hiddenUserId, true);

    const filtered = buildCachedChatItems(
      createProps({ sessionKey, messages, searchOpen: true, searchQuery: "needle" }),
    );
    expect(filtered).not.toBe(unfiltered);
    expect(filtered.every((item) => item.kind !== "group" || item.role !== "assistant")).toBe(true);
    syncToolCardExpansionState(sessionKey, filtered, false, true);

    expect(tools.get(cardId)).toBe(true);
    expect(users.get(hiddenUserId)).toBe(true);

    const restored = buildCachedChatItems(createProps({ sessionKey, messages }));
    syncToolCardExpansionState(sessionKey, restored, false);

    expect(tools.get(cardId)).toBe(true);
    expect(users.get(hiddenUserId)).toBe(true);
  });

  it("prunes cards removed during search when the same visible projection becomes complete", () => {
    resetChatThreadState();
    const sessionKey = "search-removes-hidden-card";
    const group = (key: string): MessageGroup => ({
      kind: "group",
      key,
      role: "assistant",
      messages: [
        {
          key,
          message: {
            role: "assistant",
            content: [{ type: "toolcall", id: `call-${key}`, name: "browser.open" }],
          },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    });
    const hidden = group("hidden-card");
    const visible = group("visible-card");
    const visibleProjection = [visible];
    syncToolCardExpansionState(sessionKey, [hidden, visible], false);
    const expanded = getExpandedToolCards(sessionKey);
    const hiddenCardId = "hidden-card:toolcard:0";
    setExpansionState(expanded, hiddenCardId, true);

    syncToolCardExpansionState(sessionKey, visibleProjection, false, true);
    expect(expanded.get(hiddenCardId)).toBe(true);
    const filteredVersion = getExpansionStateVersion(expanded);

    syncToolCardExpansionState(sessionKey, visibleProjection, false);

    expect(expanded.has(hiddenCardId)).toBe(false);
    expect(expanded.has("visible-card:toolcard:0")).toBe(true);
    expect(getExpansionStateVersion(expanded)).toBe(filteredVersion + 1);
  });

  it("auto-expands retained cards hidden while transcript search is active", () => {
    resetChatThreadState();
    const sessionKey = "search-auto-expands-hidden-cards";
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hidden assistant reply" },
          { type: "toolcall", id: "hidden-call", name: "browser.open" },
        ],
      },
      { role: "user", content: "another turn" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "needle visible reply" },
          { type: "toolcall", id: "visible-call", name: "browser.open" },
        ],
      },
    ];
    const complete = buildCachedChatItems(createProps({ sessionKey, messages }));
    syncToolCardExpansionState(sessionKey, complete, false);
    const expanded = getExpandedToolCards(sessionKey);
    const cardIds = [...expanded.keys()];
    const hiddenCardId = expectDefined(cardIds[0], "hidden retained card");
    const visibleCardId = expectDefined(cardIds[1], "visible retained card");

    const filtered = buildCachedChatItems(
      createProps({ sessionKey, messages, searchOpen: true, searchQuery: "needle" }),
    );
    syncToolCardExpansionState(sessionKey, filtered, false, true);
    expect(expanded.get(hiddenCardId)).toBe(false);
    expect(expanded.get(visibleCardId)).toBe(false);

    syncToolCardExpansionState(sessionKey, filtered, true, true);

    expect(expanded.get(hiddenCardId)).toBe(true);
    expect(expanded.get(visibleCardId)).toBe(true);
    syncToolCardExpansionState(
      sessionKey,
      buildCachedChatItems(createProps({ sessionKey, messages })),
      true,
    );
    expect(expanded.get(hiddenCardId)).toBe(true);
    expect(expanded.get(visibleCardId)).toBe(true);
  });

  it("prunes expansion state when a tool card leaves the transcript", () => {
    resetChatThreadState();
    const group: MessageGroup = {
      kind: "group",
      key: "assistant-pruned",
      role: "assistant",
      messages: [
        {
          key: "assistant-pruned",
          message: {
            role: "assistant",
            content: [{ type: "toolcall", id: "call-pruned", name: "browser.open" }],
          },
        },
      ],
      timestamp: 1,
      isStreaming: false,
    };
    syncToolCardExpansionState("prune-session", [group], false);
    const expanded = getExpandedToolCards("prune-session");
    expect(expanded.has("assistant-pruned:toolcard:0")).toBe(true);
    const populatedVersion = getExpansionStateVersion(expanded);

    syncToolCardExpansionState("prune-session", [], false);

    expect(expanded.has("assistant-pruned:toolcard:0")).toBe(false);
    expect(getExpansionStateVersion(expanded)).toBe(populatedVersion + 1);
  });

  it("drops render versions with evicted and reset session maps", () => {
    resetChatThreadState();
    const evicted = getExpandedToolCards("evicted-session");
    setExpansionState(evicted, "card", true);
    for (let index = 0; index < 20; index += 1) {
      getExpandedToolCards(`other-session-${index}`);
    }

    expect(getExpandedToolCards("evicted-session")).not.toBe(evicted);
    expect(getExpansionStateVersion(getExpandedToolCards("evicted-session"))).toBe(0);

    setExpansionState(getExpandedUserMessages("reset-session"), "message", true);
    resetChatThreadState();
    expect(getExpansionStateVersion(getExpandedUserMessages("reset-session"))).toBe(0);
  });
});

describe("user message expansion state", () => {
  it("keeps disclosure state per session and clears it with thread state", () => {
    resetChatThreadState();
    getExpandedUserMessages("main").set("user-message:one", true);

    expect(getExpandedUserMessages("main").get("user-message:one")).toBe(true);
    expect(getExpandedUserMessages("agent:main:main").get("user-message:one")).toBe(true);
    expect(getExpandedUserMessages("other").get("user-message:one")).toBeUndefined();

    resetChatThreadState();
    expect(getExpandedUserMessages("main").get("user-message:one")).toBeUndefined();
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

  it("rebuilds the live row when active stream identity changes", () => {
    resetChatThreadState();
    const first = buildCachedChatItems(
      createProps({
        runId: "run-1",
        stream: "first reply",
        streamStartedAt: 10,
      }),
    );
    const firstStream = expectDefined(
      first.find((item) => item.kind === "stream" && item.isStreaming),
      "first live stream",
    );

    const second = buildCachedChatItems(
      createProps({
        runId: "run-2",
        stream: "second reply",
        streamStartedAt: 20,
      }),
    );
    const secondStream = expectDefined(
      second.find((item) => item.kind === "stream" && item.isStreaming),
      "second live stream",
    );

    expect(second).not.toBe(first);
    expect(secondStream.key).not.toBe(firstStream.key);
    expect(secondStream).toMatchObject({ kind: "stream", startedAt: 20 });
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

  it("evicts the least-recently-used session after 20 cached transcripts", () => {
    resetChatThreadState();
    const paneId = "pane-lru";
    const firstInput = createProps({ paneId, sessionKey: "session-0" });
    const first = buildCachedChatItems(firstInput);
    for (let index = 1; index <= 20; index += 1) {
      buildCachedChatItems(createProps({ paneId, sessionKey: `session-${index}` }));
    }

    expect(buildCachedChatItems(firstInput)).not.toBe(first);
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
  return toolResultMessage(toolCallId, "demo__show", [{ type: "text", text: "ok" }], timestamp, {
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
  });
}

function mcpAppLiveResult(viewId: string, toolCallId: string, timestamp: number | undefined) {
  const persisted = mcpAppResult(viewId, toolCallId, timestamp ?? 0);
  return assistantMessage(
    [
      { type: "toolcall", name: "demo__show", arguments: {} },
      {
        type: "toolresult",
        name: "demo__show",
        text: "ok",
        details: persisted.details,
      },
    ],
    timestamp,
    {
      toolCallId,
      runId: "run-live",
      __openclawToolStreamLive: true,
      __openclawToolStreamResultReceived: true,
    },
  );
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
