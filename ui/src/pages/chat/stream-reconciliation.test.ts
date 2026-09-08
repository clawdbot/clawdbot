// @vitest-environment node
// Control UI tests cover stream reconciliation behavior.
import { describe, expect, it } from "vitest";
import {
  reconcileTerminalStreamBoundary,
  resolveCumulativeAssistantTail,
  rolloverChatStream,
} from "./stream-causal-boundary.ts";
import {
  appendTerminalAssistantMessage,
  historyReplacedVisibleStream,
  materializeVisibleStreamState,
  visibleAssistantStreamParts,
  visibleCurrentAssistantStreamTail,
} from "./stream-reconciliation.ts";
import {
  discardStreamSegmentIndexes,
  pruneHistoryReplacedStreamSegments,
  prunePersistedToolStreamMessages,
} from "./stream-segment-pruning.ts";
import { rememberLiveTerminalRun } from "./terminal-message-identity.ts";
import { buildToolStreamIdentity, persistedCurrentToolStreamIds } from "./tool-stream-identity.ts";

type StreamReconciliationState = Parameters<typeof materializeVisibleStreamState>[1];

const visibleStreamOptions = {
  isHiddenAssistantMessage: () => false,
  isHiddenStreamText: () => false,
  persistCommentary: true,
};

function makeIdleStreamState<T extends Record<string, unknown>>(overrides: T) {
  return {
    chatStream: null,
    chatStreamStartedAt: null,
    ...overrides,
  } satisfies StreamReconciliationState;
}

function messageText(message: unknown): string | null {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : null;
  }
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : null;
}

function createConcurrentToolStreamState() {
  const toolCallId = "call-shared";
  const foregroundIdentity = buildToolStreamIdentity("run-foreground", toolCallId);
  const backgroundIdentity = buildToolStreamIdentity("run-background", toolCallId);
  const foregroundMessage = {
    role: "assistant",
    runId: "run-foreground",
    toolCallId,
    content: [{ type: "toolcall", name: "read", arguments: { path: "foreground.txt" } }],
  };
  const backgroundMessage = {
    role: "assistant",
    runId: "run-background",
    toolCallId,
    content: [{ type: "toolcall", name: "exec", arguments: { command: "background" } }],
  };
  const state = {
    chatStream: "foreground still running",
    chatStreamStartedAt: 5,
    chatStreamSegments: [
      { text: "before foreground", ts: 2, runId: "run-foreground", toolCallId },
      { text: "before background", ts: 3, runId: "run-background", toolCallId },
    ],
    chatToolMessages: [foregroundMessage, backgroundMessage],
    toolStreamById: new Map<string, unknown>([
      [foregroundIdentity, { runId: "run-foreground", toolCallId, message: foregroundMessage }],
      [backgroundIdentity, { runId: "run-background", toolCallId, message: backgroundMessage }],
    ]),
    toolStreamOrder: [foregroundIdentity, backgroundIdentity],
  };
  return { state, toolCallId, foregroundIdentity, backgroundIdentity, foregroundMessage };
}

describe("stream reconciliation", () => {
  it.each([
    { name: "commentary mirror", fallback: { itemId: "commentary" }, text: "Progress", tail: "C" },
    {
      name: "matching commentary mirror",
      fallback: { itemId: "commentary" },
      text: "BC",
      tail: "C",
    },
    { name: "ordinary assistant", fallback: undefined, text: "Other answer", tail: "BC" },
    { name: "unkeyed fallback", fallback: {}, text: "Other answer", tail: "BC" },
    { name: "blank item id", fallback: { itemId: " " }, text: "Other answer", tail: "BC" },
  ])("subtracts the cumulative prefix across an interleaved $name", ({ fallback, text, tail }) => {
    const messages = [
      { role: "assistant", content: "A", __openclaw: { idempotencyKey: "active-run" } },
      {
        role: "assistant",
        content: text,
        __openclaw: { idempotencyKey: "active-run" },
        ...(fallback ? { openclawStreamFallback: { source: "segment", ...fallback } } : {}),
      },
      { role: "assistant", content: "B", __openclaw: { idempotencyKey: "active-run" } },
    ];

    expect(resolveCumulativeAssistantTail(messages, "ABC", "active-run")).toBe(tail);
  });

  it("does not anchor cumulative coverage on matching commentary before an older reply", () => {
    const messages = [
      {
        role: "assistant",
        content: "ABC",
        __openclaw: { idempotencyKey: "active-run" },
        openclawStreamFallback: { source: "segment", itemId: "commentary" },
      },
      { role: "assistant", content: "ABC" },
      { role: "user", content: "Current request" },
      { role: "assistant", content: "A", __openclaw: { idempotencyKey: "active-run" } },
      { role: "assistant", content: "B", __openclaw: { idempotencyKey: "active-run" } },
    ];

    expect(resolveCumulativeAssistantTail(messages, "ABC", "active-run")).toBe("C");
  });

  it("materializes keyed preambles by timestamp instead of tool index", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [
        { text: "first preamble", ts: 2, itemId: "preamble-1" },
        { text: "second preamble", ts: 3, itemId: "preamble-2" },
      ],
      toolStreamOrder: ["call_1"],
    });
    const messages = [
      { role: "user", content: "latest ask", timestamp: 1 },
      { role: "toolResult", toolCallId: "call_1", content: "tool output", timestamp: 4 },
    ];

    const next = materializeVisibleStreamState(messages, state, visibleStreamOptions);

    expect(next.map(messageText)).toEqual([
      "latest ask",
      "first preamble",
      "second preamble",
      "tool output",
    ]);
  });

  it("materializes keyed preambles before later assistant messages", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [
        { text: "first preamble", ts: 2, itemId: "preamble-1" },
        { text: "second preamble", ts: 3, itemId: "preamble-2" },
      ],
    });
    const messages = [
      { role: "user", content: "latest ask", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "final reply" }], timestamp: 4 },
    ];

    const next = materializeVisibleStreamState(messages, state, visibleStreamOptions);

    expect(next.map(messageText)).toEqual([
      "latest ask",
      "first preamble",
      "second preamble",
      "final reply",
    ]);
  });

  it.each(["run-active", "run-other", undefined])(
    "reconciles a reused commentary item with history owner %s before the user boundary loads",
    (persistedRunId) => {
      const persisted = {
        role: "assistant",
        content: [{ type: "text", text: "Saved commentary" }],
        timestamp: 1,
        __openclaw: { id: "saved", seq: 1, runId: persistedRunId },
        openclawStreamFallback: { itemId: "shared-item", source: "segment" },
      };
      const segment = {
        text: "Current commentary",
        ts: 2,
        itemId: "shared-item",
        runId: "run-active",
      };
      const state = makeIdleStreamState({
        chatRunId: "run-active",
        chatStreamSegments: [segment],
      });
      const foreignRun = persistedRunId === "run-other";
      expect(
        materializeVisibleStreamState([persisted], state, visibleStreamOptions).map(messageText),
      ).toEqual(foreignRun ? ["Saved commentary", "Current commentary"] : ["Saved commentary"]);
      pruneHistoryReplacedStreamSegments([persisted], state, visibleStreamOptions);
      expect(state.chatStreamSegments).toEqual(foreignRun ? [segment] : []);
    },
  );

  it("does not replay a keyed preamble across a same-run steer boundary", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [
        {
          text: "already visible",
          ts: 2,
          itemId: "preamble-1",
          boundaryRunId: "steer-run",
        },
        { text: "distinct item", ts: 4, itemId: "preamble-2" },
        { text: "already visible", ts: 5 },
      ],
    });
    const messages = [
      { role: "user", content: "original ask", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "already visible" }],
        timestamp: 2,
        openclawStreamFallback: {
          itemId: "preamble-1",
          replacementText: "already visible",
          source: "segment",
        },
      },
      {
        role: "user",
        content: "steer this run",
        timestamp: 3,
        __openclaw: { idempotencyKey: "steer-run:user" },
      },
    ];

    const next = materializeVisibleStreamState(messages, state, visibleStreamOptions);

    expect(next.map(messageText)).toEqual([
      "original ask",
      "already visible",
      "steer this run",
      "distinct item",
      "already visible",
    ]);
  });

  it("recomputes the unkeyed boundary after keyed insertions before a steer", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [
        {
          text: "first keyed",
          ts: 2,
          itemId: "preamble-1",
          boundaryRunId: "steer-run",
        },
        {
          text: "repeatable",
          ts: 3,
          itemId: "preamble-2",
          boundaryRunId: "steer-run",
        },
        { text: "repeatable", ts: 5 },
      ],
    });
    const messages = [
      { role: "user", content: "original ask", timestamp: 1 },
      {
        role: "user",
        content: "steer this run",
        timestamp: 4,
        __openclaw: { idempotencyKey: "steer-run:user" },
      },
    ];

    const next = materializeVisibleStreamState(messages, state, visibleStreamOptions);

    expect(next.map(messageText)).toEqual([
      "original ask",
      "first keyed",
      "repeatable",
      "steer this run",
      "repeatable",
    ]);
  });

  it("does not prune keyed preambles by live tool index", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [
        { text: "keyed preamble", ts: 2, itemId: "preamble-1" },
        { text: "before tool", ts: 3, toolCallId: "call_1" },
      ],
      chatToolMessages: [{ role: "toolResult", toolCallId: "call_1", content: "tool output" }],
      toolStreamById: new Map<string, unknown>([["call_1", {}]]),
      toolStreamOrder: ["call_1"],
    });

    prunePersistedToolStreamMessages(state, new Set(["call_1"]));

    expect(visibleAssistantStreamParts(state, visibleStreamOptions)).toMatchObject([
      { text: "keyed preamble", itemId: "preamble-1" },
    ]);
    expect(state.chatToolMessages).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("retains the cumulative baseline after discarding an earlier displayed prefix", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [
        {
          text: "Before steer.",
          ts: 1,
          runId: "active-run",
          boundaryRunId: "steer-run",
        },
        {
          text: "Before steer. After steer.",
          ts: 2,
          runId: "active-run",
          afterBoundaryRunId: "steer-run",
        },
      ],
    });

    discardStreamSegmentIndexes(state, [0]);

    expect(visibleAssistantStreamParts(state, visibleStreamOptions)).toMatchObject([
      { text: "After steer.", afterBoundaryRunId: "steer-run" },
    ]);
    expect(
      visibleCurrentAssistantStreamTail(
        { ...state, chatStream: "Before steer. After steer. Continued." },
        () => false,
      ),
    ).toBe("Continued.");
  });

  it("prunes only the persisted run when sibling tools share a call id", () => {
    const { state, toolCallId, foregroundIdentity, backgroundIdentity, foregroundMessage } =
      createConcurrentToolStreamState();
    const messages = [
      { role: "user", content: "latest ask", timestamp: 1 },
      {
        role: "toolResult",
        runId: "run-background",
        toolCallId,
        content: "background complete",
      },
    ];

    const persisted = persistedCurrentToolStreamIds(messages, state);

    expect(persisted).toEqual(new Set([backgroundIdentity]));
    prunePersistedToolStreamMessages(state, persisted);

    expect(state.toolStreamOrder).toEqual([foregroundIdentity]);
    expect(state.toolStreamById.has(foregroundIdentity)).toBe(true);
    expect(state.toolStreamById.has(backgroundIdentity)).toBe(false);
    expect(state.chatToolMessages).toEqual([foregroundMessage]);
    expect(
      visibleAssistantStreamParts(state, { ...visibleStreamOptions, includeCurrent: false }),
    ).toMatchObject([{ text: "before foreground", runId: "run-foreground", toolCallId }]);
  });

  it("does not attribute an unscoped persisted result to either colliding run", () => {
    const { state, toolCallId, foregroundIdentity, backgroundIdentity } =
      createConcurrentToolStreamState();
    const messages = [
      { role: "user", content: "latest ask", timestamp: 1 },
      { role: "toolResult", toolCallId, content: "unscoped output" },
    ];

    const persisted = persistedCurrentToolStreamIds(messages, state);

    expect(persisted).toEqual(new Set());
    prunePersistedToolStreamMessages(state, persisted);
    expect(state.toolStreamOrder).toEqual([foregroundIdentity, backgroundIdentity]);
    expect(state.toolStreamById.size).toBe(2);
    expect(state.chatToolMessages).toHaveLength(2);
    expect(state.chatStreamSegments).toHaveLength(2);
  });

  it.each([
    ["camel-case tool-call ID", { toolCallId: "call-persisted" }],
    ["snake-case tool-call ID", { tool_call_id: "call-persisted" }],
    ["camel-case tool-use ID", { toolUseId: "call-persisted" }],
    ["snake-case tool-use ID", { tool_use_id: "call-persisted" }],
  ])("reconciles a transcript message ID separately from its %s", (_label, toolId) => {
    const runId = "run-persisted";
    const toolCallId = "call-persisted";
    const identity = buildToolStreamIdentity(runId, toolCallId);
    const liveMessage = {
      role: "assistant",
      runId,
      toolCallId,
      content: [{ type: "toolcall", name: "read", arguments: { path: "notes.txt" } }],
    };
    const state = makeIdleStreamState({
      chatToolMessages: [liveMessage],
      chatStreamSegments: [{ text: "Reading notes", ts: 2, runId, toolCallId }],
      toolStreamById: new Map<string, unknown>([
        [identity, { runId, toolCallId, message: liveMessage }],
      ]),
      toolStreamOrder: [identity],
    });
    const messages = [
      { role: "user", content: "Read the notes", timestamp: 1 },
      {
        id: "transcript-message-42",
        role: "toolResult",
        runId,
        ...toolId,
        toolName: "read",
        content: "Persisted notes",
      },
    ];

    const persisted = persistedCurrentToolStreamIds(messages, state);

    expect(persisted).toEqual(new Set([identity]));
    prunePersistedToolStreamMessages(state, persisted);
    expect(state.toolStreamOrder).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.chatToolMessages).toEqual([]);
    expect(visibleAssistantStreamParts(state, visibleStreamOptions)).toEqual([]);
  });

  it("does not treat a transcript message ID as a second content-block tool call", () => {
    const runId = "run-persisted";
    const actualCallId = "call-persisted";
    const unrelatedCallId = "transcript-message-42";
    const actualIdentity = buildToolStreamIdentity(runId, actualCallId);
    const unrelatedIdentity = buildToolStreamIdentity(runId, unrelatedCallId);
    const state = makeIdleStreamState({
      toolStreamOrder: [actualIdentity, unrelatedIdentity],
      toolStreamById: new Map<string, unknown>([
        [actualIdentity, { runId, toolCallId: actualCallId }],
        [unrelatedIdentity, { runId, toolCallId: unrelatedCallId }],
      ]),
    });
    const messages = [
      { role: "user", content: "Run both tools", timestamp: 1 },
      {
        id: unrelatedCallId,
        role: "assistant",
        runId,
        content: [{ type: "tool_result", id: actualCallId, name: "read", text: "finished" }],
      },
    ];

    expect(persistedCurrentToolStreamIds(messages, state)).toEqual(new Set([actualIdentity]));
  });

  it("prunes persisted tool messages across current tool id shapes", () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "shell",
      },
      {
        role: "tool",
        tool_call_id: "call_2",
        tool_name: "shell",
      },
      {
        role: "assistant",
        content: [{ type: "toolcall", id: "call_3", name: "shell", arguments: {} }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_result", tool_use_id: "call_4", name: "shell", content: "ok" }],
      },
      { role: "assistant", content: "hello" },
      { role: "user", content: "hello" },
    ];
    const state = makeIdleStreamState({
      chatToolMessages: messages,
      toolStreamById: new Map<string, unknown>([
        ["call_1", {}],
        ["call_2", {}],
        ["call_3", {}],
        ["call_4", {}],
      ]),
      toolStreamOrder: ["call_1", "call_2", "call_3", "call_4"],
      chatStreamSegments: [],
    });

    prunePersistedToolStreamMessages(state, new Set(["call_1", "call_2", "call_3", "call_4"]));

    expect(state.chatToolMessages).toEqual([
      { role: "assistant", content: "hello" },
      { role: "user", content: "hello" },
    ]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("keeps materialized keyed preambles before terminal messages that share their prefix", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [{ text: "before tool", ts: 2, itemId: "preamble-1" }],
    });
    const messages = [{ role: "user", content: "latest ask", timestamp: 1 }];

    const materialized = materializeVisibleStreamState(messages, state, visibleStreamOptions);
    const next = appendTerminalAssistantMessage(materialized, {
      role: "assistant",
      content: [{ type: "text", text: "before tool\nfinal answer" }],
      timestamp: 3,
    });

    expect(next.map(messageText)).toEqual([
      "latest ask",
      "before tool",
      "before tool\nfinal answer",
    ]);
  });

  it("keeps an interrupted run fallback outside a later terminal run", () => {
    const userA = {
      role: "user",
      content: "Run A",
      timestamp: 1,
      __openclaw: { idempotencyKey: "run-a:user" },
    };
    const fallbackA = materializeVisibleStreamState(
      [userA],
      {
        chatRunId: "run-a",
        chatStream: "Interrupted A",
        chatStreamStartedAt: 2,
        chatStreamSegments: [],
      },
      visibleStreamOptions,
    )[1];
    const userB = {
      role: "user",
      content: "Run B",
      timestamp: 3,
      __openclaw: { idempotencyKey: "run-b:user" },
    };
    const terminalB = rememberLiveTerminalRun(
      {
        role: "assistant",
        content: [{ type: "text", text: "Finished B" }],
        timestamp: 4,
      },
      "run-b",
    );

    const next = appendTerminalAssistantMessage([userA, fallbackA, userB], terminalB);

    expect(next.map(messageText)).toEqual(["Run A", "Interrupted A", "Run B", "Finished B"]);
  });

  it.each([
    { name: "as the live stream", rollIntoToolSegment: false },
    { name: "after a tool boundary rollover", rollIntoToolSegment: true },
  ])("keeps output after a textless steer $name", ({ rollIntoToolSegment }) => {
    const state: StreamReconciliationState & Parameters<typeof rolloverChatStream>[0] = {
      chatRunId: "active-run",
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [],
    };
    const messages = [
      {
        role: "user",
        content: "Original",
        timestamp: 1,
        __openclaw: { idempotencyKey: "active-run:user" },
      },
      {
        role: "user",
        content: "Steer",
        timestamp: 2,
        __openclaw: { idempotencyKey: "steer-run:user", steerTargetRunId: "active-run" },
      },
    ];

    rolloverChatStream(state, { runId: "active-run", boundaryRunId: "steer-run" });
    expect(state.chatStreamSegments).toEqual([
      expect.objectContaining({
        text: "",
        boundaryMarker: true,
        boundaryRunId: "steer-run",
      }),
    ]);
    state.chatStream = "After steer";
    state.chatStreamStartedAt = 3;
    if (rollIntoToolSegment) {
      rolloverChatStream(state, { runId: "active-run", toolCallId: "call-1", timestamp: 4 });
    }

    const next = materializeVisibleStreamState(messages, state, visibleStreamOptions);

    expect(next.map(messageText)).toEqual(["Original", "Steer", "After steer"]);
  });

  it("reconciles a causal stream segment only inside its persisted user interval", () => {
    const state = {
      chatStream: "Before steer. After steer.",
      chatStreamStartedAt: 4,
      chatStreamSegments: [
        {
          text: "Before steer.",
          ts: 3,
          runId: "active-run",
          boundaryRunId: "steer-run",
        },
      ],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<{
        text: string;
        ts: number;
        runId: string;
        boundaryRunId: string;
      }>;
    };
    const messages = [
      {
        role: "user",
        content: "Original prompt",
        timestamp: 2,
        __openclaw: { idempotencyKey: "active-run:user" },
      },
      {
        role: "assistant",
        content: "Before steer.",
        timestamp: 100,
        __openclaw: { idempotencyKey: "active-run" },
      },
      {
        role: "user",
        content: "Steer prompt",
        timestamp: 1,
        __openclaw: { idempotencyKey: "steer-run:user" },
      },
    ];

    expect(historyReplacedVisibleStream(messages, state, visibleStreamOptions)).toBe(false);
    expect(
      materializeVisibleStreamState(messages, state, {
        ...visibleStreamOptions,
        includeCurrent: false,
      }).map(messageText),
    ).toEqual(["Original prompt", "Before steer.", "Steer prompt"]);
    expect(
      reconcileTerminalStreamBoundary(
        {
          role: "assistant",
          content: [{ type: "text", text: "Before steer. After steer." }],
        },
        state,
      ),
    ).toMatchObject({
      kind: "split",
      tailMessage: { content: [{ type: "text", text: "After steer." }] },
    });
  });

  it("composes cumulative stream intervals across multiple steers", () => {
    const state = {
      chatStream: "First. Second. Third.",
      chatStreamStartedAt: 6,
      chatStreamSegments: [
        {
          text: "First.",
          ts: 5,
          runId: "active-run",
          boundaryRunId: "steer-one",
        },
        {
          text: "First. Second.",
          ts: 4,
          runId: "active-run",
          boundaryRunId: "steer-two",
        },
      ],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<{
        text: string;
        ts: number;
        runId: string;
        boundaryRunId: string;
      }>;
    };
    const messages = [
      {
        role: "user",
        content: "Original prompt",
        timestamp: 3,
        __openclaw: { idempotencyKey: "active-run:user" },
      },
      {
        role: "user",
        content: "First steer",
        timestamp: 2,
        __openclaw: { idempotencyKey: "steer-one:user" },
      },
      {
        role: "user",
        content: "Second steer",
        timestamp: 1,
        __openclaw: { idempotencyKey: "steer-two:user" },
      },
    ];

    expect(
      materializeVisibleStreamState(messages, state, visibleStreamOptions).map(messageText),
    ).toEqual(["Original prompt", "First.", "First steer", "Second.", "Second steer", "Third."]);
  });

  it("does not treat matching terminal text as a keyed preamble replacement", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [{ text: "before tool", ts: 2, itemId: "preamble-1" }],
    });
    const terminalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "before tool\nfinal answer" }],
      timestamp: 3,
    };
    const messages = [{ role: "user", content: "latest ask", timestamp: 1 }, terminalMessage];

    expect(historyReplacedVisibleStream(messages, state, visibleStreamOptions)).toBe(false);
    expect(
      materializeVisibleStreamState(
        [{ role: "user", content: "latest ask", timestamp: 1 }],
        state,
        {
          ...visibleStreamOptions,
          replacementMessages: [terminalMessage],
          includeCurrent: false,
        },
      ).map(messageText),
    ).toEqual(["latest ask", "before tool"]);
  });

  it("does not require transient keyed commentary to be present in history", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [{ text: "before tool", ts: 2, itemId: "preamble-1" }],
    });
    const messages = [
      { role: "user", content: "latest ask", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "final answer" }], timestamp: 3 },
    ];

    expect(
      historyReplacedVisibleStream(messages, state, {
        ...visibleStreamOptions,
        persistCommentary: false,
      }),
    ).toBe(true);
  });

  it("keeps transient keyed commentary when history has no terminal assistant message", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [{ text: "before tool", ts: 2, itemId: "preamble-1" }],
    });
    const messages = [{ role: "user", content: "latest ask", timestamp: 1 }];

    expect(
      historyReplacedVisibleStream(messages, state, {
        ...visibleStreamOptions,
        persistCommentary: false,
      }),
    ).toBe(false);
  });

  it("replaces materialized tool stream segments with matching terminal messages", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [{ text: "before tool", ts: 2, toolCallId: "call_1" }],
    });
    const messages = [{ role: "user", content: "latest ask", timestamp: 1 }];

    const materialized = materializeVisibleStreamState(messages, state, visibleStreamOptions);
    const next = appendTerminalAssistantMessage(materialized, {
      role: "assistant",
      content: [{ type: "text", text: "before tool\nfinal answer" }],
      timestamp: 3,
    });

    expect(next.map(messageText)).toEqual(["latest ask", "before tool\nfinal answer"]);
  });

  it("omits keyed commentary parts when persistCommentary is false (transient mode)", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [
        { text: "first preamble", ts: 2, itemId: "preamble-1" },
        { text: "second preamble", ts: 3, itemId: "preamble-2" },
      ],
    });
    const messages = [
      { role: "user", content: "latest ask", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "final reply" }], timestamp: 4 },
    ];

    const next = materializeVisibleStreamState(messages, state, {
      ...visibleStreamOptions,
      persistCommentary: false,
    });

    expect(next.map(messageText)).toEqual(["latest ask", "final reply"]);
  });

  it("still materializes the current stream tail when persistCommentary is false", () => {
    const state = {
      chatStream: "draft answer",
      chatStreamStartedAt: 3,
      chatStreamSegments: [{ text: "transient preamble", ts: 2, itemId: "preamble-1" }],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
    };
    const messages = [{ role: "user", content: "latest ask", timestamp: 1 }];

    const next = materializeVisibleStreamState(messages, state, {
      ...visibleStreamOptions,
      persistCommentary: false,
    });

    expect(next.map(messageText)).toEqual(["latest ask", "draft answer"]);
  });

  it("materializes keyed commentary parts when persistCommentary is true (persist mode)", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [{ text: "kept preamble", ts: 2, itemId: "preamble-1" }],
    });
    const messages = [
      { role: "user", content: "latest ask", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "final reply" }], timestamp: 4 },
    ];

    const next = materializeVisibleStreamState(messages, state, {
      ...visibleStreamOptions,
      persistCommentary: true,
    });

    expect(next.map(messageText)).toEqual(["latest ask", "kept preamble", "final reply"]);
  });

  it("replaces current-stream fallbacks with matching terminal messages", () => {
    const state = {
      chatStream: "draft answer",
      chatStreamStartedAt: 2,
      chatStreamSegments: [],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<never>;
    };
    const messages = [{ role: "user", content: "latest ask", timestamp: 1 }];

    const materialized = materializeVisibleStreamState(messages, state, visibleStreamOptions);
    const next = appendTerminalAssistantMessage(materialized, {
      role: "assistant",
      content: [{ type: "text", text: "draft answer\nfinal answer" }],
      timestamp: 3,
    });

    expect(next.map(messageText)).toEqual(["latest ask", "draft answer\nfinal answer"]);
  });

  it("sequentially consumes incremental tool fallbacks before one terminal", () => {
    const state = {
      chatRunId: "active-run",
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        { text: "A", ts: 2, runId: "active-run", toolCallId: "call-a" },
        { text: "A B", ts: 3, runId: "active-run", toolCallId: "call-b" },
      ],
    } satisfies StreamReconciliationState;
    const messages = [
      {
        role: "user",
        content: "latest ask",
        timestamp: 1,
        __openclaw: { idempotencyKey: "active-run:user" },
      },
    ];
    const materialized = materializeVisibleStreamState(messages, state, visibleStreamOptions);
    const terminal = rememberLiveTerminalRun(
      {
        role: "assistant",
        content: [{ type: "text", text: "A B Final" }],
        timestamp: 4,
      },
      "active-run",
    );

    const next = appendTerminalAssistantMessage(materialized, terminal);

    expect(next.map(messageText)).toEqual(["latest ask", "A B Final"]);
  });
});
