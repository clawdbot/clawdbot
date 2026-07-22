import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import { readRecentUserAssistantTextForSession } from "../../config/sessions/transcript.js";
import { runPreparedInboundReply } from "../turn/kernel.js";
import { mergeSessionTranscriptContext } from "./session-transcript-context.runtime.js";

vi.mock("../../config/sessions/transcript.js", () => ({
  readRecentUserAssistantTextForSession: vi.fn(),
}));

const readRecent = vi.mocked(readRecentUserAssistantTextForSession);

function context(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    Body: "continue",
    RawBody: "continue",
    CommandBody: "continue",
    From: "slack:channel:C1",
    To: "channel:C1",
    SessionKey: "agent:main:slack:channel:c1",
    AgentId: "main",
    Provider: "slack",
    Timestamp: 4_000,
    CommandAuthorized: false,
    SessionTranscriptContext: { historyLimit: 3 },
    ...overrides,
  };
}

describe("session transcript inbound context", () => {
  beforeEach(() => {
    readRecent.mockReset();
  });

  it("restores Slack assistant context when the live window is empty after restart", async () => {
    readRecent.mockResolvedValue([
      { id: "u1", role: "user", text: "deploy at noon", timestamp: 1_000 },
      { id: "a1", role: "assistant", text: "I will remind you at 11:50", timestamp: 2_000 },
    ]);
    const ctx = context();

    await runPreparedInboundReply({
      channel: "slack",
      routeSessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
      ctxPayload: ctx,
      recordInboundSession: vi.fn(async () => undefined),
      runDispatch: vi.fn(async () => ({ queuedFinal: false })),
    });

    expect(ctx.InboundHistory).toEqual([
      { messageId: "session:u1", sender: "User", body: "deploy at noon", timestamp: 1_000 },
      {
        messageId: "session:a1",
        sender: "Assistant",
        body: "I will remind you at 11:50",
        timestamp: 2_000,
      },
    ]);
  });

  it("dedupes the canonical turn against the live window and merges chronologically", async () => {
    readRecent.mockResolvedValue([
      { id: "u1", role: "user", text: "cached user turn", timestamp: 1_000 },
      { id: "a1", role: "assistant", text: "canonical reply", timestamp: 2_000 },
    ]);
    const ctx = context({
      InboundHistory: [
        { sender: "Alice", body: "cached user turn", timestamp: 1_000, messageId: "m1" },
        { sender: "Alice", body: "new live turn", timestamp: 3_000, messageId: "m2" },
      ],
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual([
      "cached user turn",
      "canonical reply",
      "new live turn",
    ]);
  });

  it("uses channel projection ids to avoid duplicating rendered assistant replies", async () => {
    readRecent.mockResolvedValue([
      { id: "a1", role: "assistant", text: "**same answer**", timestamp: 2_000 },
      {
        id: "a2",
        role: "assistant",
        text: "[[reply_to_current]]Legacy answer",
        timestamp: 2_500,
      },
      { id: "u2", role: "user", text: "follow-up", timestamp: 3_000, sourceChannel: "gateway" },
    ]);
    const ctx = context({
      SessionTranscriptContext: {
        historyLimit: 3,
        senderLabels: { assistant: "OpenClaw", user: "User" },
      },
      UntrustedStructuredContext: [
        {
          label: "Conversation context",
          source: "telegram",
          type: "chat_window",
          sessionTranscriptDedupeMessageIds: ["a1"],
          sessionTranscriptAssistantTextDedupeKeys: ["text:2500:Legacy answer"],
          payload: {
            order: "chronological",
            relation: "selected_for_current_message",
            messages: [
              { message_id: "42", sender: "OpenClaw (you)", body: "same answer" },
              {
                message_id: "43",
                sender: "OpenClaw (you)",
                body: "Legacy answer",
                timestamp_ms: 2_500,
              },
            ],
          },
        },
      ],
    });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.UntrustedStructuredContext?.[0]).toMatchObject({
      source: "session",
      payload: {
        messages: [
          { message_id: "42", body: "same answer" },
          { message_id: "43", body: "Legacy answer" },
          { message_id: "session:u2", sender: "User (gateway)", body: "follow-up" },
        ],
      },
    });
  });

  it("keeps a reply target bounded when it consumes the full window", async () => {
    readRecent.mockResolvedValue([
      { id: "a1", role: "assistant", text: "older reply", timestamp: 1_000 },
    ]);
    const ctx = context({
      SessionTranscriptContext: { chatWindow: true, historyLimit: 1 },
      UntrustedStructuredContext: [
        {
          label: "Conversation context",
          type: "chat_window",
          payload: { messages: [{ body: "target", is_reply_target: true }] },
        },
      ],
    });

    await mergeSessionTranscriptContext({
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(ctx.UntrustedStructuredContext?.[0]?.payload).toEqual({
      messages: [{ body: "target", is_reply_target: true }],
    });
  });

  it("skips canonical history for session-boundary commands", async () => {
    const ctx = context({ CommandBody: "/new summarize this workspace" });

    await mergeSessionTranscriptContext({
      agentId: "main",
      ctx,
      sessionKey: ctx.SessionKey!,
      storePath: "/tmp/sessions.json",
    });

    expect(readRecent).not.toHaveBeenCalled();
    expect(ctx.InboundHistory).toBeUndefined();
  });
});
