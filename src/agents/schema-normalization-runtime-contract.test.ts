import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  createNativeOpenAIResponsesModel,
  createParameterFreeTool,
  createPermissiveTool,
  createStrictCompatibleTool,
  normalizedParameterFreeSchema,
} from "../../test/helpers/agents/schema-normalization-runtime-contract.js";
import { buildProviderToolCompatFamilyHooks } from "../plugin-sdk/provider-tools.js";
import { buildOpenAIResponsesParams } from "./openai-transport-stream.js";
import { convertTools as convertWebSocketTools } from "./openai-ws-message-conversion.js";
import { createOpenAIResponsesContextManagementWrapper } from "./pi-embedded-runner/openai-stream-wrappers.js";

describe("OpenAI transport schema normalization runtime contract", () => {
  it("keeps HTTP Responses and WebSocket strict decisions aligned for the same tool set", () => {
    const tools = [createStrictCompatibleTool(), createPermissiveTool()] as never;
    const httpParams = buildOpenAIResponsesParams(
      createNativeOpenAIResponsesModel() as never,
      { systemPrompt: "system", messages: [], tools } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: unknown }> };
    const wsTools = convertWebSocketTools(tools, { strict: true });

    expect(httpParams.tools?.map((tool) => tool.strict)).toEqual([false, false]);
    expect(wsTools.map((tool) => tool.strict)).toEqual([false, false]);
  });

  it("normalizes parameter-free tool schemas to the same strict-compatible object shape for HTTP Responses and WebSocket", () => {
    const tools = [createParameterFreeTool()] as never;
    const httpParams = buildOpenAIResponsesParams(
      createNativeOpenAIResponsesModel() as never,
      { systemPrompt: "system", messages: [], tools } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: unknown }> };
    const wsTools = convertWebSocketTools(tools, { strict: true });
    const normalizedSchema = normalizedParameterFreeSchema();

    expect(httpParams.tools?.[0]?.strict).toBe(true);
    expect(wsTools[0]?.strict).toBe(true);
    expect(httpParams.tools?.[0]?.parameters).toEqual(normalizedSchema);
    expect(wsTools[0]?.parameters).toEqual(normalizedSchema);
  });

  it("keeps provider-prepared parameter-free schemas strict-compatible across HTTP Responses and WebSocket", () => {
    const hooks = buildProviderToolCompatFamilyHooks("openai");
    const tools = hooks.normalizeToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      tools: [createParameterFreeTool()] as never,
    }) as never;
    const httpParams = buildOpenAIResponsesParams(
      createNativeOpenAIResponsesModel() as never,
      { systemPrompt: "system", messages: [], tools } as never,
      undefined,
    ) as { tools?: Array<{ strict?: boolean; parameters?: unknown }> };
    const wsTools = convertWebSocketTools(tools, { strict: true });
    const normalizedSchema = normalizedParameterFreeSchema();

    expect(httpParams.tools?.[0]?.strict).toBe(true);
    expect(wsTools[0]?.strict).toBe(true);
    expect(httpParams.tools?.[0]?.parameters).toEqual(normalizedSchema);
    expect(wsTools[0]?.parameters).toEqual(normalizedSchema);
  });

  it("passes prepared executable schemas through compaction-triggered Responses requests", () => {
    const hooks = buildProviderToolCompatFamilyHooks("openai");
    const tools = hooks.normalizeToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      tools: [createParameterFreeTool()] as never,
    }) as never;
    const model = createNativeOpenAIResponsesModel() as never;
    let payload:
      | { context_management?: unknown; tools?: Array<{ parameters?: unknown }> }
      | undefined;
    const baseStreamFn: StreamFn = (modelArg, contextArg, optionsArg) => {
      payload = buildOpenAIResponsesParams(
        modelArg,
        {
          ...(contextArg as unknown as Record<string, unknown>),
          systemPrompt: "system",
          messages: [],
          tools,
        } as never,
        optionsArg as never,
      ) as typeof payload;
      optionsArg?.onPayload?.(payload, modelArg);
      return {} as ReturnType<StreamFn>;
    };
    const streamFn = createOpenAIResponsesContextManagementWrapper(baseStreamFn, {
      responsesServerCompaction: true,
    });

    void streamFn(model, { systemPrompt: "system", messages: [], tools } as never, {});

    expect(payload?.context_management).toEqual([
      {
        type: "compaction",
        compact_threshold: 140_000,
      },
    ]);
    expect(payload?.tools?.[0]?.parameters).toEqual(normalizedParameterFreeSchema());
  });
});
