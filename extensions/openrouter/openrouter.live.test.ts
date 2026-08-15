// Openrouter tests cover openrouter plugin behavior.
import OpenAI from "openai";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { normalizeOpenRouterApiModelId } from "./models.js";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_MISTRAL_PROVIDER_PREFIX = "mistralai/";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const LIVE_MODEL_REF =
  process.env.OPENCLAW_LIVE_OPENROUTER_PLUGIN_MODEL?.trim() ||
  "openrouter/anthropic/claude-sonnet-4.6";
const LIVE_MODEL_ID = LIVE_MODEL_REF.startsWith("openrouter/")
  ? LIVE_MODEL_REF
  : `openrouter/${LIVE_MODEL_REF}`;
const LIVE_CACHE_MODEL_ID =
  process.env.OPENCLAW_LIVE_OPENROUTER_CACHE_MODEL?.trim() || "deepseek/deepseek-v3.2";
const liveEnabled = OPENROUTER_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const liveCatalogEnabled = process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;
const describeCatalogLive = liveCatalogEnabled ? describe : describe.skip;
const describeCacheLive =
  liveEnabled && process.env.OPENCLAW_LIVE_CACHE_TEST === "1" ? describe : describe.skip;
const ModelRegistryCtor = ModelRegistry as unknown as {
  new (authStorage: AuthStorage, modelsJsonPath?: string): ModelRegistry;
};
type OpenRouterModelsResponse = {
  data?: Array<{ id?: unknown }>;
};

const registerOpenRouterPlugin = async () =>
  registerProviderPlugin({
    plugin,
    id: "openrouter",
    name: "OpenRouter Provider",
  });

function buildStableCachePrefix(): string {
  return Array.from(
    { length: 700 },
    (_, index) =>
      `Stable OpenRouter cache probe sentence ${
        index % 20
      }: this prefix must stay byte-identical across repeated requests.`,
  ).join("\n");
}

async function completeOpenRouterChat(params: {
  client: OpenAI;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  model: string;
}) {
  return params.client.chat.completions.create({
    model: params.model,
    messages: params.messages,
    max_tokens: 8,
  });
}

async function expectWeatherToolCall(client: OpenAI, model: string): Promise<void> {
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "Call get_weather for Paris." }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a city.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: "get_weather" },
    },
    max_tokens: 64,
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.find(
    (call) => call.type === "function",
  );
  expect(toolCall?.type).toBe("function");
  expect(toolCall?.function.name).toBe("get_weather");
  expect(JSON.parse(toolCall?.function.arguments ?? "{}")).toMatchObject({ city: "Paris" });
}

async function fetchOpenRouterModelIds(): Promise<string[]> {
  const response = await fetch(OPENROUTER_MODELS_URL, {
    headers: { "accept-encoding": "identity" },
  });
  expect(response.ok).toBe(true);
  const json = (await response.json()) as OpenRouterModelsResponse;
  return (json.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

describeLive("openrouter plugin live", () => {
  it("normalizes a prefixed OpenRouter model and completes a live tool call", async () => {
    const { providers } = await registerOpenRouterPlugin();
    const provider = requireRegisteredProvider(providers, "openrouter");

    const resolved = provider.resolveDynamicModel?.({
      provider: "openrouter",
      modelId: LIVE_MODEL_ID,
      modelRegistry: new ModelRegistryCtor(AuthStorage.inMemory()),
    });
    if (!resolved) {
      throw new Error(`openrouter provider did not resolve ${LIVE_MODEL_ID}`);
    }

    expect(resolved.provider).toBe("openrouter");
    expect(resolved.id).toBe(LIVE_MODEL_ID);
    expect(resolved.api).toBe("openai-completions");
    expect(resolved.baseUrl).toBe("https://openrouter.ai/api/v1");

    const normalized =
      provider.normalizeResolvedModel?.({
        provider: "openrouter",
        modelId: resolved.id,
        model: resolved,
      }) ?? resolved;
    expect(normalized.id).toBe(normalizeOpenRouterApiModelId(LIVE_MODEL_ID));

    const client = new OpenAI({
      apiKey: OPENROUTER_API_KEY,
      baseURL: normalized.baseUrl,
    });
    const autoResolved = provider.resolveDynamicModel?.({
      provider: "openrouter",
      modelId: "openrouter/auto",
      modelRegistry: new ModelRegistryCtor(AuthStorage.inMemory()),
    });
    if (!autoResolved) {
      throw new Error("openrouter provider did not resolve openrouter/auto");
    }
    const autoModel =
      provider.normalizeResolvedModel?.({
        provider: "openrouter",
        modelId: autoResolved.id,
        model: autoResolved,
      }) ?? autoResolved;
    expect(autoModel.id).toBe("openrouter/auto");
    await expectWeatherToolCall(client, autoModel.id);
    await expectWeatherToolCall(client, normalized.id);
  }, 30_000);

  it("preserves a billed zero from the live free route", async () => {
    const { providers } = await registerOpenRouterPlugin();
    const provider = requireRegisteredProvider(providers, "openrouter");
    const resolved = provider.resolveDynamicModel?.({
      provider: "openrouter",
      modelId: "openrouter/free",
      modelRegistry: new ModelRegistryCtor(AuthStorage.inMemory()),
    });
    if (!resolved) {
      throw new Error("openrouter provider did not resolve openrouter/free");
    }
    const model =
      provider.normalizeResolvedModel?.({
        provider: "openrouter",
        modelId: resolved.id,
        model: resolved,
      }) ?? resolved;
    const wrapped = provider.wrapStreamFn?.({
      provider: "openrouter",
      modelId: model.id,
      streamFn: streamSimple,
    } as never);
    if (!wrapped) {
      throw new Error("openrouter provider did not expose its stream wrapper");
    }

    const stream = await wrapped(
      model,
      {
        messages: [
          {
            role: "user",
            content: "Reply with exactly OK.",
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey: OPENROUTER_API_KEY, maxTokens: 16 },
    );
    const message = await stream.result();

    expect(message.usage.cost.total).toBe(0);
    expect(message.usage.cost.totalOrigin).toBe("provider-billed");
  }, 30_000);
});

describeCatalogLive("openrouter plugin live model catalog", () => {
  it("applies strict9 replay policy to current OpenRouter Mistral-family routes", async () => {
    const liveMistralModelIds = (await fetchOpenRouterModelIds()).filter((id) =>
      id.startsWith(OPENROUTER_MISTRAL_PROVIDER_PREFIX),
    );
    expect(liveMistralModelIds.length).toBeGreaterThan(0);

    const { providers } = await registerOpenRouterPlugin();
    const provider = requireRegisteredProvider(providers, "openrouter");

    for (const modelId of liveMistralModelIds) {
      const policy = provider.buildReplayPolicy?.({
        provider: "openrouter",
        modelApi: "openai-completions",
        modelId,
      } as never);
      expect.soft(policy?.sanitizeToolCallIds, modelId).toBe(true);
      expect.soft(policy?.toolCallIdMode, modelId).toBe("strict9");
    }
  }, 30_000);
});

describeCacheLive("openrouter plugin live cache", () => {
  it("observes automatic cache reads for DeepSeek model refs after cache construction", async () => {
    const { providers } = await registerOpenRouterPlugin();
    const provider = requireRegisteredProvider(providers, "openrouter");
    const resolved = provider.resolveDynamicModel?.({
      provider: "openrouter",
      modelId: LIVE_CACHE_MODEL_ID,
      modelRegistry: new ModelRegistryCtor(AuthStorage.inMemory()),
    });
    if (!resolved) {
      throw new Error(`openrouter provider did not resolve ${LIVE_CACHE_MODEL_ID}`);
    }

    const client = new OpenAI({
      apiKey: OPENROUTER_API_KEY,
      baseURL: resolved.baseUrl,
    });
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `You are testing prompt caching.\n${buildStableCachePrefix()}`,
      },
      { role: "user", content: "Reply with exactly OK." },
    ];

    await completeOpenRouterChat({ client, model: resolved.id, messages });
    await new Promise((resolve) => {
      setTimeout(resolve, 2_000);
    });
    const cached = await completeOpenRouterChat({ client, model: resolved.id, messages });

    const cachedTokens = cached.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    expect(cached.choices[0]?.message?.content?.trim()).toMatch(/^OK[.!]?$/);
    expect(cachedTokens).toBeGreaterThan(1024);
  }, 60_000);
});
