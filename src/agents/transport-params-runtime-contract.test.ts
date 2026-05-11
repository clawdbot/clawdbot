import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GPT_PARALLEL_TOOL_CALLS_PAYLOAD_APIS,
  NON_OPENAI_GPT5_TRANSPORT_CASE,
  OPENAI_GPT5_TRANSPORT_DEFAULT_CASES,
  OPENAI_GPT5_TRANSPORT_DEFAULTS,
  UNRELATED_TOOL_CALLS_PAYLOAD_APIS,
} from "../../test/helpers/agents/transport-params-runtime-contract.js";
import {
  __testing as extraParamsTesting,
  applyExtraParamsToAgent,
  resolveExtraParams,
  resolvePreparedExtraParams,
} from "./pi-embedded-runner/extra-params.js";
import { createOpenAIThinkingLevelWrapper } from "./pi-embedded-runner/openai-stream-wrappers.js";
import { supportsGptParallelToolCallsPayload } from "./provider-api-families.js";

beforeEach(() => {
  installNoopProviderRuntimeDeps();
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

describe("transport params runtime contract (Pi/OpenAI path)", () => {
  it.each(OPENAI_GPT5_TRANSPORT_DEFAULT_CASES)(
    "applies OpenAI GPT-5 transport defaults for $provider/$modelId",
    ({ provider, modelId }) => {
      expect(resolveExtraParams({ cfg: undefined, provider, modelId })).toEqual(
        OPENAI_GPT5_TRANSPORT_DEFAULTS,
      );
    },
  );

  it("does not leak OpenAI GPT-5 defaults to non-OpenAI providers", () => {
    expect(
      resolveExtraParams({
        cfg: undefined,
        provider: NON_OPENAI_GPT5_TRANSPORT_CASE.provider,
        modelId: NON_OPENAI_GPT5_TRANSPORT_CASE.modelId,
      }),
    ).toBeUndefined();
  });

  it("normalizes aliased caller params without losing explicit overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {
              params: {
                parallelToolCalls: false,
                textVerbosity: "medium",
                cached_content: "conversation-cache",
              },
            },
          },
        },
      },
    };

    expect(resolveExtraParams({ cfg, provider: "openai", modelId: "gpt-5.4" })).toEqual({
      parallel_tool_calls: false,
      text_verbosity: "medium",
      cachedContent: "conversation-cache",
    });
  });

  it.each(GPT_PARALLEL_TOOL_CALLS_PAYLOAD_APIS)(
    "advertises %s as accepting the GPT parallel_tool_calls payload patch",
    (api) => {
      expect(supportsGptParallelToolCallsPayload(api)).toBe(true);
    },
  );

  it.each(UNRELATED_TOOL_CALLS_PAYLOAD_APIS)(
    "does not advertise %s as accepting the GPT parallel_tool_calls payload patch",
    (api) => {
      expect(supportsGptParallelToolCallsPayload(api)).toBe(false);
    },
  );

  it("injects parallel_tool_calls into openai-codex Responses payloads", () => {
    const payload = runPayloadMutation({
      applyProvider: "openai-codex",
      applyModelId: "gpt-5.4",
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.4",
      } as Model<"openai-codex-responses">,
    });

    expect(payload.parallel_tool_calls).toBe(true);
  });

  it("maps OpenAI GPT-5 thinking level into Responses reasoning effort payloads", () => {
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: () => undefined,
      resolveProviderExtraParamsForTransport: () => undefined,
      wrapProviderStreamFn: (params) =>
        createOpenAIThinkingLevelWrapper(params.context.streamFn, params.context.thinkingLevel),
    });

    const payload = runPayloadMutation({
      applyProvider: "openai-codex",
      applyModelId: "gpt-5.4",
      thinkingLevel: "high",
      model: {
        api: "openai-codex-responses",
        provider: "openai-codex",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api",
      } as Model<"openai-codex-responses">,
      payload: { reasoning: { effort: "none", summary: "auto" } },
    });

    expect(payload.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  it("composes provider preparation before transport patch resolution", () => {
    const resolveProviderExtraParamsForTransport = vi.fn((_params: unknown) => ({
      patch: {
        parallel_tool_calls: false,
        transportHookApplied: true,
      },
    }));
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: (params) => ({
        ...params.context.extraParams,
        transport: "websocket",
        preparedByProvider: true,
      }),
      resolveProviderExtraParamsForTransport,
      wrapProviderStreamFn: (params) => params.context.streamFn,
    });

    const prepared = resolvePreparedExtraParams({
      cfg: undefined,
      provider: "openai",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
      } as Model<"openai-responses">,
    });

    expect(prepared?.transport).toBe("websocket");
    expect(prepared?.preparedByProvider).toBe(true);
    expect(prepared?.parallel_tool_calls).toBe(false);
    expect(prepared?.transportHookApplied).toBe(true);
    const transportInput = resolveProviderExtraParamsForTransport.mock.calls[0]?.[0] as
      | {
          context?: {
            extraParams?: { preparedByProvider?: boolean };
            transport?: string;
          };
        }
      | undefined;
    expect(transportInput?.context?.extraParams?.preparedByProvider).toBe(true);
    expect(transportInput?.context?.transport).toBe("websocket");
  });
});

function runPayloadMutation(params: {
  applyProvider: string;
  applyModelId: string;
  model: Model<"openai-codex-responses"> | Model<"openai-responses">;
  thinkingLevel?: Parameters<typeof applyExtraParamsToAgent>[5];
  payload?: Record<string, unknown>;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = params.payload ?? {};
  const baseStreamFn: StreamFn = (model, _context, options) => {
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };
  applyExtraParamsToAgent(
    agent,
    undefined,
    params.applyProvider,
    params.applyModelId,
    undefined,
    params.thinkingLevel,
  );
  const context: Context = { messages: [] };
  void agent.streamFn?.(params.model, context, {});
  return payload;
}

function installNoopProviderRuntimeDeps() {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: () => undefined,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: (params) => params.context.streamFn,
  });
}
