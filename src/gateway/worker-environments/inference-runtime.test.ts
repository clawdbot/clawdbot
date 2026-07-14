import { describe, expect, it, vi } from "vitest";
import type { WorkerInferenceStartParams } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { applyExtraParamsToAgent } from "../../agents/embedded-agent-runner/extra-params.js";
import type { resolveModelAsync } from "../../agents/embedded-agent-runner/model.js";
import type { resolveEmbeddedAgentStreamFn } from "../../agents/embedded-agent-runner/stream-resolution.js";
import type { loadModelCatalog } from "../../agents/model-catalog.js";
import type { registerProviderStreamForModel } from "../../agents/provider-stream.js";
import type { prepareSimpleCompletionModel } from "../../agents/simple-completion-runtime.js";
import { resolveSimpleCompletionModelResolverWorkspace } from "../../agents/simple-completion-scope.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { onTrustedInternalDiagnosticEvent } from "../../infra/diagnostic-events.js";
import type { AssistantMessage, Model, StreamFn, Usage } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import type { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  createWorkerInferenceExecutor,
  type WorkerInferenceExecutionParams,
} from "./inference-runtime.js";

type Deps = {
  applyStreamPolicy: typeof applyExtraParamsToAgent;
  loadCatalog: typeof loadModelCatalog;
  loadManifestSnapshot: typeof loadManifestMetadataSnapshot;
  prepareModel: typeof prepareSimpleCompletionModel;
  resolveModel: typeof resolveModelAsync;
  resolveProviderStream: typeof registerProviderStreamForModel;
  resolveStream: typeof resolveEmbeddedAgentStreamFn;
};
type Execution = WorkerInferenceExecutionParams;

const PROVIDER = "openai";
const MODEL = "approved-model";
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

function providerStream(message = finalMessage()) {
  const stream = createAssistantMessageEventStream();
  const fragmented = {
    ...message,
    content: [...message.content.slice(0, -1), { ...TOOL_CALL, id: "", name: "" }],
  } satisfies AssistantMessage;
  stream.push({ type: "text_delta", contentIndex: 0, delta: "Gateway response" });
  stream.push({ type: "toolcall_start", contentIndex: 1, partial: fragmented });
  stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: message });
  stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: TOOL_CALL, partial: message });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

function setup(entry: SessionEntry = sessionEntry) {
  const scope: {
    agentDir?: string;
    agentRuntime?: string;
    authProfile?: string;
    catalogWorkspace?: string;
    prepareWorkspace?: string;
    registerStream?: boolean;
  } = {};
  const resolveModel = vi.fn<Deps["resolveModel"]>(
    async (_provider, _model, _dir, _cfg, options) => {
      scope.agentRuntime = options?.agentRuntimeId;
      return {} as Awaited<ReturnType<Deps["resolveModel"]>>;
    },
  );
  const prepareModel = vi.fn<Deps["prepareModel"]>(async (modelParams) => {
    scope.prepareWorkspace = resolveSimpleCompletionModelResolverWorkspace(
      modelParams.modelResolver,
    );
    await modelParams.modelResolver?.(PROVIDER, MODEL, modelParams.agentDir, modelParams.cfg, {});
    return {
      model: logicalModel,
      auth: {
        apiKey: AUTH_MARKER,
        profileId: PROFILE,
        source: "gateway agent profile",
        mode: "api-key",
      },
    };
  });
  const stream = vi.fn<StreamFn>(() => providerStream());
  const fallbackStream = vi.fn<StreamFn>(() => providerStream());
  const loadManifestSnapshot = vi.fn(
    () => ({ plugins: [] }) as unknown as ReturnType<Deps["loadManifestSnapshot"]>,
  );
  const resolveProviderStream = vi.fn<Deps["resolveProviderStream"]>((streamParams) => {
    scope.registerStream = streamParams.registerStream;
    return stream;
  });
  const resolveStream = vi.fn<Deps["resolveStream"]>((streamParams) => {
    scope.authProfile = streamParams.authProfileId;
    return streamParams.providerStreamFn ?? streamParams.currentStreamFn ?? fallbackStream;
  });
  const applyStreamPolicy = vi.fn<Deps["applyStreamPolicy"]>(() => ({
    effectiveExtraParams: {},
  }));
  const dependencies = {
    now: vi.fn<() => number>().mockReturnValueOnce(100).mockReturnValue(125),
    resolveSessionTarget: vi.fn(() => ({
      agentId: "runtime-agent",
      sessionEntry: entry,
      sessionKey: SESSION_KEY,
      sessionStore: { [SESSION_KEY]: entry },
      storePath: "runtime-sessions.json",
    })),
    loadManifestSnapshot,
    loadCatalog: vi.fn<Deps["loadCatalog"]>(async (catalogParams) => {
      scope.agentDir = catalogParams?.agentDir;
      scope.catalogWorkspace = catalogParams?.workspaceDir;
      return [
        { provider: PROVIDER, id: MODEL, name: "Approved model" },
        { provider: PROVIDER, id: "known-but-unapproved", name: "Unapproved model" },
      ];
    }),
    resolveDefaultModel: vi.fn(() => ({ provider: PROVIDER, model: MODEL })),
    resolveSessionAuthProfile: vi.fn(async () => entry.authProfileOverride),
    resolveModel,
    prepareModel,
    resolveProviderStream,
    resolveStream,
    applyStreamPolicy,
    stream: fallbackStream,
    wrapStream: vi.fn((streamFn: StreamFn) => streamFn),
    createTrace: vi.fn(() => ({ traceId: "1".repeat(32), spanId: "2".repeat(16) })),
  };
  return {
    applyStreamPolicy,
    executor: createWorkerInferenceExecutor(dependencies),
    prepareModel,
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
      prepareWorkspace: WORKSPACE,
      registerStream: false,
    });
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
    const inferenceRequest = request();
    inferenceRequest.options.reasoning = "adaptive";

    expect(await runtime.executor(params(inferenceRequest, vi.fn()))).toMatchObject({
      type: "done",
    });
    expect(runtime.applyStreamPolicy.mock.calls[0]?.[5]).toBe("adaptive");
    expect(runtime.stream.mock.calls[0]?.[2]).toMatchObject({ reasoning: "high" });
  });
});
