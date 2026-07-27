// Hook integration coverage for direct and queued embedded compaction.

import { expectDefined } from "@openclaw/normalization-core";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import {
  acquireSessionWriteLockMock,
  applyExtraParamsToAgentMock,
  applyAgentCompactionSettingsFromConfigMock,
  buildAgentRuntimePlanMock,
  buildEmbeddedSystemPromptMock,
  contextEngineCompactMock,
  compactWithSafetyTimeoutMock,
  createAgentSessionMock,
  createPreparedEmbeddedAgentSettingsManagerMock,
  createOpenClawCodingToolsMock,
  enqueueCommandInLaneMock,
  ensureAuthProfileStoreMock,
  ensureRuntimePluginsLoaded,
  estimateTokensMock,
  getApiKeyForModelMock,
  getMemorySearchManagerMock,
  guardSessionManagerMock,
  hookRunner,
  listRegisteredPluginAgentPromptGuidanceMock,
  loadCompactHooksHarness,
  maybeCompactAgentHarnessSessionMock,
  resolveAgentHarnessPolicyMock,
  registerProviderStreamForModelMock,
  resolveProviderEntryApiKeyProfileReferenceMock,
  resolveContextWindowInfoMock,
  resolveContextEngineMock,
  resolveEmbeddedAgentStreamFnMock,
  resolveMemorySearchConfigMock,
  resolveModelAsyncMock,
  resolveModelMock,
  resolveSandboxContextMock,
  resolveSessionAgentIdMock,
  resolveSessionAgentIdsMock,
  rotateTranscriptAfterCompactionMock,
  selectAgentHarnessForPreparedModelProvidersMock,
  selectAgentHarnessMock,
  shouldPreferExplicitConfigApiKeyAuthMock,
  resetCompactHooksHarnessMocks,
  resetCompactSessionStateMocks,
  sessionAbortCompactionMock,
  sessionMessages,
  sessionCompactImpl,
  triggerInternalHook,
} from "./compact.hooks.harness.js";
import {
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  isEmbeddedAgentRunHandleActive,
  setActiveEmbeddedRun,
} from "./runs.js";

let compactEmbeddedAgentSessionDirect: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;
let compactEmbeddedAgentSession: typeof import("./compact.queued.js").compactEmbeddedAgentSession;
let compactTesting: typeof import("./compact.js").testing;
let onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;
let onInternalSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onInternalSessionTranscriptUpdate;
let withOwnedSessionTranscriptWrites: typeof import("../../config/sessions/transcript-write-context.js").withOwnedSessionTranscriptWrites;

const TEST_SESSION_ID = "session-1";
const TEST_SESSION_KEY = "agent:main:session-1";
const TEST_SESSION_FILE = "/tmp/session.jsonl";
const TEST_WORKSPACE_DIR = "/tmp";
const TEST_CUSTOM_INSTRUCTIONS = "focus on decisions";
type SessionHookEvent = {
  type?: string;
  action?: string;
  sessionKey?: string;
  context?: Record<string, unknown>;
};
type PostCompactionSyncParams = {
  archiveFiles?: string[];
  reason: string;
  sessionFiles?: string[];
  sessions?: Array<{ agentId: string; sessionId: string; sessionKey?: string }>;
};
type PostCompactionSync = (params?: unknown) => Promise<void>;
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  // Tests use manual deferreds to prove queued compaction waits at the exact
  // lifecycle boundary instead of racing transcript updates.
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  if (!resolve) {
    throw new Error("Expected compaction deferred resolver to be initialized");
  }
  return { promise, resolve };
}

function mockPendingContextEngineCompaction() {
  const pending = {
    signal: undefined as AbortSignal | undefined,
    started: createDeferred<void>(),
    release: createDeferred<void>(),
  };
  contextEngineCompactMock.mockImplementationOnce(async (...args: unknown[]) => {
    const [params] = args;
    pending.signal = (params as { abortSignal?: AbortSignal }).abortSignal;
    pending.started.resolve(undefined);
    await pending.release.promise;
    return {
      ok: true,
      compacted: true,
      reason: undefined,
      result: { summary: "engine-summary", tokensAfter: 50 },
    };
  });
  return pending;
}

function mockPendingNativeCompaction() {
  const pending = {
    signal: undefined as AbortSignal | undefined,
    started: createDeferred<void>(),
    terminal: createDeferred<{ ok: false; compacted: false; reason: string }>(),
  };
  maybeCompactAgentHarnessSessionMock.mockImplementationOnce(async (...args: unknown[]) => {
    const [params] = args;
    pending.signal = (params as { abortSignal?: AbortSignal }).abortSignal;
    pending.started.resolve(undefined);
    return await pending.terminal.promise;
  });
  return pending;
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function findMockCall(mock: ReturnType<typeof vi.fn>, predicate: (arg: unknown[]) => boolean) {
  const call = mock.mock.calls.find((entry) => predicate(entry));
  if (!call) {
    throw new Error("Expected matching mock call");
  }
  return call;
}

function mockResolvedModel(params?: {
  supportsTools?: boolean;
  input?: string[];
  contextWindow?: number;
}) {
  resolveModelMock.mockReset();
  resolveModelMock.mockImplementation(
    (provider = "openai", modelId = "fake", _agentDir?: string, cfg?: unknown) => {
      const providerConfig = (
        cfg as
          | {
              models?: {
                providers?: Record<string, { api?: string; baseUrl?: string }>;
              };
            }
          | undefined
      )?.models?.providers?.[provider];
      return {
        model: {
          provider,
          api: providerConfig?.api ?? "openai-responses",
          baseUrl: providerConfig?.baseUrl?.trim() || "https://api.openai.com/v1",
          id: modelId,
          input: params?.input ?? [],
          ...(params?.contextWindow === undefined ? {} : { contextWindow: params.contextWindow }),
          ...(params?.supportsTools === undefined
            ? {}
            : { compat: { supportsTools: params.supportsTools } }),
        },
        error: null,
        authStorage: { setRuntimeApiKey: vi.fn() },
        modelRegistry: {},
      };
    },
  );
}

function compactionConfig(mode: "await" | "off" | "async") {
  return {
    agents: {
      defaults: {
        compaction: {
          postIndexSync: mode,
        },
      },
    },
  } as never;
}

function wrappedCompactionArgs(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_SESSION_KEY,
    sessionFile: TEST_SESSION_FILE,
    workspaceDir: TEST_WORKSPACE_DIR,
    customInstructions: TEST_CUSTOM_INSTRUCTIONS,
    enqueue: async <T>(task: () => Promise<T> | T) => await task(),
    ...overrides,
  };
}

function createPreparedCodexCompactionPlans(modelId = "gpt-5.5") {
  const modelRoute = {
    provider: "openai",
    modelId,
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authRequirement: "api-key",
    requestTransportOverrides: "none",
    runtimePolicy: { compatibleIds: ["codex"] },
  } as const;
  const runtimeAuthPlan = {
    providerForAuth: "openai",
    modelId,
    authProfileProviderForAuth: "openai",
    harnessAuthProvider: "openai",
    selectedAuthMode: "api-key",
    modelRoute,
  } as const;
  return {
    modelRoute,
    runtimeAuthPlan,
    runtimePlan: {
      resolvedRef: {
        provider: "openai",
        modelId,
        modelApi: "openai-responses",
        harnessId: "codex",
      },
      auth: runtimeAuthPlan,
    } as never,
  };
}

const sessionHook = (action: string): SessionHookEvent | undefined =>
  triggerInternalHook.mock.calls.find((call) => {
    const event = call[0] as SessionHookEvent | undefined;
    return event?.type === "session" && event.action === action;
  })?.[0] as SessionHookEvent | undefined;

async function runCompactionHooks(params: { sessionKey?: string; messageProvider?: string }) {
  // Build metrics through the production helper so hook payload assertions stay
  // aligned with compaction token accounting.
  const originalMessages = sessionMessages.slice(1) as AgentMessage[];
  const currentMessages = sessionMessages.slice(1) as AgentMessage[];
  const beforeMetrics = compactTesting.buildBeforeCompactionHookMetrics({
    originalMessages,
    currentMessages,
    estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
  });

  const hookState = await compactTesting.runBeforeCompactionHooks({
    hookRunner,
    sessionId: TEST_SESSION_ID,
    sessionKey: params.sessionKey,
    sessionAgentId: "main",
    workspaceDir: TEST_WORKSPACE_DIR,
    messageProvider: params.messageProvider,
    metrics: beforeMetrics,
  });

  await compactTesting.runAfterCompactionHooks({
    hookRunner,
    sessionId: TEST_SESSION_ID,
    sessionAgentId: "main",
    hookSessionKey: hookState.hookSessionKey,
    missingSessionKey: hookState.missingSessionKey,
    workspaceDir: TEST_WORKSPACE_DIR,
    messageProvider: params.messageProvider,
    messageCountAfter: 1,
    tokensAfter: 10,
    compactedCount: 1,
    sessionFile: TEST_SESSION_FILE,
    summaryLength: "summary".length,
    tokensBefore: 120,
    firstKeptEntryId: "entry-1",
  });
}

beforeAll(async () => {
  const loaded = await loadCompactHooksHarness();
  compactEmbeddedAgentSessionDirect = (params) =>
    loaded.compactEmbeddedAgentSessionDirect({ agentId: "main", ...params });
  compactEmbeddedAgentSession = loaded.compactEmbeddedAgentSession;
  compactTesting = loaded.testing;
  onSessionTranscriptUpdate = loaded.onSessionTranscriptUpdate;
  onInternalSessionTranscriptUpdate = loaded.onInternalSessionTranscriptUpdate;
  withOwnedSessionTranscriptWrites = loaded.withOwnedSessionTranscriptWrites;
});

beforeEach(() => {
  resetCompactHooksHarnessMocks();
});

describe("compactEmbeddedAgentSessionDirect hooks", () => {
  beforeEach(() => {
    ensureRuntimePluginsLoaded.mockReset();
    triggerInternalHook.mockClear();
    hookRunner.hasHooks.mockReset();
    hookRunner.runBeforeCompaction.mockReset();
    hookRunner.runAfterCompaction.mockReset();
    mockResolvedModel();
    sessionCompactImpl.mockReset();
    sessionCompactImpl.mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      details: { ok: true },
    });
    resetCompactSessionStateMocks();
  });

  it("acquires the normal session lock without process-wide reentry", async () => {
    const result = await compactEmbeddedAgentSessionDirect(wrappedCompactionArgs());

    expect(result).toMatchObject({ ok: true, compacted: true });
    const lockOptions = mockCallArg(acquireSessionWriteLockMock);
    expect(lockOptions).toMatchObject({ sessionFile: TEST_SESSION_FILE });
    expect(lockOptions).not.toHaveProperty("allowReentrant");
  });

  it("reuses the matching logical writer lock during direct compaction", async () => {
    const withSessionWriteLockCall = vi.fn();
    const withSessionWriteLock = async <T>(run: () => Promise<T> | T): Promise<T> => {
      withSessionWriteLockCall();
      return await run();
    };

    const result = await withOwnedSessionTranscriptWrites(
      {
        sessionFile: TEST_SESSION_FILE,
        sessionKey: TEST_SESSION_KEY,
        withSessionWriteLock,
      },
      async () => await compactEmbeddedAgentSessionDirect(wrappedCompactionArgs()),
    );

    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(withSessionWriteLockCall).toHaveBeenCalledOnce();
    expect(acquireSessionWriteLockMock).not.toHaveBeenCalled();
  });

  it("fails closed before generic compaction for a model-locked native session", async () => {
    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-5.5",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      failure: { reason: "model_selection_locked" },
    });
    expect(resolveModelMock).not.toHaveBeenCalled();
    expect(sessionCompactImpl).not.toHaveBeenCalled();
  });

  it("preserves prepared runtime plans for the normalized primary compaction candidate", async () => {
    const { modelRoute, runtimeAuthPlan, runtimePlan } = createPreparedCodexCompactionPlans();

    const result = await compactEmbeddedAgentSessionDirect({
      ...wrappedCompactionArgs({ provider: " OpenAI ", model: "gpt-5.5" }),
      modelFallbacksOverride: ["anthropic/claude-fallback"],
      runtimeAuthPlan,
      runtimePlan,
    });

    expect(result).toMatchObject({ ok: true });
    expect(selectAgentHarnessForPreparedModelProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.5",
        agentHarnessRuntimeOverride: "codex",
        modelProviders: [
          expect.objectContaining({
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            preparedAuth: expect.objectContaining({ source: "direct" }),
          }),
        ],
      }),
    );
    expect(selectAgentHarnessMock).not.toHaveBeenCalled();
    expect(buildAgentRuntimePlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
        modelRoute,
      }),
    );
  });

  it("rebuilds runtime plans for an actual compaction fallback candidate", async () => {
    const { runtimeAuthPlan, runtimePlan } = createPreparedCodexCompactionPlans();
    sessionCompactImpl
      .mockRejectedValueOnce(
        Object.assign(new Error("primary compaction rate limited"), {
          status: 429,
          code: "rate_limit_exceeded",
        }),
      )
      .mockResolvedValueOnce({
        summary: "rebuilt fallback summary",
        firstKeptEntryId: "entry-fallback",
        tokensBefore: 120,
        details: { ok: true },
      });

    const result = await compactEmbeddedAgentSessionDirect({
      ...wrappedCompactionArgs({ provider: "openai", model: "gpt-5.5" }),
      modelFallbacksOverride: ["anthropic/claude-fallback"],
      runtimeAuthPlan,
      runtimePlan,
    });

    expect(result).toMatchObject({ ok: true, result: { summary: "rebuilt fallback summary" } });
    const fallbackPlanCall = findMockCall(buildAgentRuntimePlanMock, ([input]) => {
      const fields = input as { provider?: string; modelId?: string } | undefined;
      return fields?.provider === "anthropic" && fields.modelId === "claude-fallback";
    });
    expectRecordFields(fallbackPlanCall[0], {
      provider: "anthropic",
      modelId: "claude-fallback",
      harnessId: "openclaw",
      modelRoute: undefined,
    });
  });

  it("rematerializes the downstream model for a resolved backup profile", async () => {
    getApiKeyForModelMock
      .mockRejectedValueOnce(new Error("missing SecretRef"))
      .mockResolvedValueOnce({
        apiKey: "backup-key",
        mode: "api-key",
        source: "profile:openai:backup",
        profileId: "openai:backup",
      });

    await compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        runtimeAuthPlan: {
          providerForAuth: "openai",
          modelId: "gpt-5.5",
          authProfileProviderForAuth: "openai",
          forwardedAuthProfileId: "openai:missing",
          forwardedAuthProfileSource: "auto",
          forwardedAuthProfileCandidateIds: ["openai:missing", "openai:backup"],
          selectedAuthMode: "api-key",
        },
      }),
    );

    expect(
      getApiKeyForModelMock.mock.calls.map(
        ([params]) => (params as { profileId?: string }).profileId,
      ),
    ).toEqual(["openai:missing", "openai:backup"]);
    expect(
      resolveModelAsyncMock.mock.calls.some((call) => {
        const options = (call as unknown as readonly unknown[])[4] as
          | { authProfileId?: string }
          | undefined;
        return options?.authProfileId === "openai:backup";
      }),
    ).toBe(true);
    expect(
      resolveModelAsyncMock.mock.calls.some((call) => {
        const options = (call as unknown as readonly unknown[])[4] as
          | { authProfileId?: string }
          | undefined;
        return options?.authProfileId === "openai:missing";
      }),
    ).toBe(true);
    expect(resolveEmbeddedAgentStreamFnMock).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "openai:backup" }),
    );
    expect(buildAgentRuntimePlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionAuthProfileId: "openai:backup" }),
    );
  });

  it("falls through a failed subscription auth route to the prepared Platform route", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:subscription": {
          type: "token",
          provider: "openai",
          token: "subscription-token",
          expires: Date.now() + 60_000,
        },
        "openai:platform": {
          type: "api_key",
          provider: "openai",
          key: "platform-key",
        },
      },
      order: { openai: ["openai:subscription", "openai:platform"] },
    });
    getApiKeyForModelMock.mockImplementation(async (authParams = {}) => {
      if (authParams.profileId === "openai:subscription") {
        throw new Error("subscription credential resolution failed");
      }
      if (authParams.profileId === "openai:platform") {
        return {
          apiKey: "platform-key",
          mode: "api-key",
          source: "profile:openai:platform",
          profileId: "openai:platform",
        };
      }
      throw new Error(`unexpected profile: ${authParams.profileId ?? "none"}`);
    });

    const result = await compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        config: {
          auth: { order: { openai: ["openai:subscription", "openai:platform"] } },
          agents: {
            defaults: {
              models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(getApiKeyForModelMock.mock.calls.map(([authParams]) => authParams?.profileId)).toEqual([
      "openai:subscription",
      "openai:platform",
    ]);
    expectRecordFields(mockCallArg(createAgentSessionMock), {
      model: expect.objectContaining({
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
    });
    expect(buildAgentRuntimePlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionAuthProfileId: "openai:platform",
        modelRoute: expect.objectContaining({
          api: "openai-responses",
          authRequirement: "api-key",
        }),
      }),
    );
  });

  it("uses a prepared direct API-key fallback only after its profile tier fails", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:broken": {
          type: "api_key",
          provider: "openai",
          key: "broken-profile-key",
        },
      },
      order: { openai: ["openai:broken"] },
    });
    resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    shouldPreferExplicitConfigApiKeyAuthMock.mockReturnValue(false);
    getApiKeyForModelMock.mockImplementation(async (authParams = {}) => {
      if (authParams.profileId === "openai:broken") {
        throw new Error("profile key could not be resolved");
      }
      if (authParams.profileId === undefined && authParams.allowAuthProfileFallback === false) {
        return {
          apiKey: "literal-key",
          mode: "api-key",
          source: "models.json",
        };
      }
      throw new Error("unexpected auth lookup");
    });

    const result = await compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        config: {
          auth: { order: { openai: ["openai:broken"] } },
          models: {
            providers: {
              openai: { apiKey: "literal-key", baseUrl: "", models: [] },
            },
          },
          agents: {
            defaults: {
              models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(
      getApiKeyForModelMock.mock.calls.map(([authParams]) => ({
        profileId: authParams?.profileId,
        allowAuthProfileFallback: authParams?.allowAuthProfileFallback,
      })),
    ).toEqual([
      { profileId: "openai:broken", allowAuthProfileFallback: undefined },
      { profileId: undefined, allowAuthProfileFallback: false },
    ]);
    expect(buildAgentRuntimePlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileMode: "api-key",
        sessionAuthProfileId: undefined,
        modelRoute: expect.objectContaining({
          api: "openai-responses",
          authRequirement: "api-key",
        }),
      }),
    );
  });

  it("replans manual compaction once when the full attempt set changes harness", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:platform": {
          type: "api_key",
          provider: "openai",
          key: "platform-key",
        },
      },
      order: { openai: ["openai:platform"] },
    });
    selectAgentHarnessMock.mockReturnValueOnce({
      id: "codex",
      label: "Codex test harness",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(),
    } as never);
    selectAgentHarnessForPreparedModelProvidersMock.mockReturnValue({
      id: "openclaw",
      label: "OpenClaw test harness",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(),
    } as never);

    const result = await compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({ provider: "openai", model: "gpt-5.5" }),
    );

    expect(result.ok).toBe(true);
    expect(selectAgentHarnessForPreparedModelProvidersMock).toHaveBeenCalledTimes(2);
    expect(buildAgentRuntimePlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ harnessId: "openclaw", harnessRuntime: "openclaw" }),
    );
  });

  it("bootstraps runtime plugins with the resolved workspace", async () => {
    // This assertion only cares about bootstrap wiring, so stop before the
    // rest of the compaction pipeline can pull in unrelated runtime surfaces.
    resolveModelMock.mockReturnValue({
      model: undefined,
      error: "stop after bootstrap",
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    } as never);

    await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
    });

    expect(ensureRuntimePluginsLoaded).toHaveBeenCalledWith(
      expect.objectContaining({ config: {}, workspaceDir: "/tmp/workspace" }),
    );
  });

  it("forwards gateway subagent binding opt-in during compaction bootstrap", async () => {
    // Coding-tool forwarding is covered elsewhere; this compaction test only
    // owns the runtime bootstrap wiring.
    resolveModelMock.mockReturnValue({
      model: undefined,
      error: "stop after bootstrap",
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    } as never);

    await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });

    expect(ensureRuntimePluginsLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        workspaceDir: "/tmp/workspace",
        allowGatewaySubagentBinding: true,
      }),
    );
  });

  it("uses sandboxSessionKey only for compaction sandbox resolution", async () => {
    await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sandboxSessionKey: "agent:main:telegram:default:direct:12345",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
    });

    expect(resolveSandboxContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        sessionKey: "agent:main:telegram:default:direct:12345",
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("uses subagent prompt surface and guidance for compacted subagent prompt rebuilds", async () => {
    await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:main:subagent:worker",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
    });

    expect(listRegisteredPluginAgentPromptGuidanceMock).toHaveBeenCalledWith({
      surface: "subagent",
    });
    expect(buildEmbeddedSystemPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        promptMode: "minimal",
        promptSurface: "subagent",
        nativeCommandGuidanceLines: ["Subagent compact command guidance."],
      }),
    );
  });

  it("uses ACP prompt surface and guidance for compacted ACP prompt rebuilds", async () => {
    await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:codex:acp:worker",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
    });

    expect(listRegisteredPluginAgentPromptGuidanceMock).toHaveBeenCalledWith({
      surface: "acp_backend",
    });
    expect(buildEmbeddedSystemPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        promptMode: "full",
        promptSurface: "acp_backend",
        nativeCommandGuidanceLines: ["ACP compact command guidance."],
      }),
    );
  });

  it("passes resolved agent context to compacted system prompt rebuilds", async () => {
    resolveSessionAgentIdsMock.mockReturnValue({
      defaultAgentId: "main",
      sessionAgentId: "marketing-agent",
    });

    await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:marketing-agent:session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
    });

    expect(buildEmbeddedSystemPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeInfo: expect.objectContaining({
          agentId: "marketing-agent",
          sessionKey: "agent:marketing-agent:session-1",
        }),
      }),
    );
  });

  it("keeps the embedded compaction system prompt after active tool selection", async () => {
    buildEmbeddedSystemPromptMock.mockReturnValueOnce("compaction system prompt");

    await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
    });

    const createdSession = (await createAgentSessionMock.mock.results[0]?.value) as {
      session: {
        agent: { state: { systemPrompt?: string } };
        setActiveToolsByName: Mock;
        setBaseSystemPrompt: Mock;
      };
    };

    expect(createdSession.session.setBaseSystemPrompt).toHaveBeenCalledWith(
      "compaction system prompt",
    );
    expect(createdSession.session.setActiveToolsByName.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        createdSession.session.setBaseSystemPrompt.mock.invocationCallOrder[0],
        "createdSession.session.setBaseSystemPrompt.mock.invocationCallOrder[0] test invariant",
      ),
    );
  });

  it("routes compaction through shared stream resolution and extra params", async () => {
    const resolvedStreamFn = vi.fn();
    resolveEmbeddedAgentStreamFnMock.mockReturnValue(resolvedStreamFn);
    applyExtraParamsToAgentMock.mockReturnValue({
      effectiveExtraParams: { transport: "websocket" },
    });
    const session = {
      agent: {
        streamFn: vi.fn(),
      },
      messages: [{ role: "user", content: "hello" }],
    };

    await compactTesting.prepareCompactionSessionAgent({
      session: session as never,
      llmRuntime: { streamSimple: vi.fn() } as never,
      providerStreamFn: vi.fn(),
      sessionId: "session-1",
      signal: new AbortController().signal,
      effectiveModel: { provider: "openai", id: "fake", api: "responses", input: [] } as never,
      resolvedApiKey: undefined,
      authStorage: { setRuntimeApiKey: vi.fn() },
      config: undefined,
      provider: "openai",
      modelId: "gpt-5.4",
      thinkLevel: "off",
      sessionAgentId: "main",
      effectiveWorkspace: "/tmp/workspace",
      agentDir: "/tmp/workspace",
      runtimePlan: {
        auth: { forwardedAuthProfileId: "openai:profile-1" },
        transport: { resolveExtraParams: vi.fn(() => undefined) },
      } as never,
    });

    const streamArg = mockCallArg(resolveEmbeddedAgentStreamFnMock) as Record<string, unknown>;
    expect(streamArg.currentStreamFn).toBeTypeOf("function");
    expect(streamArg.sessionId).toBe("session-1");
    expect(streamArg.authProfileId).toBe("openai:profile-1");
    expect(applyExtraParamsToAgentMock).toHaveBeenCalledWith(
      expectRecordFields(mockCallArg(applyExtraParamsToAgentMock), { streamFn: resolvedStreamFn }),
      undefined,
      "openai",
      "gpt-5.4",
      undefined,
      "off",
      "main",
      "/tmp/workspace",
      expectRecordFields(mockCallArg(applyExtraParamsToAgentMock, 0, 8), {
        provider: "openai",
        id: "fake",
        api: "responses",
      }),
      "/tmp/workspace",
      undefined,
      expectRecordFields(mockCallArg(applyExtraParamsToAgentMock, 0, 11), {
        nativeWebSearchPolicyContext: {
          sessionKey: undefined,
          sandboxToolPolicy: undefined,
          messageProvider: undefined,
          agentAccountId: undefined,
          groupId: undefined,
          groupChannel: undefined,
          groupSpace: undefined,
          spawnedBy: undefined,
          senderId: undefined,
          senderName: undefined,
          senderUsername: undefined,
          senderE164: undefined,
        },
      }),
    );
  });

  it("maps logical Ultra to max before compaction provider hooks", async () => {
    const resolveExtraParams = vi.fn(() => undefined);
    await compactTesting.prepareCompactionSessionAgent({
      session: {
        agent: { streamFn: vi.fn() },
        messages: [{ role: "user", content: "hello" }],
      } as never,
      llmRuntime: { streamSimple: vi.fn() } as never,
      providerStreamFn: vi.fn(),
      sessionId: "session-1",
      signal: new AbortController().signal,
      effectiveModel: { provider: "openai", id: "fake", api: "responses", input: [] } as never,
      resolvedApiKey: undefined,
      authStorage: { setRuntimeApiKey: vi.fn() },
      config: undefined,
      provider: "openai",
      modelId: "gpt-5.6-sol",
      thinkLevel: "ultra",
      sessionAgentId: "main",
      effectiveWorkspace: "/tmp/workspace",
      agentDir: "/tmp/workspace",
      runtimePlan: {
        auth: {},
        transport: { resolveExtraParams },
      } as never,
    });

    expect(resolveExtraParams).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingLevel: "max" }),
    );
    expect(applyExtraParamsToAgentMock).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      "openai",
      "gpt-5.6-sol",
      undefined,
      "max",
      "main",
      "/tmp/workspace",
      expect.anything(),
      "/tmp/workspace",
      undefined,
      expect.anything(),
    );
  });

  it("preserves full sender identity when building compaction tools", async () => {
    await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      senderId: "sender-1",
      senderName: "Alice",
      senderUsername: "alice_u",
      senderE164: "+15551234567",
    });

    expectRecordFields(mockCallArg(createOpenClawCodingToolsMock), {
      senderId: "sender-1",
      senderName: "Alice",
      senderUsername: "alice_u",
      senderE164: "+15551234567",
    });
  });

  it.each([
    { input: ["text"], modelHasVision: false },
    { input: ["text", "image"], modelHasVision: true },
  ])(
    "propagates modelHasVision=$modelHasVision when rebuilding compaction tools",
    async ({ input, modelHasVision }) => {
      mockResolvedModel({ input });

      await compactEmbeddedAgentSessionDirect({
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
      });

      expectRecordFields(mockCallArg(createOpenClawCodingToolsMock), { modelHasVision });
    },
  );

  it("uses cwd for compaction runtime tools while preserving workspace bootstrap root", async () => {
    await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      cwd: "/tmp/task-repo",
    });

    expectRecordFields(mockCallArg(createOpenClawCodingToolsMock), {
      cwd: "/tmp/task-repo",
      workspaceDir: "/tmp/workspace",
      spawnWorkspaceDir: "/tmp/workspace",
    });
    expectRecordFields(mockCallArg(createPreparedEmbeddedAgentSettingsManagerMock), {
      cwd: "/tmp/task-repo",
      agentDir: "/tmp/agents/main/agent",
    });
  });

  it("uses the caller context token budget during runtime compaction", async () => {
    await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      contextTokenBudget: 64_000,
    });

    expectRecordFields(mockCallArg(createOpenClawCodingToolsMock), {
      modelContextWindowTokens: 64_000,
    });
    expectRecordFields(mockCallArg(guardSessionManagerMock, 0, 1), {
      contextWindowTokens: 64_000,
    });
    expectRecordFields(mockCallArg(createPreparedEmbeddedAgentSettingsManagerMock), {
      contextTokenBudget: 64_000,
    });
    expectRecordFields(mockCallArg(applyAgentCompactionSettingsFromConfigMock), {
      contextTokenBudget: 64_000,
    });
  });

  it("skips runtime tool construction when the compaction model does not support tools", async () => {
    mockResolvedModel({ supportsTools: false });

    await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
    });

    expect(createOpenClawCodingToolsMock).not.toHaveBeenCalled();
  });

  it("quarantines unsupported tool schemas before creating the compaction model session", async () => {
    resolveContextEngineMock.mockResolvedValueOnce({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
    });
    resolveModelMock.mockReturnValueOnce({
      model: { provider: "openai", api: "openai-responses", id: "fake", input: [] },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    });
    createOpenClawCodingToolsMock.mockReturnValueOnce([
      {
        name: "healthy_lookup",
        label: "Healthy Lookup",
        description: "Look up safe data.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ text: "ok" }),
      },
      {
        name: "fuzzplugin_move_angles",
        label: "Fuzzplugin Move Angles",
        description: "Move robot joints.",
        parameters: { type: "array", items: { type: "number" } },
        execute: async () => ({ text: "bad" }),
      },
    ] as never);

    await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      runId: "run-tool-schema-quarantine",
    });

    const sessionOptions = expectRecordFields(mockCallArg(createAgentSessionMock), {});
    expect(
      (sessionOptions.customTools as Array<{ name: string }>).map((tool) => tool.name),
    ).toEqual(["healthy_lookup"]);
    expect(sessionOptions.tools).toEqual(["healthy_lookup"]);
  });

  it("clamps the caller context token budget to the compaction model", async () => {
    resolveContextWindowInfoMock.mockReturnValueOnce({ tokens: 32_000 });

    await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      contextTokenBudget: 64_000,
    });

    expectRecordFields(mockCallArg(createOpenClawCodingToolsMock), {
      modelContextWindowTokens: 32_000,
    });
  });

  it("uses the session model fallback chain when overflow compaction fails", async () => {
    sessionCompactImpl
      .mockRejectedValueOnce(
        Object.assign(new Error("primary compaction rate limited"), {
          status: 429,
          code: "rate_limit_exceeded",
        }),
      )
      .mockResolvedValueOnce({
        summary: "overflow fallback summary",
        firstKeptEntryId: "entry-fallback",
        tokensBefore: 120,
        details: { ok: true },
      });

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-primary",
      trigger: "overflow",
      modelFallbacksOverride: ["anthropic/claude-fallback"],
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-primary",
              fallbacks: [],
            },
          },
        },
      } as never,
    });

    expect(result.ok).toBe(true);
    expect(result.result?.summary).toBe("overflow fallback summary");
    const primaryCall = findMockCall(
      resolveModelMock,
      ([provider, modelId]) => provider === "openai" && modelId === "gpt-primary",
    );
    expect(primaryCall[2]).toBeTypeOf("string");
    if (primaryCall[3] === undefined) {
      throw new Error("Expected primary resolve-model options");
    }
    const fallbackCall = findMockCall(
      resolveModelMock,
      ([provider, modelId]) => provider === "anthropic" && modelId === "claude-fallback",
    );
    expect(fallbackCall[2]).toBeTypeOf("string");
    if (fallbackCall[3] === undefined) {
      throw new Error("Expected fallback resolve-model options");
    }
  });

  it("keeps model-locked OpenClaw compaction on its exact model without fallbacks", async () => {
    sessionCompactImpl.mockRejectedValueOnce(
      Object.assign(new Error("primary compaction rate limited"), { status: 429 }),
    );

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-primary",
      agentHarnessId: "openclaw",
      modelSelectionLocked: true,
      modelFallbacksOverride: ["anthropic/claude-fallback"],
      config: {
        agents: {
          defaults: {
            compaction: { model: "azure/compact-primary" },
            model: {
              primary: "openai/gpt-primary",
              fallbacks: ["anthropic/claude-fallback"],
            },
          },
        },
      } as never,
    });

    expect(result.ok).toBe(false);
    expect(resolveModelMock).toHaveBeenCalledTimes(1);
    expect(mockCallArg(resolveModelMock)).toBe("openai");
    expect(mockCallArg(resolveModelMock, 0, 1)).toBe("gpt-primary");
  });

  it("revalidates immutable Ultra for each compaction fallback candidate", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "openclaw" });
    sessionCompactImpl
      .mockRejectedValueOnce(
        Object.assign(new Error("primary compaction rate limited"), {
          status: 429,
          code: "rate_limit_exceeded",
        }),
      )
      .mockResolvedValueOnce({
        summary: "fallback summary",
        firstKeptEntryId: "entry-fallback",
        tokensBefore: 120,
        details: { ok: true },
      });
    const params = {
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-5.6-sol",
      thinkLevel: "ultra" as const,
      trigger: "overflow" as const,
      modelFallbacksOverride: ["demo/basic"],
      config: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
    };

    const result = await compactEmbeddedAgentSessionDirect(params);

    expect(result.ok).toBe(true);
    expect(
      createAgentSessionMock.mock.calls.map(
        (call) => (call[0] as { thinkingLevel?: string }).thinkingLevel,
      ),
    ).toEqual(["ultra", "high"]);
    expect(params.thinkLevel).toBe("ultra");
  });

  it("preserves Codex OAuth across same-provider OpenAI compaction fallbacks", async () => {
    mockResolvedModel();
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "test-access",
          refresh: "test-refresh",
          expires: Date.now() + 60_000,
        },
      },
      order: { openai: ["openai:default"] },
    });
    getApiKeyForModelMock.mockImplementation(async (params?: { profileId?: string }) => ({
      apiKey: "test-oauth",
      mode: "oauth",
      source: `profile:${params?.profileId ?? "openai:default"}`,
      profileId: params?.profileId ?? "openai:default",
    }));
    sessionCompactImpl
      .mockRejectedValueOnce(
        Object.assign(new Error("primary compaction rate limited"), {
          status: 429,
          code: "rate_limit_exceeded",
        }),
      )
      .mockResolvedValueOnce({
        summary: "oauth fallback summary",
        firstKeptEntryId: "entry-fallback",
        tokensBefore: 120,
        details: { ok: true },
      });

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "openai:default",
      trigger: "overflow",
      modelFallbacksOverride: ["openai/gpt-5.4-mini"],
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5",
              fallbacks: [],
            },
          },
        },
      } as never,
    });

    expect(result.ok).toBe(true);
    expect(result.result?.summary).toBe("oauth fallback summary");
    findMockCall(
      resolveModelMock,
      ([provider, modelId]) => provider === "openai" && modelId === "gpt-5.5",
    );
    findMockCall(
      resolveModelMock,
      ([provider, modelId]) => provider === "openai" && modelId === "gpt-5.4-mini",
    );
    expectRecordFields(mockCallArg(resolveEmbeddedAgentStreamFnMock, 1), {
      authProfileId: "openai:default",
    });
  });

  it("routes unbound ChatGPT OAuth direct compaction through auth-aware codex selection", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "implicit",
    } as never);
    // Only ChatGPT OAuth is available — no API-key profile. Auth-aware
    // selection must pick codex (harness-owned) instead of forced openclaw.
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "test-auth-token",
          refresh: "test-auth-token",
          expires: Date.now() + 10 * 60_000,
        },
      },
      order: { openai: ["openai:chatgpt"] },
    });
    getApiKeyForModelMock.mockImplementation(async (params?: { profileId?: string }) => ({
      apiKey: "test-auth-token",
      mode: "oauth",
      source: `profile:${params?.profileId ?? "openai:chatgpt"}`,
      profileId: params?.profileId ?? "openai:chatgpt",
    }));

    const result = await compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        // Do not pin provider-level api to openai-responses: that collapses
        // route resolution to api-key-only and hides ChatGPT OAuth.
        config: {
          models: {
            providers: {
              openai: { models: [{ id: "gpt-5.5", contextWindow: 350_000 }] },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
    expect(selectAgentHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: undefined,
        agentHarnessRuntimeOverride: undefined,
      }),
    );
    expect(selectAgentHarnessMock.mock.results[0]?.value).toEqual(
      expect.objectContaining({ id: "codex", authBootstrap: "harness" }),
    );
    expect(selectAgentHarnessForPreparedModelProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessRuntimeOverride: undefined,
        modelProviders: expect.arrayContaining([
          expect.objectContaining({
            preparedAuth: expect.objectContaining({
              source: "profile",
              mode: "oauth",
              requirement: "subscription",
            }),
          }),
        ]),
      }),
    );
  });

  it("keeps custom OpenAI-compatible compaction on OpenAI logical context", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "codex" });

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-5.5",
      agentHarnessId: "codex",
      config: {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://example.test/v1",
              models: [{ id: "gpt-5.5", contextWindow: 350_000 }],
            },
          },
        },
      } as never,
    });

    expect(result.ok).toBe(true);
    expect(mockCallArg(resolveModelMock)).toBe("openai");
    expect(mockCallArg(resolveModelMock, 0, 1)).toBe("gpt-5.5");
    const sessionOptions = expectRecordFields(mockCallArg(createAgentSessionMock), {});
    expectRecordFields(sessionOptions.model, {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
    });
    expect(buildAgentRuntimePlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-responses",
        model: expect.objectContaining({
          api: "openai-responses",
          baseUrl: "https://example.test/v1",
        }),
        modelRoute: expect.objectContaining({
          api: "openai-responses",
          baseUrl: "https://example.test/v1",
          authRequirement: "api-key",
        }),
      }),
    );
    expectRecordFields(mockCallArg(resolveContextWindowInfoMock), {
      provider: "openai",
      modelId: "gpt-5.5",
    });
  });

  it("uses explicit Codex runtime policy for direct OpenAI compaction", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "model",
    } as never);

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      config: {
        models: {
          providers: {
            openai: { models: [{ id: "fake-model", contextWindow: 350_000 }] },
          },
        },
      } as never,
    });

    expect(result.ok).toBe(true);
    expect(resolveAgentHarnessPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", modelId: "fake-model" }),
    );
    expect(selectAgentHarnessForPreparedModelProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProviders: expect.arrayContaining([
          expect.objectContaining({
            preparedAuth: expect.objectContaining({ source: "profile" }),
            runtimePolicy: expect.objectContaining({ compatibleIds: ["openclaw", "codex"] }),
          }),
        ]),
      }),
    );
    expect(mockCallArg(resolveModelMock)).toBe("openai");
    expectRecordFields(mockCallArg(resolveContextWindowInfoMock), {
      provider: "openai",
      modelId: "fake-model",
    });
  });

  it("preserves direct OpenAI API-key compaction when OpenClaw runtime is active", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "openclaw" });

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-5.5",
      runtimeAuthPlan: {
        providerForAuth: "openai",
        modelId: "gpt-5.5",
        authProfileProviderForAuth: "openai",
        selectedAuthMode: "api-key",
      },
      config: {
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5", contextWindow: 1_000_000 }] },
          },
        },
      } as never,
    });

    expect(result.ok).toBe(true);
    expect(mockCallArg(resolveModelMock)).toBe("openai");
    expect(mockCallArg(resolveModelMock, 0, 1)).toBe("gpt-5.5");
    expect(mockCallArg(resolveModelAsyncMock, 0, 4)).toMatchObject({
      authProfileMode: "api_key",
    });
  });

  it("uses the compaction model override with a pinned Codex harness", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "codex" });

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-5.5",
      agentHarnessId: "codex",
      config: {
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.5" }, { id: "gpt-5.4-mini", contextWindow: 350_000 }],
            },
          },
        },
        agents: {
          defaults: { compaction: { model: "openai/gpt-5.4-mini" } },
        },
      } as never,
    });

    expect(result.ok).toBe(true);
    expect(mockCallArg(resolveModelMock)).toBe("openai");
    expect(mockCallArg(resolveModelMock, 0, 1)).toBe("gpt-5.4-mini");
    expectRecordFields(mockCallArg(resolveContextWindowInfoMock), {
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });
  });

  it("does not reuse a source-provider profile for cross-provider compaction", async () => {
    const result = await compactEmbeddedAgentSessionDirect({
      ...wrappedCompactionArgs(),
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "openai:work",
      runtimeAuthPlan: {
        providerForAuth: "openai",
        modelId: "gpt-5.5",
        authProfileProviderForAuth: "openai",
        forwardedAuthProfileId: "openai:work",
      },
      config: {
        agents: {
          defaults: {
            compaction: { model: "github-copilot/gpt-5.6-sol" },
          },
        },
      } as never,
    });

    expect(result.ok).toBe(true);
    const initialResolveCall = resolveModelAsyncMock.mock.calls[0] as
      | [string, string, string, unknown, { authProfileId?: string }?]
      | undefined;
    expect(initialResolveCall?.[0]).toBe("github-copilot");
    expect(initialResolveCall?.[4]?.authProfileId).toBeUndefined();
  });

  it("materializes subscription-auth OpenAI compaction while preserving logical context", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "openclaw" });
    mockResolvedModel({ contextWindow: 1_000_000 });
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:work": {
          type: "oauth",
          provider: "openai",
          access: "test-access",
          refresh: "test-refresh",
          expires: Date.now() + 60_000,
        },
      },
    });
    getApiKeyForModelMock.mockImplementation(async (params?: { profileId?: string }) => ({
      apiKey: "test-oauth",
      mode: "oauth",
      source: `profile:${params?.profileId ?? "openai:work"}`,
      profileId: params?.profileId ?? "openai:work",
    }));

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      config: {
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5", contextWindow: 350_000 }] },
          },
        },
      } as never,
    });

    expect(result.ok).toBe(true);
    expect(mockCallArg(resolveModelMock)).toBe("openai");
    const sessionOptions = expectRecordFields(mockCallArg(createAgentSessionMock), {});
    expectRecordFields(sessionOptions.model, {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    expect(buildAgentRuntimePlanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.5",
        modelApi: "openai-chatgpt-responses",
        sessionAuthProfileId: "openai:work",
        sessionAuthProfileSource: "user",
        modelRoute: expect.objectContaining({
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
        }),
      }),
    );
    expectRecordFields(mockCallArg(resolveContextWindowInfoMock), {
      provider: "openai",
      modelId: "gpt-5.5",
    });
  });

  it("keeps compaction fallback selection ephemeral", async () => {
    sessionCompactImpl
      .mockRejectedValueOnce(Object.assign(new Error("400 invalid request body"), { status: 400 }))
      .mockResolvedValueOnce({
        summary: "fallback summary",
        firstKeptEntryId: "entry-fallback",
        tokensBefore: 120,
        details: { ok: true },
      });
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-primary",
            fallbacks: ["anthropic/claude-fallback"],
          },
        },
      },
      sessions: {
        entries: {
          [TEST_SESSION_KEY]: {
            modelProvider: "openai",
            model: "gpt-primary",
          },
        },
      },
    };
    const configBefore = structuredClone(config);

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-primary",
      config: config as never,
    });

    expect(result.ok).toBe(true);
    expect(result.result?.summary).toBe("fallback summary");
    const primaryCall = findMockCall(
      resolveModelMock,
      ([provider, modelId]) => provider === "openai" && modelId === "gpt-primary",
    );
    expect(primaryCall[2]).toBeTypeOf("string");
    if (primaryCall[3] === undefined) {
      throw new Error("Expected primary resolve-model options");
    }
    const fallbackCall = findMockCall(
      resolveModelMock,
      ([provider, modelId]) => provider === "anthropic" && modelId === "claude-fallback",
    );
    expect(fallbackCall[2]).toBeTypeOf("string");
    if (fallbackCall[3] === undefined) {
      throw new Error("Expected fallback resolve-model options");
    }
    expect(config).toEqual(configBefore);
  });

  it("preserves explicit compaction.model behavior without session fallback", async () => {
    sessionCompactImpl.mockRejectedValueOnce(
      Object.assign(new Error("400 invalid request body"), { status: 400 }),
    );

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-primary",
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-primary",
              fallbacks: ["anthropic/claude-fallback"],
            },
            compaction: {
              model: "azure/compact-primary",
            },
          },
        },
      } as never,
    });

    expect(result.ok).toBe(false);
    expect(resolveModelMock).toHaveBeenCalledTimes(1);
    expect(mockCallArg(resolveModelMock)).toBe("azure");
    expect(mockCallArg(resolveModelMock, 0, 1)).toBe("compact-primary");
    expect(mockCallArg(resolveModelMock, 0, 2)).toBeTypeOf("string");
    if (mockCallArg(resolveModelMock, 0, 3) === undefined) {
      throw new Error("Expected resolve-model options");
    }
  });

  it("preserves compaction failure status and code metadata", async () => {
    sessionCompactImpl.mockRejectedValueOnce(
      Object.assign(new Error("primary compaction rate limited"), {
        status: 429,
        code: "rate_limit_exceeded",
      }),
    );

    const result = await compactEmbeddedAgentSessionDirect({
      sessionId: "session-1",
      sessionKey: TEST_SESSION_KEY,
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      provider: "openai",
      model: "gpt-primary",
      config: {
        agents: {
          defaults: {
            compaction: {
              model: "openai/gpt-primary",
            },
          },
        },
      } as never,
    });

    expectRecordFields(result, {
      ok: false,
      compacted: false,
    });
    expect(result.failure).toEqual({
      reason: "rate_limit",
      status: 429,
      code: "rate_limit_exceeded",
      rawError: "primary compaction rate limited",
    });
  });

  it("emits internal + plugin compaction hooks with counts", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    await runCompactionHooks({
      sessionKey: TEST_SESSION_KEY,
      messageProvider: "telegram",
    });

    expectRecordFields(sessionHook("compact:before"), {
      type: "session",
      action: "compact:before",
    });
    const beforeContext = sessionHook("compact:before")?.context;
    const afterContext = sessionHook("compact:after")?.context;

    expectRecordFields(beforeContext, {
      messageCount: 2,
      tokenCount: 20,
      messageCountOriginal: 2,
      tokenCountOriginal: 20,
    });
    expectRecordFields(afterContext, {
      messageCount: 1,
      compactedCount: 1,
    });
    expect(afterContext?.compactedCount).toBe(
      (beforeContext?.messageCountOriginal as number) - (afterContext?.messageCount as number),
    );

    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      expectRecordFields(mockCallArg(hookRunner.runBeforeCompaction), {
        messageCount: 2,
        tokenCount: 20,
      }),
      expectRecordFields(mockCallArg(hookRunner.runBeforeCompaction, 0, 1), {
        sessionKey: "agent:main:session-1",
        messageProvider: "telegram",
      }),
    );
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      {
        messageCount: 1,
        tokenCount: 10,
        compactedCount: 1,
        sessionFile: "/tmp/session.jsonl",
      },
      expectRecordFields(mockCallArg(hookRunner.runAfterCompaction, 0, 1), {
        sessionKey: "agent:main:session-1",
        messageProvider: "telegram",
      }),
    );
  });

  it("uses sessionId as hook session key fallback when sessionKey is missing", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    await runCompactionHooks({});

    expect(sessionHook("compact:before")?.sessionKey).toBe("session-1");
    expect(sessionHook("compact:after")?.sessionKey).toBe("session-1");
    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      mockCallArg(hookRunner.runBeforeCompaction),
      expectRecordFields(mockCallArg(hookRunner.runBeforeCompaction, 0, 1), {
        sessionKey: "session-1",
      }),
    );
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
      mockCallArg(hookRunner.runAfterCompaction),
      expectRecordFields(mockCallArg(hookRunner.runAfterCompaction, 0, 1), {
        sessionKey: "session-1",
      }),
    );
  });

  it("applies validated transcript before hooks even when it becomes empty", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    const beforeMetrics = compactTesting.buildBeforeCompactionHookMetrics({
      originalMessages: [],
      currentMessages: [],
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
    });
    await compactTesting.runBeforeCompactionHooks({
      hookRunner,
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      workspaceDir: "/tmp",
      metrics: beforeMetrics,
    });

    const beforeContext = sessionHook("compact:before")?.context;
    expectRecordFields(beforeContext, {
      messageCountOriginal: 0,
      tokenCountOriginal: 0,
      messageCount: 0,
      tokenCount: 0,
    });
  });

  it("forwards internal compaction hook messages to the caller", async () => {
    const onHookMessages = vi.fn();
    triggerInternalHook.mockImplementation((event: unknown) => {
      const hookEvent = event as { action?: string; messages?: string[] };
      hookEvent.messages?.push(`${hookEvent.action} notice`);
    });
    const beforeMetrics = compactTesting.buildBeforeCompactionHookMetrics({
      originalMessages: sessionMessages.slice(1) as AgentMessage[],
      currentMessages: sessionMessages.slice(1) as AgentMessage[],
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
    });

    const hookState = await compactTesting.runBeforeCompactionHooks({
      hookRunner,
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      workspaceDir: "/tmp",
      metrics: beforeMetrics,
      onHookMessages,
    });
    await compactTesting.runAfterCompactionHooks({
      hookRunner,
      sessionId: "session-1",
      sessionAgentId: "main",
      hookSessionKey: hookState.hookSessionKey,
      missingSessionKey: hookState.missingSessionKey,
      workspaceDir: "/tmp",
      messageCountAfter: 1,
      tokensAfter: 10,
      compactedCount: 1,
      sessionFile: "/tmp/session.jsonl",
      onHookMessages,
    });

    expect(onHookMessages).toHaveBeenNthCalledWith(1, {
      phase: "before",
      messages: ["compact:before notice"],
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
    expect(onHookMessages).toHaveBeenNthCalledWith(2, {
      phase: "after",
      messages: ["compact:after notice"],
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    });
  });
  it("emits a transcript update after successful compaction", async () => {
    const listener = vi.fn();
    const cleanup = onInternalSessionTranscriptUpdate(listener);

    try {
      await compactTesting.runPostCompactionSideEffects({
        sessionKey: "agent:main:session-1",
        sessionFile: "  /tmp/session.jsonl  ",
      });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        sessionFile: "/tmp/session.jsonl",
        sessionKey: "agent:main:session-1",
      });
    } finally {
      cleanup();
    }
  });

  it("emits post-compaction side effects once for a rotated successor transcript", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    rotateTranscriptAfterCompactionMock.mockResolvedValueOnce({
      rotated: true,
      sessionId: "rotated-session",
      sessionFile: "/tmp/rotated-session.jsonl",
      leafId: "rotated-leaf",
    });

    try {
      const result = await compactEmbeddedAgentSessionDirect({
        sessionId: "session-1",
        sessionKey: TEST_SESSION_KEY,
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
        config: {
          agents: {
            defaults: {
              compaction: {
                truncateAfterCompaction: true,
                postIndexSync: "await",
              },
            },
          },
        } as never,
      });

      expect(result.ok).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        agentId: "main",
        sessionKey: TEST_SESSION_KEY,
        sessionId: "rotated-session",
        target: {
          agentId: "main",
          sessionId: "rotated-session",
          sessionKey: TEST_SESSION_KEY,
        },
      });
      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledWith({
        reason: "post-compaction",
        sessions: [
          {
            agentId: "main",
            sessionId: "rotated-session",
            sessionKey: TEST_SESSION_KEY,
          },
        ],
      });
      expectRecordFields(mockCallArg(hookRunner.runAfterCompaction), {
        previousSessionId: "session-1",
        sessionFile: "/tmp/rotated-session.jsonl",
      });
      expectRecordFields(mockCallArg(hookRunner.runAfterCompaction, 0, 1), {
        sessionId: "rotated-session",
      });
    } finally {
      cleanup();
    }
  });

  it("preserves tokensAfter when full-session context exceeds result.tokensBefore", () => {
    estimateTokensMock.mockImplementation((message: unknown) => {
      const role = (message as { role?: string }).role;
      if (role === "user") {
        return 30;
      }
      if (role === "assistant") {
        return 20;
      }
      return 5;
    });
    const tokensAfter = compactTesting.estimateTokensAfterCompaction({
      messagesAfter: [{ role: "user", content: "kept ask" }] as AgentMessage[],
      fullSessionTokensBefore: 55,
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
    });

    expect(tokensAfter).toBe(30);
  });

  it("treats pre-compaction token estimation failures as a no-op sanity check", () => {
    estimateTokensMock.mockImplementation((message: unknown) => {
      const role = (message as { role?: string }).role;
      if (role === "assistant") {
        throw new Error("legacy message");
      }
      if (role === "user") {
        return 30;
      }
      return 5;
    });
    const beforeMetrics = compactTesting.buildBeforeCompactionHookMetrics({
      originalMessages: sessionMessages as AgentMessage[],
      currentMessages: sessionMessages as AgentMessage[],
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
    });
    const tokensAfter = compactTesting.estimateTokensAfterCompaction({
      messagesAfter: [{ role: "user", content: "kept ask" }] as AgentMessage[],
      fullSessionTokensBefore: 0,
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
    });

    expect(beforeMetrics.tokenCountOriginal).toBeUndefined();
    expect(beforeMetrics.tokenCountBefore).toBeUndefined();
    expect(tokensAfter).toBe(30);
  });

  it("skips sync in await mode when postCompactionForce is false", async () => {
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    resolveMemorySearchConfigMock.mockReturnValue({
      sources: ["sessions"],
      sync: {
        sessions: {
          postCompactionForce: false,
        },
      },
    });

    await compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("await"),
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });

    const resolveAgentArg = mockCallArg(resolveSessionAgentIdMock) as Record<string, unknown>;
    expectRecordFields(resolveAgentArg, { sessionKey: TEST_SESSION_KEY });
    expect(resolveAgentArg.config).toBeTypeOf("object");
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("awaits post-compaction memory sync in await mode when postCompactionForce is true", async () => {
    const syncStarted = createDeferred<PostCompactionSyncParams>();
    const syncRelease = createDeferred<void>();
    const sync = vi.fn<PostCompactionSync>(async (params) => {
      syncStarted.resolve(params as PostCompactionSyncParams);
      await syncRelease.promise;
    });
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    let settled = false;

    const resultPromise = compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("await"),
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });

    void resultPromise.then(() => {
      settled = true;
    });
    await expect(syncStarted.promise).resolves.toEqual({
      archiveFiles: [TEST_SESSION_FILE],
      reason: "post-compaction",
    });
    expect(settled).toBe(false);
    syncRelease.resolve(undefined);
    await resultPromise;
    expect(settled).toBe(true);
  });

  it("skips post-compaction memory sync when the mode is off", async () => {
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });

    await compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("off"),
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });

    expect(resolveSessionAgentIdMock).not.toHaveBeenCalled();
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("fires post-compaction memory sync without awaiting it in async mode", async () => {
    const sync = vi.fn<PostCompactionSync>(async () => {});
    const managerRequested = createDeferred<void>();
    const managerGate = createDeferred<{ manager: { sync: PostCompactionSync } }>();
    const syncStarted = createDeferred<PostCompactionSyncParams>();
    sync.mockImplementation(async (params) => {
      syncStarted.resolve(params as PostCompactionSyncParams);
    });
    getMemorySearchManagerMock.mockImplementation(async () => {
      managerRequested.resolve(undefined);
      return await managerGate.promise;
    });
    let settled = false;

    const resultPromise = compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("async"),
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });

    await managerRequested.promise;
    void resultPromise.then(() => {
      settled = true;
    });
    await resultPromise;
    expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    managerGate.resolve({ manager: { sync } });
    await expect(syncStarted.promise).resolves.toEqual({
      archiveFiles: [TEST_SESSION_FILE],
      reason: "post-compaction",
    });
  });

  it("compacts an overflow transcript anchored by a compaction summary", async () => {
    sessionMessages.splice(
      0,
      sessionMessages.length,
      {
        role: "compactionSummary",
        summary: "The user asked for a long-running repository audit.",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        content: [{ type: "text", text: "audit output" }],
        isError: false,
        timestamp: 3,
      },
    );

    const result = await compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({ trigger: "overflow" }),
    );

    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(sessionCompactImpl).toHaveBeenCalledOnce();
  });

  it("skips compaction when the transcript only contains boilerplate replies and tool output", () => {
    const messages = [
      { role: "user", content: "<b>HEARTBEAT_OK</b>", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "exec",
        content: [{ type: "text", text: "checked" }],
        isError: false,
        timestamp: 2,
      },
    ] as AgentMessage[];

    expect(compactTesting.containsRealConversationMessages(messages)).toBe(false);
  });

  it("skips compaction when the transcript only contains heartbeat boilerplate and reasoning blocks", () => {
    const messages = [
      { role: "user", content: "<b>HEARTBEAT_OK</b>", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "checking" }],
        timestamp: 2,
      },
    ] as AgentMessage[];

    expect(compactTesting.containsRealConversationMessages(messages)).toBe(false);
  });

  it("does not treat assistant-only tool-call blocks as meaningful conversation", () => {
    expect(
      compactTesting.hasMeaningfulConversationContent({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "exec", arguments: {} }],
      } as AgentMessage),
    ).toBe(false);
  });

  it("counts tool output as real only when a meaningful user ask exists in the lookback window", () => {
    const heartbeatToolResultWindow = [
      { role: "user", content: "<b>HEARTBEAT_OK</b>" },
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "exec",
        content: [{ type: "text", text: "checked" }],
      },
    ] as AgentMessage[];
    expect(
      compactTesting.hasRealConversationContent(
        expectDefined(heartbeatToolResultWindow[1], "heartbeatToolResultWindow[1] test invariant"),
        heartbeatToolResultWindow,
        1,
      ),
    ).toBe(false);

    const realAskToolResultWindow = [
      { role: "assistant", content: "NO_REPLY" },
      { role: "user", content: "please inspect the failing PR" },
      {
        role: "toolResult",
        toolCallId: "t2",
        toolName: "exec",
        content: [{ type: "text", text: "checked" }],
      },
    ] as AgentMessage[];
    expect(
      compactTesting.hasRealConversationContent(
        expectDefined(realAskToolResultWindow[2], "realAskToolResultWindow[2] test invariant"),
        realAskToolResultWindow,
        2,
      ),
    ).toBe(true);
  });

  it("counts visible custom prompts as real conversation anchors for tool output", () => {
    const messages = [
      {
        role: "custom",
        customType: "cron-request",
        content: "prepare the daily report",
        display: true,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "report source data" }],
      },
    ] as AgentMessage[];

    expect(
      compactTesting.hasRealConversationContent(
        expectDefined(messages[0], "messages[0] test invariant"),
        messages,
        0,
      ),
    ).toBe(true);
    expect(
      compactTesting.hasRealConversationContent(
        expectDefined(messages[2], "messages[2] test invariant"),
        messages,
        2,
      ),
    ).toBe(true);
  });

  it("registers the Ollama api provider before compaction", () => {
    const streamFn = vi.fn();
    registerProviderStreamForModelMock.mockReturnValue(streamFn);

    const result = compactTesting.resolveCompactionProviderStream({
      effectiveModel: {
        provider: "ollama",
        api: "ollama",
        id: "qwen3:8b",
        input: ["text"],
        baseUrl: "http://127.0.0.1:11434",
        headers: { Authorization: "Bearer ollama-cloud" },
      } as never,
      config: undefined,
      agentDir: "/tmp",
      effectiveWorkspace: "/tmp",
      apiRegistry: {} as never,
    });

    expect(result).toBe(streamFn);
    const streamRegistration = mockCallArg(registerProviderStreamForModelMock) as Record<
      string,
      unknown
    >;
    expectRecordFields(streamRegistration, {
      agentDir: "/tmp",
      workspaceDir: "/tmp",
    });
    expectRecordFields(streamRegistration.model, {
      provider: "ollama",
      api: "ollama",
      id: "qwen3:8b",
    });
  });

  it("aborts in-flight compaction when the caller abort signal fires", async () => {
    const { compactWithSafetyTimeout } = await vi.importActual<
      typeof import("./compaction-safety-timeout.js")
    >("./compaction-safety-timeout.js");
    const controller = new AbortController();
    const compactStarted = createDeferred<void>();

    const resultPromise = compactWithSafetyTimeout(
      async () => {
        compactStarted.resolve(undefined);
        return await new Promise<never>(() => {});
      },
      30_000,
      {
        abortSignal: controller.signal,
        onCancel: () => {
          sessionAbortCompactionMock();
        },
      },
    );

    await compactStarted.promise;
    controller.abort(new Error("request timed out"));

    await expect(resultPromise).rejects.toThrow("request timed out");
    expect(sessionAbortCompactionMock).toHaveBeenCalledTimes(1);
  });
});

describe("compactEmbeddedAgentSession hooks (ownsCompaction engine)", () => {
  function mockQueuedRouteAwareModel(
    defaultApi: "openai-responses" | "openai-chatgpt-responses" = "openai-responses",
  ) {
    resolveModelMock.mockImplementation(
      (provider = "openai", modelId = "gpt-5.5", _agentDir?: string, cfg?: unknown) => {
        const providerConfig = (
          cfg as
            | {
                models?: {
                  providers?: Record<string, { api?: string; baseUrl?: string }>;
                };
              }
            | undefined
        )?.models?.providers?.[provider];
        const api = providerConfig?.api ?? defaultApi;
        const subscription = api === "openai-chatgpt-responses";
        return {
          model: {
            provider,
            id: modelId,
            api,
            baseUrl:
              providerConfig?.baseUrl ??
              (subscription
                ? "https://chatgpt.com/backend-api/codex"
                : "https://api.openai.com/v1"),
            contextWindow: subscription ? 272_000 : 1_050_000,
            input: [],
          },
          error: null,
          authStorage: { setRuntimeApiKey: vi.fn() },
          modelRegistry: {},
        };
      },
    );
  }

  beforeEach(() => {
    hookRunner.hasHooks.mockReset();
    hookRunner.runBeforeCompaction.mockReset();
    hookRunner.runAfterCompaction.mockReset();
    resolveContextEngineMock.mockReset();
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: true },
      compact: contextEngineCompactMock,
    });
    contextEngineCompactMock.mockReset();
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: undefined,
      result: { summary: "engine-summary", tokensAfter: 50 },
    });
    mockResolvedModel();
    mockQueuedRouteAwareModel();
  });

  it("disposes the context engine once when route materialization rejects", async () => {
    const dispose = vi.fn(async () => {});
    const authStorage = { setRuntimeApiKey: vi.fn() };
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: true },
      compact: contextEngineCompactMock,
      dispose,
    } as never);
    resolveModelAsyncMock
      .mockResolvedValueOnce({
        model: {
          provider: "openai",
          id: "fake",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          input: [],
        },
        error: null,
        authStorage,
        modelRegistry: {},
      })
      .mockRejectedValueOnce(new Error("route materialization failed"));

    await expect(
      compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          provider: "openai",
          model: "fake",
          runtimeAuthPlan: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            selectedAuthMode: "api-key",
            modelRoute: {
              provider: "openai",
              modelId: "fake",
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              authRequirement: "api-key",
              requestTransportOverrides: "none",
            },
          },
        }),
      ),
    ).rejects.toThrow("route materialization failed");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(enqueueCommandInLaneMock).not.toHaveBeenCalled();
  });

  it("disposes the context engine safely when primary native compaction throws", async () => {
    const dispose = vi.fn(async () => {
      throw new Error("dispose failed");
    });
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
      dispose,
    } as never);
    maybeCompactAgentHarnessSessionMock.mockRejectedValueOnce(
      new Error("native compaction failed"),
    );

    await expect(
      compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          provider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "codex",
        }),
      ),
    ).rejects.toThrow("native compaction failed");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(enqueueCommandInLaneMock).not.toHaveBeenCalled();
  });

  it("binds context-engine compaction runtime LLM to the session agent", async () => {
    resolveSessionAgentIdsMock.mockReturnValueOnce({
      defaultAgentId: "main",
      sessionAgentId: "lossless-agent",
    });

    await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        config: {
          agents: {
            defaults: {
              model: "openai/gpt-5.5",
            },
          },
        },
        sessionKey: "legacy-topic-47",
      }),
    );

    const contextEngineCompactCalls = contextEngineCompactMock.mock.calls as unknown as Array<
      [
        {
          runtimeContext?: {
            llm?: {
              complete?: (params: {
                messages: Array<{ role: "user"; content: string }>;
                agentId?: string;
              }) => Promise<unknown>;
            };
          };
        },
      ]
    >;
    const runtimeContext = contextEngineCompactCalls[0]?.[0]?.runtimeContext;
    if (!runtimeContext) {
      throw new Error("expected compaction runtime context");
    }
    expect(runtimeContext.llm?.complete).toBeTypeOf("function");

    await expect(
      runtimeContext.llm?.complete?.({
        messages: [{ role: "user", content: "summarize" }],
        agentId: "other-agent",
      }),
    ).rejects.toThrow("cannot override the active session agent");
  });

  it("fires before_compaction with sentinel -1 and after_compaction on success", async () => {
    hookRunner.hasHooks.mockReturnValue(true);

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        messageChannel: "telegram",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);

    expect(mockCallArg(hookRunner.runBeforeCompaction)).toEqual({
      messageCount: -1,
      sessionFile: TEST_SESSION_FILE,
    });
    expectRecordFields(mockCallArg(hookRunner.runBeforeCompaction, 0, 1), {
      sessionKey: TEST_SESSION_KEY,
      messageProvider: "telegram",
    });
    expect(mockCallArg(hookRunner.runAfterCompaction)).toEqual({
      messageCount: -1,
      compactedCount: -1,
      tokenCount: 50,
      sessionFile: TEST_SESSION_FILE,
    });
    expectRecordFields(mockCallArg(hookRunner.runAfterCompaction, 0, 1), {
      sessionKey: TEST_SESSION_KEY,
      messageProvider: "telegram",
    });
  });

  it("passes the rotated session id to engine-owned after_compaction hooks", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    const rotatedSessionId = "rotated-session";
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: undefined,
      result: {
        summary: "engine-summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        tokensAfter: 50,
        sessionId: rotatedSessionId,
      },
    } as never);

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({ cwd: "/tmp/task-repo" }),
    );

    expect(result.ok).toBe(true);
    expectRecordFields(mockCallArg(hookRunner.runAfterCompaction), {
      sessionFile: TEST_SESSION_FILE,
      previousSessionId: TEST_SESSION_ID,
    });
    expectRecordFields(mockCallArg(hookRunner.runAfterCompaction, 0, 1), {
      sessionId: rotatedSessionId,
      sessionKey: TEST_SESSION_KEY,
    });
  });

  it("emits a transcript update and post-compaction memory sync on the engine-owned path", async () => {
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });

    try {
      const result = await compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          sessionFile: `  ${TEST_SESSION_FILE}  `,
          config: compactionConfig("await"),
        }),
      );

      expect(result.ok).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        agentId: "main",
        sessionKey: TEST_SESSION_KEY,
        sessionId: TEST_SESSION_ID,
        target: {
          agentId: "main",
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_SESSION_KEY,
        },
      });
      expect(sync).toHaveBeenCalledWith({
        reason: "post-compaction",
        sessions: [
          {
            agentId: "main",
            sessionId: TEST_SESSION_ID,
            sessionKey: TEST_SESSION_KEY,
          },
        ],
      });
    } finally {
      cleanup();
    }
  });

  it("runs maintain after successful compaction with a transcript rewrite helper", async () => {
    const maintain = vi.fn(async (_params?: unknown) => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: true },
      compact: contextEngineCompactMock,
      maintain,
    } as never);

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({ cwd: "/tmp/task-repo" }),
    );

    expect(result.ok).toBe(true);
    const runtimeContext = (
      maintain.mock.calls.at(0)?.[0] as { runtimeContext?: Record<string, unknown> } | undefined
    )?.runtimeContext;
    expectRecordFields(mockCallArg(maintain), {
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });
    expect(runtimeContext?.workspaceDir).toBe(TEST_WORKSPACE_DIR);
    expect(runtimeContext?.cwd).toBe("/tmp/task-repo");
    expect(runtimeContext?.rewriteTranscriptEntries).toBeTypeOf("function");
  });

  it("resolves the effective compaction model before manual engine-owned compaction", async () => {
    await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        config: {
          agents: {
            defaults: {
              compaction: {
                model: "anthropic/claude-opus-4-6",
              },
            },
          },
        },
        provider: "openai",
        model: "gpt-5.4",
        authProfileId: "openai:p1",
      }),
    );

    expect(mockCallArg(resolveModelMock)).toBe("anthropic");
    expect(mockCallArg(resolveModelMock, 0, 1)).toBe("claude-opus-4-6");
    expect(mockCallArg(resolveModelMock, 0, 2)).toBeTypeOf("string");
    if (mockCallArg(resolveModelMock, 0, 3) === undefined) {
      throw new Error("Expected resolve-model options");
    }
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg.runtimeContext, {
      provider: "anthropic",
      model: "claude-opus-4-6",
      authProfileId: undefined,
    });
  });

  it("clamps caller context token budget before queued engine-owned compaction", async () => {
    resolveContextWindowInfoMock.mockReturnValueOnce({ tokens: 32_000 });

    await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        contextTokenBudget: 64_000,
        config: {
          agents: {
            defaults: {
              compaction: {
                model: "anthropic/claude-opus-4-6",
              },
            },
          },
        },
      }),
    );

    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      tokenBudget?: number;
      runtimeContext?: Record<string, unknown>;
    };
    expect(compactArg.tokenBudget).toBe(32_000);
    expectRecordFields(compactArg.runtimeContext, {
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  it("passes resolved OpenAI runtime context to context-engine compaction", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "codex" });
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:p1": {
          type: "api_key",
          provider: "openai",
          key: "platform-key",
        },
      },
    });
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "harness",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.4",
        authProfileId: "openai:p1",
        authProfileIdSource: "user",
        currentTokenCount: 333,
      }),
    );

    expect(result.ok).toBe(true);
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg.runtimeContext, {
      sessionKey: TEST_SESSION_KEY,
      workspaceDir: TEST_WORKSPACE_DIR,
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "openai:p1",
      currentTokenCount: 333,
    });
  });

  it("runs selected Codex harness queued compaction on canonical OpenAI context", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "codex" });
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "harness",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
        config: {
          models: {
            providers: {
              openai: { models: [{ id: "gpt-5.5", contextWindow: 350_000 }] },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(contextEngineCompactMock).toHaveBeenCalledTimes(1);
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(1);
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
      }),
      { nativeCompactionRequest: "after_context_engine" },
    );
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg.runtimeContext, {
      provider: "openai",
      runtimeProvider: undefined,
      model: "gpt-5.5",
    });
  });

  it("keeps queued native auth candidates uncollapsed until native resolution", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "native",
      runtimeSource: "model",
    } as never);
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:subscription": {
          type: "token",
          provider: "openai",
          token: "subscription-token",
          expires: Date.now() + 60_000,
        },
      },
      order: { openai: ["openai:subscription"] },
    });
    resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    shouldPreferExplicitConfigApiKeyAuthMock.mockReturnValue(false);
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "harness",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "native",
        config: {
          models: {
            providers: {
              openai: {
                auth: "api-key",
                apiKey: "literal-key",
                models: [{ id: "gpt-5.5", contextWindow: 350_000 }],
              },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(selectAgentHarnessForPreparedModelProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProviders: expect.arrayContaining([
          expect.objectContaining({
            api: "openai-chatgpt-responses",
            preparedAuth: expect.objectContaining({ source: "profile" }),
          }),
          expect.objectContaining({
            api: "openai-responses",
            preparedAuth: expect.objectContaining({ source: "direct" }),
          }),
        ]),
      }),
    );
    const nativeParams = mockCallArg(maybeCompactAgentHarnessSessionMock) as {
      runtimeAuthPlan?: unknown;
      runtimePlan?: unknown;
    };
    expect(nativeParams.runtimeAuthPlan).toBeUndefined();
    expect(nativeParams.runtimePlan).toBeUndefined();
  });

  it("keeps cross-route direct fallback available through queued legacy compaction", async () => {
    const authStore = {
      version: 1 as const,
      profiles: {
        "openai:subscription": {
          type: "token" as const,
          provider: "openai",
          token: "subscription-token",
          expires: Date.now() + 60_000,
        },
      },
      order: { openai: ["openai:subscription"] },
    };
    ensureAuthProfileStoreMock.mockReturnValue(authStore);
    resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    shouldPreferExplicitConfigApiKeyAuthMock.mockReturnValue(false);
    getApiKeyForModelMock.mockImplementation(async (authParams = {}) => {
      if (authParams.profileId === "openai:subscription") {
        throw new Error("subscription credential resolution failed");
      }
      if (authParams.allowAuthProfileFallback === false) {
        return { apiKey: "literal-key", mode: "api-key", source: "models.json" };
      }
      throw new Error("unexpected auth lookup");
    });
    const legacyCompact = vi.fn(
      async (compactParams: {
        sessionId: string;
        sessionKey?: string;
        sessionFile: string;
        tokenBudget?: number;
        force?: boolean;
        customInstructions?: string;
        runtimeContext?: Record<string, unknown>;
      }) => {
        const directParams = {
          ...compactParams.runtimeContext,
          sessionId: compactParams.sessionId,
          sessionKey: compactParams.sessionKey,
          sessionFile: compactParams.sessionFile,
          tokenBudget: compactParams.tokenBudget,
          force: compactParams.force,
          customInstructions: compactParams.customInstructions,
          workspaceDir: TEST_WORKSPACE_DIR,
        } as Parameters<typeof compactEmbeddedAgentSessionDirect>[0];
        return await compactEmbeddedAgentSessionDirect(directParams);
      },
    );
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: legacyCompact,
    } as never);

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: {
                auth: "api-key",
                apiKey: "literal-key",
                models: [{ id: "gpt-5.5" }],
              },
            },
          },
          agents: {
            defaults: {
              models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(
      getApiKeyForModelMock.mock.calls.map(([authParams]) => ({
        profileId: authParams?.profileId,
        allowAuthProfileFallback: authParams?.allowAuthProfileFallback,
      })),
    ).toEqual([
      { profileId: "openai:subscription", allowAuthProfileFallback: undefined },
      { profileId: undefined, allowAuthProfileFallback: false },
    ]);
  });

  it("uses explicit Codex runtime policy for queued native compaction", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "model",
    } as never);
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "harness",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: { models: [{ id: "gpt-5.5", contextWindow: 350_000 }] },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(contextEngineCompactMock).toHaveBeenCalledTimes(1);
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(1);
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
      }),
      { nativeCompactionRequest: "after_context_engine" },
    );
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg.runtimeContext, {
      provider: "openai",
      runtimeProvider: undefined,
      model: "gpt-5.5",
    });
  });

  it("normalizes an omitted manual target before native harness compaction", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "model",
    } as never);
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { summary: "harness", firstKeptEntryId: "entry-1", tokensBefore: 100 },
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        config: {
          agents: {
            defaults: {
              compaction: { model: "openai/gpt-5.5" },
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
        runtimeModel: expect.objectContaining({
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        }),
      }),
      { nativeCompactionRequest: "after_context_engine" },
    );
  });

  it("preserves concrete OpenClaw pins over explicit Codex policy for queued compaction", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "model",
    } as never);
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "harness",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "openclaw",
        config: {
          models: {
            providers: {
              openai: { models: [{ id: "gpt-5.5", contextWindow: 350_000 }] },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg.runtimeContext, {
      provider: "openai",
      runtimeProvider: undefined,
      model: "gpt-5.5",
    });
  });

  it("uses concrete Codex pins on canonical OpenAI for queued compaction", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "auto",
      runtimeSource: "model",
    } as never);
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "harness",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
        config: {
          models: {
            providers: {
              openai: { models: [{ id: "gpt-5.5", contextWindow: 350_000 }] },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(contextEngineCompactMock).toHaveBeenCalledTimes(1);
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(1);
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
      }),
      { nativeCompactionRequest: "after_context_engine" },
    );
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg.runtimeContext, {
      provider: "openai",
      runtimeProvider: undefined,
      model: "gpt-5.5",
    });
  });

  it("materializes the selected route before deriving compaction context budget", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "model",
    } as never);
    resolveContextWindowInfoMock.mockImplementation((input?: { modelContextWindow?: number }) => ({
      tokens: input?.modelContextWindow ?? 128_000,
    }));
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:token": {
          type: "token",
          provider: "openai",
          token: "subscription-token",
        },
      },
      order: { openai: ["openai:token"] },
    });
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { summary: "harness", firstKeptEntryId: "entry-1", tokensBefore: 100 },
    });

    await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        authProfileId: "openai:token",
        authProfileIdSource: "auto",
        agentHarnessId: "codex",
      }),
    );

    expect(mockCallArg(resolveModelAsyncMock, 0, 4)).toEqual(
      expect.objectContaining({ authProfileId: "openai:token" }),
    );
    expect(resolveModelAsyncMock).toHaveBeenLastCalledWith(
      "openai",
      "gpt-5.5",
      expect.any(String),
      expect.objectContaining({
        models: {
          providers: {
            openai: expect.objectContaining({
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
            }),
          },
        },
      }),
      expect.objectContaining({ authProfileMode: "token" }),
    );
    expect(contextEngineCompactMock).toHaveBeenCalledWith(
      expect.objectContaining({ tokenBudget: 272_000 }),
    );
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg.runtimeContext, {
      provider: "openai",
      runtimeProvider: undefined,
      model: "gpt-5.5",
    });
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:token",
        authProfileIdSource: "auto",
        contextTokenBudget: 272_000,
        runtimeModel: expect.objectContaining({
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          contextWindow: 272_000,
        }),
        runtimeAuthPlan: undefined,
      }),
      { nativeCompactionRequest: "after_context_engine" },
    );
  });

  it("prepares queued native harness auth without a host profile", async () => {
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "model",
    } as never);
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { summary: "harness", firstKeptEntryId: "entry-1", tokensBefore: 100 },
    });

    await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
      }),
    );

    expect(selectAgentHarnessForPreparedModelProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProviders: expect.arrayContaining([
          expect.objectContaining({
            preparedAuth: expect.objectContaining({ source: "harness" }),
            runtimePolicy: expect.objectContaining({ compatibleIds: ["openclaw", "codex"] }),
          }),
        ]),
      }),
    );
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeAuthPlan: undefined }),
      { nativeCompactionRequest: "after_context_engine" },
    );
  });

  it("does not route queued compaction through implicit Codex policy alone", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "codex" });
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "harness",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: { models: [{ id: "gpt-5.5", contextWindow: 350_000 }] },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg.runtimeContext, {
      provider: "openai",
      runtimeProvider: undefined,
      model: "gpt-5.5",
    });
  });

  it("routes unbound ChatGPT OAuth queued compaction through auth-aware codex selection", async () => {
    // Implicit policy may prefer codex, but with no bound/planned harness the
    // override must stay undefined so prepared OAuth can select the harness.
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "implicit",
    } as never);
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "test-auth-token",
          refresh: "test-auth-token",
          expires: Date.now() + 10 * 60_000,
        },
      },
      order: { openai: ["openai:chatgpt"] },
    });
    getApiKeyForModelMock.mockImplementation(async (params?: { profileId?: string }) => ({
      apiKey: "test-auth-token",
      mode: "oauth",
      source: `profile:${params?.profileId ?? "openai:chatgpt"}`,
      profileId: params?.profileId ?? "openai:chatgpt",
    }));

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        // Do not pin provider-level api to openai-responses: that collapses
        // route resolution to api-key-only and hides ChatGPT OAuth.
        config: {
          models: {
            providers: {
              openai: { models: [{ id: "gpt-5.5", contextWindow: 350_000 }] },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
    expect(selectAgentHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: undefined,
        agentHarnessRuntimeOverride: undefined,
      }),
    );
    expect(selectAgentHarnessMock.mock.results[0]?.value).toEqual(
      expect.objectContaining({ id: "codex", authBootstrap: "harness" }),
    );
    expect(selectAgentHarnessForPreparedModelProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessRuntimeOverride: undefined,
        modelProviders: expect.arrayContaining([
          expect.objectContaining({
            preparedAuth: expect.objectContaining({
              source: "profile",
              mode: "oauth",
              requirement: "subscription",
            }),
          }),
        ]),
      }),
    );
  });

  it("keeps unbound api-key queued compaction on openclaw without native harness compaction", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "openclaw",
      runtimeSource: "implicit",
    } as never);

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: { models: [{ id: "gpt-5.5", contextWindow: 350_000 }] },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
    expect(selectAgentHarnessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: undefined,
        agentHarnessRuntimeOverride: undefined,
      }),
    );
    expect(selectAgentHarnessMock.mock.results[0]?.value).toEqual(
      expect.objectContaining({ id: "openclaw" }),
    );
  });

  it("resolves reusable queued direct auth without a stored profile", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "openclaw",
      runtimeSource: "implicit",
    } as never);

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        runtimeAuthPlan: {
          providerForAuth: "openai",
          modelId: "gpt-5.5",
          authProfileProviderForAuth: "openai",
          selectedAuthMode: "api-key",
        },
        config: {
          models: {
            providers: {
              openai: { models: [{ id: "gpt-5.5", contextWindow: 350_000 }] },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(mockCallArg(resolveModelAsyncMock, 0, 4)).toEqual({
      authProfileMode: "api_key",
    });
  });

  it("uses a prepared harness binding for queued custom OpenAI Responses compaction", async () => {
    const modelRoute = {
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      authRequirement: "api-key",
      requestTransportOverrides: "none",
    } as const;
    const runtimeAuthPlan = {
      providerForAuth: "openai",
      modelId: "gpt-5.5",
      authProfileProviderForAuth: "openai",
      harnessAuthProvider: "openai",
      selectedAuthMode: "api-key",
      modelRoute,
    } as const;
    resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "codex" });
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "harness",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
        runtimeAuthPlan,
        config: {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: "https://example.test/v1",
                models: [{ id: "gpt-5.5", contextWindow: 350_000 }],
              },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(mockCallArg(resolveModelMock)).toBe("openai");
    expectRecordFields(mockCallArg(resolveContextWindowInfoMock), {
      provider: "openai",
      modelId: "gpt-5.5",
    });
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
        runtimeModel: expect.objectContaining({
          api: "openai-responses",
          baseUrl: "https://example.test/v1",
        }),
        runtimeAuthPlan: expect.objectContaining({ modelRoute }),
      }),
      { nativeCompactionRequest: "after_context_engine" },
    );
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg.runtimeContext, {
      provider: "openai",
      runtimeProvider: undefined,
      model: "gpt-5.5",
    });
  });

  it("keeps queued custom OpenAI Responses compaction embedded without a harness binding", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "openclaw",
      runtimeSource: "implicit",
    } as never);

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: "https://example.test/v1",
                models: [{ id: "gpt-5.5", contextWindow: 350_000 }],
              },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(contextEngineCompactMock).toHaveBeenCalledTimes(1);
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg.runtimeContext, {
      provider: "openai",
      runtimeProvider: undefined,
      model: "gpt-5.5",
    });
  });

  it("fails deferred budget compaction when background maintenance is not scheduled", async () => {
    const dispose = vi.fn(async () => {});
    const maintain = vi.fn(async () => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: true, turnMaintenanceMode: "background" },
      compact: contextEngineCompactMock,
      dispose,
      maintain,
    } as never);
    enqueueCommandInLaneMock.mockImplementationOnce(() => {
      throw new Error("scheduler offline");
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        trigger: "budget",
        deferOwningContextEngineCompaction: true,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("failed to schedule background context-engine maintenance");
    expect(result.failure?.reason).toBe("deferred_compaction_not_scheduled");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(maintain).not.toHaveBeenCalled();
    expect(contextEngineCompactMock).not.toHaveBeenCalled();
  });

  it("keeps context-engine compaction successful when Codex native binding is missing", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "codex" });
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "no codex app-server thread binding",
      failure: { reason: "missing_thread_binding" },
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.4",
        agentHarnessId: "codex",
        currentTokenCount: 333,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.summary).toBe("engine-summary");
    expect(contextEngineCompactMock).toHaveBeenCalledTimes(1);
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(1);
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        agentHarnessId: "codex",
      }),
      { nativeCompactionRequest: "after_context_engine" },
    );
    const details = result.result?.details as
      | { codexNativeCompaction?: Record<string, unknown> }
      | undefined;
    expect(details?.codexNativeCompaction).toMatchObject({
      ok: false,
      compacted: false,
      reason: "no codex app-server thread binding",
      failure: { reason: "missing_thread_binding" },
    });
  });

  it.each([
    ["missing_thread_binding", "no codex app-server thread binding"],
    ["stale_thread_binding", "thread not found"],
  ])(
    "fails model-locked Codex compaction on %s without a context-engine fallback",
    async (failureReason, reason) => {
      resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "openclaw" });
      maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
        ok: false,
        compacted: false,
        reason,
        failure: { reason: failureReason },
      });

      const result = await compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          provider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          currentTokenCount: 333,
        }),
      );

      expect(result).toMatchObject({
        ok: false,
        compacted: false,
        failure: { reason: failureReason },
      });
      expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(1);
      expect(contextEngineCompactMock).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "auto"])(
    "fails a model-locked session with unavailable persisted harness %s",
    async (agentHarnessId) => {
      const result = await compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          provider: "openai",
          model: "gpt-5.5",
          agentHarnessId,
          modelSelectionLocked: true,
          currentTokenCount: 333,
        }),
      );

      expect(result).toMatchObject({
        ok: false,
        compacted: false,
        failure: { reason: "model_selection_locked" },
      });
      expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
      expect(contextEngineCompactMock).not.toHaveBeenCalled();
    },
  );

  it("fails a model-locked native session when its harness returns no result", async () => {
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce(undefined);

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        currentTokenCount: 333,
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      failure: { reason: "model_selection_locked" },
    });
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(1);
    expect(contextEngineCompactMock).not.toHaveBeenCalled();
  });

  it("keeps owning context-engine compaction primary for legacy Codex native sessions", async () => {
    const successorSessionId = "engine-successor-session";
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "model",
    } as never);
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: undefined,
      result: {
        summary: "engine-summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 333,
        tokensAfter: 50,
        sessionId: successorSessionId,
      },
    } as never);
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "",
        firstKeptEntryId: "",
        tokensBefore: 333,
        details: {
          backend: "codex-app-server",
          signal: "thread/compact/start",
          pending: false,
          completed: true,
        },
      },
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "codex",
        model: "gpt-5.4",
        agentHarnessId: "codex",
        trigger: "budget",
        currentTokenCount: 333,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.summary).toBe("engine-summary");
    expect(contextEngineCompactMock).toHaveBeenCalledTimes(1);
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(1);
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: successorSessionId,
        sessionFile: TEST_SESSION_FILE,
        trigger: "budget",
      }),
      { nativeCompactionRequest: "after_context_engine" },
    );
    expect(contextEngineCompactMock.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(
        maybeCompactAgentHarnessSessionMock.mock.invocationCallOrder[0],
        "maybeCompactAgentHarnessSessionMock.mock.invocationCallOrder[0] test invariant",
      ),
    );
    const details = result.result?.details as
      | { codexNativeCompaction?: Record<string, unknown> }
      | undefined;
    expect(details?.codexNativeCompaction).toMatchObject({
      ok: true,
      compacted: true,
      result: {
        tokensBefore: 333,
        details: {
          backend: "codex-app-server",
          signal: "thread/compact/start",
          pending: false,
          completed: true,
        },
      },
    });
  });

  it("holds the queued lane until secondary Codex compaction reaches its terminal event", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "model",
    } as never);
    const nativeTerminal = createDeferred<{
      ok: true;
      compacted: true;
      result: { summary: string; firstKeptEntryId: string; tokensBefore: number };
    }>();
    maybeCompactAgentHarnessSessionMock.mockReturnValueOnce(nativeTerminal.promise);
    compactWithSafetyTimeoutMock
      .mockImplementation(async () => {
        throw new Error("Compaction timed out");
      })
      .mockImplementationOnce(async (compact) => await compact());

    let settled = false;
    const resultPromise = compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "codex",
        model: "gpt-5.4",
        agentHarnessId: "codex",
        trigger: "budget",
      }),
    ).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(1);
    });
    expect(settled).toBe(false);
    expect(compactWithSafetyTimeoutMock).toHaveBeenCalledTimes(1);

    nativeTerminal.resolve({
      ok: true,
      compacted: true,
      result: {
        summary: "",
        firstKeptEntryId: "",
        tokensBefore: 333,
      },
    });
    await expect(resultPromise).resolves.toMatchObject({ ok: true, compacted: true });
  });

  it("keeps context-engine compaction successful when the secondary Codex bridge gets a provider 4xx", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "model",
    } as never);
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "provider_error_4xx",
      failure: {
        reason: "provider_error_4xx",
        status: 400,
        rawError: "provider_error_4xx",
      },
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "codex",
        model: "gpt-5.4",
        agentHarnessId: "codex",
        trigger: "budget",
        currentTokenCount: 333,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.summary).toBe("engine-summary");
    expect(contextEngineCompactMock).toHaveBeenCalledTimes(1);
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(1);
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "budget",
      }),
      { nativeCompactionRequest: "after_context_engine" },
    );
    const details = result.result?.details as
      | { codexNativeCompaction?: Record<string, unknown> }
      | undefined;
    expect(details?.codexNativeCompaction).toMatchObject({
      ok: false,
      compacted: false,
      reason: "provider_error_4xx",
      failure: {
        reason: "provider_error_4xx",
        status: 400,
      },
    });
  });

  it("does not fire after_compaction when compaction fails", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    contextEngineCompactMock.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
      result: undefined,
    });

    const result = await compactEmbeddedAgentSession(wrappedCompactionArgs());

    expect(result.ok).toBe(false);
    expect(hookRunner.runBeforeCompaction).toHaveBeenCalledTimes(1);
    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("surfaces a hung/throwing engine compact() as a clean ok:false result", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    // The safety-timeout wrapper rejects on timeout; a thrown rejection here
    // simulates that path. The queued lane must convert it to a result object
    // instead of throwing a raw rejection at callers that only read result.ok.
    contextEngineCompactMock.mockRejectedValue(new Error("Compaction timed out after 900000ms"));

    const result = await compactEmbeddedAgentSession(wrappedCompactionArgs());

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("timed out");
    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
  });

  it("forces engine-owned compaction for preflight-required budget compaction", async () => {
    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        trigger: "budget",
        forcePreflight: true,
        preflightRequired: true,
        preflightCompactionTrigger: "transcript_bytes",
      }),
    );

    expect(result.ok).toBe(true);
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg, {
      compactionTarget: "budget",
      force: true,
    });
    expectRecordFields(compactArg.runtimeContext, {
      forceReason: "preflight_required",
      preflightCompactionTrigger: "transcript_bytes",
    });
  });

  it("continues forcing engine-owned manual compaction with manual force reason", async () => {
    const result = await compactEmbeddedAgentSession(wrappedCompactionArgs({ trigger: "manual" }));

    expect(result.ok).toBe(true);
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg, {
      compactionTarget: "threshold",
      force: true,
    });
    expectRecordFields(compactArg.runtimeContext, {
      forceReason: "manual",
    });
  });

  it("aborts manual compaction before its queued global task starts", async () => {
    let startQueuedTask: (() => void) | undefined;
    const enqueue = <T>(task: () => Promise<T> | T): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        startQueuedTask = () => {
          void Promise.resolve().then(task).then(resolve, reject);
        };
      });

    const resultPromise = compactEmbeddedAgentSession(
      wrappedCompactionArgs({ enqueue, trigger: "manual" }),
    );

    await vi.waitFor(() => {
      expect(startQueuedTask).toBeTypeOf("function");
    });
    expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(true);
    expect(abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" })).toBe(true);

    const start = startQueuedTask;
    if (!start) {
      throw new Error("Expected queued compaction task");
    }
    start();

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      compacted: false,
      reason: expect.stringContaining("aborted"),
    });
    expect(contextEngineCompactMock).not.toHaveBeenCalled();
    expect(hookRunner.runBeforeCompaction).not.toHaveBeenCalled();
    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
  });

  it.each([
    { position: "primary", ownsCompaction: false, abortReason: "user_abort", resultOk: false },
    { position: "secondary", ownsCompaction: true, abortReason: "restart", resultOk: true },
  ] as const)(
    "aborts $position native harness compaction through the registered handle",
    async ({ ownsCompaction, abortReason, resultOk }) => {
      resolveContextEngineMock.mockResolvedValue({
        info: { ownsCompaction },
        compact: contextEngineCompactMock,
      });
      resolveAgentHarnessPolicyMock.mockReturnValue({
        runtime: "codex",
        runtimeSource: "model",
      } as never);
      const pending = mockPendingNativeCompaction();
      const resultPromise = compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          provider: "openai",
          model: "gpt-5.4",
          agentHarnessId: "codex",
          trigger: "manual",
        }),
      );

      await pending.started.promise;
      const aborted =
        abortReason === "restart"
          ? abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" })
          : abortEmbeddedAgentRun(TEST_SESSION_ID);
      expect(aborted).toBe(true);
      expect(pending.signal?.reason).toBe(abortReason);
      pending.terminal.resolve({ ok: false, compacted: false, reason: "aborted" });

      await expect(resultPromise).resolves.toMatchObject({ ok: resultOk });
      expect(contextEngineCompactMock).toHaveBeenCalledTimes(ownsCompaction ? 1 : 0);
      expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
    },
  );

  it("registers manual compaction alongside its active reply operation", async () => {
    const replyOperation = createReplyOperation({
      sessionKey: TEST_SESSION_KEY,
      sessionId: TEST_SESSION_ID,
      resetTriggered: false,
    });
    replyOperation.setPhase("preflight_compacting");
    expect(isEmbeddedAgentRunActive(TEST_SESSION_ID)).toBe(true);
    expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
    const pending = mockPendingContextEngineCompaction();

    try {
      const resultPromise = compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          abortSignal: replyOperation.abortSignal,
          trigger: "manual",
        }),
      );

      await pending.started.promise;
      expect(isEmbeddedAgentRunActive(TEST_SESSION_ID)).toBe(true);
      expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(true);
      expect(replyOperation.abortByUser()).toBe(true);
      expect(pending.signal?.aborted).toBe(true);
      expect(pending.signal?.reason).toBe(replyOperation.abortSignal.reason);
      pending.release.resolve(undefined);

      await expect(resultPromise).resolves.toMatchObject({ ok: false, compacted: false });
      expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
      expect(isEmbeddedAgentRunActive(TEST_SESSION_ID)).toBe(true);
    } finally {
      replyOperation.complete();
    }
  });

  it("clears the manual handle when setup rejects", async () => {
    resolveModelMock.mockImplementationOnce(() => {
      throw new Error("model failed");
    });

    await expect(
      compactEmbeddedAgentSession(wrappedCompactionArgs({ trigger: "manual" })),
    ).rejects.toThrow("model failed");
    expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
  });

  it.each([
    {
      identity: "session key",
      activeSessionKey: TEST_SESSION_KEY,
      activeSessionFile: "/tmp/other-session.jsonl",
    },
    {
      identity: "session file",
      activeSessionKey: "agent:main:other-session",
      activeSessionFile: TEST_SESSION_FILE,
    },
  ])("rejects manual compaction matching an active $identity", async (active) => {
    const activeSessionId = "other-session";
    const existingHandle = {
      kind: "embedded" as const,
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    setActiveEmbeddedRun(
      activeSessionId,
      existingHandle,
      active.activeSessionKey,
      active.activeSessionFile,
    );
    try {
      await expect(
        compactEmbeddedAgentSession(wrappedCompactionArgs({ trigger: "manual" })),
      ).resolves.toMatchObject({
        ok: false,
        compacted: false,
        failure: { reason: "active_run" },
      });
      expect(contextEngineCompactMock).not.toHaveBeenCalled();
      expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
      expect(isEmbeddedAgentRunHandleActive(activeSessionId)).toBe(true);
    } finally {
      clearActiveEmbeddedRun(
        activeSessionId,
        existingHandle,
        active.activeSessionKey,
        active.activeSessionFile,
      );
    }
  });

  it("does not duplicate transcript updates or sync in the wrapper when the engine delegates compaction", async () => {
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
    });

    try {
      const result = await compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          config: compactionConfig("await"),
        }),
      );

      expect(result.ok).toBe(true);
      expect(listener).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("reuses a delegated compaction successor session identity", async () => {
    const maintain = vi.fn(async (_params?: unknown) => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    const delegatedSessionId = "delegated-session";
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
      maintain,
    } as never);
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: undefined,
      result: {
        summary: "engine-summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        tokensAfter: 50,
        sessionId: delegatedSessionId,
      },
    } as never);

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        config: {
          agents: {
            defaults: {
              compaction: {
                truncateAfterCompaction: true,
              },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.result?.sessionId).toBe(delegatedSessionId);
    expect(result.result?.sessionFile).toBeUndefined();
    expectRecordFields(mockCallArg(maintain), {
      sessionId: delegatedSessionId,
      sessionFile: TEST_SESSION_FILE,
    });
  });

  it("keeps a delegated result that echoes the current transcript on the active transcript", async () => {
    const maintain = vi.fn(async (_params?: unknown) => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
      maintain,
    } as never);
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: undefined,
      result: {
        summary: "engine-summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        tokensAfter: 50,
        sessionId: TEST_SESSION_ID,
      },
    } as never);
    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        config: {
          agents: {
            defaults: {
              compaction: {
                truncateAfterCompaction: true,
              },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(rotateTranscriptAfterCompactionMock).not.toHaveBeenCalled();
    expect(result.result?.sessionId).toBeUndefined();
    expect(result.result?.sessionFile).toBeUndefined();
    expectRecordFields(mockCallArg(maintain), {
      sessionId: TEST_SESSION_ID,
      sessionFile: TEST_SESSION_FILE,
    });
  });

  it("catches and logs hook exceptions without aborting compaction", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeCompaction.mockRejectedValue(new Error("hook boom"));

    const result = await compactEmbeddedAgentSession(wrappedCompactionArgs());

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(contextEngineCompactMock).toHaveBeenCalledTimes(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
