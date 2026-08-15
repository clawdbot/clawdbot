// Settlement liveness: a wedged block-reply flush must not park the turn.
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindStreamLlmRuntime } from "../../../llm/model-runtime-binding.js";
import { SessionManager } from "../../sessions/index.js";
import { RUN_LIVENESS_JOIN_TIMEOUT_MS } from "./abortable.js";
import {
  prepareEmbeddedAttemptTransport,
  settleEmbeddedAttemptStream,
} from "./attempt-stream-settle.js";

type SettleInput = Parameters<typeof settleEmbeddedAttemptStream>[0];
type PrepareTransportInput = Parameters<typeof prepareEmbeddedAttemptTransport>[0];

function createSettleFixture(overrides?: Partial<SettleInput>): SettleInput {
  const sessionManager = SessionManager.inMemory();
  return {
    attempt: {
      runId: "run-settle-1",
      sessionId: "sess-settle-1",
      sessionKey: "agent:main:test",
      provider: "openai",
      modelId: "gpt-5.6-luna",
      model: { api: "openai-responses" },
      config: {},
      promptCacheKey: undefined,
    },
    activeSession: {
      sessionId: "sess-settle-1",
      isCompacting: false,
      isStreaming: false,
      messages: [],
    },
    sessionManager,
    withOwnedTranscriptWrite: async (operation: () => unknown) => await operation(),
    subscription: {
      toolMetas: [],
      waitForCompactionRetry: async () => {},
      isCompactionInFlight: () => false,
      getCompactionCount: () => 0,
      getCurrentAttemptAssistant: () => undefined,
      getUsageTotals: () => undefined,
      getLastAssistantUsage: () => undefined,
    },
    state: {
      promptError: null,
      promptErrorSource: null,
      yieldAborted: false,
      sessionIdUsed: "sess-settle-1",
    },
    readLifecycleState: () => ({
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    }),
    markTimedOutDuringCompaction: vi.fn(),
    runAbortDeadlineAtMs: Date.now() + 600_000,
    runAbortSignal: new AbortController().signal,
    isProbeSession: true,
    abortable: async <T>(promise: Promise<T>) => await promise,
    prePromptMessageCount: 0,
    toolSearchTargetTranscriptProjections: [],
    cache: {
      observabilityEnabled: false,
      changesForTurn: null,
      retention: undefined,
    },
    shouldFlushForContextEngine: false,
    ...overrides,
  } as unknown as SettleInput;
}

describe("settleEmbeddedAttemptStream liveness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles past a block-reply flush that never resolves", async () => {
    vi.useFakeTimers();
    // A wedged delivery lane (including the supported blockReplyTimeoutMs: 0
    // path) previously parked settlement until the 48h run budget.
    const input = createSettleFixture({
      onBlockReplyFlush: () => new Promise<never>(() => {}),
    } as Partial<SettleInput>);

    const settle = settleEmbeddedAttemptStream(input);
    let settled = false;
    void settle.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(RUN_LIVENESS_JOIN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await settle;
    expect(result.sessionIdUsed).toBe("sess-settle-1");
  });

  it("settles normally when the flush resolves", async () => {
    const flushed = vi.fn(async () => {});
    const input = createSettleFixture({
      onBlockReplyFlush: flushed,
    } as Partial<SettleInput>);
    const result = await settleEmbeddedAttemptStream(input);
    expect(flushed).toHaveBeenCalledWith({ reason: "pre_compaction", attemptAccepted: false });
    expect(result.sessionIdUsed).toBe("sess-settle-1");
  });
});

describe("prepareEmbeddedAttemptTransport", () => {
  it("applies the prepared transport to the live agent owner", async () => {
    const streamFn = vi.fn();
    bindStreamLlmRuntime(streamFn, {
      streamSimple: streamFn,
      registry: { getApiProvider: () => undefined },
    } as never);
    const session = {
      agent: {
        streamFn,
        transport: "auto",
      },
    };
    const input = {
      attempt: {
        config: {},
        model: {
          api: "test-api",
          provider: "test-provider",
          id: "test-model",
        },
        modelId: "test-model",
        provider: "test-provider",
        promptCacheKey: undefined,
        resolvedApiKey: undefined,
        runId: "run-transport-1",
        runtimePlan: {
          auth: { forwardedAuthProfileId: undefined },
          transport: {
            resolveExtraParams: () => ({ transport: "sse" }),
          },
        },
        sessionId: "sess-transport-1",
      },
      session,
      settingsManager: {
        getGlobalSettings: () => ({}),
        getProjectSettings: () => ({}),
      },
      providerThinkingLevel: undefined,
      sessionAgentId: "main",
      workspaceDir: "/workspace",
      workspaceOnly: false,
      agentDir: "/agent",
      abortSignal: new AbortController().signal,
      getProviderRuntimeHandle: () => ({
        provider: "test-provider",
        modelId: "test-model",
      }),
      sandboxSessionKey: "agent:main:test",
      codeModeControlsEnabled: false,
      providerPromptState: {
        state: {},
        effectiveContextTokenBudget: 128_000,
      },
    } as unknown as PrepareTransportInput;

    const result = await prepareEmbeddedAttemptTransport(input);

    expect(result.effectiveAgentTransport).toBe("sse");
    expect(session.agent.transport).toBe("sse");
  });
});
