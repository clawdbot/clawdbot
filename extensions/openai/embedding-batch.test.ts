// Openai tests cover embedding batch plugin behavior.
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
