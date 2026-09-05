import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistCodexContextCompactionActivity } from "./context-compaction-activity.js";

const appendMessage = vi.hoisted(() => vi.fn());
const publishUpdate = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  appendSessionTranscriptMessageByIdentity: appendMessage,
  publishSessionTranscriptUpdateByIdentity: publishUpdate,
}));

beforeEach(() => {
  appendMessage.mockReset();
  publishUpdate.mockReset();
});

describe("persistCodexContextCompactionActivity", () => {
  it("publishes one model-excluded activity and leaves replay deduplication to transcript identity", async () => {
    appendMessage
      .mockImplementationOnce(async (params: { message: unknown }) => ({
        appended: true,
        message: params.message,
        messageId: "activity-message",
      }))
      .mockResolvedValueOnce({
        appended: false,
        message: {},
        messageId: "activity-message",
      });
    const params = {
      runId: "run-1",
      cwd: "/workspace",
      sessionTarget: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:dashboard:session-1",
        storePath: "/state/openclaw-agent.sqlite",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "compact-1",
      timestamp: 123,
    } as Parameters<typeof persistCodexContextCompactionActivity>[0];

    await persistCodexContextCompactionActivity(params);
    await persistCodexContextCompactionActivity(params);

    expect(appendMessage).toHaveBeenCalledTimes(2);
    expect(appendMessage.mock.calls[0]?.[0]).toMatchObject({
      eventId: "codex-context-compaction:thread-1:turn-1:compact-1",
      message: {
        role: "custom",
        customType: "openclaw.context-compaction",
        content: "Context compacted",
        display: true,
        excludeFromContext: true,
        idempotencyKey: "codex-context-compaction:thread-1:turn-1:compact-1",
        __openclaw: { runId: "run-1", itemId: "compact-1" },
      },
    });
    expect(publishUpdate).toHaveBeenCalledOnce();
    expect(publishUpdate.mock.calls[0]?.[0]).toMatchObject({
      update: {
        messageId: "activity-message",
        runId: "run-1",
      },
    });
  });

  it("records an available post-compaction usage boundary when the app-server reported a count", async () => {
    appendMessage.mockImplementationOnce(async (params: { message: unknown }) => ({
      appended: true,
      message: params.message,
      messageId: "activity-message",
    }));
    const params = {
      runId: "run-1",
      sessionTarget: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:dashboard:session-1",
        storePath: "/state/openclaw-agent.sqlite",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "compact-1",
      timestamp: 123,
      usageAfter: { state: "available", promptTokens: 80, totalTokens: 100 },
    } as Parameters<typeof persistCodexContextCompactionActivity>[0];

    await persistCodexContextCompactionActivity(params);

    expect(appendMessage.mock.calls[0]?.[0]?.message).toMatchObject({
      role: "custom",
      customType: "openclaw.context-compaction",
      usage: {
        contextUsage: { state: "available", promptTokens: 80, totalTokens: 100 },
      },
    });
  });

  it("records an explicit unavailable boundary when the post-compaction count is unknown", async () => {
    appendMessage.mockImplementationOnce(async (params: { message: unknown }) => ({
      appended: true,
      message: params.message,
      messageId: "activity-message",
    }));
    const params = {
      sessionTarget: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:dashboard:session-1",
        storePath: "/state/openclaw-agent.sqlite",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "compact-1",
      timestamp: 123,
      usageAfter: { state: "unavailable" },
    } as Parameters<typeof persistCodexContextCompactionActivity>[0];

    await persistCodexContextCompactionActivity(params);

    expect(appendMessage.mock.calls[0]?.[0]?.message).toMatchObject({
      role: "custom",
      customType: "openclaw.context-compaction",
      usage: {
        contextUsage: { state: "unavailable" },
      },
    });
  });

  it("omits the usage boundary when none was supplied", async () => {
    appendMessage.mockImplementationOnce(async (params: { message: unknown }) => ({
      appended: true,
      message: params.message,
      messageId: "activity-message",
    }));
    const params = {
      sessionTarget: {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:dashboard:session-1",
        storePath: "/state/openclaw-agent.sqlite",
      },
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "compact-1",
      timestamp: 123,
    } as Parameters<typeof persistCodexContextCompactionActivity>[0];

    await persistCodexContextCompactionActivity(params);

    const message = appendMessage.mock.calls[0]?.[0]?.message as Record<string, unknown>;
    expect(message.role).toBe("custom");
    expect(message).not.toHaveProperty("usage");
  });
});
