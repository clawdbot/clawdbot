import { describe, expect, it } from "vitest";
import { createOllamaEmbeddingProvider } from "./src/embedding-provider.js";
import { createOllamaStreamFn } from "./src/stream.js";
import { createOllamaWebSearchProvider } from "./src/web-search-provider.js";

const LIVE = process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_OLLAMA === "1";
const OLLAMA_BASE_URL =
  process.env.OPENCLAW_LIVE_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
const CHAT_MODEL = process.env.OPENCLAW_LIVE_OLLAMA_MODEL?.trim() || "llama3.2:latest";
const EMBEDDING_MODEL =
  process.env.OPENCLAW_LIVE_OLLAMA_EMBED_MODEL?.trim() || "embeddinggemma:latest";
const PROVIDER_ID = process.env.OPENCLAW_LIVE_OLLAMA_PROVIDER_ID?.trim() || "ollama-live-custom";
const RUN_WEB_SEARCH = process.env.OPENCLAW_LIVE_OLLAMA_WEB_SEARCH !== "0";

async function collectStreamEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe.skipIf(!LIVE)("ollama live", () => {
  it("runs native chat with a custom provider prefix and normalized tool schemas", async () => {
    const streamFn = createOllamaStreamFn(OLLAMA_BASE_URL);
    let payload:
      | {
          model?: string;
          think?: boolean;
          keep_alive?: string;
          options?: { num_ctx?: number; top_p?: number };
          tools?: Array<{
            function?: {
              parameters?: {
                properties?: Record<string, { type?: string }>;
              };
            };
          }>;
        }
      | undefined;

    const stream = streamFn(
      {
        id: `${PROVIDER_ID}/${CHAT_MODEL}`,
        api: "ollama",
        provider: PROVIDER_ID,
        contextWindow: 8192,
        params: { num_ctx: 4096, top_p: 0.9, thinking: false, keep_alive: "5m" },
        requestTimeoutMs: 120_000,
      } as never,
      {
        messages: [{ role: "user", content: "Reply exactly OK." }],
        tools: [
          {
            name: "lookup_weather",
            description: "Lookup weather for a city.",
            parameters: {
              properties: {
                city: { enum: ["London", "Vienna"] },
                units: { enum: ["metric", "imperial"] },
                options: {
                  properties: {
                    includeWind: { type: "boolean" },
                  },
                },
              },
              required: ["city"],
            },
          },
        ],
      } as never,
      {
        maxTokens: 32,
        temperature: 0,
        onPayload: (body: unknown) => {
          payload = body as NonNullable<typeof payload>;
        },
      } as never,
    );

    const events = await collectStreamEvents(await Promise.resolve(stream));
    const error = events.find((event) => (event as { type?: string }).type === "error");

    expect(error).toBeUndefined();
    expect(events.some((event) => (event as { type?: string }).type === "done")).toBe(true);
    expect(payload?.model).toBe(CHAT_MODEL);
    expect(payload?.options?.num_ctx).toBe(4096);
    expect(payload?.options?.top_p).toBe(0.9);
    expect(payload?.think).toBe(false);
    expect(payload?.keep_alive).toBe("5m");
    const properties = payload?.tools?.[0]?.function?.parameters?.properties;
    expect(properties?.city?.type).toBe("string");
    expect(properties?.units?.type).toBe("string");
    expect(properties?.options?.type).toBe("object");
  }, 60_000);

  it("embeds a batch through the current Ollama endpoint for custom providers", async () => {
    const { client } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            [PROVIDER_ID]: {
              api: "ollama",
              baseUrl: OLLAMA_BASE_URL,
              apiKey: "ollama-local",
            },
          },
        },
      },
      provider: PROVIDER_ID,
      model: `${PROVIDER_ID}/${EMBEDDING_MODEL}`,
    } as never);

    const embeddings = await client.embedBatch(["hello", "world"]);

    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]?.length ?? 0).toBeGreaterThan(0);
    expect(embeddings[1]?.length).toBe(embeddings[0]?.length);
    expect(Math.hypot(...embeddings[0])).toBeGreaterThan(0.99);
    expect(Math.hypot(...embeddings[0])).toBeLessThan(1.01);
  }, 45_000);

  it.skipIf(!RUN_WEB_SEARCH)(
    "searches through Ollama web search fallback endpoints",
    async () => {
      const provider = createOllamaWebSearchProvider();
      const tool = provider.createTool({
        config: {
          models: {
            providers: {
              ollama: {
                api: "ollama",
                baseUrl: OLLAMA_BASE_URL,
                apiKey: "ollama-local",
              },
            },
          },
        },
      } as never);
      if (!tool) {
        throw new Error("Ollama web-search provider did not create a tool");
      }

      const result = (await tool.execute({
        query: "OpenClaw documentation",
        count: 1,
      })) as {
        provider?: string;
        results?: Array<{ url?: string }>;
      };

      expect(result.provider).toBe("ollama");
      expect(result.results?.length ?? 0).toBeGreaterThan(0);
      expect(result.results?.[0]?.url).toMatch(/^https?:\/\//);
    },
    45_000,
  );
});
