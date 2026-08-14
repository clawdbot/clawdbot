import { describe, expect, it } from "vitest";
import type { Model } from "../types.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  createAssistantOutput,
  expectRecordFields,
  makeCompletionsChunk,
  makeCompletionsModel,
} from "./openai-completions.test-support.js";

function geminiToolReplayContext(
  model: Model<"openai-completions">,
  options: {
    sourceApi?: string;
    thoughtSignature?: string;
    arguments?: unknown;
    includeUserAndResult?: boolean;
  } = {},
) {
  const assistant = {
    role: "assistant",
    api: options.sourceApi ?? model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
    content: [
      {
        type: "toolCall",
        id: "call_abc",
        name: "echo_value",
        arguments: options.arguments ?? {},
        ...(options.thoughtSignature ? { thoughtSignature: options.thoughtSignature } : {}),
      },
    ],
  };
  return {
    messages: options.includeUserAndResult
      ? [
          { role: "user", content: "echo" },
          assistant,
          {
            role: "toolResult",
            toolCallId: "call_abc",
            toolName: "echo_value",
            content: [{ type: "text", text: "ok" }],
            isError: false,
          },
        ]
      : [assistant],
    tools: [],
  } as never;
}

describe("openai completions params", () => {
  describe("Gemini thought_signature round-trip on OpenAI-compatible completions", () => {
    const geminiModel = makeCompletionsModel({
      id: "gemini-3-flash-preview",
      name: "Gemini 3 Flash Preview",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      contextWindow: 1_000_000,
    });

    it("captures thought_signature from streamed Google tool_calls", async () => {
      const output = createAssistantOutput(geminiModel);
      const chunks = [
        makeCompletionsChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_abc",
              type: "function",
              function: { name: "echo_value", arguments: "" },
              extra_content: { google: { thought_signature: "SIG-OPAQUE-ABC==" } },
            },
          ],
        }),
        makeCompletionsChunk(
          {
            tool_calls: [{ index: 0, function: { arguments: '{"value":"repro"}' } }],
          },
          "tool_calls" as const,
        ),
      ] as const;
      async function* mockStream() {
        for (const chunk of chunks) {
          yield chunk as never;
        }
      }

      await processCompletionsStream(mockStream(), output, geminiModel, {
        push() {},
      });

      expectRecordFields(output.content[0], {
        type: "toolCall",
        id: "call_abc",
        name: "echo_value",
        arguments: { value: "repro" },
        thoughtSignature: "SIG-OPAQUE-ABC==",
      });
    });

    it("captures a top-level thought_signature from streamed OpenAI-compatible tool_calls", async () => {
      const veniceGeminiModel = makeCompletionsModel({
        id: "gemini-3-6-flash",
        name: "Gemini 3.6 Flash",
        provider: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
        contextWindow: 1_000_000,
      });
      const output = createAssistantOutput(veniceGeminiModel);
      const chunks = [
        makeCompletionsChunk({
          tool_calls: [
            {
              index: 0,
              id: "call_abc",
              type: "function",
              function: { name: "echo_value", arguments: '{"value":"repro"}' },
              thought_signature: "SIG-VENICE-OPAQUE-ABC==",
            },
          ],
        }),
        makeCompletionsChunk({}, "tool_calls" as const),
      ] as const;
      async function* mockStream() {
        for (const chunk of chunks) {
          yield chunk as never;
        }
      }

      await processCompletionsStream(mockStream(), output, veniceGeminiModel, {
        push() {},
      });

      expectRecordFields(output.content[0], {
        type: "toolCall",
        id: "call_abc",
        name: "echo_value",
        arguments: { value: "repro" },
        thoughtSignature: "SIG-VENICE-OPAQUE-ABC==",
      });
    });

    it("re-emits captured thought_signature for same Google route tool-call replay", () => {
      const params = buildOpenAICompletionsParams(
        geminiModel,
        geminiToolReplayContext(geminiModel, {
          thoughtSignature: "SIG-OPAQUE-ABC==",
          arguments: { value: "repro" },
          includeUserAndResult: true,
        }),
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(
        "SIG-OPAQUE-ABC==",
      );
    });

    it("uses the Gemini skip-validator signature across a different API surface", () => {
      const params = buildOpenAICompletionsParams(
        geminiModel,
        geminiToolReplayContext(geminiModel, {
          sourceApi: "google-generative-ai",
          thoughtSignature: "SIG-OPAQUE-ABC==",
          arguments: { value: "repro" },
        }),
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(
        "skip_thought_signature_validator",
      );
    });

    it("uses the Gemini skip-validator signature when no thought_signature was captured", () => {
      const params = buildOpenAICompletionsParams(
        geminiModel,
        geminiToolReplayContext(geminiModel),
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(
        "skip_thought_signature_validator",
      );
    });

    it("falls back to skip_thought_signature_validator when a captured same-route Gemini 3 signature is truncated", () => {
      // Compaction-truncated sig: 109 chars, length mod 4 == 1.
      // Same-route assistant tool-call whose captured thoughtSignature is truncated.
      // The guard should fall back to the sentinel instead of dropping the field.
      const params = buildOpenAICompletionsParams(
        geminiModel,
        geminiToolReplayContext(geminiModel, {
          arguments: { value: "repro" },
          thoughtSignature:
            "CmcBjz1rX55U6JcpC2oZVTk40Kx6nVK8LKzbl61rOFztcvSdL7pdIvBEDyJLRqWrPVpdD+rj3GsJ3f9PG6b2Ry2UnK38+dInfGIlJbXHt++EC",
        }),
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(
        "skip_thought_signature_validator",
      );
    });

    it("drops the field when the model is not Gemini 3 and the captured same-route signature is truncated", () => {
      // gemini-2.5-pro: requiresGoogleCompatToolCallThoughtSignature returns false,
      // so fallbackSig is undefined and there is no sentinel to fall back to.
      // A truncated same-route sig should cause the field to be dropped entirely.
      const nonGemini3Model = {
        ...geminiModel,
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
      };
      const params = buildOpenAICompletionsParams(
        nonGemini3Model,
        geminiToolReplayContext(nonGemini3Model, {
          arguments: { value: "repro" },
          thoughtSignature:
            "CmcBjz1rX55U6JcpC2oZVTk40Kx6nVK8LKzbl61rOFztcvSdL7pdIvBEDyJLRqWrPVpdD+rj3GsJ3f9PG6b2Ry2UnK38+dInfGIlJbXHt++EC",
        }),
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBeUndefined();
    });

    it("does not trust cross-route thought_signature for non-Gemini-3 Google compat models", () => {
      const nonGemini3Model = {
        ...geminiModel,
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
      };
      const params = buildOpenAICompletionsParams(
        nonGemini3Model,
        geminiToolReplayContext(nonGemini3Model, {
          sourceApi: "google-generative-ai",
          thoughtSignature: "SIG-OPAQUE-ABC==",
          arguments: { value: "repro" },
        }),
        undefined,
      ) as { messages: Array<Record<string, unknown>> };

      const assistant = params.messages.find((message) => message.role === "assistant") as
        | { tool_calls?: Array<{ extra_content?: unknown }> }
        | undefined;
      expect(assistant?.tool_calls?.[0]?.extra_content).toBeUndefined();
    });

    it.each([
      ["gemini-pro-latest", "Gemini Pro Latest"],
      ["gemini-flash-latest", "Gemini Flash Latest"],
      ["gemini-flash-lite-latest", "Gemini Flash Lite Latest"],
    ])(
      "uses the Gemini skip-validator signature for unsigned tool calls on %s",
      (modelId, modelName) => {
        const latestModel = { ...geminiModel, id: modelId, name: modelName };
        const params = buildOpenAICompletionsParams(
          latestModel,
          geminiToolReplayContext(latestModel),
          undefined,
        ) as { messages: Array<Record<string, unknown>> };

        const assistant = params.messages.find((message) => message.role === "assistant") as
          | { tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }
          | undefined;
        expect(assistant?.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe(
          "skip_thought_signature_validator",
        );
      },
    );
  });
});
