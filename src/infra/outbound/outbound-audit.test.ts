import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onTrustedMessageAuditEvent,
  resetMessageAuditEventsForTest,
  type TrustedMessageAuditEvent,
} from "../../audit/message-audit-events.js";
import {
  completedOutboundAuditTerminals,
  emitOutboundAuditTerminals,
  uniformOutboundAuditTerminals,
} from "./outbound-audit.js";

describe("outbound audit projection", () => {
  beforeEach(() => resetMessageAuditEventsForTest());
  afterEach(() => resetMessageAuditEventsForTest());

  it("keeps mixed logical payloads distinct under one durable queue intent", () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    try {
      emitOutboundAuditTerminals({
        context: {
          channel: "matrix",
          to: "!room:target",
          payloads: [{ text: "suppressed" }, { text: "sent" }],
          session: { conversationKind: "channel" },
          mirror: { sessionKey: "secret-session", agentId: "mirror-agent", isGroup: true },
        },
        terminals: () =>
          completedOutboundAuditTerminals({
            payloadCount: 2,
            results: [{ channel: "matrix", messageId: "platform-1" }],
            payloadOutcomes: [
              { index: 0, status: "suppressed", reason: "no_visible_payload" },
              {
                index: 1,
                status: "sent",
                deliveryKind: "media",
                results: [{ channel: "matrix", messageId: "platform-1" }],
              },
            ],
          }),
        startedAt: Date.now(),
        queueId: "queue-1",
      });
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.sourceId)).toEqual([
      "message:outbound:queue:queue-1:payload:0",
      "message:outbound:queue:queue-1:payload:1",
    ]);
    expect(events.map((event) => event.outcome)).toEqual(["suppressed", "sent"]);
    expect(events[0]).toMatchObject({
      status: "blocked",
      actorType: "agent",
      actorId: "mirror-agent",
      agentId: "mirror-agent",
      conversationKind: "channel",
      resultCount: 0,
    });
    expect(events[0]).not.toHaveProperty("deliveryKind");
    expect(events[1]).toMatchObject({
      status: "succeeded",
      deliveryKind: "media",
      messageId: "platform-1",
      resultCount: 1,
    });
    expect(JSON.stringify(events)).not.toContain("secret-session");
  });

  it("does not resolve terminal metadata without an active listener", () => {
    const resolveTerminals = vi.fn(() => []);
    emitOutboundAuditTerminals({
      context: { channel: "matrix", to: "!room:target", payloads: [{ text: "secret" }] },
      terminals: resolveTerminals,
      startedAt: Date.now(),
    });
    expect(resolveTerminals).not.toHaveBeenCalled();
  });

  it("isolates terminal projection failures from delivery", () => {
    const unsubscribe = onTrustedMessageAuditEvent(() => {});
    try {
      expect(() =>
        emitOutboundAuditTerminals({
          context: { channel: "matrix", to: "!room:target", payloads: [{ text: "sent" }] },
          terminals: () => {
            throw new Error("bad terminal projection");
          },
          startedAt: Date.now(),
        }),
      ).not.toThrow();

      expect(() =>
        emitOutboundAuditTerminals({
          context: { channel: "matrix", to: "!room:target", payloads: [{ text: "sent" }] },
          terminals: uniformOutboundAuditTerminals(1, {
            outcome: "sent",
            results: [
              {
                channel: "matrix",
                messageId: "platform-1",
                receipt: {} as never,
              },
            ],
          }),
          startedAt: Date.now(),
        }),
      ).not.toThrow();
    } finally {
      unsubscribe();
    }
  });

  it("preserves unknown delivery state without inventing a failure code", () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    try {
      emitOutboundAuditTerminals({
        context: { channel: "matrix", to: "!room:target", payloads: [{ text: "sent?" }] },
        terminals: uniformOutboundAuditTerminals(1, {
          outcome: "unknown",
          failureStage: "platform_send",
        }),
        startedAt: Date.now(),
      });
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "unknown",
      outcome: "unknown",
      failureStage: "platform_send",
      resultCount: 0,
    });
    expect(events[0]).not.toHaveProperty("errorCode");
  });

  it("treats a missing adapter identity as unknown rather than a proven suppression", () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    try {
      emitOutboundAuditTerminals({
        context: { channel: "matrix", to: "!room:target", payloads: [{ text: "sent?" }] },
        terminals: completedOutboundAuditTerminals({
          payloadCount: 1,
          results: [],
          payloadOutcomes: [
            { index: 0, status: "suppressed", reason: "adapter_returned_no_identity" },
          ],
        }),
        startedAt: Date.now(),
      });
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "unknown",
      outcome: "unknown",
      failureStage: "platform_send",
      resultCount: 0,
    });
    expect(events[0]).not.toHaveProperty("reasonCode");
    expect(events[0]).not.toHaveProperty("deliveryKind");
  });

  it("counts physical sends once across receipt representations and result fallbacks", () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    try {
      emitOutboundAuditTerminals({
        context: { channel: "matrix", to: "!room:target", payloads: [{ text: "batch" }] },
        terminals: uniformOutboundAuditTerminals(1, {
          outcome: "sent",
          results: [
            {
              channel: "matrix",
              messageId: "aggregate-with-parts",
              receipt: {
                primaryPlatformMessageId: "part-1",
                platformMessageIds: ["part-1", "part-2"],
                parts: [
                  { platformMessageId: "part-1", kind: "text", index: 0 },
                  { platformMessageId: "part-2", kind: "text", index: 1 },
                ],
                sentAt: Date.now(),
              },
            },
            {
              channel: "matrix",
              messageId: "aggregate-with-ids",
              receipt: {
                platformMessageIds: ["id-1", "id-2", "id-3"],
                parts: [],
                sentAt: Date.now(),
              },
            },
            { channel: "matrix", messageId: "single-result" },
          ],
        }),
        startedAt: Date.now(),
      });
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "succeeded",
      outcome: "sent",
      resultCount: 6,
    });
  });

  it("normalizes a routed target used as the fallback conversation identifier", () => {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    try {
      emitOutboundAuditTerminals({
        context: {
          channel: "discord",
          to: "discord:channel:123456789",
          payloads: [{ text: "sent" }],
        },
        terminals: uniformOutboundAuditTerminals(1, {
          outcome: "sent",
          results: [{ channel: "discord", messageId: "message-1" }],
        }),
        startedAt: Date.now(),
      });
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      conversationId: "123456789",
      targetId: "discord:channel:123456789",
    });
  });

  function conversationKindFor(
    context: Omit<Parameters<typeof emitOutboundAuditTerminals>[0]["context"], "payloads">,
  ): string | undefined {
    const events: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => events.push(event));
    try {
      emitOutboundAuditTerminals({
        context: { ...context, payloads: [{ text: "x" }] },
        terminals: uniformOutboundAuditTerminals(1, {
          outcome: "sent",
          results: [{ channel: context.channel, messageId: "m-1" }],
        }),
        startedAt: Date.now(),
      });
    } finally {
      unsubscribe();
    }
    return events[0]?.conversationKind;
  }

  it("classifies direct only from a session route naming this exact destination", () => {
    expect(
      conversationKindFor({
        channel: "matrix",
        to: "@user:server",
        session: { key: "agent:main:matrix:default:direct:@user:server" },
      }),
    ).toBe("direct");
    expect(
      conversationKindFor({
        channel: "slack",
        to: "channel:C0AGENT",
        session: { key: "agent:main:slack:channel:c0agent" },
      }),
    ).toBe("channel");
    // Channel-name-prefixed targets (telegram:999) must match route peer 999.
    expect(
      conversationKindFor({
        channel: "telegram",
        to: "telegram:999",
        session: { key: "agent:main:telegram:default:direct:999" },
      }),
    ).toBe("direct");
    // An explicit group target must never validate a direct route.
    expect(
      conversationKindFor({
        channel: "slack",
        to: "group:123",
        session: { key: "agent:main:slack:default:direct:123" },
      }),
    ).toBe("unknown");
    // The full canonical prefix grammar applies: room: is a group fact even
    // when the direct route's peer id literally contains the prefix.
    expect(
      conversationKindFor({
        channel: "matrix",
        to: "room:123",
        session: { key: "agent:main:matrix:default:direct:room:123" },
      }),
    ).toBe("unknown");
    // Nested provider+kind prefixes normalize in layers: discord:dm:123 -> 123.
    expect(
      conversationKindFor({
        channel: "discord",
        to: "discord:dm:123",
        session: { key: "agent:main:discord:dm:123" },
      }),
    ).toBe("direct");
    // direct: is in the kind map even though the canonical strip default omits it.
    expect(
      conversationKindFor({
        channel: "whatsapp",
        to: "direct:+15551234567",
        session: { key: "agent:main:whatsapp:default:direct:+15551234567" },
      }),
    ).toBe("direct");
  });

  it("does not classify by a policy session that names another conversation", () => {
    // Native command acting on a WhatsApp DM session, response delivered to a
    // Matrix room: the acted-on session must not stamp the destination "direct".
    expect(
      conversationKindFor({
        channel: "matrix",
        to: "!room:server",
        session: {
          key: "agent:main:matrix:default:direct:@user:server",
          policyKey: "agent:main:whatsapp:default:direct:+15551234567",
          conversationType: "direct",
        },
      }),
    ).toBe("unknown");
  });

  it("lets weak origin facts escalate to group but never to direct", () => {
    expect(
      conversationKindFor({
        channel: "matrix",
        to: "!room:server",
        mirror: { sessionKey: "control-session", agentId: "a", isGroup: true },
      }),
    ).toBe("group");
    expect(
      conversationKindFor({
        channel: "matrix",
        to: "!room:server",
        mirror: { sessionKey: "control-session", agentId: "a", isGroup: false },
      }),
    ).toBe("unknown");
  });
});
