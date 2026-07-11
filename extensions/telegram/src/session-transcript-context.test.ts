import { readRecentUserAssistantTextForSession } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTelegramSessionTranscriptPromptEntries } from "./session-transcript-context.js";

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  readRecentUserAssistantTextForSession: vi.fn(),
}));

const readRecentUserAssistantTextForSessionMock = vi.mocked(readRecentUserAssistantTextForSession);

describe("buildTelegramSessionTranscriptPromptEntries", () => {
  beforeEach(() => {
    readRecentUserAssistantTextForSessionMock.mockReset();
  });

  it("maps shared session turns into chronological Telegram prompt messages", async () => {
    readRecentUserAssistantTextForSessionMock.mockResolvedValue([
      {
        id: "u1",
        role: "user",
        text: "Analyze this chart",
        timestamp: 1_000,
        sourceChannel: "gateway",
      },
      {
        id: "a1",
        role: "assistant",
        text: "The chart is range-bound; want an alert?",
        timestamp: 2_000,
      },
    ]);

    await expect(
      buildTelegramSessionTranscriptPromptEntries({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/sessions.json",
        beforeTimestampMs: 3_000,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        role: "user",
        transcriptMessageId: "u1",
        message: {
          message_id: "session:u1",
          sender: "User (gateway)",
          timestamp_ms: 1_000,
          body: "Analyze this chart",
          source_channel: "gateway",
        },
      },
      {
        role: "assistant",
        transcriptMessageId: "a1",
        message: {
          message_id: "session:a1",
          sender: "OpenClaw",
          timestamp_ms: 2_000,
          body: "The chart is range-bound; want an alert?",
        },
      },
    ]);
    expect(readRecentUserAssistantTextForSessionMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: "/tmp/sessions.json",
      limit: 10,
      beforeTimestampMs: 3_000,
    });
  });

  it("forwards topic-enabled DM session keys unchanged to the SDK reader", async () => {
    readRecentUserAssistantTextForSessionMock.mockResolvedValue([]);

    await buildTelegramSessionTranscriptPromptEntries({
      agentId: "main",
      sessionKey: "agent:main:main:thread:1234:42",
      storePath: "/tmp/sessions.json",
      beforeTimestampMs: 5_000,
      limit: 10,
    });

    expect(readRecentUserAssistantTextForSessionMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main:thread:1234:42",
      storePath: "/tmp/sessions.json",
      limit: 10,
      beforeTimestampMs: 5_000,
    });
  });
});
