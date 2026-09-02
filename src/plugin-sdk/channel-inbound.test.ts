/**
 * Tests channel inbound context and dispatch helper behavior.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  configureChannelAdmissionEvidenceCollection,
  readChannelContextAdmissionEvidence,
} from "../channels/message-access/admission-evidence.js";
import {
  buildChannelInboundEventContext,
  buildChannelTurnContext,
  type BuildChannelInboundEventContextParams,
  type PluginHookChannelSenderContext,
} from "./channel-inbound.js";
import * as channelIngressRuntime from "./channel-ingress-runtime.js";

declare module "./channel-inbound.js" {
  interface PluginHookChannelSenderContext {
    testUnionId?: string;
  }
}

function createInboundParams(
  overrides: Partial<BuildChannelInboundEventContextParams> = {},
): BuildChannelInboundEventContextParams {
  return {
    channel: "test",
    messageId: "msg-1",
    from: "test:user:u1",
    sender: { id: "u1" },
    conversation: {
      kind: "group",
      id: "room-1",
    },
    route: {
      agentId: "main",
      routeSessionKey: "agent:main:test:group:room-1",
    },
    reply: {
      to: "test:room:room-1",
    },
    message: {
      rawBody: "side chatter",
      inboundEventKind: "room_event",
    },
    ...overrides,
  };
}

describe("channel-inbound public helpers", () => {
  it("builds inbound event kind into message context", async () => {
    const ctx = buildChannelInboundEventContext(createInboundParams());

    expect(ctx.InboundEventKind).toBe("room_event");
  });

  it("accepts plugin-augmented hook channel sender fields", () => {
    expectTypeOf<PluginHookChannelSenderContext["testUnionId"]>().toEqualTypeOf<
      string | undefined
    >();
    const sender = {
      id: "u1",
      testUnionId: "union-1",
    } satisfies PluginHookChannelSenderContext;
    expect(sender.testUnionId).toBe("union-1");
    const channelContext = {
      sender: {
        id: "u1",
        testUnionId: "union-1",
      },
    } satisfies NonNullable<BuildChannelInboundEventContextParams["channelContext"]>;
    const ctx = buildChannelInboundEventContext(
      createInboundParams({
        channelContext,
      }),
    );

    expect(ctx.ChannelContext?.sender?.testUnionId).toBe("union-1");
  });

  it("does not expose public participant evidence authority", () => {
    expect(channelIngressRuntime).not.toHaveProperty("createChannelParticipantAdmissionEvidence");
    expect(channelIngressRuntime).not.toHaveProperty("copyChannelParticipantAdmissionEvidence");
  });

  it("keeps public resolver and builder paths non-authoritative", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const channelIngress = await channelIngressRuntime.resolveStableChannelMessageIngress({
        channelId: "test",
        accountId: "default",
        subject: { stableId: "u1" },
        conversation: { kind: "group", id: "room-1" },
        dmPolicy: "open",
        groupPolicy: "open",
      });
      const ctx = buildChannelTurnContext({
        ...createInboundParams({ channelIngress }),
        message: {
          rawBody: "hello",
          inboundTurnKind: "user_request",
        },
      });

      expect(ctx.InboundTurnKind).toBe("user_request");
      expect(readChannelContextAdmissionEvidence(ctx)).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
