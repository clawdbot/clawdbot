// Voice Call tests cover events plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "../config.js";
import {
  createEventManagerHarness,
  EVENT_MANAGER_REPLAY_KEY_LIMIT,
} from "../manager.test-harness.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallRecord, HangupCallInput, NormalizedEvent } from "../types.js";
import { processEvent } from "./events.js";
import { speakInitialMessage } from "./outbound.js";
import { MAX_CALL_REPLAY_KEYS } from "./replay-keys.js";

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

const {
  cleanup,
  createContext,
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("processEvent (functional)", () => {
  it.each(["speech", "answered", "terminal"] as const)(
    "publishes %s side effects only after SQLite persistence succeeds",
    (kind) => {
      let failPersistence = true;
      installStateRuntime(() => failPersistence);
      const onCallAnswered = vi.fn();
      const ctx = createContext({ onCallAnswered });
      const call: CallRecord = {
        callId: `call-durable-${kind}`,
        providerCallId: "provider-before",
        provider: "plivo",
        direction: "outbound",
        state: kind === "answered" ? "ringing" : "active",
        from: "+15550000000",
        to: "+15550000001",
        startedAt: Date.now(),
        transcript: [],
        processedEventIds: [],
      };
      ctx.activeCalls.set(call.callId, call);
      ctx.providerCallIdMap.set("provider-before", call.callId);
      const resolve = vi.fn();
      const reject = vi.fn();
      if (kind !== "answered") {
        ctx.transcriptWaiters.set(call.callId, {
          resolve,
          reject,
          timeout: setTimeout(() => {}, 60_000),
        });
      }
      if (kind === "terminal") {
        ctx.maxDurationTimers.set(
          call.callId,
          setTimeout(() => {}, 60_000),
        );
      }
      const base = { id: `event-${kind}`, callId: call.callId, timestamp: Date.now() };
      const event: NormalizedEvent =
        kind === "speech"
          ? { ...base, type: "call.speech", transcript: "durable", isFinal: true }
          : kind === "answered"
            ? { ...base, type: "call.answered", providerCallId: "provider-after" }
            : { ...base, type: "call.ended", reason: "hangup-user" };

      expect(() => processEvent(ctx, event)).toThrow("synthetic SQLite persistence failure");
      expect(ctx.processedEventIds.has(event.id)).toBe(false);
      expect(call.processedEventIds).toEqual([]);
      expect(call.transcript).toEqual([]);
      expect(call.providerCallId).toBe("provider-before");
      expect(ctx.providerCallIdMap.has("provider-after")).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
      expect(ctx.maxDurationTimers.has(call.callId)).toBe(kind === "terminal");

      failPersistence = false;
      processEvent(ctx, event);
      expect(ctx.processedEventIds.has(event.id)).toBe(true);
      expect(resolve).toHaveBeenCalledTimes(kind === "speech" ? 1 : 0);
      expect(reject).toHaveBeenCalledTimes(kind === "terminal" ? 1 : 0);
      expect(onCallAnswered).toHaveBeenCalledTimes(kind === "answered" ? 1 : 0);
      expect(ctx.activeCalls.has(call.callId)).toBe(kind !== "terminal");
    },
  );

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

    expect(processEvent(ctx, event)).toEqual({ kind: "ignored", replayable: true });

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

  it("bounds committed replay keys in both manager and persisted call owners", () => {
    const now = Date.now();
    const managerKeys = Array.from(
      { length: EVENT_MANAGER_REPLAY_KEY_LIMIT },
      (_, index) => `manager-${index}`,
    );
    const callKeys = Array.from({ length: MAX_CALL_REPLAY_KEYS }, (_, index) => `call-${index}`);
    const ctx = createContext({ processedEventIds: new Set(managerKeys) });
    ctx.activeCalls.set("call-bounded", {
      callId: "call-bounded",
      providerCallId: "provider-bounded",
      provider: "plivo",
      direction: "outbound",
      state: "active",
      from: "+15550000000",
      to: "+15550000001",
      startedAt: now,
      transcript: [],
      processedEventIds: callKeys,
      metadata: {},
    });
    ctx.providerCallIdMap.set("provider-bounded", "call-bounded");

    const result = processEvent(ctx, {
      id: "evt-bounded-new",
      type: "call.dtmf",
      callId: "call-bounded",
      providerCallId: "provider-bounded",
      timestamp: now + 1,
      digits: "1",
    });

    const call = ctx.activeCalls.get("call-bounded");
    expect(result).toEqual({ kind: "processed" });
    expect(ctx.processedEventIds.size).toBe(EVENT_MANAGER_REPLAY_KEY_LIMIT);
    expect(ctx.processedEventIds.has("manager-0")).toBe(false);
    expect(ctx.processedEventIds.has("evt-bounded-new")).toBe(true);
    expect(call?.processedEventIds).toHaveLength(MAX_CALL_REPLAY_KEYS);
    expect(call?.processedEventIds[0]).toBe("call-1");
    expect(call?.processedEventIds.at(-1)).toBe("evt-bounded-new");
    expect(
      processEvent(ctx, {
        id: "evt-bounded-new",
        type: "call.dtmf",
        callId: "call-bounded",
        providerCallId: "provider-bounded",
        timestamp: now + 2,
        digits: "1",
      }),
    ).toEqual({ kind: "ignored" });
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

    expect(processEvent(ctx, event)).toEqual({ kind: "processed", replayable: true });
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
