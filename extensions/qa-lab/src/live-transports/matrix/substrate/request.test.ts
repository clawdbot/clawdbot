// Qa Lab Matrix tests cover request behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestMatrixJson, type MatrixQaFetchLike } from "./request.js";

describe("requestMatrixJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps oversized request timeouts before creating the abort signal", async () => {
    const signal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchImpl = vi.fn<MatrixQaFetchLike>(async () => Response.json({ ok: true }));

    await requestMatrixJson({
      baseUrl: "https://matrix.example.test",
      endpoint: "/_matrix/client/v3/account/whoami",
      fetchImpl,
      method: "GET",
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ signal }));
  });

  it("fails closed when the homeserver streams an over-cap response body", async () => {
    // Stream past the 16 MiB cap one chunk at a time so the fixture proves the
    // bound trips on the prefix and cancels the body instead of buffering it
    // all. `cancel()` flipping `canceled` is what real-behavior fail-closed
    // looks like: the stream is torn down, not drained.
    const chunkSize = 1024 * 1024;
    const chunkCount = 32; // 32 MiB total, well past the 16 MiB limit
    let reads = 0;
    let canceled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(encoder.encode("a".repeat(chunkSize)));
        if (reads >= chunkCount) {
          controller.close();
        }
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = vi.fn<MatrixQaFetchLike>(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      requestMatrixJson({
        baseUrl: "https://matrix.example.test",
        endpoint: "/_matrix/client/v3/sync",
        fetchImpl,
        method: "GET",
      }),
    ).rejects.toThrow(/Matrix homeserver response exceeds 16777216 bytes/);

    // Fail-closed proof: the read stopped before draining all 32 chunks and the
    // stream was canceled rather than fully buffered.
    expect(canceled).toBe(true);
    expect(reads).toBeLessThan(chunkCount);
  });

  it("rejects an oversized error-status body instead of buffering it whole", async () => {
    // Even on a non-2xx status the cap must trip first: an attacker controlling
    // the homeserver could otherwise return a 500 with a multi-GiB body knowing
    // the helper only inspects `body.error` after fully reading it.
    const chunkSize = 1024 * 1024;
    const chunkCount = 32;
    let reads = 0;
    let canceled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(encoder.encode("b".repeat(chunkSize)));
        if (reads >= chunkCount) {
          controller.close();
        }
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = vi.fn<MatrixQaFetchLike>(
      async () =>
        new Response(stream, {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      requestMatrixJson({
        baseUrl: "https://matrix.example.test",
        endpoint: "/_matrix/client/v3/sync",
        fetchImpl,
        method: "GET",
      }),
    ).rejects.toThrow(/Matrix homeserver response exceeds 16777216 bytes/);
    expect(canceled).toBe(true);
    expect(reads).toBeLessThan(chunkCount);
  });

  it("still falls back to an empty body for malformed in-bounds JSON", async () => {
    const fetchImpl = vi.fn<MatrixQaFetchLike>(
      async () =>
        new Response("{ not valid json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await requestMatrixJson<{ ok?: boolean }>({
      baseUrl: "https://matrix.example.test",
      endpoint: "/_matrix/client/v3/account/whoami",
      fetchImpl,
      method: "GET",
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({});
  });

  it("treats an empty in-bounds body as an empty object", async () => {
    const fetchImpl = vi.fn<MatrixQaFetchLike>(
      async () =>
        new Response("", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await requestMatrixJson<Record<string, unknown>>({
      baseUrl: "https://matrix.example.test",
      endpoint: "/_matrix/client/v3/account/whoami",
      fetchImpl,
      method: "GET",
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({});
  });

  it("reads a normal in-bounds JSON body unchanged", async () => {
    const fetchImpl = vi.fn<MatrixQaFetchLike>(async () => Response.json({ user_id: "@qa:test" }));

    const result = await requestMatrixJson<{ user_id: string }>({
      baseUrl: "https://matrix.example.test",
      endpoint: "/_matrix/client/v3/account/whoami",
      fetchImpl,
      method: "GET",
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ user_id: "@qa:test" });
  });

  it("reads an in-bounds body just under the cap without tripping the bound", async () => {
    // Boundary guard: a body close to but under 16 MiB must parse normally so
    // the cap does not regress legitimate large-but-valid Matrix responses.
    const filler = "x".repeat(8 * 1024 * 1024); // 8 MiB string, well under cap
    const payload = JSON.stringify({ data: filler });
    const fetchImpl = vi.fn<MatrixQaFetchLike>(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await requestMatrixJson<{ data: string }>({
      baseUrl: "https://matrix.example.test",
      endpoint: "/_matrix/client/v3/sync",
      fetchImpl,
      method: "GET",
    });

    expect(result.status).toBe(200);
    expect(result.body.data).toHaveLength(filler.length);
  });
});
