// Covers OpenAI-compatible embedding provider plugin behavior.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import type { EmbeddingProviderCreateOptions } from "./embedding-providers.js";
import { getRegisteredEmbeddingProvider } from "./embedding-providers.js";
import {
  createOpenAICompatibleEmbeddingProvider,
  openAICompatibleEmbeddingProviderAdapter,
} from "./openai-compatible-embedding-provider.js";

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
};

type FixtureResponse = {
  object: "list";
  data: Array<{
    object?: "embedding";
    embedding: number[];
    index: number;
  }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
};

const servers: Array<{ close: () => Promise<void> }> = [];

function createOptions(
  overrides: Partial<EmbeddingProviderCreateOptions> = {},
): EmbeddingProviderCreateOptions {
  return {
    config: {} as EmbeddingProviderCreateOptions["config"],
    provider: "openai-compatible",
    model: "text-embedding-bge-m3",
    ...overrides,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

async function startEmbeddingServer(params?: {
  token?: string;
  respond?: (request: CapturedRequest) => FixtureResponse | Record<string, unknown>;
  status?: number;
}): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readJsonBody(req);
        const captured: CapturedRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        };
        requests.push(captured);

        if (params?.token) {
          expect(req.headers.authorization).toBe(`Bearer ${params.token}`);
        } else {
          expect(req.headers.authorization).toBeUndefined();
        }

        res.writeHead(params?.status ?? 200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            params?.respond?.(captured) ?? {
              object: "list",
              data: [{ object: "embedding", embedding: [0.1, 0.2, 0.3], index: 0 }],
              model: body.model,
            },
          ),
        );
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
}

afterEach(async () => {
  const pending = servers.splice(0);
  await Promise.all(pending.map((server) => server.close()));
});

describe("openai-compatible generic embedding provider", () => {
  it("is registered as a core generic embedding provider", () => {
    expect(getRegisteredEmbeddingProvider("openai-compatible")).toMatchObject({
      adapter: openAICompatibleEmbeddingProviderAdapter,
      ownerPluginId: "core",
    });
  });

  it("registers as a generic embedding provider with no memory-specific policy", async () => {
    expect(openAICompatibleEmbeddingProviderAdapter.id).toBe("openai-compatible");
    expect(openAICompatibleEmbeddingProviderAdapter.transport).toBe("remote");
    expect(openAICompatibleEmbeddingProviderAdapter.authProviderId).toBeUndefined();

    const server = await startEmbeddingServer();
    const result = await openAICompatibleEmbeddingProviderAdapter.create(
      createOptions({
        model: "nomic-embed-text",
        remote: { baseUrl: server.baseUrl },
      }),
    );

    expect(result.provider?.id).toBe("openai-compatible");
    expect(result.runtime?.cacheKeyData).toMatchObject({
      provider: "openai-compatible",
      baseUrl: server.baseUrl,
      model: "nomic-embed-text",
    });
    expect(server.requests).toHaveLength(0);
  });

  it("adds non-secret routing headers to runtime cache identity", async () => {
    const server = await startEmbeddingServer();
    const result = await openAICompatibleEmbeddingProviderAdapter.create(
      createOptions({
        model: "tenant-embedder",
        remote: {
          baseUrl: server.baseUrl,
          apiKey: "secret-api-key",
          headers: {
            "x-api-key": "also-secret",
            "x-deployment": "tenant-a",
          },
        },
      }),
    );

    expect(result.runtime?.cacheKeyData).toMatchObject({
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-deployment": "tenant-a",
      },
    });
    expect(result.runtime?.cacheKeyData).not.toHaveProperty("authorization");
    expect(
      (result.runtime!.cacheKeyData as { headers?: Record<string, string> }).headers,
    ).not.toHaveProperty("x-api-key");
  });

  it("posts OpenAI-compatible embedding requests without warming up during create", async () => {
    const token = "local-test-token";
    const server = await startEmbeddingServer({
      token,
      respond: ({ body }) => {
        const input = body.input;
        const texts = Array.isArray(input) ? input : [input];
        return {
          object: "list",
          data: texts.map((text, index) => ({
            object: "embedding",
            embedding: [String(text).length, index + 0.25, 1],
            index,
          })),
          model: String(body.model),
          usage: { prompt_tokens: texts.length, total_tokens: texts.length },
        };
      },
    });

    const { provider, client } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({
        model: "text-embedding-bge-m3",
        dimensions: 1024,
        remote: {
          baseUrl: `  ${server.baseUrl}/  `,
          apiKey: `  ${token}  `,
          headers: {
            Authorization: "Bearer ignored",
            "x-local-runtime": "ollama",
          },
        },
      }),
    );

    expect(provider.id).toBe("openai-compatible");
    expect(provider.model).toBe("text-embedding-bge-m3");
    expect(provider.dimensions).toBe(1024);
    expect(client.baseUrl).toBe(server.baseUrl);
    expect(client.headers.authorization).toBe(`Bearer ${token}`);
    expect(server.requests).toHaveLength(0);

    await expect(provider.embed("hello")).resolves.toEqual([5, 0.25, 1]);
    await expect(provider.embedBatch(["a", "abcd"])).resolves.toEqual([
      [1, 0.25, 1],
      [4, 1.25, 1],
    ]);

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/v1/embeddings",
      body: {
        model: "text-embedding-bge-m3",
        input: ["hello"],
        dimensions: 1024,
      },
    });
    expect(server.requests[0]?.body).not.toHaveProperty("encoding_format");
    expect(server.requests[0]?.body).not.toHaveProperty("input_type");
    expect(server.requests[0]?.headers["content-type"]).toContain("application/json");
    expect(server.requests[0]?.headers.accept).toBe("application/json");
    expect(server.requests[0]?.headers["x-local-runtime"]).toBe("ollama");
    expect(server.requests[1]?.body).toEqual({
      model: "text-embedding-bge-m3",
      input: ["a", "abcd"],
      dimensions: 1024,
    });
  });

  it("resolves env SecretRef API keys on the memory search secret surface", async () => {
    const token = "env-secret-token";
    const envVar = "OPENCLAW_TEST_OPENAI_COMPATIBLE_EMBEDDING_API_KEY";
    const server = await startEmbeddingServer({ token });

    await withEnvAsync({ [envVar]: token }, async () => {
      const { provider } = await createOpenAICompatibleEmbeddingProvider(
        createOptions({
          model: "text-embedding-bge-m3",
          remote: {
            baseUrl: server.baseUrl,
            apiKey: { source: "env", provider: "default", id: envVar },
          },
        }),
      );

      await expect(provider.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
      expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${token}`);
    });
  });

  it("enforces configured env SecretRef allowlists for API keys", async () => {
    const envVar = "OPENCLAW_TEST_OPENAI_COMPATIBLE_BLOCKED_API_KEY";
    const server = await startEmbeddingServer();

    await withEnvAsync({ [envVar]: "blocked-token" }, async () => {
      await expect(
        createOpenAICompatibleEmbeddingProvider(
          createOptions({
            config: {
              secrets: {
                providers: {
                  default: { source: "env", allowlist: ["OPENCLAW_ALLOWED_ONLY"] },
                },
              },
            } as EmbeddingProviderCreateOptions["config"],
            model: "text-embedding-bge-m3",
            remote: {
              baseUrl: server.baseUrl,
              apiKey: { source: "env", provider: "default", id: envVar },
            },
          }),
        ),
      ).rejects.toThrow("SecretRef is unresolved");
      expect(server.requests).toHaveLength(0);
    });
  });

  it("enforces configured env SecretRef allowlists for custom headers", async () => {
    const envVar = "OPENCLAW_TEST_OPENAI_COMPATIBLE_BLOCKED_HEADER";
    const server = await startEmbeddingServer();

    await withEnvAsync({ [envVar]: "blocked-header" }, async () => {
      await expect(
        createOpenAICompatibleEmbeddingProvider(
          createOptions({
            config: {
              secrets: {
                providers: {
                  default: { source: "env", allowlist: ["OPENCLAW_ALLOWED_ONLY"] },
                },
              },
            } as EmbeddingProviderCreateOptions["config"],
            model: "text-embedding-bge-m3",
            remote: {
              baseUrl: server.baseUrl,
              headers: {
                "x-tenant-token": {
                  source: "env",
                  provider: "default",
                  id: envVar,
                } as unknown as string,
              },
            },
          }),
        ),
      ).rejects.toThrow("SecretRef is unresolved");
      expect(server.requests).toHaveLength(0);
    });
  });

  it("resolves env-template API key strings before treating them as inline secrets", async () => {
    const token = "env-template-token";
    const envVar = "OPENCLAW_TEST_OPENAI_COMPATIBLE_EMBEDDING_TEMPLATE_KEY";
    const server = await startEmbeddingServer({ token });

    await withEnvAsync({ [envVar]: token }, async () => {
      const { provider } = await createOpenAICompatibleEmbeddingProvider(
        createOptions({
          model: "text-embedding-bge-m3",
          remote: {
            baseUrl: server.baseUrl,
            apiKey: `\${${envVar}}`,
          },
        }),
      );

      await expect(provider.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
      expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${token}`);
    });
  });

  it("does not treat missing env-template API key strings as inline secrets", async () => {
    const envVar = "OPENCLAW_TEST_OPENAI_COMPATIBLE_EMBEDDING_MISSING_TEMPLATE_KEY";
    const server = await startEmbeddingServer();

    await withEnvAsync({ [envVar]: undefined }, async () => {
      await expect(
        createOpenAICompatibleEmbeddingProvider(
          createOptions({
            model: "text-embedding-bge-m3",
            remote: {
              baseUrl: server.baseUrl,
              apiKey: `\${${envVar}}`,
            },
          }),
        ),
      ).rejects.toThrow(`SecretRef is unresolved (env:default:${envVar})`);
      expect(server.requests).toHaveLength(0);
    });
  });

  it("reads connection settings from configured explicit OpenAI-compatible providers", async () => {
    const token = "alias-token";
    const server = await startEmbeddingServer({ token });
    const { provider, client } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({
        config: {
          models: {
            providers: {
              "tenant-embeddings": {
                baseUrl: server.baseUrl,
                apiKey: token,
                headers: {
                  "x-tenant": "tenant-a",
                },
                models: [],
              },
            },
          },
        } as EmbeddingProviderCreateOptions["config"],
        provider: "tenant-embeddings",
        model: "text-embedding-bge-m3",
      }),
    );

    expect(client.baseUrl).toBe(server.baseUrl);
    await expect(provider.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(server.requests[0]?.headers["x-tenant"]).toBe("tenant-a");
  });

  it("reads connection settings from configured OpenAI chat-compatible provider ids", async () => {
    const token = "alias-token";
    const server = await startEmbeddingServer({ token });
    const { provider, client } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({
        config: {
          models: {
            providers: {
              "tenant-embeddings": {
                api: "openai-responses",
                baseUrl: server.baseUrl,
                apiKey: token,
                models: [],
              },
            },
          },
        } as EmbeddingProviderCreateOptions["config"],
        provider: "tenant-embeddings",
        model: "tenant-embeddings/text-embedding-bge-m3",
      }),
    );

    expect(client.baseUrl).toBe(server.baseUrl);
    expect(provider.model).toBe("text-embedding-bge-m3");
    await expect(provider.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${token}`);
  });

  it("treats blank remote overrides as unset for configured explicit providers", async () => {
    const token = "alias-token";
    const server = await startEmbeddingServer({ token });
    const { provider, client } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({
        config: {
          models: {
            providers: {
              "tenant-embeddings": {
                baseUrl: server.baseUrl,
                apiKey: token,
                models: [],
              },
            },
          },
        } as EmbeddingProviderCreateOptions["config"],
        provider: "tenant-embeddings",
        model: "text-embedding-bge-m3",
        remote: {
          baseUrl: "   ",
          apiKey: "   ",
        },
      }),
    );

    expect(client.baseUrl).toBe(server.baseUrl);
    await expect(provider.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${token}`);
  });

  it("strips the active configured provider id from model ids", async () => {
    const server = await startEmbeddingServer();
    const { provider } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({
        config: {
          models: {
            providers: {
              "ollama-local": {
                baseUrl: server.baseUrl,
                models: [],
              },
            },
          },
        } as EmbeddingProviderCreateOptions["config"],
        provider: "ollama-local",
        model: "ollama-local/qwen2.5:3b",
      }),
    );

    expect(provider.model).toBe("qwen2.5:3b");
    await expect(provider.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(server.requests[0]?.body.model).toBe("qwen2.5:3b");
  });

  it("maps configured memory input_type labels onto query and document requests", async () => {
    const server = await startEmbeddingServer({
      respond: ({ body }) => {
        const input = body.input;
        const texts = Array.isArray(input) ? input : [input];
        return {
          object: "list",
          data: texts.map((text, index) => ({
            object: "embedding",
            embedding: [String(text).length, index + 0.25, 1],
            index,
          })),
          model: String(body.model),
        };
      },
    });

    const result = await openAICompatibleEmbeddingProviderAdapter.create(
      createOptions({
        model: "text-embedding-bge-m3",
        inputType: "  default  ",
        queryInputType: "  query  ",
        documentInputType: "  document  ",
        remote: { baseUrl: server.baseUrl },
      }),
    );
    const provider = result.provider;
    if (!provider) {
      throw new Error("expected openai-compatible provider");
    }

    expect(result.runtime?.cacheKeyData).toMatchObject({
      inputType: "default",
      queryInputType: "query",
      documentInputType: "document",
    });

    await expect(provider.embed("hello", { inputType: "query" })).resolves.toEqual([5, 0.25, 1]);
    await expect(provider.embedBatch(["doc"], { inputType: "document" })).resolves.toEqual([
      [3, 0.25, 1],
    ]);
    await expect(provider.embed("semantic", { inputType: "semantic" })).resolves.toEqual([
      8, 0.25, 1,
    ]);

    expect(server.requests.map((request) => request.body.input_type)).toEqual([
      "query",
      "document",
      "default",
    ]);
  });

  it("omits Authorization when no apiKey is configured", async () => {
    const server = await startEmbeddingServer();
    const { provider, client } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({
        model: "nomic-embed-text",
        remote: { baseUrl: server.baseUrl },
      }),
    );

    expect(client.headers).not.toHaveProperty("authorization");

    await expect(provider.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("coerces structured text inputs and rejects inline data", async () => {
    const server = await startEmbeddingServer({
      respond: ({ body }) => {
        expect(body.input).toEqual(["ab"]);
        return {
          object: "list",
          data: [{ object: "embedding", embedding: [2, 1], index: 0 }],
        };
      },
    });
    const { provider } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({ remote: { baseUrl: server.baseUrl } }),
    );

    await expect(
      provider.embed({
        text: "ignored",
        parts: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).resolves.toEqual([2, 1]);
    await expect(
      provider.embed({
        text: "image",
        parts: [{ type: "inline-data", mimeType: "image/png", data: "AA==" }],
      }),
    ).rejects.toThrow("only support text embedding inputs");
  });

  it.each([
    {
      runtime: "Ollama",
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.11, 0.12], index: 0 }],
        model: "nomic-embed-text",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
    },
    {
      runtime: "llama.cpp llama-server",
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.21, 0.22], index: 0 }],
        model: "bge-small-en-v1.5",
      },
    },
    {
      runtime: "vLLM",
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.31, 0.32], index: 0 }],
        model: "intfloat/e5-small-v2",
      },
    },
    {
      runtime: "LocalAI",
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.41, 0.42], index: 0 }],
        model: "text-embedding-ada-002",
      },
    },
    {
      runtime: "TGI-compatible server",
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.51, 0.52], index: 0 }],
        model: "tei-bge-small",
      },
    },
    {
      runtime: "llamafile",
      response: {
        object: "list",
        data: [{ object: "embedding", embedding: [0.61, 0.62], index: 0 }],
        model: "all-MiniLM-L6-v2",
      },
    },
  ] satisfies Array<{ runtime: string; response: FixtureResponse }>)(
    "parses $runtime OpenAI-compatible embedding responses through the same path",
    async ({ response }) => {
      const server = await startEmbeddingServer({ respond: () => response });
      const { provider } = await createOpenAICompatibleEmbeddingProvider(
        createOptions({
          model: response.model ?? "embedding-model",
          remote: { baseUrl: server.baseUrl },
        }),
      );

      await expect(provider.embed("hello")).resolves.toEqual(response.data[0]?.embedding);
      expect(server.requests[0]?.url).toBe("/v1/embeddings");
      expect(server.requests[0]?.body).toEqual({
        model: response.model ?? "embedding-model",
        input: ["hello"],
      });
    },
  );

  it("reports missing required config with actionable keys", async () => {
    await expect(
      createOpenAICompatibleEmbeddingProvider(
        createOptions({ remote: { baseUrl: "   " }, model: "text-embedding-bge-m3" }),
      ),
    ).rejects.toThrow("remote.baseUrl");
    await expect(
      createOpenAICompatibleEmbeddingProvider(
        createOptions({ remote: { baseUrl: "http://127.0.0.1:11434/v1" }, model: "   " }),
      ),
    ).rejects.toThrow("missing model");
  });

  it("keeps remote parser failures behind the provider-specific error prefix", async () => {
    const server = await startEmbeddingServer({ respond: () => ({ data: [] }) });
    const { provider } = await createOpenAICompatibleEmbeddingProvider(
      createOptions({
        model: "text-embedding-bge-m3",
        remote: { baseUrl: server.baseUrl },
      }),
    );

    await expect(provider.embed("hello")).rejects.toThrow(
      "openai-compatible embeddings failed: malformed JSON response",
    );
  });
});
