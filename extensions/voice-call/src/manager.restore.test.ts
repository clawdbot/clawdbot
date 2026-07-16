// Voice Call tests cover manager.restore plugin behavior.
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createTestStorePath,
  FakeProvider,
  makePersistedCall,
  writeCallsToStore,
} from "./manager.test-harness.js";
import { loadActiveCallsFromStore } from "./manager/store.js";
import { setVoiceCallStateRuntime } from "./runtime-state.js";

function installStateRuntime(): void {
  setVoiceCallStateRuntime({
    state: {
      resolveStateDir: () => "",
      openKeyedStore: (() => {
        throw new Error("openKeyedStore is not used by voice-call restore tests");
      }) as never,
      openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStoreForTests("voice-call", options),
      openChannelIngressQueue: (() => {
        throw new Error("openChannelIngressQueue is not used by voice-call restore tests");
      }) as never,
    },
  });
}

function requireSingleActiveCall(manager: CallManager) {
  const activeCalls = manager.getActiveCalls();
  expect(activeCalls).toHaveLength(1);
  const activeCall = activeCalls[0];
  if (!activeCall) {
    throw new Error("expected restored active call");
  }
  return activeCall;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requireSingleHangupCall(provider: FakeProvider) {
  expect(provider.hangupCalls).toHaveLength(1);
  return requireRecord(provider.hangupCalls[0], "hangup call");
}

describe("CallManager verification on restore", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installStateRuntime();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
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

  it("resolves a terminal call from persisted state after restore", async () => {
    const { call, manager } = await initializeManager({
      callOverrides: { state: "completed", endReason: "completed", endedAt: Date.now() },
    });

    expect(manager.getCall(call.callId as string)).toBeUndefined();
    expect(await manager.getCallFromMemoryOrStore(call.callId as string)).toMatchObject({
      callId: call.callId,
      state: "completed",
    });
    expect(await manager.getCallFromMemoryOrStore(call.providerCallId as string)).toMatchObject({
      callId: call.callId,
      state: "completed",
    });
  });

  it("prefers active provider state before persisted fallback", async () => {
    const storePath = createTestStorePath();
    writeCallsToStore(storePath, [
      makePersistedCall({
        callId: "call-target",
        providerCallId: "provider-completed",
        state: "completed",
        endReason: "completed",
        endedAt: Date.now(),
      }),
      makePersistedCall({
        callId: "call-active",
        providerCallId: "call-target",
        state: "answered",
      }),
    ]);
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    });
    const manager = new CallManager(config, storePath);
    await manager.initialize(new FakeProvider(), "https://example.com/voice/webhook");

    expect(manager.getCallByProviderCallId("call-target")?.callId).toBe("call-active");
    expect(await manager.getCallFromMemoryOrStore("call-target")).toMatchObject({
      callId: "call-active",
      state: "answered",
    });
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
    const hangupCall = requireSingleHangupCall(provider);
    expect(hangupCall.reason).toBe("timeout");

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
    const hangupCall = requireSingleHangupCall(provider);
    expect(hangupCall.callId).toBe("expired-a");
    expect(hangupCall.providerCallId).toBe("expired-provider-a");
    expect(hangupCall.reason).toBe("timeout");
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
    const hangupCall = requireSingleHangupCall(provider);
    expect(hangupCall.reason).toBe("timeout");
  });

  it.each(["speaking", "listening"] as const)(
    "uses call start as max-duration anchor for restored live %s calls without answeredAt",
    async (state) => {
      vi.useFakeTimers();
      const now = new Date("2026-03-17T03:07:00Z").getTime();
      vi.setSystemTime(now);
      const startedAt = now - 290_000;
      const { manager, provider, storePath } = await initializeManager({
        callOverrides: {
          callId: `call-${state}`,
          providerCallId: `provider-${state}`,
          state,
          startedAt,
          answeredAt: undefined,
        },
        configOverrides: { maxDurationSeconds: 300 },
      });

      const activeCall = requireSingleActiveCall(manager);
      expect(activeCall.state).toBe(state);
      expect(activeCall.answeredAt).toBe(startedAt);
      expect(
        loadActiveCallsFromStore(storePath).activeCalls.get(activeCall.callId)?.answeredAt,
      ).toBe(startedAt);

      await vi.advanceTimersByTimeAsync(9_000);
      expect(manager.getActiveCalls()).toHaveLength(1);
      expect(provider.hangupCalls).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1_100);
      expect(manager.getActiveCalls()).toHaveLength(0);
      const hangupCall = requireSingleHangupCall(provider);
      expect(hangupCall.reason).toBe("timeout");
    },
  );

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
