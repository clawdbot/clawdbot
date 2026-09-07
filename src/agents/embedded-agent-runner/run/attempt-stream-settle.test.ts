// Settlement liveness: a wedged block-reply flush must not park the turn.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveProviderContext,
  type ProviderStreamOptions,
} from "../../../../packages/ai/src/provider-types.js";
import { createPluginMetadataSnapshot } from "../../../config/plugin-auto-enable.test-helpers.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { bindStreamLlmRuntime } from "../../../llm/model-runtime-binding.js";
import { createCodexNativeWebSearchWrapper } from "../../../llm/providers/stream-wrappers/openai.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import { attachRuntimePromptMediaFacts } from "../../../media/media-facts.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import type { StreamFn } from "../../runtime/index.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/index.js";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import { readLastCacheTtlTimestamp } from "../cache-ttl.js";
import { testing as extraParamsTesting } from "../extra-params.test-support.js";
import {
  clearEmbeddedSessionPromptStates,
  createToolResultPromptProjectionState,
  getEmbeddedSessionPromptState,
  persistToolResultProjections,
  serializeCacheTtlToolResultProjections,
} from "../session-prompt-state.js";
import { restoreCacheTtlToolResultProjections } from "../tool-result-truncation.js";
import { RUN_LIVENESS_JOIN_TIMEOUT_MS } from "./abortable.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import {
  prepareEmbeddedAttemptTransport,
  settleEmbeddedAttemptStream,
} from "./attempt-stream-settle.js";

const registerProviderStreamForModel = vi.hoisted(() => vi.fn());

vi.mock("../../provider-stream.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../provider-stream.js")>()),
  registerProviderStreamForModel,
}));

type SettleInput = Parameters<typeof settleEmbeddedAttemptStream>[0];
type PrepareTransportInput = Parameters<typeof prepareEmbeddedAttemptTransport>[0];
const MP4 = Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex");

function createSettleFixture(overrides?: Partial<SettleInput>): SettleInput {
  const sessionManager = SessionManager.inMemory();
  const runAbortDeadlineAtMs = Date.now() + 600_000;
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
    toolResultPromptProjectionState: createToolResultPromptProjectionState(),
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
    getRunAbortDeadlineAtMs: () => runAbortDeadlineAtMs,
    runAbortSignal: new AbortController().signal,
    isProbeSession: true,
    abortable: async <T>(promise: Promise<T>) => await promise,
    prePromptMessageCount: 0,
    nestedToolActivities: [],
    cache: {
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

  it("keeps the last request observation separate from billing totals", async () => {
    const input = createSettleFixture();
    input.subscription.getUsageTotals = () => ({ input: 300, cacheRead: 30_000 });
    input.subscription.getLastAssistantUsage = () => ({ input: 100, cacheRead: 10_000 });
    input.cache = {
      ...input.cache,
      getObservation: () => ({
        requestIndex: 3,
        broke: false,
        input: 100,
        cacheRead: 10_000,
        cacheWrite: 0,
        previousCacheRead: 10_000,
        changes: null,
      }),
    };
    const result = await settleEmbeddedAttemptStream(input);
    expect(result.attemptUsage?.cacheRead).toBe(30_000);
    expect(result.promptCache?.observation).toMatchObject({
      broke: false,
      cacheRead: 10_000,
      previousCacheRead: 10_000,
    });
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

  it("persists the active projection after session-state eviction", async () => {
    const sessionId = "cache-ttl-settle-evicted";
    const otherSessionIds = Array.from({ length: 65 }, (_, index) => `cache-ttl-other-${index}`);
    const state = getEmbeddedSessionPromptState(sessionId).toolResults;
    const key = "tool:old-read:42";
    state.replacements.set(key, {
      content: [{ type: "text", text: "kept prefix\n...\nkept suffix" }],
      cacheTtl: "soft",
    });
    state.sourceHashByKey.set(key, "original-source-hash");
    state.frozen.add(key);
    const input = {
      ...createSettleFixture(),
      toolResultPromptProjectionState: state,
    };
    input.attempt = {
      ...input.attempt,
      sessionId,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      model: { ...input.attempt.model, api: "anthropic-messages" },
      config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } },
    };
    try {
      for (const otherSessionId of otherSessionIds) {
        getEmbeddedSessionPromptState(otherSessionId);
      }
      expect(getEmbeddedSessionPromptState(sessionId).toolResults).not.toBe(state);

      // Production supplies this generation before entering the attempt runner.
      const metadataSnapshot = createPluginMetadataSnapshot({
        config: input.attempt.config,
        manifestRegistry: { plugins: [], diagnostics: [] },
      });
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
        settleEmbeddedAttemptStream(input),
      );

      expect(input.sessionManager.getEntries()).toContainEqual(
        expect.objectContaining({
          type: "custom",
          customType: "openclaw.cache-ttl",
          data: expect.objectContaining({
            prunedToolResults: [{ key, mode: "soft" }],
          }),
        }),
      );
    } finally {
      clearEmbeddedSessionPromptStates([sessionId, ...otherSessionIds]);
    }
  });
});

describe("attempt projection persistence through settlement", () => {
  registerAgentSessionLoopTestLifecycle();

  it("keeps one snapshot across unchanged dispatch, TTL settlement, and reopen", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-projection-settle-"));
    const scope = {
      agentId: "main",
      sessionId: "projection-settle",
      sessionKey: "agent:main:projection-settle",
      storePath: path.join(dir, "sessions.json"),
    };
    const model = { ...testModel, provider: "anthropic", id: "claude-sonnet-4-6" };
    try {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      let manager = SessionManager.open(scope, dir);
      manager.appendMessage({ role: "user", content: "read file", timestamp: 1 });
      manager.appendMessage(
        createAssistant(
          model,
          [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
          "toolUse",
        ),
      );
      const toolResult = {
        role: "toolResult" as const,
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text" as const, text: "x".repeat(6_000) }],
        isError: false,
        timestamp: 2,
      };
      manager.appendMessage(toolResult);
      manager.appendMessage(createAssistant(model, [{ type: "text", text: "read complete" }]));
      let previousSnapshot: ReturnType<typeof serializeCacheTtlToolResultProjections> | undefined;
      for (let turn = 0; turn < 3; turn++) {
        const sessionPromptState = getEmbeddedSessionPromptState(scope.sessionId);
        const projectionState = sessionPromptState.toolResults;
        restoreCacheTtlToolResultProjections(projectionState, manager.getBranch());
        if (previousSnapshot) {
          expect(serializeCacheTtlToolResultProjections(projectionState)).toEqual(previousSnapshot);
        }
        const { session } = await createTestSession({ sessionManager: manager, model });
        const input = createSettleFixture({
          activeSession: session,
          sessionManager: manager,
          toolResultPromptProjectionState: projectionState,
        });
        input.attempt = {
          ...input.attempt,
          sessionId: scope.sessionId,
          provider: model.provider,
          modelId: model.id,
          config: { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } },
        };
        const markers = () =>
          manager
            .getBranch()
            .filter(
              (entry) => entry.type === "custom" && entry.customType === "openclaw.cache-ttl",
            );
        const snapshotMarkers = () =>
          markers().filter(
            (entry) =>
              entry.type === "custom" && Object.hasOwn(entry.data as object, "frozenToolResults"),
          );
        session.agent.streamFn = () => {
          expect(snapshotMarkers()).toHaveLength(1);
          return createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "done" }]),
          );
        };
        await submitEmbeddedAttemptPrompt({
          attempt: input.attempt,
          activeSession: session,
          contextTokenBudget: 8_000,
          images: [],
          modelPrompt: "continue",
          onFinalPromptText: () => {},
          onSteeringAcknowledged: () => {},
          persistToolResultProjections: async () => {
            persistToolResultProjections(projectionState, (customType, data) =>
              manager.appendCustomEntry(customType, data),
            );
          },
          promptActiveSession: (prompt, options) => session.prompt(prompt, options),
          runtimeOnly: false,
          sessionPromptState,
          systemPrompt: "test prompt",
          toolResultAggregateMaxChars: 8_000,
          toolResultMaxChars: 4_000,
          toolResultPromptProjectionState: projectionState,
          trajectoryRecorder: null,
          transcriptLeafId: null,
          transcriptPrompt: "continue",
        });
        const metadataSnapshot = createPluginMetadataSnapshot({
          config: input.attempt.config,
          manifestRegistry: { plugins: [], diagnostics: [] },
        });
        await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
          settleEmbeddedAttemptStream(input),
        );
        expect(snapshotMarkers()).toHaveLength(1);
        expect(markers()).toHaveLength(turn + 2);
        const touch = markers().at(-1);
        expect(touch?.type === "custom" && touch.data).toEqual({
          timestamp: expect.any(Number),
          provider: model.provider,
          modelId: model.id,
        });
        expect(
          readLastCacheTtlTimestamp(manager, { provider: model.provider, modelId: model.id }),
        ).toBe(touch?.type === "custom" && (touch.data as { timestamp: number }).timestamp);
        expect(manager.getBranch()).toContainEqual(
          expect.objectContaining({ type: "message", message: toolResult }),
        );
        previousSnapshot = serializeCacheTtlToolResultProjections(projectionState);
        expect(previousSnapshot.frozenToolResults[0]?.texts?.[0]?.length).toBeLessThan(6_000);
        session.dispose();
        manager.flushPendingPersistence();
        clearEmbeddedSessionPromptStates([scope.sessionId]);
        manager = SessionManager.open(scope, dir);
      }
    } finally {
      clearEmbeddedSessionPromptStates([scope.sessionId]);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

function createTransportFixture(testCase: {
  compaction: boolean;
  pruning: boolean;
  apiKey: string;
  baseUrl?: string;
}) {
  const streamFn = vi.fn<StreamFn>();
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
      config: {
        agents: {
          defaults: { contextPruning: { mode: testCase.pruning ? "cache-ttl" : "off" } },
        },
      },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        baseUrl: testCase.baseUrl ?? "https://api.anthropic.com",
      },
      modelId: "claude-sonnet-4-6",
      provider: "anthropic",
      promptCacheKey: undefined,
      resolvedApiKey: undefined,
      authStorage: { getApiKey: async () => testCase.apiKey },
      runId: "run-transport-1",
      runtimePlan: {
        auth: { forwardedAuthProfileId: undefined },
        transport: {
          resolveExtraParams: () => ({
            transport: "sse",
            anthropicServerCompaction: testCase.compaction,
          }),
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
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    }),
    sandboxSessionKey: "agent:main:test",
    codeModeControlsEnabled: false,
    providerPromptState: {
      state: {},
      effectiveContextTokenBudget: 128_000,
    },
  } as unknown as PrepareTransportInput;
  return { input, session, streamFn };
}

describe("prepareEmbeddedAttemptTransport", () => {
  beforeEach(() => {
    // These cases own prepared auth/config, not runtime plugin discovery.
    extraParamsTesting.setProviderRuntimeDepsForTest({ wrapProviderStreamFn: () => undefined });
  });
  afterEach(() => {
    extraParamsTesting.resetProviderRuntimeDepsForTest();
    registerProviderStreamForModel.mockReset();
  });

  it.each([
    {
      compaction: true,
      apiKey: "test-api-key",
      replayEnabled: true,
      pruning: false,
      clearing: false,
    },
    {
      compaction: true,
      apiKey: "test-sk-ant-oat-oauth",
      replayEnabled: false,
      pruning: true,
      clearing: false,
    },
    {
      compaction: false,
      apiKey: "test-api-key",
      replayEnabled: false,
      pruning: true,
      clearing: true,
    },
    {
      compaction: true,
      apiKey: "test-api-key",
      replayEnabled: true,
      pruning: true,
      clearing: true,
    },
    {
      compaction: false,
      apiKey: "test-api-key",
      replayEnabled: false,
      pruning: true,
      clearing: false,
      baseUrl: "https://proxy.example.test/anthropic",
    },
  ])("prepares transport and replay from resolved auth/config: %j", async (testCase) => {
    const { input, session } = createTransportFixture(testCase);

    const result = await prepareEmbeddedAttemptTransport(input);

    expect(result.effectiveAgentTransport).toBe("sse");
    expect(session.agent.transport).toBe("sse");
    expect(result.compactionReplayEnabled).toBe(testCase.replayEnabled);
    expect(result.serverToolClearingEnabled).toBe(testCase.clearing);
  });

  describe.each([false, true])("with code mode enabled: %s", (codeModeControlsEnabled) => {
    it.each([
      { label: "foreground", toolExecutionAllow: undefined, expectedSearch: true },
      { label: "skill review", toolExecutionAllow: ["skill_workshop"], expectedSearch: false },
      { label: "explicit search", toolExecutionAllow: ["web_search"], expectedSearch: true },
      { label: "no execution", toolExecutionAllow: [], expectedSearch: false },
    ])("keeps $label authority on the provider payload", async (testCase) => {
      const { input, streamFn } = createTransportFixture({
        compaction: false,
        pruning: false,
        apiKey: "test-api-key",
      });
      input.attempt.model = {
        ...input.attempt.model,
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api",
      };
      input.attempt.modelId = input.attempt.model.id;
      input.attempt.provider = input.attempt.model.provider;
      input.attempt.toolExecutionAllow = testCase.toolExecutionAllow;
      input.attempt.config = {
        auth: { profiles: { test: { provider: "openai", mode: "oauth" } } },
        tools: { web: { search: { openaiCodex: { enabled: true } } } },
      };
      input.codeModeControlsEnabled = codeModeControlsEnabled;
      extraParamsTesting.setProviderRuntimeDepsForTest({
        wrapProviderStreamFn: ({ context }) =>
          createCodexNativeWebSearchWrapper(context.streamFn, context),
      });
      const functionTools = (
        codeModeControlsEnabled ? ["exec", "wait"] : ["read", "skill_workshop"]
      ).map((name) => ({
        type: "function",
        name,
        description: name,
        parameters: Type.Object({}),
      }));
      const payload: { tools: Array<Record<string, unknown>> } = { tools: [...functionTools] };
      const foregroundFunctionSchemas = JSON.stringify(functionTools);
      streamFn.mockImplementation(async (model, _context, options) => {
        await options?.onPayload?.(payload, model);
        return createAssistantMessageEventStream();
      });

      await prepareEmbeddedAttemptTransport(input);
      await input.session.agent.streamFn?.(
        input.attempt.model,
        { messages: [], tools: functionTools },
        {},
      );

      expect(JSON.stringify(payload.tools.filter((tool) => tool.type === "function"))).toBe(
        foregroundFunctionSchemas,
      );
      expect(payload.tools.some((tool) => tool.type === "web_search")).toBe(
        testCase.expectedSearch,
      );
    });
  });

  it("materializes native video from the prepared session agent workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transport-video-"));
    const videoPath = path.join(workspaceDir, "history.mp4");
    await fs.writeFile(videoPath, MP4);
    let providerOptions: ProviderStreamOptions | undefined;
    const providerStream = vi.fn((_model, _context, options) => {
      providerOptions = options as ProviderStreamOptions;
      return {} as never;
    });
    bindStreamLlmRuntime(providerStream, {
      streamSimple: providerStream,
      registry: { getApiProvider: () => undefined },
    } as never);
    const session = {
      agent: {
        streamFn: providerStream,
        transport: "auto",
      },
    };
    const model = {
      api: "test-api",
      provider: "test-provider",
      id: "test-model-video",
    };
    registerProviderStreamForModel.mockReturnValue(providerStream);

    try {
      await prepareEmbeddedAttemptTransport({
        attempt: {
          config: { agents: { list: [{ id: "marketing", workspace: workspaceDir }] } },
          model,
          modelId: model.id,
          provider: model.provider,
          runId: "run-native-video",
          runtimePlan: {
            auth: { forwardedAuthProfileId: undefined },
            transport: { resolveExtraParams: () => ({}) },
          },
          sessionId: "session-native-video",
        },
        session,
        settingsManager: {
          getGlobalSettings: () => ({}),
          getProjectSettings: () => ({}),
        },
        sessionAgentId: "marketing",
        workspaceDir,
        workspaceOnly: false,
        agentDir: workspaceDir,
        abortSignal: new AbortController().signal,
        getProviderRuntimeHandle: () => ({ provider: model.provider, modelId: model.id }),
        sandboxSessionKey: "agent:marketing:test",
        codeModeControlsEnabled: false,
        providerPromptState: { state: {}, effectiveContextTokenBudget: 128_000 },
      } as unknown as PrepareTransportInput);
      const message = attachRuntimePromptMediaFacts(
        castAgentMessage({ role: "user", content: [{ type: "text", text: "inspect" }] }),
        [{ kind: "video", path: videoPath, contentType: "video/mp4" }],
      );
      const context = { systemPrompt: "system", messages: [message], tools: [] };

      session.agent.streamFn(model as never, context as never, {});
      const provider = await resolveProviderContext(context as never, providerOptions);

      expect(provider.messages[0]?.content).toEqual([
        { type: "text", text: "inspect" },
        { type: "video", data: MP4.toString("base64"), mimeType: "video/mp4" },
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("records image hydration failures at the provider handoff", async () => {
    let providerOptions: ProviderStreamOptions | undefined;
    const providerStream = vi.fn((_model, _context, options) => {
      providerOptions = options as ProviderStreamOptions;
      return {} as never;
    });
    bindStreamLlmRuntime(providerStream, {
      streamSimple: providerStream,
      registry: { getApiProvider: () => undefined },
    } as never);
    const session = {
      agent: { streamFn: providerStream, transport: "auto" },
    };
    const model = { api: "test-api", provider: "test-provider", id: "test-model-image" };
    const onCurrentTurnImageFailure = vi.fn();
    registerProviderStreamForModel.mockReturnValue(providerStream);
    await prepareEmbeddedAttemptTransport({
      attempt: {
        config: {},
        model,
        modelId: model.id,
        provider: model.provider,
        runId: "run-native-image-failure",
        runtimePlan: {
          auth: { forwardedAuthProfileId: undefined },
          transport: { resolveExtraParams: () => ({}) },
        },
        sessionId: "session-native-image-failure",
      },
      session,
      settingsManager: {
        getGlobalSettings: () => ({}),
        getProjectSettings: () => ({}),
      },
      onCurrentTurnImageFailure,
      sessionAgentId: "main",
      workspaceDir: "/tmp",
      workspaceOnly: false,
      agentDir: "/tmp",
      abortSignal: new AbortController().signal,
      getProviderRuntimeHandle: () => ({ provider: model.provider, modelId: model.id }),
      sandboxSessionKey: "agent:main:test",
      codeModeControlsEnabled: false,
      providerPromptState: { state: {}, effectiveContextTokenBudget: 128_000 },
    } as unknown as PrepareTransportInput);
    const message = attachRuntimePromptMediaFacts(
      castAgentMessage({
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", data: "%%%", mimeType: "image/png" },
        ],
      }),
      [{ kind: "image" }],
      ["inline"],
    );
    const context = { systemPrompt: "system", messages: [message], tools: [] };

    session.agent.streamFn(model as never, context as never, {});
    const provider = await resolveProviderContext(context as never, providerOptions);

    expect(onCurrentTurnImageFailure).toHaveBeenCalledWith(1);
    expect(provider.messages[0]?.content).toEqual([
      { type: "text", text: "inspect" },
      {
        type: "text",
        text: expect.stringMatching(/1.*image contents.*unavailable.*resend.*not claim/is),
      },
    ]);
  });
});
