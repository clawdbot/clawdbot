// Input file fetch guard tests cover network fetch limits for media inputs.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.fn();
const convertHeicToJpegMock = vi.fn();
const detectMimeMock = vi.fn();
const extractPdfContentMock = vi.fn();

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

vi.mock("./media-services.js", () => ({
  convertHeicToJpeg: (...args: unknown[]) => convertHeicToJpegMock(...args),
}));

vi.mock("@openclaw/media-core/mime", async () => {
  const actual = await vi.importActual<typeof import("@openclaw/media-core/mime")>(
    "@openclaw/media-core/mime",
  );
  detectMimeMock.mockImplementation(actual.detectMime);
  return { ...actual, detectMime: (...args: unknown[]) => detectMimeMock(...args) };
});

vi.mock("./pdf-extract.js", () => ({
  extractPdfContent: (...args: unknown[]) => extractPdfContentMock(...args),
}));

async function waitForMicrotaskTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
}

let extractImageContentFromSource: typeof import("./input-files.js").extractImageContentFromSource;
let extractFileContentFromSource: typeof import("./input-files.js").extractFileContentFromSource;

beforeAll(async () => {
  ({ extractImageContentFromSource, extractFileContentFromSource } =
    await import("./input-files.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  extractPdfContentMock.mockResolvedValue({ text: "", images: [] });
});

function createImageSourceLimits(allowedMimes: string[], allowUrl = false) {
  return {
    allowUrl,
    allowedMimes: new Set(allowedMimes),
    maxBytes: 1024 * 1024,
    maxRedirects: 0,
    timeoutMs: allowUrl ? 1000 : 1,
  };
}

function createFileSourceLimits(allowedMimes: string[], allowUrl = false) {
  return {
    allowUrl,
    allowedMimes: new Set(allowedMimes),
    maxBytes: 1024 * 1024,
    maxChars: 100,
    maxRedirects: 0,
    timeoutMs: allowUrl ? 1000 : 1,
    pdf: { maxPages: 1, maxPixels: 1, minTextChars: 1 },
  };
}

function mockUrlFetchResponse(params: {
  source: Parameters<typeof extractImageContentFromSource>[0];
  fetchedUrl?: string;
  fetchedContentType?: string;
  fetchedBody?: Uint8Array;
}) {
  if (params.source.type !== "url") {
    return null;
  }

  const release = vi.fn(async () => {});
  const responseBody = Uint8Array.from(params.fetchedBody ?? Buffer.from("url-source"));
  const headers = new Headers();
  if (params.fetchedContentType !== undefined) {
    headers.set("content-type", params.fetchedContentType);
  }
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: new Response(
      responseBody.buffer.slice(
        responseBody.byteOffset,
        responseBody.byteOffset + responseBody.byteLength,
      ),
      {
        status: 200,
        headers,
      },
    ),
    release,
    finalUrl: params.fetchedUrl ?? params.source.url,
  });

  return release;
}

async function expectRejectedImageMimeCase(params: {
  source: Parameters<typeof extractImageContentFromSource>[0];
  limits: Parameters<typeof extractImageContentFromSource>[1];
  expectedError: string;
  fetchedUrl?: string;
  fetchedContentType?: string;
  fetchedBody?: Uint8Array;
}) {
  const release = mockUrlFetchResponse(params);
  await expect(extractImageContentFromSource(params.source, params.limits)).rejects.toThrow(
    params.expectedError,
  );
  if (release) {
    expect(release).toHaveBeenCalledTimes(1);
  }
}

type ImageSourceLimits = Parameters<typeof extractImageContentFromSource>[1];

async function expectResolvedImageContentCase(params: {
  source: Parameters<typeof extractImageContentFromSource>[0];
  limits: ImageSourceLimits;
  detectedMime: string;
  convertedBytes?: Buffer;
  fetchedUrl?: string;
  fetchedContentType?: string;
  fetchedBody?: Uint8Array;
  expectedImage: Awaited<ReturnType<typeof extractImageContentFromSource>>;
}) {
  const release = mockUrlFetchResponse(params);
  detectMimeMock.mockResolvedValueOnce(params.detectedMime);
  if (params.convertedBytes) {
    convertHeicToJpegMock.mockResolvedValueOnce(params.convertedBytes);
  }

  const image = await extractImageContentFromSource(params.source, params.limits);

  expect(image).toEqual(params.expectedImage);
  expect(detectMimeMock).toHaveBeenCalledTimes(1);
  expect(convertHeicToJpegMock).toHaveBeenCalledTimes(params.convertedBytes ? 1 : 0);
  if (release) {
    expect(release).toHaveBeenCalledTimes(1);
  }
}

async function expectBase64ImageValidationCase(params: {
  source: Parameters<typeof extractImageContentFromSource>[0];
  limits: Parameters<typeof extractImageContentFromSource>[1];
  expectedData?: string;
  expectedError?: string;
}) {
  if (params.expectedError) {
    await expect(extractImageContentFromSource(params.source, params.limits)).rejects.toThrow(
      params.expectedError,
    );
    return;
  }

  const image = await extractImageContentFromSource(params.source, params.limits);
  expect(image.data).toBe(params.expectedData);
}

describe("HEIC input image normalization", () => {
  it.each([
    {
      name: "converts base64 HEIC images to JPEG before returning them",
      source: {
        type: "base64",
        data: Buffer.from("heic-source").toString("base64"),
        mediaType: "image/heic",
      } as const,
      limits: createImageSourceLimits(["image/heic", "image/jpeg"]),
      detectedMime: "image/heic",
      convertedBytes: Buffer.from("jpeg-normalized"),
      expectedImage: {
        type: "image",
        data: Buffer.from("jpeg-normalized").toString("base64"),
        mimeType: "image/jpeg",
      },
    },
    {
      name: "converts URL HEIC images to JPEG before returning them",
      source: {
        type: "url",
        url: "https://example.com/photo.heic",
      } as const,
      limits: createImageSourceLimits(["image/heic", "image/jpeg"], true),
      detectedMime: "image/heic",
      convertedBytes: Buffer.from("jpeg-url-normalized"),
      fetchedUrl: "https://example.com/photo.heic",
      fetchedContentType: "image/heic",
      fetchedBody: Buffer.from("heic-url-source"),
      expectedImage: {
        type: "image",
        data: Buffer.from("jpeg-url-normalized").toString("base64"),
        mimeType: "image/jpeg",
      },
    },
    {
      name: "converts sniffed HEIC sequence images using the existing HEIC allowlist",
      source: {
        type: "base64",
        data: Buffer.from("heic-sequence-source").toString("base64"),
        mediaType: "image/heic",
      } as const,
      limits: createImageSourceLimits(["image/heic", "image/jpeg"]),
      detectedMime: "image/heic-sequence",
      convertedBytes: Buffer.from("jpeg-heic-sequence"),
      expectedImage: {
        type: "image",
        data: Buffer.from("jpeg-heic-sequence").toString("base64"),
        mimeType: "image/jpeg",
      },
    },
    {
      name: "converts sniffed HEIF sequence images using the existing HEIF allowlist",
      source: {
        type: "base64",
        data: Buffer.from("heif-sequence-source").toString("base64"),
        mediaType: "image/heif",
      } as const,
      limits: createImageSourceLimits(["image/heif", "image/jpeg"]),
      detectedMime: "image/heif-sequence",
      convertedBytes: Buffer.from("jpeg-heif-sequence"),
      expectedImage: {
        type: "image",
        data: Buffer.from("jpeg-heif-sequence").toString("base64"),
        mimeType: "image/jpeg",
      },
    },
    {
      name: "converts fetched HEIC sequence images using the existing HEIC allowlist",
      source: {
        type: "url",
        url: "https://example.com/photo.heic",
      } as const,
      limits: createImageSourceLimits(["image/heic", "image/jpeg"], true),
      detectedMime: "image/heic-sequence",
      convertedBytes: Buffer.from("jpeg-url-sequence"),
      fetchedContentType: "image/heic-sequence",
      fetchedBody: Buffer.from("heic-url-sequence"),
      expectedImage: {
        type: "image",
        data: Buffer.from("jpeg-url-sequence").toString("base64"),
        mimeType: "image/jpeg",
      },
    },
    {
      name: "keeps declared MIME for non-HEIC images after validation",
      source: {
        type: "base64",
        data: Buffer.from("png-like").toString("base64"),
        mediaType: "image/png",
      } as const,
      limits: createImageSourceLimits(["image/png"]),
      detectedMime: "image/png",
      expectedImage: {
        type: "image",
        data: Buffer.from("png-like").toString("base64"),
        mimeType: "image/png",
      },
    },
    {
      name: "prefers sniffed JPEG when base64 mediaType is absent (OpenAI-compatible endpoint path)",
      source: {
        type: "base64",
        data: Buffer.from("jpeg-bytes").toString("base64"),
      } as const,
      limits: createImageSourceLimits(["image/png", "image/jpeg"]),
      detectedMime: "image/jpeg",
      expectedImage: {
        type: "image",
        data: Buffer.from("jpeg-bytes").toString("base64"),
        mimeType: "image/jpeg",
      },
    },
    {
      name: "prefers sniffed JPEG when declared HEIC bytes are actually JPEG",
      source: {
        type: "base64",
        data: Buffer.from("jpeg-bytes").toString("base64"),
        mediaType: "image/heic",
      } as const,
      limits: createImageSourceLimits(["image/heic", "image/jpeg"]),
      detectedMime: "image/jpeg",
      expectedImage: {
        type: "image",
        data: Buffer.from("jpeg-bytes").toString("base64"),
        mimeType: "image/jpeg",
      },
    },
    {
      name: "prefers sniffed MIME for URL images with a generic Content-Type header",
      source: {
        type: "url",
        url: "https://example.com/photo",
      } as const,
      limits: createImageSourceLimits(["image/png", "image/webp"], true),
      detectedMime: "image/webp",
      fetchedUrl: "https://example.com/photo",
      fetchedContentType: "application/octet-stream",
      fetchedBody: Buffer.from("webp-bytes"),
      expectedImage: {
        type: "image",
        data: Buffer.from("webp-bytes").toString("base64"),
        mimeType: "image/webp",
      },
    },
  ] as const)("$name", async (testCase) => {
    await expectResolvedImageContentCase(testCase);
  });

  it.each([
    {
      name: "rejects spoofed base64 images when detected bytes are not an image",
      source: {
        type: "base64" as const,
        data: Buffer.from("%PDF-1.4\n").toString("base64"),
        mediaType: "image/png",
      },
      limits: createImageSourceLimits(["image/png", "image/jpeg"]),
      detectedMime: "application/pdf",
      expectedError: "Unsupported image MIME type: application/pdf",
    },
    {
      name: "rejects spoofed URL images when detected bytes are not an image",
      source: {
        type: "url" as const,
        url: "https://example.com/photo.png",
      },
      limits: createImageSourceLimits(["image/png", "image/jpeg"], true),
      detectedMime: "application/pdf",
      expectedError: "Unsupported image MIME type: application/pdf",
      fetchedUrl: "https://example.com/photo.png",
      fetchedContentType: "image/png",
      fetchedBody: Buffer.from("%PDF-1.4\n"),
    },
    {
      name: "rejects sequence images when their canonical HEIC MIME is not allowed",
      source: {
        type: "base64" as const,
        data: Buffer.from("heic-sequence-source").toString("base64"),
        mediaType: "image/heic-sequence",
      },
      limits: createImageSourceLimits(["image/png", "image/jpeg"]),
      detectedMime: "image/heic-sequence",
      expectedError: "Unsupported image MIME type",
    },
    {
      name: "rejects spoofed HEIC sequence metadata when detected bytes are not an image",
      source: {
        type: "base64" as const,
        data: Buffer.from("%PDF-1.4\n").toString("base64"),
        mediaType: "image/heic-sequence",
      },
      limits: createImageSourceLimits(["image/heic", "image/jpeg"]),
      detectedMime: "application/pdf",
      expectedError: "Unsupported image MIME type: application/pdf",
    },
  ] as const)("$name", async (testCase) => {
    detectMimeMock.mockResolvedValueOnce(testCase.detectedMime);
    await expectRejectedImageMimeCase(testCase);
    expect(convertHeicToJpegMock).not.toHaveBeenCalled();
  });
});

describe("guarded input file URL fetches", () => {
  it.each(["image", "file"] as const)(
    "does not start %s processing after cancellation during fetch release",
    async (kind) => {
      const controller = new AbortController();
      const reason = new Error("HTTP request ended during download cleanup");
      const source = { type: "url" as const, url: "https://example.com/input" };
      const release = mockUrlFetchResponse({
        source,
        fetchedContentType: kind === "image" ? "image/png" : "application/pdf",
        fetchedBody:
          kind === "image"
            ? Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2N4j8AAAAASUVORK5CYII=",
                "base64",
              )
            : Buffer.from("%PDF-1.4\n"),
      });
      release?.mockImplementationOnce(async () => controller.abort(reason));

      const extraction =
        kind === "image"
          ? extractImageContentFromSource(
              source,
              createImageSourceLimits(["image/png"], true),
              controller.signal,
            )
          : extractFileContentFromSource({
              source,
              limits: createFileSourceLimits(["application/pdf"], true),
              signal: controller.signal,
            });
      await expect(extraction).rejects.toBe(reason);
      expect(kind === "image" ? detectMimeMock : extractPdfContentMock).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("releases a rejected fetch without waiting for its capture tee", async () => {
    const response = new Response("server error", { status: 503 });
    const capture = response.clone();
    const release = vi.fn(async () => {
      await capture.body?.cancel();
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
    let failure: unknown;
    const pending = extractFileContentFromSource({
      source: { type: "url", url: "https://example.com/notes" },
      limits: createFileSourceLimits(["text/plain"], true),
    }).catch((error: unknown) => {
      failure = error;
    });

    try {
      await vi.waitFor(() => expect(failure).toBeInstanceOf(Error), { timeout: 500 });
      expect(failure).toMatchObject({ message: expect.stringContaining("Failed to fetch: 503") });
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      await capture.body?.cancel();
      await pending;
    }
  });

  it.each([
    'text/plain; charset="windows-1252"',
    'text/plain; note="a;charset=utf-8;b"; charset=windows-1252',
  ])("decodes fetched bytes using response metadata %s", async (fetchedContentType) => {
    const source = {
      type: "url" as const,
      url: "https://example.com/notes.txt",
      mediaType: "text/plain; charset=utf-8",
    };
    const release = mockUrlFetchResponse({
      source,
      fetchedContentType,
      fetchedBody: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]),
    });

    await expect(
      extractFileContentFromSource({
        source,
        limits: createFileSourceLimits(["text/plain"], true),
      }),
    ).resolves.toEqual({ filename: "file", text: "café €" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cancels ignored HTTP error bodies", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("server error"));
      },
      cancel() {
        canceled = true;
      },
    });
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(stream, {
        status: 503,
        statusText: "Service Unavailable",
      }),
      release,
      finalUrl: "https://example.com/file.bin",
    });

    await expect(
      extractFileContentFromSource({
        source: { type: "url", url: "https://example.com/file.bin" },
        limits: {
          ...createFileSourceLimits(["application/octet-stream"], true),
          maxBytes: 1024,
        },
      }),
    ).rejects.toThrow("Failed to fetch: 503 Service Unavailable");

    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cancels ignored bodies when content-length exceeds the byte limit", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() {
        canceled = true;
      },
    });
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(stream, {
        status: 200,
        headers: { "content-length": "2048", "content-type": "application/octet-stream" },
      }),
      release,
      finalUrl: "https://example.com/file.bin",
    });

    await expect(
      extractFileContentFromSource({
        source: { type: "url", url: "https://example.com/file.bin" },
        limits: {
          ...createFileSourceLimits(["application/octet-stream"], true),
          maxBytes: 1024,
        },
      }),
    ).rejects.toThrow("Content too large: 2048 bytes");

    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed content-length before reading input files", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() {
        canceled = true;
      },
    });
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(stream, {
        status: 200,
        headers: { "content-length": "1e9", "content-type": "application/octet-stream" },
      }),
      release,
      finalUrl: "https://example.com/file.bin",
    });

    await expect(
      extractFileContentFromSource({
        source: { type: "url", url: "https://example.com/file.bin" },
        limits: {
          ...createFileSourceLimits(["application/octet-stream"], true),
          maxBytes: 1024,
        },
      }),
    ).rejects.toThrow("invalid content-length header: 1e9");

    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized streamed payloads and cancels the stream", async () => {
    let canceled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array([5, 6, 7, 8]));
        }
        // keep stream open; cancel() should stop it once maxBytes exceeded
      },
      cancel() {
        canceled = true;
      },
    });

    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(stream, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
      release,
      finalUrl: "https://example.com/file.bin",
    });

    await expect(
      extractFileContentFromSource({
        source: { type: "url", url: "https://example.com/file.bin" },
        limits: {
          ...createFileSourceLimits(["application/octet-stream"], true),
          maxBytes: 6,
        },
      }),
    ).rejects.toThrow("Content too large");

    // Allow cancel() microtask to run.
    await waitForMicrotaskTurn();

    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("input file MIME sniffing", () => {
  it.each(['image/apng; charset="utf-8"', "not-a-mime; charset=windows-1252"])(
    "keeps sniffed URL image admission with %s metadata",
    async (fetchedContentType) => {
      const source = { type: "url" as const, url: "https://example.com/image" };
      const bytes = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2N4j8AAAAASUVORK5CYII=",
        "base64",
      );
      const release = mockUrlFetchResponse({ source, fetchedContentType, fetchedBody: bytes });

      await expect(
        extractImageContentFromSource(source, createImageSourceLimits(["image/png"], true)),
      ).resolves.toEqual({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("infers printable URL file bytes as text when Content-Type is absent", async () => {
    const body = "headerless printable text";
    mockUrlFetchResponse({
      source: { type: "url", url: "https://example.com/notes" },
      fetchedBody: Buffer.from(body),
    });

    await expect(
      extractFileContentFromSource({
        source: { type: "url", url: "https://example.com/notes" },
        limits: createFileSourceLimits(["text/plain"], true),
      }),
    ).resolves.toEqual({ filename: "file", text: body });
  });

  it("keeps an explicit octet-stream response binary for the same printable URL bytes", async () => {
    const body = Buffer.from("headerless printable text");
    mockUrlFetchResponse({
      source: { type: "url", url: "https://example.com/notes" },
      fetchedContentType: 'application/octet-stream; charset="windows-1252"',
      fetchedBody: body,
    });

    await expect(
      extractFileContentFromSource({
        source: { type: "url", url: "https://example.com/notes" },
        limits: createFileSourceLimits(["text/plain"], true),
      }),
    ).rejects.toThrow("Unsupported file MIME type: application/octet-stream");
  });

  it("rejects base64 files whose bytes sniff as an unsupported image despite a text media type", async () => {
    detectMimeMock.mockResolvedValueOnce("image/png");

    await expect(
      extractFileContentFromSource({
        source: {
          type: "base64",
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"),
          mediaType: "text/plain",
          filename: "note.txt",
        },
        limits: createFileSourceLimits(["text/plain", "application/pdf"]),
      }),
    ).rejects.toThrow("Unsupported file MIME type: image/png");
  });

  it("rejects URL files whose bytes sniff as an unsupported image despite a text content-type", async () => {
    mockUrlFetchResponse({
      source: { type: "url", url: "https://example.com/note.txt", mediaType: "text/plain" },
      fetchedContentType: "text/plain",
      fetchedBody: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    detectMimeMock.mockResolvedValueOnce("image/png");

    await expect(
      extractFileContentFromSource({
        source: { type: "url", url: "https://example.com/note.txt", mediaType: "text/plain" },
        limits: createFileSourceLimits(["text/plain", "application/pdf"], true),
      }),
    ).rejects.toThrow("Unsupported file MIME type: image/png");
  });

  it("rejects generic zip bytes mislabeled as text", async () => {
    detectMimeMock.mockResolvedValueOnce("application/zip");

    await expect(
      extractFileContentFromSource({
        source: {
          type: "base64",
          data: Buffer.from("PK\u0003\u0004fake-zip").toString("base64"),
          mediaType: "text/plain",
          filename: "notes.txt",
        },
        limits: createFileSourceLimits(["text/plain"]),
      }),
    ).rejects.toThrow("Unsupported file MIME type: application/zip");
  });

  it("times out local PDF extraction with the input file timeout", async () => {
    vi.useFakeTimers();
    try {
      detectMimeMock.mockResolvedValueOnce("application/pdf");
      extractPdfContentMock.mockReturnValueOnce(new Promise(() => {}));

      const pending = expect(
        extractFileContentFromSource({
          source: {
            type: "base64",
            data: Buffer.from("%PDF-1.4\n").toString("base64"),
            mediaType: "application/pdf",
            filename: "scan.pdf",
          },
          limits: createFileSourceLimits(["application/pdf"]),
        }),
      ).rejects.toThrow("PDF extraction timed out after 1ms");

      await vi.advanceTimersByTimeAsync(1);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("base64 size guards", () => {
  it.each([
    {
      kind: "images",
      expectedError: "Image too large",
      run: async (data: string) => {
        return await extractImageContentFromSource(
          { type: "base64", data, mediaType: "image/png" },
          {
            allowUrl: false,
            allowedMimes: new Set(["image/png"]),
            maxBytes: 6,
            maxRedirects: 0,
            timeoutMs: 1,
          },
        );
      },
    },
    {
      kind: "files",
      expectedError: "File too large",
      run: async (data: string) => {
        return await extractFileContentFromSource({
          source: { type: "base64", data, mediaType: "text/plain", filename: "x.txt" },
          limits: {
            allowUrl: false,
            allowedMimes: new Set(["text/plain"]),
            maxBytes: 6,
            maxChars: 100,
            maxRedirects: 0,
            timeoutMs: 1,
            pdf: { maxPages: 1, maxPixels: 1, minTextChars: 1 },
          },
        });
      },
    },
  ] as const)("rejects oversized base64 $kind before decoding", async (testCase) => {
    const data = Buffer.alloc(7).toString("base64");
    const fromSpy = vi.spyOn(Buffer, "from");
    await expect(testCase.run(data)).rejects.toThrow(testCase.expectedError);

    // Regression check: oversize reject happens before Buffer.from(..., "base64") allocates.
    const base64Calls = fromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64");
    expect(base64Calls).toHaveLength(0);
    fromSpy.mockRestore();
  });
});

describe("input image base64 validation", () => {
  it.each([
    {
      name: "rejects malformed base64 payloads",
      source: {
        type: "base64",
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2N4j8AAAAASUVORK5CYII=" onerror="alert(1)',
        mediaType: "image/png",
      } as const,
      limits: {
        allowUrl: false,
        allowedMimes: new Set(["image/png"]),
        maxBytes: 1024 * 1024,
        maxRedirects: 0,
        timeoutMs: 1,
      },
      expectedError: "invalid 'data' field",
    },
    {
      name: "normalizes whitespace in valid base64 payloads",
      source: {
        type: "base64",
        data: " aGVs bG8= \n",
        mediaType: "image/png",
      } as const,
      limits: createImageSourceLimits(["image/png"]),
      expectedData: "aGVsbG8=",
    },
  ] as const)("$name", async ({ source, limits, expectedData, expectedError }) => {
    await expectBase64ImageValidationCase({
      source,
      limits,
      ...(expectedData ? { expectedData } : {}),
      ...(expectedError ? { expectedError } : {}),
    });
  });
});
