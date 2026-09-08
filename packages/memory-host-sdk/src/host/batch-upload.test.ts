// Memory Host SDK tests cover batch upload behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../../test/helpers/promise.js";
import { uploadBatchJsonlFile } from "./batch-upload.js";
import { withRemoteHttpResponse } from "./remote-http.js";
import { createPendingResponse } from "./response-snippet.test-harness.js";

vi.mock("./remote-http.js", () => ({
  withRemoteHttpResponse: vi.fn(),
}));

const remoteHttpMock = vi.mocked(withRemoteHttpResponse);

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

function streamingTextResponse(params: {
  body: string;
  status: number;
  headers?: HeadersInit;
  onCancel: () => void;
}): Response {
  const encoded = new TextEncoder().encode(params.body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
    },
    cancel() {
      params.onCancel();
    },
  });
  return new Response(stream, { status: params.status, headers: params.headers });
}

describe("uploadBatchJsonlFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps malformed file-upload JSON with the request error prefix", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(textResponse("{ nope", 200));
    });

    await expect(
      uploadBatchJsonlFile({
        client: {
          baseUrl: "https://memory.example/v1",
          headers: { Authorization: "Bearer test" },
        },
        requests: [{ input: "one" }],
        errorPrefix: "file upload failed",
      }),
    ).rejects.toThrow("file upload failed: malformed JSON response");
  });

  it("bounds non-ok file-upload response bodies before formatting the error", async () => {
    let canceled = false;
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        streamingTextResponse({
          body: "x".repeat(12_000),
          status: 413,
          onCancel: () => {
            canceled = true;
          },
        }),
      );
    });

    await expect(
      uploadBatchJsonlFile({
        client: {
          baseUrl: "https://memory.example/v1",
          headers: { Authorization: "Bearer test" },
        },
        requests: [{ input: "one" }],
        errorPrefix: "file upload failed",
      }),
    ).rejects.toThrow(`file upload failed: 413 ${"x".repeat(1_000)}... [truncated]`);
    expect(canceled).toBe(true);
  });

  it("rejects oversized successful file-upload JSON before parsing", async () => {
    let canceled = false;
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        streamingTextResponse({
          body: '{"id":"file_123"}',
          status: 200,
          headers: { "content-length": "00064" },
          onCancel: () => {
            canceled = true;
          },
        }),
      );
    });

    await expect(
      uploadBatchJsonlFile({
        client: {
          baseUrl: "https://memory.example/v1",
          headers: { Authorization: "Bearer test" },
        },
        requests: [{ input: "one" }],
        errorPrefix: "file upload failed",
        maxResponseBytes: 8,
      }),
    ).rejects.toThrow("file upload failed: response body too large: 64 bytes (limit: 8 bytes)");
    expect(canceled).toBe(true);
  });

  it("accepts leading-zero content-length values on successful file-upload JSON", async () => {
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(
        new Response('{"id":"file_123"}', {
          status: 200,
          headers: { "content-length": "00017" },
        }),
      );
    });

    await expect(
      uploadBatchJsonlFile({
        client: {
          baseUrl: "https://memory.example/v1",
          headers: { Authorization: "Bearer test" },
        },
        requests: [{ input: "one" }],
        errorPrefix: "file upload failed",
        maxResponseBytes: 32,
      }),
    ).resolves.toBe("file_123");
  });

  it("passes caller abort signals through non-ok file-upload response snippets", async () => {
    const fixture = createPendingResponse({ status: 500 });
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(fixture.response);
    });
    const controller = new AbortController();
    const expected = new Error("upload aborted");
    const upload = uploadBatchJsonlFile({
      client: {
        baseUrl: "https://memory.example/v1",
        headers: { Authorization: "Bearer test" },
      },
      requests: [{ input: "one" }],
      errorPrefix: "file upload failed",
      signal: controller.signal,
    });
    const settled = upload.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await withTestTimeout(fixture.readStarted, 1_000, "upload snippet read did not start");
      expect(fixture.response.body?.locked).toBe(true);
      controller.abort(expected);

      await expect(
        withTestTimeout(settled, 1_000, "upload snippet abort did not settle"),
      ).resolves.toBe(expected);
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(fixture.response.body?.locked).toBe(false);
      expect(remoteHttpMock.mock.calls[0]?.[0].signal).toBe(controller.signal);
    } finally {
      controller.abort(expected);
      fixture.dispose();
      await withTestTimeout(settled, 1_000, "upload snippet cleanup did not settle");
    }
  });

  it("passes caller abort signals through successful file-upload JSON reads", async () => {
    const fixture = createPendingResponse({ status: 200 });
    remoteHttpMock.mockImplementationOnce(async (params) => {
      return await params.onResponse(fixture.response);
    });
    const controller = new AbortController();
    const expected = new Error("upload json aborted");
    const upload = uploadBatchJsonlFile({
      client: {
        baseUrl: "https://memory.example/v1",
        headers: { Authorization: "Bearer test" },
      },
      requests: [{ input: "one" }],
      errorPrefix: "file upload failed",
      signal: controller.signal,
    });
    const settled = upload.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await withTestTimeout(fixture.readStarted, 1_000, "upload JSON read did not start");
      expect(fixture.response.body?.locked).toBe(true);
      controller.abort(expected);

      await expect(
        withTestTimeout(settled, 1_000, "upload JSON abort did not settle"),
      ).resolves.toBe(expected);
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(fixture.response.body?.locked).toBe(false);
      expect(remoteHttpMock.mock.calls[0]?.[0].signal).toBe(controller.signal);
    } finally {
      controller.abort(expected);
      fixture.dispose();
      await withTestTimeout(settled, 1_000, "upload JSON cleanup did not settle");
    }
  });
});
