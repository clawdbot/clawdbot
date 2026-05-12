import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { uploadFile } from "../tlon-api.js";
import { uploadImageFromUrl } from "./upload.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../tlon-api.js", () => ({
  uploadFile: vi.fn(),
}));

const mockFetch = vi.mocked(fetchWithSsrFGuard);
const mockUploadFile = vi.mocked(uploadFile);

type FetchMock = typeof mockFetch;

function mockSuccessfulFetch(params: {
  mockFetch: FetchMock;
  blob: Blob;
  finalUrl: string;
  contentType: string;
}) {
  params.mockFetch.mockResolvedValue({
    response: {
      ok: true,
      headers: new Headers({ "content-type": params.contentType }),
      blob: () => Promise.resolve(params.blob),
    } as unknown as Response,
    finalUrl: params.finalUrl,
    release: vi.fn().mockResolvedValue(undefined),
  });
}

async function setupSuccessfulUpload(params?: {
  sourceUrl?: string;
  contentType?: string;
  uploadedUrl?: string;
}) {
  const sourceUrl = params?.sourceUrl ?? "https://example.com/image.png";
  const contentType = params?.contentType ?? "image/png";
  const mockBlob = new Blob(["fake-image"], { type: contentType });
  mockSuccessfulFetch({
    mockFetch,
    blob: mockBlob,
    finalUrl: sourceUrl,
    contentType,
  });
  if (params?.uploadedUrl) {
    mockUploadFile.mockResolvedValue({ url: params.uploadedUrl });
  }
  return { mockBlob };
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

  it("fetches image and calls uploadFile, returns uploaded URL", async () => {
    const { mockBlob } = await setupSuccessfulUpload({
      uploadedUrl: "https://memex.tlon.network/uploaded.png",
    });

    const result = await uploadImageFromUrl("https://example.com/image.png");

    expect(result).toBe("https://memex.tlon.network/uploaded.png");
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    const uploadParams = requireUploadParams();
    expect(uploadParams.blob).toBe(mockBlob);
    expect(uploadParams.contentType).toBe("image/png");
  });

  it("returns original URL if fetch fails", async () => {
    mockFetch.mockResolvedValue({
      response: {
        ok: false,
        status: 404,
      } as unknown as Response,
      finalUrl: "https://example.com/image.png",
      release: vi.fn().mockResolvedValue(undefined),
    });

    const result = await uploadImageFromUrl("https://example.com/image.png");

    expect(result).toBe("https://example.com/image.png");
  });

  it("returns original URL if upload fails", async () => {
    await setupSuccessfulUpload();
    mockUploadFile.mockRejectedValue(new Error("Upload failed"));

    const result = await uploadImageFromUrl("https://example.com/image.png");

    expect(result).toBe("https://example.com/image.png");
  });

  it("rejects non-http(s) URLs", async () => {
    const result = await uploadImageFromUrl("file:///etc/passwd");
    expect(result).toBe("file:///etc/passwd");

    const result2 = await uploadImageFromUrl("ftp://example.com/image.png");
    expect(result2).toBe("ftp://example.com/image.png");
  });

  it("handles invalid URLs gracefully", async () => {
    const result = await uploadImageFromUrl("not-a-valid-url");
    expect(result).toBe("not-a-valid-url");
  });

  it("extracts filename from URL path", async () => {
    const mockBlob = new Blob(["fake-image"], { type: "image/jpeg" });
    mockSuccessfulFetch({
      mockFetch,
      blob: mockBlob,
      finalUrl: "https://example.com/path/to/my-image.jpg",
      contentType: "image/jpeg",
    });

    mockUploadFile.mockResolvedValue({ url: "https://memex.tlon.network/uploaded.jpg" });

    await uploadImageFromUrl("https://example.com/path/to/my-image.jpg");

    expect(requireUploadParams().fileName).toBe("my-image.jpg");
  });

  it("uses default filename when URL has no path", async () => {
    const mockBlob = new Blob(["fake-image"], { type: "image/png" });
    mockSuccessfulFetch({
      mockFetch,
      blob: mockBlob,
      finalUrl: "https://example.com/",
      contentType: "image/png",
    });

    mockUploadFile.mockResolvedValue({ url: "https://memex.tlon.network/uploaded.png" });

    await uploadImageFromUrl("https://example.com/");

    expect(requireUploadParams().fileName).toMatch(/^upload-\d+\.png$/);
  });
});
