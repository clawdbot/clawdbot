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
        __openclaw: { runId: "run-1" },
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
});
