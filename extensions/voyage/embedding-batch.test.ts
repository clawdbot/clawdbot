// Voyage batch tests cover bounded status/error response reads.
import { describe, expect, it } from "vitest";
import { testing } from "./embedding-batch.js";
import type { VoyageEmbeddingClient } from "./embedding-provider.js";

const { fetchVoyageBatchStatus, readVoyageBatchError, VOYAGE_BATCH_RESPONSE_MAX_BYTES } = testing;

function buildClient(): VoyageEmbeddingClient {
  return {
    baseUrl: "https://api.voyageai.test/v1",
    headers: { authorization: "Bearer test" },
    model: "voyage-3",
  };
}

/**
 * Build deps whose withRemoteHttpResponse drives the real onResponse against a
 * caller-provided Response, so the bounded readers run exactly as in production.
 */
function buildDeps(response: Response): Parameters<typeof fetchVoyageBatchStatus>[0]["deps"] {
  return {
    now: () => 0,
    sleep: async () => {},
    postJsonWithRetry: (async () => {
      throw new Error("postJsonWithRetry should not be called in these tests");
    }) as never,
    uploadBatchJsonlFile: (async () => {
      throw new Error("uploadBatchJsonlFile should not be called in these tests");
    }) as never,
    withRemoteHttpResponse: (async (params: { onResponse: (res: Response) => Promise<unknown> }) =>
      await params.onResponse(response)) as never,
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
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(encoder.encode("a".repeat(params.chunkSize)));
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
  it("uses a 16 MiB cap for batch status/error responses", () => {
    expect(VOYAGE_BATCH_RESPONSE_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it("parses a well-formed batch status response under the byte cap", async () => {
    const response = new Response(JSON.stringify({ id: "batch_1", status: "completed" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const status = await fetchVoyageBatchStatus({
      client: buildClient(),
      batchId: "batch_1",
      deps: buildDeps(response),
    });

    expect(status).toEqual({ id: "batch_1", status: "completed" });
  });

  it("caps an oversized batch status stream instead of buffering the whole body", async () => {
    const streamed = streamingResponse({ chunkCount: 64, chunkSize: 1024 });

    await expect(
      fetchVoyageBatchStatus({
        client: buildClient(),
        batchId: "batch_1",
        deps: buildDeps(streamed.response),
        maxResponseBytes: 4096,
      }),
    ).rejects.toThrow(/voyage-batch-status: JSON response exceeds 4096 bytes/);

    // Stream was cancelled mid-flight: fewer chunks read than the full payload.
    expect(streamed.getReadCount()).toBeLessThan(64);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("preserves the full NDJSON parse chain for an under-cap error file", async () => {
    // Multi-line NDJSON with a blank line proves the bounded read does not
    // disturb the original trim/split("\n")/JSON.parse/extractBatchErrorMessage
    // pipeline: the first useful error message is still extracted byte-for-byte
    // identically to the pre-change `await res.text()` path.
    const body = [
      JSON.stringify({ custom_id: "req-0", response: { status_code: 200 } }),
      "",
      JSON.stringify({ custom_id: "req-1", error: { message: "voyage upstream rejected" } }),
      JSON.stringify({ custom_id: "req-2", error: { message: "second error ignored" } }),
      "",
    ].join("\n");
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });

    const message = await readVoyageBatchError({
      client: buildClient(),
      errorFileId: "file_1",
      deps: buildDeps(response),
    });

    // extractBatchErrorMessage returns the first line carrying a message, so the
    // success line is skipped and the second error is not surfaced.
    expect(message).toBe("voyage upstream rejected");
  });

  it("returns undefined for an empty error file via the original empty-body branch", async () => {
    // Whitespace-only body must still hit the `!text.trim()` short-circuit after
    // decoding the bounded buffer, returning undefined exactly as before.
    const response = new Response("   \n", {
      status: 200,
      headers: { "content-type": "application/x-ndjson" },
    });

    const message = await readVoyageBatchError({
      client: buildClient(),
      errorFileId: "file_1",
      deps: buildDeps(response),
    });

    expect(message).toBeUndefined();
  });

  it("fail-softs an oversized error file into formatUnavailableBatchError by design", async () => {
    const streamed = streamingResponse({ chunkCount: 64, chunkSize: 1024 });

    // Intended behavior: an over-cap error file must NOT throw out of
    // readVoyageBatchError. An unbounded error body would otherwise OOM the
    // worker, so the bounded overflow error is caught and degraded into a
    // diagnostic string via formatUnavailableBatchError. We accept the lost
    // detail; the overflow message names the cap so the truncation is visible.
    const readError = async () =>
      await readVoyageBatchError({
        client: buildClient(),
        errorFileId: "file_1",
        deps: buildDeps(streamed.response),
        maxResponseBytes: 4096,
      });

    await expect(readError()).resolves.toMatch(
      /error file unavailable: voyage batch error file content exceeds 4096 bytes/,
    );

    // The bounded reader still cancels the stream mid-flight rather than
    // buffering the whole advertised payload before failing soft.
    expect(streamed.getReadCount()).toBeLessThan(64);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("caps an oversized non-OK (error) diagnostic body instead of buffering it whole", async () => {
    // Regression for the non-OK gap: `assertVoyageResponseOk` previously read the
    // 4xx/5xx diagnostic body with an unbounded `await res.text()`. A hostile
    // endpoint can return a 500 with a never-ending body, so that read must be
    // bounded too. Drive a streaming 500 through the real status path and assert
    // the bounded overflow error fires and the stream is cancelled mid-flight.
    const streamed = streamingResponse({ chunkCount: 64, chunkSize: 1024, status: 500 });

    await expect(
      fetchVoyageBatchStatus({
        client: buildClient(),
        batchId: "batch_1",
        deps: buildDeps(streamed.response),
        maxResponseBytes: 4096,
      }),
    ).rejects.toThrow(/voyage batch status failed: 500 \(error body exceeds 4096 bytes\)/);

    // Stream was cancelled mid-flight rather than draining the whole body.
    expect(streamed.getReadCount()).toBeLessThan(64);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("preserves the diagnostic shape for a small non-OK (error) body", async () => {
    // Under-cap non-OK body must still surface the original
    // `${context}: ${status} ${text}` diagnostic byte-for-byte.
    const response = new Response("voyage upstream is down", {
      status: 503,
      headers: { "content-type": "text/plain" },
    });

    await expect(
      fetchVoyageBatchStatus({
        client: buildClient(),
        batchId: "batch_1",
        deps: buildDeps(response),
      }),
    ).rejects.toThrow(/voyage batch status failed: 503 voyage upstream is down/);
  });
});
