// Google tests cover embedding batch bounded JSON response reads.
import { createServer } from "node:http";
import * as embeddingSdk from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGeminiEmbeddingBatches } from "./embedding-batch.js";
import type { GeminiEmbeddingClient } from "./embedding-provider.js";
import { geminiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/logging-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/logging-core")>();
  return {
    ...actual,
    createSubsystemLogger: () => loggerMocks,
  };
});

// Pass-through so onResponse receives real Response objects (required by
// readProviderJsonResponse which needs a real .body ReadableStream).
vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")>();
  return {
    ...actual,
    withRemoteHttpResponse: async <T>(params: {
      url: string;
      ssrfPolicy?: unknown;
      init?: RequestInit;
      onResponse: (response: Response) => Promise<T>;
    }): Promise<T> => {
      const response = await fetch(params.url, params.init);
      return await params.onResponse(response);
    },
  };
});

afterEach(() => {
  loggerMocks.info.mockClear();
  loggerMocks.warn.mockClear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function listenLoopbackServer(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function makeGeminiClient(
  baseUrl = "https://generativelanguage.googleapis.com/v1beta",
): GeminiEmbeddingClient {
  return {
    baseUrl,
    model: "gemini-embedding-001",
    modelPath: "models/gemini-embedding-001",
    headers: { "x-goog-api-client": "test-client" },
    apiKeys: ["test-key"],
    ssrfPolicy: undefined,
  };
}

function makeGeminiEmbedding2Client(
  outputDimensionality: number,
  baseUrl = "https://generativelanguage.googleapis.com/v1beta",
): GeminiEmbeddingClient {
  return {
    ...makeGeminiClient(baseUrl),
    model: "gemini-embedding-2",
    modelPath: "models/gemini-embedding-2",
    outputDimensionality,
  };
}

type GeminiBatchRequest = Parameters<typeof runGeminiEmbeddingBatches>[0]["requests"][number];

function batchRequest(customId: string, text: string): GeminiBatchRequest {
  return {
    custom_id: customId,
    request: {
      model: "models/gemini-embedding-001",
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_DOCUMENT",
    },
  };
}

function singleRequest(): GeminiBatchRequest[] {
  return [batchRequest("r0", "hello")];
}

type BatchStage = "upload" | "create" | "status" | "download";

function batchStageForUrl(url: string): BatchStage {
  if (url.includes("/upload/")) {
    return "upload";
  }
  if (url.includes(":asyncBatchEmbedContent")) {
    return "create";
  }
  if (url.includes("/batches/")) {
    return "status";
  }
  if (url.includes(":download")) {
    return "download";
  }
  throw new Error(`unexpected Gemini batch URL: ${url}`);
}

function defaultBatchResponse(stage: BatchStage): Response {
  switch (stage) {
    case "upload":
      return jsonResponse({ file: { name: "files/f-ok" } });
    case "create":
      return jsonResponse({
        name: "batches/b-0",
        done: false,
        metadata: { state: "BATCH_STATE_PENDING" },
      });
    case "status":
      return jsonResponse({
        name: "batches/b-0",
        done: true,
        metadata: { state: "BATCH_STATE_SUCCEEDED" },
        response: { responsesFile: "files/out-0" },
      });
    case "download":
      return new Response(
        JSON.stringify({ key: "r0", response: { embedding: { values: [1, 0, 0] } } }),
        { status: 200 },
      );
  }
  throw new Error("unexpected Gemini batch stage");
}

function stubBatchFetch(
  override?: (stage: BatchStage, url: string, init?: RequestInit) => Response | undefined,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = fetchInputUrl(input);
    const stage = batchStageForUrl(url);
    return override?.(stage, url, init) ?? defaultBatchResponse(stage);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function runBatch(
  requests = singleRequest(),
  gemini = makeGeminiClient(),
): Promise<Map<string, number[]>> {
  return runGeminiEmbeddingBatches({
    gemini,
    agentId: "main",
    requests,
    wait: true,
    concurrency: 1,
    pollIntervalMs: 1,
    timeoutMs: 5_000,
  });
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function makeOversizedResponse(status = 200): {
  response: Response;
  getReadCount: () => number;
  wasCanceled: () => boolean;
} {
  const chunkSize = 1024 * 1024;
  const chunkCount = 20; // 20 MiB — over 16 MiB cap
  let readCount = 0;
  let canceled = false;
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (readCount >= chunkCount) {
            controller.close();
            return;
          }
          readCount += 1;
          controller.enqueue(new Uint8Array(chunkSize));
        },
        cancel() {
          canceled = true;
        },
      }),
      { status, headers: { "Content-Type": "application/json" } },
    ),
    getReadCount: () => readCount,
    wasCanceled: () => canceled,
  };
}

describe("Google embedding-batch bounded JSON reads", () => {
  it("rejects async batch embeddings that do not match the requested dimensions", async () => {
    stubBatchFetch((stage) => {
      if (stage !== "download") {
        return undefined;
      }
      return new Response(
        JSON.stringify({ key: "r0", response: { embedding: { values: [1, 0, 0] } } }),
        { status: 200 },
      );
    });

    await expect(runBatch(singleRequest(), makeGeminiEmbedding2Client(768))).rejects.toThrow(
      "gemini embeddings failed: expected 768 dimensions, received 3",
    );
  });

  it("stops before polling status after the batch timeout expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = stubBatchFetch();

    const result = runGeminiEmbeddingBatches({
      gemini: makeGeminiClient(),
      agentId: "main",
      requests: singleRequest(),
      wait: true,
      concurrency: 1,
      pollIntervalMs: 2_000,
      timeoutMs: 1_000,
      debug: (message) => {
        if (message.includes("batches/b-0 pending")) {
          vi.setSystemTime(1_000);
        }
      },
    });
    const rejection = captureRejection(result);

    await expect(rejection).resolves.toMatchObject({
      message: "gemini batch batches/b-0 timed out after 1000ms",
    });
    expect(
      fetchMock.mock.calls.filter(([input]) => fetchInputUrl(input).includes("/batches/")),
    ).toHaveLength(0);
  });

  it.each([
    { stage: "upload", label: "gemini.batch-file-upload" },
    { stage: "create", label: "gemini.batch-create" },
    { stage: "status", label: "gemini.batch-status" },
  ] as const)("bounds oversized successful $stage JSON", async ({ stage, label }) => {
    const streamed = makeOversizedResponse();
    stubBatchFetch((candidate) => (candidate === stage ? streamed.response : undefined));

    const error = await captureRejection(runBatch());

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(label);
    expect(streamed.wasCanceled()).toBe(true);
    expect(streamed.getReadCount()).toBeLessThan(20);
  });

  it("reports malformed output without logging response content", async () => {
    const responseMarker = "secret-response-body-4451";
    stubBatchFetch((stage) =>
      stage === "download" ? new Response(`not-json ${responseMarker}`) : undefined,
    );

    await expect(runBatch()).rejects.toThrow("malformed JSONL record");
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "memory embeddings: gemini batch output reconciliation failed",
      expect.objectContaining({
        failureKind: "transport-or-parse",
        unreconciledResponses: 1,
      }),
    );
    expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain(responseMarker);
  });

  it.each([
    { stage: "upload", label: "gemini.batch-file-upload" },
    { stage: "create", label: "gemini.batch-create" },
    { stage: "status", label: "gemini.batch-status" },
    { stage: "download", label: "gemini.batch-file-content" },
  ] as const)("bounds oversized $stage errors", async ({ stage, label }) => {
    const streamed = makeOversizedResponse(503);
    stubBatchFetch((candidate) => (candidate === stage ? streamed.response : undefined));

    const error = await captureRejection(runBatch());

    expect(error).toMatchObject({ name: "ProviderHttpError", status: 503, statusCode: 503 });
    expect((error as Error).message).toContain(label);
    expect(streamed.wasCanceled()).toBe(true);
    expect(streamed.getReadCount()).toBeLessThan(20);
    if (stage === "download") {
      expect(loggerMocks.warn).toHaveBeenCalledWith(
        "memory embeddings: gemini batch output reconciliation failed",
        expect.objectContaining({
          failureKind: "http",
          providerStatus: 503,
          unreconciledResponses: 1,
        }),
      );
    }
  });

  it("marks create 404 as unavailable while preserving the structured cause", async () => {
    const response = jsonResponse(
      { error: { code: 404, message: "Input file was not found", status: "NOT_FOUND" } },
      404,
    );
    stubBatchFetch((stage) => (stage === "create" ? response : undefined));

    const error = await captureRejection(runBatch());

    expect(error).toMatchObject({
      name: "EmbeddingBatchUnavailableError",
      code: "embedding_batch_unavailable",
    });
    expect((error as Error).message).toContain("asyncBatchEmbedContent not available");
    expect((error as Error).cause).toMatchObject({
      name: "ProviderHttpError",
      status: 404,
      code: "NOT_FOUND",
    });
    expect(((error as Error).cause as Error).message).toContain("Input file was not found");
    expect((error as Error).message).not.toContain("switch providers");
    expect(response.bodyUsed).toBe(true);
  });

  it.each([
    { baseUrl: "https://generativelanguage.googleapis.com/v1beta", version: "v1beta", query: "" },
    {
      baseUrl: "https://generativelanguage.googleapis.com/v1alpha/?tenant=remote",
      version: "v1alpha",
      query: "tenant=remote&",
    },
  ])("uses canonical Google file routes for $baseUrl", async ({ baseUrl, version, query }) => {
    const fetchMock = stubBatchFetch();

    const result = await runBatch(singleRequest(), makeGeminiClient(baseUrl));

    expect(result.get("r0")).toEqual([1, 0, 0]);
    expect(fetchMock.mock.calls.map(([input]) => fetchInputUrl(input))).toEqual([
      `https://generativelanguage.googleapis.com/upload/${version}/files?${query}uploadType=multipart`,
      `https://generativelanguage.googleapis.com/${version}/models/gemini-embedding-001:asyncBatchEmbedContent${query ? `?${query.slice(0, -1)}` : ""}`,
      `https://generativelanguage.googleapis.com/${version}/batches/b-0${query ? `?${query.slice(0, -1)}` : ""}`,
      `https://generativelanguage.googleapis.com/download/${version}/files/out-0:download?${query}alt=media`,
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("test-key");
    }
    const createCall = fetchMock.mock.calls.find(([input]) =>
      fetchInputUrl(input).includes(":asyncBatchEmbedContent"),
    );
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      batch: { inputConfig: { file_name: "files/f-ok" } },
    });
  });

  it("reports provider lifecycle statistics and output reconciliation", async () => {
    const requests = [batchRequest("r0", "hello"), batchRequest("r1", "world")];
    stubBatchFetch((stage) => {
      if (stage === "create") {
        return jsonResponse({
          name: "batches/b-telemetry",
          done: false,
          metadata: {
            state: "BATCH_STATE_PENDING",
            createTime: "2026-08-09T01:00:00Z",
            updateTime: "2026-08-09T01:00:01Z",
            batchStats: { requestCount: "2", pendingRequestCount: "2" },
          },
        });
      }
      if (stage === "status") {
        return jsonResponse({
          name: "batches/b-telemetry",
          done: true,
          state: "BATCH_STATE_SUCCEEDED",
          createTime: "2026-08-09T01:00:00Z",
          endTime: "2026-08-09T01:00:05Z",
          batchStats: {
            requestCount: "2",
            successfulRequestCount: "2",
            failedRequestCount: "0",
            pendingRequestCount: "0",
          },
          metadata: {
            state: "BATCH_STATE_RUNNING",
            batchStats: { successfulRequestCount: "999" },
          },
          output: { responsesFile: "files/out-telemetry" },
        });
      }
      if (stage === "download") {
        return new Response(
          [
            JSON.stringify({ key: "r0", response: { embedding: { values: [1, 0] } } }),
            JSON.stringify({ key: "r1", response: { embedding: { values: [0, 1] } } }),
          ].join("\n"),
        );
      }
      return undefined;
    });

    await expect(runBatch(requests)).resolves.toEqual(
      new Map([
        ["r0", [1, 0]],
        ["r1", [0, 1]],
      ]),
    );

    expect(loggerMocks.info).toHaveBeenCalledWith(
      "memory embeddings: gemini batch created",
      expect.objectContaining({
        batchName: "batches/b-telemetry",
        state: "pending",
        submittedRequests: 2,
        providerCreateTime: "2026-08-09T01:00:00.000Z",
        providerUpdateTime: "2026-08-09T01:00:01.000Z",
        providerRequestCount: 2,
        providerPendingRequests: 2,
      }),
    );
    const createdLog = loggerMocks.info.mock.calls.find(
      ([message]) => message === "memory embeddings: gemini batch created",
    )?.[1];
    expect(createdLog).not.toHaveProperty("providerElapsedMs");
    expect(loggerMocks.info).toHaveBeenCalledWith(
      "memory embeddings: gemini batch completed",
      expect.objectContaining({
        state: "succeeded",
        providerSuccessfulRequests: 2,
        providerFailedRequests: 0,
        providerPendingRequests: 0,
        providerEndTime: "2026-08-09T01:00:05.000Z",
        providerElapsedMs: 5_000,
      }),
    );
    expect(loggerMocks.info).toHaveBeenCalledWith(
      "memory embeddings: gemini batch output reconciled",
      expect.objectContaining({
        returnedEmbeddings: 2,
        missingResponses: 0,
        outputErrors: 0,
      }),
    );
  });

  it("reconciles later responses after a provider output error", async () => {
    const requests = [batchRequest("r0", "hello"), batchRequest("r1", "world")];
    stubBatchFetch((stage) =>
      stage === "download"
        ? new Response(
            [
              JSON.stringify({
                key: "r0",
                response: { error: { message: "provider rejected record" } },
              }),
              JSON.stringify({ key: "r1", response: { embedding: { values: [0, 1] } } }),
            ].join("\n"),
          )
        : undefined,
    );

    await expect(runBatch(requests)).rejects.toThrow("provider rejected record");
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "memory embeddings: gemini batch output reconciliation failed",
      expect.objectContaining({
        submittedRequests: 2,
        returnedEmbeddings: 1,
        missingResponses: 0,
        outputErrors: 1,
      }),
    );
  });

  it("never logs request text, authentication, or embedding vectors", async () => {
    const secretText = "secret-request-text-7f51";
    const secretApiKey = "secret-api-key-9a32";
    const secretVectorValue = 987654.321;
    const gemini = { ...makeGeminiClient(), apiKeys: [secretApiKey] };
    stubBatchFetch((stage) =>
      stage === "download"
        ? new Response(
            JSON.stringify({
              key: "r0",
              response: { embedding: { values: [secretVectorValue, 1] } },
            }),
          )
        : undefined,
    );

    await runBatch([batchRequest("r0", secretText)], gemini);

    const serializedLogs = JSON.stringify({
      info: loggerMocks.info.mock.calls,
      warn: loggerMocks.warn.mock.calls,
    });
    expect(serializedLogs).not.toContain(secretText);
    expect(serializedLogs).not.toContain(secretApiKey);
    expect(serializedLogs).not.toContain(String(secretVectorValue));
  });

  it("uses a consistent local observed duration when provider timestamps are absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    stubBatchFetch((stage) => {
      if (stage === "create") {
        vi.setSystemTime(2_500);
        return jsonResponse({
          name: "batches/b-local-clock",
          done: true,
          state: "BATCH_STATE_SUCCEEDED",
          output: { responsesFile: "files/out-local-clock" },
        });
      }
      return undefined;
    });

    await runBatch();

    expect(loggerMocks.info).toHaveBeenCalledWith(
      "memory embeddings: gemini batch completed",
      expect.objectContaining({ observedElapsedMs: 2_500 }),
    );
    const completedLog = loggerMocks.info.mock.calls.find(
      ([message]) => message === "memory embeddings: gemini batch completed",
    )?.[1];
    expect(completedLog).not.toHaveProperty("providerElapsedMs");
  });

  it("preserves a configured gateway prefix for output downloads", async () => {
    const fetchMock = stubBatchFetch();

    await runBatch(singleRequest(), makeGeminiClient("https://gateway.example/gemini/v1beta"));

    expect(fetchMock.mock.calls.map(([input]) => fetchInputUrl(input))).toContain(
      "https://gateway.example/gemini/v1beta/files/out-0:download?alt=media",
    );
  });

  it.each([
    { basePath: "/v1beta", prefix: "", query: "" },
    { basePath: "/gateway/v1beta/", prefix: "/gateway", query: "?tenant=remote" },
    { basePath: "/gateway/v1beta/", prefix: "/gateway", query: "?tenant=remote&route=a/" },
    { basePath: "/gateway/v1beta", prefix: "/gateway", query: "?tenant=/openai/team/" },
    { basePath: "/gateway/v1beta/openai", prefix: "/gateway", query: "?tenant=remote" },
  ])(
    "runs the public adapter over HTTP for $basePath with query $query",
    async ({ basePath, prefix, query }) => {
      let createBody: unknown;
      let uploadBody = "";
      const observedUrls: string[] = [];
      const authHeaders: Array<string | undefined> = [];
      const tenantHeaders: Array<string | undefined> = [];
      const realSdk = await vi.importActual<typeof embeddingSdk>(
        "openclaw/plugin-sdk/memory-core-host-engine-embeddings",
      );
      const remoteHttp = vi
        .spyOn(embeddingSdk, "withRemoteHttpResponse")
        .mockImplementation(realSdk.withRemoteHttpResponse);
      const server = createServer((request, response) => {
        void (async () => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          observedUrls.push(`${request.method} ${url.pathname}${url.search}`);
          const apiKey = request.headers["x-goog-api-key"];
          authHeaders.push(Array.isArray(apiKey) ? apiKey.join(", ") : apiKey);
          const tenant = request.headers["x-proof-tenant"];
          tenantHeaders.push(Array.isArray(tenant) ? tenant.join(", ") : tenant);
          const expectedQuery = new URLSearchParams(query);
          const configuredQuerySurvives = [...expectedQuery].every(
            ([name, value]) => url.searchParams.get(name) === value,
          );
          if (!configuredQuerySurvives) {
            response.writeHead(400).end(`configured query changed: ${url.pathname}${url.search}`);
            request.resume();
            return;
          }
          const respondJson = (body: unknown) => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
          };
          if (url.pathname === `${prefix}/v1beta/models/gemini-embedding-001:embedContent`) {
            request.resume();
            respondJson({ embedding: { values: [1, 0, 0] } });
            return;
          }
          if (
            url.pathname === `${prefix}/upload/v1beta/files` &&
            url.searchParams.get("uploadType") === "multipart"
          ) {
            request.setEncoding("utf8");
            for await (const chunk of request) {
              uploadBody += chunk;
            }
            respondJson({ file: { name: "files/input-0" } });
            return;
          }
          if (
            url.pathname === `${prefix}/v1beta/models/gemini-embedding-001:asyncBatchEmbedContent`
          ) {
            let body = "";
            request.setEncoding("utf8");
            for await (const chunk of request) {
              body += chunk;
            }
            createBody = JSON.parse(body) as unknown;
            respondJson({
              name: "batches/b-0",
              done: false,
              metadata: { state: "BATCH_STATE_PENDING" },
            });
            return;
          }
          if (url.pathname === `${prefix}/v1beta/batches/b-0`) {
            respondJson({
              name: "batches/b-0",
              done: true,
              metadata: { state: "BATCH_STATE_SUCCEEDED" },
              response: { responsesFile: "files/output-0" },
            });
            return;
          }
          if (
            url.pathname === `${prefix}/v1beta/files/output-0:download` &&
            url.searchParams.get("alt") === "media"
          ) {
            response.writeHead(200, { "content-type": "application/jsonl" });
            const line = JSON.stringify({
              key: "0",
              response: { embedding: { values: [1, 0, 0] } },
            });
            response.write(line.slice(0, 17));
            response.end(line.slice(17));
            return;
          }
          response.writeHead(404).end();
        })().catch((error: unknown) => {
          response.writeHead(500).end(error instanceof Error ? error.message : String(error));
        });
      });
      const port = await listenLoopbackServer(server);

      try {
        const adapter = await geminiMemoryEmbeddingProviderAdapter.create({
          config: {},
          provider: "gemini",
          model: "gemini-embedding-001",
          fallback: "none",
          remote: {
            baseUrl: `http://127.0.0.1:${port}${basePath}${query}`,
            apiKey: "test-key",
            headers: { "X-Proof-Tenant": "remote" },
          },
        });
        if (!adapter.provider) {
          throw new Error("Expected a Gemini embedding provider");
        }
        await expect(adapter.provider.embed("hello", { inputType: "query" })).resolves.toEqual([
          1, 0, 0,
        ]);
        const result = await adapter.runtime?.batchEmbed?.({
          agentId: "main",
          chunks: [{ text: "hello" }],
          wait: true,
          concurrency: 1,
          pollIntervalMs: 1,
          timeoutMs: 5_000,
          debug: () => {},
        });

        expect(result).toEqual([[1, 0, 0]]);
        const uploadedRequest = uploadBody.split("\r\n\r\n")[2]?.split("\r\n")[0];
        expect(JSON.parse(uploadedRequest ?? "null")).toEqual({
          key: "0",
          request: {
            content: { parts: [{ text: "hello" }] },
            taskType: "RETRIEVAL_DOCUMENT",
            model: "models/gemini-embedding-001",
          },
        });
        expect(createBody).toMatchObject({
          batch: { inputConfig: { file_name: "files/input-0" } },
        });
        expect(authHeaders).toEqual(Array(5).fill("test-key"));
        expect(tenantHeaders).toEqual(Array(5).fill("remote"));
        expect(observedUrls.map((value) => value.split("?")[0])).toEqual([
          `POST ${prefix}/v1beta/models/gemini-embedding-001:embedContent`,
          `POST ${prefix}/upload/v1beta/files`,
          `POST ${prefix}/v1beta/models/gemini-embedding-001:asyncBatchEmbedContent`,
          `GET ${prefix}/v1beta/batches/b-0`,
          `GET ${prefix}/v1beta/files/output-0:download`,
        ]);
      } finally {
        remoteHttp.mockRestore();
        await closeServer(server);
      }
    },
  );

  it("honors terminal LRO fields when metadata is stale", async () => {
    stubBatchFetch((stage) =>
      stage === "create"
        ? jsonResponse({
            name: "batches/b-0",
            done: true,
            metadata: { state: "BATCH_STATE_RUNNING" },
            response: { responsesFile: "files/out-0" },
          })
        : undefined,
    );

    await expect(runBatch()).resolves.toEqual(new Map([["r0", [1, 0, 0]]]));
  });

  it("keeps a terminal Operation error ahead of stale success metadata", async () => {
    const providerErrorMarker = "secret-request-text-7f51";
    stubBatchFetch((stage) =>
      stage === "create"
        ? jsonResponse({
            name: "batches/b-0",
            done: true,
            metadata: { state: "BATCH_STATE_SUCCEEDED" },
            response: { responsesFile: "files/out-0" },
            error: { code: 13, message: `provider job failed: ${providerErrorMarker}` },
          })
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow("gemini batch batches/b-0 failed");
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "memory embeddings: gemini batch terminal failure",
      expect.objectContaining({ state: "failed", providerErrorCode: 13 }),
    );
    expect(JSON.stringify(loggerMocks.warn.mock.calls)).not.toContain(providerErrorMarker);
  });

  it("keeps shipped compatible-endpoint output aliases", async () => {
    const requests = [batchRequest("r0", "hello"), batchRequest("r1", "world")];
    stubBatchFetch((stage) =>
      stage === "download"
        ? new Response(
            [
              JSON.stringify({ custom_id: "r0", embedding: { values: [1, 0] } }),
              JSON.stringify({ request_id: "r1", embedding: { values: [0, 1] } }),
            ].join("\n"),
          )
        : undefined,
    );

    await expect(runBatch(requests)).resolves.toEqual(
      new Map([
        ["r0", [1, 0]],
        ["r1", [0, 1]],
      ]),
    );
  });

  it("falls back from an empty top-level output error", async () => {
    stubBatchFetch((stage) =>
      stage === "download"
        ? new Response(
            JSON.stringify({
              key: "r0",
              error: { message: "" },
              response: { error: { message: "nested output error" } },
            }),
          )
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow("nested output error");
  });

  it.each([
    { state: "BATCH_STATE_FAILED", normalized: "failed" },
    { state: "JOB_STATE_CANCELLED", normalized: "cancelled" },
    { state: "BATCH_STATE_EXPIRED", normalized: "expired" },
  ])("surfaces $state Operation failures", async ({ state, normalized }) => {
    stubBatchFetch((stage) =>
      stage === "create"
        ? jsonResponse({
            name: "batches/b-0",
            done: true,
            createTime: "2026-08-09T01:00:00Z",
            endTime: "2026-08-09T01:00:03Z",
            batchStats: {
              requestCount: "1",
              successfulRequestCount: "0",
              failedRequestCount: "1",
              pendingRequestCount: "0",
            },
            metadata: { state },
          })
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow(`gemini batch batches/b-0 ${normalized}`);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "memory embeddings: gemini batch terminal failure",
      expect.objectContaining({
        state: normalized,
        providerRequestCount: 1,
        providerFailedRequests: 1,
        providerPendingRequests: 0,
        providerElapsedMs: 3_000,
      }),
    );
  });

  it("prefers canonical output over stale legacy aliases", async () => {
    const fetchMock = stubBatchFetch((stage) =>
      stage === "create"
        ? jsonResponse({
            name: "batches/b-0",
            done: true,
            state: "BATCH_STATE_SUCCEEDED",
            output: { responsesFile: "files/top-level-output" },
            metadata: {
              state: "BATCH_STATE_SUCCEEDED",
              output: { responsesFile: "files/metadata-output" },
            },
            response: { responsesFile: "files/response-output" },
          })
        : undefined,
    );

    await expect(runBatch()).resolves.toEqual(new Map([["r0", [1, 0, 0]]]));
    expect(fetchMock.mock.calls.map(([input]) => fetchInputUrl(input))).toContain(
      "https://generativelanguage.googleapis.com/download/v1beta/files/top-level-output:download?alt=media",
    );
    expect(loggerMocks.info).toHaveBeenCalledWith(
      "memory embeddings: gemini batch completed",
      expect.objectContaining({ state: "succeeded" }),
    );
    expect(loggerMocks.warn).not.toHaveBeenCalledWith(
      "memory embeddings: gemini batch output metadata unusable",
      expect.anything(),
    );
  });

  it("rejects conflicting legacy output aliases without a canonical output", async () => {
    const fetchMock = stubBatchFetch((stage) =>
      stage === "create"
        ? jsonResponse({
            name: "batches/b-0",
            done: true,
            state: "BATCH_STATE_SUCCEEDED",
            metadata: {
              state: "BATCH_STATE_SUCCEEDED",
              output: { responsesFile: "files/metadata-output" },
            },
            response: { responsesFile: "files/response-output" },
          })
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow(
      "gemini batch operation returned conflicting output files",
    );
    expect(
      fetchMock.mock.calls.map(([input]) => batchStageForUrl(fetchInputUrl(input))),
    ).not.toContain("download");
  });

  it("reports terminal success when the provider omits output metadata", async () => {
    stubBatchFetch((stage) =>
      stage === "create"
        ? jsonResponse({
            name: "batches/b-no-output",
            done: true,
            state: "BATCH_STATE_SUCCEEDED",
            createTime: "2026-08-09T01:00:00Z",
            endTime: "2026-08-09T01:00:02Z",
            batchStats: { requestCount: "1", successfulRequestCount: "1" },
          })
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow("completed without output file");
    expect(loggerMocks.info).toHaveBeenCalledWith(
      "memory embeddings: gemini batch completed",
      expect.objectContaining({ providerSuccessfulRequests: 1, providerElapsedMs: 2_000 }),
    );
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      "memory embeddings: gemini batch output metadata unusable",
      expect.objectContaining({ failureKind: "missing-output-file" }),
    );
  });
});
