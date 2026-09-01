// Shared harness for extra-params wrapper tests.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Context, Model, SimpleStreamOptions } from "../../llm/types.js";
import type {
  prepareProviderExtraParams,
  resolveProviderExtraParamsForTransport,
  wrapProviderStreamFn,
} from "../../plugins/provider-hook-runtime.js";
import type { StreamFn } from "../runtime/index.js";
import { applyExtraParamsToAgent } from "./extra-params.js";
import type { ProviderThinkLevel } from "./utils.js";

type ExtraParamsTestApi = {
  setProviderRuntimeDepsForTest(
    deps:
      | Partial<{
          prepareProviderExtraParams: typeof prepareProviderExtraParams;
          resolveProviderExtraParamsForTransport: typeof resolveProviderExtraParamsForTransport;
          wrapProviderStreamFn: typeof wrapProviderStreamFn;
        }>
      | undefined,
  ): void;
  resetProviderRuntimeDepsForTest(): void;
};

function getTestApi(): ExtraParamsTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.extraParamsTestApi")
  ];
  if (!api) {
    throw new Error("extra params test API is unavailable");
  }
  return api as ExtraParamsTestApi;
}

export const testing = getTestApi();

type ExtraParamsCapture<TPayload extends Record<string, unknown>> = {
  headers?: Record<string, string>;
  options?: SimpleStreamOptions;
  payload: TPayload;
};

function createMockStream(): ReturnType<StreamFn> {
  // Minimal async stream surface for wrappers that decorate push/result/iterate
  // behavior without needing a real model provider.
  return {
    push() {},
    async result() {
      return undefined;
    },
    async *[Symbol.asyncIterator]() {
      // Minimal async stream surface for wrappers that decorate iteration.
    },
  } as unknown as ReturnType<StreamFn>;
}

type RunExtraParamsCaseParams<
  TApi extends "openai-completions" | "openai-responses" | "azure-openai-responses",
  TPayload extends Record<string, unknown>,
> = {
  applyModelId?: string;
  applyProvider?: string;
  callerHeaders?: Record<string, string>;
  cfg?: OpenClawConfig;
  model: Model<TApi>;
  mockProviderRuntime?: boolean;
  options?: SimpleStreamOptions;
  payload: TPayload;
  thinkingLevel?: ProviderThinkLevel;
  workspaceDir?: string;
};

export function runExtraParamsCase<
  TApi extends "openai-completions" | "openai-responses" | "azure-openai-responses",
  TPayload extends Record<string, unknown>,
>(params: RunExtraParamsCaseParams<TApi, TPayload>): ExtraParamsCapture<TPayload> {
  // Capture both transport options and payload mutation, which are the two
  // public effects of applyExtraParamsToAgent.
  const captured: ExtraParamsCapture<TPayload> = {
    payload: params.payload,
  };

  const baseStreamFn: StreamFn = (model, _context, options) => {
    captured.headers = options?.headers;
    captured.options = options;
    options?.onPayload?.(params.payload, model);
    return createMockStream();
  };
  const agent = { streamFn: baseStreamFn };

  if (params.mockProviderRuntime === true) {
    testing.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: () => undefined,
      resolveProviderExtraParamsForTransport: () => undefined,
      wrapProviderStreamFn: () => undefined,
    });
  }
  try {
    applyExtraParamsToAgent(
      agent,
      params.cfg,
      params.applyProvider ?? params.model.provider,
      params.applyModelId ?? params.model.id,
      undefined,
      params.thinkingLevel,
      undefined,
      params.workspaceDir,
    );
  } finally {
    if (params.mockProviderRuntime === true) {
      testing.resetProviderRuntimeDepsForTest();
    }
  }

  const context: Context = { messages: [] };
  void agent.streamFn?.(params.model, context, {
    ...params.options,
    headers: params.callerHeaders ?? params.options?.headers,
  });

  return captured;
}
