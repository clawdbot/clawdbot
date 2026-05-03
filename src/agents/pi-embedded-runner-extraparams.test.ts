import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as extraParamsTesting } from "./pi-embedded-runner/extra-params.js";

vi.mock("../plugins/provider-hook-runtime.js", () => ({
  __testing: {
    buildHookProviderCacheKey: () => "test-provider-hook-cache-key",
  },
  prepareProviderExtraParams: () => undefined,
  resolveProviderExtraParamsForTransport: () => undefined,
  wrapProviderStreamFn: (params: { context: { streamFn?: StreamFn } }) => params.context.streamFn,
}));

vi.mock("./codex-native-web-search.js", () => ({
  patchCodexNativeWebSearchPayload: (params: {
    payload: unknown;
    config?: {
      tools?: {
        web?: {
          search?: {
            openaiCodex?: {
              mode?: string;
              allowedDomains?: string[];
            };
          };
        };
      };
    };
  }) => {
    if (!params.payload || typeof params.payload !== "object") {
      return { status: "payload_not_object" };
    }
    const payload = params.payload as { tools?: Array<Record<string, unknown>> };
    if (payload.tools?.some((tool) => tool.type === "web_search")) {
      return { status: "native_tool_already_present" };
    }
    const nativeConfig = params.config?.tools?.web?.search?.openaiCodex;
    payload.tools = [
      ...(payload.tools ?? []),
      {
        type: "web_search",
        external_web_access: nativeConfig?.mode === "live",
        ...(nativeConfig?.allowedDomains
          ? { filters: { allowed_domains: nativeConfig.allowedDomains } }
          : {}),
      },
    ];
    return { status: "injected" };
  },
  resolveCodexNativeSearchActivation: (params: {
    config?: {
      auth?: { profiles?: Record<string, { provider?: string }> };
      tools?: {
        web?: {
          search?: {
            enabled?: boolean;
            openaiCodex?: { enabled?: boolean; mode?: string };
          };
        };
      };
    };
    modelProvider?: string;
    modelApi?: string;
  }) => {
    const search = params.config?.tools?.web?.search;
    const codex = search?.openaiCodex;
    const nativeEligible =
      params.modelProvider === "openai-codex" || params.modelApi === "openai-codex-responses";
    const hasRequiredAuth =
      params.modelProvider !== "openai-codex" ||
      Object.values(params.config?.auth?.profiles ?? {}).some(
        (profile) => profile.provider === "openai-codex",
      );
    const active =
      search?.enabled !== false && codex?.enabled === true && nativeEligible && hasRequiredAuth;
    return {
      globalWebSearchEnabled: search?.enabled !== false,
      codexNativeEnabled: codex?.enabled === true,
      codexMode: codex?.mode === "live" ? "live" : "cached",
      nativeEligible,
      hasRequiredAuth,
      state: active ? "native_active" : "managed_only",
      ...(active ? {} : { inactiveReason: "test_inactive" }),
    };
  },
}));

const ANTHROPIC_DEFAULT_BETAS = [
  "fine-grained-tool-streaming-2025-05-14",
  "interleaved-thinking-2025-05-14",
];
const ANTHROPIC_CONTEXT_1M_BETA = "context-1m-2025-08-07";
const ANTHROPIC_OAUTH_BETAS = ["oauth-2025-04-20", "claude-code-20250219"];

const XAI_FAST_MODEL_IDS = new Map<string, string>([
  ["grok-3", "grok-3-fast"],
  ["grok-3-mini", "grok-3-mini-fast"],
  ["grok-4", "grok-4-fast"],
  ["grok-4-0709", "grok-4-fast"],
]);

function createTestXaiFastModeWrapper(
  baseStreamFn: StreamFn | undefined,
  fastMode: boolean,
): StreamFn {
  return (model, context, options) => {
    if (!fastMode || model.api !== "openai-completions" || model.provider !== "xai") {
      return (
        baseStreamFn ??
        (() => {
          throw new Error("missing stream function");
        })
      )(model, context, options);
    }

    const fastModelId = XAI_FAST_MODEL_IDS.get(model.id.trim());
    return (
      baseStreamFn ??
      (() => {
        throw new Error("missing stream function");
      })
    )(fastModelId ? { ...model, id: fastModelId } : model, context, options);
  };
}

function stripTestXaiUnsupportedStrictFlag(tool: unknown): unknown {
  if (!tool || typeof tool !== "object") {
    return tool;
  }
  const toolObj = tool as Record<string, unknown>;
  const fn = toolObj.function;
  if (!fn || typeof fn !== "object") {
    return tool;
  }
  const fnObj = fn as Record<string, unknown>;
  if (typeof fnObj.strict !== "boolean") {
    return tool;
  }
  const nextFunction = { ...fnObj };
  delete nextFunction.strict;
  return { ...toolObj, function: nextFunction };
}

function createTestXaiPayloadCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  return (model, context, options) => {
    const underlying =
      baseStreamFn ??
      (() => {
        throw new Error("missing stream function");
      });
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (Array.isArray(payloadObj.tools)) {
            payloadObj.tools = payloadObj.tools.map((tool) =>
              stripTestXaiUnsupportedStrictFlag(tool),
            );
          }
          delete payloadObj.reasoning;
          delete payloadObj.reasoningEffort;
          delete payloadObj.reasoning_effort;
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

function createTestToolStreamWrapper(
  baseStreamFn: StreamFn | undefined,
  enabled: boolean,
): StreamFn {
  return (model, context, options) => {
    const underlying =
      baseStreamFn ??
      (() => {
        throw new Error("missing stream function");
      });
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (enabled && payload && typeof payload === "object") {
          (payload as Record<string, unknown>).tool_stream = true;
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

function resolveAnthropicBetas(
  extraParams: Record<string, unknown> | undefined,
  modelId: string,
): string[] {
  const configuredBetas = Array.isArray(extraParams?.anthropicBeta)
    ? extraParams.anthropicBeta.filter((value): value is string => typeof value === "string")
    : [];
  if (!extraParams?.context1m || !/(opus|sonnet)/i.test(modelId)) {
    return configuredBetas;
  }
  return [...ANTHROPIC_DEFAULT_BETAS, ...configuredBetas, ANTHROPIC_CONTEXT_1M_BETA];
}

function resolveAnthropicServiceTier(extraParams: Record<string, unknown> | undefined) {
  const serviceTier = extraParams?.service_tier ?? extraParams?.serviceTier;
  return serviceTier === "auto" || serviceTier === "standard_only" ? serviceTier : undefined;
}

function resolveAnthropicFastMode(extraParams: Record<string, unknown> | undefined) {
  return typeof extraParams?.fastMode === "boolean" ? extraParams.fastMode : undefined;
}

function isAnthropicOauthApiKey(apiKey: unknown): boolean {
  return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

function isDirectAnthropicModel(model: { provider?: string; baseUrl?: string }): boolean {
  const baseUrl = typeof model.baseUrl === "string" ? model.baseUrl : "";
  return model.provider === "anthropic" && (!baseUrl || baseUrl.includes("api.anthropic.com"));
}

function createAnthropicBetaHeadersWrapper(baseStreamFn: StreamFn | undefined, betas: string[]) {
  const underlying = baseStreamFn ?? (() => ({}) as ReturnType<StreamFn>);
  return ((model, context, options) => {
    const nextBetas = isAnthropicOauthApiKey(options?.apiKey)
      ? [...ANTHROPIC_OAUTH_BETAS, ...betas.filter((beta) => beta !== ANTHROPIC_CONTEXT_1M_BETA)]
      : betas;
    const existingBeta =
      typeof options?.headers?.["anthropic-beta"] === "string"
        ? options.headers["anthropic-beta"]
        : "";
    const betaHeader = [...(existingBeta ? [existingBeta] : []), ...nextBetas].join(",");
    return underlying(model, context, {
      ...options,
      headers: {
        ...options?.headers,
        ...(betaHeader ? { "anthropic-beta": betaHeader } : {}),
      },
    });
  }) as StreamFn;
}

function createAnthropicServiceTierWrapper(
  baseStreamFn: StreamFn | undefined,
  serviceTier: string,
) {
  const underlying = baseStreamFn ?? (() => ({}) as ReturnType<StreamFn>);
  return ((model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (
          payload &&
          typeof payload === "object" &&
          isDirectAnthropicModel(model) &&
          !isAnthropicOauthApiKey(options?.apiKey)
        ) {
          const payloadObj = payload as Record<string, unknown>;
          payloadObj.service_tier ??= serviceTier;
        }
        return originalOnPayload?.(payload, model);
      },
    });
  }) as StreamFn;
}

function createAnthropicFastModeWrapper(baseStreamFn: StreamFn | undefined, fastMode: boolean) {
  return createAnthropicServiceTierWrapper(baseStreamFn, fastMode ? "auto" : "standard_only");
}

import { createAnthropicToolPayloadCompatibilityWrapper } from "./pi-embedded-runner/anthropic-family-tool-payload-compat.js";
import {
  createBedrockNoCacheWrapper,
  isAnthropicBedrockModel,
} from "./pi-embedded-runner/bedrock-stream-wrappers.js";
import {
  applyExtraParamsToAgent,
  resolveAgentTransportOverride,
  resolveExplicitSettingsTransport,
  resolvePreparedExtraParams,
} from "./pi-embedded-runner/extra-params.js";
import { createGoogleThinkingPayloadWrapper } from "./pi-embedded-runner/google-stream-wrappers.js";
import { log } from "./pi-embedded-runner/logger.js";
import { createMinimaxFastModeWrapper } from "./pi-embedded-runner/minimax-stream-wrappers.js";
import {
  createCodexNativeWebSearchWrapper,
  createOpenAIAttributionHeadersWrapper,
  createOpenAIDefaultTransportWrapper,
  createOpenAIFastModeWrapper,
  createOpenAIReasoningCompatibilityWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIServiceTierWrapper,
  createOpenAIStringContentWrapper,
  createOpenAITextVerbosityWrapper,
  createOpenAIThinkingLevelWrapper,
  resolveOpenAIFastMode,
  resolveOpenAIServiceTier,
  resolveOpenAITextVerbosity,
} from "./pi-embedded-runner/openai-stream-wrappers.js";

type WrapProviderStreamFnParams = Parameters<
  typeof import("../plugins/provider-hook-runtime.js").wrapProviderStreamFn
>[0];

function installFullProviderRuntimeDepsForTest() {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: (params) => {
      if (params.provider !== "openai-codex") {
        return undefined;
      }
      const transport = params.context.extraParams?.transport;
      if (transport === "auto" || transport === "sse" || transport === "websocket") {
        return params.context.extraParams;
      }
      return {
        ...params.context.extraParams,
        transport: "auto",
      };
    },
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: (params) => {
      if (params.provider === "openai") {
        return createTestOpenAIProviderWrapper(params, true);
      }
      if (params.provider === "openai-codex") {
        return createTestOpenAIProviderWrapper(params, false);
      }
      if (params.provider === "azure-openai" || params.provider === "azure-openai-responses") {
        return createTestOpenAIProviderWrapper(params, false);
      }
      if (params.provider === "amazon-bedrock") {
        return isAnthropicBedrockModel(params.context.modelId)
          ? params.context.streamFn
          : createBedrockNoCacheWrapper(params.context.streamFn);
      }
      if (params.provider === "google") {
        return createGoogleThinkingPayloadWrapper(
          params.context.streamFn,
          params.context.thinkingLevel,
        );
      }
      if (params.provider === "test-anthropic-tool-compat") {
        return createAnthropicToolPayloadCompatibilityWrapper(params.context.streamFn, {
          toolSchemaMode: "openai-functions",
          toolChoiceMode: "openai-string-modes",
        });
      }
      if (params.provider === "kimi") {
        return params.context.streamFn;
      }
      if (params.provider === "minimax" || params.provider === "minimax-portal") {
        return createMinimaxFastModeWrapper(
          params.context.streamFn,
          params.context.extraParams?.fastMode === true,
        );
      }
      if (params.provider === "xai") {
        let streamFn = createTestXaiPayloadCompatibilityWrapper(params.context.streamFn);
        streamFn = createTestXaiFastModeWrapper(
          streamFn,
          params.context.extraParams?.fastMode === true,
        );
        return createTestToolStreamWrapper(
          streamFn,
          params.context.extraParams?.tool_stream !== false,
        );
      }
      if (params.provider === "anthropic") {
        let streamFn = params.context.streamFn;
        const anthropicBetas = resolveAnthropicBetas(
          params.context.extraParams,
          params.context.modelId,
        );
        if (anthropicBetas?.length) {
          streamFn = createAnthropicBetaHeadersWrapper(streamFn, anthropicBetas);
        }
        const serviceTier = resolveAnthropicServiceTier(params.context.extraParams);
        if (serviceTier) {
          streamFn = createAnthropicServiceTierWrapper(streamFn, serviceTier);
        }
        const fastMode = resolveAnthropicFastMode(params.context.extraParams);
        if (fastMode !== undefined) {
          streamFn = createAnthropicFastModeWrapper(streamFn, fastMode);
        }
        return streamFn;
      }
      return params.context.streamFn;
    },
  });
}

function withMinimalProviderRuntimeDepsForTest<T>(run: () => T): T {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: () => undefined,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: (params) => params.context.streamFn,
  });
  try {
    return run();
  } finally {
    installFullProviderRuntimeDepsForTest();
  }
}

function createTestOpenAIProviderWrapper(
  params: WrapProviderStreamFnParams,
  withDefaultTransport: boolean,
): StreamFn {
  let streamFn = params.context.streamFn;
  if (withDefaultTransport) {
    streamFn = createOpenAIDefaultTransportWrapper(streamFn);
  }
  streamFn = createOpenAIAttributionHeadersWrapper(streamFn);

  if (resolveOpenAIFastMode(params.context.extraParams)) {
    streamFn = createOpenAIFastModeWrapper(streamFn);
  }

  const serviceTier = resolveOpenAIServiceTier(params.context.extraParams);
  if (serviceTier) {
    streamFn = createOpenAIServiceTierWrapper(streamFn, serviceTier);
  }

  const textVerbosity = resolveOpenAITextVerbosity(params.context.extraParams);
  if (textVerbosity) {
    streamFn = createOpenAITextVerbosityWrapper(streamFn, textVerbosity);
  }

  streamFn = createCodexNativeWebSearchWrapper(streamFn, {
    config: params.context.config,
    agentDir: params.context.agentDir,
  });
  streamFn = createOpenAIStringContentWrapper(streamFn);
  return createOpenAIResponsesContextManagementWrapper(
    createOpenAIReasoningCompatibilityWrapper(
      createOpenAIThinkingLevelWrapper(streamFn, params.context.thinkingLevel),
    ),
    params.context.extraParams,
  );
}

beforeEach(() => {
  installFullProviderRuntimeDepsForTest();
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("applyExtraParamsToAgent", () => {
  function createOptionsCaptureAgent() {
    const calls: Array<(SimpleStreamOptions & { openaiWsWarmup?: boolean }) | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options as (SimpleStreamOptions & { openaiWsWarmup?: boolean }) | undefined);
      return {} as ReturnType<StreamFn>;
    };
    return {
      calls,
      agent: { streamFn: baseStreamFn },
    };
  }

  function buildModelConfig(modelKey: string, params: Record<string, unknown>) {
    return {
      agents: {
        defaults: {
          models: {
            [modelKey]: { params },
          },
        },
      },
    };
  }

  it("passes agentDir and workspaceDir to provider stream wrappers", () => {
    let capturedContext: WrapProviderStreamFnParams["context"] | undefined;
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: () => undefined,
      wrapProviderStreamFn: (params) => {
        capturedContext = params.context;
        return params.context.streamFn;
      },
    });

    const agent = { streamFn: (() => ({}) as ReturnType<StreamFn>) as StreamFn };
    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.4",
    } as Model<"openai-codex-responses">;

    applyExtraParamsToAgent(
      agent,
      undefined,
      "openai-codex",
      "gpt-5.4",
      undefined,
      "high",
      "cass",
      "/tmp/openclaw-workspace",
      model,
      "/tmp/openclaw-agent",
    );

    expect(capturedContext?.agentDir).toBe("/tmp/openclaw-agent");
    expect(capturedContext?.workspaceDir).toBe("/tmp/openclaw-workspace");
  });

  function runResponsesPayloadMutationCase(params: {
    applyProvider: string;
    applyModelId: string;
    model:
      | Model<"openai-responses">
      | Model<"azure-openai-responses">
      | Model<"openai-codex-responses">
      | Model<"openai-completions">
      | Model<"anthropic-messages">;
    options?: SimpleStreamOptions;
    cfg?: Record<string, unknown>;
    extraParamsOverride?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    thinkingLevel?: Parameters<typeof applyExtraParamsToAgent>[5];
  }) {
    const payload = params.payload ?? { store: false };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(
      agent,
      params.cfg as Parameters<typeof applyExtraParamsToAgent>[1],
      params.applyProvider,
      params.applyModelId,
      params.extraParamsOverride,
      params.thinkingLevel,
    );
    const context: Context = { messages: [] };
    void agent.streamFn?.(params.model, context, params.options ?? {});
    return payload;
  }

  function runResolvedModelIdCase(params: {
    applyProvider: string;
    applyModelId: string;
    model: Model<"anthropic-messages"> | Model<"openai-completions">;
    cfg?: Record<string, unknown>;
    extraParamsOverride?: Record<string, unknown>;
  }): string {
    let resolvedModelId = params.model.id;
    const baseStreamFn: StreamFn = (model) => {
      resolvedModelId = model.id;
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(
      agent,
      params.cfg as Parameters<typeof applyExtraParamsToAgent>[1],
      params.applyProvider,
      params.applyModelId,
      params.extraParamsOverride,
    );
    const context: Context = { messages: [] };
    void agent.streamFn?.(params.model, context, {});
    return resolvedModelId;
  }

  function runParallelToolCallsPayloadMutationCase(params: {
    applyProvider: string;
    applyModelId: string;
    model:
      | Model<"openai-completions">
      | Model<"openai-responses">
      | Model<"openai-codex-responses">
      | Model<"azure-openai-responses">
      | Model<"anthropic-messages">;
    cfg?: Record<string, unknown>;
    extraParamsOverride?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  }) {
    return withMinimalProviderRuntimeDepsForTest(() => {
      const payload = params.payload ?? {};
      const baseStreamFn: StreamFn = (model, _context, options) => {
        options?.onPayload?.(payload, model);
        return {} as ReturnType<StreamFn>;
      };
      const agent = { streamFn: baseStreamFn };
      applyExtraParamsToAgent(
        agent,
        params.cfg as Parameters<typeof applyExtraParamsToAgent>[1],
        params.applyProvider,
        params.applyModelId,
        params.extraParamsOverride,
      );
      const context: Context = { messages: [] };
      void agent.streamFn?.(params.model, context, {});
      return payload;
    });
  }

  function runToolPayloadMutationCase(params: {
    applyProvider: "openai" | "xai";
    applyModelId: string;
    model: Model<"openai-completions">;
  }) {
    const payload: {
      tools: Array<{ function?: Record<string, unknown> }>;
    } = {
      tools: [
        {
          function: {
            name: "write",
            description: "write a file",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        },
      ],
    };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload as unknown as Record<string, unknown>, model);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    applyExtraParamsToAgent(agent, undefined, params.applyProvider, params.applyModelId);
    const context: Context = { messages: [] };
    void agent.streamFn?.(params.model, context, {});
    return payload;
  }

  function runAnthropicHeaderCase(params: {
    cfg: Record<string, unknown>;
    modelId: string;
    options?: SimpleStreamOptions;
  }) {
    const { calls, agent } = createOptionsCaptureAgent();
    applyExtraParamsToAgent(agent, params.cfg, "anthropic", params.modelId);

    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: params.modelId,
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, params.options ?? {});

    expect(calls).toHaveLength(1);
    return calls[0]?.headers;
  }

  it("disables thinking for MiniMax anthropic-messages payloads", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "minimax", "MiniMax-M2.7");

    const model = {
      api: "anthropic-messages",
      provider: "minimax",
      id: "MiniMax-M2.7",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toEqual({ type: "disabled" });
  });

  it("strips xai Responses reasoning payload fields", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "xai",
      applyModelId: "grok-4.20-beta-latest-reasoning",
      model: {
        api: "openai-responses",
        provider: "xai",
        id: "grok-4.20-beta-latest-reasoning",
      } as unknown as Model<"openai-responses">,
      payload: {
        model: "grok-4.20-beta-latest-reasoning",
        input: [],
        reasoning: { effort: "high", summary: "auto" },
        reasoningEffort: "high",
        reasoning_effort: "high",
      },
    });

    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("strips disabled reasoning payloads for native OpenAI responses models that do not support none", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        reasoning: { effort: "none", summary: "auto" },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5", undefined, "off");

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
      baseUrl: "https://api.openai.com/v1",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      context_management: [{ type: "compaction", compact_threshold: 80000 }],
      parallel_tool_calls: true,
      store: true,
      text: { verbosity: "low" },
    });
  });

  it("keeps OpenAI Responses web_search compatible when thinking is minimal", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "http://127.0.0.1:19191/v1",
        reasoning: true,
      } as unknown as Model<"openai-responses">,
      payload: {
        model: "gpt-5",
        input: [],
        tools: [
          {
            type: "function",
            name: "web_search",
            description: "Search the web",
            parameters: { type: "object", properties: {} },
          },
        ],
        reasoning: { effort: "low", summary: "auto" },
      },
      thinkingLevel: "minimal",
    });

    expect(payload.reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("strips disabled reasoning payloads for proxied OpenAI responses routes", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        reasoning: { effort: "none", summary: "auto" },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5", undefined, "off");

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
      baseUrl: "https://proxy.example.com/v1",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toHaveProperty("reasoning");
  });

  it("injects parallel_tool_calls for openai-completions payloads when configured", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "nvidia-nim",
      applyModelId: "moonshotai/kimi-k2.5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "nvidia-nim/moonshotai/kimi-k2.5": {
                params: {
                  parallel_tool_calls: false,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-completions",
        provider: "nvidia-nim",
        id: "moonshotai/kimi-k2.5",
      } as unknown as Model<"openai-completions">,
    });

    expect(payload.parallel_tool_calls).toBe(false);
  });

  it("uses canonical model config keys for provider-prefixed model ids", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "openrouter",
      applyModelId: "openrouter/auto",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openrouter/auto": {
                params: {
                  parallel_tool_calls: false,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-completions",
        provider: "openrouter",
        id: "openrouter/auto",
      } as unknown as Model<"openai-completions">,
    });

    expect(payload.parallel_tool_calls).toBe(false);
  });

  it("keeps legacy double-prefixed model config fallback for provider-prefixed model ids", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "openrouter",
      applyModelId: "openrouter/auto",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openrouter/openrouter/auto": {
                params: {
                  parallel_tool_calls: false,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-completions",
        provider: "openrouter",
        id: "openrouter/auto",
      } as Model<"openai-completions">,
    });

    expect(payload.parallel_tool_calls).toBe(false);
  });

  it("strips store from proxied openai-completions payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "google",
      applyModelId: "gemini-2.5-pro",
      model: {
        api: "openai-completions",
        provider: "google",
        id: "gemini-2.5-pro",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      } as Model<"openai-completions">,
      payload: {
        messages: [],
        store: false,
      },
    });

    expect(payload).not.toHaveProperty("store");
  });

  it("keeps store untouched for native openai-completions payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-4.1",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-4.1",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-completions">,
      payload: {
        messages: [],
        store: false,
      },
    });

    expect(payload.store).toBe(false);
  });

  it("merges extra_body into openai-completions payloads before proxy store stripping", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "google",
      applyModelId: "gemini-2.5-pro",
      cfg: {
        agents: {
          defaults: {
            models: {
              "google/gemini-2.5-pro": {
                params: {
                  extraBody: {
                    google: { thinking_config: { thinking_budget: 0 } },
                    store: false,
                  },
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-completions",
        provider: "google",
        id: "gemini-2.5-pro",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      } as Model<"openai-completions">,
      payload: {
        messages: [],
      },
    });

    expect(payload.google).toEqual({ thinking_config: { thinking_budget: 0 } });
    expect(payload).not.toHaveProperty("store");
  });

  it("forwards chat_template_kwargs params as top-level openai-completions payload fields", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "vllm",
      applyModelId: "nemotron-3-super",
      cfg: {
        agents: {
          defaults: {
            models: {
              "vllm/nemotron-3-super": {
                params: {
                  chat_template_kwargs: {
                    enable_thinking: false,
                    force_nonempty_content: true,
                  },
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-completions",
        provider: "vllm",
        id: "nemotron-3-super",
        baseUrl: "http://127.0.0.1:8000/v1",
      } as Model<"openai-completions">,
      payload: {
        messages: [],
      },
    });

    expect(payload.chat_template_kwargs).toEqual({
      enable_thinking: false,
      force_nonempty_content: true,
    });
  });

  it("warns and skips invalid chat_template_kwargs params", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const payload = runResponsesPayloadMutationCase({
        applyProvider: "vllm",
        applyModelId: "nemotron-3-super",
        cfg: {
          agents: {
            defaults: {
              models: {
                "vllm/nemotron-3-super": {
                  params: { chat_template_kwargs: "not-an-object" },
                },
              },
            },
          },
        },
        model: {
          api: "openai-completions",
          provider: "vllm",
          id: "nemotron-3-super",
          baseUrl: "http://127.0.0.1:8000/v1",
        } as Model<"openai-completions">,
        payload: {
          messages: [],
        },
      });

      expect(payload).not.toHaveProperty("chat_template_kwargs");
      expect(warnSpy).toHaveBeenCalledWith(
        "ignoring invalid chat_template_kwargs param: not-an-object",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns and skips invalid extra_body params", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const payload = runResponsesPayloadMutationCase({
        applyProvider: "google",
        applyModelId: "gemini-2.5-pro",
        cfg: {
          agents: {
            defaults: {
              models: {
                "google/gemini-2.5-pro": {
                  params: { extra_body: "not-an-object" },
                },
              },
            },
          },
        },
        model: {
          api: "openai-completions",
          provider: "google",
          id: "gemini-2.5-pro",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        } as Model<"openai-completions">,
      });

      expect(payload).not.toHaveProperty("extra_body");
      expect(warnSpy).toHaveBeenCalledWith("ignoring invalid extra_body param: not-an-object");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("flattens pure text OpenAI completions message arrays for string-only compat models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "inferrs",
      applyModelId: "google/gemma-4-E2B-it",
      model: {
        api: "openai-completions",
        provider: "inferrs",
        id: "google/gemma-4-E2B-it",
        name: "Gemma 4 E2B (inferrs)",
        baseUrl: "http://127.0.0.1:8080/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 4096,
        compat: {
          requiresStringContent: true,
        } as Record<string, unknown>,
      } as unknown as Model<"openai-completions">,
      payload: {
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "System text" }],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Line one" },
              { type: "text", text: "Line two" },
            ],
          },
        ],
      },
    });

    expect(payload.messages).toEqual([
      {
        role: "system",
        content: "System text",
      },
      {
        role: "user",
        content: "Line one\nLine two",
      },
    ]);
  });

  it("injects parallel_tool_calls for openai-responses payloads when configured", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5": {
                params: {
                  parallelToolCalls: true,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
    });

    expect(payload.parallel_tool_calls).toBe(true);
  });

  it("injects parallel_tool_calls for openai-codex-responses payloads when configured", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "openai-codex",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai-codex/gpt-5.4": {
                params: {
                  parallelToolCalls: true,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      } as unknown as Model<"openai-codex-responses">,
    });

    expect(payload.parallel_tool_calls).toBe(true);
  });

  it("strips function.strict for xai providers", () => {
    const payload = runToolPayloadMutationCase({
      applyProvider: "xai",
      applyModelId: "grok-4-1-fast-reasoning",
      model: {
        api: "openai-completions",
        provider: "xai",
        id: "grok-4-1-fast-reasoning",
      } as Model<"openai-completions">,
    });

    expect(payload.tools[0]?.function).not.toHaveProperty("strict");
  });

  it("keeps function.strict for non-xai providers", () => {
    const payload = runToolPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5.4",
      } as Model<"openai-completions">,
    });

    expect(payload.tools[0]?.function?.strict).toBe(true);
  });

  it("injects parallel_tool_calls for azure-openai-responses payloads when configured", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "azure-openai-responses/gpt-5": {
                params: {
                  parallelToolCalls: true,
                },
              },
            },
          },
        },
      },
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-5",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as unknown as Model<"azure-openai-responses">,
    });

    expect(payload.parallel_tool_calls).toBe(true);
  });

  it("does not inject parallel_tool_calls for unsupported APIs", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-6",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {
                params: {
                  parallel_tool_calls: false,
                },
              },
            },
          },
        },
      },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-6",
      } as Model<"anthropic-messages">,
    });

    expect(payload).not.toHaveProperty("parallel_tool_calls");
  });

  it("lets runtime override win across alias styles for parallel_tool_calls", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "nvidia-nim",
      applyModelId: "moonshotai/kimi-k2.5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "nvidia-nim/moonshotai/kimi-k2.5": {
                params: {
                  parallel_tool_calls: true,
                },
              },
            },
          },
        },
      },
      extraParamsOverride: {
        parallelToolCalls: false,
      },
      model: {
        api: "openai-completions",
        provider: "nvidia-nim",
        id: "moonshotai/kimi-k2.5",
      } as Model<"openai-completions">,
    });

    expect(payload.parallel_tool_calls).toBe(false);
  });

  it("lets null runtime override suppress inherited parallel_tool_calls injection", () => {
    const payload = runParallelToolCallsPayloadMutationCase({
      applyProvider: "nvidia-nim",
      applyModelId: "moonshotai/kimi-k2.5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "nvidia-nim/moonshotai/kimi-k2.5": {
                params: {
                  parallel_tool_calls: true,
                },
              },
            },
          },
        },
      },
      extraParamsOverride: {
        parallelToolCalls: null,
      },
      model: {
        api: "openai-completions",
        provider: "nvidia-nim",
        id: "moonshotai/kimi-k2.5",
      } as Model<"openai-completions">,
    });

    expect(payload).not.toHaveProperty("parallel_tool_calls");
  });

  it("warns and skips invalid parallel_tool_calls values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runParallelToolCallsPayloadMutationCase({
        applyProvider: "nvidia-nim",
        applyModelId: "moonshotai/kimi-k2.5",
        cfg: {
          agents: {
            defaults: {
              models: {
                "nvidia-nim/moonshotai/kimi-k2.5": {
                  params: {
                    parallelToolCalls: "false",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "openai-completions",
          provider: "nvidia-nim",
          id: "moonshotai/kimi-k2.5",
        } as Model<"openai-completions">,
      });

      expect(payload).not.toHaveProperty("parallel_tool_calls");
      expect(warnSpy).toHaveBeenCalledWith("ignoring invalid parallel_tool_calls param: false");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("normalizes thinking=off to null for SiliconFlow Pro models", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { thinking: "off" };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "siliconflow",
      "Pro/MiniMaxAI/MiniMax-M2.7",
      undefined,
      "off",
    );

    const model = {
      api: "openai-completions",
      provider: "siliconflow",
      id: "Pro/MiniMaxAI/MiniMax-M2.7",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toBeNull();
  });

  it("keeps thinking=off unchanged for non-Pro SiliconFlow model IDs", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = { thinking: "off" };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "siliconflow",
      "deepseek-ai/DeepSeek-V3.2",
      undefined,
      "off",
    );

    const model = {
      api: "openai-completions",
      provider: "siliconflow",
      id: "deepseek-ai/DeepSeek-V3.2",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.thinking).toBe("off");
  });

  it("keeps anthropic tool payloads native for Kimi", () => {
    withMinimalProviderRuntimeDepsForTest(() => {
      const payloads: Record<string, unknown>[] = [];
      const baseStreamFn: StreamFn = (_model, _context, options) => {
        const payload: Record<string, unknown> = {
          tools: [
            {
              name: "read",
              description: "Read file",
              input_schema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          ],
          tool_choice: { type: "tool", name: "read" },
        };
        options?.onPayload?.(payload, _model);
        payloads.push(payload);
        return {} as ReturnType<StreamFn>;
      };
      const agent = { streamFn: baseStreamFn };

      applyExtraParamsToAgent(agent, undefined, "kimi", "kimi-code", undefined, "low");

      const model = {
        api: "anthropic-messages",
        provider: "kimi",
        id: "kimi-code",
        baseUrl: "https://api.kimi.com/coding/",
      } as Model<"anthropic-messages">;
      const context: Context = { messages: [] };
      void agent.streamFn?.(model, context, {});

      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.tools).toEqual([
        {
          name: "read",
          description: "Read file",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ]);
      expect(payloads[0]?.tool_choice).toEqual({ type: "tool", name: "read" });
    });
  });

  it("does not rewrite anthropic tool schema for non-kimi endpoints", () => {
    withMinimalProviderRuntimeDepsForTest(() => {
      const payloads: Record<string, unknown>[] = [];
      const baseStreamFn: StreamFn = (_model, _context, options) => {
        const payload: Record<string, unknown> = {
          tools: [
            {
              name: "read",
              description: "Read file",
              input_schema: { type: "object", properties: {} },
            },
          ],
        };
        options?.onPayload?.(payload, _model);
        payloads.push(payload);
        return {} as ReturnType<StreamFn>;
      };
      const agent = { streamFn: baseStreamFn };

      applyExtraParamsToAgent(agent, undefined, "anthropic", "claude-sonnet-4-6", undefined, "low");

      const model = {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        baseUrl: "https://api.anthropic.com",
      } as Model<"anthropic-messages">;
      const context: Context = { messages: [] };
      void agent.streamFn?.(model, context, {});

      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.tools).toEqual([
        {
          name: "read",
          description: "Read file",
          input_schema: { type: "object", properties: {} },
        },
      ]);
    });
  });

  it("uses explicit compat metadata for anthropic tool payload normalization", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tools: [
          {
            name: "read",
            description: "Read file",
            input_schema: { type: "object", properties: {} },
          },
        ],
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const streamFn = createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn);

    const model = {
      api: "anthropic-messages",
      provider: "custom-anthropic-proxy",
      id: "proxy-model",
      compat: {
        requiresOpenAiAnthropicToolPayload: true,
      },
    } as unknown as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void streamFn(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read file",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it("lets provider-owned wrappers normalize anthropic tool payloads", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        tools: [
          {
            name: "read",
            description: "Read file",
            input_schema: { type: "object", properties: {} },
          },
        ],
        tool_choice: { type: "any" },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(
      agent,
      undefined,
      "test-anthropic-tool-compat",
      "proxy-model",
      undefined,
      "low",
    );

    const model = {
      api: "anthropic-messages",
      provider: "test-anthropic-tool-compat",
      id: "proxy-model",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read file",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(payloads[0]?.tool_choice).toBe("required");
  });

  it("sanitizes invalid Atproxy Gemini negative thinking budgets", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        contents: [
          {
            role: "user",
            parts: [
              { text: "describe image" },
              {
                inlineData: {
                  mimeType: "image/png",
                  data: "ZmFrZQ==",
                },
              },
            ],
          },
        ],
        config: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: -1,
          },
        },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "atproxy", "gemini-3.1-pro-high", undefined, "high");

    const model = {
      api: "google-generative-ai",
      provider: "atproxy",
      id: "gemini-3.1-pro-high",
    } as Model<"google-generative-ai">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    const thinkingConfig = (
      payloads[0]?.config as { thinkingConfig?: Record<string, unknown> } | undefined
    )?.thinkingConfig;
    expect(thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
    expect(
      (
        payloads[0]?.contents as
          | Array<{ parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> }>
          | undefined
      )?.[0]?.parts?.[1]?.inlineData,
    ).toEqual({
      mimeType: "image/png",
      data: "ZmFrZQ==",
    });
  });

  it("rewrites Gemini 3 thinkingBudget to thinkingLevel", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        config: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: 2048,
          },
        },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "atproxy", "gemini-3.1-pro-high", undefined, "high");

    const model = {
      api: "google-generative-ai",
      provider: "atproxy",
      id: "gemini-3.1-pro-high",
    } as Model<"google-generative-ai">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.config).toEqual({
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: "HIGH",
      },
    });
  });

  it("rewrites Gemma 4 thinkingBudget to a supported Google thinkingLevel", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        config: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: 24576,
          },
        },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "google", "gemma-4-26b-a4b-it", undefined, "high");

    const model = {
      api: "google-generative-ai",
      provider: "google",
      id: "gemma-4-26b-a4b-it",
      reasoning: true,
    } as Model<"google-generative-ai">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.config).toEqual({
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: "HIGH",
      },
    });
  });

  it("preserves Gemma 4 thinking off instead of rewriting thinkingBudget=0 to MINIMAL", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        config: {
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "google", "gemma-4-26b-a4b-it", undefined, "off");

    const model = {
      api: "google-generative-ai",
      provider: "google",
      id: "gemma-4-26b-a4b-it",
      reasoning: true,
    } as Model<"google-generative-ai">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.config).toEqual({});
  });

  it("preserves explicit Gemma 4 thinking level when thinkingBudget=0", () => {
    const payloads: Record<string, unknown>[] = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {
        config: {
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      };
      options?.onPayload?.(payload, _model);
      payloads.push(payload);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };

    applyExtraParamsToAgent(agent, undefined, "google", "gemma-4-26b-a4b-it", undefined, "high");

    const model = {
      api: "google-generative-ai",
      provider: "google",
      id: "gemma-4-26b-a4b-it",
      reasoning: true,
    } as Model<"google-generative-ai">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.config).toEqual({
      thinkingConfig: {
        thinkingLevel: "HIGH",
      },
    });
  });
  it("passes configured websocket transport through stream options", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                transport: "websocket",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.4");

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.4",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("websocket");
  });

  it("passes configured websocket transport through stream options for openai-codex gpt-5.4", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                transport: "websocket",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.4");

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.4",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("websocket");
  });

  it("preserves maxTokens: 0 in shared extra params for providers that forward it", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5": {
              params: {
                maxTokens: 0,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxTokens).toBe(0);
  });

  it("defaults Codex transport to auto (WebSocket-first)", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "openai-codex", "gpt-5.4");

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.4",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("auto");
  });

  it("defaults OpenAI transport to auto without websocket warm-up", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("auto");
    expect(calls[0]?.openaiWsWarmup).toBe(false);
  });

  it("injects GPT-5 default parallel tool calls and low verbosity for OpenAI Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as unknown as Model<"openai-responses">,
      payload: {},
    });

    expect(payload.parallel_tool_calls).toBe(true);
    expect(payload.text).toEqual({ verbosity: "low" });
  });

  it("injects GPT-5 default parallel tool calls for Codex Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai-codex",
      applyModelId: "gpt-5.4",
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.4",
      } as Model<"openai-codex-responses">,
      payload: {},
    });

    expect(payload.parallel_tool_calls).toBe(true);
    expect(payload.text).toEqual({ verbosity: "low" });
  });

  it("injects native Codex web_search for direct openai-codex Responses models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai-codex",
      applyModelId: "gpt-5.4",
      cfg: {
        auth: {
          profiles: {
            "openai-codex:default": {
              provider: "openai-codex",
              mode: "oauth",
            },
          },
        },
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: {
                enabled: true,
                mode: "live",
                allowedDomains: ["example.com"],
              },
            },
          },
        },
      },
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.4",
      } as Model<"openai-codex-responses">,
      payload: { tools: [{ type: "function", name: "read" }] },
    });

    expect(payload.tools).toEqual([
      { type: "function", name: "read" },
      {
        type: "web_search",
        external_web_access: true,
        filters: { allowed_domains: ["example.com"] },
      },
    ]);
  });

  it("does not inject duplicate native Codex web_search tools", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "gateway",
      applyModelId: "gpt-5.4",
      cfg: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: {
                enabled: true,
                mode: "cached",
              },
            },
          },
        },
      },
      model: {
        api: "openai-codex-responses",
        provider: "gateway",
        id: "gpt-5.4",
      } as Model<"openai-codex-responses">,
      payload: { tools: [{ type: "web_search" }] },
    });

    expect(payload.tools).toEqual([{ type: "web_search" }]);
  });

  it("keeps payload unchanged when Codex native search is inactive", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      cfg: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: {
                enabled: true,
                mode: "cached",
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
      } as unknown as Model<"openai-responses">,
      payload: { tools: [{ type: "function", name: "read" }] },
    });

    expect(payload.tools).toEqual([{ type: "function", name: "read" }]);
  });

  it("lets runtime options override OpenAI default transport", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, { transport: "sse" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("sse");
  });

  it("allows disabling OpenAI websocket warm-up via model params", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5": {
              params: {
                openaiWsWarmup: false,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.openaiWsWarmup).toBe(false);
  });

  it("lets runtime options override configured OpenAI websocket warm-up", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5": {
              params: {
                openaiWsWarmup: false,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai", "gpt-5");

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {
      openaiWsWarmup: true,
    } as unknown as SimpleStreamOptions);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.openaiWsWarmup).toBe(true);
  });

  it("allows forcing Codex transport to SSE", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                transport: "sse",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.4");

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.4",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("sse");
  });

  it("lets runtime options override configured transport", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                transport: "websocket",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.4");

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.4",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, { transport: "sse" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("sse");
  });

  it("falls back to Codex default transport when configured value is invalid", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              params: {
                transport: "udp",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "openai-codex", "gpt-5.4");

    const model = {
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-5.4",
    } as Model<"openai-codex-responses">;
    const context: Context = { messages: [] };
    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.transport).toBe("auto");
  });

  it("returns prepared Codex transport defaults for runtime sessions", () => {
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      provider: "openai-codex",
      modelId: "gpt-5.4",
    });

    expect(effectiveExtraParams.transport).toBe("auto");
  });

  it("composes transport extra-param hooks after provider preparation", () => {
    const resolveProviderExtraParamsForTransport = vi.fn((_params) => ({
      patch: {
        hookApplied: true,
      },
    }));
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: (params) => ({
        ...params.context.extraParams,
        transport: "websocket",
      }),
      resolveProviderExtraParamsForTransport,
      wrapProviderStreamFn: (params) => params.context.streamFn,
    });

    const model = {
      api: "openai-responses",
      provider: "openai",
      id: "gpt-5",
    } as Model<"openai-responses">;
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      provider: "openai",
      modelId: "gpt-5",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      model,
    });

    expect(effectiveExtraParams).toMatchObject({
      transport: "websocket",
      hookApplied: true,
    });
    expect(resolveProviderExtraParamsForTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        context: expect.objectContaining({
          model,
          transport: "websocket",
          agentDir: "/tmp/agent",
          workspaceDir: "/tmp/workspace",
        }),
      }),
    );
  });

  it("keys prepared extra-param memoization by resolved model transport inputs", () => {
    const resolveProviderExtraParamsForTransport = vi.fn((params) => ({
      patch: {
        transportFamily: params.context.model?.api,
        baseUrl: (params.context.model as Record<string, unknown> | undefined)?.baseUrl,
        headerAuth: (
          (params.context.model as Record<string, unknown> | undefined)?.headers as
            | Record<string, unknown>
            | undefined
        )?.["X-Test"],
      },
    }));
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: (params) => params.context.extraParams,
      resolveProviderExtraParamsForTransport,
      wrapProviderStreamFn: (params) => params.context.streamFn,
    });
    const cfg = {};

    const responsesParams = resolvePreparedExtraParams({
      cfg,
      provider: "openai",
      modelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api-one.example/v1",
        headers: { "X-Test": "one" },
      } as unknown as Model<"openai-responses">,
    });
    const completionsParams = resolvePreparedExtraParams({
      cfg,
      provider: "openai",
      modelId: "gpt-5",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api-one.example/v1",
        headers: { "X-Test": "one" },
      } as unknown as Model<"openai-completions">,
    });
    const differentModelHeadersParams = resolvePreparedExtraParams({
      cfg,
      provider: "openai",
      modelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api-two.example/v1",
        headers: { "X-Test": "two" },
      } as unknown as Model<"openai-responses">,
    });
    const repeatedResponsesParams = resolvePreparedExtraParams({
      cfg,
      provider: "openai",
      modelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api-one.example/v1",
        headers: { "X-Test": "one" },
      } as unknown as Model<"openai-responses">,
    });

    expect(responsesParams.transportFamily).toBe("openai-responses");
    expect(completionsParams.transportFamily).toBe("openai-completions");
    expect(differentModelHeadersParams.baseUrl).toBe("https://api-two.example/v1");
    expect(differentModelHeadersParams.headerAuth).toBe("two");
    expect(repeatedResponsesParams.transportFamily).toBe("openai-responses");
    expect(resolveProviderExtraParamsForTransport).toHaveBeenCalledTimes(3);
  });

  it("passes explicit settings transport to transport extra-param hooks", () => {
    const resolveProviderExtraParamsForTransport = vi.fn((_params) => ({
      patch: {
        hookApplied: true,
      },
    }));
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: (params) => ({
        ...params.context.extraParams,
        transport: "auto",
      }),
      resolveProviderExtraParamsForTransport,
      wrapProviderStreamFn: (params) => params.context.streamFn,
    });

    const resolvedTransport = resolveExplicitSettingsTransport({
      settingsManager: {
        getGlobalSettings: () => ({ transport: "websocket" }),
        getProjectSettings: () => ({}),
      },
      sessionTransport: "websocket",
    });
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      provider: "openai",
      modelId: "gpt-5",
      resolvedTransport,
    });

    expect(effectiveExtraParams).toMatchObject({
      transport: "auto",
      hookApplied: true,
    });
    expect(resolveProviderExtraParamsForTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          transport: "websocket",
        }),
      }),
    );
  });

  it("applies transport hook parallel_tool_calls patches to request payloads", () => {
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: () => undefined,
      resolveProviderExtraParamsForTransport: () => ({
        patch: {
          parallel_tool_calls: true,
        },
      }),
      wrapProviderStreamFn: (params) => params.context.streamFn,
    });
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "test-openai",
      applyModelId: "gpt-compatible",
      model: {
        api: "openai-responses",
        provider: "test-openai",
        id: "gpt-compatible",
      } as Model<"openai-responses">,
      payload: {},
    });

    expect(payload.parallel_tool_calls).toBe(true);
  });

  it("uses prepared transport when session settings did not explicitly set one", () => {
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      provider: "openai-codex",
      modelId: "gpt-5.4",
    });

    expect(
      resolveAgentTransportOverride({
        settingsManager: {
          getGlobalSettings: () => ({}),
          getProjectSettings: () => ({}),
        },
        effectiveExtraParams,
      }),
    ).toBe("auto");
  });

  it("keeps explicit session transport over prepared OpenAI defaults", () => {
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      provider: "openai",
      modelId: "gpt-5",
    });

    expect(
      resolveAgentTransportOverride({
        settingsManager: {
          getGlobalSettings: () => ({ transport: "sse" }),
          getProjectSettings: () => ({}),
        },
        effectiveExtraParams,
      }),
    ).toBeUndefined();
  });

  it("resolves explicit settings transport from the active session transport", () => {
    expect(
      resolveExplicitSettingsTransport({
        settingsManager: {
          getGlobalSettings: () => ({}),
          getProjectSettings: () => ({}),
        },
        sessionTransport: "websocket",
      }),
    ).toBeUndefined();
    expect(
      resolveExplicitSettingsTransport({
        settingsManager: {
          getGlobalSettings: () => ({ transport: "sse" }),
          getProjectSettings: () => ({}),
        },
        sessionTransport: "websocket",
      }),
    ).toBe("websocket");
  });

  it("strips prototype pollution keys from extra params overrides", () => {
    const effectiveExtraParams = resolvePreparedExtraParams({
      cfg: undefined,
      provider: "openai",
      modelId: "gpt-5",
      extraParamsOverride: {
        __proto__: { polluted: true },
        constructor: "blocked",
        prototype: "blocked",
        temperature: 0.2,
      },
    });

    expect(effectiveExtraParams.temperature).toBe(0.2);
    expect(Object.hasOwn(effectiveExtraParams, "__proto__")).toBe(false);
    expect(Object.hasOwn(effectiveExtraParams, "constructor")).toBe(false);
    expect(Object.hasOwn(effectiveExtraParams, "prototype")).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("keeps Anthropic Bedrock models eligible for provider-side caching", () => {
    const { calls, agent } = createOptionsCaptureAgent();

    applyExtraParamsToAgent(agent, undefined, "amazon-bedrock", "us.anthropic.claude-sonnet-4-5");

    const model = {
      api: "openai-completions",
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-sonnet-4-5",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBeUndefined();
  });

  it("passes through explicit cacheRetention for Anthropic Bedrock models", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "amazon-bedrock/us.anthropic.claude-opus-4-6-v1": {
              params: {
                cacheRetention: "long",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "amazon-bedrock", "us.anthropic.claude-opus-4-6-v1");

    const model = {
      api: "openai-completions",
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-opus-4-6-v1",
    } as Model<"openai-completions">;
    const context: Context = { messages: [] };

    void agent.streamFn?.(model, context, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBe("long");
  });

  it("passes through explicit cacheRetention for custom anthropic-messages providers", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = {
      agents: {
        defaults: {
          models: {
            "litellm/claude-sonnet-4-6": {
              params: {
                cacheRetention: "long",
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(
      agent,
      cfg,
      "litellm",
      "claude-sonnet-4-6",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        api: "anthropic-messages",
        provider: "litellm",
        id: "claude-sonnet-4-6",
      } as Model<"anthropic-messages">,
    );

    const context: Context = { messages: [] };

    void agent.streamFn?.(
      {
        api: "anthropic-messages",
        provider: "litellm",
        id: "claude-sonnet-4-6",
      } as Model<"anthropic-messages">,
      context,
      {},
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cacheRetention).toBe("long");
  });

  it("adds Anthropic 1M beta header when context1m is enabled for Opus/Sonnet", () => {
    const { calls, agent } = createOptionsCaptureAgent();
    const cfg = buildModelConfig("anthropic/claude-opus-4-6", { context1m: true });

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-opus-4-6");

    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-opus-4-6",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };

    // Simulate pi-agent-core passing apiKey in options (API key, not OAuth token)
    void agent.streamFn?.(model, context, {
      apiKey: "sk-ant-api03-test", // pragma: allowlist secret
      headers: { "X-Custom": "1" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toEqual({
      "X-Custom": "1",
      // Includes pi-ai default betas (preserved to avoid overwrite) + context1m
      "anthropic-beta":
        "fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14,context-1m-2025-08-07",
    });
  });

  it("does not add Anthropic 1M beta header when context1m is not enabled", () => {
    const cfg = buildModelConfig("anthropic/claude-opus-4-6", {
      temperature: 0.2,
    });
    const headers = runAnthropicHeaderCase({
      cfg,
      modelId: "claude-opus-4-6",
      options: { headers: { "X-Custom": "1" } },
    });

    expect(headers).toEqual({ "X-Custom": "1" });
  });

  it("skips context1m beta for OAuth tokens but preserves OAuth-required betas", () => {
    const calls: Array<SimpleStreamOptions | undefined> = [];
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      calls.push(options);
      return {} as ReturnType<StreamFn>;
    };
    const agent = { streamFn: baseStreamFn };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": {
              params: {
                context1m: true,
              },
            },
          },
        },
      },
    };

    applyExtraParamsToAgent(agent, cfg, "anthropic", "claude-sonnet-4-6");

    const model = {
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-sonnet-4-6",
    } as Model<"anthropic-messages">;
    const context: Context = { messages: [] };

    // Simulate pi-agent-core passing an OAuth token (sk-ant-oat-*) as apiKey
    void agent.streamFn?.(model, context, {
      apiKey: "sk-ant-oat01-test-oauth-token", // pragma: allowlist secret
      headers: { "X-Custom": "1" },
    });

    expect(calls).toHaveLength(1);
    const betaHeader = calls[0]?.headers?.["anthropic-beta"] as string;
    // Must include the OAuth-required betas so they aren't stripped by pi-ai's mergeHeaders
    expect(betaHeader).toContain("oauth-2025-04-20");
    expect(betaHeader).toContain("claude-code-20250219");
    expect(betaHeader).not.toContain("context-1m-2025-08-07");
  });

  it("merges existing anthropic-beta headers with configured betas", () => {
    const cfg = buildModelConfig("anthropic/claude-sonnet-4-5", {
      context1m: true,
      anthropicBeta: ["files-api-2025-04-14"],
    });
    const headers = runAnthropicHeaderCase({
      cfg,
      modelId: "claude-sonnet-4-5",
      options: {
        apiKey: "sk-ant-api03-test", // pragma: allowlist secret
        headers: { "anthropic-beta": "prompt-caching-2024-07-31" },
      },
    });

    expect(headers).toEqual({
      "anthropic-beta":
        "prompt-caching-2024-07-31,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14,files-api-2025-04-14,context-1m-2025-08-07",
    });
  });

  it("ignores context1m for non-Opus/Sonnet Anthropic models", () => {
    const cfg = buildModelConfig("anthropic/claude-haiku-3-5", { context1m: true });
    const headers = runAnthropicHeaderCase({
      cfg,
      modelId: "claude-haiku-3-5",
      options: { headers: { "X-Custom": "1" } },
    });
    expect(headers).toEqual({ "X-Custom": "1" });
  });

  it("forces store=true for direct OpenAI Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(true);
  });

  it("forces store=true for azure-openai provider with openai-responses API (#42800)", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai",
      applyModelId: "gpt-5-mini",
      model: {
        api: "openai-responses",
        provider: "azure-openai",
        id: "gpt-5-mini",
        baseUrl: "https://myresource.openai.azure.com/openai/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(true);
  });

  it("strips disabled OpenAI reasoning payloads on native Responses models that do not support none", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5-mini",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5-mini",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        reasoning: { effort: "none" },
      },
    });
    expect(payload).not.toHaveProperty("reasoning");
  });

  it("strips disabled Azure OpenAI Responses reasoning payloads for models that do not support none", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-5-mini",
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-5-mini",
        baseUrl: "https://myresource.openai.azure.com/openai/v1",
      } as unknown as Model<"azure-openai-responses">,
      payload: {
        store: false,
        reasoning: { effort: "none" },
      },
    });
    expect(payload).not.toHaveProperty("reasoning");
  });

  it("injects configured OpenAI service_tier into Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.service_tier).toBe("priority");
  });

  it("injects configured OpenAI text verbosity into Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  textVerbosity: "low",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.text).toEqual({ verbosity: "low" });
  });

  it("injects configured text verbosity into Codex Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai-codex",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai-codex/gpt-5.4": {
                params: {
                  text_verbosity: "high",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api/codex/responses",
      } as unknown as Model<"openai-codex-responses">,
      payload: {
        store: false,
        text: {
          verbosity: "medium",
        },
      },
    });
    expect(payload.text).toEqual({ verbosity: "high" });
  });

  it("preserves caller-provided payload.text keys when injecting text verbosity", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  text_verbosity: "medium",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        text: {
          format: { type: "text" },
        },
      },
    });
    expect(payload.text).toEqual({
      format: { type: "text" },
      verbosity: "medium",
    });
  });

  it("preserves caller-provided payload.text.verbosity for OpenAI Responses", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  textVerbosity: "low",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        text: {
          verbosity: "high",
        },
      },
    });
    expect(payload.text).toEqual({ verbosity: "high" });
  });

  it("injects configured OpenAI service_tier into Codex Responses payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai-codex",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai-codex/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api",
      } as unknown as Model<"openai-codex-responses">,
    });
    expect(payload.service_tier).toBe("priority");
  });

  it("preserves caller-provided service_tier values", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        service_tier: "default",
      },
    });
    expect(payload.service_tier).toBe("default");
  });

  it("warns and skips invalid OpenAI text verbosity values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runResponsesPayloadMutationCase({
        applyProvider: "openai",
        applyModelId: "gpt-5.4",
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.4": {
                  params: {
                    textVerbosity: "loud",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
        } as unknown as Model<"openai-responses">,
      });
      expect(payload).not.toHaveProperty("text");
      expect(warnSpy).toHaveBeenCalledWith("ignoring invalid OpenAI text verbosity param: loud");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("lets null runtime override suppress inherited text verbosity injection", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  textVerbosity: "high",
                },
              },
            },
          },
        },
      },
      extraParamsOverride: {
        text_verbosity: null,
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("text");
  });

  it("ignores OpenAI text verbosity params for non-OpenAI providers without warning", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runResponsesPayloadMutationCase({
        applyProvider: "anthropic",
        applyModelId: "claude-sonnet-4-5",
        cfg: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-sonnet-4-5": {
                  params: {
                    textVerbosity: "high",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "anthropic-messages",
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          baseUrl: "https://api.anthropic.com",
        } as unknown as Model<"anthropic-messages">,
        payload: {},
      });
      expect(payload).not.toHaveProperty("text");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("maps fast mode to priority service_tier for direct OpenAI Responses", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  fastMode: true,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
      },
    });
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload.text).toEqual({ verbosity: "low" });
    expect(payload.service_tier).toBe("priority");
  });

  it("preserves caller-provided OpenAI payload fields when fast mode is enabled", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        reasoning: { effort: "medium" },
        text: { verbosity: "high" },
        service_tier: "default",
      },
    });
    expect(payload.reasoning).toEqual({ effort: "medium" });
    expect(payload.text).toEqual({ verbosity: "high" });
    expect(payload.service_tier).toBe("default");
  });

  it("maps MiniMax /fast to the matching highspeed model", () => {
    const resolvedModelId = runResolvedModelIdCase({
      applyProvider: "minimax",
      applyModelId: "MiniMax-M2.7",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
        baseUrl: "https://api.minimax.io/anthropic",
      } as Model<"anthropic-messages">,
    });

    expect(resolvedModelId).toBe("MiniMax-M2.7-highspeed");
  });

  it("maps MiniMax M2.7 /fast to the matching highspeed model", () => {
    const resolvedModelId = runResolvedModelIdCase({
      applyProvider: "minimax",
      applyModelId: "MiniMax-M2.7",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
        baseUrl: "https://api.minimax.io/anthropic",
      } as Model<"anthropic-messages">,
    });

    expect(resolvedModelId).toBe("MiniMax-M2.7-highspeed");
  });

  it("keeps explicit MiniMax highspeed models unchanged when /fast is off", () => {
    const resolvedModelId = runResolvedModelIdCase({
      applyProvider: "minimax-portal",
      applyModelId: "MiniMax-M2.7-highspeed",
      extraParamsOverride: { fastMode: false },
      model: {
        api: "anthropic-messages",
        provider: "minimax-portal",
        id: "MiniMax-M2.7-highspeed",
        baseUrl: "https://api.minimax.io/anthropic",
      } as unknown as Model<"anthropic-messages">,
    });

    expect(resolvedModelId).toBe("MiniMax-M2.7-highspeed");
  });

  it("maps xAI /fast to the current Grok fast model", () => {
    const resolvedModelId = runResolvedModelIdCase({
      applyProvider: "xai",
      applyModelId: "grok-4",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "openai-completions",
        provider: "xai",
        id: "grok-4",
        baseUrl: "https://api.x.ai/v1",
      } as unknown as Model<"openai-completions">,
    });

    expect(resolvedModelId).toBe("grok-4-fast");
  });

  it("keeps explicit xAI fast models unchanged when /fast is off", () => {
    const resolvedModelId = runResolvedModelIdCase({
      applyProvider: "xai",
      applyModelId: "grok-4-1-fast",
      extraParamsOverride: { fastMode: false },
      model: {
        api: "openai-completions",
        provider: "xai",
        id: "grok-4-1-fast",
        baseUrl: "https://api.x.ai/v1",
      } as Model<"openai-completions">,
    });

    expect(resolvedModelId).toBe("grok-4-1-fast");
  });

  it("injects service_tier=auto for Anthropic fast mode on direct API-key models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload.service_tier).toBe("auto");
  });

  it("injects service_tier=standard_only for Anthropic fast mode off", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      extraParamsOverride: { fastMode: false },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload.service_tier).toBe("standard_only");
  });

  it("preserves caller-provided Anthropic service_tier values", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      payload: {
        service_tier: "standard_only",
      },
    });
    expect(payload.service_tier).toBe("standard_only");
  });

  it("injects configured Anthropic service_tier into direct Anthropic payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-5": {
                params: {
                  serviceTier: "standard_only",
                },
              },
            },
          },
        },
      },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload.service_tier).toBe("standard_only");
  });

  it("does not inject configured Anthropic service_tier into OAuth-authenticated Anthropic payloads", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-5": {
                params: {
                  serviceTier: "standard_only",
                },
              },
            },
          },
        },
      },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      options: {
        apiKey: "sk-ant-oat-test-token",
      },
      payload: {},
    });
    expect(payload.service_tier).toBeUndefined();
  });

  it("does not warn for valid Anthropic serviceTier values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runResponsesPayloadMutationCase({
        applyProvider: "anthropic",
        applyModelId: "claude-sonnet-4-5",
        cfg: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-sonnet-4-5": {
                  params: {
                    serviceTier: "standard_only",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "anthropic-messages",
          provider: "anthropic",
          id: "claude-sonnet-4-5",
          baseUrl: "https://api.anthropic.com",
        } as unknown as Model<"anthropic-messages">,
        payload: {},
      });

      expect(payload.service_tier).toBe("standard_only");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("accepts snake_case Anthropic service_tier params", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      extraParamsOverride: {
        service_tier: "standard_only",
      },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload.service_tier).toBe("standard_only");
  });

  it("lets explicit Anthropic service_tier override fast mode defaults", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-5": {
                params: {
                  fastMode: true,
                  serviceTier: "standard_only",
                },
              },
            },
          },
        },
      },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload.service_tier).toBe("standard_only");
  });

  it("does not inject explicit Anthropic service_tier for OAuth auth even when fast mode is enabled", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-5": {
                params: {
                  fastMode: true,
                  serviceTier: "standard_only",
                },
              },
            },
          },
        },
      },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      options: {
        apiKey: "sk-ant-oat-test-token",
      },
      payload: {},
    });
    expect(payload.service_tier).toBeUndefined();
  });

  it("does not inject Anthropic fast mode service_tier for OAuth auth", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      options: {
        apiKey: "sk-ant-oat-test-token",
      },
      payload: {},
    });
    expect(payload.service_tier).toBeUndefined();
  });

  it("does not inject Anthropic standard_only service_tier for OAuth auth when fastMode is false", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      extraParamsOverride: { fastMode: false },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://api.anthropic.com",
      } as unknown as Model<"anthropic-messages">,
      options: {
        apiKey: "sk-ant-oat-test-token",
      },
      payload: {},
    });
    expect(payload.service_tier).toBeUndefined();
  });

  it("does not inject Anthropic fast mode service_tier for proxied base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://proxy.example.com/anthropic",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("does not inject explicit Anthropic service_tier for proxied base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "anthropic",
      applyModelId: "claude-sonnet-4-5",
      extraParamsOverride: {
        serviceTier: "standard_only",
      },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        baseUrl: "https://proxy.example.com/anthropic",
      } as unknown as Model<"anthropic-messages">,
      payload: {},
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("maps fast mode to priority service_tier for openai-codex responses", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai-codex",
      applyModelId: "gpt-5.4",
      extraParamsOverride: { fastMode: true },
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api",
      } as unknown as Model<"openai-codex-responses">,
      payload: {
        store: false,
      },
    });
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload.text).toEqual({ verbosity: "low" });
    expect(payload.service_tier).toBe("priority");
  });

  it("does not inject service_tier for non-openai providers", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "azure-openai-responses/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-5.4",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as unknown as Model<"azure-openai-responses">,
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("does not inject service_tier for proxied openai base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://proxy.example.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("does not inject service_tier for openai provider routed to Azure base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  serviceTier: "priority",
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("warns and skips service_tier injection for invalid serviceTier values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runResponsesPayloadMutationCase({
        applyProvider: "openai",
        applyModelId: "gpt-5.4",
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.4": {
                  params: {
                    serviceTier: "invalid",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
        } as unknown as Model<"openai-responses">,
      });

      expect(payload).not.toHaveProperty("service_tier");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith("ignoring invalid OpenAI service tier param: invalid");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn for valid OpenAI serviceTier values", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const payload = runResponsesPayloadMutationCase({
        applyProvider: "openai",
        applyModelId: "gpt-5.4",
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.4": {
                  params: {
                    serviceTier: "priority",
                  },
                },
              },
            },
          },
        },
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
        } as unknown as Model<"openai-responses">,
      });

      expect(payload.service_tier).toBe("priority");
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not force store for OpenAI Responses routed through non-OpenAI base URLs", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://proxy.example.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(false);
  });

  it("does not force store for OpenAI Responses when baseUrl is empty", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.store).toBe(false);
  });

  it("strips store from payload for models that declare supportsStore=false", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-4o",
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-4o",
        name: "gpt-4o",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
        compat: { supportsStore: false },
      } as unknown as Model<"azure-openai-responses">,
    });
    expect(payload).not.toHaveProperty("store");
  });

  it("strips store from payload for non-OpenAI responses providers with supportsStore=false", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "custom-openai-responses",
      applyModelId: "gemini-2.5-pro",
      model: {
        api: "openai-responses",
        provider: "custom-openai-responses",
        id: "gemini-2.5-pro",
        name: "gemini-2.5-pro",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        compat: { supportsStore: false },
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("store");
  });

  it("keeps existing context_management when stripping store for supportsStore=false models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "custom-openai-responses",
      applyModelId: "gemini-2.5-pro",
      model: {
        api: "openai-responses",
        provider: "custom-openai-responses",
        id: "gemini-2.5-pro",
        name: "gemini-2.5-pro",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/openai",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        compat: { supportsStore: false },
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        context_management: [{ type: "compaction", compact_threshold: 12_345 }],
      },
    });
    expect(payload).not.toHaveProperty("store");
    expect(payload.context_management).toEqual([{ type: "compaction", compact_threshold: 12_345 }]);
  });

  it("auto-injects OpenAI Responses context_management compaction for direct OpenAI models", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 200_000,
      } as unknown as Model<"openai-responses">,
    });
    expect(payload.context_management).toEqual([
      {
        type: "compaction",
        compact_threshold: 140_000,
      },
    ]);
  });

  it("does not auto-inject OpenAI Responses context_management for Azure by default", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-4o",
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-4o",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as unknown as Model<"azure-openai-responses">,
    });
    expect(payload).not.toHaveProperty("context_management");
  });

  it("allows explicitly enabling OpenAI Responses context_management compaction", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-4o",
      cfg: {
        agents: {
          defaults: {
            models: {
              "azure-openai-responses/gpt-4o": {
                params: {
                  responsesServerCompaction: true,
                  responsesCompactThreshold: 42_000,
                },
              },
            },
          },
        },
      },
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-4o",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as unknown as Model<"azure-openai-responses">,
    });
    expect(payload.context_management).toEqual([
      {
        type: "compaction",
        compact_threshold: 42_000,
      },
    ]);
  });

  it("preserves existing context_management payload values", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        context_management: [{ type: "compaction", compact_threshold: 12_345 }],
      },
    });
    expect(payload.context_management).toEqual([{ type: "compaction", compact_threshold: 12_345 }]);
  });

  it("allows disabling OpenAI Responses context_management compaction via model params", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5": {
                params: {
                  responsesServerCompaction: false,
                },
              },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
    });
    expect(payload).not.toHaveProperty("context_management");
  });

  it.each([
    {
      name: "with openai-codex provider config",
      run: () =>
        runResponsesPayloadMutationCase({
          applyProvider: "openai-codex",
          applyModelId: "codex-mini-latest",
          model: {
            api: "openai-codex-responses",
            provider: "openai-codex",
            id: "codex-mini-latest",
            baseUrl: "https://chatgpt.com/backend-api/codex/responses",
          } as Model<"openai-codex-responses">,
        }),
    },
    {
      name: "without config via provider/model hints",
      run: () =>
        runResponsesPayloadMutationCase({
          applyProvider: "openai-codex",
          applyModelId: "codex-mini-latest",
          model: {
            api: "openai-codex-responses",
            provider: "openai-codex",
            id: "codex-mini-latest",
            baseUrl: "https://chatgpt.com/backend-api/codex/responses",
          } as Model<"openai-codex-responses">,
          options: {},
        }),
    },
  ])(
    "does not force store=true for Codex responses (Codex requires store=false) ($name)",
    ({ run }) => {
      expect(run().store).toBe(false);
    },
  );

  it("strips prompt cache fields for non-OpenAI openai-responses endpoints", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "custom-proxy",
      applyModelId: "some-model",
      model: {
        api: "openai-responses",
        provider: "custom-proxy",
        id: "some-model",
        baseUrl: "https://my-proxy.example.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        prompt_cache_key: "session-xyz",
        prompt_cache_retention: "24h",
      },
    });
    expect(payload).not.toHaveProperty("prompt_cache_key");
    expect(payload).not.toHaveProperty("prompt_cache_retention");
  });

  it("keeps prompt cache fields for direct OpenAI openai-responses endpoints", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
        baseUrl: "https://api.openai.com/v1",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        prompt_cache_key: "session-123",
        prompt_cache_retention: "24h",
      },
    });
    expect(payload.prompt_cache_key).toBe("session-123");
    expect(payload.prompt_cache_retention).toBe("24h");
  });

  it("keeps prompt cache fields for direct Azure OpenAI azure-openai-responses endpoints", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "azure-openai-responses",
      applyModelId: "gpt-4o",
      model: {
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        id: "gpt-4o",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      } as unknown as Model<"azure-openai-responses">,
      payload: {
        store: false,
        prompt_cache_key: "session-azure",
        prompt_cache_retention: "24h",
      },
    });
    expect(payload.prompt_cache_key).toBe("session-azure");
    expect(payload.prompt_cache_retention).toBe("24h");
  });

  it("keeps prompt cache fields when openai-responses baseUrl is omitted", () => {
    const payload = runResponsesPayloadMutationCase({
      applyProvider: "openai",
      applyModelId: "gpt-5",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5",
      } as unknown as Model<"openai-responses">,
      payload: {
        store: false,
        prompt_cache_key: "session-default",
        prompt_cache_retention: "24h",
      },
    });
    expect(payload.prompt_cache_key).toBe("session-default");
    expect(payload.prompt_cache_retention).toBe("24h");
  });
});
