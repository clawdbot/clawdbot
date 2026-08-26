// Voyage batch tests cover the real HTTP boundary and bounded response reads.
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runVoyageEmbeddingBatches } from "./embedding-batch.js";
import { createVoyageEmbeddingProvider, type VoyageEmbeddingClient } from "./embedding-provider.js";

type VoyageBatchOptions = Parameters<typeof runVoyageEmbeddingBatches>[0];
type BatchStage = "upload" | "create" | "status" | "output" | "error";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildClient(): VoyageEmbeddingClient {
  return {
    baseUrl: "https://api.voyageai.test/v1",
    headers: { authorization: "Bearer fixture-voyage" },
    model: "voyage-3",
  };
}

function resolveBatchStage(url: string, init?: RequestInit): BatchStage {
  if (url.endsWith("/files") && init?.method === "POST") {
    return "upload";
  }
  if (url.endsWith("/batches") && init?.method === "POST") {
    return "create";
  }
  if (url.endsWith("/batches/batch-0")) {
    return "status";
  }
  if (url.endsWith("/files/output-0/content")) {
    return "output";
  }
  if (url.endsWith("/files/error-0/content")) {
    return "error";
  }
  throw new Error(`unexpected Voyage batch request: ${url}`);
}

function defaultBatchResponse(stage: BatchStage): Response {
  switch (stage) {
    case "upload":
      return jsonResponse({ id: "input-0" });
    case "create":
      return jsonResponse({ id: "batch-0", status: "in_progress" });
    case "status":
      return jsonResponse({ id: "batch-0", status: "completed", output_file_id: "output-0" });
    case "output":
      return new Response(
        JSON.stringify({
          custom_id: "req-0",
          response: { status_code: 200, body: { data: [{ embedding: [1, 2] }] } },
        }),
      );
    case "error":
      return new Response(
        JSON.stringify({
          custom_id: "req-0",
          response: { status_code: 500, message: "provider rejected request" },
          error: null,
        }),
      );
  }
  throw new Error("unexpected Voyage batch stage");
}

function fetchInputUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function stubBatchFetch(
  override?: (stage: BatchStage, url: string, init?: RequestInit) => Response | undefined,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = fetchInputUrl(input);
    const stage = resolveBatchStage(url, init);
    return override?.(stage, url, init) ?? defaultBatchResponse(stage);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function runBatch(overrides: Partial<VoyageBatchOptions> = {}) {
  return runVoyageEmbeddingBatches({
    client: buildClient(),
    agentId: "main",
    requests: [{ custom_id: "req-0", body: { input: "hello" } }],
    wait: true,
    pollIntervalMs: 1,
    timeoutMs: 60_000,
    concurrency: 1,
    ...overrides,
  });
}

function streamingResponse(params: { chunkCount: number; chunkSize: number; status?: number }): {
  response: Response;
  getReadCount: () => number;
  wasCanceled: () => boolean;
} {
  let reads = 0;
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(new Uint8Array(params.chunkSize));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, {
      status: params.status ?? 200,
      headers: { "content-type": "application/json" },
    }),
    getReadCount: () => reads,
    wasCanceled: () => canceled,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("voyage batch bounded reads", () => {
  it("preserves configured query parameters on real direct embedding requests", async () => {
    const received: Array<{ url: string; authorization: string | undefined }> = [];
    const server = createServer((request, response) => {
      received.push({ url: request.url ?? "", authorization: request.headers.authorization });
      if (request.url !== "/tenant/v1/embeddings?api-version=2024-10-21&tenant=beta") {
        response.writeHead(404).end("wrong embedding endpoint");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ embedding: [7, 11] }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback TCP address");
    }

    try {
      const { provider } = await createVoyageEmbeddingProvider({
        config: {},
        provider: "voyage",
        model: "voyage-3",
        fallback: "none",
        remote: {
          baseUrl: `http://127.0.0.1:${address.port}/tenant/v1/?api-version=2024-10-21&tenant=beta#local`,
          apiKey: "voyage-loopback-key",
        },
      });

      await expect(provider.embedQuery("hello")).resolves.toEqual([7, 11]);
      expect(received).toEqual([
        {
          url: "/tenant/v1/embeddings?api-version=2024-10-21&tenant=beta",
          authorization: "Bearer voyage-loopback-key",
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("preserves configured query parameters through real batch upload, create, status, and error output", async () => {
    const received: Array<{ url: string; authorization: string | undefined }> = [];
    const server = createServer((request, response) => {
      const url = request.url ?? "";
      received.push({ url, authorization: request.headers.authorization });
      const parsed = new URL(url, "http://localhost");
      if (parsed.search !== "?api-version=2024-10-21&tenant=beta") {
        response.writeHead(404).end("missing embedding tenant query");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (parsed.pathname === "/tenant/v1/files") {
        response.end(JSON.stringify({ id: "input-0" }));
      } else if (parsed.pathname === "/tenant/v1/batches") {
        response.end(JSON.stringify({ id: "batch-0", status: "in_progress" }));
      } else if (parsed.pathname === "/tenant/v1/batches/batch-0") {
        response.end(
          JSON.stringify({
            id: "batch-0",
            status: "completed",
            output_file_id: "output-0",
            error_file_id: "error-0",
          }),
        );
      } else if (parsed.pathname === "/tenant/v1/files/error-0/content") {
        response.end(
          JSON.stringify({
            custom_id: "req-0",
            response: { status_code: 500, message: "provider rejected request" },
            error: null,
          }),
        );
      } else {
        response.end(JSON.stringify({ error: "unexpected embedding path" }));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback TCP address");
    }

    try {
      await expect(
        runBatch({
          client: {
            baseUrl: `http://127.0.0.1:${address.port}/tenant/v1/?api-version=2024-10-21&tenant=beta#local`,
            headers: { Authorization: "Bearer voyage-loopback-key" },
            model: "voyage-3",
            ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
          },
        }),
      ).rejects.toThrow("voyage batch batch-0 completed: provider rejected request");

      expect(received.map(({ url }) => url)).toEqual([
        "/tenant/v1/files?api-version=2024-10-21&tenant=beta",
        "/tenant/v1/batches?api-version=2024-10-21&tenant=beta",
        "/tenant/v1/batches/batch-0?api-version=2024-10-21&tenant=beta",
        "/tenant/v1/files/error-0/content?api-version=2024-10-21&tenant=beta",
      ]);
      expect(
        received.every(({ authorization }) => authorization === "Bearer voyage-loopback-key"),
      ).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("clamps polling to the remaining batch timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    stubBatchFetch();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const nowSpy = vi.spyOn(Date, "now");
    const result = runBatch({
      pollIntervalMs: 2_000,
      timeoutMs: 1_000,
      debug: (message) => {
        if (message === "memory embeddings: voyage batch created") {
          nowSpy.mockReturnValueOnce(0).mockReturnValue(500);
        }
      },
    });
    const rejection = expect(result).rejects.toThrow("voyage batch batch-0 timed out after 1000ms");
    for (
      let attempt = 0;
      attempt < 100 && !timeoutSpy.mock.calls.some(([, ms]) => ms === 500);
      attempt++
    ) {
      await Promise.resolve();
    }
    expect(timeoutSpy.mock.calls.some(([, ms]) => ms === 500)).toBe(true);
    nowSpy.mockReturnValue(1_000);
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
  });

  it("does not poll status after the batch timeout expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchMock = stubBatchFetch();
    const result = runBatch({ pollIntervalMs: 1_000, timeoutMs: 1_000 });
    const rejection = expect(result).rejects.toThrow("voyage batch batch-0 timed out after 1000ms");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(
      fetchMock.mock.calls.some(([url]) => fetchInputUrl(url).endsWith("/batches/batch-0")),
    ).toBe(false);
  });

  it("caps an oversized batch status stream through the public runner", async () => {
    const streamed = streamingResponse({ chunkCount: 20, chunkSize: 1024 * 1024 });
    stubBatchFetch((stage) => (stage === "status" ? streamed.response : undefined));

    await expect(runBatch()).rejects.toThrow(
      /voyage-batch-status: JSON response exceeds \d+ bytes/,
    );
    expect(streamed.getReadCount()).toBeLessThan(20);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("fail-softs an oversized error file through the public runner", async () => {
    const streamed = streamingResponse({ chunkCount: 20, chunkSize: 1024 * 1024 });
    stubBatchFetch((stage) => {
      if (stage === "create") {
        return jsonResponse({
          id: "batch-0",
          status: "completed",
          output_file_id: "output-0",
          error_file_id: "error-0",
        });
      }
      return stage === "error" ? streamed.response : undefined;
    });

    await expect(runBatch()).rejects.toThrow(
      /voyage batch batch-0 completed: error file unavailable: voyage batch error file content exceeds \d+ bytes/,
    );
    expect(streamed.getReadCount()).toBeLessThan(20);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("normalizes and bounds a non-OK status diagnostic through the public runner", async () => {
    const streamed = streamingResponse({ chunkCount: 20, chunkSize: 1024 * 1024, status: 500 });
    stubBatchFetch((stage) => (stage === "status" ? streamed.response : undefined));

    await expect(runBatch()).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 500,
      statusCode: 500,
    });
    expect(streamed.getReadCount()).toBeLessThan(20);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("uses the shared output reader and stops after the expected result", async () => {
    let canceled = false;
    const encoder = new TextEncoder();
    const output = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                custom_id: "req-0",
                response: { status_code: 200, body: { data: [{ embedding: [1, 2] }] } },
              })}\n`,
            ),
          );
        },
        cancel() {
          canceled = true;
        },
      }),
    );
    stubBatchFetch((stage) => (stage === "output" ? output : undefined));

    await expect(runBatch()).resolves.toEqual(new Map([["req-0", [1, 2]]]));
    expect(canceled).toBe(true);
  });

  it("reads a completed error file before downloading successful output", async () => {
    const fetchMock = stubBatchFetch((stage) =>
      stage === "status"
        ? jsonResponse({
            id: "batch-0",
            status: "completed",
            output_file_id: "output-0",
            error_file_id: "error-0",
          })
        : undefined,
    );

    await expect(runBatch()).rejects.toThrow(
      "voyage batch batch-0 completed: provider rejected request",
    );
    expect(
      fetchMock.mock.calls.some(([url]) => fetchInputUrl(url).includes("/files/output-0/")),
    ).toBe(false);
  });

  it("preserves authentication and batch request details on the real fetch boundary", async () => {
    const fetchMock = stubBatchFetch();

    await expect(runBatch()).resolves.toEqual(new Map([["req-0", [1, 2]]]));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-voyage");
    }
    const create = fetchMock.mock.calls.find(([url]) => fetchInputUrl(url).endsWith("/batches"));
    const requestBody = create?.[1]?.body;
    if (typeof requestBody !== "string") {
      throw new Error("missing Voyage batch creation body");
    }
    expect(JSON.parse(requestBody)).toMatchObject({
      endpoint: "/v1/embeddings",
      request_params: { model: "voyage-3", input_type: "document" },
    });
    const status = fetchMock.mock.calls.find(([url]) =>
      fetchInputUrl(url).endsWith("/batches/batch-0"),
    );
    expect(status?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries transient batch creation failures through the shared HTTP policy", async () => {
    let attempts = 0;
    stubBatchFetch((stage) => {
      if (stage !== "create" || ++attempts > 1) {
        return undefined;
      }
      return jsonResponse({ error: { message: "retry this request" } }, 503);
    });

    await expect(runBatch()).resolves.toEqual(new Map([["req-0", [1, 2]]]));
    expect(attempts).toBe(2);
  });

  it("does not poll or download when waiting is disabled", async () => {
    const fetchMock = stubBatchFetch();

    await expect(runBatch({ wait: false })).rejects.toThrow(
      "voyage batch batch-0 submitted; enable remote.batch.wait to await completion",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
