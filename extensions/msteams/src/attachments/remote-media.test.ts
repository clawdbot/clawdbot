import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the runtime so we can assert whether the strict-dispatcher path
// (`saveRemoteMedia`) was invoked versus the new direct-fetch path added
// for issue #63396 (Node 24+ / undici v7 compat).
const runtimeSaveRemoteMediaMock = vi.fn(
  async (
    _params: unknown,
  ): Promise<{
    id: string;
    path: string;
    size: number;
    contentType?: string;
    fileName?: string;
  }> => ({
    id: "saved",
    path: "/tmp/saved.png",
    size: 42,
    contentType: "image/png",
  }),
);
const runtimeDetectMimeMock = vi.fn(async () => "image/png");
const runtimeSaveMediaBufferMock = vi.fn(async (_buf: Buffer, contentType?: string) => ({
  id: "saved",
  path: "/tmp/saved.png",
  size: 42,
  contentType: contentType ?? "image/png",
}));
const saveResponseMediaMock = vi.hoisted(() =>
  vi.fn(async (response: Response, options: { maxBytes?: number }) => {
    if (!response.ok) {
      const statusText = response.statusText ? ` ${response.statusText}` : "";
      throw new Error(`HTTP ${response.status}${statusText}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && options.maxBytes && contentLength > options.maxBytes) {
      throw new Error(`content length ${contentLength} exceeds maxBytes ${options.maxBytes}`);
    }
    return {
      id: "saved",
      path: "/tmp/saved.png",
      size: 42,
      contentType: response.headers.get("content-type") ?? "image/png",
    };
  }),
);

vi.mock("openclaw/plugin-sdk/media-runtime", async () => ({
  saveResponseMedia: saveResponseMediaMock,
}));

vi.mock("../runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    media: { detectMime: runtimeDetectMimeMock },
    channel: {
      media: {
        saveRemoteMedia: runtimeSaveRemoteMediaMock,
        saveMediaBuffer: runtimeSaveMediaBufferMock,
      },
    },
  }),
}));

import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function jsonResponse(body: BodyInit, init?: ResponseInit): Response {
  return new Response(body, init);
}

function requireFirstFetchUrl(mock: ReturnType<typeof vi.fn>): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected direct fetch call");
  }
  return call[0];
}

describe("downloadAndStoreMSTeamsRemoteMedia", () => {
  beforeEach(() => {
    runtimeSaveRemoteMediaMock.mockClear();
    saveResponseMediaMock.mockClear();
    runtimeDetectMimeMock.mockClear();
    runtimeSaveMediaBufferMock.mockClear();
  });

  describe("useDirectFetch: true (Node 24+ / undici v7 path for issue #63396)", () => {
    it("bypasses readRemoteMediaBuffer and calls the supplied fetchImpl directly", async () => {
      // `fetchImpl` here simulates the "pre-validated hostname" contract from
      // `safeFetchWithPolicy`: the caller has already enforced the allowlist,
      // so the strict SSRF dispatcher is not needed.
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(PNG_BYTES, { status: 200, headers: { "content-type": "image/png" } }),
      );

      const result = await downloadAndStoreMSTeamsRemoteMedia({
        url: "https://graph.microsoft.com/v1.0/shares/abc/driveItem/content",
        filePathHint: "file.png",
        maxBytes: 1024,
        useDirectFetch: true,
        fetchImpl,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const calledUrl = requireFirstFetchUrl(fetchImpl);
      expect(calledUrl).toBe("https://graph.microsoft.com/v1.0/shares/abc/driveItem/content");
      expect(runtimeSaveRemoteMediaMock).not.toHaveBeenCalled();
      expect(result.path).toBe("/tmp/saved.png");
    });

    it("surfaces HTTP errors as exceptions (no silent drop)", async () => {
      const fetchImpl = vi.fn(async () => jsonResponse("nope", { status: 403 }));

      await expect(
        downloadAndStoreMSTeamsRemoteMedia({
          url: "https://graph.microsoft.com/v1.0/shares/abc/driveItem/content",
          filePathHint: "file.png",
          maxBytes: 1024,
          useDirectFetch: true,
          fetchImpl,
        }),
      ).rejects.toThrow(/HTTP 403/);
      expect(runtimeSaveRemoteMediaMock).not.toHaveBeenCalled();
    });

    it("rejects a response whose Content-Length exceeds maxBytes", async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(PNG_BYTES, {
          status: 200,
          headers: { "content-length": "999999" },
        }),
      );

      await expect(
        downloadAndStoreMSTeamsRemoteMedia({
          url: "https://graph.microsoft.com/v1.0/shares/abc/driveItem/content",
          filePathHint: "file.png",
          maxBytes: 1024,
          useDirectFetch: true,
          fetchImpl,
        }),
      ).rejects.toThrow(/exceeds maxBytes/);
      expect(runtimeSaveRemoteMediaMock).not.toHaveBeenCalled();
    });

    it("falls back to the runtime saveRemoteMedia path when useDirectFetch is omitted", async () => {
      // Non-SharePoint caller, no pre-validated fetchImpl: make sure the strict
      // SSRF dispatcher path is still used.
      runtimeSaveRemoteMediaMock.mockResolvedValueOnce({
        id: "saved",
        path: "/tmp/saved.png",
        size: 42,
        contentType: "image/png",
        fileName: "file.png",
      });

      await downloadAndStoreMSTeamsRemoteMedia({
        url: "https://tenant.sharepoint.com/file.png",
        filePathHint: "file.png",
        maxBytes: 1024,
      });

      expect(runtimeSaveRemoteMediaMock).toHaveBeenCalledTimes(1);
    });

    it("does not use the direct path when useDirectFetch is true but fetchImpl is missing", async () => {
      runtimeSaveRemoteMediaMock.mockResolvedValueOnce({
        id: "saved",
        path: "/tmp/saved.png",
        size: 42,
        contentType: "image/png",
      });

      await downloadAndStoreMSTeamsRemoteMedia({
        url: "https://graph.microsoft.com/v1.0/shares/abc/driveItem/content",
        filePathHint: "file.png",
        maxBytes: 1024,
        useDirectFetch: true,
      });

      // Without a fetchImpl to delegate to, we must fall back to the runtime
      // path rather than crashing.
      expect(runtimeSaveRemoteMediaMock).toHaveBeenCalledTimes(1);
    });
  });
});
