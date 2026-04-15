import { MAX_IMAGE_BYTES } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/media-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    ...actual,
    fetchRemoteMedia: vi.fn(),
    saveMediaBuffer: vi.fn(),
  };
});

describe("tlon monitor media", () => {
  async function loadMediaModule() {
    const mediaRuntime = await import("openclaw/plugin-sdk/media-runtime");
    const mediaModule = await import("./media.js");
    return {
      fetchRemoteMedia: vi.mocked(mediaRuntime.fetchRemoteMedia),
      saveMediaBuffer: vi.mocked(mediaRuntime.saveMediaBuffer),
      ...mediaModule,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps extracted images at eight per message", async () => {
    const { extractImageBlocks } = await loadMediaModule();
    const content = Array.from({ length: 10 }, (_, index) => ({
      block: { image: { src: `https://example.com/${index}.png`, alt: `image-${index}` } },
    }));

    const images = extractImageBlocks(content);

    expect(images).toHaveLength(8);
    expect(images.map((image) => image.url)).toEqual(
      Array.from({ length: 8 }, (_, index) => `https://example.com/${index}.png`),
    );
  });

  it("stores fetched media through the shared inbound media store with the image cap", async () => {
    const { downloadMedia, fetchRemoteMedia, saveMediaBuffer } = await loadMediaModule();

    fetchRemoteMedia.mockResolvedValue({
      buffer: Buffer.from("image-data"),
      contentType: "image/png",
      fileName: "photo.png",
    });
    saveMediaBuffer.mockResolvedValue({
      id: "photo---uuid.png",
      path: "/tmp/openclaw/media/inbound/photo---uuid.png",
      size: "image-data".length,
      contentType: "image/png",
    });

    const result = await downloadMedia("https://example.com/photo.png");

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/photo.png",
        maxBytes: MAX_IMAGE_BYTES,
        readIdleTimeoutMs: 30_000,
        requestInit: { method: "GET" },
      }),
    );
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("image-data"),
      "image/png",
      "inbound",
      MAX_IMAGE_BYTES,
      "photo.png",
    );
    expect(result).toEqual({
      localPath: "/tmp/openclaw/media/inbound/photo---uuid.png",
      contentType: "image/png",
      originalUrl: "https://example.com/photo.png",
    });
  });

  it("returns null when the fetch exceeds the image cap", async () => {
    const { downloadMedia, fetchRemoteMedia, saveMediaBuffer } = await loadMediaModule();

    fetchRemoteMedia.mockRejectedValue(
      new Error(
        `Failed to fetch media from https://example.com/photo.png: payload exceeds maxBytes ${MAX_IMAGE_BYTES}`,
      ),
    );

    const result = await downloadMedia("https://example.com/photo.png");

    expect(result).toBeNull();
    expect(saveMediaBuffer).not.toHaveBeenCalled();
  });
});
