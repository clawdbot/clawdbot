// Settlement liveness: a wedged block-reply flush must not park the turn.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveProviderContext,
  type ProviderStreamOptions,
} from "../../../../packages/ai/src/provider-types.js";
import { bindStreamLlmRuntime } from "../../../llm/model-runtime-binding.js";
import { attachRuntimePromptMediaFacts } from "../../../media/media-facts.js";
import { SessionManager } from "../../sessions/index.js";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import { testing as extraParamsTesting } from "../extra-params.test-support.js";
import { RUN_LIVENESS_JOIN_TIMEOUT_MS } from "./abortable.js";
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
    nestedToolActivities: [],
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
  beforeEach(() => {
    // These cases own prepared auth/config, not runtime plugin discovery.
    extraParamsTesting.setProviderRuntimeDepsForTest({ wrapProviderStreamFn: () => undefined });
  });
  afterEach(() => {
    extraParamsTesting.resetProviderRuntimeDepsForTest();
    registerProviderStreamForModel.mockReset();
  });

  it.each([
    { compaction: true, apiKey: "test-api-key", replayEnabled: true },
    { compaction: true, apiKey: "test-sk-ant-oat-oauth", replayEnabled: false },
    { compaction: false, apiKey: "test-api-key", replayEnabled: false },
  ])("prepares transport and replay from resolved auth/config: %j", async (testCase) => {
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
          api: "anthropic-messages",
          provider: "anthropic",
          id: "claude-sonnet-4-6",
          baseUrl: "https://api.anthropic.com",
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

    const result = await prepareEmbeddedAttemptTransport(input);

    expect(result.effectiveAgentTransport).toBe("sse");
    expect(session.agent.transport).toBe("sse");
    expect(result.compactionReplayEnabled).toBe(testCase.replayEnabled);
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
