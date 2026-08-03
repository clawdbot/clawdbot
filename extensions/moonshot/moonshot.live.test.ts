// Moonshot tests cover moonshot plugin behavior.
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
import { buildMoonshotProvider, MOONSHOT_CN_BASE_URL } from "./provider-catalog.js";
import { createKimiWebSearchProvider } from "./src/kimi-web-search-provider.js";

const KIMI_SEARCH_KEY =
  process.env.KIMI_API_KEY?.trim() || process.env.MOONSHOT_API_KEY?.trim() || "";
const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY?.trim() || "";
const describeLive = isLiveTestEnabled() && KIMI_SEARCH_KEY.length > 0 ? describe : describe.skip;
const describeModelLive =
  isLiveTestEnabled() && MOONSHOT_API_KEY.length > 0 ? describe : describe.skip;
const KIMI_LIVE_SEARCH_TIMEOUT_SECONDS = 60;

function isTransientKimiSearchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  const message = error.message.toLowerCase();
  return message.includes("timeout") || message.includes("aborted");
}

function isMoonshotAuthDrift(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("401") &&
    (message.includes("incorrect api key") ||
      message.includes("incorrect_api_key") ||
      message.includes("invalid authentication") ||
      message.includes("invalid_authentication_error"))
  );
}

describe("moonshot live auth drift detection", () => {
  it.each([
    ["401 Incorrect API key provided", true],
    ["401 invalid_authentication_error: Invalid Authentication", true],
    ["401 Permission denied", false],
    ["400 Incorrect API key provided", false],
  ])("classifies %s", (message, expected) => {
    expect(isMoonshotAuthDrift(new Error(message))).toBe(expected);
  });
});

describeLive("moonshot plugin live", () => {
  it("runs Kimi web search through the provider tool", async () => {
    const provider = createKimiWebSearchProvider();
    const tool = provider.createTool?.({
      config: {},
      searchConfig: {
        kimi: { apiKey: KIMI_SEARCH_KEY },
        cacheTtlMinutes: 0,
        timeoutSeconds: KIMI_LIVE_SEARCH_TIMEOUT_SECONDS,
      },
    } as never);

    let result: { provider?: string; content?: unknown; citations?: unknown } | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await tool?.execute({ query: "OpenClaw GitHub", count: 1 });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (isMoonshotAuthDrift(error)) {
          console.warn("[moonshot:live] skip Kimi web search: auth drift");
          return;
        }
        if (!isTransientKimiSearchError(error) || attempt === 1) {
          throw error;
        }
      }
    }
    if (lastError) {
      throw toLintErrorObject(lastError, "Non-Error thrown");
    }

    expect(result?.provider).toBe("kimi");
    expect(typeof result?.content).toBe("string");
    expect((result!.content as string).length).toBeGreaterThan(20);
    expect(Array.isArray(result?.citations)).toBe(true);
  }, 180_000);
});

function resolveMoonshotModels(modelId: string): Model<"openai-completions">[] {
  const provider = buildMoonshotProvider();
  const model = provider.models.find((entry) => entry.id === modelId);
  if (!model) {
    throw new Error(`Moonshot catalog does not include ${modelId}`);
  }
  const defaultModel = {
    provider: "moonshot",
    baseUrl: provider.baseUrl,
    ...model,
    api: "openai-completions",
  } as Model<"openai-completions">;
  return [defaultModel, { ...defaultModel, baseUrl: MOONSHOT_CN_BASE_URL }];
}

function createNoopTool(): Tool {
  return {
    name: "noop",
    description: "Return ok.",
    parameters: Type.Object({}, { additionalProperties: false }),
  };
}

async function collectDoneMessage(
  stream: AsyncIterable<{ type: string; message?: AssistantMessage; error?: AssistantMessage }>,
): Promise<AssistantMessage> {
  let doneMessage: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "error") {
      throw new Error(event.error?.errorMessage || "Moonshot live request failed");
    }
    if (event.type === "done") {
      doneMessage = event.message;
    }
  }
  if (!doneMessage) {
    throw new Error("Moonshot live stream ended without a done message");
  }
  return doneMessage;
}

describeModelLive("moonshot K2.6 replay live", () => {
  it("accepts a cross-model tool-call replay after backfilling reasoning_content", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const wrappedStream = provider.wrapStreamFn?.({
      provider: "moonshot",
      modelId: "kimi-k2.6",
      thinkingLevel: "low",
      streamFn: streamSimple,
    } as never);
    if (!wrappedStream) {
      throw new Error("Moonshot provider did not register a stream wrapper");
    }

    const tool = createNoopTool();
    const replayContext: Context = {
      messages: [
        {
          role: "user",
          content: "Call the noop tool.",
          timestamp: Date.now(),
        },
        {
          role: "assistant",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.5",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call_cross_model", name: "noop", arguments: {} }],
          timestamp: Date.now(),
        } as AssistantMessage,
        {
          role: "toolResult",
          toolCallId: "call_cross_model",
          toolName: "noop",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: Date.now(),
        },
        {
          role: "user",
          content: "The tool returned ok. Reply with exactly: ok",
          timestamp: Date.now(),
        },
      ],
      tools: [tool],
    };

    const runScenario = async (model: Model<"openai-completions">) => {
      let payload: Record<string, unknown> | undefined;
      const response = await collectDoneMessage(
        wrappedStream(model, replayContext, {
          apiKey: MOONSHOT_API_KEY,
          maxTokens: 256,
          onPayload: (value) => {
            payload = value as Record<string, unknown>;
          },
        }) as AsyncIterable<{
          type: string;
          message?: AssistantMessage;
          error?: AssistantMessage;
        }>,
      );

      const messages = payload?.messages as Array<Record<string, unknown>> | undefined;
      const replayedAssistant = messages?.find(
        (message) => message.role === "assistant" && Array.isArray(message.tool_calls),
      );
      expect(replayedAssistant?.reasoning_content).toBe("");
      expect(response.stopReason).not.toBe("error");
    };

    let lastAuthError: unknown;
    for (const model of resolveMoonshotModels("kimi-k2.6")) {
      try {
        await runScenario(model);
        return;
      } catch (error) {
        if (!isMoonshotAuthDrift(error)) {
          throw error;
        }
        lastAuthError = error;
      }
    }
    throw toLintErrorObject(lastAuthError, "Moonshot K2.6 rejected the API key in both regions");
  }, 180_000);
});

describeModelLive("moonshot K2.7 Code live", () => {
  it("omits thinking controls and completes a replayed tool turn", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const wrappedStream = provider.wrapStreamFn?.({
      provider: "moonshot",
      modelId: "kimi-k2.7-code",
      thinkingLevel: "off",
      extraParams: { thinking: { type: "disabled", keep: "all" } },
      streamFn: streamSimple,
    } as never);
    if (!wrappedStream) {
      throw new Error("Moonshot provider did not register a stream wrapper");
    }

    const tool = createNoopTool();
    const firstUser = {
      role: "user" as const,
      content: "Call the noop tool with {}. Do not answer directly.",
      timestamp: Date.now(),
    };

    const runScenario = async (model: Model<"openai-completions">) => {
      let firstPayload: Record<string, unknown> | undefined;
      const first = await collectDoneMessage(
        wrappedStream(
          model,
          { messages: [firstUser], tools: [tool] },
          {
            apiKey: MOONSHOT_API_KEY,
            maxTokens: 16_000,
            temperature: 0,
            onPayload: (payload) => {
              firstPayload = payload as Record<string, unknown>;
            },
          },
        ) as AsyncIterable<{
          type: string;
          message?: AssistantMessage;
          error?: AssistantMessage;
        }>,
      );

      expect(firstPayload).toBeDefined();
      expect(firstPayload).not.toHaveProperty("thinking");
      expect(firstPayload).not.toHaveProperty("reasoning_effort");
      expect(firstPayload).not.toHaveProperty("temperature");
      const reasoning = first.content.find((block) => block.type === "thinking");
      if (!reasoning || reasoning.type !== "thinking" || reasoning.thinking.length === 0) {
        throw new Error("Moonshot K2.7 Code did not return captured reasoning");
      }
      const toolCall = first.content.find((block) => block.type === "toolCall");
      if (!toolCall || toolCall.type !== "toolCall") {
        throw new Error(`Moonshot K2.7 Code did not call noop: ${first.stopReason}`);
      }
      expect(toolCall.name).toBe("noop");

      let secondPayload: Record<string, unknown> | undefined;
      const replayContext: Context = {
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
            content: "Reply with exactly: ok",
            timestamp: Date.now(),
          },
        ],
        tools: [tool],
      };
      const second = await collectDoneMessage(
        wrappedStream(model, replayContext, {
          apiKey: MOONSHOT_API_KEY,
          maxTokens: 16_000,
          temperature: 0,
          onPayload: (payload) => {
            secondPayload = payload as Record<string, unknown>;
          },
        }) as AsyncIterable<{
          type: string;
          message?: AssistantMessage;
          error?: AssistantMessage;
        }>,
      );

      expect(secondPayload).toBeDefined();
      expect(secondPayload).not.toHaveProperty("thinking");
      expect(secondPayload).not.toHaveProperty("reasoning_effort");
      expect(secondPayload).not.toHaveProperty("temperature");
      const text = second.content
        .filter((block) => block.type === "text")
        .map((block) => block.text.trim())
        .join(" ");
      expect(text).toMatch(/^ok[.!]?$/i);
    };

    let lastAuthError: unknown;
    for (const model of resolveMoonshotModels("kimi-k2.7-code")) {
      try {
        await runScenario(model);
        return;
      } catch (error) {
        if (!isMoonshotAuthDrift(error)) {
          throw error;
        }
        lastAuthError = error;
      }
    }
    throw toLintErrorObject(
      lastAuthError,
      "Moonshot K2.7 Code rejected the API key in both regions",
    );
  }, 180_000);
});

describeModelLive("moonshot K3 live", () => {
  it("forces max reasoning and completes a required tool call", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const wrappedStream = provider.wrapStreamFn?.({
      provider: "moonshot",
      modelId: "kimi-k3",
      thinkingLevel: "off",
      extraParams: { thinking: { type: "disabled", keep: "all" } },
      streamFn: streamSimple,
    } as never);
    if (!wrappedStream) {
      throw new Error("Moonshot provider did not register a stream wrapper");
    }

    const runScenario = async (model: Model<"openai-completions">, liveValue: string) => {
      let capturedPayload: Record<string, unknown> | undefined;
      const response = await collectDoneMessage(
        wrappedStream(
          model,
          {
            messages: [
              {
                role: "user",
                content: "Call the noop tool with {}. Do not answer directly.",
                timestamp: Date.now(),
              },
            ],
            tools: [createNoopTool()],
          },
          {
            apiKey: liveValue,
            maxTokens: 4096,
            onPayload: (value) => {
              const payload = value as Record<string, unknown>;
              capturedPayload = payload;
              payload.thinking = { type: "disabled", keep: "all" };
              payload.reasoning_effort = "low";
              payload.reasoningEffort = "low";
              payload.temperature = 0;
              payload.top_p = 0.5;
              payload.n = 2;
              payload.presence_penalty = 1;
              payload.frequency_penalty = 1;
              payload.tool_choice = "required";
            },
          },
        ) as AsyncIterable<{
          type: string;
          message?: AssistantMessage;
          error?: AssistantMessage;
        }>,
      );

      expect(capturedPayload).toBeDefined();
      expect(capturedPayload).not.toHaveProperty("thinking");
      expect(capturedPayload).not.toHaveProperty("reasoningEffort");
      expect(capturedPayload?.reasoning_effort).toBe("max");
      expect(capturedPayload?.tool_choice).toBe("required");
      expect(capturedPayload).not.toHaveProperty("temperature");
      expect(capturedPayload).not.toHaveProperty("top_p");
      expect(capturedPayload).not.toHaveProperty("n");
      expect(capturedPayload).not.toHaveProperty("presence_penalty");
      expect(capturedPayload).not.toHaveProperty("frequency_penalty");
      const reasoning = response.content.find((block) => block.type === "thinking");
      if (!reasoning || reasoning.type !== "thinking" || reasoning.thinking.length === 0) {
        throw new Error("Moonshot K3 did not return captured reasoning");
      }
      const toolCall = response.content.find((block) => block.type === "toolCall");
      if (!toolCall || toolCall.type !== "toolCall") {
        throw new Error(`Moonshot K3 did not call noop: ${response.stopReason}`);
      }
      expect(toolCall.name).toBe("noop");
    };

    let lastAuthError: unknown;
    for (const model of resolveMoonshotModels("kimi-k3")) {
      try {
        await runScenario(model, MOONSHOT_API_KEY);
        return;
      } catch (error) {
        if (!isMoonshotAuthDrift(error)) {
          throw error;
        }
        lastAuthError = error;
      }
    }
    throw toLintErrorObject(lastAuthError, "Moonshot K3 rejected the API key in both regions");
  }, 180_000);
});

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
