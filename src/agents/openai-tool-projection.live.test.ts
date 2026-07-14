import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions.js";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { createCodexNativeWebSearchWrapper } from "../llm/providers/stream-wrappers/openai.js";
import type { Context, Model } from "../llm/types.js";
import { isLiveTestEnabled } from "./live-test-helpers.js";
import {
  buildOpenAICompletionsParams,
  createOpenAIResponsesTransportStreamFn,
  testing as openAITransportTesting,
} from "./openai-transport-stream.js";

const { buildOpenAIResponsesParams } = openAITransportTesting;

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const LIVE = isLiveTestEnabled(["OPENAI_LIVE_TEST"]) && Boolean(OPENAI_KEY);
const describeLive = LIVE ? describe : describe.skip;

const probeTools = [
  {
    name: "unreadable_probe",
    description: "Unreadable probe.",
    parameters: {
      type: "object",
      get properties(): never {
        throw new Error("live unreadable nested schema getter");
      },
    },
  },
  {
    name: "live_probe",
    description: "Return the requested probe value.",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
];

const context = {
  systemPrompt: "Call the requested function exactly once.",
  messages: [
    {
      role: "user",
      content: "Call live_probe with value exactly OPENAI_PROJECTION_OK.",
      timestamp: 1,
    },
  ],
  tools: probeTools,
} satisfies Context;

describeLive("OpenAI tool projection live", () => {
  const modelId = process.env.OPENCLAW_LIVE_OPENAI_TOOL_MODEL || "gpt-5.6-luna";
  const client = new OpenAI({ apiKey: OPENAI_KEY });

  it("calls a healthy Responses function after quarantining an unreadable sibling", async () => {
    const model = {
      id: modelId,
      name: modelId,
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 256,
    } satisfies Model<"openai-responses">;
    const params = buildOpenAIResponsesParams(model, context, {
      maxTokens: 128,
      reasoning: "low",
      toolChoice: { type: "function", name: "live_probe" },
    });

    const response = await client.responses.create({
      ...params,
      stream: false,
    } as unknown as ResponseCreateParamsNonStreaming);
    const toolCall = response.output.find((item) => item.type === "function_call");

    expect(toolCall).toMatchObject({
      type: "function_call",
      name: "live_probe",
    });
    expect(JSON.parse(toolCall?.arguments ?? "{}")).toEqual({
      value: "OPENAI_PROJECTION_OK",
    });
  }, 45_000);

  it("calls a GPT-5.6 Chat Completions function with reasoning disabled", async () => {
    const model = {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 256,
    } satisfies Model<"openai-completions">;
    const params = buildOpenAICompletionsParams(model, context, {
      maxTokens: 128,
      reasoning: "low",
      toolChoice: {
        type: "allowed_tools",
        allowed_tools: {
          mode: "required",
          tools: [
            { type: "function", function: { name: "unreadable_probe" } },
            { type: "function", function: { name: "live_probe" } },
          ],
        },
      },
    });
    expect(params.reasoning_effort).toBe("none");
    const { stream_options: _streamOptions, ...nonStreamingParams } = params;

    const response = await client.chat.completions.create({
      ...nonStreamingParams,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming);
    const toolCall = response.choices[0]?.message.tool_calls?.[0];

    if (!toolCall || toolCall.type !== "function") {
      throw new Error("OpenAI did not return the expected function tool call");
    }
    expect(toolCall).toMatchObject({
      type: "function",
      function: { name: "live_probe" },
    });
    expect(JSON.parse(toolCall.function.arguments)).toEqual({
      value: "OPENAI_PROJECTION_OK",
    });
  }, 45_000);

  it("keeps code-mode tools after a payload hook adds an unreadable sibling", async () => {
    const model = {
      id: modelId,
      name: modelId,
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 256,
    } satisfies Model<"openai-responses">;
    const codeModeContext = {
      systemPrompt: "Call the requested function exactly once.",
      messages: [
        {
          role: "user",
          content: "Call exec with value exactly OPENAI_POST_HOOK_OK.",
          timestamp: 1,
        },
      ],
      tools: [
        {
          name: "exec",
          description: "Return the requested probe value.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
        {
          name: "wait",
          description: "Wait without doing work.",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    } satisfies Context;
    const streamFn = createCodexNativeWebSearchWrapper(createOpenAIResponsesTransportStreamFn(), {
      codeModeToolSurfaceEnabled: true,
    });
    const streamOptions = {
      apiKey: OPENAI_KEY,
      maxTokens: 128,
      reasoning: "low",
      toolChoice: { type: "function", name: "exec" },
      openclawCodeModeToolSurface: true,
      onPayload(payload: unknown) {
        const record = payload as Record<string, unknown>;
        const tools = record.tools;
        if (!Array.isArray(tools) || tools.length !== 2) {
          throw new Error("Expected projected exec and wait tools");
        }
        record.tools = [
          tools[0],
          {
            type: "function",
            get function(): { name: string } {
              throw new Error("live unreadable post-hook function getter");
            },
          },
          tools[1],
        ];
        return record;
      },
    } satisfies Parameters<typeof streamFn>[2] & {
      reasoning: "low";
      toolChoice: { type: "function"; name: string };
      openclawCodeModeToolSurface: true;
    };
    const stream = await Promise.resolve(streamFn(model, codeModeContext, streamOptions));

    const result = await stream.result();
    const toolCall = result.content.find(
      (block) => block.type === "toolCall" && block.name === "exec",
    );

    expect(result.stopReason).toBe("toolUse");
    expect(toolCall).toMatchObject({
      type: "toolCall",
      name: "exec",
      arguments: { value: "OPENAI_POST_HOOK_OK" },
    });
  }, 45_000);
});
