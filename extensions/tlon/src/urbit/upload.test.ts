// Tlon tests cover upload plugin behavior.
import { MAX_IMAGE_BYTES, readRemoteMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { uploadFile } from "../tlon-api.js";
import { uploadImageFromUrl } from "./upload.js";

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MAX_IMAGE_BYTES: 6 * 1024 * 1024,
  readRemoteMediaBuffer: vi.fn(),
}));

vi.mock("../tlon-api.js", () => ({
  uploadFile: vi.fn(),
}));

const mockReadRemoteMediaBuffer = vi.mocked(readRemoteMediaBuffer);
const mockUploadFile = vi.mocked(uploadFile);

async function setupSuccessfulUpload(params?: { contentType?: string; uploadedUrl?: string }) {
  const contentType = params?.contentType ?? "image/png";
  const buffer = Buffer.from("fake-image");
  mockReadRemoteMediaBuffer.mockResolvedValue({
    buffer,
    contentType,
    fileName: "image.png",
  });
  if (params?.uploadedUrl) {
    mockUploadFile.mockResolvedValue({ url: params.uploadedUrl });
  }
  return { buffer };
}

function requireUploadParams(): { blob?: Blob; contentType?: string; fileName?: string } {
  const [call] = mockUploadFile.mock.calls;
  if (!call) {
    throw new Error("expected Tlon uploadFile call");
  }
  const [uploadParams] = call;
  if (!uploadParams || typeof uploadParams !== "object" || Array.isArray(uploadParams)) {
    throw new Error("expected Tlon uploadFile params");
  }
  return uploadParams as { blob?: Blob; contentType?: string; fileName?: string };
}

describe("uploadImageFromUrl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([undefined, 1024, MAX_IMAGE_BYTES * 2])(
    "uploads with the effective configured cap %s",
    async (cap) => {
      const { buffer } = await setupSuccessfulUpload({
        uploadedUrl: "https://memex.tlon.network/uploaded.png",
      });

      const result = await uploadImageFromUrl("https://example.com/image.png", cap);

      expect(result).toBe("https://memex.tlon.network/uploaded.png");
      expect(mockReadRemoteMediaBuffer).toHaveBeenCalledWith({
        url: "https://example.com/image.png",
        maxBytes: Math.min(cap ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES),
        responseHeaderTimeoutMs: 120_000,
        readIdleTimeoutMs: 30_000,
        ssrfPolicy: undefined,
        requestInit: { method: "GET" },
      });
      expect(mockUploadFile).toHaveBeenCalledTimes(1);
      const uploadParams = requireUploadParams();
      expect(uploadParams.contentType).toBe("image/png");
      const blob = uploadParams.blob;
      expect(blob).toBeInstanceOf(Blob);
      expect(Buffer.from(await blob!.arrayBuffer())).toEqual(buffer);
    },
  );

  it("returns original URL if fetch fails", async () => {
    mockReadRemoteMediaBuffer.mockRejectedValue(new Error("HTTP 404"));

    const result = await uploadImageFromUrl("https://example.com/image.png");

    expect(result).toBe("https://example.com/image.png");
  });

  it("does not embed an unchecked URL when a configured cap rejects its bytes", async () => {
    const error = new Error("payload exceeds maxBytes 1024");
    mockReadRemoteMediaBuffer.mockRejectedValue(error);
    await expect(uploadImageFromUrl("https://example.com/image.png", 1024)).rejects.toBe(error);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it("returns original URL when the remote image exceeds the image cap", async () => {
    mockReadRemoteMediaBuffer.mockRejectedValue(
      new Error(
        `Failed to fetch media from https://example.com/image.png: payload exceeds maxBytes ${MAX_IMAGE_BYTES}`,
      ),
    );

    const result = await uploadImageFromUrl("https://example.com/image.png");

    expect(result).toBe("https://example.com/image.png");
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it.each([undefined, 1024])(
    "retains the bounded original URL if upload fails with cap %s",
    async (cap) => {
      await setupSuccessfulUpload();
      mockUploadFile.mockRejectedValue(new Error("Upload failed"));

      const result = await uploadImageFromUrl("https://example.com/image.png", cap);

      expect(result).toBe("https://example.com/image.png");
    },
  );

  it("rejects non-http(s) URLs", async () => {
    const result = await uploadImageFromUrl("file:///etc/passwd");
    expect(result).toBe("file:///etc/passwd");

    const result2 = await uploadImageFromUrl("ftp://example.com/image.png");
    expect(result2).toBe("ftp://example.com/image.png");
    expect(mockReadRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("handles invalid URLs gracefully", async () => {
    const result = await uploadImageFromUrl("not-a-valid-url");
    expect(result).toBe("not-a-valid-url");
    expect(mockReadRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("extracts filename from URL path", async () => {
    await setupSuccessfulUpload({
      contentType: "image/jpeg",
    });
    mockUploadFile.mockResolvedValue({ url: "https://memex.tlon.network/uploaded.jpg" });

    await uploadImageFromUrl("https://example.com/path/to/my-image.jpg");

    expect(requireUploadParams().fileName).toBe("my-image.jpg");
  });

  it("uses default filename when URL has no path", async () => {
    await setupSuccessfulUpload({
      contentType: "image/png",
    });
    mockUploadFile.mockResolvedValue({ url: "https://memex.tlon.network/uploaded.png" });

    await uploadImageFromUrl("https://example.com/");

    expect(requireUploadParams().fileName).toMatch(/^upload-\d+\.png$/);
  });
});
