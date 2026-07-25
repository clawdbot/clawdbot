import {
  streamSimple,
  type AssistantMessage,
  type Context,
  type Model,
  type Tool,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { buildKimiCodingProvider } from "./provider-catalog.js";

const describeLive =
  isLiveTestEnabled() && process.env.KIMI_API_KEY?.trim() ? describe : describe.skip;

async function collectDoneMessage(
  stream: AsyncIterable<{ type: string; message?: AssistantMessage; error?: AssistantMessage }>,
): Promise<AssistantMessage> {
  let doneMessage: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "error") {
      throw new Error(event.error?.errorMessage || "Kimi live request failed");
    }
    if (event.type === "done") {
      doneMessage = event.message;
    }
  }
  if (!doneMessage) {
    throw new Error("Kimi live stream ended without a done message");
  }
  return doneMessage;
}

function resolveModel(modelId: "k3" | "k3[1m]"): Model<"anthropic-messages"> {
  const provider = buildKimiCodingProvider();
  const definition = provider.models.find((model) => model.id === modelId);
  if (!definition) {
    throw new Error(`Missing model ${modelId}`);
  }
  return {
    provider: "kimi",
    baseUrl: provider.baseUrl,
    headers: provider.headers,
    ...definition,
    api: "anthropic-messages",
  } as Model<"anthropic-messages">;
}

function countContentChars(message: AssistantMessage, type: "text" | "thinking"): number {
  return message.content.reduce((total, block) => {
    if (type === "text" && block.type === "text") {
      return total + block.text.length;
    }
    if (type === "thinking" && block.type === "thinking") {
      return total + block.thinking.length;
    }
    return total;
  }, 0);
}

async function runReasoningScenario(params: {
  modelId: "k3" | "k3[1m]";
  thinkingLevel: "off" | "max";
}): Promise<AssistantMessage> {
  const registered = await registerSingleProviderPlugin(plugin);
  const wrapped = registered.wrapStreamFn?.({
    provider: "kimi",
    modelId: params.modelId,
    thinkingLevel: params.thinkingLevel,
    extraParams: { thinking: params.thinkingLevel === "off" ? "off" : "enabled" },
    streamFn: streamSimple,
  } as never);
  if (!wrapped) {
    throw new Error("Missing Kimi stream wrapper");
  }

  const context: Context = {
    messages: [
      {
        role: "user",
        content: "Reply with exactly LIVE_OK and no punctuation.",
        timestamp: Date.now(),
      },
    ],
  };
  return collectDoneMessage(
    wrapped(resolveModel(params.modelId), context, {
      apiKey: process.env.KIMI_API_KEY?.trim() ?? "",
      maxTokens: 4096,
    }) as AsyncIterable<{
      type: string;
      message?: AssistantMessage;
      error?: AssistantMessage;
    }>,
  );
}

describeLive("Kimi Code K3 reasoning live", () => {
  it.each(["k3", "k3[1m]"] as const)(
    "%s honors off and max reasoning",
    async (modelId) => {
      const off = await runReasoningScenario({ modelId, thinkingLevel: "off" });
      expect(countContentChars(off, "thinking")).toBe(0);
      expect(countContentChars(off, "text")).toBeGreaterThan(0);

      const max = await runReasoningScenario({ modelId, thinkingLevel: "max" });
      expect(countContentChars(max, "thinking")).toBeGreaterThan(0);
      expect(countContentChars(max, "text")).toBeGreaterThan(0);
    },
    180_000,
  );

  it("preserves reasoning across a K3 tool-result replay", async () => {
    const registered = await registerSingleProviderPlugin(plugin);
    const wrapped = registered.wrapStreamFn?.({
      provider: "kimi",
      modelId: "k3",
      thinkingLevel: "max",
      streamFn: streamSimple,
    } as never);
    if (!wrapped) {
      throw new Error("Missing Kimi stream wrapper");
    }

    const tool: Tool = {
      name: "noop",
      description: "Return ok.",
      parameters: Type.Object({}, { additionalProperties: false }),
    };
    const firstUser = {
      role: "user" as const,
      content: "Call the noop tool with an empty object. Do not answer directly.",
      timestamp: Date.now(),
    };
    const first = await collectDoneMessage(
      wrapped(
        resolveModel("k3"),
        { messages: [firstUser], tools: [tool] },
        { apiKey: process.env.KIMI_API_KEY?.trim() ?? "", maxTokens: 4096 },
      ) as AsyncIterable<{
        type: string;
        message?: AssistantMessage;
        error?: AssistantMessage;
      }>,
    );
    expect(countContentChars(first, "thinking")).toBeGreaterThan(0);
    const toolCall = first.content.find((block) => block.type === "toolCall");
    if (!toolCall || toolCall.type !== "toolCall") {
      throw new Error(`Kimi K3 did not call noop: ${first.stopReason}`);
    }
    expect(toolCall.name).toBe("noop");

    const second = await collectDoneMessage(
      wrapped(
        resolveModel("k3"),
        {
          messages: [
            firstUser,
            first,
            {
              role: "toolResult",
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              content: [{ type: "text", text: "ok" }],
              isError: false,
              timestamp: Date.now(),
            },
            {
              role: "user",
              content: "Reply with exactly LIVE_OK and no punctuation.",
              timestamp: Date.now(),
            },
          ],
          tools: [tool],
        },
        { apiKey: process.env.KIMI_API_KEY?.trim() ?? "", maxTokens: 4096 },
      ) as AsyncIterable<{
        type: string;
        message?: AssistantMessage;
        error?: AssistantMessage;
      }>,
    );
    expect(countContentChars(second, "text")).toBeGreaterThan(0);
  }, 180_000);
});
