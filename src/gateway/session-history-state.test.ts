/**
 * Session history state hashing and metadata tests.
 */
import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { STREAM_ERROR_FALLBACK_TEXT } from "../agents/stream-message-shared.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { buildSessionHistorySnapshot, SessionHistorySseState } from "./session-history-state.js";
import * as sessionTranscriptReaders from "./session-transcript-readers.js";

type HistorySnapshot = ReturnType<typeof buildSessionHistorySnapshot>;
type RawStateOptions = Omit<
  Parameters<typeof SessionHistorySseState.fromRawSnapshot>[0],
  "target" | "rawMessages"
>;

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

function assistantTextMessage(text: string, seq: number) {
  return {
    role: "assistant" as const,
    content: textContent(text),
    __openclaw: { seq },
  };
}

function userTextMessage(text: string, seq: number) {
  return {
    role: "user" as const,
    content: textContent(text),
    __openclaw: { seq },
  };
}

function newState(rawMessages: Array<Record<string, unknown>>, options: RawStateOptions = {}) {
  return SessionHistorySseState.fromRawSnapshot({
    target: { sessionId: "sess-main", sessionKey: "agent:main:main" },
    rawMessages,
    ...options,
  });
}

function newStateWithUserText(text: string): SessionHistorySseState {
  return newState([userTextMessage(text, 1)]);
}

function expectOnlyAssistantText(snapshot: HistorySnapshot, text: string, seq: number): void {
  expect(snapshot.history.messages).toEqual([assistantTextMessage(text, seq)]);
}

function messageToolCall(id: string, message: string, args: Record<string, unknown> = {}) {
  return {
    type: "toolCall" as const,
    id,
    name: "message",
    arguments: {
      action: "send",
      message,
      ...args,
    },
  };
}

function messageToolResult(
  toolCallId: string,
  messageId: string,
  seq?: number,
  content: Record<string, unknown> = {},
) {
  return {
    role: "toolResult" as const,
    toolName: "message",
    toolCallId,
    content: { ok: true, messageId, ...content },
    ...(seq === undefined ? {} : { __openclaw: { seq } }),
  };
}

function appendAssistantText(state: SessionHistorySseState, text: string, messageSeq?: number) {
  return state.appendInlineMessage({
    message: {
      role: "assistant",
      content: textContent(text),
    },
    ...(messageSeq === undefined ? {} : { messageSeq }),
  });
}

describe("SessionHistorySseState", () => {
  test("uses the initial raw snapshot for both first history and seq seeding", () => {
    const readSpy = vi
      .spyOn(sessionTranscriptReaders, "readSessionMessagesAsync")
      .mockResolvedValue([assistantTextMessage("stale disk message", 1)]);
    try {
      const state = newState([assistantTextMessage("fresh snapshot message", 2)]);

      expect(state.snapshot().messages).toHaveLength(1);
      expect(
        (
          state.snapshot().messages[0] as {
            content?: Array<{ text?: string }>;
            __openclaw?: { seq?: number };
          }
        ).content?.[0]?.text,
      ).toBe("fresh snapshot message");
      expect(
        (
          state.snapshot().messages[0] as {
            __openclaw?: { seq?: number };
          }
        )["__openclaw"]?.seq,
      ).toBe(2);

      const appended = state.appendInlineMessage({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "next message" }],
        },
      });

      expect(appended?.messageSeq).toBe(3);
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  test("carries inline user idempotency keys into history metadata", () => {
    const state = newState([]);

    const appended = state.appendInlineMessage({
      message: {
        role: "user",
        content: [{ type: "text", text: "optimistic turn" }],
        idempotencyKey: "client-turn-2",
      },
      messageId: "message-user-2",
      messageSeq: 2,
    });

    expect(appended).toBeDefined();
    expect(appended?.messageSeq).toBe(2);
    expect(
      (
        appended!.message as {
          __openclaw?: { id?: string; idempotencyKey?: string; seq?: number };
        }
      )["__openclaw"],
    ).toMatchObject({
      id: "message-user-2",
      idempotencyKey: "client-turn-2",
      seq: 2,
    });
  });

  test("reuses one canonical array for items and messages", () => {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [assistantTextMessage("first", 1), assistantTextMessage("second", 2)],
      limit: 1,
    });

    expect(snapshot.history.items).toBe(snapshot.history.messages);
    expect(snapshot.history.messages[0]?.["__openclaw"]?.seq).toBe(2);
    expect(snapshot.rawTranscriptSeq).toBe(2);
  });

  test("retains the recent projection without changing carried inline sequence", () => {
    const state = newState([
      assistantTextMessage("first", 1),
      assistantTextMessage("second", 2),
      assistantTextMessage("third", 3),
      assistantTextMessage("fourth", 4),
    ]);

    const retained = state.retainRecentMessages(2);

    expect(retained.items).toBe(retained.messages);
    expect(retained.messages).toEqual([
      assistantTextMessage("third", 3),
      assistantTextMessage("fourth", 4),
    ]);
    expect(retained.hasMore).toBe(true);
    expect(retained.nextCursor).toBe("3");

    const appended = appendAssistantText(state, "fifth", 5);
    expect(appended?.messageSeq).toBe(5);
    expect(appended?.message?.content).toEqual(textContent("fifth"));
    expect(state.retainRecentMessages(2).messages).toEqual([
      assistantTextMessage("fourth", 4),
      assistantTextMessage("fifth", 5),
    ]);
  });

  test("keeps the existing projection when it already fits the retention window", () => {
    const state = newState([assistantTextMessage("first", 1)]);
    const initialSnapshot = state.snapshot();

    expect(state.retainRecentMessages(2)).toBe(initialSnapshot);
  });

  test("uses carried sequence for inline SSE appends", () => {
    const state = newState([assistantTextMessage("initial", 2)]);

    const appended = appendAssistantText(state, "carried", 9);

    expect(appended?.messageSeq).toBe(9);
    expect(state.snapshot().messages.at(-1)?.["__openclaw"]?.seq).toBe(9);
  });

  test("emits message-tool mirror when silent control reply completes inline append", () => {
    const state = newStateWithUserText("reply here");

    expect(
      state.appendInlineMessage({
        message: {
          role: "assistant",
          content: [
            messageToolCall("call-message-channel-hint", "Still the current chat.", {
              channel: "telegram",
            }),
          ],
        },
        messageSeq: 2,
      })?.messageSeq,
    ).toBe(2);
    expect(
      state.appendInlineMessage({
        message: messageToolResult("call-message-channel-hint", "24270", undefined, {
          chatId: "current-run",
        }),
        messageSeq: 3,
      })?.messageSeq,
    ).toBe(3);

    const appended = appendAssistantText(state, "NO_REPLY", 4);

    expect(appended?.messageSeq).toBe(4);
    expect(
      (
        appended?.message as {
          content?: Array<{ text?: string }>;
          openclawMessageToolMirror?: unknown;
        }
      )?.content?.[0]?.text,
    ).toBe("Still the current chat.");
    expect(
      Boolean(
        (appended?.message as { openclawMessageToolMirror?: unknown } | undefined)
          ?.openclawMessageToolMirror,
      ),
    ).toBe(true);
  });

  test("keeps message-tool mirror pending across projected sessions_send inline history", () => {
    const state = SessionHistorySseState.fromRawSnapshot({
      target: { sessionId: "sess-main", sessionKey: "agent:main:main" },
      rawMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-message-forwarded",
              name: "message",
              arguments: {
                action: "send",
                message: "Still visible after forwarded handoff.",
              },
            },
          ],
          __openclaw: { seq: 1 },
        },
        {
          role: "user",
          content: [{ type: "text", text: "forwarded status update" }],
          provenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:webchat:source",
            sourceTool: "sessions_send",
          },
          __openclaw: { seq: 2 },
        },
      ],
    });

    expect(state.snapshot().messages[1]).toMatchObject({
      role: "assistant",
      senderLabel: "Forwarded from main",
    });
    expect(
      state.appendInlineMessage({
        message: {
          role: "toolResult",
          toolName: "message",
          toolCallId: "call-message-forwarded",
          content: { ok: true, messageId: "24271", chatId: "current-run" },
        },
        messageSeq: 3,
      })?.messageSeq,
    ).toBe(3);

    const appended = state.appendInlineMessage({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "NO_REPLY" }],
      },
      messageSeq: 4,
    });

    expect(
      (
        appended?.message as {
          content?: Array<{ text?: string }>;
          openclawMessageToolMirror?: unknown;
        }
      )?.content?.[0]?.text,
    ).toBe("Still visible after forwarded handoff.");
    expect(
      Boolean(
        (appended?.message as { openclawMessageToolMirror?: unknown } | undefined)
          ?.openclawMessageToolMirror,
      ),
    ).toBe(true);
  });

  test("keeps same-sequence projected rows reachable across cursor pages", () => {
    const rawMessages = [
      userTextMessage("send both here", 1),
      {
        role: "assistant" as const,
        content: [
          messageToolCall("call-message-first", "First visible reply."),
          messageToolCall("call-message-second", "Second visible reply."),
        ],
        __openclaw: { seq: 2 },
      },
      messageToolResult("call-message-first", "first", 3),
      messageToolResult("call-message-second", "second", 4),
      assistantTextMessage("NO_REPLY", 5),
    ];

    const newest = buildSessionHistorySnapshot({ rawMessages, limit: 1 }).history;
    expect(newest.messages).toMatchObject([
      { role: "toolResult", toolCallId: "call-message-first", __openclaw: { seq: 3 } },
      { role: "toolResult", toolCallId: "call-message-second", __openclaw: { seq: 4 } },
      {
        role: "assistant",
        content: [{ text: "First visible reply." }],
        openclawMessageToolMirror: { toolCallId: "call-message-first" },
        __openclaw: { seq: 3 },
      },
      {
        role: "assistant",
        content: [{ text: "Second visible reply." }],
        openclawMessageToolMirror: { toolCallId: "call-message-second" },
        __openclaw: { seq: 4 },
      },
    ]);
    expect(newest.nextCursor).toBe("3");

    const middle = buildSessionHistorySnapshot({
      rawMessages,
      limit: 1,
      cursor: newest.nextCursor,
    }).history;
    expect(middle.messages).toMatchObject([
      {
        role: "assistant",
        content: [{ id: "call-message-first" }, { id: "call-message-second" }],
        __openclaw: { seq: 2 },
      },
    ]);
    expect(middle.nextCursor).toBe("2");

    const oldest = buildSessionHistorySnapshot({
      rawMessages,
      limit: 1,
      cursor: middle.nextCursor,
    }).history;
    expect(oldest.messages).toEqual([userTextMessage("send both here", 1)]);
    expect(oldest.hasMore).toBe(false);
    expect(oldest.nextCursor).toBeUndefined();
  });

  test("does not coerce partial cursor values", () => {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [assistantTextMessage("first", 1), assistantTextMessage("second", 2)],
      cursor: "seq:2next",
    });

    expect(snapshot.history.messages.map((message) => message["__openclaw"]?.seq)).toEqual([1, 2]);
  });

  test("requests refresh when silent control reply completes multiple message-tool mirrors", () => {
    const state = newState([userTextMessage("send both here", 1)]);

    state.appendInlineMessage({
      message: {
        role: "assistant",
        content: [
          messageToolCall("call-message-first", "First visible reply."),
          messageToolCall("call-message-second", "Second visible reply."),
        ],
      },
      messageSeq: 2,
    });
    state.appendInlineMessage({
      message: messageToolResult("call-message-first", "first"),
      messageSeq: 3,
    });
    state.appendInlineMessage({
      message: messageToolResult("call-message-second", "second"),
      messageSeq: 4,
    });

    const appended = appendAssistantText(state, "NO_REPLY", 5);

    expect(appended).toEqual({ shouldRefresh: true });
    expect(
      state
        .snapshot()
        .messages.flatMap(
          (message) => (message as { content?: Array<{ text?: string }> }).content?.[0]?.text,
        )
        .filter((text): text is string => typeof text === "string"),
    ).toEqual(["send both here", "First visible reply.", "Second visible reply."]);
  });

  test("does not emit a no-op hidden inline control reply", () => {
    const state = newStateWithUserText("reply here");

    const appended = appendAssistantText(state, "NO_REPLY", 2);

    expect(appended).toBeNull();
    expect(state.snapshot().messages).toHaveLength(1);
  });

  test("requests refresh when inline TTS supplement merges into an existing assistant message", () => {
    const visibleText = "Here is the answer.";
    const textSha256 = createHash("sha256").update(visibleText).digest("hex");
    const state = newState([assistantTextMessage(visibleText, 2)]);

    const appended = state.appendInlineMessage({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Audio reply" },
          {
            type: "attachment",
            attachment: {
              url: "/tmp/tts.mp3",
              kind: "audio",
              label: "tts.mp3",
              mimeType: "audio/mpeg",
            },
          },
        ],
        openclawTtsSupplement: { textSha256, spokenText: visibleText },
      },
      messageSeq: 3,
    });

    expect(appended).toEqual({ shouldRefresh: true });
    expect(state.snapshot().messages).toEqual([
      {
        role: "assistant",
        content: [
          textContent(visibleText)[0],
          {
            type: "attachment",
            attachment: {
              url: "/tmp/tts.mp3",
              kind: "audio",
              label: "tts.mp3",
              mimeType: "audio/mpeg",
            },
          },
        ],
        __openclaw: { seq: 2 },
      },
    ]);
  });

  test("requests refresh for non-monotonic carried inline sequence", () => {
    const state = newState([assistantTextMessage("current", 5)]);

    const appended = appendAssistantText(state, "rewound branch", 3);

    expect(appended).toEqual({ shouldRefresh: true });
    expect(state.snapshot().messages).toHaveLength(1);
    expect(state.snapshot().messages.at(-1)?.["__openclaw"]?.seq).toBe(5);
  });

  test("requests refresh when later assistant content repairs an inline stream error", () => {
    const state = newState([userTextMessage("hello", 1)]);

    const sentinel = state.appendInlineMessage({
      message: {
        role: "assistant",
        content: textContent(STREAM_ERROR_FALLBACK_TEXT),
        stopReason: "error",
        errorMessage: "provider failed before content",
      },
      messageSeq: 2,
    });

    expect(sentinel?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "The agent run failed before producing a reply." }],
      __openclaw: { seq: 2 },
    });
    expect(appendAssistantText(state, "actual fallback response", 3)).toEqual({
      shouldRefresh: true,
    });
  });

  test("keeps an inline failed turn before a new forwarded inter-session turn", () => {
    const state = newState([
      {
        role: "assistant",
        content: textContent(STREAM_ERROR_FALLBACK_TEXT),
        stopReason: "error",
        __openclaw: { seq: 1 },
      },
    ]);

    const forwarded = state.appendInlineMessage({
      message: {
        role: "user",
        content: textContent("forwarded update"),
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:webchat:source",
          sourceTool: "sessions_send",
        },
      },
      messageSeq: 2,
    });

    expect(forwarded?.message).toMatchObject({
      role: "assistant",
      content: textContent("forwarded update"),
    });
    expect(appendAssistantText(state, "actual fallback response", 3)?.message).toMatchObject({
      role: "assistant",
      content: textContent("actual fallback response"),
    });
    expect(state.snapshot().messages[0]?.content).toEqual([
      { type: "text", text: "The agent run failed before producing a reply." },
    ]);
  });

  test("requests refresh when initial SSE history ends with a repaired stream error", () => {
    const state = newState([
      userTextMessage("hello", 1),
      {
        role: "assistant",
        content: textContent(STREAM_ERROR_FALLBACK_TEXT),
        stopReason: "error",
        __openclaw: { seq: 2 },
      },
    ]);

    expect(appendAssistantText(state, "actual fallback response", 3)).toEqual({
      shouldRefresh: true,
    });
  });

  test("marks bounded tail snapshots as having older history", () => {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [assistantTextMessage("tail", 99)],
      limit: 1,
      rawTranscriptSeq: 99,
      totalRawMessages: 99,
    });

    expect(snapshot.history.hasMore).toBe(true);
    expect(snapshot.history.nextCursor).toBe("99");
    expect(snapshot.rawTranscriptSeq).toBe(99);
  });

  test("refreshes limited SSE history from bounded async tail reads", async () => {
    const fullReadSpy = vi
      .spyOn(sessionTranscriptReaders, "readSessionMessagesAsync")
      .mockResolvedValue([]);
    const tailReadSpy = vi
      .spyOn(sessionTranscriptReaders, "readRecentSessionMessagesWithStatsAsync")
      .mockResolvedValueOnce({
        messages: [assistantTextMessage("tail two", 8)],
        totalMessages: 8,
      });
    try {
      const state = newState([assistantTextMessage("tail one", 7)], {
        rawTranscriptSeq: 7,
        totalRawMessages: 7,
        limit: 1,
      });

      expect(state.snapshot().messages[0]?.["__openclaw"]?.seq).toBe(7);
      const refreshed = await state.refreshAsync();

      expect(refreshed.hasMore).toBe(true);
      expect(refreshed.nextCursor).toBe("8");
      expect(refreshed.messages[0]?.["__openclaw"]?.seq).toBe(8);
      expect(tailReadSpy).toHaveBeenCalledTimes(1);
      expect(fullReadSpy).not.toHaveBeenCalled();
    } finally {
      fullReadSpy.mockRestore();
      tailReadSpy.mockRestore();
    }
  });

  test("strips legacy internal envelopes before exposing history", () => {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
                "secret runtime context",
                "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
                "",
                "visible ask",
              ].join("\n"),
            },
          ],
          __openclaw: { seq: 1 },
        },
      ],
    });

    expect(snapshot.history.messages).toHaveLength(1);
    expect(
      (
        snapshot.history.messages[0] as {
          content?: Array<{ text?: string }>;
        }
      ).content?.[0]?.text,
    ).toBe("visible ask");
  });

  test("drops internal-only user messages after envelope stripping", () => {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
                "subagent completion payload",
                "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
              ].join("\n"),
            },
          ],
          __openclaw: { seq: 1 },
        },
        assistantTextMessage("visible answer", 2),
      ],
    });

    expectOnlyAssistantText(snapshot, "visible answer", 2);
  });

  test("drops hidden runtime-context custom messages from projected history", () => {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [
        {
          role: "custom",
          customType: "openclaw.runtime-context",
          content: "secret runtime context",
          display: false,
          __openclaw: { seq: 1 },
        },
        assistantTextMessage("visible answer", 2),
      ],
    });

    expectOnlyAssistantText(snapshot, "visible answer", 2);
    expect(snapshot.rawTranscriptSeq).toBe(2);
  });

  test("drops subagent announce inter-session user messages from projected history", () => {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=webchat sourceTool=subagent_announce isUser=false",
                "This content was routed by OpenClaw from another session or internal tool.",
                "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
                "subagent completion payload",
                "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
              ].join("\n"),
            },
          ],
          provenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:subagent:child",
            sourceTool: "subagent_announce",
          },
          __openclaw: { seq: 1 },
        },
        assistantTextMessage("clean child result", 2),
      ],
    });

    expectOnlyAssistantText(snapshot, "clean child result", 2);
  });

  test("drops generated media completion wakes while retaining final media", () => {
    const assistantReply = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "Created." },
        {
          type: "image" as const,
          source: { type: "url" as const, url: "/api/chat/media/outgoing/generated.png" },
        },
      ],
      __openclaw: { seq: 2 },
    };
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "A background task completed. Use this result to reply normally.",
                "session_key: image_generate:task-123",
                'path="/root/.openclaw/media/tool-image-generation/private.png"',
              ].join("\n"),
            },
          ],
          provenance: {
            kind: "inter_session",
            sourceChannel: "webchat",
            sourceSessionKey: "image_generate:task-123",
            sourceTool: "image_generate",
          },
          __openclaw: { seq: 1 },
        },
        assistantReply,
      ],
    });

    expect(snapshot.history.messages).toEqual([assistantReply]);
    expect(JSON.stringify(snapshot.history.messages)).not.toContain("image_generate:task-123");
    expect(JSON.stringify(snapshot.history.messages)).not.toContain("/root/.openclaw/media");
  });

  test("hides heartbeat prompt and ok acknowledgements from visible history", () => {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [
        {
          role: "user",
          content: `${HEARTBEAT_PROMPT}\nWhen reading HEARTBEAT.md, use workspace file /tmp/HEARTBEAT.md (exact case). Do not read docs/heartbeat.md.`,
          __openclaw: { seq: 1 },
        },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "Checking the heartbeat." },
            { type: "text", text: "HEARTBEAT_OK" },
          ],
          __openclaw: { seq: 2 },
        },
        {
          role: "user",
          content: HEARTBEAT_PROMPT,
          __openclaw: { seq: 3 },
        },
        assistantTextMessage("Disk usage crossed 95 percent.", 4),
      ],
    });

    expect(snapshot.history.messages).toEqual([
      {
        ...assistantTextMessage("Disk usage crossed 95 percent.", 4),
        __openclaw: { seq: 4, turnBoundary: true },
      },
    ]);
    expect(snapshot.rawTranscriptSeq).toBe(4);
  });

  test("carries a hidden heartbeat boundary into the next visible SSE append", () => {
    const state = newState([
      assistantTextMessage("already visible", 1),
      {
        role: "user",
        content: HEARTBEAT_PROMPT,
        __openclaw: { seq: 2 },
      },
    ]);

    expect(appendAssistantText(state, "HEARTBEAT_OK", 3)).toBeNull();

    const compaction = state.appendInlineMessage({
      message: {
        role: "system",
        content: textContent("Compaction summary"),
      },
      messageSeq: 4,
    });
    expect(compaction?.message?.["__openclaw"]?.turnBoundary).toBeUndefined();

    const appended = appendAssistantText(state, "Disk usage crossed 95 percent.", 5);
    expect(appended?.message).toMatchObject({
      role: "assistant",
      __openclaw: { seq: 5, turnBoundary: true },
    });
  });

  test("does not append heartbeat or internal-only SSE messages", () => {
    const state = newState([assistantTextMessage("already visible", 1)]);

    expect(
      state.appendInlineMessage({
        message: {
          role: "user",
          content: HEARTBEAT_PROMPT,
        },
      }),
    ).toBeNull();
    expect(appendAssistantText(state, "HEARTBEAT_OK")).toBeNull();
    expect(
      state.appendInlineMessage({
        message: {
          role: "custom",
          customType: "openclaw.runtime-context",
          content: "secret runtime context",
          display: false,
        },
      }),
    ).toBeNull();
    expect(
      state.appendInlineMessage({
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
                "runtime details",
                "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
              ].join("\n"),
            },
          ],
        },
      }),
    ).toBeNull();
    expect(state.snapshot().messages).toHaveLength(1);
  });
});
