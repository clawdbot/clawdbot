import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadableStream } from "node:stream/web";
import type { VoyageBatchOutputLine, VoyageBatchRequest } from "./batch-voyage.js";
import type { VoyageEmbeddingClient } from "./embeddings-voyage.js";

// Mock internal.js if needed, but runWithConcurrency is simple enough to keep real.
// We DO need to mock retryAsync to avoid actual delays/retries logic complicating tests
vi.mock("../infra/retry.js", () => ({
  retryAsync: async <T>(fn: () => Promise<T>) => fn(),
}));

describe("runVoyageEmbeddingBatches", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  const mockClient: VoyageEmbeddingClient = {
    baseUrl: "https://api.voyageai.com/v1",
    headers: { Authorization: "Bearer test-key" },
    model: "voyage-4-large",
  };

  const mockRequests: VoyageBatchRequest[] = [
    { custom_id: "req-1", body: { input: "text1" } },
    { custom_id: "req-2", body: { input: "text2" } },
  ];

  it("successfully submits batch, waits, and streams results", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Sequence of fetch calls:
    // 1. Upload file
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "file-123" }),
    });

    // 2. Create batch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "batch-abc", status: "pending" }),
    });

    // 3. Poll status (pending) - Optional depending on wait loop, let's say it finishes immediately for this test
    // Actually the code does: initial check (if completed) -> wait loop.
    // If create returns "pending", it enters waitForVoyageBatch.
    // waitForVoyageBatch fetches status.

    // 3. Poll status (completed)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "batch-abc",
        status: "completed",
        output_file_id: "file-out-999",
      }),
    });

    // 4. Download content (Streaming)
    const outputLines: VoyageBatchOutputLine[] = [
      {
        custom_id: "req-1",
        response: { status_code: 200, body: { data: [{ embedding: [0.1, 0.1] }] } },
      },
      {
        custom_id: "req-2",
        response: { status_code: 200, body: { data: [{ embedding: [0.2, 0.2] }] } },
      },
    ];

    // Create a stream that emits the NDJSON lines
    const stream = new ReadableStream({
      start(controller) {
        const text = outputLines.map((l) => JSON.stringify(l)).join("\n");
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: stream,
    });

    const { runVoyageEmbeddingBatches } = await import("./batch-voyage.js");

    const results = await runVoyageEmbeddingBatches({
      client: mockClient,
      agentId: "agent-1",
      requests: mockRequests,
      wait: true,
      pollIntervalMs: 1, // fast poll
      timeoutMs: 1000,
      concurrency: 1,
    });

    expect(results.size).toBe(2);
    expect(results.get("req-1")).toEqual([0.1, 0.1]);
    expect(results.get("req-2")).toEqual([0.2, 0.2]);

    // Verify calls
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Verify File Upload
    expect(fetchMock.mock.calls[0][0]).toContain("/files");
    const uploadBody = fetchMock.mock.calls[0][1].body as FormData;
    expect(uploadBody).toBeInstanceOf(FormData);
    expect(uploadBody.get("purpose")).toBe("batch");

    // Verify Batch Create
    expect(fetchMock.mock.calls[1][0]).toContain("/batches");
    const createBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(createBody.input_file_id).toBe("file-123");
    expect(createBody.completion_window).toBe("12h");

    // Verify Content Fetch
    expect(fetchMock.mock.calls[3][0]).toContain("/files/file-out-999/content");
  });

  it("handles empty lines and stream chunks correctly", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // 1. Upload
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ id: "f1" }) });
    // 2. Create (completed immediately)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "b1", status: "completed", output_file_id: "out1" }),
    });
    // 3. Download Content (Streaming with chunks and newlines)
    const stream = new ReadableStream({
      start(controller) {
        const line1 = JSON.stringify({
          custom_id: "req-1",
          response: { body: { data: [{ embedding: [1] }] } },
        });
        const line2 = JSON.stringify({
          custom_id: "req-2",
          response: { body: { data: [{ embedding: [2] }] } },
        });

        // Split across chunks
        controller.enqueue(new TextEncoder().encode(line1 + "\n"));
        controller.enqueue(new TextEncoder().encode("\n")); // empty line
        controller.enqueue(new TextEncoder().encode(line2)); // no newline at EOF
        controller.close();
      },
    });

    fetchMock.mockResolvedValueOnce({ ok: true, body: stream });

    const { runVoyageEmbeddingBatches } = await import("./batch-voyage.js");

    const results = await runVoyageEmbeddingBatches({
      client: mockClient,
      agentId: "a1",
      requests: mockRequests,
      wait: true,
      pollIntervalMs: 1,
      timeoutMs: 1000,
      concurrency: 1,
    });

    expect(results.get("req-1")).toEqual([1]);
    expect(results.get("req-2")).toEqual([2]);
  });
});
