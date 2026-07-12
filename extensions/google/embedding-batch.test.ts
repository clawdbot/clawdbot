// Google tests cover embedding batch bounded JSON response reads.
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGeminiEmbeddingBatches } from "./embedding-batch.js";
import type { GeminiEmbeddingClient } from "./embedding-provider.js";

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
    model: "text-embedding-004",
    modelPath: "models/text-embedding-004",
    headers: { "x-goog-api-client": "test-client" },
    apiKeys: ["test-key"],
    ssrfPolicy: undefined,
  };
}

type GeminiBatchRequest = Parameters<typeof runGeminiEmbeddingBatches>[0]["requests"][number];

function batchRequest(customId: string, text: string): GeminiBatchRequest {
  return {
    custom_id: customId,
    request: {
      model: "models/text-embedding-004",
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

  it("normalizes raw Google Operations and uses the canonical download route", async () => {
    const fetchMock = stubBatchFetch();

    const result = await runBatch();

    expect(result.get("r0")).toEqual([1, 0, 0]);
    expect(fetchMock.mock.calls.map(([input]) => fetchInputUrl(input))).toContain(
      "https://generativelanguage.googleapis.com/download/v1beta/files/out-0:download?alt=media",
    );
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

  it("preserves a configured gateway prefix for output downloads", async () => {
    const fetchMock = stubBatchFetch();

    await runBatch(singleRequest(), makeGeminiClient("https://gateway.example/gemini/v1beta"));

    expect(fetchMock.mock.calls.map(([input]) => fetchInputUrl(input))).toContain(
      "https://gateway.example/gemini/v1beta/files/out-0:download?alt=media",
    );
  });

  it("runs the complete batch lifecycle over loopback HTTP", async () => {
    let createBody: unknown;
    const authHeaders: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const apiKey = request.headers["x-goog-api-key"];
        authHeaders.push(Array.isArray(apiKey) ? apiKey.join(", ") : apiKey);
        const respondJson = (body: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };
        if (url.pathname === "/upload/v1beta/files") {
          request.resume();
          await new Promise<void>((resolve) => {
            request.once("end", () => resolve());
          });
          respondJson({ file: { name: "files/input-0" } });
          return;
        }
        if (url.pathname.endsWith(":asyncBatchEmbedContent")) {
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
        if (url.pathname === "/v1beta/batches/b-0") {
          respondJson({
            name: "batches/b-0",
            done: true,
            metadata: { state: "BATCH_STATE_SUCCEEDED" },
            response: { responsesFile: "files/output-0" },
          });
          return;
        }
        if (url.pathname === "/v1beta/files/output-0:download") {
          response.writeHead(200, { "content-type": "application/jsonl" });
          const line = JSON.stringify({
            key: "r0",
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
      const result = await runBatch(
        singleRequest(),
        makeGeminiClient(`http://127.0.0.1:${port}/v1beta`),
      );

      expect(result).toEqual(new Map([["r0", [1, 0, 0]]]));
      expect(createBody).toMatchObject({ batch: { inputConfig: { file_name: "files/input-0" } } });
      expect(authHeaders).toEqual(["test-key", "test-key", "test-key", "test-key"]);
    } finally {
      await closeServer(server);
    }
  });

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
    stubBatchFetch((stage) =>
      stage === "create"
        ? jsonResponse({
            name: "batches/b-0",
            done: true,
            metadata: { state: "BATCH_STATE_SUCCEEDED" },
            response: { responsesFile: "files/out-0" },
            error: { code: 13, message: "provider job failed" },
          })
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow("gemini batch batches/b-0 failed");
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
            metadata: { state },
          })
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow(`gemini batch batches/b-0 ${normalized}`);
  });

  it("rejects conflicting output files in one Operation", async () => {
    stubBatchFetch((stage) =>
      stage === "create"
        ? jsonResponse({
            name: "batches/b-0",
            done: true,
            metadata: {
              state: "BATCH_STATE_SUCCEEDED",
              output: { responsesFile: "files/metadata-output" },
            },
            response: { responsesFile: "files/response-output" },
          })
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow("conflicting output files");
  });
});
