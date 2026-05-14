import { describe, expect, test, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { buildSessionHistorySnapshot, SessionHistorySseState } from "./session-history-state.js";
import * as sessionUtils from "./session-utils.js";

describe("SessionHistorySseState", () => {
  test("uses the initial raw snapshot for both first history and seq seeding", () => {
    const readSpy = vi.spyOn(sessionUtils, "readSessionMessagesAsync").mockResolvedValue([
      {
        role: "assistant",
        content: [{ type: "text", text: "stale disk message" }],
        __openclaw: { seq: 1 },
      },
    ]);
    try {
      const state = SessionHistorySseState.fromRawSnapshot({
        target: { sessionId: "sess-main" },
        rawMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "fresh snapshot message" }],
            __openclaw: { seq: 2 },
          },
        ],
      });

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
        ).__openclaw?.seq,
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

  test("reuses one canonical array for items and messages", () => {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          __openclaw: { seq: 1 },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "second" }],
          __openclaw: { seq: 2 },
        },
      ],
      limit: 1,
    });

    expect(snapshot.history.items).toBe(snapshot.history.messages);
    expect(snapshot.history.messages[0]?.__openclaw?.seq).toBe(2);
    expect(snapshot.rawTranscriptSeq).toBe(2);
  });

  test("uses carried sequence for inline SSE appends", () => {
    const state = SessionHistorySseState.fromRawSnapshot({
      target: { sessionId: "sess-main" },
      rawMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "initial" }],
          __openclaw: { seq: 2 },
        },
      ],
    });

    const appended = state.appendInlineMessage({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "carried" }],
      },
      messageSeq: 9,
    });

    expect(appended?.messageSeq).toBe(9);
    expect(state.snapshot().messages.at(-1)?.__openclaw?.seq).toBe(9);
  });

  test("requests refresh for non-monotonic carried inline sequence", () => {
    const state = SessionHistorySseState.fromRawSnapshot({
      target: { sessionId: "sess-main" },
      rawMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "current" }],
          __openclaw: { seq: 5 },
        },
      ],
    });

    const appended = state.appendInlineMessage({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "rewound branch" }],
      },
      messageSeq: 3,
    });

    expect(appended).toEqual({ shouldRefresh: true });
    expect(state.snapshot().messages).toHaveLength(1);
    expect(state.snapshot().messages.at(-1)?.__openclaw?.seq).toBe(5);
  });

  test("marks bounded tail snapshots as having older history", () => {
    const snapshot = buildSessionHistorySnapshot({
      rawMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "tail" }],
          __openclaw: { seq: 99 },
        },
      ],
      limit: 1,
      rawTranscriptSeq: 99,
      totalRawMessages: 99,
    });

    expect(snapshot.history.hasMore).toBe(true);
    expect(snapshot.history.nextCursor).toBe("99");
    expect(snapshot.rawTranscriptSeq).toBe(99);
  });

  test("refreshes limited SSE history from bounded async tail reads", async () => {
    const fullReadSpy = vi.spyOn(sessionUtils, "readSessionMessagesAsync").mockResolvedValue([]);
    const tailReadSpy = vi
      .spyOn(sessionUtils, "readRecentSessionMessagesWithStatsAsync")
      .mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "tail two" }],
            __openclaw: { seq: 8 },
          },
        ],
        totalMessages: 8,
      });
    try {
      const state = SessionHistorySseState.fromRawSnapshot({
        target: { sessionId: "sess-main" },
        rawMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "tail one" }],
            __openclaw: { seq: 7 },
          },
        ],
        rawTranscriptSeq: 7,
        totalRawMessages: 7,
        limit: 1,
      });

      expect(state.snapshot().messages[0]?.__openclaw?.seq).toBe(7);
      const refreshed = await state.refreshAsync();

      expect(refreshed.hasMore).toBe(true);
      expect(refreshed.nextCursor).toBe("8");
      expect(refreshed.messages[0]?.__openclaw?.seq).toBe(8);
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
        {
          role: "assistant",
          content: [{ type: "text", text: "visible answer" }],
          __openclaw: { seq: 2 },
        },
      ],
    });

    expect(snapshot.history.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "visible answer" }],
        __openclaw: { seq: 2 },
      },
    ]);
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
        {
          role: "assistant",
          content: [{ type: "text", text: "clean child result" }],
          __openclaw: { seq: 2 },
        },
      ],
    });

    expect(snapshot.history.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "clean child result" }],
        __openclaw: { seq: 2 },
      },
    ]);
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
          content: [{ type: "text", text: "HEARTBEAT_OK" }],
          __openclaw: { seq: 2 },
        },
        {
          role: "user",
          content: HEARTBEAT_PROMPT,
          __openclaw: { seq: 3 },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Disk usage crossed 95 percent." }],
          __openclaw: { seq: 4 },
        },
      ],
    });

    expect(snapshot.history.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Disk usage crossed 95 percent." }],
        __openclaw: { seq: 4 },
      },
    ]);
    expect(snapshot.rawTranscriptSeq).toBe(4);
  });

  test("does not append heartbeat or internal-only SSE messages", () => {
    const state = SessionHistorySseState.fromRawSnapshot({
      target: { sessionId: "sess-main" },
      rawMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "already visible" }],
          __openclaw: { seq: 1 },
        },
      ],
    });

    expect(
      state.appendInlineMessage({
        message: {
          role: "user",
          content: HEARTBEAT_PROMPT,
        },
      }),
    ).toBeNull();
    expect(
      state.appendInlineMessage({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "HEARTBEAT_OK" }],
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
