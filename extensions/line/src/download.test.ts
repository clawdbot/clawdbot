// Line tests cover download plugin behavior.
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
const delayMock = vi.hoisted(() => vi.fn());
const saveMediaStreamMock = vi.hoisted(() => vi.fn());

vi.mock("node:timers/promises", () => ({
  setTimeout: delayMock,
}));

function responseWithChunks(status: number, parts: Buffer[]): Response {
  return new Response(Buffer.concat(parts), { status });
}

function cancellableResponse(
  status: number,
  parts: Buffer[] = [],
): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
    },
    cancel,
  });
  return { response: new Response(body, { status }), cancel };
}

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => {
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => logger,
    };
    return logger;
  },
  logVerbose: () => {},
}));

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaStream: saveMediaStreamMock,
}));

let downloadLineMedia: typeof import("./download.js").downloadLineMedia;
let isRetryableLineInboundMediaError: typeof import("./download.js").isRetryableLineInboundMediaError;

function saveMediaStreamCall(): unknown[] {
  const call = saveMediaStreamMock.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected saveMediaStream call");
  }
  return call;
}

function detectMockContentType(buffer: Buffer, contentType?: string): string | undefined {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    return buffer.toString("ascii", 8, 12) === "M4A " ? "audio/x-m4a" : "video/mp4";
  }
  return contentType;
}

function expectMediaFetchError(err: unknown): MediaFetchError {
  expect(err).toBeInstanceOf(MediaFetchError);
  if (!(err instanceof MediaFetchError)) {
    throw new Error("expected a MediaFetchError");
  }
  return err;
}

describe("downloadLineMedia", () => {
  beforeAll(async () => {
    ({ downloadLineMedia, isRetryableLineInboundMediaError } = await import("./download.js"));
  });

  afterAll(() => {
    vi.doUnmock("node:timers/promises");
    vi.doUnmock("openclaw/plugin-sdk/runtime-env");
    vi.doUnmock("openclaw/plugin-sdk/media-store");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    delayMock.mockReset().mockResolvedValue(undefined);
    saveMediaStreamMock.mockReset();
    saveMediaStreamMock.mockImplementation(
      async (stream: AsyncIterable<Buffer>, contentType?: string, subdir?: string) => {
        const chunksLocal: Buffer[] = [];
        for await (const chunk of stream) {
          chunksLocal.push(Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunksLocal);
        return {
          path: `/home/user/.openclaw/media/${subdir ?? "unknown"}/saved-media`,
          contentType: detectMockContentType(buffer, contentType),
          size: buffer.length,
        };
      },
    );
  });

  it("persists inbound media with the shared media store", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [jpeg]));

    const result = await downloadLineMedia("mid-jpeg", "token");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api-data.line.me/v2/bot/message/mid-jpeg/content",
      expect.objectContaining({
        headers: { Authorization: "Bearer token" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(saveMediaStreamMock).toHaveBeenCalledTimes(1);
    const call = saveMediaStreamCall();
    expect(call[1]).toBeUndefined();
    expect(call[2]).toBe("inbound");
    expect(call[3]).toBe(10 * 1024 * 1024);
    expect(result).toEqual({
      path: "/home/user/.openclaw/media/inbound/saved-media",
      contentType: "image/jpeg",
      size: jpeg.length,
    });
  });

  it("does not pass the external messageId as a media filename", async () => {
    const messageId = "a/../../../../etc/passwd";
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [jpeg]));

    const result = await downloadLineMedia(messageId, "token");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api-data.line.me/v2/bot/message/a%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd/content",
    );
    expect(result.size).toBe(jpeg.length);
    expect(result.contentType).toBe("image/jpeg");
    for (const arg of saveMediaStreamCall()) {
      if (typeof arg === "string") {
        expect(arg).not.toContain(messageId);
      }
    }
  });

  it("cancels content when the media store rejects it", async () => {
    const content = cancellableResponse(200, [Buffer.from("oversized")]);
    fetchMock.mockResolvedValueOnce(content.response);
    saveMediaStreamMock.mockImplementationOnce(async (stream: AsyncIterable<Buffer>) => {
      for await (const chunk of stream) {
        expect(chunk).toEqual(Buffer.from("oversized"));
        throw new Error("Media exceeds 0MB limit");
      }
      throw new Error("Expected media content");
    });

    await expect(downloadLineMedia("mid", "token", 7)).rejects.toThrow(/Media exceeds/i);
    expect(saveMediaStreamMock).toHaveBeenCalledTimes(1);
    expect(content.cancel).toHaveBeenCalledTimes(1);
  });

  it("uses media store content type for M4A media", async () => {
    const m4aHeader = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
    ]);
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [m4aHeader]));

    const result = await downloadLineMedia("mid-audio", "token");

    expect(result.contentType).toBe("audio/x-m4a");
    expect(saveMediaStreamCall()[2]).toBe("inbound");
  });

  it("passes original filenames to the media store for extension fallback", async () => {
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [Buffer.from("unknown-audio-bytes")]));

    await downloadLineMedia("mid-file-audio", "token", 10 * 1024 * 1024, {
      originalFilename: "voice-note.m4a",
    });

    const call = saveMediaStreamCall();
    expect(call[3]).toBe(10 * 1024 * 1024);
    expect(call[4]).toBe("voice-note.m4a");
  });

  it("uses media store content type for MP4 video", async () => {
    const mp4 = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [mp4]));

    const result = await downloadLineMedia("mid-mp4", "token");

    expect(result.contentType).toBe("video/mp4");
  });

  it("passes the LINE response content type to the media store", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.from("plain attachment"), {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    const result = await downloadLineMedia("mid-text", "token");

    expect(saveMediaStreamCall()[1]).toBe("text/plain");
    expect(result.contentType).toBe("text/plain");
  });

  it("retries 202 responses and cancels every discarded body", async () => {
    const m4aHeader = Buffer.from([
      0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
    ]);
    const first = cancellableResponse(202);
    const second = cancellableResponse(202);
    fetchMock
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(second.response)
      .mockResolvedValueOnce(responseWithChunks(200, [m4aHeader]));

    const result = await downloadLineMedia("mid-preparing", "token");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(delayMock).toHaveBeenNthCalledWith(1, 500, undefined, {
      signal: expect.any(AbortSignal),
    });
    expect(delayMock).toHaveBeenNthCalledWith(2, 1000, undefined, {
      signal: expect.any(AbortSignal),
    });
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(second.cancel).toHaveBeenCalledTimes(1);
    expect(result.contentType).toBe("audio/x-m4a");
    expect(result.size).toBe(m4aHeader.length);
  });

  it("cancels every response when content never becomes ready", async () => {
    const attempts = Array.from({ length: 6 }, () => cancellableResponse(202));
    for (const attempt of attempts) {
      fetchMock.mockResolvedValueOnce(attempt.response);
    }

    await expect(downloadLineMedia("mid-stuck", "token")).rejects.toThrow(/still preparing/i);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(delayMock).toHaveBeenCalledTimes(5);
    expect(delayMock.mock.calls.map((call) => call[0])).toEqual([500, 1000, 2000, 4000, 4000]);
    for (const attempt of attempts) {
      expect(attempt.cancel).toHaveBeenCalledTimes(1);
    }
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
  });

  it("cancels error responses without retrying", async () => {
    const response = cancellableResponse(404);
    fetchMock.mockResolvedValueOnce(response.response);

    await expect(downloadLineMedia("mid-missing", "token")).rejects.toThrow(/HTTP 404/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.cancel).toHaveBeenCalledTimes(1);
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
  });

  it("preserves a permanent HTTP error when response cancellation fails", async () => {
    const response = cancellableResponse(404);
    response.cancel.mockRejectedValueOnce(new Error("cancel failed"));
    fetchMock.mockResolvedValueOnce(response.response);

    const err = expectMediaFetchError(
      await downloadLineMedia("mid-missing", "token").catch((e: unknown) => e),
    );

    expect(err.code).toBe("http_error");
    expect(err.status).toBe(404);
    expect(isRetryableLineInboundMediaError(err)).toBe(false);
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
  });

  it("aborts a hung content request at the total readiness deadline", async () => {
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(new Error("fetch aborted")), {
            once: true,
          });
        });
      },
    );

    vi.useFakeTimers();
    const pending = downloadLineMedia("mid-hung", "token");
    const rejection = expect(pending).rejects.toThrow(/did not become ready within 15 seconds/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
  });

  it("wraps an ordinary network failure for durable retry", async () => {
    const cause = new Error("socket reset");
    fetchMock.mockRejectedValueOnce(cause);

    const err = expectMediaFetchError(
      await downloadLineMedia("mid-network", "token").catch((e: unknown) => e),
    );

    expect(err.code).toBe("fetch_failed");
    expect(err.cause).toBe(cause);
    expect(isRetryableLineInboundMediaError(err)).toBe(true);
    expect(saveMediaStreamMock).not.toHaveBeenCalled();
  });

  it("propagates a response-stream failure for durable retry", async () => {
    const failure = new Error("response stream reset");
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(failure);
          },
        }),
        { status: 200 },
      ),
    );

    const err = expectMediaFetchError(
      await downloadLineMedia("mid-stream", "token").catch((e: unknown) => e),
    );

    expect(err.code).toBe("fetch_failed");
    expect(err.cause).toBe(failure);
    expect(isRetryableLineInboundMediaError(err)).toBe(true);
  });

  it("does not retry a permanent media-store failure", async () => {
    fetchMock.mockResolvedValueOnce(responseWithChunks(200, [Buffer.from("media")]));
    const failure = Object.assign(new Error("media store unavailable"), { code: "EACCES" });
    saveMediaStreamMock.mockRejectedValueOnce(failure);

    const err = await downloadLineMedia("mid-store", "token").catch((e: unknown) => e);

    expect(err).toBe(failure);
    expect(isRetryableLineInboundMediaError(err)).toBe(false);
  });

  it("raises a retryable MediaFetchError when content stays 202 until the attempt cap", async () => {
    for (let i = 0; i < 6; i++) {
      fetchMock.mockResolvedValueOnce(cancellableResponse(202).response);
    }

    const err = expectMediaFetchError(
      await downloadLineMedia("mid-stuck", "token").catch((e: unknown) => e),
    );

    expect(err.code).toBe("http_error");
    expect(err.status).toBe(202);
    expect(isRetryableLineInboundMediaError(err)).toBe(true);
  });

  it("raises a retryable MediaFetchError when the readiness deadline aborts", async () => {
    fetchMock.mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("fetch aborted")), {
            once: true,
          });
        }),
    );

    vi.useFakeTimers();
    const pending = downloadLineMedia("mid-hung", "token").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    const err = expectMediaFetchError(await pending);

    expect(err.code).toBe("fetch_failed");
    expect(isRetryableLineInboundMediaError(err)).toBe(true);
  });

  it("raises a non-retryable MediaFetchError for a permanent HTTP error", async () => {
    fetchMock.mockResolvedValueOnce(cancellableResponse(404).response);

    const err = expectMediaFetchError(
      await downloadLineMedia("mid-missing", "token").catch((e: unknown) => e),
    );

    expect(err.code).toBe("http_error");
    expect(err.status).toBe(404);
    expect(isRetryableLineInboundMediaError(err)).toBe(false);
  });

  it("classifies media failures for durable retry", () => {
    expect(
      isRetryableLineInboundMediaError(new MediaFetchError("http_error", "x", { status: 202 })),
    ).toBe(true);
    expect(
      isRetryableLineInboundMediaError(new MediaFetchError("http_error", "x", { status: 408 })),
    ).toBe(true);
    expect(
      isRetryableLineInboundMediaError(new MediaFetchError("http_error", "x", { status: 429 })),
    ).toBe(true);
    expect(
      isRetryableLineInboundMediaError(new MediaFetchError("http_error", "x", { status: 503 })),
    ).toBe(true);
    expect(isRetryableLineInboundMediaError(new MediaFetchError("fetch_failed", "x"))).toBe(false);
    expect(
      isRetryableLineInboundMediaError(new MediaFetchError("http_error", "x", { status: 404 })),
    ).toBe(false);
    expect(isRetryableLineInboundMediaError(new MediaFetchError("max_bytes", "x"))).toBe(false);
    expect(isRetryableLineInboundMediaError(new Error("Media exceeds 0MB limit"))).toBe(false);
  });
});
