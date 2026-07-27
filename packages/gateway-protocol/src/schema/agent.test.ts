// Gateway Protocol tests cover agent behavior.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AgentParamsSchema,
  ConversationListParamsSchema,
  ConversationListResultSchema,
  ConversationSendParamsSchema,
  ConversationSendResultSchema,
  ConversationTurnCancelParamsSchema,
  ConversationTurnCancelResultSchema,
  ConversationTurnParamsSchema,
  ConversationTurnResultSchema,
  MessageActionParamsSchema,
} from "./agent.js";

/**
 * Regression coverage for agent-run schema payloads that carry internal
 * completion events. These events are produced by child automation and consumed
 * by parent agent runs, so the fixture mirrors the cross-runtime boundary.
 */
type AgentInternalEvent = {
  type: "task_completion";
  source: string;
  childSessionKey: string;
  childSessionId: string;
  announceType: string;
  taskLabel: string;
  status: "ok" | "error";
  statusLabel: string;
  result: string;
  attachments?: unknown[];
  mediaUrls?: string[];
  replyInstruction?: string;
};

/** Builds the smallest valid agent request that embeds one internal event. */
function makeAgentParamsWithInternalEvent(event: AgentInternalEvent) {
  return {
    message: "A music generation task finished. Process the completion update now.",
    sessionKey: "agent:main:discord:channel:1456744319972282449",
    internalEvents: [event],
    idempotencyKey: "music_generate:task-123:ok",
  };
}

/** Representative generated-media completion event from a child task. */
const musicCompletionEvent: AgentInternalEvent = {
  type: "task_completion",
  source: "music_generation",
  childSessionKey: "music_generate:task-123",
  childSessionId: "task-123",
  announceType: "music generation task",
  taskLabel: "OpenClaw release anthem",
  status: "ok",
  statusLabel: "completed successfully",
  result: "Generated 1 track.",
  attachments: [
    {
      type: "audio",
      path: "/tmp/openclaw/generated-release-anthem.mp3",
      mimeType: "audio/mpeg",
      name: "generated-release-anthem.mp3",
    },
  ],
  mediaUrls: ["/tmp/openclaw/generated-release-anthem.mp3"],
  replyInstruction: "Deliver the generated music.",
};

describe("AgentParamsSchema", () => {
  it("accepts cache-only idempotent replay requests", () => {
    expect(
      Value.Check(AgentParamsSchema, {
        message: "recover",
        idempotencyKey: "recovery-1",
        replayOnly: true,
        replayCapability: "test-capability-placeholder",
      }),
    ).toBe(true);
  });

  it("accepts the backend expected-session binding", () => {
    expect(
      Value.Check(AgentParamsSchema, {
        message: "resume",
        sessionKey: "agent:main:main",
        expectedExistingSessionId: "session-1",
        idempotencyKey: "recovery-1",
      }),
    ).toBe(true);
  });

  it("rejects host-owned delivery media constraints from public requests", () => {
    expect(
      Value.Check(AgentParamsSchema, {
        message: "deliver generated media",
        sessionKey: "agent:main:main",
        internalDeliveryMediaUrls: ["/tmp/proof.png"],
        idempotencyKey: "delivery-1",
      }),
    ).toBe(false);
  });

  it("accepts generated music attachments on internal completion events", () => {
    const params = makeAgentParamsWithInternalEvent(musicCompletionEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(true);
  });

  it("keeps task completion internal events strict", () => {
    const params = makeAgentParamsWithInternalEvent({
      ...musicCompletionEvent,
      unexpected: true,
    } as AgentInternalEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(false);
  });

  it("rejects malformed generated attachment entries on internal events", () => {
    const params = makeAgentParamsWithInternalEvent({
      ...musicCompletionEvent,
      attachments: [null],
    } as unknown as AgentInternalEvent);

    expect(Value.Check(AgentParamsSchema, params)).toBe(false);
  });
});

describe("MessageActionParamsSchema", () => {
  const baseParams = {
    channel: "matrix",
    action: "read",
    params: {},
    idempotencyKey: "idem-1",
  };

  it("accepts only the operation-local direct-operator marker", () => {
    expect(
      Value.Check(MessageActionParamsSchema, {
        ...baseParams,
        conversationReadOrigin: "direct-operator",
      }),
    ).toBe(true);
    expect(
      Value.Check(MessageActionParamsSchema, {
        ...baseParams,
        conversationReadOrigin: "delegated",
      }),
    ).toBe(false);
  });

  it("rejects caller-supplied current chat classification", () => {
    expect(
      Value.Check(MessageActionParamsSchema, {
        ...baseParams,
        toolContext: {
          currentChannelId: "!room:example.org",
          currentChatType: "direct",
        },
      }),
    ).toBe(false);
  });
});

describe("Conversation schemas", () => {
  it("accepts Gateway-owned address discovery without session internals", () => {
    expect(
      Value.Check(ConversationListParamsSchema, {
        agentId: "main",
        channel: "reef",
        query: "@molty",
        limit: 50,
      }),
    ).toBe(true);
    expect(
      Value.Check(ConversationListResultSchema, {
        conversations: [
          {
            conversationRef: "conv_0123456789abcdef0123456789abcdef",
            channel: "reef",
            accountId: "default",
            kind: "direct",
            target: "reef:molty",
            label: "@molty's agent",
            firstSeenAt: 100,
            lastSeenAt: 100,
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts a Gateway-owned durable send and result", () => {
    expect(
      Value.Check(ConversationSendParamsSchema, {
        agentId: "main",
        sourceSessionKey: "agent:main:telegram:direct:operator",
        operationId: "conversation-send-1",
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        message: "hello",
      }),
    ).toBe(true);
    expect(
      Value.Check(ConversationSendResultSchema, {
        status: "sent",
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        channel: "reef",
        messageId: "01JZ0000000000000000000200",
        queueId: "conversation-send-1",
      }),
    ).toBe(true);
  });

  it("accepts a Gateway-owned correlated turn and its inline reply", () => {
    expect(
      Value.Check(ConversationTurnParamsSchema, {
        agentId: "main",
        sourceSessionKey: "agent:main:telegram:direct:operator",
        turnId: "conversation-turn-1",
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        message: "hello",
        timeoutMs: 30_000,
      }),
    ).toBe(true);
    expect(
      Value.Check(ConversationTurnResultSchema, {
        status: "replied",
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        channel: "reef",
        messageId: "01JZ0000000000000000000200",
        correlationPersisted: true,
        reply: {
          conversationRef: "conv_0123456789abcdef0123456789abcdef",
          messageId: "01JZ0000000000000000000201",
          replyToId: "01JZ0000000000000000000200",
          text: "hello back",
          timestamp: 123,
        },
      }),
    ).toBe(true);
  });

  it("accepts explicit cancellation for an abandoned Gateway-owned turn", () => {
    expect(
      Value.Check(ConversationTurnCancelParamsSchema, {
        agentId: "main",
        turnId: "conversation-turn-1",
      }),
    ).toBe(true);
    expect(Value.Check(ConversationTurnCancelParamsSchema, { turnId: "conversation-turn-1" })).toBe(
      false,
    );
    expect(Value.Check(ConversationTurnCancelResultSchema, { cancelled: true })).toBe(true);
  });

  it("represents durable queued delivery without claiming an inline reply", () => {
    const queued = {
      status: "queued",
      conversationRef: "conv_0123456789abcdef0123456789abcdef",
      channel: "reef",
      messageId: "01JZ0000000000000000000200",
      correlationPersisted: true,
      error: "Delivery is queued",
    };
    expect(Value.Check(ConversationTurnResultSchema, queued)).toBe(true);
    expect(Value.Check(ConversationTurnResultSchema, { ...queued, status: "retrying" })).toBe(
      false,
    );
  });
});
