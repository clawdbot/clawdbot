import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import plugin from "./index.js";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const LIVE_MODEL_ID =
  process.env.OPENCLAW_LIVE_OPENROUTER_PLUGIN_MODEL?.trim() || "openai/gpt-5.4-nano";
const LIVE_CACHE_MODEL_ID =
  process.env.OPENCLAW_LIVE_OPENROUTER_CACHE_MODEL?.trim() || "deepseek/deepseek-v3.2";
const liveEnabled = OPENROUTER_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;
const describeCacheLive =
  liveEnabled && process.env.OPENCLAW_LIVE_CACHE_TEST === "1" ? describe : describe.skip;
const ModelRegistryCtor = ModelRegistry as unknown as {
  new (authStorage: AuthStorage, modelsJsonPath?: string): ModelRegistry;
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

describeLive("openrouter plugin live", () => {
  it("registers an OpenRouter provider that can complete a live request", async () => {
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

    expect(resolved).toMatchObject({
      provider: "openrouter",
      id: LIVE_MODEL_ID,
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const client = new OpenAI({
      apiKey: OPENROUTER_API_KEY,
      baseURL: resolved.baseUrl,
    });
    const response = await client.chat.completions.create({
      model: resolved.id,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      max_tokens: 16,
    });

    expect(response.choices[0]?.message?.content?.trim()).toMatch(/^OK[.!]?$/);
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
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const cached = await completeOpenRouterChat({ client, model: resolved.id, messages });

    const cachedTokens = cached.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    expect(cached.choices[0]?.message?.content?.trim()).toMatch(/^OK[.!]?$/);
    expect(cachedTokens).toBeGreaterThan(1024);
  }, 60_000);
});
