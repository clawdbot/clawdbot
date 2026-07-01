// Openai tests cover embedding batch plugin behavior.
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { parseOpenAiBatchOutput, runOpenAiEmbeddingBatches } from "./embedding-batch.js";

const jsonlEncoder = new TextEncoder();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonlBytes(value: string): number {
  return jsonlEncoder.encode(value).byteLength;
}

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function parseStringBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new Error("missing JSON request body");
  }
  return JSON.parse(init.body) as unknown;
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
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

describe("OpenAI embedding batch output", () => {
  it("wraps malformed JSONL output", () => {
    expect(() => parseOpenAiBatchOutput('{"custom_id":"ok"}\n{not json')).toThrow(
      "OpenAI embedding batch output contained malformed JSONL",
    );
  });

  it("splits provider uploads by serialized JSONL byte cap", async () => {
    const requests: Parameters<typeof runOpenAiEmbeddingBatches>[0]["requests"] = Array.from(
      { length: 3 },
      (_, index) => ({
        custom_id: String(index),
        method: "POST" as const,
        url: "/v1/embeddings",
        body: {
          model: "text-embedding-3-small",
          input: `payload-${index}-${"β".repeat(8)}`,
        },
      }),
    );
    const uploadedJsonl: string[] = [];
    const requestsByFileId = new Map<string, Array<{ custom_id?: string }>>();
    const outputByFileId = new Map<string, string>();
    let fileIndex = 0;
    let batchIndex = 0;
    const maxJsonlBytes = jsonlBytes(JSON.stringify(requests[0]));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      if (url.endsWith("/files") && init?.method === "POST") {
        const form = init.body as FormData;
        const file = form.get("file");
        if (!(file instanceof Blob)) {
          throw new Error("missing batch upload file");
        }
        const jsonl = await file.text();
        const fileId = `file-${fileIndex}`;
        fileIndex += 1;
        uploadedJsonl.push(jsonl);
        requestsByFileId.set(
          fileId,
          jsonl.split("\n").map((line) => JSON.parse(line) as { custom_id?: string }),
        );
        return jsonResponse({ id: fileId });
      }
      if (url.endsWith("/batches") && init?.method === "POST") {
        const body = parseStringBody(init) as { input_file_id?: string };
        const batchId = `batch-${batchIndex}`;
        const outputFileId = `output-${batchIndex}`;
        batchIndex += 1;
        const uploadedRequests = requestsByFileId.get(body.input_file_id ?? "") ?? [];
        outputByFileId.set(
          outputFileId,
          uploadedRequests
            .map((request) =>
              JSON.stringify({
                custom_id: request.custom_id,
                response: {
                  status_code: 200,
                  body: { data: [{ embedding: [Number(request.custom_id) + 1] }] },
                },
              }),
            )
            .join("\n"),
        );
        return jsonResponse({ id: batchId, status: "completed", output_file_id: outputFileId });
      }
      const contentMatch = url.match(/\/files\/([^/]+)\/content$/);
      if (contentMatch) {
        return new Response(outputByFileId.get(contentMatch[1] ?? "") ?? "", { status: 200 });
      }
      return new Response("unexpected request", { status: 500 });
    });

    const byCustomId = await runOpenAiEmbeddingBatches({
      openAi: {
        baseUrl: "https://openai-compatible.example/v1",
        headers: { Authorization: "Bearer test" },
        model: "text-embedding-3-small",
        fetchImpl,
      },
      agentId: "main",
      requests,
      maxJsonlBytes,
      wait: true,
      concurrency: 1,
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
    });

    expect(uploadedJsonl).toHaveLength(3);
    expect(uploadedJsonl.every((jsonl) => jsonlBytes(jsonl) <= maxJsonlBytes)).toBe(true);
    expect([...byCustomId.entries()]).toEqual([
      ["0", [1]],
      ["1", [2]],
      ["2", [3]],
    ]);
  });

  it("adapts OpenAI-compatible upload groups after payload-size rejection", async () => {
    const requests: Parameters<typeof runOpenAiEmbeddingBatches>[0]["requests"] = Array.from(
      { length: 4 },
      (_, index) => ({
        custom_id: String(index),
        method: "POST" as const,
        url: "/v1/embeddings",
        body: {
          model: "text-embedding-3-small",
          input: `payload-${index}`,
        },
      }),
    );
    const uploadedGroups: string[][] = [];
    const requestsByFileId = new Map<string, Array<{ custom_id?: string }>>();
    const outputByFileId = new Map<string, string>();
    const debug = vi.fn();
    let fileIndex = 0;
    let batchIndex = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      if (url.endsWith("/files") && init?.method === "POST") {
        const form = init.body as FormData;
        const file = form.get("file");
        if (!(file instanceof Blob)) {
          throw new Error("missing batch upload file");
        }
        const uploadedRequests = (await file.text())
          .split("\n")
          .map((line) => JSON.parse(line) as { custom_id?: string });
        const customIds = uploadedRequests.map((request) => request.custom_id ?? "");
        uploadedGroups.push(customIds);
        if (uploadedRequests.length > 2) {
          return jsonResponse(
            {
              error: {
                message: "Request body too large. Maximum allowed: 10 MB",
                type: "payload_too_large",
                code: "PAYLOAD_TOO_LARGE",
              },
            },
            413,
          );
        }
        const fileId = `file-${fileIndex}`;
        fileIndex += 1;
        requestsByFileId.set(fileId, uploadedRequests);
        return jsonResponse({ id: fileId });
      }
      if (url.endsWith("/batches") && init?.method === "POST") {
        const body = parseStringBody(init) as { input_file_id?: string };
        const batchId = `batch-${batchIndex}`;
        const outputFileId = `output-${batchIndex}`;
        batchIndex += 1;
        const uploadedRequests = requestsByFileId.get(body.input_file_id ?? "") ?? [];
        outputByFileId.set(
          outputFileId,
          uploadedRequests
            .map((request) =>
              JSON.stringify({
                custom_id: request.custom_id,
                response: {
                  status_code: 200,
                  body: { data: [{ embedding: [Number(request.custom_id) + 1] }] },
                },
              }),
            )
            .join("\n"),
        );
        return jsonResponse({ id: batchId, status: "completed", output_file_id: outputFileId });
      }
      const contentMatch = url.match(/\/files\/([^/]+)\/content$/);
      if (contentMatch) {
        return new Response(outputByFileId.get(contentMatch[1] ?? "") ?? "", { status: 200 });
      }
      return new Response("unexpected request", { status: 500 });
    });

    const byCustomId = await runOpenAiEmbeddingBatches({
      openAi: {
        baseUrl: "https://openai-compatible.example/v1",
        headers: { Authorization: "Bearer test" },
        model: "text-embedding-3-small",
        fetchImpl,
      },
      agentId: "main",
      requests,
      wait: true,
      concurrency: 1,
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
      debug,
    });

    expect(uploadedGroups).toEqual([
      ["0", "1", "2", "3"],
      ["0", "1"],
      ["2", "3"],
    ]);
    expect(debug).toHaveBeenCalledWith(
      "memory embeddings: openai batch upload too large; splitting group",
      expect.objectContaining({
        requests: 4,
        parts: [2, 2],
      }),
    );
    expect([...byCustomId.entries()]).toEqual([
      ["0", [1]],
      ["1", [2]],
      ["2", [3]],
      ["3", [4]],
    ]);
  });

  it("bounds batch status success body via readProviderJsonResponse", async () => {
    const chunkSize = 1024 * 1024;
    const chunkCount = 20; // 20 MiB, well over 16 MiB cap
    let readCount = 0;
    let canceled = false;
    const oversizedStatus = new Response(
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
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    let batchStatusCalled = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      if (url.endsWith("/files") && init?.method === "POST") {
        return jsonResponse({ id: "file-0" });
      }
      if (url.endsWith("/batches") && init?.method === "POST") {
        return jsonResponse({ id: "batch-0", status: "in_progress" });
      }
      if (url.endsWith("/batches/batch-0") && !batchStatusCalled) {
        batchStatusCalled = true;
        return oversizedStatus;
      }
      return new Response("unexpected request", { status: 500 });
    });

    await expect(
      runOpenAiEmbeddingBatches({
        openAi: {
          baseUrl: "https://openai-compatible.example/v1",
          headers: { Authorization: "Bearer test" },
          model: "text-embedding-3-small",
          fetchImpl,
        },
        agentId: "main",
        requests: [
          {
            custom_id: "0",
            method: "POST",
            url: "/v1/embeddings",
            body: { model: "text-embedding-3-small", input: "payload" },
          },
        ],
        wait: true,
        concurrency: 1,
        pollIntervalMs: 1000,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/openai\.batch-status/);
    expect(canceled).toBe(true);
    expect(readCount).toBeLessThan(chunkCount);
  });

  it("streams valid batch output files larger than the provider text cap", async () => {
    const outputLineCount = 18;
    const padding = "x".repeat(1024 * 1024);
    const requests: Parameters<typeof runOpenAiEmbeddingBatches>[0]["requests"] = Array.from(
      { length: outputLineCount },
      (_, index) => ({
        custom_id: String(index),
        method: "POST" as const,
        url: "/v1/embeddings",
        body: { model: "text-embedding-3-small", input: `payload-${index}` },
      }),
    );
    let outputLinesSent = 0;
    const outputResponse = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (outputLinesSent >= outputLineCount) {
            controller.close();
            return;
          }
          const customId = String(outputLinesSent);
          controller.enqueue(
            jsonlEncoder.encode(
              `${JSON.stringify({
                custom_id: customId,
                response: {
                  status_code: 200,
                  body: { data: [{ embedding: [outputLinesSent + 1] }] },
                },
                padding,
              })}\n`,
            ),
          );
          outputLinesSent += 1;
        },
      }),
      { status: 200, headers: { "Content-Type": "application/jsonl" } },
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      if (url.endsWith("/files") && init?.method === "POST") {
        return jsonResponse({ id: "file-0" });
      }
      if (url.endsWith("/batches") && init?.method === "POST") {
        return jsonResponse({ id: "batch-0", status: "completed", output_file_id: "output-0" });
      }
      if (url.endsWith("/files/output-0/content")) {
        return outputResponse;
      }
      return new Response("unexpected request", { status: 500 });
    });

    const byCustomId = await runOpenAiEmbeddingBatches({
      openAi: {
        baseUrl: "https://openai-compatible.example/v1",
        headers: { Authorization: "Bearer test" },
        model: "text-embedding-3-small",
        fetchImpl,
      },
      agentId: "main",
      requests,
      wait: true,
      concurrency: 1,
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
    });

    expect(outputLinesSent).toBe(outputLineCount);
    expect([...byCustomId.entries()]).toEqual(
      requests.map((request, index) => [request.custom_id, [index + 1]]),
    );
  });

  it("stops reading batch output after all requested custom IDs are accounted for", async () => {
    const outputLineCount = 1024;
    let outputLinesSent = 0;
    let canceled = false;
    const outputResponse = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (outputLinesSent >= outputLineCount) {
            controller.close();
            return;
          }
          const line =
            outputLinesSent === 0
              ? {
                  custom_id: "0",
                  response: {
                    status_code: 200,
                    body: { data: [{ embedding: [1] }] },
                  },
                }
              : {
                  custom_id: `extra-${outputLinesSent}`,
                  response: {
                    status_code: 200,
                    body: { data: [{ embedding: [outputLinesSent] }] },
                  },
                };
          controller.enqueue(jsonlEncoder.encode(`${JSON.stringify(line)}\n`));
          outputLinesSent += 1;
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200, headers: { "Content-Type": "application/jsonl" } },
    );
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      if (url.endsWith("/files") && init?.method === "POST") {
        return jsonResponse({ id: "file-0" });
      }
      if (url.endsWith("/batches") && init?.method === "POST") {
        return jsonResponse({ id: "batch-0", status: "completed", output_file_id: "output-0" });
      }
      if (url.endsWith("/files/output-0/content")) {
        return outputResponse;
      }
      return new Response("unexpected request", { status: 500 });
    });

    const byCustomId = await runOpenAiEmbeddingBatches({
      openAi: {
        baseUrl: "https://openai-compatible.example/v1",
        headers: { Authorization: "Bearer test" },
        model: "text-embedding-3-small",
        fetchImpl,
      },
      agentId: "main",
      requests: [
        {
          custom_id: "0",
          method: "POST",
          url: "/v1/embeddings",
          body: { model: "text-embedding-3-small", input: "payload" },
        },
      ],
      wait: true,
      concurrency: 1,
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
    });

    expect([...byCustomId.entries()]).toEqual([["0", [1]]]);
    expect(canceled).toBe(true);
    expect(outputLinesSent).toBeLessThan(outputLineCount);
  });

  it("bounds batch output file content without buffering the whole response", async () => {
    const outputChunkCount = 1024;
    let outputChunksSent = 0;
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      if (url === "/v1/files") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "file-0" }));
        return;
      }
      if (url === "/v1/batches") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "batch-0", status: "completed", output_file_id: "output-0" }));
        return;
      }
      if (url === "/v1/files/output-0/content") {
        res.writeHead(200, { "Content-Type": "application/jsonl" });
        const chunkSize = 1024 * 1024;
        const writeNext = () => {
          if (outputChunksSent >= outputChunkCount) {
            res.end();
            return;
          }
          outputChunksSent += 1;
          if (res.write(Buffer.alloc(chunkSize))) {
            setImmediate(writeNext);
          } else {
            res.once("drain", writeNext);
          }
        };
        writeNext();
        return;
      }
      res.writeHead(500);
      res.end("unexpected request");
    });

    const port = await listenLoopbackServer(server);
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const originalUrl = new URL(fetchInputUrl(input));
      const loopbackUrl = new URL(
        `${originalUrl.pathname}${originalUrl.search}`,
        `http://127.0.0.1:${port}`,
      );
      return await realFetch(loopbackUrl, init);
    });

    try {
      await expect(
        runOpenAiEmbeddingBatches({
          openAi: {
            baseUrl: "https://openai-compatible.example/v1",
            headers: { Authorization: "Bearer test" },
            model: "text-embedding-3-small",
            fetchImpl,
          },
          agentId: "main",
          requests: [
            {
              custom_id: "0",
              method: "POST",
              url: "/v1/embeddings",
              body: { model: "text-embedding-3-small", input: "payload" },
            },
          ],
          wait: true,
          concurrency: 1,
          pollIntervalMs: 1000,
          timeoutMs: 60_000,
        }),
      ).rejects.toThrow(/openai\.batch-file-content/);
    } finally {
      await closeServer(server);
    }
    expect(outputChunksSent).toBeLessThan(outputChunkCount);
  });

  it("bounds batch resource error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"batch status unavailable ".repeat(1024)}tail`, {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    let batchStatusReturned = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchInputUrl(input);
      if (url.endsWith("/files") && init?.method === "POST") {
        return jsonResponse({ id: "file-0" });
      }
      if (url.endsWith("/batches") && init?.method === "POST") {
        return jsonResponse({ id: "batch-0", status: "in_progress" });
      }
      if (url.endsWith("/batches/batch-0") && !batchStatusReturned) {
        batchStatusReturned = true;
        return tracked.response;
      }
      return new Response("unexpected request", { status: 500 });
    });

    await expect(
      runOpenAiEmbeddingBatches({
        openAi: {
          baseUrl: "https://openai-compatible.example/v1",
          headers: { Authorization: "Bearer test" },
          model: "text-embedding-3-small",
          fetchImpl,
        },
        agentId: "main",
        requests: [
          {
            custom_id: "0",
            method: "POST",
            url: "/v1/embeddings",
            body: {
              model: "text-embedding-3-small",
              input: "payload",
            },
          },
        ],
        wait: true,
        concurrency: 1,
        pollIntervalMs: 1000,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/openai batch status failed: 400 batch status unavailable/);
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });
});
