import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { vi } from "vitest";
import type { ThinkLevel } from "../../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { __testing as extraParamsTesting, applyExtraParamsToAgent } from "./extra-params.js";

vi.mock("../../plugins/provider-runtime.js", () => ({
  prepareProviderExtraParams: ({
    context,
  }: {
    context: { extraParams: Record<string, unknown> };
  }) => context.extraParams,
  wrapProviderStreamFn: () => undefined,
}));

export type ExtraParamsCapture<TPayload extends Record<string, unknown>> = {
  headers?: Record<string, string>;
  options?: SimpleStreamOptions;
  payload: TPayload;
};

function createMockStream(): ReturnType<StreamFn> {
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
  thinkingLevel?: ThinkLevel;
};

export function runExtraParamsCase<
  TApi extends "openai-completions" | "openai-responses" | "azure-openai-responses",
  TPayload extends Record<string, unknown>,
>(params: RunExtraParamsCaseParams<TApi, TPayload>): ExtraParamsCapture<TPayload> {
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
    extraParamsTesting.setProviderRuntimeDepsForTest({
      prepareProviderExtraParams: () => undefined,
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
    );
  } finally {
    if (params.mockProviderRuntime === true) {
      extraParamsTesting.resetProviderRuntimeDepsForTest();
    }
  }

  const context: Context = { messages: [] };
  void agent.streamFn?.(params.model, context, {
    ...params.options,
    headers: params.callerHeaders ?? params.options?.headers,
  });

  return captured;
}
