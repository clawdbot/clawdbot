import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createTestStorePath,
  FakeProvider,
  makePersistedCall,
  writeCallsToStore,
} from "./manager.test-harness.js";
import { flushPendingCallRecordWritesForTest, loadActiveCallsFromStore } from "./manager/store.js";

function requireSingleActiveCall(manager: CallManager) {
  const activeCalls = manager.getActiveCalls();
  expect(activeCalls).toHaveLength(1);
  const activeCall = activeCalls[0];
  if (!activeCall) {
    throw new Error("expected restored active call");
  }
  return activeCall;
}

describe("CallManager verification on restore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function initializeManager(params?: {
    callOverrides?: Parameters<typeof makePersistedCall>[0];
    providerResult?: FakeProvider["getCallStatusResult"];
    configureProvider?: (provider: FakeProvider) => void;
    configOverrides?: Partial<{ maxDurationSeconds: number }>;
  }) {
    const storePath = createTestStorePath();
    const call = makePersistedCall(params?.callOverrides);
    writeCallsToStore(storePath, [call]);

    const provider = new FakeProvider();
    if (params?.providerResult) {
      provider.getCallStatusResult = params.providerResult;
    }
    params?.configureProvider?.(provider);

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      ...params?.configOverrides,
    });
    const manager = new CallManager(config, storePath);
    await manager.initialize(provider, "https://example.com/voice/webhook");

    return { call, manager, provider, storePath };
  }

  it("skips stale calls reported terminal by provider", async () => {
    const { manager } = await initializeManager({
      providerResult: { status: "completed", isTerminal: true },
    });

    expect(manager.getActiveCalls()).toHaveLength(0);
  });

  it("keeps calls reported active by provider", async () => {
    const { call, manager } = await initializeManager({
      providerResult: { status: "in-progress", isTerminal: false },
    });

    const activeCall = requireSingleActiveCall(manager);
    expect(activeCall.callId).toBe(call.callId);
  });

  it("keeps calls when provider returns unknown (transient error)", async () => {
    const { call, manager } = await initializeManager({
      providerResult: { status: "error", isTerminal: false, isUnknown: true },
    });

    const activeCall = requireSingleActiveCall(manager);
    expect(activeCall.callId).toBe(call.callId);
    expect(activeCall.state).toBe(call.state);
  });

  it("skips calls older than maxDurationSeconds", async () => {
    const { manager, provider, storePath } = await initializeManager({
      callOverrides: {
        startedAt: Date.now() - 600_000,
        answeredAt: Date.now() - 590_000,
      },
      configOverrides: { maxDurationSeconds: 300 },
    });

    expect(manager.getActiveCalls()).toHaveLength(0);
    expect(provider.hangupCalls).toEqual([
      expect.objectContaining({
        reason: "timeout",
      }),
    ]);

    await flushPendingCallRecordWritesForTest();
    expect(loadActiveCallsFromStore(storePath).activeCalls.size).toBe(0);
  });

  it("skips calls without providerCallId", async () => {
    const { manager } = await initializeManager({
      callOverrides: { providerCallId: undefined, state: "initiated" },
    });

    expect(manager.getActiveCalls()).toHaveLength(0);
  });

  it("keeps call when getCallStatus throws (verification failure)", async () => {
    const { call, manager } = await initializeManager({
      configureProvider: (provider) => {
        provider.getCallStatus = async () => {
          throw new Error("network failure");
        };
      },
    });

    const activeCall = requireSingleActiveCall(manager);
    expect(activeCall.callId).toBe(call.callId);
    expect(activeCall.state).toBe(call.state);
  });

  it("uses only remaining max duration for restored answered calls", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-17T03:07:00Z");
    vi.setSystemTime(now);
    const { manager, provider } = await initializeManager({
      callOverrides: {
        startedAt: now.getTime() - 290_000,
        answeredAt: now.getTime() - 290_000,
        state: "answered",
      },
      configOverrides: { maxDurationSeconds: 300 },
    });

    expect(manager.getActiveCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(manager.getActiveCalls()).toHaveLength(1);
    expect(provider.hangupCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_100);
    expect(manager.getActiveCalls()).toHaveLength(0);
    expect(provider.hangupCalls).toEqual([
      expect.objectContaining({
        reason: "timeout",
      }),
    ]);
  });

  it("restores dedupe keys from terminal persisted calls so replayed webhooks stay ignored", async () => {
    const storePath = createTestStorePath();
    const persisted = makePersistedCall({
      state: "completed",
      endedAt: Date.now() - 5_000,
      endReason: "completed",
      processedEventIds: ["evt-terminal-init"],
    });
    writeCallsToStore(storePath, [persisted]);

    const provider = new FakeProvider();
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    });
    const manager = new CallManager(config, storePath);
    await manager.initialize(provider, "https://example.com/voice/webhook");

    manager.processEvent({
      id: "evt-terminal-init",
      type: "call.initiated",
      callId: String(persisted.providerCallId),
      providerCallId: String(persisted.providerCallId),
      timestamp: Date.now(),
      direction: "outbound",
      from: "+15550000000",
      to: "+15550000001",
    });

    expect(manager.getActiveCalls()).toHaveLength(0);
  });
});
