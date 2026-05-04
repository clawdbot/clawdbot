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
    vi.restoreAllMocks();
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

  it("summarizes repeated restored-call verification outcomes", async () => {
    const now = Date.now();
    const storePath = createTestStorePath();
    const calls = [
      makePersistedCall({
        callId: "missing-provider-a",
        providerCallId: undefined,
        state: "initiated",
        startedAt: now - 10_000,
        answeredAt: undefined,
      }),
      makePersistedCall({
        callId: "missing-provider-b",
        providerCallId: undefined,
        state: "initiated",
        startedAt: now - 10_000,
        answeredAt: undefined,
      }),
      makePersistedCall({
        callId: "expired-a",
        providerCallId: "expired-provider-a",
        state: "initiated",
        startedAt: now - 600_000,
        answeredAt: undefined,
      }),
      makePersistedCall({
        callId: "terminal-a",
        providerCallId: "terminal-provider-a",
        state: "initiated",
        startedAt: now - 20_000,
        answeredAt: undefined,
      }),
      makePersistedCall({
        callId: "terminal-b",
        providerCallId: "terminal-provider-b",
        state: "initiated",
        startedAt: now - 20_000,
        answeredAt: undefined,
      }),
      makePersistedCall({
        callId: "unknown-a",
        providerCallId: "unknown-provider-a",
        state: "initiated",
        startedAt: now - 20_000,
        answeredAt: undefined,
      }),
      makePersistedCall({
        callId: "active-a",
        providerCallId: "active-provider-a",
        state: "initiated",
        startedAt: now - 20_000,
        answeredAt: undefined,
      }),
      makePersistedCall({
        callId: "failure-a",
        providerCallId: "failure-provider-a",
        state: "initiated",
        startedAt: now - 20_000,
        answeredAt: undefined,
      }),
    ];
    writeCallsToStore(storePath, calls);

    const provider = new FakeProvider();
    provider.getCallStatus = async ({ providerCallId }) => {
      if (providerCallId.startsWith("terminal-provider")) {
        return { status: "completed", isTerminal: true };
      }
      if (providerCallId.startsWith("unknown-provider")) {
        return { status: "unknown", isTerminal: false, isUnknown: true };
      }
      if (providerCallId.startsWith("active-provider")) {
        return { status: "in-progress", isTerminal: false };
      }
      throw new Error("network failure");
    };
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      maxDurationSeconds: 300,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const manager = new CallManager(config, storePath);

    await manager.initialize(provider, "https://example.com/voice/webhook");

    expect(
      manager
        .getActiveCalls()
        .map((call) => call.callId)
        .toSorted(),
    ).toEqual(["active-a", "failure-a", "unknown-a"]);
    expect(provider.hangupCalls).toEqual([
      expect.objectContaining({
        callId: "expired-a",
        providerCallId: "expired-provider-a",
        reason: "timeout",
      }),
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      "[voice-call] Skipped 2 restored call(s) with no providerCallId",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[voice-call] Skipped 1 restored call(s) older than maxDurationSeconds",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[voice-call] Skipped 2 restored call(s) with provider status: completed",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[voice-call] Kept 1 restored call(s) confirmed active by provider",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[voice-call] Kept 1 restored call(s) with unknown provider status (relying on timer)",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[voice-call] Kept 1 restored call(s) after verification failure (relying on timer)",
    );
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("terminal-a");

    logSpy.mockRestore();
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
