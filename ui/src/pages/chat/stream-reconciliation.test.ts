// Control UI tests cover stream reconciliation behavior.
import { describe, expect, it } from "vitest";
import {
  appendTerminalAssistantMessage,
  historyReplacedVisibleStream,
  materializeVisibleStreamState,
  prunePersistedToolStreamMessages,
} from "./stream-reconciliation.ts";

type StreamReconciliationState = Parameters<typeof materializeVisibleStreamState>[1];

const visibleStreamOptions = {
  isHiddenAssistantMessage: () => false,
  isHiddenStreamText: () => false,
  persistCommentary: true,
};

function messageText(message: unknown): string | null {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : null;
  }
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : null;
}

describe("stream reconciliation", () => {
  it("materializes keyed preambles by timestamp instead of tool index", () => {
    const state = {
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        { text: "first preamble", ts: 2, itemId: "preamble-1" },
        { text: "second preamble", ts: 3, itemId: "preamble-2" },
      ],
      toolStreamOrder: ["call_1"],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
      toolStreamOrder: string[];
    };
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
    const state = {
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        { text: "first preamble", ts: 2, itemId: "preamble-1" },
        { text: "second preamble", ts: 3, itemId: "preamble-2" },
      ],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
    };
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

  it("does not prune keyed preambles by live tool index", () => {
    const state = {
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        { text: "keyed preamble", ts: 2, itemId: "preamble-1" },
        { text: "before tool", ts: 3, toolCallId: "call_1" },
      ],
      chatToolMessages: [{ role: "toolResult", toolCallId: "call_1", content: "tool output" }],
      toolStreamById: new Map<string, unknown>([["call_1", {}]]),
      toolStreamOrder: ["call_1"],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<{
        text: string;
        ts: number;
        itemId?: string;
        toolCallId?: string;
      }>;
      chatToolMessages: unknown[];
      toolStreamById: Map<string, unknown>;
      toolStreamOrder: string[];
    };

    prunePersistedToolStreamMessages(state, new Set(["call_1"]));

    expect(state.chatStreamSegments).toEqual([
      { text: "keyed preamble", ts: 2, itemId: "preamble-1" },
    ]);
    expect(state.chatToolMessages).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
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
    const state = {
      chatStream: null,
      chatStreamStartedAt: null,
      chatToolMessages: messages,
      toolStreamById: new Map<string, unknown>([
        ["call_1", {}],
        ["call_2", {}],
        ["call_3", {}],
        ["call_4", {}],
      ]),
      toolStreamOrder: ["call_1", "call_2", "call_3", "call_4"],
      chatStreamSegments: [],
    } satisfies StreamReconciliationState & {
      chatToolMessages: unknown[];
      toolStreamById: Map<string, unknown>;
      toolStreamOrder: string[];
      chatStreamSegments: Array<never>;
    };

    prunePersistedToolStreamMessages(state, new Set(["call_1", "call_2", "call_3", "call_4"]));

    expect(state.chatToolMessages).toEqual([
      { role: "assistant", content: "hello" },
      { role: "user", content: "hello" },
    ]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("keeps materialized keyed preambles before terminal messages that share their prefix", () => {
    const state = {
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [{ text: "before tool", ts: 2, itemId: "preamble-1" }],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
    };
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

  it("does not treat matching terminal text as a keyed preamble replacement", () => {
    const state = {
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [{ text: "before tool", ts: 2, itemId: "preamble-1" }],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
    };
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
    const state = {
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [{ text: "before tool", ts: 2, itemId: "preamble-1" }],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
    };
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
    const state = {
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [{ text: "before tool", ts: 2, itemId: "preamble-1" }],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
    };
    const messages = [{ role: "user", content: "latest ask", timestamp: 1 }];

    expect(
      historyReplacedVisibleStream(messages, state, {
        ...visibleStreamOptions,
        persistCommentary: false,
      }),
    ).toBe(false);
  });

  it("replaces materialized tool stream segments with matching terminal messages", () => {
    const state = {
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [{ text: "before tool", ts: 2, toolCallId: "call_1" }],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<{ text: string; ts: number; toolCallId: string }>;
    };
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
    const state = {
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        { text: "first preamble", ts: 2, itemId: "preamble-1" },
        { text: "second preamble", ts: 3, itemId: "preamble-2" },
      ],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
    };
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
    const state = {
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [{ text: "kept preamble", ts: 2, itemId: "preamble-1" }],
    } satisfies StreamReconciliationState & {
      chatStreamSegments: Array<{ text: string; ts: number; itemId: string }>;
    };
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
});
