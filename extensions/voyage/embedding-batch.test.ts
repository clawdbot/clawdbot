// Voyage batch tests cover bounded status/error response reads.
import { describe, expect, it, vi } from "vitest";
import { runVoyageEmbeddingBatches } from "./embedding-batch.js";
import type { VoyageEmbeddingClient } from "./embedding-provider.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function buildClient(): VoyageEmbeddingClient {
  return {
    baseUrl: "https://api.voyageai.test/v1",
    headers: { authorization: "Bearer test" },
    model: "voyage-3",
  };
}

/**
 * A streaming JSON-ish body that proves an oversized response stops being read
 * before the whole advertised payload is buffered into memory. getReadCount
 * reports how many chunks were pulled; cancel() flips wasCanceled.
 */
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

describe("voyage batch bounded reads", () => {
  it("clamps polling to the remaining batch timeout", async () => {
    const sleeps: number[] = [];

    await expect(
      runVoyageEmbeddingBatches({
        client: buildClient(),
        agentId: "main",
        requests: [{ custom_id: "req-0", body: { input: "hello" } }],
        wait: true,
        pollIntervalMs: 2_000,
        timeoutMs: 1_000,
        concurrency: 1,
        deps: {
          now: (() => {
            const times = [0, 500];
            return () => times.shift() ?? 500;
          })(),
          sleep: async (ms) => {
            sleeps.push(ms);
            throw new Error("stop after first wait");
          },
          uploadBatchJsonlFile: async () => "input-0",
          postJsonWithRetry: async () => ({ id: "batch-0", status: "in_progress" }),
        },
      }),
    ).rejects.toThrow("stop after first wait");

    expect(sleeps).toEqual([500]);
  });

  it("does not poll status after the batch timeout expires", async () => {
    let now = 0;
    const statusFetch = vi.fn();

    await expect(
      runVoyageEmbeddingBatches({
        client: buildClient(),
        agentId: "main",
        requests: [{ custom_id: "req-0", body: { input: "hello" } }],
        wait: true,
        pollIntervalMs: 1_000,
        timeoutMs: 1_000,
        concurrency: 1,
        deps: {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
          uploadBatchJsonlFile: async () => "input-0",
          postJsonWithRetry: async () => ({ id: "batch-0", status: "in_progress" }),
          withRemoteHttpResponse: statusFetch as never,
        },
      }),
    ).rejects.toThrow("voyage batch batch-0 timed out after 1000ms");

    expect(statusFetch).not.toHaveBeenCalled();
  });

  it("caps an oversized batch status stream through the public runner", async () => {
    const streamed = streamingResponse({ chunkCount: 20, chunkSize: 1024 * 1024 });

    await expect(
      runVoyageEmbeddingBatches({
        client: buildClient(),
        agentId: "main",
        requests: [{ custom_id: "req-0", body: { input: "hello" } }],
        wait: true,
        pollIntervalMs: 1,
        timeoutMs: 60_000,
        concurrency: 1,
        deps: {
          now: () => 0,
          sleep: async () => {},
          uploadBatchJsonlFile: async () => "input-0",
          postJsonWithRetry: async () => ({ id: "batch-0", status: "in_progress" }),
          withRemoteHttpResponse: (async (params: {
            onResponse: (response: Response) => Promise<unknown>;
          }) => await params.onResponse(streamed.response)) as never,
        },
      }),
    ).rejects.toThrow(/voyage-batch-status: JSON response exceeds \d+ bytes/);

    expect(streamed.getReadCount()).toBeLessThan(20);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("fail-softs an oversized error file through the public runner", async () => {
    const streamed = streamingResponse({ chunkCount: 20, chunkSize: 1024 * 1024 });

    await expect(
      runVoyageEmbeddingBatches({
        client: buildClient(),
        agentId: "main",
        requests: [{ custom_id: "req-0", body: { input: "hello" } }],
        wait: true,
        pollIntervalMs: 1,
        timeoutMs: 60_000,
        concurrency: 1,
        deps: {
          uploadBatchJsonlFile: async () => "input-0",
          postJsonWithRetry: async () => ({
            id: "batch-0",
            status: "completed",
            output_file_id: "output-0",
            error_file_id: "error-0",
          }),
          withRemoteHttpResponse: (async (params: {
            url: string;
            onResponse: (response: Response) => Promise<unknown>;
          }) => {
            expect(params.url).toContain("/files/error-0/content");
            return await params.onResponse(streamed.response);
          }) as never,
        },
      }),
    ).rejects.toThrow(
      /voyage batch batch-0 completed: error file unavailable: voyage batch error file content exceeds \d+ bytes/,
    );

    expect(streamed.getReadCount()).toBeLessThan(20);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("normalizes and bounds a non-OK status diagnostic through the public runner", async () => {
    const streamed = streamingResponse({
      chunkCount: 20,
      chunkSize: 1024 * 1024,
      status: 500,
    });

    await expect(
      runVoyageEmbeddingBatches({
        client: buildClient(),
        agentId: "main",
        requests: [{ custom_id: "req-0", body: { input: "hello" } }],
        wait: true,
        pollIntervalMs: 1,
        timeoutMs: 60_000,
        concurrency: 1,
        deps: {
          now: () => 0,
          sleep: async () => {},
          uploadBatchJsonlFile: async () => "input-0",
          postJsonWithRetry: async () => ({ id: "batch-0", status: "in_progress" }),
          withRemoteHttpResponse: (async (params: {
            onResponse: (response: Response) => Promise<unknown>;
          }) => await params.onResponse(streamed.response)) as never,
        },
      }),
    ).rejects.toMatchObject({ name: "ProviderHttpError", status: 500, statusCode: 500 });

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

    const result = await runVoyageEmbeddingBatches({
      client: buildClient(),
      agentId: "main",
      requests: [{ custom_id: "req-0", body: { input: "hello" } }],
      wait: true,
      pollIntervalMs: 1,
      timeoutMs: 1_000,
      concurrency: 1,
      deps: {
        uploadBatchJsonlFile: async () => "input-0",
        postJsonWithRetry: async () => ({
          id: "batch-0",
          status: "completed",
          output_file_id: "output-0",
        }),
        withRemoteHttpResponse: (async (params: {
          onResponse: (response: Response) => Promise<unknown>;
        }) => await params.onResponse(output)) as never,
      },
    });

    expect(result).toEqual(new Map([["req-0", [1, 2]]]));
    expect(canceled).toBe(true);
  });

  it("reads a completed error file before downloading successful output", async () => {
    let outputFetched = false;

    await expect(
      runVoyageEmbeddingBatches({
        client: buildClient(),
        agentId: "main",
        requests: [{ custom_id: "req-0", body: { input: "hello" } }],
        wait: true,
        pollIntervalMs: 1,
        timeoutMs: 1_000,
        concurrency: 1,
        deps: {
          uploadBatchJsonlFile: async () => "input-0",
          postJsonWithRetry: async () => ({
            id: "batch-0",
            status: "in_progress",
          }),
          withRemoteHttpResponse: (async (params: {
            url: string;
            onResponse: (response: Response) => Promise<unknown>;
          }) => {
            if (params.url.endsWith("/batches/batch-0")) {
              return await params.onResponse(
                jsonResponse({
                  id: "batch-0",
                  status: "completed",
                  output_file_id: "output-0",
                  error_file_id: "error-0",
                }),
              );
            }
            if (params.url.endsWith("/files/output-0/content")) {
              outputFetched = true;
            }
            return await params.onResponse(
              new Response(
                JSON.stringify({
                  custom_id: "req-0",
                  response: { status_code: 500, message: "provider rejected request" },
                  error: null,
                }),
              ),
            );
          }) as never,
        },
      }),
    ).rejects.toThrow("voyage batch batch-0 completed: provider rejected request");
    expect(outputFetched).toBe(false);
  });
});
