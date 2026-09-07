// Exercise the provider, shared factory, and guarded HTTP transport together.
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import {
  createRemoteEmbeddingProvider,
  type MemoryEmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiEmbeddingProvider } from "./embedding-provider.js";

type EmbeddingBody = {
  model: string;
  input: string[];
  dimensions?: number;
  input_type?: string;
};
type CapturedRequest = {
  url: string | undefined;
  authorization: string | undefined;
  alias: string | string[] | undefined;
  body: EmbeddingBody;
  response: ServerResponse;
  closed: boolean;
};

const servers: Server[] = [];

function respondWithEmbeddings(request: CapturedRequest): void {
  request.response.writeHead(200, { "content-type": "application/json" });
  request.response.end(
    JSON.stringify({
      data: request.body.input
        .map((text, index) => ({ index, embedding: [text.length, index + 1] }))
        .toReversed(),
    }),
  );
}

async function startEmbeddingServer(onRequest = respondWithEmbeddings) {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const captured: CapturedRequest = {
          url: request.url,
          authorization: request.headers.authorization,
          alias: request.headers["x-alias"],
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as EmbeddingBody,
          response,
          closed: false,
        };
        response.once("close", () => {
          captured.closed = true;
        });
        requests.push(captured);
        onRequest(captured);
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    })();
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/tenant/v1`, requests };
}

function createOptions(
  overrides: Partial<MemoryEmbeddingProviderCreateOptions> = {},
): MemoryEmbeddingProviderCreateOptions {
  return {
    config: {},
    provider: "openai",
    model: "text-embedding-3-small",
    fallback: "none",
    ...overrides,
    remote: { apiKey: "fixture-openai-key", ...overrides.remote },
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});

describe("OpenAI embedding provider HTTP contract", () => {
  it.each([
    { name: "omitted", fields: { input_type: "document" } },
    {
      name: "overridden",
      fields: { model: "other-model", input: ["shortened"], input_type: "document" },
    },
  ])("rejects short responses when callback fields have $name model/input", async ({ fields }) => {
    const server = await startEmbeddingServer((request) => {
      request.response.writeHead(200, { "content-type": "application/json" });
      request.response.end(JSON.stringify({ data: [{ embedding: [1, 2] }] }));
    });
    const provider = createRemoteEmbeddingProvider({
      id: "fixture",
      client: {
        baseUrl: server.baseUrl,
        headers: {},
        model: "fixture-model",
        ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
      },
      errorPrefix: "fixture embeddings failed",
      buildRequestFields: () => fields,
    });

    await expect(provider.embedBatch(["first", "second"])).rejects.toThrow(
      "fixture embeddings failed: malformed JSON response",
    );
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.body).toEqual({
      model: "fixture-model",
      input: ["first", "second"],
      input_type: "document",
    });
  });

  it.each([
    {
      name: "query override",
      options: { inputType: "passage", queryInputType: " query " },
      kind: "query" as const,
      expected: { input_type: "query" },
    },
    {
      name: "document override",
      options: { inputType: "query", documentInputType: " document " },
      kind: "document" as const,
      expected: { input_type: "document" },
    },
    {
      name: "configured default",
      options: { inputType: " passage " },
      kind: undefined,
      expected: { input_type: "passage" },
    },
    {
      name: "unconfigured input type",
      options: {},
      kind: "document" as const,
      expected: {},
    },
    {
      name: "blank explicit query override",
      options: { inputType: "passage", queryInputType: " " },
      kind: "query" as const,
      expected: {},
    },
    {
      name: "dimensions",
      options: { dimensions: 512 },
      kind: "document" as const,
      expected: { dimensions: 512 },
    },
    {
      name: "other semantic types use the document payload",
      options: { queryInputType: "query", documentInputType: "passage" },
      kind: "semantic" as const,
      expected: { input_type: "passage" },
    },
  ])("preserves $name", async ({ options, kind, expected }) => {
    const server = await startEmbeddingServer();
    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({
        ...options,
        remote: { baseUrl: `${server.baseUrl}/?tenant=beta#local` },
      }),
    );

    await expect(provider.embed({ text: "hello" }, { inputType: kind })).resolves.toEqual([5, 1]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      url: "/tenant/v1/embeddings?tenant=beta",
      authorization: "Bearer fixture-openai-key",
      body: { model: "text-embedding-3-small", input: ["hello"], ...expected },
    });
    expect(server.requests[0]?.body).toEqual({
      model: "text-embedding-3-small",
      input: ["hello"],
      ...expected,
    });
  });

  it("keeps document batches in one request and restores indexed response order", async () => {
    const server = await startEmbeddingServer();
    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({
        documentInputType: "document",
        remote: { baseUrl: server.baseUrl },
      }),
    );

    await expect(
      provider.embedBatch(["first", { text: "second" }, "", { text: " \t" }]),
    ).resolves.toEqual([
      [5, 1],
      [6, 2],
      [0, 3],
      [2, 4],
    ]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.body).toEqual({
      model: "text-embedding-3-small",
      input: ["first", "second", "", " \t"],
      input_type: "document",
    });
    await expect(provider.embedBatch([])).resolves.toEqual([]);
    await expect(provider.embedBatch([], { inputType: "query" })).resolves.toEqual([]);
    expect(server.requests).toHaveLength(1);
  });

  it("reads mutable client payload fields per call while retaining endpoint and provider metadata", async () => {
    const server = await startEmbeddingServer();
    const { provider, client } = await createOpenAiEmbeddingProvider(
      createOptions({ queryInputType: "query", remote: { baseUrl: server.baseUrl } }),
    );
    await provider.embed("first", { inputType: "query" });
    client.model = "updated-model";
    client.queryInputType = " updated-query ";
    client.outputDimensionality = 64;
    client.headers = { ...client.headers, "x-alias": "updated" };
    client.baseUrl = `${server.baseUrl}/unused`;

    await provider.embed("second", { inputType: "query" });

    expect(provider.model).toBe("text-embedding-3-small");
    expect(provider.maxInputTokens).toBe(8192);
    expect(server.requests.map(({ url, alias, body }) => ({ url, alias, body }))).toEqual([
      {
        url: "/tenant/v1/embeddings",
        alias: undefined,
        body: { model: "text-embedding-3-small", input: ["first"], input_type: "query" },
      },
      {
        url: "/tenant/v1/embeddings",
        alias: "updated",
        body: {
          model: "updated-model",
          input: ["second"],
          dimensions: 64,
          input_type: "updated-query",
        },
      },
    ]);
  });

  it.each(["singleton", "query batch", "document batch"] as const)(
    "rejects a pre-aborted %s without sending HTTP",
    async (kind) => {
      const server = await startEmbeddingServer();
      const { provider } = await createOpenAiEmbeddingProvider(
        createOptions({ remote: { baseUrl: server.baseUrl } }),
      );
      const controller = new AbortController();
      controller.abort();
      const options = {
        signal: controller.signal,
        inputType: kind === "document batch" ? ("document" as const) : ("query" as const),
      };
      const outcome =
        kind === "singleton"
          ? provider.embed("hello", options)
          : provider.embedBatch(["first", "second"], options);

      await expect(outcome).rejects.toMatchObject({ name: "AbortError" });
      expect(server.requests).toHaveLength(0);
    },
  );

  it("starts query requests concurrently and preserves input order despite reversed completion", async () => {
    const server = await startEmbeddingServer(() => {});
    const controller = new AbortController();
    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({ queryInputType: "query", remote: { baseUrl: server.baseUrl } }),
    );
    const outcome = provider
      .embedBatch(["first", { text: "second" }], {
        inputType: "query",
        signal: controller.signal,
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    try {
      // Both requests must reach HTTP before either response is released.
      await vi.waitFor(() => expect(server.requests).toHaveLength(2));
      const first = server.requests.find((request) => request.body.input[0] === "first");
      const second = server.requests.find((request) => request.body.input[0] === "second");
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (!first || !second) {
        throw new Error("missing query request");
      }
      expect(server.requests.map((request) => request.body.input_type)).toEqual(["query", "query"]);
      respondWithEmbeddings(second);
      await vi.waitFor(() => expect(second.closed).toBe(true));
      respondWithEmbeddings(first);
      await expect(outcome).resolves.toEqual({
        value: [
          [5, 1],
          [6, 1],
        ],
      });
    } finally {
      controller.abort();
      await outcome;
    }
  });

  it.each(["cancel", "first request failure"] as const)(
    "preserves query-batch %s and releases every guarded request",
    async (mode) => {
      const server = await startEmbeddingServer(() => {});
      const controller = new AbortController();
      const { provider } = await createOpenAiEmbeddingProvider(
        createOptions({ remote: { baseUrl: server.baseUrl } }),
      );
      const outcome = provider
        .embedBatch(["first", "second"], { inputType: "query", signal: controller.signal })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      try {
        await vi.waitFor(() => expect(server.requests).toHaveLength(2));
        if (mode === "first request failure") {
          server.requests[0]?.response.writeHead(503).end("fixture rejected");
          await expect(outcome).resolves.toMatchObject({
            error: { message: expect.stringContaining("openai embeddings failed: 503") },
          });
          // Promise.all rejects early; it must not cancel the still-running sibling.
          expect(server.requests[1]?.closed).toBe(false);
        }
        controller.abort(new Error("fixture caller cancellation"));
        await expect(outcome).resolves.toHaveProperty("error");
        await vi.waitFor(() =>
          expect(server.requests.every((request) => request.closed)).toBe(true),
        );
        expect(server.requests).toHaveLength(2);
      } finally {
        controller.abort();
        await outcome;
      }
    },
  );

  it.each(["https://api.openai.com/v1", "https://API.OPENAI.COM/v1"])(
    "strips the model prefix only for native endpoint %s",
    async (baseUrl) => {
      const { provider } = await createOpenAiEmbeddingProvider(
        createOptions({ model: "openai/text-embedding-3-small", remote: { baseUrl } }),
      );
      expect(provider.model).toBe("text-embedding-3-small");
      expect(provider.maxInputTokens).toBe(8192);
    },
  );

  it("preserves qualified router models in metadata and request bodies", async () => {
    const server = await startEmbeddingServer();
    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({
        model: "openai/text-embedding-3-small",
        remote: { baseUrl: server.baseUrl },
      }),
    );
    expect(provider.model).toBe("openai/text-embedding-3-small");
    expect(provider.maxInputTokens).toBe(8192);
    await provider.embed("hello", { inputType: "query" });
    expect(server.requests[0]?.body.model).toBe("openai/text-embedding-3-small");
  });

  it("uses the configured custom provider destination and headers", async () => {
    const server = await startEmbeddingServer();
    const { provider } = await createOpenAiEmbeddingProvider(
      createOptions({
        provider: "fixture-alias",
        config: {
          models: {
            providers: {
              "fixture-alias": {
                baseUrl: server.baseUrl,
                headers: { "x-alias": "selected" },
                models: [],
              },
            },
          },
        },
      }),
    );
    await provider.embed("hello");
    expect(server.requests[0]?.alias).toBe("selected");
  });

  it("defaults the client provider lookup to OpenAI", async () => {
    const { client } = await createOpenAiEmbeddingProvider(createOptions({ provider: undefined }));
    expect(client.baseUrl).toBe("https://api.openai.com/v1");
    expect(client.model).toBe("text-embedding-3-small");
  });
});
