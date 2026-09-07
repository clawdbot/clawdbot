// Voice Call tests cover inbound event policy and routing behavior.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "../config.js";
import {
  createEventManagerHarness,
  EVENT_MANAGER_REPLAY_KEY_LIMIT,
} from "../manager.test-harness.js";
import type { AnswerCallInput, CallRecord, NormalizedEvent } from "../types.js";
import { processEvent } from "./events.js";

const {
  cleanup,
  createContext,
  createInboundDisabledConfig,
  createInboundInitiatedEvent,
  createProvider,
  createRejectingInboundContext,
  installStateRuntime,
  requireFirstActiveCall,
  setup,
} = createEventManagerHarness();

beforeEach(() => {
  setup();
});

afterEach(() => {
  cleanup();
});

describe("processEvent (functional inbound calls)", () => {
  it.each(["created", "rejected"] as const)(
    "does not publish %s inbound calls before SQLite persistence succeeds",
    (kind) => {
      let failPersistence = true;
      installStateRuntime(() => failPersistence);
      const { ctx, hangupCalls } = createRejectingInboundContext();
      ctx.config.inboundPolicy = kind === "created" ? "open" : "disabled";
      const event = createInboundInitiatedEvent({
        id: `event-durable-${kind}`,
        providerCallId: `provider-durable-${kind}`,
        from: "+15550000002",
      });

      expect(() => processEvent(ctx, event)).toThrow("synthetic SQLite persistence failure");
      expect(ctx.activeCalls.size).toBe(0);
      expect(ctx.providerCallIdMap.size).toBe(0);
      expect(ctx.rejectedProviderCallIds.size).toBe(0);
      expect(ctx.processedEventIds.size).toBe(0);
      expect(hangupCalls).toHaveLength(0);

      failPersistence = false;
      expect(processEvent(ctx, event)).toEqual({ kind: "processed" });
      expect(ctx.activeCalls.size).toBe(kind === "created" ? 1 : 0);
      expect(hangupCalls).toHaveLength(kind === "rejected" ? 1 : 0);
    },
  );

  it("calls provider hangup when rejecting inbound call", () => {
    const { ctx, hangupCalls } = createRejectingInboundContext();
    const event = createInboundInitiatedEvent({
      id: "evt-1",
      providerCallId: "prov-1",
      from: "+15559999999",
    });

    processEvent(ctx, event);

    expect(ctx.activeCalls.size).toBe(0);
    expect(hangupCalls).toHaveLength(1);
    expect(hangupCalls[0]).toEqual({
      callId: "prov-1",
      providerCallId: "prov-1",
      reason: "hangup-bot",
    });
  });

  it("does not call hangup when provider is null", () => {
    const ctx = createContext({
      config: createInboundDisabledConfig(),
      provider: null,
    });
    const event = createInboundInitiatedEvent({
      id: "evt-2",
      providerCallId: "prov-2",
      from: "+15551111111",
    });

    processEvent(ctx, event);

    expect(ctx.activeCalls.size).toBe(0);
  });

  it("calls hangup only once for duplicate events for same rejected call", () => {
    const { ctx, hangupCalls } = createRejectingInboundContext();
    const event1 = createInboundInitiatedEvent({
      id: "evt-init",
      providerCallId: "prov-dup",
      from: "+15552222222",
    });
    const event2: NormalizedEvent = {
      id: "evt-ring",
      type: "call.ringing",
      callId: "prov-dup",
      providerCallId: "prov-dup",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15552222222",
      to: "+15550000000",
    };

    processEvent(ctx, event1);
    processEvent(ctx, event2);

    expect(ctx.activeCalls.size).toBe(0);
    expect(hangupCalls).toEqual([
      {
        callId: "prov-dup",
        providerCallId: "prov-dup",
        reason: "hangup-bot",
      },
    ]);
  });

  it("answers accepted inbound calls when the provider requires an answer command", () => {
    const answerCalls: AnswerCallInput[] = [];
    const provider = createProvider({
      answerCall: async (input: AnswerCallInput): Promise<void> => {
        answerCalls.push(input);
      },
    });
    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "telnyx",
        fromNumber: "+15550000000",
        inboundPolicy: "open",
        telnyx: {
          apiKey: "KEY123",
          connectionId: "CONN456",
        },
        skipSignatureVerification: true,
      }),
      provider,
    });
    const event = createInboundInitiatedEvent({
      id: "evt-answer",
      providerCallId: "call-control-1",
      from: "+15552222222",
    });

    processEvent(ctx, event);

    const call = requireFirstActiveCall(ctx);
    expect(answerCalls).toEqual([
      {
        callId: call.callId,
        providerCallId: "call-control-1",
      },
    ]);
  });

  it("removes active call even when hangup rejects", () => {
    const provider = createProvider({
      hangupCall: async (): Promise<void> => {
        throw new Error("provider down");
      },
    });
    const ctx = createContext({
      config: createInboundDisabledConfig(),
      provider,
    });
    const event = createInboundInitiatedEvent({
      id: "evt-fail",
      providerCallId: "prov-fail",
      from: "+15553333333",
    });

    processEvent(ctx, event);
    expect(ctx.activeCalls.size).toBe(0);
  });

  it("preserves inbound direction for auto-registered inbound calls", () => {
    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        inboundPolicy: "open",
      }),
    });
    const event: NormalizedEvent = {
      id: "evt-inbound-dir",
      type: "call.initiated",
      callId: "CA-inbound-789",
      providerCallId: "CA-inbound-789",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15554444444",
      to: "+15550000000",
    };

    processEvent(ctx, event);

    expect(ctx.activeCalls.size).toBe(1);
    const call = requireFirstActiveCall(ctx);
    expect(call.direction).toBe("inbound");
  });

  it.each([
    {
      sessionScope: "per-call",
      coreSession: undefined,
      expectedSessionKey: (call: CallRecord) => `agent:main:voice:call:${call.callId}`,
    },
    {
      sessionScope: "main",
      coreSession: { mainKey: "work" },
      expectedSessionKey: () => "agent:main:work",
    },
  ])(
    "assigns $sessionScope session keys to inbound calls",
    ({ sessionScope, coreSession, expectedSessionKey }) => {
      const ctx = createContext({
        config: VoiceCallConfigSchema.parse({
          enabled: true,
          provider: "plivo",
          fromNumber: "+15550000000",
          inboundPolicy: "open",
          sessionScope,
        }),
        coreSession,
      });
      const event: NormalizedEvent = {
        id: "evt-inbound-session-scope",
        type: "call.initiated",
        callId: "CA-inbound-session-scope",
        providerCallId: "CA-inbound-session-scope",
        timestamp: Date.now(),
        direction: "inbound",
        from: "+15554444444",
        to: "+15550000000",
      };

      processEvent(ctx, event);

      const call = requireFirstActiveCall(ctx);
      expect(call.sessionKey).toBe(expectedSessionKey(call));
    },
  );

  it("applies per-number inbound greeting and stores the matched route key", () => {
    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        inboundPolicy: "open",
        inboundGreeting: "Hello from global.",
        numbers: {
          "+15550002222": {
            agentId: "cards",
            inboundGreeting: "Silver Fox Cards, how can I help?",
          },
        },
      }),
    });
    const event: NormalizedEvent = {
      id: "evt-inbound-number-route",
      type: "call.initiated",
      callId: "CA-inbound-number-route",
      providerCallId: "CA-inbound-number-route",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15554444444",
      to: "+1 (555) 000-2222",
    };

    processEvent(ctx, event);

    const call = requireFirstActiveCall(ctx);
    expect(call.metadata?.initialMessage).toBe("Silver Fox Cards, how can I help?");
    expect(call.metadata?.numberRouteKey).toBe("+15550002222");
    expect(call.agentId).toBe("cards");
  });

  it("bounds rejected provider calls while retaining hangup-once behavior", () => {
    const rejectedProviderCallIds = new Map<string, symbol>(
      Array.from(
        { length: EVENT_MANAGER_REPLAY_KEY_LIMIT },
        (_, index) => [`provider-${index}`, Symbol(`provider-${index}`)] as const,
      ),
    );
    const { ctx, hangupCalls } = createRejectingInboundContext();
    ctx.rejectedProviderCallIds = rejectedProviderCallIds;

    processEvent(
      ctx,
      createInboundInitiatedEvent({
        id: "evt-rejected-new",
        providerCallId: "provider-new",
        from: "+15552222222",
      }),
    );
    processEvent(
      ctx,
      createInboundInitiatedEvent({
        id: "evt-rejected-new-replay",
        providerCallId: "provider-new",
        from: "+15552222222",
      }),
    );

    expect(ctx.rejectedProviderCallIds.size).toBe(EVENT_MANAGER_REPLAY_KEY_LIMIT);
    expect(ctx.rejectedProviderCallIds.has("provider-0")).toBe(false);
    expect(ctx.rejectedProviderCallIds.has("provider-new")).toBe(true);
    expect(hangupCalls).toHaveLength(1);
  });
});
