import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, deliverSubagentAnnouncement } from "./subagent-announce-delivery.js";
import { callGateway as runtimeCallGateway } from "./subagent-announce-delivery.runtime.js";
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

function createGatewayMock() {
  return vi.fn(async () => ({}) as Record<string, unknown>) as unknown as typeof runtimeCallGateway;
}

async function deliverSlackThreadAnnouncement(params: {
  callGateway: typeof runtimeCallGateway;
  isActive: boolean;
  sessionId: string;
  expectsCompletionMessage: boolean;
  directIdempotencyKey: string;
  queueEmbeddedPiMessage?: (sessionId: string, message: string) => boolean;
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
