import { describe, expect, it, vi } from "vitest";
import { WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  validateWorkerInferenceTerminalOutcome,
  type WorkerInferenceStartParams,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { resolveSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import type { applyExtraParamsToAgent } from "../../agents/embedded-agent-runner/extra-params.js";
import type { resolveModelAsync } from "../../agents/embedded-agent-runner/model.js";
import type { resolveEmbeddedAgentStreamFn } from "../../agents/embedded-agent-runner/stream-resolution.js";
import type {
  acquireAgentRunPreparedModelRuntime,
  PreparedModelRuntimeSnapshot,
} from "../../agents/prepared-model-runtime.js";
import type { registerProviderStreamForModel } from "../../agents/provider-stream.js";
import type { prepareSimpleCompletionModel } from "../../agents/simple-completion-runtime.js";
import { createEmptyPluginMetadataSnapshot } from "../../agents/test-helpers/embedded-agent-runner-e2e-mocks.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { onTrustedInternalDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { bindModelLlmRuntime } from "../../llm/model-runtime-binding.js";
import type { AssistantMessage, Model, StreamFn, Usage } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { getPluginRuntimeGenerationRegistry } from "../../plugins/runtime/generation-scope.js";
import {
  isWorkerTranscriptMessageFrameSafe,
  WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE,
} from "../../worker/transcript-message.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  createWorkerInferenceExecutor,
  type WorkerInferenceExecutionParams,
} from "./inference-runtime.js";
import { createWorkerToolCallStream } from "./inference-tool-call-stream.js";

type Deps = {
  applyStreamPolicy: typeof applyExtraParamsToAgent;
  acquireRuntimeLease: typeof acquireAgentRunPreparedModelRuntime;
  prepareModel: typeof prepareSimpleCompletionModel;
  resolveSessionAuthSelection: typeof resolveSessionAuthSelection;
  resolveModel: typeof resolveModelAsync;
  resolveProviderStream: typeof registerProviderStreamForModel;
  resolveStream: typeof resolveEmbeddedAgentStreamFn;
};
type Execution = WorkerInferenceExecutionParams;

const PROVIDER = "openai";
const MODEL = "gpt-5.6-sol";
const ALIAS = "fast";
const BASE_URL = "https://chatgpt.com/backend-api";
const ENDPOINT = `${BASE_URL}/codex`;
const PROFILE = ["gateway", "profile"].join("-");
const AUTH_MARKER = ["gateway", "profile", "value"].join("-");
const SESSION_ID = "session-runtime-test";
const SESSION_KEY = "agent:runtime-agent:main";
const TOOL_CALL = { type: "toolCall" as const, id: "call-1", name: "lookup", arguments: {} };
const WORKSPACE_BASE = "/gateway-workspace";
const WORKSPACE = `${WORKSPACE_BASE}/runtime-agent`;

const config = {
  agents: {
    defaults: {
      model: { primary: `${PROVIDER}/${MODEL}` },
      models: { [`${PROVIDER}/${MODEL}`]: {} },
      workspace: WORKSPACE_BASE,
    },
    list: [
      { id: "main", default: true },
      {
        id: "runtime-agent",
        models: {
          [`${PROVIDER}/${MODEL}`]: { alias: ALIAS, agentRuntime: { id: "openclaw" } },
        },
        params: { temperature: 0.1 },
      },
    ],
  },
} satisfies OpenClawConfig;
const sessionEntry: SessionEntry = {
  sessionId: SESSION_ID,
  updatedAt: 1,
  authProfileOverride: PROFILE,
  authProfileOverrideSource: "user",
};
const identity: WorkerConnectionIdentity = {
  environmentId: "environment-runtime-test",
  credentialHash: ["credential", "hash", "runtime", "test"].join("-"),
  bundleHash: "bundle-hash-runtime-test",
  sessionId: SESSION_ID,
  runId: "run-runtime-test",
  turnClaim: {
    sessionId: SESSION_ID,
    claimId: "claim-runtime-test",
    runId: "run-runtime-test",
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: "environment-runtime-test", ownerEpoch: 3 },
  },
  ownerEpoch: 3,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-inference-v1"],
  credentialExpiresAtMs: 100_000,
};
const usage: Usage = {
  input: 11,
  output: 7,
  cacheRead: 3,
  cacheWrite: 2,
  totalTokens: 23,
  cost: {
    input: 0.001,
    output: 0.002,
    cacheRead: 0.0001,
    cacheWrite: 0.0002,
    total: 0.0033,
  },
};
const logicalModel: Model = {
  id: MODEL,
  name: "Approved model",
  api: "openai-chatgpt-responses",
  provider: PROVIDER,
  baseUrl: BASE_URL,
  headers: { "x-gateway-route": "selected" },
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  contextWindow: 16_000,
  maxTokens: 1_024,
};
function request(model = ALIAS): WorkerInferenceStartParams {
  return {
    runEpoch: 3,
    sessionId: SESSION_ID,
    runId: "run-runtime-test",
    turnId: `turn-${model}`,
    modelRef: { provider: PROVIDER, model },
    context: {
      systemPrompt: "Gateway system prompt",
      messages: [{ role: "user", content: "Prepared worker context", timestamp: 10 }],
      tools: [{ name: "lookup", description: "Look up a value", parameters: { type: "object" } }],
    },
    options: {
      temperature: 0.25,
      maxTokens: 256,
      reasoning: "low",
      thinkingBudgets: { low: 96 },
    },
  };
}

function finalMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Gateway response", textSignature: "text-signature" },
      TOOL_CALL,
    ],
    api: logicalModel.api,
    provider: PROVIDER,
    model: MODEL,
    usage,
    stopReason: "stop",
    timestamp: 20,
  };
}

function providerStream(message = finalMessage(), options: { omitToolEnd?: boolean } = {}) {
  const stream = createAssistantMessageEventStream();
  const fragmented = {
    ...message,
    content: [...message.content.slice(0, -1), { ...TOOL_CALL, id: "", name: "" }],
  } satisfies AssistantMessage;
  stream.push({ type: "text_delta", contentIndex: 0, delta: "Gateway response" });
  stream.push({ type: "toolcall_start", contentIndex: 1, partial: fragmented });
  stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: message });
  if (!options.omitToolEnd) {
    stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: TOOL_CALL, partial: message });
  }
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

function setup(
  entry: SessionEntry = sessionEntry,
  options: {
    catalogOnlyModel?: boolean;
    pluginRegistry?: PluginRegistry;
    afterModelPreparation?: () => void;
    observeStage?: (
      stage: "factory" | "policy" | "wrapper" | "execution",
      registry: PluginRegistry | null | undefined,
    ) => void;
  } = {},
) {
  const scope: {
    agentDir?: string;
    agentRuntime?: string;
    authProfile?: string;
    catalogWorkspace?: string;
    preparedModelRuntime?: boolean;
    prepareWorkspace?: string;
  } = {};
  const preparedModelRuntime = {
    catalogOwner: undefined,
    agentDir: "/gateway-agent",
    activeProjectKeys: [],
    allowGatewaySubagentBinding: true,
    workspaceDir: WORKSPACE,
    config,
    authModes: {},
    metadataSnapshot: createEmptyPluginMetadataSnapshot(WORKSPACE),
    pluginRegistry: options.pluginRegistry ?? createEmptyPluginRegistry(),
    modelCatalog: {
      entries: [
        { provider: PROVIDER, id: MODEL, name: "Approved model" },
        { provider: PROVIDER, id: "known-but-unapproved", name: "Unapproved model" },
      ],
      routeVariants: [],
    },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores: () => ({ authStorage: {} as never, modelRegistry: {} as never }),
  } satisfies PreparedModelRuntimeSnapshot;
  let leasedPreparedModelRuntime: PreparedModelRuntimeSnapshot | undefined;
  const resolveModel = vi.fn<Deps["resolveModel"]>(async () => {
    return {} as Awaited<ReturnType<Deps["resolveModel"]>>;
  });
  const prepareModel = vi.fn<Deps["prepareModel"]>(async (modelParams) => {
    if (options.catalogOnlyModel && !modelParams.allowBundledStaticCatalogFallback) {
      return { error: `Unknown model: ${modelParams.provider}/${modelParams.modelId}` };
    }
    scope.agentRuntime = modelParams.agentRuntimeId;
    scope.preparedModelRuntime = modelParams.preparedModelRuntime === leasedPreparedModelRuntime;
    scope.prepareWorkspace = modelParams.workspaceDir;
    options.afterModelPreparation?.();
    return {
      model: bindModelLlmRuntime(logicalModel, {
        registry: {},
        streamSimple: fallbackStream,
      } as never),
      auth: {
        apiKey: AUTH_MARKER,
        profileId: PROFILE,
        source: "gateway agent profile",
        mode: "api-key",
      },
    };
  });
  const resolveAuthSelection = vi.fn<Deps["resolveSessionAuthSelection"]>(async () =>
    entry.authProfileOverride
      ? {
          profileId: entry.authProfileOverride,
          source: entry.authProfileOverrideSource ?? "user",
          routeRequirement: undefined,
        }
      : undefined,
  );
  const observedRegistry = () => getPluginRuntimeGenerationRegistry() ?? getActivePluginRegistry();
  const stream = vi.fn<StreamFn>(() => {
    options.observeStage?.("execution", observedRegistry());
    return providerStream();
  });
  const fallbackStream = vi.fn<StreamFn>(() => providerStream());
  const resolveProviderStream = vi.fn<Deps["resolveProviderStream"]>(() => {
    options.observeStage?.("factory", observedRegistry());
    return stream;
  });
  const resolveStream = vi.fn<Deps["resolveStream"]>((streamParams) => {
    scope.authProfile = streamParams.authProfileId;
    return streamParams.providerStreamFn ?? streamParams.currentStreamFn ?? fallbackStream;
  });
  const applyStreamPolicy = vi.fn<Deps["applyStreamPolicy"]>(() => {
    options.observeStage?.("policy", observedRegistry());
    return { effectiveExtraParams: {} };
  });
  const releaseRuntime = vi.fn();
  const acquireRuntimeLease = vi.fn<Deps["acquireRuntimeLease"]>(async (runtimeParams) => {
    scope.agentDir = runtimeParams.agentDir;
    scope.catalogWorkspace = WORKSPACE;
    const leased = { ...preparedModelRuntime, agentDir: runtimeParams.agentDir };
    leasedPreparedModelRuntime = leased;
    return {
      snapshot: leased,
      pluginGeneration: {
        configuredCatalogEntries: [],
        inlineProviderModels: [],
        pluginMetadataSnapshot: leased.metadataSnapshot,
        pluginRegistry: leased.pluginRegistry,
      },
      release: releaseRuntime,
    };
  });
  const dependencies = {
    now: vi.fn<() => number>().mockReturnValueOnce(100).mockReturnValue(125),
    resolveSessionTarget: vi.fn(() => ({
      agentId: "runtime-agent",
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      sessionStore: { [SESSION_KEY]: entry },
      storePath: "runtime-sessions.json",
    })),
    acquireRuntimeLease,
    resolveDefaultModel: vi.fn(() => ({ provider: PROVIDER, model: MODEL })),
    resolveSessionAuthSelection: resolveAuthSelection,
    resolveModel,
    prepareModel,
    resolveProviderStream,
    resolveStream,
    applyStreamPolicy,
    wrapStream: vi.fn((streamFn: StreamFn) => {
      options.observeStage?.("wrapper", observedRegistry());
      return streamFn;
    }),
    createTrace: vi.fn(() => ({ traceId: "1".repeat(32), spanId: "2".repeat(16) })),
  };
  return {
    applyStreamPolicy,
    executor: createWorkerInferenceExecutor(dependencies),
    acquireRuntimeLease,
    prepareModel,
    releaseRuntime,
    resolveAuthSelection,
    scope,
    stream,
  };
}

function params(
  inferenceRequest: WorkerInferenceStartParams,
  emit: Execution["emit"],
  runtimeConfig: OpenClawConfig = config,
): Execution {
  return {
    identity,
    request: inferenceRequest,
    signal: new AbortController().signal,
    emit,
    isCurrent: () => true,
    config: runtimeConfig,
  };
}

const MODEL_ERROR = {
  type: "error",
  reason: "model-not-approved",
  message: "Model is not approved for this agent.",
};

describe("worker inference provider runtime", () => {
  it("prepares an approved model available only from the bundled static catalog", async () => {
    const runtime = setup(sessionEntry, { catalogOnlyModel: true });

    await expect(runtime.executor(params(request(MODEL), vi.fn()))).resolves.toMatchObject({
      type: "done",
      message: { provider: PROVIDER, model: MODEL },
    });
    expect(runtime.stream).toHaveBeenCalledOnce();
    expect(runtime.releaseRuntime).toHaveBeenCalledOnce();
  });

  it("returns bounded, redacted model preparation guidance", async () => {
    const runtime = setup();
    const secret = `worker-preparation-secret-${"a".repeat(48)}`;
    runtime.prepareModel.mockResolvedValueOnce({
      error: `Auth lookup failed for provider "anthropic": configure the selected auth profile. Authorization: Bearer ${secret}. ${"diagnostic ".repeat(40)}`,
    });

    const outcome = await runtime.executor(params(request(), vi.fn()));

    expect(outcome).toMatchObject({ type: "error", reason: "provider-error" });
    if (outcome.type !== "error") {
      throw new Error("expected model preparation to fail");
    }
    expect(outcome.message).toContain("configure the selected auth profile");
    expect(outcome.message).not.toContain(secret);
    expect(outcome.message.length).toBeLessThanOrEqual(256);
    expect(validateWorkerInferenceTerminalOutcome(outcome)).toBe(true);
    expect(runtime.stream).not.toHaveBeenCalled();
    expect(runtime.releaseRuntime).toHaveBeenCalledOnce();
  });

  it("keeps provider construction and execution on the leased generation", async () => {
    const generationA = createEmptyPluginRegistry();
    const generationB = createEmptyPluginRegistry();
    const observed: string[] = [];
    const runtime = setup(sessionEntry, {
      pluginRegistry: generationA,
      afterModelPreparation: () =>
        setActivePluginRegistry(generationB, "worker-generation-b", "default", WORKSPACE),
      observeStage: (stage, registry) =>
        observed.push(
          `${stage}:${registry === generationA ? "A" : registry === generationB ? "B" : "none"}`,
        ),
    });

    try {
      await expect(runtime.executor(params(request(), vi.fn()))).resolves.toMatchObject({
        type: "done",
      });
    } finally {
      resetPluginRuntimeStateForTest();
    }

    expect(observed).toEqual(["factory:A", "policy:A", "wrapper:A", "execution:A"]);
    expect(runtime.releaseRuntime).toHaveBeenCalledOnce();
  });

  it("projects the gateway-owned auth profile onto the provider route", async () => {
    const oauthRuntime = setup();
    oauthRuntime.resolveAuthSelection.mockResolvedValue({
      profileId: PROFILE,
      source: "user",
      routeRequirement: "subscription",
    });
    await oauthRuntime.executor(params(request(), vi.fn()));
    const oauth = oauthRuntime.prepareModel.mock.calls[0]?.[0].cfg ?? {};

    const apiKeyRuntime = setup();
    apiKeyRuntime.resolveAuthSelection.mockResolvedValue({
      profileId: PROFILE,
      source: "user",
      routeRequirement: "api-key",
    });
    await apiKeyRuntime.executor(params(request(), vi.fn()));
    const apiKey = apiKeyRuntime.prepareModel.mock.calls[0]?.[0].cfg ?? {};

    expect(oauth.models?.providers?.openai).toMatchObject({
      auth: "oauth",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    expect(apiKey.models?.providers?.openai).toMatchObject({
      auth: "api-key",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("prepares the selected model against its gateway-owned OAuth route", async () => {
    const runtime = setup();
    runtime.resolveAuthSelection.mockResolvedValue({
      profileId: PROFILE,
      source: "user",
      routeRequirement: "subscription",
    });

    await expect(runtime.executor(params(request(), vi.fn()))).resolves.toMatchObject({
      type: "done",
    });

    expect(runtime.prepareModel.mock.calls[0]?.[0].cfg?.models?.providers?.openai).toMatchObject({
      auth: "oauth",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });

  it("pins an automatic profile to the route projected from that profile", async () => {
    const runtime = setup({
      ...sessionEntry,
      authProfileOverrideSource: "auto",
      authProfileOverrideCompactionCount: 1,
    });
    runtime.resolveAuthSelection.mockResolvedValue({
      profileId: PROFILE,
      source: "auto",
      routeRequirement: "subscription",
    });

    await expect(runtime.executor(params(request(), vi.fn()))).resolves.toMatchObject({
      type: "done",
    });

    expect(runtime.prepareModel).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: PROFILE,
        preferredProfile: PROFILE,
        bindAuthOwner: true,
      }),
    );
  });

  it("keeps approved alias routing, endpoint, headers, and auth gateway-owned", async () => {
    const runtime = setup();
    const emitted: Parameters<Execution["emit"]>[0][] = [];
    const usageEvents: unknown[] = [];
    const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
      if (event.type === "model.usage" && event.sessionId === SESSION_ID) {
        usageEvents.push(event);
      }
    });
    const inferenceRequest = request();
    const execution = params(inferenceRequest, (event) => emitted.push(event));
    const outcome = await runtime.executor(execution).finally(unsubscribe);

    expect(runtime.releaseRuntime).toHaveBeenCalledOnce();

    expect(runtime.prepareModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: MODEL,
        profileId: PROFILE,
        bindAuthOwner: true,
        cfg: config,
      }),
    );
    const prepared = runtime.prepareModel.mock.calls[0]?.[0];
    expect(runtime.scope).toEqual({
      agentDir: prepared?.agentDir,
      agentRuntime: "openclaw",
      authProfile: PROFILE,
      catalogWorkspace: WORKSPACE,
      preparedModelRuntime: true,
      prepareWorkspace: WORKSPACE,
    });
    expect(runtime.acquireRuntimeLease).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "runtime-agent",
      }),
    );
    const [streamModel, streamContext, streamOptions] = runtime.stream.mock.calls[0] ?? [];
    expect(streamModel).toMatchObject({ baseUrl: ENDPOINT });
    expect(streamContext?.messages).toEqual(inferenceRequest.context.messages);
    expect(streamOptions).toEqual({
      ...inferenceRequest.options,
      signal: expect.any(AbortSignal),
      sessionId: SESSION_ID,
      apiKey: AUTH_MARKER,
    });
    expect(emitted.map((event) => event.type)).toEqual([
      "text_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
    ]);
    expect(emitted).toContainEqual({
      type: "toolcall_start",
      contentIndex: 1,
      id: TOOL_CALL.id,
      toolName: TOOL_CALL.name,
    });
    expect(outcome).toMatchObject({
      type: "done",
      message: {
        api: logicalModel.api,
        provider: PROVIDER,
        model: MODEL,
        usage,
      },
    });
    const outbound = JSON.stringify({ emitted, outcome });
    for (const privateValue of [BASE_URL, ENDPOINT, AUTH_MARKER, "x-gateway-route"]) {
      expect(outbound).not.toContain(privateValue);
    }
    expect(usageEvents).toEqual([
      expect.objectContaining({
        channel: "worker",
        durationMs: 25,
        provider: PROVIDER,
        model: MODEL,
      }),
    ]);
  });

  it("closes provider tool calls from the authoritative terminal message", async () => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => providerStream(finalMessage(), { omitToolEnd: true }));
    const emitted: Parameters<Execution["emit"]>[0][] = [];

    await expect(
      runtime.executor(params(request(), (event) => emitted.push(event))),
    ).resolves.toMatchObject({
      type: "done",
    });
    expect(emitted.map((event) => event.type)).toEqual([
      "text_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
    ]);
  });

  it("projects provider terminal messages onto the closed worker schema", async () => {
    const runtime = setup();
    const message = finalMessage();
    message.providerReplay = {
      v: 1,
      type: "openai-responses-compaction",
      id: "cmp_worker_terminal",
      data: "opaque-worker-terminal",
      replayIndex: 1,
      provider: "openai",
      api: "openai-responses",
      model: MODEL,
      baseUrlHash: "ozhevd1smnk8s",
      sessionHash: "171dzdv17gum5g",
      authProfileHash: "oe8bkr3r8947",
    };
    Object.assign(message.content[0]!, { providerScratch: "text-state" });
    Object.assign(message.content[1]!, { partialArgs: "{}", streamIndex: 0 });
    Object.assign(message.usage, { providerScratch: { requestId: "private" } });
    Object.assign(message.providerReplay, { providerScratch: "private" });
    runtime.stream.mockImplementation(() => providerStream(message));

    const outcome = await runtime.executor(params(request(), vi.fn()));

    expect(validateWorkerInferenceTerminalOutcome(outcome)).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("providerScratch");
    expect(JSON.stringify(outcome)).not.toContain("partialArgs");
    expect(JSON.stringify(outcome)).not.toContain("streamIndex");
    expect(outcome).toMatchObject({
      type: "done",
      message: {
        providerReplay: {
          type: "openai-responses-compaction",
          data: "opaque-worker-terminal",
          replayIndex: 1,
          sessionHash: "171dzdv17gum5g",
          authProfileHash: "oe8bkr3r8947",
        },
      },
    });
  });

  it("returns a typed error when authoritative replay cannot be persisted", async () => {
    const runtime = setup();
    const message = finalMessage();
    message.providerReplay = {
      v: 1,
      type: "openai-responses-compaction",
      data: "x".repeat(WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES + 1),
      provider: "openai",
      api: "openai-responses",
      model: MODEL,
    };
    runtime.stream.mockImplementation(() => providerStream(message));
    const payloadEvents: unknown[] = [];
    const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
      if (event.type === "payload.large" && event.surface === "worker.provider-replay") {
        payloadEvents.push(event);
      }
    });

    const outcome = await runtime.executor(params(request(), vi.fn())).finally(unsubscribe);

    expect(outcome).toMatchObject({
      type: "error",
      reason: "provider-error",
      message: WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE,
      usage: message.usage,
    });
    expect(payloadEvents).toEqual([
      expect.objectContaining({
        type: "payload.large",
        surface: "worker.provider-replay",
        action: "rejected",
        bytes: WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES + 1,
        limitBytes: WORKER_PROVIDER_REPLAY_MAX_DATA_BYTES,
        reason: "provider-replay-data-budget",
      }),
    ]);
    expect(JSON.stringify(payloadEvents)).not.toContain(message.providerReplay.data);
  });

  it("keeps a maximum fitting replay exact through the terminal projection", async () => {
    const runtime = setup();
    const message = finalMessage();
    const ciphertext = `cipher-${"x".repeat(60 * 1024)}-€`;
    message.providerReplay = {
      v: 1,
      type: "openai-responses-compaction",
      data: ciphertext,
      provider: "openai",
      api: "openai-responses",
      model: MODEL,
    };
    runtime.stream.mockImplementation(() => providerStream(message));

    const outcome = await runtime.executor(params(request(), vi.fn()));

    expect(outcome.type).toBe("done");
    if (outcome.type !== "done") {
      throw new Error("expected successful worker inference");
    }
    expect(outcome.message.providerReplay?.data).toBe(ciphertext);
    expect(isWorkerTranscriptMessageFrameSafe(outcome.message)).toBe(true);
  });

  it("rejects an incomplete final argument stream", async () => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const message = finalMessage();
      const completeToolCall = { ...TOOL_CALL, arguments: { query: "alpha" } };
      message.content = [...message.content.slice(0, -1), completeToolCall];
      stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
      stream.push({
        type: "toolcall_delta",
        contentIndex: 1,
        delta: '{"query":',
        partial: message,
      });
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    });
    const emitted: Parameters<Execution["emit"]>[0][] = [];

    await expect(
      runtime.executor(params(request(), (event) => emitted.push(event))),
    ).resolves.toMatchObject({ type: "error", reason: "provider-error" });
    expect(
      emitted.flatMap((event) => (event.type === "toolcall_delta" ? [event.delta] : [])),
    ).toEqual(['{"query":']);
    expect(emitted.some((event) => event.type === "toolcall_end")).toBe(false);
  });

  it("rejects a terminal tool call whose identity changed", async () => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const partial = finalMessage();
      const terminal = finalMessage();
      terminal.content = [...terminal.content.slice(0, -1), { ...TOOL_CALL, id: "call-2" }];
      stream.push({ type: "toolcall_start", contentIndex: 1, partial });
      stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial });
      stream.push({ type: "done", reason: "toolUse", message: terminal });
      return stream;
    });
    const emitted: Parameters<Execution["emit"]>[0][] = [];

    await expect(
      runtime.executor(params(request(), (event) => emitted.push(event))),
    ).resolves.toMatchObject({ type: "error", reason: "provider-error" });
    expect(emitted.some((event) => event.type === "toolcall_end")).toBe(false);
  });

  it("revalidates a normally ended tool call against the terminal message", async () => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const partial = finalMessage();
      const terminal = finalMessage();
      terminal.content = [...terminal.content.slice(0, -1), { ...TOOL_CALL, id: "call-2" }];
      stream.push({ type: "toolcall_start", contentIndex: 1, partial });
      stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial });
      stream.push({
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: TOOL_CALL,
        partial,
      });
      stream.push({ type: "done", reason: "toolUse", message: terminal });
      return stream;
    });

    await expect(runtime.executor(params(request(), vi.fn()))).resolves.toMatchObject({
      type: "error",
      reason: "provider-error",
    });
  });

  it("rejects tool-call deltas after the end event", async () => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const message = finalMessage();
      stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
      stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: message });
      stream.push({
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: TOOL_CALL,
        partial: message,
      });
      stream.push({ type: "toolcall_delta", contentIndex: 1, delta: " ", partial: message });
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    });
    const emitted: Parameters<Execution["emit"]>[0][] = [];

    await expect(
      runtime.executor(params(request(), (event) => emitted.push(event))),
    ).resolves.toMatchObject({ type: "error", reason: "provider-error" });
    expect(
      emitted.flatMap((event) => (event.type === "toolcall_delta" ? [event.delta] : [])),
    ).toEqual(["{}"]);
  });

  it("rejects a normally ended tool call omitted from the terminal message", async () => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const partial = finalMessage();
      const terminal = finalMessage();
      terminal.content = terminal.content.slice(0, 1);
      stream.push({ type: "toolcall_start", contentIndex: 1, partial });
      stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial });
      stream.push({
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: TOOL_CALL,
        partial,
      });
      stream.push({ type: "done", reason: "stop", message: terminal });
      return stream;
    });

    await expect(runtime.executor(params(request(), vi.fn()))).resolves.toMatchObject({
      type: "error",
      reason: "provider-error",
    });
  });

  it("rejects unresolved pre-identity tool deltas omitted from the terminal message", async () => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const terminal = finalMessage();
      terminal.content = terminal.content.slice(0, 1);
      const partial = {
        ...terminal,
        content: [...terminal.content, { ...TOOL_CALL, id: "", name: "" }],
      } satisfies AssistantMessage;
      stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial });
      stream.push({ type: "done", reason: "stop", message: terminal });
      return stream;
    });

    await expect(runtime.executor(params(request(), vi.fn()))).resolves.toMatchObject({
      type: "error",
      reason: "provider-error",
    });
  });

  it("rejects retained tool arguments above the stream bound", async () => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const partial = finalMessage();
      stream.push({ type: "toolcall_start", contentIndex: 1, partial });
      stream.push({
        type: "toolcall_delta",
        contentIndex: 1,
        delta: "x".repeat(1024 * 1024 + 1),
        partial,
      });
      stream.push({ type: "done", reason: "toolUse", message: partial });
      return stream;
    });
    const emitted: Parameters<Execution["emit"]>[0][] = [];

    await expect(
      runtime.executor(params(request(), (event) => emitted.push(event))),
    ).resolves.toMatchObject({ type: "error", reason: "provider-error" });
    expect(emitted.map((event) => event.type)).toEqual(["toolcall_start"]);
  });

  it("accepts valid tool arguments split across many small fragments", async () => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const message = finalMessage();
      stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
      for (let index = 0; index < 4096; index += 1) {
        stream.push({ type: "toolcall_delta", contentIndex: 1, delta: " ", partial: message });
      }
      stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: message });
      stream.push({ type: "done", reason: "toolUse", message });
      return stream;
    });

    await expect(runtime.executor(params(request(), vi.fn()))).resolves.toMatchObject({
      type: "done",
    });
  });

  it("bounds nonempty streamed argument work and ignores empty fragments", () => {
    const message = finalMessage();
    let emitted = 0;
    const toolCalls = createWorkerToolCallStream({
      emit: () => {
        emitted += 1;
      },
      isCurrent: () => true,
    });
    expect(toolCalls.start(1, message)).toBe("ok");
    expect(toolCalls.delta(1, "", message)).toBe("ok");
    for (let index = 0; index < 64 * 1024 - 1; index += 1) {
      expect(toolCalls.delta(1, " ", message)).toBe("ok");
    }

    expect(toolCalls.delta(1, " ", message)).toBe("invalid");
    expect(emitted).toBe(64 * 1024);
  });

  it("synthesizes canonical arguments after deferred provider deltas", () => {
    const complete = { ...TOOL_CALL, arguments: { env: { NODE_ENV: "test" } } };
    const message = finalMessage();
    message.content = [...message.content.slice(0, -1), complete];
    const emitted: Parameters<Execution["emit"]>[0][] = [];
    const toolCalls = createWorkerToolCallStream({
      emit: (event) => emitted.push(event),
      isCurrent: () => true,
    });

    expect(toolCalls.start(1, message)).toBe("ok");
    expect(toolCalls.delta(1, "", message)).toBe("ok");
    expect(toolCalls.end(1, message, complete)).toBe("ok");
    expect(emitted).toEqual([
      { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "lookup" },
      {
        type: "toolcall_delta",
        contentIndex: 1,
        delta: '{"env":{"NODE_ENV":"test"}}',
      },
      { type: "toolcall_end", contentIndex: 1 },
    ]);
  });

  it("fences terminal tool-call synthesis after owner rotation", async () => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => providerStream(finalMessage(), { omitToolEnd: true }));
    const emitted: Parameters<Execution["emit"]>[0][] = [];
    let current = true;
    const execution = params(request(), (event) => {
      emitted.push(event);
      if (event.type === "toolcall_delta") {
        current = false;
      }
    });
    execution.isCurrent = () => current;

    await expect(runtime.executor(execution)).resolves.toMatchObject({
      type: "error",
      reason: "cancelled",
    });
    expect(emitted.map((event) => event.type)).toEqual([
      "text_delta",
      "toolcall_start",
      "toolcall_delta",
    ]);
  });

  it("stops terminal synthesis when its start event rotates ownership", async () => {
    const runtime = setup();
    runtime.stream.mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const message = finalMessage();
      const fragmented = {
        ...message,
        content: [...message.content.slice(0, -1), { ...TOOL_CALL, id: "", name: "" }],
      } satisfies AssistantMessage;
      stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: fragmented });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    });
    const emitted: Parameters<Execution["emit"]>[0][] = [];
    let current = true;
    const execution = params(request(), (event) => {
      emitted.push(event);
      if (event.type === "toolcall_start") {
        current = false;
      }
    });
    execution.isCurrent = () => current;

    await expect(runtime.executor(execution)).resolves.toMatchObject({
      type: "error",
      reason: "cancelled",
    });
    expect(emitted.map((event) => event.type)).toEqual(["toolcall_start"]);
  });

  it("records usage before rejecting a dangling streamed tool call", async () => {
    const runtime = setup();
    const terminal = finalMessage();
    terminal.content = terminal.content.slice(0, 1);
    runtime.stream.mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const partial = finalMessage();
      stream.push({ type: "toolcall_start", contentIndex: 1, partial });
      stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial });
      stream.push({ type: "done", reason: "stop", message: terminal });
      return stream;
    });
    const usageEvents: unknown[] = [];
    const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
      if (event.type === "model.usage" && event.sessionId === SESSION_ID) {
        usageEvents.push(event);
      }
    });

    await expect(
      runtime.executor(params(request(), vi.fn())).finally(unsubscribe),
    ).resolves.toMatchObject({
      type: "error",
      reason: "provider-error",
    });
    expect(usageEvents).toHaveLength(1);
  });

  it("rejects unknown, unapproved, and profile-qualified refs", async () => {
    const runtime = setup();
    const emit = vi.fn<Execution["emit"]>();
    for (const ref of ["missing-model", "known-but-unapproved", `${ALIAS}@worker-profile`]) {
      expect(await runtime.executor(params(request(ref), emit))).toEqual(MODEL_ERROR);
    }
  });

  it("projects worker options before applying provider stream policy", async () => {
    const runtime = setup();
    const inferenceRequest = request();
    Object.assign(inferenceRequest.options, {
      extra_body: { mode: "worker" },
      transport: "sse",
      response_format: { type: "json_object" },
    });

    expect(await runtime.executor(params(inferenceRequest, vi.fn()))).toMatchObject({
      type: "done",
    });
    expect(runtime.applyStreamPolicy.mock.calls[0]?.[4]).toEqual({
      temperature: 0.25,
      maxTokens: 256,
      reasoning: "low",
      thinkingBudgets: { low: 96 },
    });
  });

  it("preserves adaptive provider policy while lowering the core stream effort", async () => {
    const runtime = setup();
    const baseRequest = request();
    const inferenceRequest = {
      ...baseRequest,
      options: { ...baseRequest.options, reasoning: "adaptive" as const },
    };

    expect(await runtime.executor(params(inferenceRequest, vi.fn()))).toMatchObject({
      type: "done",
    });
    expect(runtime.applyStreamPolicy.mock.calls[0]?.[5]).toBe("adaptive");
    expect(runtime.stream.mock.calls[0]?.[2]).toMatchObject({ reasoning: "high" });
  });
});
