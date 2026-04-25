import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentInternalEvent } from "./internal-events.js";
import {
  __testing,
  deliverSubagentAnnouncement,
  extractThreadCompletionFallbackText,
} from "./subagent-announce-delivery.js";
import {
  callGateway as runtimeCallGateway,
  sendMessage as runtimeSendMessage,
} from "./subagent-announce-delivery.runtime.js";
import { resolveAnnounceOrigin } from "./subagent-announce-origin.js";

afterEach(() => {
  __testing.setDepsForTest();
});

const slackThreadOrigin = {
  channel: "slack",
  to: "channel:C123",
  accountId: "acct-1",
  threadId: "171.222",
} as const;

function createGatewayMock(response: Record<string, unknown> = {}) {
  return vi.fn(async () => response) as unknown as typeof runtimeCallGateway;
}

function createSendMessageMock() {
  return vi.fn(async () => ({
    channel: "slack",
    to: "channel:C123",
    via: "direct" as const,
    mediaUrl: null,
    result: { messageId: "msg-1" },
  })) as unknown as typeof runtimeSendMessage;
}

async function deliverSlackThreadAnnouncement(params: {
  callGateway: typeof runtimeCallGateway;
  isActive: boolean;
  sessionId: string;
  expectsCompletionMessage: boolean;
  directIdempotencyKey: string;
  queueEmbeddedPiMessage?: (sessionId: string, message: string) => boolean;
  sendMessage?: typeof runtimeSendMessage;
  internalEvents?: AgentInternalEvent[];
}) {
  __testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: params.sessionId,
      isActive: params.isActive,
    }),
    loadConfig: () => ({}) as never,
    ...(params.queueEmbeddedPiMessage
      ? { queueEmbeddedPiMessage: params.queueEmbeddedPiMessage }
      : {}),
    ...(params.sendMessage ? { sendMessage: params.sendMessage } : {}),
  });

  return deliverSubagentAnnouncement({
    requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
    targetRequesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
    triggerMessage: "child done",
    steerMessage: "child done",
    requesterOrigin: slackThreadOrigin,
    requesterSessionOrigin: slackThreadOrigin,
    completionDirectOrigin: slackThreadOrigin,
    directOrigin: slackThreadOrigin,
    requesterIsSubagent: false,
    expectsCompletionMessage: params.expectsCompletionMessage,
    bestEffortDeliver: true,
    directIdempotencyKey: params.directIdempotencyKey,
    internalEvents: params.internalEvents,
  });
}

describe("resolveAnnounceOrigin threaded route targets", () => {
  it("preserves stored thread ids when requester origin omits one for the same chat", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "topicchat",
          lastTo: "topicchat:room-a:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "topicchat",
          to: "topicchat:room-a",
        },
      ),
    ).toEqual({
      channel: "topicchat",
      to: "topicchat:room-a",
      threadId: 99,
    });
  });

  it("preserves stored thread ids for group-prefixed requester targets", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "topicchat",
          lastTo: "topicchat:room-a:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "topicchat",
          to: "group:room-a",
        },
      ),
    ).toEqual({
      channel: "topicchat",
      to: "group:room-a",
      threadId: 99,
    });
  });

  it("still strips stale thread ids when the stored route points at a different chat", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "topicchat",
          lastTo: "topicchat:room-b:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "topicchat",
          to: "topicchat:room-a",
        },
      ),
    ).toEqual({
      channel: "topicchat",
      to: "topicchat:room-a",
    });
  });
});

describe("deliverSubagentAnnouncement completion delivery", () => {
  it("keeps completion announces session-internal while preserving route context for active requesters", async () => {
    const callGateway = createGatewayMock();
    const queueEmbeddedPiMessage = vi.fn(() => true);
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-1",
      isActive: true,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-1",
      queueEmbeddedPiMessage,
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "steered",
      }),
    );
    expect(queueEmbeddedPiMessage).toHaveBeenCalledWith("requester-session-1", "child done");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("keeps direct external delivery for dormant completion requesters", async () => {
    const callGateway = createGatewayMock();
    await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-2",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-1b",
    });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          deliver: true,
          channel: "slack",
          accountId: "acct-1",
          to: "channel:C123",
          threadId: "171.222",
          bestEffortDeliver: true,
        }),
      }),
    );
  });

  it("keeps announce-agent delivery primary for dormant completion events with child output", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [{ text: "requester voice completion" }],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-4",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-thread-fallback-1",
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "thread completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "direct",
      }),
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          deliver: true,
          channel: "slack",
          accountId: "acct-1",
          to: "channel:C123",
          threadId: "171.222",
          bestEffortDeliver: true,
          internalEvents: expect.any(Array),
        }),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("uses a direct thread fallback when announce-agent delivery fails", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("UNAVAILABLE: gateway lost final output");
    }) as unknown as typeof runtimeCallGateway;
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-4",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-thread-fallback-1",
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "thread completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "direct-thread-fallback",
      }),
    );
    expect(callGateway).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "acct-1",
        to: "channel:C123",
        threadId: "171.222",
        content: "child completion output",
        requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
        bestEffort: true,
        idempotencyKey: "announce-thread-fallback-1",
      }),
    );
  });

  it("uses a direct thread fallback when announce-agent returns no visible output", async () => {
    const callGateway = createGatewayMock({
      result: {
        payloads: [],
      },
    });
    const sendMessage = createSendMessageMock();
    const result = await deliverSlackThreadAnnouncement({
      callGateway,
      sendMessage,
      sessionId: "requester-session-4",
      isActive: false,
      expectsCompletionMessage: true,
      directIdempotencyKey: "announce-thread-fallback-empty",
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          childSessionId: "child-session-id",
          announceType: "subagent task",
          taskLabel: "thread completion smoke",
          status: "ok",
          statusLabel: "completed successfully",
          result: "child completion output",
          replyInstruction: "Summarize the result.",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        delivered: true,
        path: "direct-thread-fallback",
      }),
    );
    expect(callGateway).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "child completion output",
        idempotencyKey: "announce-thread-fallback-empty",
      }),
    );
  });

  it("keeps direct external delivery for non-completion announces", async () => {
    const callGateway = createGatewayMock();
    await deliverSlackThreadAnnouncement({
      callGateway,
      sessionId: "requester-session-3",
      isActive: false,
      expectsCompletionMessage: false,
      directIdempotencyKey: "announce-2",
    });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          deliver: true,
          channel: "slack",
          accountId: "acct-1",
          to: "channel:C123",
          threadId: "171.222",
          bestEffortDeliver: true,
        }),
      }),
    );
  });
});

describe("extractThreadCompletionFallbackText", () => {
  it("prefers task completion result text", () => {
    expect(
      extractThreadCompletionFallbackText([
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          announceType: "subagent task",
          taskLabel: "sample task",
          status: "ok",
          statusLabel: "completed successfully",
          result: "final child result",
          replyInstruction: "Summarize the result.",
        },
      ]),
    ).toBe("final child result");
  });

  it("falls back to task and status labels when result text is empty", () => {
    expect(
      extractThreadCompletionFallbackText([
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          announceType: "subagent task",
          taskLabel: "sample task",
          status: "ok",
          statusLabel: "completed successfully",
          result: "   ",
          replyInstruction: "Summarize the result.",
        },
      ]),
    ).toBe("sample task: completed successfully");
  });

  it("falls back to the task label when result and status label are empty", () => {
    expect(
      extractThreadCompletionFallbackText([
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: "agent:worker:subagent:child",
          announceType: "subagent task",
          taskLabel: "sample task",
          status: "ok",
          statusLabel: "   ",
          result: "   ",
          replyInstruction: "Summarize the result.",
        },
      ]),
    ).toBe("sample task");
  });
});
