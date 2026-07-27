// Copilot tests cover harness plugin behavior.
import type { CopilotClient } from "@github/copilot-sdk";
import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessCompactParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCopilotAgentHarness, type CopilotSessionBinding } from "./harness.js";
import type { resolvePoolAcquire } from "./src/attempt.js";
import type { CopilotClientPool, PoolKey } from "./src/runtime.js";

type CanonicalAttemptResult = Extract<AgentHarnessAttemptResult, { terminal: unknown }>;

const COPILOT_BYOK_PROVIDER_ERROR =
  "[copilot-attempt] BYOK requires an OpenAI-compatible or Anthropic model api and a non-empty baseUrl";

const mocks = vi.hoisted(() => ({
  runCopilotAttempt: vi.fn(),
  resolvePoolAcquire: vi.fn(
    (_params: any) =>
      ({
        auth: {
          agentId: "test",
          authMode: "useLoggedInUser",
          copilotHome: "/tmp/copilot",
        },
        key: { agentId: "test", authMode: "useLoggedInUser", copilotHome: "/tmp/copilot" },
        options: { copilotHome: "/tmp/copilot", useLoggedInUser: true },
        provider: { mode: "github-copilot" },
      }) as ReturnType<typeof resolvePoolAcquire>,
  ),
  createCopilotByokProxy: vi.fn(),
  createCopilotClientPool: vi.fn(),
}));

vi.mock("./src/attempt.js", () => ({
  resolvePoolAcquire: mocks.resolvePoolAcquire,
  runCopilotAttempt: mocks.runCopilotAttempt,
}));

vi.mock("./src/byok-proxy.js", () => ({
  createCopilotByokProxy: mocks.createCopilotByokProxy,
}));

vi.mock("./src/runtime.js", () => ({
  createCopilotClientPool: mocks.createCopilotClientPool,
}));

function asAttemptParams(value: Record<string, unknown>): AgentHarnessAttemptParams {
  return value as unknown as AgentHarnessAttemptParams;
}

function asAttemptResult(value: Record<string, unknown>): AgentHarnessAttemptResult {
  return value as unknown as AgentHarnessAttemptResult;
}

function asCompleteAttemptResult(value: Record<string, unknown>): CanonicalAttemptResult {
  return asAttemptResult({
    terminal: { kind: "ok" },
    sessionIdUsed: "session-1",
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...value,
  }) as CanonicalAttemptResult;
}

const ATTEMPT_PARAMS = asAttemptParams({
  provider: "github-copilot",
  model: "gpt-4.1",
});
const ATTEMPT_RESULT = asCompleteAttemptResult({ ok: true });
const TEST_POOL_KEY = {
  agentId: "test",
  authMode: "useLoggedInUser",
  copilotHome: "/tmp/copilot",
} satisfies PoolKey;
const TEST_SESSION_CONFIG = {
  availableTools: [],
  model: "gpt-4.1",
  tools: [],
  workingDirectory: "/workspace",
};

function createMockCopilotClient(overrides: Record<string, unknown> = {}): CopilotClient {
  return overrides as unknown as CopilotClient;
}

function makePoolMock() {
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    dispose: vi.fn().mockResolvedValue([]),
    size: vi.fn().mockReturnValue(0),
  } satisfies CopilotClientPool;
}

function makeSessionStoreMock() {
  const entries = new Map<string, CopilotSessionBinding>();
  return {
    entries,
    store: {
      register: vi.fn((key: string, value: CopilotSessionBinding) => {
        entries.set(key, value);
      }),
      lookup: vi.fn((key: string) => entries.get(key)),
      delete: vi.fn((key: string) => entries.delete(key)),
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("createCopilotAgentHarness", () => {
  beforeEach(() => {
    mocks.runCopilotAttempt.mockReset();
    mocks.resolvePoolAcquire.mockClear();
    mocks.createCopilotByokProxy.mockReset();
    mocks.createCopilotClientPool.mockReset();
    mocks.runCopilotAttempt.mockResolvedValue(ATTEMPT_RESULT);
    mocks.resolvePoolAcquire.mockReturnValue({
      auth: {
        agentId: "test",
        authMode: "useLoggedInUser",
        copilotHome: "/tmp/copilot",
      },
      key: { agentId: "test", authMode: "useLoggedInUser", copilotHome: "/tmp/copilot" },
      options: { copilotHome: "/tmp/copilot", useLoggedInUser: true },
      provider: { mode: "github-copilot" },
    });
    mocks.createCopilotClientPool.mockImplementation(() => makePoolMock());
    mocks.createCopilotByokProxy.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetGlobalHookRunner();
  });

  it("returns the copilot id and default label", () => {
    const harness = createCopilotAgentHarness();

    expect(harness.id).toBe("copilot");
    expect(harness.label).toBe("GitHub Copilot agent runtime");
  });

  it("accepts custom id and label from options", () => {
    const harness = createCopilotAgentHarness({ id: "sdk", label: "SDK Harness" });

    expect(harness.id).toBe("sdk");
    expect(harness.label).toBe("SDK Harness");
  });

  it("supports returns false in auto runtime even for github provider", () => {
    const harness = createCopilotAgentHarness();

    expect(harness.autoSelection?.providerIds).toEqual([]);

    expect(
      harness.supports({
        provider: "github-copilot",
        modelId: "gpt-4.1",
        requestedRuntime: "auto",
      }),
    ).toEqual({
      supported: false,
      reason: "copilot is opt-in only",
    });
  });

  it("supports returns false in pi runtime", () => {
    const harness = createCopilotAgentHarness();

    expect(
      harness.supports({ provider: "github-copilot", modelId: "gpt-4.1", requestedRuntime: "pi" }),
    ).toEqual({
      supported: false,
      reason: "copilot is opt-in only",
    });
  });

  it("supports returns true for requestedRuntime copilot with github-copilot provider", () => {
    const harness = createCopilotAgentHarness();

    expect(
      harness.supports({
        provider: "github-copilot",
        modelId: "gpt-4.1",
        requestedRuntime: "copilot",
      }),
    ).toEqual({ supported: true, priority: 100 });
  });

  it("supports normalizes provider casing and whitespace", () => {
    const harness = createCopilotAgentHarness();

    expect(
      harness.supports({
        provider: "  GitHub-Copilot  ",
        modelId: "gpt-4.1",
        requestedRuntime: "copilot",
      }),
    ).toEqual({ supported: true, priority: 100 });
  });

  it("supports normalizes requestedRuntime casing", () => {
    const harness = createCopilotAgentHarness();

    expect(
      harness.supports({
        provider: "github-copilot",
        modelId: "gpt-4.1",
        requestedRuntime: "  COPILOT  ",
      }),
    ).toEqual({ supported: true, priority: 100 });
  });

  it("supports custom provider ids for BYOK model entries", () => {
    const harness = createCopilotAgentHarness();

    expect(
      harness.supports({
        provider: "custom-proxy",
        modelId: "llama-3.1-8b",
        modelProvider: {
          api: "openai-responses",
          baseUrl: "https://proxy.example/v1",
        },
        providerOwnerStatus: "unowned",
        providerOwnerPluginIds: [],
        requestedRuntime: "copilot",
      }),
    ).toEqual({ supported: true, priority: 100 });
  });

  it("supports rejects custom provider ids without a supported BYOK model shape", () => {
    const harness = createCopilotAgentHarness();

    expect(
      harness.supports({
        provider: "custom-proxy",
        modelId: "llama-3.1-8b",
        providerOwnerStatus: "unowned",
        providerOwnerPluginIds: [],
        requestedRuntime: "copilot",
      }),
    ).toEqual({
      supported: false,
      reason:
        "provider is not a supported Copilot BYOK model (requires supported api, baseUrl, and no request transport policy overrides)",
    });
    expect(
      harness.supports({
        provider: "custom-proxy",
        modelId: "llama-3.1-8b",
        modelProvider: {
          api: "openai-responses",
          baseUrl: "https://proxy.example/v1",
          request: { proxy: { mode: "env-proxy" } },
        },
        providerOwnerStatus: "unowned",
        providerOwnerPluginIds: [],
        requestedRuntime: "copilot",
      }),
    ).toEqual({
      supported: false,
      reason:
        "provider is not a supported Copilot BYOK model (requires supported api, baseUrl, and no request transport policy overrides)",
    });
  });

  it("supports rejects manifest-owned providers outside the whitelist", () => {
    const harness = createCopilotAgentHarness();

    for (const [provider, ownerPluginIds] of [
      ["anthropic", ["anthropic"]],
      ["azure-openai-responses", ["openai"]],
      ["deepinfra", ["deepinfra"]],
      ["fireworks", ["fireworks"]],
      ["github", ["github"]],
      ["openclaw", ["openclaw"]],
      ["sglang", ["sglang"]],
      ["together", ["together"]],
      ["vllm", ["vllm"]],
    ] as const) {
      expect(
        harness.supports({
          provider,
          modelId: "gpt-4.1",
          requestedRuntime: "copilot",
          providerOwnerStatus: "owned",
          providerOwnerPluginIds: ownerPluginIds,
        }),
      ).toEqual({
        supported: false,
        reason: "provider is not one of: github-copilot",
      });
    }
  });

  it("supports rejects ambiguous custom provider ownership", () => {
    const harness = createCopilotAgentHarness();

    expect(
      harness.supports({
        provider: "custom-proxy",
        modelId: "proxy-model",
        modelProvider: {
          api: "openai-responses",
          baseUrl: "https://proxy.example/v1",
        },
        requestedRuntime: "copilot",
        providerOwnerStatus: "ambiguous",
        providerOwnerPluginIds: ["first-owner", "second-owner"],
      }),
    ).toEqual({
      supported: false,
      reason: "provider is not one of: github-copilot",
    });
  });

  it("runAttempt lazy-imports attempt by waiting until invocation to create a pool", async () => {
    const pool = makePoolMock();
    mocks.createCopilotClientPool.mockReturnValue(pool);
    const harness = createCopilotAgentHarness();

    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
    expect(mocks.runCopilotAttempt).not.toHaveBeenCalled();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);

    expect(mocks.createCopilotClientPool).toHaveBeenCalledTimes(1);
    expect(mocks.runCopilotAttempt).toHaveBeenCalledTimes(1);
  });

  it("keeps invalid BYOK provider configuration on the structured attempt path", async () => {
    const pool = makePoolMock();
    mocks.createCopilotClientPool.mockReturnValue(pool);
    mocks.resolvePoolAcquire.mockImplementationOnce(() => {
      throw new Error(COPILOT_BYOK_PROVIDER_ERROR);
    });
    const harness = createCopilotAgentHarness();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);
    expect(mocks.runCopilotAttempt).toHaveBeenCalledWith(ATTEMPT_PARAMS, { pool });
  });

  it("runAttempt creates one pool lazily and reuses it across two attempts on the same harness", async () => {
    const pool = makePoolMock();
    const firstResult = asAttemptResult({ attempt: 1 });
    const secondResult = asAttemptResult({ attempt: 2 });
    mocks.createCopilotClientPool.mockReturnValue(pool);
    mocks.runCopilotAttempt.mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult);
    const harness = createCopilotAgentHarness();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(firstResult);
    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(secondResult);

    expect(mocks.createCopilotClientPool).toHaveBeenCalledTimes(1);
    expect(mocks.runCopilotAttempt).toHaveBeenNthCalledWith(
      1,
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool }),
    );
    expect(mocks.runCopilotAttempt).toHaveBeenNthCalledWith(
      2,
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool }),
    );
  });

  it("finalizes settled tools by resuming the compatible SDK session in isolated mode", async () => {
    const pool = makePoolMock();
    const client = createMockCopilotClient({ deleteSession: vi.fn() });
    const settledResult = asCompleteAttemptResult({ assistantTexts: [] });
    const finalAssistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "final answer" }],
      stopReason: "stop" as const,
    };
    const finalResult = asCompleteAttemptResult({
      assistantTexts: ["final answer"],
      currentAttemptCompletedAssistant: finalAssistant,
    });
    const params = asAttemptParams({
      ...ATTEMPT_PARAMS,
      initialReplayState: { replayInvalid: true },
      onAgentEvent: vi.fn(),
      onAssistantDelta: vi.fn(),
      onPartialReply: vi.fn(),
      sessionId: "openclaw-session-finalize",
    });
    mocks.runCopilotAttempt
      .mockImplementationOnce(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-session-finalize",
          pooledClient: { client, key: TEST_POOL_KEY },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return settledResult;
      })
      .mockResolvedValueOnce(finalResult);
    const harness = createCopilotAgentHarness({ pool });

    await expect(harness.runAttempt(params)).resolves.toBe(settledResult);
    await expect(
      harness.finalizeSettledTurn?.({ attempt: params, settledAttempt: settledResult }),
    ).resolves.toEqual({ assistant: finalAssistant });

    expect(mocks.runCopilotAttempt).toHaveBeenCalledTimes(2);
    expect(mocks.runCopilotAttempt.mock.calls[1]?.[0]).toMatchObject({
      disableTools: true,
      initialReplayState: { sdkSessionId: "sdk-session-finalize" },
      sessionId: "openclaw-session-finalize",
    });
    expect(mocks.runCopilotAttempt.mock.calls[1]?.[0]?.initialReplayState).not.toHaveProperty(
      "replayInvalid",
    );
    expect(mocks.runCopilotAttempt.mock.calls[1]?.[0]).toMatchObject({
      onAgentEvent: undefined,
      onAssistantDelta: undefined,
      onPartialReply: undefined,
    });
    expect(mocks.runCopilotAttempt.mock.calls[1]?.[1]).toMatchObject({
      operation: "settled-tool-finalization",
      pool,
    });
    expect(mocks.runCopilotAttempt.mock.calls[1]?.[1]?.onSessionEstablished).toBeUndefined();
  });

  it("fails closed when settled finalization has no compatible SDK session", async () => {
    const harness = createCopilotAgentHarness({ pool: makePoolMock() });
    const params = asAttemptParams({
      ...ATTEMPT_PARAMS,
      sessionId: "openclaw-session-missing",
    });

    await expect(
      harness.finalizeSettledTurn?.({ attempt: params, settledAttempt: ATTEMPT_RESULT }),
    ).rejects.toThrow(
      "cannot safely finalize a settled tool turn without its compatible SDK session",
    );
    expect(mocks.runCopilotAttempt).not.toHaveBeenCalled();
  });

  it("multiple harness instances create independent pools", async () => {
    const poolOne = makePoolMock();
    const poolTwo = makePoolMock();
    mocks.createCopilotClientPool.mockReturnValueOnce(poolOne).mockReturnValueOnce(poolTwo);
    const firstHarness = createCopilotAgentHarness();
    const secondHarness = createCopilotAgentHarness();

    await expect(firstHarness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);
    await expect(secondHarness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);

    expect(mocks.createCopilotClientPool).toHaveBeenCalledTimes(2);
    expect(mocks.runCopilotAttempt).toHaveBeenNthCalledWith(
      1,
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool: poolOne }),
    );
    expect(mocks.runCopilotAttempt).toHaveBeenNthCalledWith(
      2,
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool: poolTwo }),
    );
  });

  it("runAttempt does not serialize concurrent attempts", async () => {
    const pool = makePoolMock();
    const firstResult = asAttemptResult({ attempt: 1 });
    const secondResult = asAttemptResult({ attempt: 2 });
    mocks.createCopilotClientPool.mockReturnValue(pool);
    mocks.runCopilotAttempt.mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult);
    const harness = createCopilotAgentHarness();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(firstResult);
    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(secondResult);

    expect(mocks.createCopilotClientPool).toHaveBeenCalledTimes(1);
    expect(mocks.runCopilotAttempt).toHaveBeenCalledTimes(2);
  });

  it("dispose before first runAttempt does not create a pool", async () => {
    const harness = createCopilotAgentHarness();

    await expect(harness.dispose?.()).resolves.toBeUndefined();

    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
  });

  it("dispose during lazy startup prevents the attempt from creating a pool", async () => {
    const harness = createCopilotAgentHarness();

    const attemptPromise = harness.runAttempt(ATTEMPT_PARAMS);
    const disposePromise = harness.dispose?.();

    await expect(attemptPromise).rejects.toThrow(
      "[copilot] harness was disposed while starting an attempt",
    );
    await expect(disposePromise).resolves.toBeUndefined();
    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
    expect(mocks.runCopilotAttempt).not.toHaveBeenCalled();
  });

  it("dispose after pool creation calls pool.dispose once even when called twice", async () => {
    const pool = makePoolMock();
    mocks.createCopilotClientPool.mockReturnValue(pool);
    const harness = createCopilotAgentHarness();

    await harness.runAttempt(ATTEMPT_PARAMS);

    const firstDispose = harness.dispose?.();
    const secondDispose = harness.dispose?.();

    await expect(firstDispose).resolves.toBeUndefined();
    await expect(secondDispose).resolves.toBeUndefined();
    expect(pool["dispose"]).toHaveBeenCalledTimes(1);
  });

  it("dispose waits for in-flight runAttempt before disposing", async () => {
    const pool = makePoolMock();
    const deferred = createDeferred<AgentHarnessAttemptResult>();
    mocks.createCopilotClientPool.mockReturnValue(pool);
    mocks.runCopilotAttempt.mockImplementation(() => deferred.promise);
    const harness = createCopilotAgentHarness();

    const attemptPromise = harness.runAttempt(ATTEMPT_PARAMS);
    await flushAsyncWork();

    const disposePromise = harness.dispose?.();
    let disposeSettled = false;
    void disposePromise?.then(() => {
      disposeSettled = true;
    });

    await flushAsyncWork();

    expect(pool["dispose"]).not.toHaveBeenCalled();
    expect(disposeSettled).toBe(false);

    deferred.resolve(ATTEMPT_RESULT);

    await expect(attemptPromise).resolves.toBe(ATTEMPT_RESULT);
    await expect(disposePromise).resolves.toBeUndefined();
    expect(pool["dispose"]).toHaveBeenCalledTimes(1);
  });

  it("runAttempt after dispose rejects without creating a new pool", async () => {
    const harness = createCopilotAgentHarness();

    await harness.dispose?.();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).rejects.toThrow(
      "[copilot] harness has been disposed; cannot start new attempts",
    );
    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
  });

  it("dispose surfaces pool.dispose errors as AggregateError", async () => {
    const pool = makePoolMock();
    const errors = [new Error("first"), new Error("second")];
    pool.dispose = vi.fn().mockResolvedValue(errors);
    mocks.createCopilotClientPool.mockReturnValue(pool);
    const harness = createCopilotAgentHarness();

    await harness.runAttempt(ATTEMPT_PARAMS);

    try {
      await harness.dispose?.();
      throw new Error("expected dispose to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toBe("[copilot] pool disposal errors");
      expect((error as AggregateError).errors).toEqual(errors);
    }
  });

  it("dispose does not dispose a caller-supplied pool", async () => {
    const pool = makePoolMock();
    const harness = createCopilotAgentHarness({ pool });

    await harness.runAttempt(ATTEMPT_PARAMS);
    await expect(harness.dispose?.()).resolves.toBeUndefined();

    expect(pool["dispose"]).not.toHaveBeenCalled();
  });

  it("uses options.pool when supplied", async () => {
    const pool = makePoolMock();
    const harness = createCopilotAgentHarness({ pool });

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);

    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
    expect(mocks.runCopilotAttempt).toHaveBeenCalledWith(
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool }),
    );
  });

  describe("reset", () => {
    it("is a no-op when params.sessionId is missing", async () => {
      const pool = makePoolMock();
      const harness = createCopilotAgentHarness({ pool });

      await expect(harness.reset?.({})).resolves.toBeUndefined();
    });

    it("is a no-op when the session was never tracked", async () => {
      const pool = makePoolMock();
      const harness = createCopilotAgentHarness({ pool });

      await expect(harness.reset?.({ sessionId: "unknown" })).resolves.toBeUndefined();
    });

    it("calls deleteSession on the client that created the session", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const client = createMockCopilotClient({ deleteSession });
      mocks.runCopilotAttempt.mockImplementation(async (params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-123",
          pooledClient: { key: TEST_POOL_KEY, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-sess-1" });
      await harness.reset?.({ sessionId: "oc-sess-1" });

      expect(deleteSession).toHaveBeenCalledTimes(1);
      expect(deleteSession).toHaveBeenCalledWith("sdk-sess-123");
    });

    it("does not call deleteSession when no sdkSessionId was reported", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      mocks.runCopilotAttempt.mockImplementation(async (_params, _deps) => ATTEMPT_RESULT);
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-sess-2" });
      await harness.reset?.({ sessionId: "oc-sess-2" });

      expect(deleteSession).not.toHaveBeenCalled();
    });

    it("swallows errors thrown by client.deleteSession", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockRejectedValue(new Error("session not found"));
      const client = createMockCopilotClient({ deleteSession });
      mocks.runCopilotAttempt.mockImplementation(async (params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-err",
          pooledClient: { key: TEST_POOL_KEY, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-sess-3" });

      await expect(harness.reset?.({ sessionId: "oc-sess-3" })).resolves.toBeUndefined();
      expect(deleteSession).toHaveBeenCalledTimes(1);
    });

    it("forgets the session after reset; a second reset is a no-op", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const client = createMockCopilotClient({ deleteSession });
      mocks.runCopilotAttempt.mockImplementation(async (params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-x",
          pooledClient: { key: TEST_POOL_KEY, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-sess-4" });
      await harness.reset?.({ sessionId: "oc-sess-4" });
      await harness.reset?.({ sessionId: "oc-sess-4" });

      expect(deleteSession).toHaveBeenCalledTimes(1);
    });

    it("does not invoke deleteSession for a session belonging to a different openclawSessionId", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const client = createMockCopilotClient({ deleteSession });
      mocks.runCopilotAttempt.mockImplementation(async (params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-y",
          pooledClient: { key: TEST_POOL_KEY, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-A" });
      await harness.reset?.({ sessionId: "oc-B" });

      expect(deleteSession).not.toHaveBeenCalled();
    });
  });

  it("dispose clears tracked sessions so subsequent reset is a no-op", async () => {
    const pool = makePoolMock();
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const client = createMockCopilotClient({ deleteSession });
    mocks.runCopilotAttempt.mockImplementation(async (params, deps) => {
      deps.onSessionEstablished?.({
        sdkSessionId: "sdk-sess-d",
        pooledClient: { key: TEST_POOL_KEY, client },
      });
      return ATTEMPT_RESULT;
    });
    const harness = createCopilotAgentHarness({ pool });

    await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-disp" });
    await harness.dispose?.();
    await harness.reset?.({ sessionId: "oc-disp" });

    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("aborts deferred compaction cleanup before disposal", async () => {
    const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
    const abort = vi.fn(() => cleanup.resolve("aborted"));
    mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
      deps.onSessionEstablished?.({
        sdkSessionId: "sdk-sess-pending-cleanup",
        pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        sessionConfig: TEST_SESSION_CONFIG,
      });
      deps.onDeferredCompaction?.({
        abort,
        cleanup: cleanup.promise,
        sdkSessionId: "sdk-sess-pending-cleanup",
      });
      return ATTEMPT_RESULT;
    });
    const harness = createCopilotAgentHarness();

    await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-pending-cleanup" });
    await harness.dispose?.();

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("aborts deferred compaction cleanup when the OpenClaw session resets", async () => {
    const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
    const abort = vi.fn(() => cleanup.resolve("aborted"));
    mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
      deps.onSessionEstablished?.({
        sdkSessionId: "sdk-sess-reset-cleanup",
        pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        sessionConfig: TEST_SESSION_CONFIG,
      });
      deps.onDeferredCompaction?.({
        abort,
        cleanup: cleanup.promise,
        sdkSessionId: "sdk-sess-reset-cleanup",
      });
      return ATTEMPT_RESULT;
    });
    const harness = createCopilotAgentHarness();

    await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-reset-cleanup" });
    await harness.reset?.({ sessionId: "oc-reset-cleanup" });

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("does not delete a replacement session while reset awaits deferred cleanup", async () => {
    const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
    const abort = vi.fn();
    const oldDeleteSession = vi.fn().mockResolvedValue(undefined);
    const replacementDeleteSession = vi.fn().mockResolvedValue(undefined);
    const sessionStore = makeSessionStoreMock();
    let attempt = 0;
    mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
      attempt += 1;
      if (attempt === 1) {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-before-reset",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: oldDeleteSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        deps.onDeferredCompaction?.({
          abort,
          cleanup: cleanup.promise,
          sdkSessionId: "sdk-sess-before-reset",
        });
      } else {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-replacement",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: replacementDeleteSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
      }
      return ATTEMPT_RESULT;
    });
    const harness = createCopilotAgentHarness({
      pool: makePoolMock(),
      sessionStore: sessionStore.store,
    });

    await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-reset-race" });
    const reset = harness.reset?.({ sessionId: "oc-reset-race" });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-reset-race" });
    cleanup.resolve("aborted");
    await reset;

    expect(oldDeleteSession).toHaveBeenCalledWith("sdk-sess-before-reset");
    expect(replacementDeleteSession).not.toHaveBeenCalled();
    expect(sessionStore.entries.get("oc-reset-race")?.sdkSessionId).toBe("sdk-sess-replacement");
  });

  it("does not reuse a reset target while deferred cleanup is pending", async () => {
    const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
    const abort = vi.fn();
    const replacementDeleteSession = vi.fn().mockResolvedValue(undefined);
    const duringResetDeleteSession = vi.fn().mockResolvedValue(undefined);
    const sessionStore = makeSessionStoreMock();
    let attempt = 0;
    mocks.runCopilotAttempt.mockImplementation(async (params, deps) => {
      attempt += 1;
      if (attempt === 1) {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-before-reset",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        deps.onDeferredCompaction?.({
          abort,
          cleanup: cleanup.promise,
          sdkSessionId: "sdk-sess-before-reset",
        });
      } else if (attempt === 2) {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-replacement",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: replacementDeleteSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
      } else if (attempt === 3 && !params.initialReplayState?.sdkSessionId) {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-during-reset",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: duringResetDeleteSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
      }
      return ATTEMPT_RESULT;
    });
    const harness = createCopilotAgentHarness({
      pool: makePoolMock(),
      sessionStore: sessionStore.store,
    });
    const params = { ...ATTEMPT_PARAMS, sessionId: "oc-reset-reuse" };

    await harness.runAttempt(params);
    await harness.runAttempt(params);
    const reset = harness.reset?.({ sessionId: "oc-reset-reuse" });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    await harness.runAttempt(params);
    cleanup.resolve("aborted");
    await reset;

    expect(
      mocks.runCopilotAttempt.mock.calls[2]?.[0]?.initialReplayState?.sdkSessionId,
    ).toBeUndefined();
    expect(replacementDeleteSession).toHaveBeenCalledWith("sdk-sess-replacement");
    expect(duringResetDeleteSession).not.toHaveBeenCalled();
    expect(sessionStore.entries.get("oc-reset-reuse")?.sdkSessionId).toBe("sdk-sess-during-reset");
  });

  describe("session reuse across turns (dogfood finding #4)", () => {
    // These tests pin the harness's session-reuse contract: subsequent
    // `runAttempt` calls within the same OpenClaw session should pass
    // the tracked `sdkSessionId` to the attempt via `initialReplayState`
    // so the SDK can `resumeSession` and keep its prompt cache + thread
    // history warm. Compatibility-fingerprint mismatch (provider/model/
    // cwd/auth) starts a fresh SDK session instead, and any caller-
    // provided `replayInvalid: true` must survive untouched.

    function makeAttemptParams(overrides: Record<string, unknown> = {}): any {
      return {
        provider: "github-copilot",
        model: "gpt-4.1",
        cwd: "/ws",
        workspaceDir: "/ws",
        agentDir: "/home",
        copilotHome: "/copilot-home",
        auth: { useLoggedInUser: true },
        sessionId: "oc-sess-reuse",
        ...overrides,
      };
    }

    it("seeds initialReplayState.sdkSessionId from trackedSessions on the second turn", async () => {
      const pool = makePoolMock();
      const client = createMockCopilotClient({ deleteSession: vi.fn() });
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-warm",
          pooledClient: { key: TEST_POOL_KEY, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeAttemptParams({ runId: "t1" }));
      await harness.runAttempt(makeAttemptParams({ runId: "t2" }));

      expect(mocks.runCopilotAttempt).toHaveBeenCalledTimes(2);
      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string; replayInvalid?: boolean };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBe("sdk-sess-warm");
      // Must not synthesize a replayInvalid signal: undefined → resumable.
      expect(secondCallParams.initialReplayState?.replayInvalid).toBeUndefined();
    });

    it("blocks reuse while timed-out compaction is pending, then resumes after completion", async () => {
      const pool = makePoolMock();
      const sessionStore = makeSessionStoreMock();
      const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
      let attempt = 0;
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        attempt += 1;
        if (attempt === 1) {
          deps.onSessionEstablished?.({
            sdkSessionId: "sdk-sess-compacting",
            pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
            sessionConfig: TEST_SESSION_CONFIG,
          });
          deps.onDeferredCompaction?.({
            abort: () => undefined,
            cleanup: cleanup.promise,
            sdkSessionId: "sdk-sess-compacting",
          });
        }
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool, sessionStore: sessionStore.store });

      await harness.runAttempt(makeAttemptParams({ runId: "t1" }));
      await harness.runAttempt(makeAttemptParams({ runId: "t2" }));

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();

      cleanup.resolve("completed");
      await flushAsyncWork();

      await harness.runAttempt(makeAttemptParams({ runId: "t3" }));
      const thirdCallParams = mocks.runCopilotAttempt.mock.calls[2]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(thirdCallParams.initialReplayState?.sdkSessionId).toBe("sdk-sess-compacting");
      expect(sessionStore.store.delete).not.toHaveBeenCalledWith("oc-sess-reuse");
    });

    it("reuses a replacement session while an older cleanup is pending", async () => {
      const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
      let attempt = 0;
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        attempt += 1;
        if (attempt === 1) {
          deps.onSessionEstablished?.({
            sdkSessionId: "sdk-sess-old",
            pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
            sessionConfig: TEST_SESSION_CONFIG,
          });
          deps.onDeferredCompaction?.({
            abort: () => undefined,
            cleanup: cleanup.promise,
            sdkSessionId: "sdk-sess-old",
          });
        } else if (attempt === 2) {
          deps.onSessionEstablished?.({
            sdkSessionId: "sdk-sess-replacement",
            pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
            sessionConfig: TEST_SESSION_CONFIG,
          });
        }
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool: makePoolMock() });

      await harness.runAttempt(makeAttemptParams({ runId: "t1" }));
      await harness.runAttempt(makeAttemptParams({ runId: "t2" }));
      await harness.runAttempt(makeAttemptParams({ runId: "t3" }));

      const thirdCallParams = mocks.runCopilotAttempt.mock.calls[2]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(thirdCallParams.initialReplayState?.sdkSessionId).toBe("sdk-sess-replacement");
      cleanup.resolve("completed");
      await flushAsyncWork();
    });

    it("invalidates the retained SDK binding when deferred compaction is cancelled", async () => {
      const pool = makePoolMock();
      const sessionStore = makeSessionStoreMock();
      const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
      let attempt = 0;
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        attempt += 1;
        if (attempt === 1) {
          deps.onSessionEstablished?.({
            sdkSessionId: "sdk-sess-cancelled",
            pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
            sessionConfig: TEST_SESSION_CONFIG,
          });
          deps.onDeferredCompaction?.({
            abort: () => undefined,
            cleanup: cleanup.promise,
            sdkSessionId: "sdk-sess-cancelled",
          });
        }
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool, sessionStore: sessionStore.store });

      await harness.runAttempt(makeAttemptParams({ runId: "t1" }));
      cleanup.resolve("aborted");
      await flushAsyncWork();

      await harness.runAttempt(makeAttemptParams({ runId: "t2" }));
      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
      expect(sessionStore.store.delete).toHaveBeenCalledWith("oc-sess-reuse");
    });

    it("ignores deferred cleanup from a session replaced by an overlapping attempt", async () => {
      const firstAttemptFinished = createDeferred<void>();
      const staleCleanup = createDeferred<"aborted" | "completed" | "deadline">();
      let firstAttemptDeps:
        | {
            onDeferredCompaction?: (info: {
              abort: () => void;
              cleanup: Promise<"aborted" | "completed" | "deadline">;
              sdkSessionId: string;
            }) => void;
          }
        | undefined;
      let attempt = 0;
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        attempt += 1;
        if (attempt === 1) {
          deps.onSessionEstablished?.({
            sdkSessionId: "sdk-sess-stale",
            pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
            sessionConfig: TEST_SESSION_CONFIG,
          });
          firstAttemptDeps = deps;
          await firstAttemptFinished.promise;
        } else if (attempt === 2) {
          deps.onSessionEstablished?.({
            sdkSessionId: "sdk-sess-current",
            pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
            sessionConfig: TEST_SESSION_CONFIG,
          });
        }
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool: makePoolMock() });

      const firstAttempt = harness.runAttempt(makeAttemptParams({ runId: "t1" }));
      await flushAsyncWork();
      await harness.runAttempt(makeAttemptParams({ runId: "t2" }));
      firstAttemptDeps?.onDeferredCompaction?.({
        abort: () => undefined,
        cleanup: staleCleanup.promise,
        sdkSessionId: "sdk-sess-stale",
      });
      firstAttemptFinished.resolve();
      await firstAttempt;

      await harness.runAttempt(makeAttemptParams({ runId: "t3" }));
      const thirdCallParams = mocks.runCopilotAttempt.mock.calls[2]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };

      expect(thirdCallParams.initialReplayState?.sdkSessionId).toBe("sdk-sess-current");
      staleCleanup.resolve("completed");
      await flushAsyncWork();
    });

    it("does not seed sdkSessionId on the first turn (nothing tracked yet)", async () => {
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-cold",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeAttemptParams({ runId: "t1" }));

      const firstCallParams = mocks.runCopilotAttempt.mock.calls[0]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(firstCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("does not seed when compatibility fingerprint differs (model change)", async () => {
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-gpt4",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(
        makeAttemptParams({ runId: "t1", model: { provider: "github-copilot", id: "gpt-4.1" } }),
      );
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          model: { provider: "github-copilot", id: "claude-sonnet-4.5" },
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("does not seed when compatibility fingerprint differs (model API change)", async () => {
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-api",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(
        makeAttemptParams({
          runId: "t1",
          model: { api: "chat", provider: "github-copilot", id: "gpt-4.1" },
        }),
      );
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          model: { api: "responses", provider: "github-copilot", id: "gpt-4.1" },
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("does not seed when compatibility fingerprint differs (legacy auth.gitHubToken rotation)", async () => {
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-auth1",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      // Use the explicit-token auth branch (which carries gitHubToken
      // + profileId + profileVersion through resolveCopilotAuth and
      // surfaces the version into authProfileVersion) so a profile
      // version bump is a real auth rotation, not a no-op fall-through
      // to useLoggedInUser.
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t1",
          auth: { gitHubToken: "tok-1", profileId: "p1", profileVersion: "v1" },
        }),
      );
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          auth: { gitHubToken: "tok-1", profileId: "p1", profileVersion: "v2" },
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("G3: does not seed when top-level authProfileId rotates (production path)", async () => {
      // The production main path (EmbeddedRunAttemptParams) carries
      // top-level `authProfileId` + `resolvedApiKey`, not the legacy
      // `auth.*` sub-object. computeSessionCompatKey delegates to
      // resolveCopilotAuth so both paths produce the same effective
      // auth identity. Rotating the top-level profile id must
      // invalidate session reuse.
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-p1",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(
        makeAttemptParams({
          runId: "t1",
          auth: undefined,
          authProfileId: "p1",
          resolvedApiKey: "tok-same",
        }),
      );
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          auth: undefined,
          authProfileId: "p2",
          resolvedApiKey: "tok-same",
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("G3: does not seed when top-level resolvedApiKey rotates (token fingerprint changes)", async () => {
      // Same authProfileId but the resolved token bytes change.
      // resolveCopilotAuth synthesizes authProfileVersion via
      // tokenFingerprint(resolvedApiKey) for the contract path, so
      // rotating the bytes flips the fingerprint and therefore the
      // compat key. Important for cases where an upstream auth
      // store re-issues a token under the same profile id.
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-tok1",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(
        makeAttemptParams({
          runId: "t1",
          auth: undefined,
          authProfileId: "p1",
          resolvedApiKey: "tok-a",
        }),
      );
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          auth: undefined,
          authProfileId: "p1",
          resolvedApiKey: "tok-b",
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("preserves caller-provided initialReplayState.replayInvalid:true (does not overwrite)", async () => {
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-tracked",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeAttemptParams({ runId: "t1" }));
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          initialReplayState: { replayInvalid: true },
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string; replayInvalid?: boolean };
      };
      // sdkSessionId is still injected from tracking, but replayInvalid
      // must remain true so replay-shim treats this as create-not-resume.
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBe("sdk-sess-tracked");
      expect(secondCallParams.initialReplayState?.replayInvalid).toBe(true);
    });

    it("updates the tracked session when onSessionEstablished reports a new sdkSessionId", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn();
      const client = createMockCopilotClient({ deleteSession });
      let nextSdkId = "sdk-sess-1";
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: nextSdkId,
          pooledClient: { key: TEST_POOL_KEY, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeAttemptParams({ runId: "t1" }));
      nextSdkId = "sdk-sess-2"; // Simulate downgraded resume → new SDK session.
      await harness.runAttempt(makeAttemptParams({ runId: "t2" }));
      await harness.reset?.({ sessionId: "oc-sess-reuse" });

      expect(deleteSession).toHaveBeenCalledTimes(1);
      // The newer sdkSessionId must be the one targeted by reset, not
      // the stale first-turn id.
      expect(deleteSession).toHaveBeenCalledWith("sdk-sess-2");
    });

    it("persists sdkSessionId in plugin state and resumes it from a new harness instance", async () => {
      const firstPool = makePoolMock();
      const secondPool = makePoolMock();
      const sessionStore = makeSessionStoreMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-sqlite",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const firstHarness = createCopilotAgentHarness({
        pool: firstPool,
        sessionStore: sessionStore.store,
      });
      const secondHarness = createCopilotAgentHarness({
        pool: secondPool,
        sessionStore: sessionStore.store,
      });

      await firstHarness.runAttempt(makeAttemptParams({ runId: "t1" }));
      await secondHarness.runAttempt(makeAttemptParams({ runId: "t2" }));

      expect(sessionStore.store.register).toHaveBeenCalledWith(
        "oc-sess-reuse",
        expect.objectContaining({
          schemaVersion: 2,
          sdkSessionId: "sdk-sess-sqlite",
        }),
      );
      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBe("sdk-sess-sqlite");
    });

    it("persists BYOK session compatibility with endpoint fingerprints instead of raw URLs", async () => {
      const sessionStore = makeSessionStoreMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-byok",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn() }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });

      await harness.runAttempt(
        makeAttemptParams({
          provider: "custom-proxy",
          model: {
            provider: "custom-proxy",
            id: "proxy-model",
            api: "openai-responses",
            baseUrl: "https://proxy.example/v1?routing=blue",
          },
          auth: undefined,
          authProfileId: "custom-proxy:main",
          resolvedApiKey: "byok-token",
        }),
      );

      const stored = sessionStore.entries.get("oc-sess-reuse");
      expect(stored?.compatKey).toContain("baseUrlFingerprint=sha256:");
      expect(stored?.compatKey).not.toContain("proxy.example");
      expect(stored?.compatKey).not.toContain("routing=blue");
    });

    it("does not reuse BYOK sessions when attached request auth mode changes", async () => {
      const pool = makePoolMock();
      const model = {
        provider: "custom-proxy",
        id: "proxy-model",
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1",
      };
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-byok",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn() }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(
        makeAttemptParams({
          provider: "custom-proxy",
          model: attachModelProviderRequestTransport(model, { auth: { mode: "provider-default" } }),
          auth: undefined,
          authProfileId: "custom-proxy:main",
          resolvedApiKey: "byok-token",
        }),
      );
      await harness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          provider: "custom-proxy",
          model: attachModelProviderRequestTransport(model, {
            auth: { mode: "header", headerName: "x-api-key", value: "byok-token" },
          }),
          auth: undefined,
          authProfileId: "custom-proxy:main",
          resolvedApiKey: "byok-token",
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("resumes shipped schema v1 plugin-state bindings for attempts", async () => {
      const sessionStore = makeSessionStoreMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-current",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const firstHarness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });

      await firstHarness.runAttempt(makeAttemptParams({ runId: "t1" }));
      const stored = sessionStore.entries.get("oc-sess-reuse");
      if (!stored) {
        throw new Error("expected persisted binding");
      }
      sessionStore.entries.set("oc-sess-reuse", {
        schemaVersion: 1,
        sdkSessionId: "sdk-sess-v1",
        compatKey: stored.compatKey,
        updatedAt: Date.now(),
      } as never);
      mocks.runCopilotAttempt.mockClear();
      const secondHarness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });

      await secondHarness.runAttempt(makeAttemptParams({ runId: "t2" }));

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[0]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBe("sdk-sess-v1");
    });

    it("starts a fresh SDK session when persisted binding lookup fails", async () => {
      const sessionStore = makeSessionStoreMock();
      sessionStore.store.lookup.mockImplementation(() => {
        throw new Error("sqlite read failed");
      });
      mocks.runCopilotAttempt.mockResolvedValue(ATTEMPT_RESULT);
      const harness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });

      await expect(harness.runAttempt(makeAttemptParams({ runId: "t1" }))).resolves.toBe(
        ATTEMPT_RESULT,
      );

      const callParams = mocks.runCopilotAttempt.mock.calls[0]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(callParams.initialReplayState?.sdkSessionId).toBeUndefined();
      expect(sessionStore.store.delete).toHaveBeenCalledWith("oc-sess-reuse");
    });

    it("keeps the in-memory binding when durable register fails", async () => {
      const sessionStore = makeSessionStoreMock();
      sessionStore.entries.set("oc-sess-reuse", {
        schemaVersion: 2,
        sdkSessionId: "sdk-sess-stale",
        compatKey: "stale",
        compactKey: "stale",
        authMode: "useLoggedInUser",
        updatedAt: 1,
      });
      sessionStore.store.register.mockImplementation(() => {
        throw new Error("sqlite write failed");
      });
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-memory-only",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });

      await harness.runAttempt(makeAttemptParams({ runId: "t1" }));
      await harness.runAttempt(makeAttemptParams({ runId: "t2" }));

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBe("sdk-sess-memory-only");
      expect(sessionStore.store.delete).toHaveBeenCalledWith("oc-sess-reuse");
      expect(sessionStore.entries.has("oc-sess-reuse")).toBe(false);
    });

    it("ignores a persisted sdkSessionId when the compatibility fingerprint changes", async () => {
      const sessionStore = makeSessionStoreMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-old-model",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const firstHarness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });
      const secondHarness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });

      await firstHarness.runAttempt(
        makeAttemptParams({ runId: "t1", model: { provider: "github-copilot", id: "gpt-4.1" } }),
      );
      await secondHarness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          model: { provider: "github-copilot", id: "claude-sonnet-4.5" },
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("ignores a persisted sdkSessionId when the default Copilot home changes by agent id", async () => {
      const sessionStore = makeSessionStoreMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-main-home",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const firstHarness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });
      const secondHarness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });
      const defaultHomeParams = {
        agentDir: undefined,
        copilotHome: undefined,
      };

      await firstHarness.runAttempt(
        makeAttemptParams({
          ...defaultHomeParams,
          runId: "t1",
          agentId: "main",
        }),
      );
      await secondHarness.runAttempt(
        makeAttemptParams({
          ...defaultHomeParams,
          runId: "t2",
          agentId: "ops",
        }),
      );

      const secondCallParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(secondCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("does not let stale plugin state override a newer incompatible tracked session", async () => {
      const sessionStore = makeSessionStoreMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-tracked-model",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });

      await harness.runAttempt(
        makeAttemptParams({ runId: "t1", model: { provider: "github-copilot", id: "gpt-4.1" } }),
      );
      const persisted = sessionStore.entries.get("oc-sess-reuse");
      expect(persisted).toBeDefined();

      await harness.runAttempt(
        makeAttemptParams({
          runId: "t2",
          model: { provider: "github-copilot", id: "claude-sonnet-4.5" },
        }),
      );
      sessionStore.entries.set("oc-sess-reuse", persisted!);
      await harness.runAttempt(
        makeAttemptParams({ runId: "t3", model: { provider: "github-copilot", id: "gpt-4.1" } }),
      );

      const thirdCallParams = mocks.runCopilotAttempt.mock.calls[2]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(thirdCallParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });

    it("deletes persisted sdkSessionId on reset even when no in-memory client is tracked", async () => {
      const sessionStore = makeSessionStoreMock();
      sessionStore.entries.set("oc-sess-reuse", {
        schemaVersion: 2,
        sdkSessionId: "sdk-sess-orphan",
        compatKey: "compat",
        compactKey: "compat",
        authMode: "useLoggedInUser",
        updatedAt: 1,
      });
      const harness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });

      await harness.reset?.({ sessionId: "oc-sess-reuse" });

      expect(sessionStore.store.delete).toHaveBeenCalledWith("oc-sess-reuse");
      expect(sessionStore.entries.has("oc-sess-reuse")).toBe(false);
    });

    it("still clears tracked SDK sessions when durable reset delete fails", async () => {
      const sessionStore = makeSessionStoreMock();
      sessionStore.store.delete.mockImplementation(() => {
        throw new Error("sqlite delete failed");
      });
      const deleteSession = vi.fn();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-reset",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient({ deleteSession }) },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });

      await harness.runAttempt(makeAttemptParams({ runId: "t1" }));
      await harness.reset?.({ sessionId: "oc-sess-reuse" });

      expect(deleteSession).toHaveBeenCalledWith("sdk-sess-reset");
    });

    it("blocks persisted reuse after reset cannot delete a durable binding", async () => {
      const sessionStore = makeSessionStoreMock();
      mocks.runCopilotAttempt.mockImplementationOnce(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-before-reset",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
        });
        return ATTEMPT_RESULT;
      });
      const firstHarness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });

      await firstHarness.runAttempt(makeAttemptParams({ runId: "t1" }));
      expect(sessionStore.entries.get("oc-sess-reuse")?.sdkSessionId).toBe("sdk-sess-before-reset");
      sessionStore.store.delete.mockImplementation(() => {
        throw new Error("sqlite delete failed");
      });
      mocks.runCopilotAttempt.mockResolvedValue(ATTEMPT_RESULT);
      const harness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });

      await harness.reset?.({ sessionId: "oc-sess-reuse" });
      await harness.runAttempt(makeAttemptParams({ runId: "t2" }));

      const callParams = mocks.runCopilotAttempt.mock.calls[1]?.[0] as {
        initialReplayState?: { sdkSessionId?: string };
      };
      expect(callParams.initialReplayState?.sdkSessionId).toBeUndefined();
    });
  });

  describe("compact", () => {
    function makeCompactParams(overrides: Record<string, unknown> = {}): any {
      return {
        provider: "github-copilot",
        model: { provider: "github-copilot", id: "gpt-4.1" },
        cwd: "/ws",
        workspaceDir: "/ws",
        agentDir: "/home",
        copilotHome: "/copilot-home",
        auth: { useLoggedInUser: true },
        sessionId: "oc-sess-compact",
        sessionFile: "/session.json",
        ...overrides,
      };
    }

    it("returns ok:false when sessionId is missing", async () => {
      const harness = createCopilotAgentHarness({ pool: makePoolMock() });
      const result = await harness.compact?.({
        workspaceDir: "/ws",
      } as AgentHarnessCompactParams);
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "missing-required-params",
      });
    });

    it("returns ok:false when the SDK session is not tracked", async () => {
      const harness = createCopilotAgentHarness({ pool: makePoolMock() });
      const result = await harness.compact?.({
        sessionId: "oc-sess-compact-1",
        trigger: "budget",
        currentTokenCount: 12345,
      } as AgentHarnessCompactParams);

      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "missing_thread_binding",
        failure: { reason: "missing_thread_binding" },
      });
    });

    it("does not resume a session while deferred background compaction is pending", async () => {
      const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
      const pool = makePoolMock();
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-background",
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        deps.onDeferredCompaction?.({
          abort: () => undefined,
          cleanup: cleanup.promise,
          sdkSessionId: "sdk-sess-background",
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeCompactParams());
      const result = await harness.compact?.(makeCompactParams());

      expect(pool.acquire.mock.calls).toHaveLength(0);
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "background-compaction-pending",
        failure: { reason: "background-compaction-pending" },
      });
      cleanup.resolve("completed");
      await flushAsyncWork();
    });

    it("clears the reset block when storing a replacement session fails", async () => {
      const cleanup = createDeferred<"aborted" | "completed" | "deadline">();
      const sessionStore = makeSessionStoreMock();
      sessionStore.store.register.mockImplementation(() => {
        throw new Error("sqlite register failed");
      });
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        const sdkSessionId =
          mocks.runCopilotAttempt.mock.calls.length === 1
            ? "sdk-sess-background"
            : "sdk-sess-replacement";
        deps.onSessionEstablished?.({
          sdkSessionId,
          pooledClient: { key: TEST_POOL_KEY, client: createMockCopilotClient() },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        if (sdkSessionId === "sdk-sess-background") {
          deps.onDeferredCompaction?.({
            abort: () => undefined,
            cleanup: cleanup.promise,
            sdkSessionId,
          });
        }
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });
      const params = makeCompactParams({ sessionId: "oc-sess-store-failure" });

      await harness.runAttempt(params);
      await harness.runAttempt(params);
      await harness.runAttempt(params);

      expect(mocks.runCopilotAttempt.mock.calls[1]?.[0]).not.toMatchObject({
        initialReplayState: expect.objectContaining({ sdkSessionId: "sdk-sess-background" }),
      });
      expect(mocks.runCopilotAttempt.mock.calls[2]?.[0]).toMatchObject({
        initialReplayState: expect.objectContaining({ sdkSessionId: "sdk-sess-replacement" }),
      });
      cleanup.resolve("completed");
      await flushAsyncWork();
    });

    it("calls the SDK history compaction RPC without requiring a workspace sidecar", async () => {
      const beforeCompaction = vi.fn();
      const afterCompaction = vi.fn();
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "before_compaction", handler: beforeCompaction },
          { hookName: "after_compaction", handler: afterCompaction },
        ]),
      );
      const compact = vi.fn(async () => ({
        success: true,
        tokensRemoved: 123,
        messagesRemoved: 4,
        summaryContent: "compacted summary",
        contextWindow: {
          tokenLimit: 1000,
          currentTokens: 777,
          messagesLength: 12,
        },
      }));
      const disconnect = vi.fn(async () => {
        throw new Error("disconnect failed");
      });
      const resumeSession = vi.fn(async () => ({
        disconnect,
        rpc: { history: { compact } },
      }));
      const pool = makePoolMock();
      pool.acquire = vi.fn(async () => ({
        key: TEST_POOL_KEY,
        client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
      }));
      const release = vi.fn(async () => undefined);
      pool.release = release;
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-compact",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(
        makeCompactParams({
          agentId: "main",
          sessionId: "oc-sess-compact-1",
          sessionKey: "agent:main:main",
        }),
      );
      const result = await harness.compact?.({
        ...makeCompactParams({ sessionId: "oc-sess-compact-1" }),
        model: "gpt-4.1",
        sessionKey: "agent:main:main",
        sessionId: "oc-sess-compact-1",
        currentTokenCount: 900,
        workspaceDir: "/this\u0000is/illegal",
        customInstructions: "Keep decisions.",
      });

      expect(resumeSession).toHaveBeenCalledWith(
        "sdk-sess-compact",
        expect.objectContaining({
          availableTools: [],
          continuePendingWork: false,
          model: "gpt-4.1",
          suppressResumeEvent: true,
          tools: [],
          workingDirectory: "/workspace",
        }),
      );
      expect(compact).toHaveBeenCalledWith({ customInstructions: "Keep decisions." });
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(beforeCompaction).toHaveBeenCalledWith(
        { messageCount: -1, sessionFile: "/session.json" },
        expect.objectContaining({
          modelId: "gpt-4.1",
          modelProviderId: "github-copilot",
          sessionId: "oc-sess-compact-1",
          sessionKey: "agent:main:main",
        }),
      );
      expect(afterCompaction).toHaveBeenCalledWith(
        { compactedCount: 4, messageCount: -1, sessionFile: "/session.json" },
        expect.objectContaining({ sessionId: "oc-sess-compact-1" }),
      );
      expect(result).toEqual({
        ok: true,
        compacted: true,
        reason: "copilot-sdk-history-compacted",
        result: {
          summary: "compacted summary",
          firstKeptEntryId: "",
          tokensBefore: 900,
          tokensAfter: 777,
          details: {
            success: true,
            tokensRemoved: 123,
            messagesRemoved: 4,
            summaryContent: "compacted summary",
            contextWindow: {
              tokenLimit: 1000,
              currentTokens: 777,
              messagesLength: 12,
            },
          },
          sessionId: "oc-sess-compact-1",
          sessionFile: "/session.json",
        },
      });
    });

    it("disconnects the resumed SDK session when compact aborts after resume", async () => {
      const abortController = new AbortController();
      const compact = vi.fn(async () => ({
        success: true,
        tokensRemoved: 123,
        messagesRemoved: 4,
      }));
      const disconnect = vi.fn(async () => undefined);
      const resumeSession = vi.fn(async () => {
        abortController.abort(new Error("stop compact"));
        return {
          disconnect,
          rpc: { history: { compact } },
        };
      });
      const pool = makePoolMock();
      pool.acquire = vi.fn(async () => ({
        key: TEST_POOL_KEY,
        client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
      }));
      const release = vi.fn(async () => undefined);
      pool.release = release;
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-abort",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(
        makeCompactParams({
          agentId: "main",
          sessionId: "oc-sess-abort",
          sessionKey: "agent:main:main",
        }),
      );
      const result = await harness.compact?.({
        ...makeCompactParams({ sessionId: "oc-sess-abort" }),
        abortSignal: abortController.signal,
        model: "gpt-4.1",
        sessionKey: "agent:main:main",
        sessionId: "oc-sess-abort",
      });

      expect(resumeSession).toHaveBeenCalledTimes(1);
      expect(compact).not.toHaveBeenCalled();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "copilot-sdk-history-compact-failed",
        failure: {
          reason: "copilot-sdk-history-compact-failed",
          rawError: "stop compact",
        },
      });
    });

    it("requires matching token auth before compacting a tracked token-auth SDK session", async () => {
      const compact = vi.fn(async () => ({
        success: true,
        tokensRemoved: 45,
        messagesRemoved: 2,
      }));
      const resumeSession = vi.fn(async () => ({
        disconnect: vi.fn(async () => undefined),
        rpc: { history: { compact } },
      }));
      const pool = makePoolMock();
      const acquire = vi.fn(async () => ({
        key: TEST_POOL_KEY,
        client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
      }));
      pool.acquire = acquire;
      pool.release = vi.fn(async () => undefined);
      mocks.resolvePoolAcquire
        .mockReturnValueOnce({
          auth: {
            agentId: "test",
            authMode: "gitHubToken",
            authProfileId: "p1",
            authProfileVersion: "v1",
            copilotHome: "/copilot-home",
            gitHubToken: "ghp_test",
          },
          key: { agentId: "test", authMode: "gitHubToken", copilotHome: "/copilot-home" },
          options: { copilotHome: "/copilot-home", gitHubToken: "ghp_test" },
          provider: { mode: "github-copilot" },
        })
        .mockReturnValueOnce({
          auth: {
            agentId: "test",
            authMode: "useLoggedInUser",
            copilotHome: "/copilot-home",
          },
          key: { agentId: "test", authMode: "useLoggedInUser", copilotHome: "/copilot-home" },
          options: { copilotHome: "/copilot-home", useLoggedInUser: true },
          provider: { mode: "github-copilot" },
        })
        .mockReturnValueOnce({
          auth: {
            agentId: "test",
            authMode: "gitHubToken",
            authProfileId: "p1",
            authProfileVersion: "v1",
            copilotHome: "/copilot-home",
            gitHubToken: "ghp_test",
          },
          key: { agentId: "test", authMode: "gitHubToken", copilotHome: "/copilot-home" },
          options: { copilotHome: "/copilot-home", gitHubToken: "ghp_test" },
          provider: { mode: "github-copilot" },
        });
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-token",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(
        makeCompactParams({
          auth: { gitHubToken: "ghp_test", profileId: "p1", profileVersion: "v1" },
          sessionId: "oc-sess-token",
        }),
      );
      const result = await harness.compact?.(
        makeCompactParams({
          auth: undefined,
          sessionId: "oc-sess-token",
        }),
      );

      expect(acquire).not.toHaveBeenCalled();
      expect(resumeSession).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "missing_thread_binding",
        failure: { reason: "missing_thread_binding" },
      });

      const matchingResult = await harness.compact?.(
        makeCompactParams({
          auth: undefined,
          authProfileId: "p1",
          resolvedApiKey: "ghp_test",
          sessionId: "oc-sess-token",
        }),
      );

      expect(resumeSession).toHaveBeenCalledWith(
        "sdk-sess-token",
        expect.objectContaining({
          continuePendingWork: false,
          gitHubToken: "ghp_test",
          model: "gpt-4.1",
          suppressResumeEvent: true,
          workingDirectory: "/workspace",
        }),
      );
      expect(matchingResult?.compacted).toBe(true);
    });

    it("compacts tracked BYOK sessions from production compact params with a fresh proxy", async () => {
      const compact = vi.fn(async () => ({
        success: true,
        tokensRemoved: 45,
        messagesRemoved: 2,
      }));
      const resumeSession = vi.fn(async () => ({
        disconnect: vi.fn(async () => undefined),
        rpc: { history: { compact } },
      }));
      const pool = makePoolMock();
      const acquire = vi.fn(async () => ({
        key: TEST_POOL_KEY,
        client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
      }));
      pool.acquire = acquire;
      pool.release = vi.fn(async () => undefined);
      const trackedRuntimeModel = {
        provider: "local-proxy",
        id: "proxy-model",
        api: "openai-responses",
        baseUrl: "https://proxy.example/v1",
      };
      mocks.resolvePoolAcquire.mockImplementation((params: any) => {
        const runtimeModel = params.runtimeModel ?? params.model;
        if (!runtimeModel?.baseUrl) {
          throw new Error(COPILOT_BYOK_PROVIDER_ERROR);
        }
        return {
          auth: {
            agentId: "test",
            authMode: "byok",
            authProfileId: "byok:local-proxy",
            authProfileVersion:
              runtimeModel.baseUrl === trackedRuntimeModel.baseUrl
                ? "sha256:provider"
                : "sha256:rotated",
            copilotHome: "/copilot-home",
          },
          key: { agentId: "test", authMode: "byok", copilotHome: "/copilot-home" },
          options: { copilotHome: "/copilot-home" },
          provider: { mode: "byok" },
        };
      });
      const closeByokProxy = vi.fn(async () => undefined);
      mocks.createCopilotByokProxy.mockImplementation(async (provider: any) => ({
        close: closeByokProxy,
        provider: {
          ...provider,
          provider: {
            ...provider.provider,
            baseUrl: "http://127.0.0.1:49152/proxy/v1",
          },
        },
      }));
      const trackedProvider = {
        type: "openai" as const,
        wireApi: "responses" as const,
        baseUrl: "https://proxy.example/v1",
        modelId: "proxy-model",
        wireModel: "proxy-model",
      };
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          compactionSessionConfig: {
            ...TEST_SESSION_CONFIG,
            provider: trackedProvider,
          },
          sdkSessionId: "sdk-sess-byok",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(
        makeCompactParams({
          model: trackedRuntimeModel,
          provider: "local-proxy",
          authProfileId: "byok:local-proxy",
          resolvedApiKey: "byok-token",
          sessionId: "oc-sess-byok",
        }),
      );
      mocks.resolvePoolAcquire.mockClear();

      const rotatedResult = await harness.compact?.(
        makeCompactParams({
          model: "proxy-model",
          runtimeModel: {
            ...trackedRuntimeModel,
            baseUrl: "https://rotated.example/v1",
          },
          provider: "local-proxy",
          authProfileId: "byok:local-proxy",
          sessionId: "oc-sess-byok",
        }),
      );

      expect(mocks.resolvePoolAcquire).toHaveBeenCalledTimes(1);
      expect(resumeSession).not.toHaveBeenCalled();
      expect(rotatedResult).toEqual({
        ok: false,
        compacted: false,
        reason: "missing_thread_binding",
        failure: { reason: "missing_thread_binding" },
      });
      mocks.resolvePoolAcquire.mockClear();

      const result = await harness.compact?.(
        makeCompactParams({
          model: "proxy-model",
          runtimeModel: trackedRuntimeModel,
          provider: "local-proxy",
          authProfileId: "byok:local-proxy",
          sessionId: "oc-sess-byok",
        }),
      );

      expect(mocks.resolvePoolAcquire).toHaveBeenCalledTimes(1);
      expect(mocks.createCopilotByokProxy).toHaveBeenCalledWith({
        mode: "byok",
        provider: trackedProvider,
      });
      expect(resumeSession).toHaveBeenCalledWith(
        "sdk-sess-byok",
        expect.objectContaining({
          continuePendingWork: false,
          model: "gpt-4.1",
          provider: expect.objectContaining({
            baseUrl: "http://127.0.0.1:49152/proxy/v1",
          }),
          suppressResumeEvent: true,
        }),
      );
      expect(closeByokProxy).toHaveBeenCalledTimes(1);
      expect(result?.compacted).toBe(true);
    });

    it("does not compact a tracked SDK session after model changes", async () => {
      const resumeSession = vi.fn();
      const pool = makePoolMock();
      const acquire = vi.fn(async () => ({
        key: TEST_POOL_KEY,
        client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
      }));
      pool.acquire = acquire;
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-model",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeCompactParams({ sessionId: "oc-sess-model" }));
      const result = await harness.compact?.(
        makeCompactParams({ model: "gpt-5", sessionId: "oc-sess-model" }),
      );

      expect(acquire).not.toHaveBeenCalled();
      expect(resumeSession).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "missing_thread_binding",
        failure: { reason: "missing_thread_binding" },
      });
    });

    it("does not compact a logged-in-user SDK session for a token-auth compact request", async () => {
      const resumeSession = vi.fn();
      const pool = makePoolMock();
      pool.acquire = vi.fn(async () => ({
        key: TEST_POOL_KEY,
        client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
      }));
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-login",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeCompactParams({ sessionId: "oc-sess-login" }));
      mocks.resolvePoolAcquire.mockReturnValueOnce({
        auth: {
          agentId: "test",
          authMode: "gitHubToken",
          authProfileId: "p1",
          authProfileVersion: "v1",
          copilotHome: "/copilot-home",
          gitHubToken: "ghp_test",
        },
        key: { agentId: "test", authMode: "gitHubToken", copilotHome: "/copilot-home" },
        options: { copilotHome: "/copilot-home", gitHubToken: "ghp_test" },
        provider: { mode: "github-copilot" },
      });
      const result = await harness.compact?.(
        makeCompactParams({
          auth: { gitHubToken: "ghp_test", profileId: "p1", profileVersion: "v1" },
          sessionId: "oc-sess-login",
        }),
      );

      expect(resumeSession).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "missing_thread_binding",
        failure: { reason: "missing_thread_binding" },
      });
    });

    it("classifies missing SDK sessions as stale bindings for host recovery", async () => {
      const sessionStore = makeSessionStoreMock();
      const resumeSession = vi.fn(async () => {
        throw new Error("session not found");
      });
      const pool = makePoolMock();
      pool.acquire = vi.fn(async () => ({
        key: TEST_POOL_KEY,
        client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
      }));
      pool.release = vi.fn(async () => undefined);
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-stale",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool, sessionStore: sessionStore.store });

      await harness.runAttempt(makeCompactParams({ sessionId: "oc-sess-stale" }));
      const result = await harness.compact?.(makeCompactParams({ sessionId: "oc-sess-stale" }));

      expect(sessionStore.store.delete).toHaveBeenCalledWith("oc-sess-stale");
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "stale_thread_binding",
        failure: { reason: "stale_thread_binding", rawError: "session not found" },
      });
    });

    it("does not start SDK compaction when the compact call is already aborted", async () => {
      const abort = new AbortController();
      abort.abort(new Error("caller canceled"));
      const resumeSession = vi.fn();
      const pool = makePoolMock();
      pool.acquire = vi.fn(async () => ({
        key: TEST_POOL_KEY,
        client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
      }));
      pool.release = vi.fn(async () => undefined);
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-abort",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeCompactParams({ sessionId: "oc-sess-abort" }));
      const result = await harness.compact?.(
        makeCompactParams({ abortSignal: abort.signal, sessionId: "oc-sess-abort" }),
      );

      expect(resumeSession).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "copilot-sdk-history-compact-failed",
        failure: {
          reason: "copilot-sdk-history-compact-failed",
          rawError: "caller canceled",
        },
      });
    });

    it("aborts the SDK manual history compaction when the compact call is canceled", async () => {
      const abort = new AbortController();
      let rejectCompact: ((reason?: unknown) => void) | undefined;
      const compact = vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectCompact = reject;
          }),
      );
      const abortManualCompaction = vi.fn(async () => {
        rejectCompact?.(new Error("manual compaction aborted"));
        return { aborted: true };
      });
      const disconnect = vi.fn(async () => undefined);
      const resumeSession = vi.fn(async () => ({
        disconnect,
        rpc: { history: { abortManualCompaction, compact } },
      }));
      const pool = makePoolMock();
      pool.acquire = vi.fn(async () => ({
        key: TEST_POOL_KEY,
        client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
      }));
      pool.release = vi.fn(async () => undefined);
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-cancel",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeCompactParams({ sessionId: "oc-sess-cancel" }));
      const resultPromise = harness.compact?.(
        makeCompactParams({ abortSignal: abort.signal, sessionId: "oc-sess-cancel" }),
      );
      await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
      abort.abort(new Error("caller canceled"));
      const result = await resultPromise;

      expect(abortManualCompaction).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "copilot-sdk-history-compact-failed",
        failure: {
          reason: "copilot-sdk-history-compact-failed",
          rawError: "caller canceled",
        },
      });
    });

    it("refuses persisted token-auth bindings without matching token auth", async () => {
      const sessionStore = makeSessionStoreMock();
      mocks.resolvePoolAcquire.mockReturnValueOnce({
        auth: {
          agentId: "test",
          authMode: "gitHubToken",
          authProfileId: "p1",
          authProfileVersion: "v1",
          copilotHome: "/copilot-home",
          gitHubToken: "ghp_test",
        },
        key: { agentId: "test", authMode: "gitHubToken", copilotHome: "/copilot-home" },
        options: { copilotHome: "/copilot-home", gitHubToken: "ghp_test" },
        provider: { mode: "github-copilot" },
      });
      mocks.runCopilotAttempt.mockImplementationOnce(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-persisted-token",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession: vi.fn() }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      const firstHarness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });
      await firstHarness.runAttempt(
        makeCompactParams({
          auth: { gitHubToken: "ghp_test", profileId: "p1", profileVersion: "v1" },
          sessionId: "oc-sess-persisted-token",
        }),
      );

      const resumeSession = vi.fn();
      const secondPool = makePoolMock();
      const secondAcquire = vi.fn(async () => ({
        key: TEST_POOL_KEY,
        client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
      }));
      secondPool.acquire = secondAcquire;
      const secondHarness = createCopilotAgentHarness({
        pool: secondPool,
        sessionStore: sessionStore.store,
      });
      const result = await secondHarness.compact?.(
        makeCompactParams({ auth: undefined, sessionId: "oc-sess-persisted-token" }),
      );

      expect(secondAcquire).not.toHaveBeenCalled();
      expect(resumeSession).not.toHaveBeenCalled();
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "missing_thread_binding",
        failure: { reason: "missing_thread_binding" },
      });

      mocks.resolvePoolAcquire.mockReturnValueOnce({
        auth: {
          agentId: "test",
          authMode: "gitHubToken",
          authProfileId: "p1",
          authProfileVersion: "v2",
          copilotHome: "/copilot-home",
          gitHubToken: "ghp_other",
        },
        key: { agentId: "test", authMode: "gitHubToken", copilotHome: "/copilot-home" },
        options: { copilotHome: "/copilot-home", gitHubToken: "ghp_other" },
        provider: { mode: "github-copilot" },
      });
      const rotatedPool = makePoolMock();
      const rotatedAcquire = vi.fn();
      rotatedPool.acquire = rotatedAcquire;
      const rotatedHarness = createCopilotAgentHarness({
        pool: rotatedPool,
        sessionStore: sessionStore.store,
      });
      const rotatedResult = await rotatedHarness.compact?.(
        makeCompactParams({
          auth: { gitHubToken: "ghp_other", profileId: "p1", profileVersion: "v2" },
          sessionId: "oc-sess-persisted-token",
        }),
      );

      expect(rotatedAcquire).not.toHaveBeenCalled();
      expect(rotatedResult).toEqual({
        ok: false,
        compacted: false,
        reason: "missing_thread_binding",
        failure: { reason: "missing_thread_binding" },
      });
    });

    it("does not compact a persisted SDK binding after harness restart", async () => {
      const sessionStore = makeSessionStoreMock();
      const firstHarness = createCopilotAgentHarness({
        pool: makePoolMock(),
        sessionStore: sessionStore.store,
      });
      mocks.runCopilotAttempt.mockImplementationOnce(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-persisted",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession: vi.fn() }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      await firstHarness.runAttempt(makeCompactParams({ sessionId: "oc-sess-persisted" }));

      const resumeSession = vi.fn();
      const secondPool = makePoolMock();
      const secondAcquire = vi.fn(async () => ({
        key: TEST_POOL_KEY,
        client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
      }));
      secondPool.acquire = secondAcquire;
      secondPool.release = vi.fn(async () => undefined);
      const secondHarness = createCopilotAgentHarness({
        pool: secondPool,
        sessionStore: sessionStore.store,
      });

      const result = await secondHarness.compact?.(
        makeCompactParams({ sessionId: "oc-sess-persisted" }),
      );

      expect(secondAcquire).not.toHaveBeenCalled();
      expect(resumeSession).not.toHaveBeenCalled();
      expect(sessionStore.store.delete).not.toHaveBeenCalledWith("oc-sess-persisted");
      expect(result).toEqual({
        ok: false,
        compacted: false,
        reason: "missing_thread_binding",
        failure: { reason: "missing_thread_binding" },
      });
    });

    it("reports SDK history compaction no-ops without writing compatibility state", async () => {
      const compact = vi.fn(async () => ({
        success: true,
        tokensRemoved: 0,
        messagesRemoved: 0,
      }));
      const resumeSession = vi.fn(async () => ({
        disconnect: vi.fn(async () => undefined),
        rpc: { history: { compact } },
      }));
      const pool = makePoolMock();
      pool.acquire = vi.fn(async () => ({
        key: TEST_POOL_KEY,
        client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
      }));
      pool.release = vi.fn(async () => undefined);
      mocks.runCopilotAttempt.mockImplementation(async (_params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-noop",
          pooledClient: {
            key: TEST_POOL_KEY,
            client: createMockCopilotClient({ deleteSession: vi.fn(), resumeSession }),
          },
          sessionConfig: TEST_SESSION_CONFIG,
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotAgentHarness({ pool });

      await harness.runAttempt(makeCompactParams({ sessionId: "oc-sess-noop" }));
      const result = await harness.compact?.({
        ...makeCompactParams({ sessionId: "oc-sess-noop" }),
        sessionId: "oc-sess-noop",
        workspaceDir: "/this\u0000is/illegal",
      });

      expect(compact).toHaveBeenCalledWith(undefined);
      expect(result).toEqual({
        ok: true,
        compacted: false,
        reason: "already under target",
      });
    });
  });

  describe("runSideQuestion", () => {
    it("is not implemented; /btw falls through to the in-tree PI fallback path", () => {
      const harness = createCopilotAgentHarness({ pool: makePoolMock() });
      expect(harness["runSideQuestion"]).toBeUndefined();
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
