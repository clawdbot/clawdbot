import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "../config.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { HangupCallInput, NormalizedEvent } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { processEvent } from "./events.js";
import { flushPendingCallRecordWritesForTest } from "./store.js";

const contexts: CallManagerContext[] = [];

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    for (const timer of ctx.maxDurationTimers.values()) {
      clearTimeout(timer);
    }
    ctx.maxDurationTimers.clear();
    for (const waiter of ctx.transcriptWaiters.values()) {
      clearTimeout(waiter.timeout);
    }
    ctx.transcriptWaiters.clear();
    await flushPendingCallRecordWritesForTest();
    fs.rmSync(ctx.storePath, { recursive: true, force: true });
  }
});

function createContext(overrides: Partial<CallManagerContext> = {}): CallManagerContext {
  const storePath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-voice-call-events-test-"));
  const ctx: CallManagerContext = {
    activeCalls: new Map(),
    providerCallIdMap: new Map(),
    processedEventIds: new Set(),
    rejectedProviderCallIds: new Set(),
    provider: null,
    config: VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    }),
    storePath,
    webhookUrl: null,
    activeTurnCalls: new Set(),
    transcriptWaiters: new Map(),
    maxDurationTimers: new Map(),
    initialMessageInFlight: new Set(),
    ...overrides,
  };
  contexts.push(ctx);
  return ctx;
}

function createProvider(overrides: Partial<VoiceCallProvider> = {}): VoiceCallProvider {
  return {
    name: "plivo",
    verifyWebhook: () => ({ ok: true }),
    parseWebhookEvent: () => ({ events: [] }),
    initiateCall: async () => ({ providerCallId: "provider-call-id", status: "initiated" }),
    hangupCall: async () => {},
    playTts: async () => {},
    startListening: async () => {},
    stopListening: async () => {},
    getCallStatus: async () => ({ status: "in-progress", isTerminal: false }),
    ...overrides,
  };
}

function createInboundDisabledConfig() {
  return VoiceCallConfigSchema.parse({
    enabled: true,
    provider: "plivo",
    fromNumber: "+15550000000",
    inboundPolicy: "disabled",
  });
}

function createInboundInitiatedEvent(params: {
  id: string;
  providerCallId: string;
  from: string;
}): NormalizedEvent {
  return {
    id: params.id,
    type: "call.initiated",
    callId: params.providerCallId,
    providerCallId: params.providerCallId,
    timestamp: Date.now(),
    direction: "inbound",
    from: params.from,
    to: "+15550000000",
  };
}

function createRejectingInboundContext(): {
  ctx: CallManagerContext;
  hangupCalls: HangupCallInput[];
} {
  const hangupCalls: HangupCallInput[] = [];
  const provider = createProvider({
    hangupCall: async (input: HangupCallInput): Promise<void> => {
      hangupCalls.push(input);
    },
  });
  const ctx = createContext({
    config: createInboundDisabledConfig(),
    provider,
  });
  return { ctx, hangupCalls };
}

function requireFirstActiveCall(ctx: CallManagerContext) {
  const call = [...ctx.activeCalls.values()][0];
  if (!call) {
    throw new Error("expected one active call");
  }
  return call;
}

describe("processEvent (functional)", () => {
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
      expect.objectContaining({
        providerCallId: "prov-dup",
        reason: "hangup-bot",
      }),
    ]);
  });

  it("updates providerCallId map when provider ID changes", () => {
    const now = Date.now();
    const ctx = createContext();
    ctx.activeCalls.set("call-1", {
      callId: "call-1",
      providerCallId: "request-uuid",
      provider: "plivo",
      direction: "outbound",
      state: "initiated",
      from: "+15550000000",
      to: "+15550000001",
      startedAt: now,
      transcript: [],
      processedEventIds: [],
      metadata: {},
    });
    ctx.providerCallIdMap.set("request-uuid", "call-1");

    processEvent(ctx, {
      id: "evt-provider-id-change",
      type: "call.answered",
      callId: "call-1",
      providerCallId: "call-uuid",
      timestamp: now + 1,
    });

    const activeCall = ctx.activeCalls.get("call-1");
    if (!activeCall) {
      throw new Error("expected active call after provider id change");
    }
    expect(activeCall.providerCallId).toBe("call-uuid");
    expect(ctx.providerCallIdMap.get("call-uuid")).toBe("call-1");
    expect(ctx.providerCallIdMap.has("request-uuid")).toBe(false);
  });

  it("does not burn replay keys for unknown calls before a later replay can resolve them", () => {
    const now = Date.now();
    const ctx = createContext();
    const event: NormalizedEvent = {
      id: "evt-late-call",
      dedupeKey: "stable-late-call",
      type: "call.answered",
      callId: "call-late",
      providerCallId: "provider-late",
      timestamp: now + 1,
    };

    processEvent(ctx, event);

    expect(ctx.processedEventIds.size).toBe(0);

    ctx.activeCalls.set("call-late", {
      callId: "call-late",
      providerCallId: "provider-late",
      provider: "plivo",
      direction: "inbound",
      state: "ringing",
      from: "+15550000002",
      to: "+15550000000",
      startedAt: now,
      transcript: [],
      processedEventIds: [],
      metadata: {},
    });
    ctx.providerCallIdMap.set("provider-late", "call-late");

    processEvent(ctx, event);

    const call = ctx.activeCalls.get("call-late");
    if (!call) {
      throw new Error("expected replayed event to resolve after call registration");
    }
    expect(call.state).toBe("answered");
    expect(call.answeredAt).toBe(now + 1);
    expect(Array.from(ctx.processedEventIds)).toEqual(["stable-late-call"]);
  });

  it("invokes onCallAnswered hook for answered events", () => {
    const now = Date.now();
    let answeredCallId: string | null = null;
    const ctx = createContext({
      onCallAnswered: (call) => {
        answeredCallId = call.callId;
      },
    });
    ctx.activeCalls.set("call-2", {
      callId: "call-2",
      providerCallId: "call-2-provider",
      provider: "plivo",
      direction: "inbound",
      state: "ringing",
      from: "+15550000002",
      to: "+15550000000",
      startedAt: now,
      transcript: [],
      processedEventIds: [],
      metadata: {},
    });
    ctx.providerCallIdMap.set("call-2-provider", "call-2");

    processEvent(ctx, {
      id: "evt-answered-hook",
      type: "call.answered",
      callId: "call-2",
      providerCallId: "call-2-provider",
      timestamp: now + 1,
    });

    expect(answeredCallId).toBe("call-2");
  });

  it("when hangup throws, logs and does not throw", () => {
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

    expect(() => processEvent(ctx, event)).not.toThrow();
    expect(ctx.activeCalls.size).toBe(0);
  });

  it("auto-registers externally-initiated outbound-api calls with correct direction", () => {
    const ctx = createContext();
    const event: NormalizedEvent = {
      id: "evt-external-1",
      type: "call.initiated",
      callId: "CA-external-123",
      providerCallId: "CA-external-123",
      timestamp: Date.now(),
      direction: "outbound",
      from: "+15550000000",
      to: "+15559876543",
    };

    processEvent(ctx, event);

    // Call should be registered in activeCalls and providerCallIdMap
    expect(ctx.activeCalls.size).toBe(1);
    const call = requireFirstActiveCall(ctx);
    expect(ctx.providerCallIdMap.get("CA-external-123")).toBe(call.callId);
    expect(call.providerCallId).toBe("CA-external-123");
    expect(call.direction).toBe("outbound");
    expect(call.from).toBe("+15550000000");
    expect(call.to).toBe("+15559876543");
  });

  it("does not reject externally-initiated outbound calls even with disabled inbound policy", () => {
    const { ctx, hangupCalls } = createRejectingInboundContext();
    const event: NormalizedEvent = {
      id: "evt-external-2",
      type: "call.initiated",
      callId: "CA-external-456",
      providerCallId: "CA-external-456",
      timestamp: Date.now(),
      direction: "outbound",
      from: "+15550000000",
      to: "+15559876543",
    };

    processEvent(ctx, event);

    // External outbound calls bypass inbound policy — they should be accepted
    expect(ctx.activeCalls.size).toBe(1);
    expect(hangupCalls).toHaveLength(0);
    const call = requireFirstActiveCall(ctx);
    expect(call.direction).toBe("outbound");
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

  it("deduplicates by dedupeKey even when event IDs differ", () => {
    const now = Date.now();
    const ctx = createContext();
    ctx.activeCalls.set("call-dedupe", {
      callId: "call-dedupe",
      providerCallId: "provider-dedupe",
      provider: "plivo",
      direction: "outbound",
      state: "answered",
      from: "+15550000000",
      to: "+15550000001",
      startedAt: now,
      transcript: [],
      processedEventIds: [],
      metadata: {},
    });
    ctx.providerCallIdMap.set("provider-dedupe", "call-dedupe");

    processEvent(ctx, {
      id: "evt-1",
      dedupeKey: "stable-key-1",
      type: "call.speech",
      callId: "call-dedupe",
      providerCallId: "provider-dedupe",
      timestamp: now + 1,
      transcript: "hello",
      isFinal: true,
    });

    processEvent(ctx, {
      id: "evt-2",
      dedupeKey: "stable-key-1",
      type: "call.speech",
      callId: "call-dedupe",
      providerCallId: "provider-dedupe",
      timestamp: now + 2,
      transcript: "hello",
      isFinal: true,
    });

    const call = ctx.activeCalls.get("call-dedupe");
    if (!call) {
      throw new Error("expected deduped call to remain active");
    }
    expect(call.transcript).toHaveLength(1);
    expect(Array.from(ctx.processedEventIds)).toEqual(["stable-key-1"]);
  });

  it("keeps retryable call.error events replayable", () => {
    const now = Date.now();
    const ctx = createContext();
    ctx.activeCalls.set("call-retryable-error", {
      callId: "call-retryable-error",
      providerCallId: "provider-retryable-error",
      provider: "plivo",
      direction: "outbound",
      state: "active",
      from: "+15550000000",
      to: "+15550000001",
      startedAt: now,
      transcript: [],
      processedEventIds: [],
      metadata: {},
    });
    ctx.providerCallIdMap.set("provider-retryable-error", "call-retryable-error");

    const event: NormalizedEvent = {
      id: "evt-retryable-error",
      dedupeKey: "stable-retryable-error",
      type: "call.error",
      callId: "call-retryable-error",
      providerCallId: "provider-retryable-error",
      timestamp: now + 1,
      error: "temporary upstream failure",
      retryable: true,
    };

    processEvent(ctx, event);
    processEvent(ctx, event);

    const call = ctx.activeCalls.get("call-retryable-error");
    if (!call) {
      throw new Error("expected retryable error call to remain active");
    }
    expect(call.state).toBe("active");
    expect(Array.from(ctx.processedEventIds)).toEqual([]);
    expect(call.processedEventIds).toEqual([]);
  });
});
