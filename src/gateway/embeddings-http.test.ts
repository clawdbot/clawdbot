// Embeddings HTTP tests cover OpenAI-compatible embedding routes, provider
// adapters, agent-scoped config, auth scopes, and disabled-surface behavior.
import fs from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { createConfigIO, resetConfigRuntimeState } from "../config/config.js";
import type {
  EmbeddingInput,
  EmbeddingProviderCallOptions,
} from "../plugins/embedding-providers.js";
import type { MemoryEmbeddingProviderAdapter } from "../plugins/memory-embedding-providers.js";
import { createPluginRegistry } from "../plugins/registry.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { startOpenAiCompatGatewayServer } from "./openai-compatible-http.test-helpers.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  resetTestPluginRegistry,
  setTestPluginRegistry,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const WRITE_SCOPE_HEADER = { "x-openclaw-scopes": "operator.write" };

let startGatewayServer: typeof import("./server.js").startGatewayServer;
let createEmbeddingProviderMock: ReturnType<
  typeof vi.fn<
    (options: {
      provider: string;
      model: string;
      agentDir?: string;
      acquireLocalService?: unknown;
    }) => Promise<{
      provider: {
        id: string;
        model: string;
        embed: (input: EmbeddingInput, options?: EmbeddingProviderCallOptions) => Promise<number[]>;
        embedBatch: (
          inputs: EmbeddingInput[],
          options?: EmbeddingProviderCallOptions,
        ) => Promise<number[][]>;
        close?: () => Promise<void> | void;
      };
    }>
  >
>;
let embedBatchMock: ReturnType<
  typeof vi.fn<
    (inputs: EmbeddingInput[], options?: EmbeddingProviderCallOptions) => Promise<number[][]>
  >
>;
let closeEmbeddingProviderMock: ReturnType<typeof vi.fn<() => Promise<void> | void>>;
let openAiAdapter: MemoryEmbeddingProviderAdapter;
let drainRetainedOpenAiEmbeddingProviders: typeof import("./embeddings-http.js").drainRetainedOpenAiEmbeddingProviders;
let clearEmbeddingProviders: typeof import("../plugins/embedding-providers.js").clearEmbeddingProviders;
let registerEmbeddingProvider: typeof import("../plugins/embedding-providers.js").registerEmbeddingProvider;
let enabledServer: Awaited<ReturnType<typeof startOpenAiCompatGatewayServer>>;
let genericEmbeddingServer: { baseUrl: string; close: () => Promise<void> };
let enabledPort: number;
let genericEmbeddingBaseUrl: string;
const genericEmbeddingRequests: Array<{
  method: string | undefined;
  url: string | undefined;
  body: Record<string, unknown>;
}> = [];

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startGenericEmbeddingServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readJsonBody(req);
      genericEmbeddingRequests.push({
        method: req.method,
        url: req.url,
        body,
      });
      const input = Array.isArray(body.input) ? body.input : [body.input];
      const inputType = body.input_type;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: input.map((_text, index) => ({
            object: "embedding",
            embedding: [index + 9.1, inputType === "document" ? 9.2 : 0],
            index,
          })),
          model: body.model,
        }),
      );
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

beforeAll(async () => {
  ({ drainRetainedOpenAiEmbeddingProviders } = await import("./embeddings-http.js"));
  ({ clearEmbeddingProviders, registerEmbeddingProvider } =
    await import("../plugins/embedding-providers.js"));
  embedBatchMock = vi.fn(async (inputs: EmbeddingInput[]) =>
    inputs.map((_input, index) => [index + 0.1, index + 0.2]),
  );
  closeEmbeddingProviderMock = vi.fn(async () => {});
  createEmbeddingProviderMock = vi.fn(
    async (options: { provider: string; model: string; agentDir?: string }) => ({
      provider: {
        id: options.provider,
        model: options.model,
        embed: async () => [0.1, 0.2],
        embedBatch: embedBatchMock,
        close: closeEmbeddingProviderMock,
      },
    }),
  );
  genericEmbeddingServer = await startGenericEmbeddingServer();
  genericEmbeddingBaseUrl = genericEmbeddingServer.baseUrl;
  openAiAdapter = {
    id: "openai",
    defaultModel: "text-embedding-3-small",
    transport: "remote",
    autoSelectPriority: 20,
    allowExplicitWhenConfiguredAuto: true,
    create: async (options) => {
      const localServiceOptions = options as typeof options & {
        acquireLocalService?: unknown;
      };
      const result = await createEmbeddingProviderMock({
        provider: options.provider ?? "openai",
        model: options.model,
        agentDir: options.agentDir,
        acquireLocalService: localServiceOptions.acquireLocalService,
      });
      return result;
    },
  };
  ({ startGatewayServer } = await import("./server.js"));
  enabledPort = await getGatewayTestPort();
  enabledServer = await startOpenAiCompatGatewayServer({
    startGatewayServer,
    port: enabledPort,
    auth: { mode: "token", token: "secret" },
    openAiChatCompletionsEnabled: true,
  });
});

beforeEach(() => {
  const builder = createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: true,
  });
  setTestPluginRegistry(builder.registry);
  registerEmbeddingProvider(openAiAdapter);
});

afterEach(() => {
  clearEmbeddingProviders();
  resetTestPluginRegistry();
});

afterAll(async () => {
  await enabledServer.close({ reason: "embeddings http enabled suite done" });
  await genericEmbeddingServer.close();
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
  model: string;
  dimensions: number;
  inputType: string;
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
  acquireLocalService?: unknown;
} {
  const calls = createEmbeddingProviderMock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error("expected embedding provider create call");
  }
  return call[0];
}

function latestCreateGenericEmbeddingProviderOptions(): {
  model?: string;
  dimensions?: number;
  inputType?: string;
} {
  const request = genericEmbeddingRequests[genericEmbeddingRequests.length - 1];
  if (!request) {
    throw new Error("expected generic embedding provider request");
  }
  return {
    model: typeof request.body.model === "string" ? request.body.model : undefined,
    dimensions: typeof request.body.dimensions === "number" ? request.body.dimensions : undefined,
    inputType: typeof request.body.input_type === "string" ? request.body.input_type : undefined,
  };
}

describe("OpenAI-compatible embeddings HTTP API (e2e)", () => {
  it("embeds string and array inputs", async () => {
    const closesBefore = closeEmbeddingProviderMock.mock.calls.length;
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
    expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 3);
  });

  it("supports base64 encoding and agent-scoped auth/config resolution", async () => {
    try {
      testState.agentsConfig = { list: [{ id: "main" }, { id: "beta" }] };
      resetConfigRuntimeState();

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
    } finally {
      testState.agentsConfig = undefined;
      resetConfigRuntimeState();
    }
  });

  it("passes provider aliases and local-service acquisition to memory adapters", async () => {
    const configPath = createConfigIO().configPath;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          models: {
            providers: {
              "tenant-embeddings": {
                api: "openai",
                baseUrl: genericEmbeddingBaseUrl,
                models: [],
              },
            },
          },
          memory: {
            search: {
              provider: "tenant-embeddings",
              model: "tenant-embeddings/nomic-embed-text",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    try {
      resetConfigRuntimeState();

      const res = await postEmbeddings({
        model: "openclaw/default",
        input: "hello",
      });
      await expectDefaultEmbeddingResponse(res);
      const lastCall = latestCreateEmbeddingProviderOptions();
      expect(lastCall.provider).toBe("tenant-embeddings");
      expect(lastCall.model).toBe("nomic-embed-text");
      expect(lastCall.acquireLocalService).toEqual(expect.any(Function));
    } finally {
      resetConfigRuntimeState();
    }
  });

  it("rejects explicit unknown agent ids", async () => {
    try {
      testState.agentsConfig = { ownership: "explicit", entries: { main: {}, beta: {} } };
      resetConfigRuntimeState();

      const missing = await postEmbeddings({ model: "openclaw", input: "hello" });
      expect(missing.status).toBe(400);
      const missingJson = (await missing.json()) as {
        error?: { type?: string; message?: string };
      };
      expect(missingJson.error?.type).toBe("invalid_request_error");
      expect(missingJson.error?.message).toContain("has no explicit owner");

      const header = await postEmbeddings(
        { model: "openclaw/default", input: "hello" },
        { "x-openclaw-agent-id": "missing-agent" },
      );
      await expectInvalidEmbeddingRequest(header, "Unknown agent 'missing-agent'.");

      const model = await postEmbeddings({ model: "openclaw/missing-agent", input: "hello" });
      await expectInvalidEmbeddingRequest(model, "Unknown agent 'missing-agent'.");
    } finally {
      testState.agentsConfig = undefined;
      resetConfigRuntimeState();
    }
  });

  it("rejects invalid input shapes", async () => {
    const res = await postEmbeddings({
      model: "openclaw/default",
      input: [{ nope: true }],
    });
    await expectInvalidEmbeddingRequest(res);
  });

  it.each([
    { name: "unsupported encoding", option: { encoding_format: "hex" } },
    { name: "numeric encoding", option: { encoding_format: 1 } },
    { name: "zero dimensions", option: { dimensions: 0 } },
    { name: "negative dimensions", option: { dimensions: -1 } },
    { name: "fractional dimensions", option: { dimensions: 1.5 } },
    { name: "string dimensions", option: { dimensions: "768" } },
    { name: "unsafe dimensions", option: { dimensions: Number.MAX_SAFE_INTEGER + 1 } },
  ])("rejects $name before creating an embedding provider", async ({ option }) => {
    const providersCreatedBefore = createEmbeddingProviderMock.mock.calls.length;
    const res = await postEmbeddings({ model: "openclaw/default", input: "hello", ...option });

    await expectInvalidEmbeddingRequest(res);
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(providersCreatedBefore);
  });

  it.each([
    { name: "an empty string", input: "" },
    { name: "an empty batch", input: [] },
    { name: "an empty batch entry", input: [""] },
    { name: "a mixed batch with an empty entry", input: ["valid", ""] },
  ])("rejects $name before creating an embedding provider", async ({ input }) => {
    const providersCreatedBefore = createEmbeddingProviderMock.mock.calls.length;
    const res = await postEmbeddings({
      model: "openclaw/default",
      input,
    });

    await expectInvalidEmbeddingRequest(res, "`input` must contain at least one non-empty string.");
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(providersCreatedBefore);
  });

  it("preserves whitespace-only embedding input", async () => {
    const input = " \t\n";
    const res = await postEmbeddings({
      model: "openclaw/default",
      input,
    });

    await expectDefaultEmbeddingResponse(res);
    expect(embedBatchMock.mock.calls.at(-1)?.[0]).toEqual([input]);
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
    const configPath = createConfigIO().configPath;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          memory: {
            search: {
              provider: "openai-compatible",
              model: "nomic-embed-text",
              inputType: "default",
              queryInputType: "query",
              documentInputType: "document",
              outputDimensionality: 768,
              remote: { baseUrl: genericEmbeddingBaseUrl },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    resetConfigRuntimeState();

    await expectGenericProviderEmbeddingRequest({
      model: "nomic-embed-text",
      dimensions: 768,
      inputType: "document",
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
                baseUrl: genericEmbeddingBaseUrl,
                models: [],
              },
            },
          },
          memory: {
            search: {
              provider: "tenant-embeddings",
              model: "tenant-embeddings/nomic-embed-text",
              inputType: "default",
              queryInputType: "query",
              documentInputType: "document",
              outputDimensionality: 768,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    resetConfigRuntimeState();

    await expectGenericProviderEmbeddingRequest({
      model: "nomic-embed-text",
      dimensions: 768,
      inputType: "document",
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

  it("rejects x-openclaw-model for trusted write-only callers", async () => {
    const port = await getGatewayTestPort();
    const server = await startOpenAiCompatGatewayServer({
      startGatewayServer,
      port,
      auth: { mode: "none" },
      openAiChatCompletionsEnabled: true,
    });
    try {
      createEmbeddingProviderMock.mockClear();
      const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openclaw-scopes": "operator.write",
          "x-openclaw-model": "openai/text-embedding-3-small",
        },
        body: JSON.stringify({
          model: "openclaw/default",
          input: "hello",
        }),
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as { error?: { type?: string; message?: string } };
      expect(json.error?.type).toBe("forbidden");
      expect(json.error?.message).toBe("missing scope: operator.admin");
      expect(createEmbeddingProviderMock).not.toHaveBeenCalled();
    } finally {
      await server.close({ reason: "embeddings model override auth test done" });
    }
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

  it("closes the provider when embedding fails", async () => {
    const closesBefore = closeEmbeddingProviderMock.mock.calls.length;
    embedBatchMock.mockRejectedValueOnce(new Error("embedding failed"));

    const res = await postEmbeddings({
      model: "openclaw/default",
      input: "hello",
    });

    expect(res.status).toBe(500);
    expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 1);
  });

  it("aborts provider work when the HTTP client disconnects", async () => {
    const closesBefore = closeEmbeddingProviderMock.mock.calls.length;
    let receivedSignal: AbortSignal | undefined;
    const embedStarted = createDeferred();
    const releaseEmbed = createDeferred();
    embedBatchMock.mockImplementationOnce(async (_texts, options) => {
      const signal = options?.signal;
      receivedSignal = signal;
      embedStarted.resolve();
      await (signal
        ? new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          })
        : releaseEmbed.promise);
      return [[0.1, 0.2]];
    });

    const body = JSON.stringify({ model: "openclaw/default", input: "hello" });
    const clientRequest = httpRequest({
      host: "127.0.0.1",
      port: enabledPort,
      path: "/v1/embeddings",
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...WRITE_SCOPE_HEADER,
      },
    });
    clientRequest.on("error", () => {});
    clientRequest.end(body);

    await embedStarted.promise;
    clientRequest.destroy();

    try {
      await vi.waitFor(() => {
        expect(receivedSignal).toBeDefined();
        expect(receivedSignal?.aborted).toBe(true);
      });
    } finally {
      releaseEmbed.resolve();
    }
    await vi.waitFor(() =>
      expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 1),
    );
  });

  it("supports synchronous provider cleanup", async () => {
    const closesBefore = closeEmbeddingProviderMock.mock.calls.length;
    closeEmbeddingProviderMock.mockImplementationOnce(() => undefined);

    const res = await postEmbeddings({
      model: "openclaw/default",
      input: "hello",
    });

    expect(res.status).toBe(200);
    expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 1);
  });

  it("retains failed cleanup and blocks replacement until retirement succeeds", async () => {
    const createsBefore = createEmbeddingProviderMock.mock.calls.length;
    closeEmbeddingProviderMock
      .mockRejectedValueOnce(new Error("first close failed"))
      .mockRejectedValueOnce(new Error("retry close failed"));

    const first = await postEmbeddings({ model: "openclaw/default", input: "first" });
    expect(first.status).toBe(200);
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 1);

    const blocked = await postEmbeddings({ model: "openclaw/default", input: "blocked" });
    expect(blocked.status).toBe(500);
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 1);

    const recovered = await postEmbeddings({ model: "openclaw/default", input: "recovered" });
    expect(recovered.status).toBe(200);
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 2);
  });

  it("does not admit a replacement while provider cleanup is pending", async () => {
    Reflect.set(openAiAdapter, "transport", "local");
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    closeEmbeddingProviderMock.mockImplementationOnce(async () => {
      await closeGate;
      throw new Error("close failed");
    });
    const createsBefore = createEmbeddingProviderMock.mock.calls.length;
    const closesBefore = closeEmbeddingProviderMock.mock.calls.length;

    const firstPromise = postEmbeddings({ model: "openclaw/default", input: "first" });
    await vi.waitFor(() =>
      expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 1),
    );
    const secondPromise = postEmbeddings({ model: "openclaw/default", input: "second" });
    await Promise.resolve();
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 1);

    releaseClose();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    Reflect.set(openAiAdapter, "transport", "remote");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 2);
  });

  it("does not create a provider for a disconnected request waiting behind cleanup", async () => {
    Reflect.set(openAiAdapter, "transport", "local");
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    closeEmbeddingProviderMock.mockImplementationOnce(async () => {
      await closeGate;
    });
    const createsBefore = createEmbeddingProviderMock.mock.calls.length;
    const closesBefore = closeEmbeddingProviderMock.mock.calls.length;
    const firstPromise = postEmbeddings({ model: "openclaw/default", input: "first" });
    let secondRequest: ReturnType<typeof httpRequest> | undefined;

    try {
      await vi.waitFor(() =>
        expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 1),
      );

      const body = JSON.stringify({ model: "openclaw/default", input: "second" });
      secondRequest = httpRequest({
        host: "127.0.0.1",
        port: enabledPort,
        path: "/v1/embeddings",
        method: "POST",
        headers: {
          authorization: "******",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...WRITE_SCOPE_HEADER,
        },
      });
      secondRequest.on("error", () => {});
      const secondRequestFinished = createDeferred();
      secondRequest.once("finish", secondRequestFinished.resolve);
      const secondRequestClosed = createDeferred();
      secondRequest.once("close", secondRequestClosed.resolve);
      secondRequest.end(body);
      await secondRequestFinished.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      secondRequest.destroy();
      await secondRequestClosed.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      releaseClose();
      expect((await firstPromise).status).toBe(200);

      const next = await postEmbeddings({ model: "openclaw/default", input: "next" });
      expect(next.status).toBe(200);
      expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 2);
    } finally {
      releaseClose();
      secondRequest?.destroy();
      Reflect.set(openAiAdapter, "transport", "remote");
    }
  });

  it("serializes cleanup when a remote request creates a local provider", async () => {
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    closeEmbeddingProviderMock.mockImplementationOnce(async () => {
      await closeGate;
    });
    createEmbeddingProviderMock.mockResolvedValueOnce({
      provider: {
        id: "local",
        model: "local-embed",
        embed: async () => [0.1, 0.2],
        embedBatch: embedBatchMock,
        close: closeEmbeddingProviderMock,
      },
    });
    const createsBefore = createEmbeddingProviderMock.mock.calls.length;
    const closesBefore = closeEmbeddingProviderMock.mock.calls.length;

    const firstPromise = postEmbeddings({ model: "openclaw/default", input: "first" });
    await vi.waitFor(() =>
      expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 1),
    );
    const secondPromise = postEmbeddings({ model: "openclaw/default", input: "second" });
    await Promise.resolve();
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 1);

    releaseClose();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 2);
  });

  it("does not bypass local cleanup with a model override", async () => {
    Reflect.set(openAiAdapter, "transport", "local");
    let releaseClose: () => void = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    closeEmbeddingProviderMock.mockImplementationOnce(async () => {
      await closeGate;
    });
    const createsBefore = createEmbeddingProviderMock.mock.calls.length;
    const closesBefore = closeEmbeddingProviderMock.mock.calls.length;

    const firstPromise = postEmbeddings(
      { model: "openclaw/default", input: "first" },
      { "x-openclaw-model": "openai/model-a" },
    );
    await vi.waitFor(() =>
      expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 1),
    );
    const secondPromise = postEmbeddings(
      { model: "openclaw/default", input: "second" },
      { "x-openclaw-model": "openai/model-b" },
    );
    await Promise.resolve();
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 1);

    releaseClose();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    Reflect.set(openAiAdapter, "transport", "remote");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(createsBefore + 2);
  });

  it("allows providers without cleanup resources to embed concurrently", async () => {
    let releaseFirstEmbed: () => void = () => {};
    const firstEmbedGate = new Promise<void>((resolve) => {
      releaseFirstEmbed = resolve;
    });
    const firstEmbed = vi.fn(async () => {
      await firstEmbedGate;
      return [[1, 2]];
    });
    const secondEmbed = vi.fn(async () => [[3, 4]]);
    createEmbeddingProviderMock
      .mockResolvedValueOnce({
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embed: async () => [1, 2],
          embedBatch: firstEmbed,
          close: vi.fn(async () => {}),
        },
      })
      .mockResolvedValueOnce({
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embed: async () => [3, 4],
          embedBatch: secondEmbed,
          close: vi.fn(async () => {}),
        },
      });

    const firstPromise = postEmbeddings({ model: "openclaw/default", input: "first" });
    await vi.waitFor(() => expect(firstEmbed).toHaveBeenCalledTimes(1));
    const second = await postEmbeddings({ model: "openclaw/default", input: "second" });
    expect(second.status).toBe(200);
    expect(secondEmbed).toHaveBeenCalledTimes(1);

    releaseFirstEmbed();
    expect((await firstPromise).status).toBe(200);
  });

  it("drains retained provider cleanup during gateway shutdown", async () => {
    const closesBefore = closeEmbeddingProviderMock.mock.calls.length;
    closeEmbeddingProviderMock.mockRejectedValueOnce(new Error("close failed"));

    const res = await postEmbeddings({ model: "openclaw/default", input: "hello" });
    expect(res.status).toBe(200);

    await drainRetainedOpenAiEmbeddingProviders();
    expect(closeEmbeddingProviderMock).toHaveBeenCalledTimes(closesBefore + 2);
  });
});
