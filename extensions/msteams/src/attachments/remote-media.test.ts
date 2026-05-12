import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the runtime so we can assert whether the strict-dispatcher path
// (`fetchRemoteMedia`) was invoked versus the new direct-fetch path added
// for issue #63396 (Node 24+ / undici v7 compat).
const runtimeFetchRemoteMediaMock = vi.fn();
const runtimeDetectMimeMock = vi.fn(async () => "image/png");
const runtimeSaveMediaBufferMock = vi.fn(async (_buf: Buffer, contentType?: string) => ({
  id: "saved",
  path: "/tmp/saved.png",
  size: 42,
  contentType: contentType ?? "image/png",
}));

vi.mock("../runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    media: { detectMime: runtimeDetectMimeMock },
    channel: {
      media: {
        fetchRemoteMedia: runtimeFetchRemoteMediaMock,
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
    runtimeFetchRemoteMediaMock.mockReset();
    runtimeDetectMimeMock.mockClear();
    runtimeSaveMediaBufferMock.mockClear();
  });

  describe("useDirectFetch: true (Node 24+ / undici v7 path for issue #63396)", () => {
    it("bypasses fetchRemoteMedia and calls the supplied fetchImpl directly", async () => {
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
      expect(runtimeFetchRemoteMediaMock).not.toHaveBeenCalled();
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
      expect(runtimeFetchRemoteMediaMock).not.toHaveBeenCalled();
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
      expect(runtimeFetchRemoteMediaMock).not.toHaveBeenCalled();
    });

    it("falls back to the runtime fetchRemoteMedia path when useDirectFetch is omitted", async () => {
      // Non-SharePoint caller, no pre-validated fetchImpl: make sure the strict
      // SSRF dispatcher path is still used.
      runtimeFetchRemoteMediaMock.mockResolvedValueOnce({
        buffer: PNG_BYTES,
        contentType: "image/png",
        fileName: "file.png",
      });

      await downloadAndStoreMSTeamsRemoteMedia({
        url: "https://tenant.sharepoint.com/file.png",
        filePathHint: "file.png",
        maxBytes: 1024,
      });

      expect(runtimeFetchRemoteMediaMock).toHaveBeenCalledTimes(1);
    });

    it("does not use the direct path when useDirectFetch is true but fetchImpl is missing", async () => {
      runtimeFetchRemoteMediaMock.mockResolvedValueOnce({
        buffer: PNG_BYTES,
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
      expect(runtimeFetchRemoteMediaMock).toHaveBeenCalledTimes(1);
    });
  });
});
