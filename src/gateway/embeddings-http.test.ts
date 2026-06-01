import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { createConfigIO, resetConfigRuntimeState } from "../config/config.js";
import type { EmbeddingProviderAdapter } from "../plugins/embedding-providers.js";
import type { MemoryEmbeddingProviderAdapter } from "../plugins/memory-embedding-providers.js";
import { startOpenAiCompatGatewayServer } from "./openai-compatible-http.test-helpers.js";
import { getFreePort, installGatewayTestHooks, testState } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const WRITE_SCOPE_HEADER = { "x-openclaw-scopes": "operator.write" };

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let createEmbeddingProviderMock: ReturnType<
  typeof vi.fn<
    (options: { provider: string; model: string; agentDir?: string }) => Promise<{
      provider: {
        id: string;
        model: string;
        embedQuery: (text: string) => Promise<number[]>;
        embedBatch: (texts: string[]) => Promise<number[][]>;
      };
    }>
  >
>;
let clearMemoryEmbeddingProviders: typeof import("../plugins/memory-embedding-providers.js").clearMemoryEmbeddingProviders;
let registerMemoryEmbeddingProvider: typeof import("../plugins/memory-embedding-providers.js").registerMemoryEmbeddingProvider;
let clearEmbeddingProviders: typeof import("../plugins/embedding-providers.js").clearEmbeddingProviders;
let registerEmbeddingProvider: typeof import("../plugins/embedding-providers.js").registerEmbeddingProvider;
let createGenericEmbeddingProviderMock: ReturnType<
  typeof vi.fn<
    (options: {
      provider?: string;
      model: string;
      dimensions?: number;
      inputType?: string;
      queryInputType?: string;
      documentInputType?: string;
    }) => Promise<{
      provider: {
        id: string;
        model: string;
        embed: (input: unknown) => Promise<number[]>;
        embedBatch: (texts: unknown[], options?: { inputType?: string }) => Promise<number[][]>;
      };
    }>
  >
>;
let enabledServer: Awaited<ReturnType<typeof startOpenAiCompatGatewayServer>>;
let enabledPort: number;

beforeAll(async () => {
  ({ clearMemoryEmbeddingProviders, registerMemoryEmbeddingProvider } =
    await import("../plugins/memory-embedding-providers.js"));
  ({ clearEmbeddingProviders, registerEmbeddingProvider } =
    await import("../plugins/embedding-providers.js"));
  createEmbeddingProviderMock = vi.fn(
    async (options: { provider: string; model: string; agentDir?: string }) => ({
      provider: {
        id: options.provider,
        model: options.model,
        embedQuery: async () => [0.1, 0.2],
        embedBatch: async (texts: string[]) =>
          texts.map((_text, index) => [index + 0.1, index + 0.2]),
      },
    }),
  );
  createGenericEmbeddingProviderMock = vi.fn(
    async (options: {
      provider?: string;
      model: string;
      dimensions?: number;
      inputType?: string;
      queryInputType?: string;
      documentInputType?: string;
    }) => ({
      provider: {
        id: options.provider ?? "openai-compatible",
        model: options.model,
        embed: async () => [9.1, 9.2],
        embedBatch: async (texts: unknown[], callOptions?: { inputType?: string }) =>
          texts.map((_text, index) => [
            index + 9.1,
            callOptions?.inputType === "document" ? 9.2 : 0,
          ]),
      },
    }),
  );
  clearMemoryEmbeddingProviders();
  clearEmbeddingProviders();
  const openAiAdapter: MemoryEmbeddingProviderAdapter = {
    id: "openai",
    defaultModel: "text-embedding-3-small",
    transport: "remote",
    autoSelectPriority: 20,
    allowExplicitWhenConfiguredAuto: true,
    create: async (options) => {
      const result = await createEmbeddingProviderMock({
        provider: "openai",
        model: options.model,
        agentDir: options.agentDir,
      });
      return result;
    },
  };
  registerMemoryEmbeddingProvider(openAiAdapter);
  const openAiCompatibleAdapter: EmbeddingProviderAdapter = {
    id: "openai-compatible",
    defaultModel: "text-embedding-3-small",
    transport: "remote",
    create: async (options) =>
      await createGenericEmbeddingProviderMock({
        provider: options.provider,
        model: options.model,
        dimensions: options.dimensions,
        inputType: options.inputType,
        queryInputType: options.queryInputType,
        documentInputType: options.documentInputType,
      }),
  };
  registerEmbeddingProvider(openAiCompatibleAdapter);
  ({ startGatewayServer } = await import("./server.js"));
  enabledPort = await getFreePort();
  enabledServer = await startOpenAiCompatGatewayServer({
    startGatewayServer,
    port: enabledPort,
    auth: { mode: "token", token: "secret" },
    openAiChatCompletionsEnabled: true,
  });
});

afterAll(async () => {
  await enabledServer.close({ reason: "embeddings http enabled suite done" });
  clearMemoryEmbeddingProviders();
  clearEmbeddingProviders();
  vi.resetModules();
});

async function postEmbeddings(body: unknown, headers?: Record<string, string>) {
  return await fetch(`http://127.0.0.1:${enabledPort}/v1/embeddings`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
      ...WRITE_SCOPE_HEADER,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function expectDefaultEmbeddingResponse(res: Response) {
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    object?: string;
    data?: Array<{ object?: string; embedding?: number[] }>;
  };
  expect(json.object).toBe("list");
  expect(json.data?.[0]?.object).toBe("embedding");
  expect(json.data?.[0]?.embedding).toEqual([0.1, 0.2]);
}

async function expectEmbeddingData(
  res: Response,
  expected: Array<{ object: "embedding"; index: number; embedding: number[] }>,
) {
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
  };
  expect(json.data).toEqual(expected);
}

async function expectInvalidEmbeddingRequest(res: Response, message?: string) {
  expect(res.status).toBe(400);
  const json = (await res.json()) as { error?: { type?: string; message?: string } };
  if (message === undefined) {
    expect(json.error?.type).toBe("invalid_request_error");
    return;
  }
  expect(json.error).toEqual({
    type: "invalid_request_error",
    message,
  });
}

async function expectGenericProviderEmbeddingRequest(expectedProviderCall: {
  provider: string;
  model: string;
  dimensions: number;
  inputType: string;
  queryInputType: string;
  documentInputType: string;
}) {
  const res = await postEmbeddings({
    model: "openclaw/default",
    input: ["a", "b"],
  });
  await expectEmbeddingData(res, [
    { object: "embedding", index: 0, embedding: [9.1, 9.2] },
    { object: "embedding", index: 1, embedding: [10.1, 9.2] },
  ]);
  expect(latestCreateGenericEmbeddingProviderOptions()).toMatchObject(expectedProviderCall);
}

function latestCreateEmbeddingProviderOptions(): {
  agentDir?: string;
  model?: string;
  provider?: string;
} {
  const calls = createEmbeddingProviderMock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected embedding provider create call");
  }
  return call[0];
}

function latestCreateGenericEmbeddingProviderOptions(): {
  provider?: string;
  model?: string;
  dimensions?: number;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
} {
  const calls = createGenericEmbeddingProviderMock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected generic embedding provider create call");
  }
  return call[0];
}

describe("OpenAI-compatible embeddings HTTP API (e2e)", () => {
  it("embeds string and array inputs", async () => {
    const single = await postEmbeddings({
      model: "openclaw/default",
      input: "hello",
    });
    await expectDefaultEmbeddingResponse(single);

    const batch = await postEmbeddings({
      model: "openclaw/default",
      input: ["a", "b"],
    });
    await expectEmbeddingData(batch, [
      { object: "embedding", index: 0, embedding: [0.1, 0.2] },
      { object: "embedding", index: 1, embedding: [1.1, 1.2] },
    ]);

    const qualified = await postEmbeddings(
      {
        model: "openclaw/default",
        input: "hello again",
      },
      { "x-openclaw-model": "openai/text-embedding-3-small" },
    );
    expect(qualified.status).toBe(200);
    const qualifiedJson = (await qualified.json()) as { model?: string };
    expect(qualifiedJson.model).toBe("openclaw/default");
    const lastCall = latestCreateEmbeddingProviderOptions();
    expect(lastCall.provider).toBe("openai");
    expect(lastCall.model).toBe("text-embedding-3-small");
  });

  it("supports base64 encoding and agent-scoped auth/config resolution", async () => {
    const res = await postEmbeddings(
      {
        model: "openclaw/beta",
        input: "hello",
        encoding_format: "base64",
      },
      { "x-openclaw-agent-id": "beta" },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: Array<{ embedding?: string }> };
    expect(typeof json.data?.[0]?.embedding).toBe("string");
    expect(createEmbeddingProviderMock).toHaveBeenCalled();
    const lastCall = latestCreateEmbeddingProviderOptions();
    expect(typeof lastCall.model).toBe("string");
    expect(lastCall.agentDir).toBe(resolveAgentDir({}, "beta"));
  });

  it("rejects invalid input shapes", async () => {
    const res = await postEmbeddings({
      model: "openclaw/default",
      input: [{ nope: true }],
    });
    await expectInvalidEmbeddingRequest(res);
  });

  it("ignores narrower declared scopes for shared-secret bearer auth", async () => {
    const res = await postEmbeddings(
      {
        model: "openclaw/default",
        input: "hello",
      },
      { "x-openclaw-scopes": "operator.read" },
    );
    await expectDefaultEmbeddingResponse(res);
  });

  it("allows requests with an empty declared scopes header", async () => {
    const res = await postEmbeddings(
      {
        model: "openclaw/default",
        input: "hello",
      },
      { "x-openclaw-scopes": "" },
    );
    await expectDefaultEmbeddingResponse(res);
  });

  it("allows requests when the operator scopes header is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${enabledPort}/v1/embeddings`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "openclaw/default",
        input: "hello",
      }),
    });
    await expectDefaultEmbeddingResponse(res);
  });

  it("routes explicit OpenAI-compatible embeddings through generic providers", async () => {
    testState.agentConfig = {
      memorySearch: {
        provider: "openai-compatible",
        model: "nomic-embed-text",
        inputType: "default",
        queryInputType: "query",
        documentInputType: "document",
        outputDimensionality: 768,
        remote: {
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKey: { type: "env", env: "OLLAMA_API_KEY" },
        },
      },
    };
    resetConfigRuntimeState();

    await expectGenericProviderEmbeddingRequest({
      provider: "openai-compatible",
      model: "nomic-embed-text",
      dimensions: 768,
      inputType: "default",
      queryInputType: "query",
      documentInputType: "document",
    });
  });

  it("routes configured OpenAI-compatible provider ids through generic providers", async () => {
    const configPath = createConfigIO().configPath;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          models: {
            providers: {
              "tenant-embeddings": {
                api: "openai-responses",
                baseUrl: "http://127.0.0.1:11434/v1",
                models: [],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    testState.agentConfig = {
      memorySearch: {
        provider: "tenant-embeddings",
        model: "tenant-embeddings/nomic-embed-text",
        inputType: "default",
        queryInputType: "query",
        documentInputType: "document",
        outputDimensionality: 768,
      },
    };
    resetConfigRuntimeState();

    await expectGenericProviderEmbeddingRequest({
      provider: "tenant-embeddings",
      model: "nomic-embed-text",
      dimensions: 768,
      inputType: "default",
      queryInputType: "query",
      documentInputType: "document",
    });
  });

  it("rejects invalid agent targets", async () => {
    const res = await postEmbeddings({
      model: "ollama/nomic-embed-text",
      input: "hello",
    });
    await expectInvalidEmbeddingRequest(
      res,
      "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
    );
  });

  it("rejects disallowed x-openclaw-model provider overrides", async () => {
    const res = await postEmbeddings(
      {
        model: "openclaw/default",
        input: "hello",
      },
      { "x-openclaw-model": "ollama/nomic-embed-text" },
    );
    await expectInvalidEmbeddingRequest(
      res,
      "This agent does not allow that embedding provider on `/v1/embeddings`.",
    );
  });

  it("rejects oversized batches", async () => {
    const res = await postEmbeddings({
      model: "openclaw/default",
      input: Array.from({ length: 129 }, () => "x"),
    });
    await expectInvalidEmbeddingRequest(res, "Too many inputs (max 128).");
  });

  it("sanitizes provider failures", async () => {
    createEmbeddingProviderMock.mockRejectedValueOnce(new Error("secret upstream failure"));
    const res = await postEmbeddings({
      model: "openclaw/default",
      input: "hello",
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error?: { type?: string; message?: string } };
    expect(json.error).toEqual({
      type: "api_error",
      message: "internal error",
    });
  });
});
