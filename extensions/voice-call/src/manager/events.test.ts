// Voice Call tests cover events plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "../config.js";
import type { VoiceCallProvider } from "../providers/base.js";
import { clearVoiceCallStateRuntime, setVoiceCallStateRuntime } from "../runtime-state.js";
import type { AnswerCallInput, HangupCallInput, NormalizedEvent } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { processEvent } from "./events.js";
import { speakInitialMessage } from "./outbound.js";
import { flushPendingCallRecordWritesForTest } from "./store.js";

const logSpy = vi.hoisted(() => {
  const logEntries: string[] = [];
  return {
    logEntries,
    clearLogEntries: () => {
      logEntries.length = 0;
    },
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    createSubsystemLogger: (_subsystem: string) => ({
      info: (msg: string) => {
        logSpy.logEntries.push(msg);
      },
      warn: (msg: string) => {
        logSpy.logEntries.push(msg);
      },
      error: (msg: string) => {
        logSpy.logEntries.push(msg);
      },
    }),
  };
});

const contexts: CallManagerContext[] = [];

function installStateRuntime(): void {
  setVoiceCallStateRuntime({
    state: {
      resolveStateDir: () => "",
      openKeyedStore: (() => {
        throw new Error("openKeyedStore is not used by voice-call event tests");
      }) as never,
      openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStoreForTests("voice-call", options),
      openChannelIngressQueue: (() => {
        throw new Error("openChannelIngressQueue is not used by voice-call event tests");
      }) as never,
    },
  });
}

beforeEach(() => {
  resetPluginStateStoreForTests();
  installStateRuntime();
});

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
  clearVoiceCallStateRuntime();
  resetPluginStateStoreForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it.each([
    {
      name: "speaking",
      expectedState: "speaking",
      expectedTranscript: [],
      createEvent: (timestamp: number): NormalizedEvent => ({
        id: "evt-live-speaking",
        type: "call.speaking",
        callId: "call-live",
        providerCallId: "provider-live",
        timestamp,
        text: "hello",
      }),
    },
    {
      name: "assistant speech",
      expectedState: "speaking",
      expectedTranscript: [{ speaker: "bot", text: "hello" }],
      createEvent: (timestamp: number): NormalizedEvent => ({
        id: "evt-live-assistant-speech",
        type: "call.assistant-speech",
        callId: "call-live",
        providerCallId: "provider-live",
        timestamp,
        transcript: "hello",
      }),
    },
    {
      name: "listening",
      expectedState: "listening",
      expectedTranscript: [{ speaker: "user", text: "hello" }],
      createEvent: (timestamp: number): NormalizedEvent => ({
        id: "evt-live-listening",
        type: "call.speech",
        callId: "call-live",
        providerCallId: "provider-live",
        timestamp,
        transcript: "hello",
        isFinal: true,
      }),
    },
  ])(
    "starts max-duration enforcement when $name arrives before answered",
    async ({ expectedState, expectedTranscript, createEvent }) => {
      const now = new Date("2026-03-22T12:00:00.000Z").getTime();
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const hangupCalls: HangupCallInput[] = [];
      const ctx = createContext({
        config: VoiceCallConfigSchema.parse({
          enabled: true,
          provider: "plivo",
          fromNumber: "+15550000000",
          maxDurationSeconds: 1,
        }),
        provider: createProvider({
          hangupCall: async (input: HangupCallInput): Promise<void> => {
            hangupCalls.push(input);
          },
        }),
      });
      ctx.activeCalls.set("call-live", {
        callId: "call-live",
        providerCallId: "provider-live",
        provider: "plivo",
        direction: "inbound",
        state: "ringing",
        from: "+15550000002",
        to: "+15550000000",
        startedAt: now - 120_000,
        transcript: [],
        processedEventIds: [],
        metadata: {},
      });
      ctx.providerCallIdMap.set("provider-live", "call-live");
      const liveTimestamp = now + 250;

      processEvent(ctx, createEvent(liveTimestamp));

      const call = ctx.activeCalls.get("call-live");
      if (!call) {
        throw new Error("expected live call to remain active");
      }
      expect(call.state).toBe(expectedState);
      expect(call.answeredAt).toBe(liveTimestamp);
      expect(call.transcript.map(({ speaker, text }) => ({ speaker, text }))).toEqual(
        expectedTranscript,
      );
      expect(ctx.maxDurationTimers.has("call-live")).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(hangupCalls).toEqual([
        {
          callId: "call-live",
          providerCallId: "provider-live",
          reason: "timeout",
        },
      ]);
      expect(ctx.activeCalls.has("call-live")).toBe(false);
      vi.useRealTimers();
    },
  );

  it("enforces max duration for Twilio initial-message streams without answeredAt", async () => {
    const now = new Date("2026-03-22T12:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const hangupCalls: HangupCallInput[] = [];
    const provider = createProvider({
      name: "twilio",
      hangupCall: async (input: HangupCallInput): Promise<void> => {
        hangupCalls.push(input);
      },
    }) as VoiceCallProvider & { isConversationStreamConnectEnabled?: () => boolean };
    provider.isConversationStreamConnectEnabled = () => true;
    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "twilio",
        fromNumber: "+15550000000",
        maxDurationSeconds: 1,
        streaming: { enabled: true },
      }),
      provider,
    });
    ctx.activeCalls.set("call-stream", {
      callId: "call-stream",
      providerCallId: "provider-stream",
      provider: "twilio",
      direction: "inbound",
      state: "active",
      from: "+15550000002",
      to: "+15550000000",
      startedAt: now - 120_000,
      transcript: [],
      processedEventIds: [],
      metadata: {
        initialMessage: "Hello from the bot.",
        mode: "conversation",
      },
    });
    ctx.providerCallIdMap.set("provider-stream", "call-stream");

    await speakInitialMessage(ctx, "provider-stream");

    const call = ctx.activeCalls.get("call-stream");
    if (!call) {
      throw new Error("expected initial-message call to remain active");
    }
    expect(call.state).toBe("speaking");
    expect(call.answeredAt).toBe(now);
    expect(ctx.maxDurationTimers.has("call-stream")).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(hangupCalls).toEqual([
      {
        callId: "call-stream",
        providerCallId: "provider-stream",
        reason: "timeout",
      },
    ]);
    expect(ctx.activeCalls.has("call-stream")).toBe(false);
    vi.useRealTimers();
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

  it("assigns per-call session keys to inbound calls when configured", () => {
    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        inboundPolicy: "open",
        sessionScope: "per-call",
      }),
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
    expect(call.sessionKey).toBe(`agent:main:voice:call:${call.callId}`);
  });

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

    const firstResult = processEvent(ctx, {
      id: "evt-1",
      dedupeKey: "stable-key-1",
      type: "call.speech",
      callId: "call-dedupe",
      providerCallId: "provider-dedupe",
      timestamp: now + 1,
      transcript: "hello",
      isFinal: true,
    });

    const replayResult = processEvent(ctx, {
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
    expect(firstResult).toMatchObject({
      kind: "final-speech",
      transcript: "hello",
      waiterResolved: false,
    });
    expect(replayResult).toEqual({ kind: "ignored" });
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
    expect(Array.from(ctx.processedEventIds)).toStrictEqual([]);
    expect(call.processedEventIds).toStrictEqual([]);
  });
});

describe("processEvent privacy assertions", () => {
  beforeEach(() => {
    logSpy.clearLogEntries();
  });

  function expectCallerRedacted(phone: string, ...expectedMetadata: string[]): void {
    const logOutput = logSpy.logEntries.join(" ");
    expect(logOutput).not.toContain(phone);
    expect(logOutput).toContain("caller=sha256:");
    for (const metadata of expectedMetadata) {
      expect(logOutput).toContain(metadata);
    }
  }

  it.each([
    {
      label: "acceptance",
      phone: "+15551112222",
      allowFrom: ["+15551112222"],
      allowed: true,
    },
    {
      label: "rejection",
      phone: "+15559999999",
      allowFrom: ["+15550001111"],
      allowed: false,
    },
  ])("redacts caller phone numbers in allowlist $label logs", ({ phone, allowFrom, allowed }) => {
    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        inboundPolicy: "allowlist",
        allowFrom,
      }),
      provider: createProvider(),
    });

    processEvent(
      ctx,
      createInboundInitiatedEvent({
        id: `evt-privacy-${allowed ? "accept" : "reject"}`,
        providerCallId: `prov-privacy-${allowed ? "accept" : "reject"}`,
        from: phone,
      }),
    );

    expectCallerRedacted(phone, `allowlisted=${allowed}`);
  });

  it("redacts caller phone numbers in call record creation logs", () => {
    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        inboundPolicy: "open",
      }),
    });
    const phone = "+15554444444";
    processEvent(
      ctx,
      createInboundInitiatedEvent({
        id: "evt-privacy-create",
        providerCallId: "prov-privacy-create",
        from: phone,
      }),
    );

    const call = requireFirstActiveCall(ctx);
    expectCallerRedacted(phone, call.callId);
  });

  it("redacts caller phone numbers when rejection cannot reach a provider", () => {
    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        inboundPolicy: "allowlist",
        allowFrom: ["+15550001111"],
      }),
      provider: null,
    });
    const phone = "+15559999999";
    processEvent(
      ctx,
      createInboundInitiatedEvent({
        id: "evt-privacy-no-provider",
        providerCallId: "prov-privacy-no-provider",
        from: phone,
      }),
    );

    expectCallerRedacted(phone, "prov-privacy-no-provider");
  });
});
