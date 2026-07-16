// Tlon tests cover media plugin behavior.
import {
  readRemoteMediaBuffer,
  MAX_IMAGE_BYTES,
  saveRemoteMedia,
} from "openclaw/plugin-sdk/media-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadMessageImages } from "./media.js";

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  MAX_IMAGE_BYTES: 6 * 1024 * 1024,
  readRemoteMediaBuffer: vi.fn(),
  saveRemoteMedia: vi.fn(),
}));

const readRemoteMediaBufferMock = vi.mocked(readRemoteMediaBuffer);
const saveRemoteMediaMock = vi.mocked(saveRemoteMedia);

describe("tlon monitor media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps downloaded images at eight per message", async () => {
    const content = Array.from({ length: 10 }, (_, index) => ({
      block: { image: { src: `https://example.com/${index}.png`, alt: `image-${index}` } },
    }));
    saveRemoteMediaMock.mockImplementation(async ({ url }) => ({
      id: `photo-${url}.png`,
      path: `/tmp/openclaw/media/inbound/${url.split("/").pop()}`,
      size: 10,
      contentType: "image/png",
    }));

    const images = await downloadMessageImages(content);

    expect(images).toHaveLength(8);
    expect(saveRemoteMediaMock.mock.calls.map(([options]) => options.url)).toEqual(
      Array.from({ length: 8 }, (_, index) => `https://example.com/${index}.png`),
    );
  });

  it("stores fetched media through the shared inbound media store with the image cap", async () => {
    saveRemoteMediaMock.mockResolvedValue({
      id: "photo---uuid.png",
      path: "/tmp/openclaw/media/inbound/photo---uuid.png",
      size: "image-data".length,
      contentType: "image/png",
    });

    const result = await downloadMessageImages([
      { block: { image: { src: "https://example.com/photo.png" } } },
    ]);

    expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
    expect(saveRemoteMediaMock).toHaveBeenCalledTimes(1);
    expect(saveRemoteMediaMock).toHaveBeenCalledWith({
      url: "https://example.com/photo.png",
      maxBytes: MAX_IMAGE_BYTES,
      responseHeaderTimeoutMs: 120_000,
      readIdleTimeoutMs: 30_000,
      ssrfPolicy: undefined,
      requestInit: { method: "GET" },
    });
    expect(result).toEqual([
      { path: "/tmp/openclaw/media/inbound/photo---uuid.png", contentType: "image/png" },
    ]);
  });

  it("returns null when the fetch exceeds the image cap", async () => {
    saveRemoteMediaMock.mockRejectedValue(
      new Error(
        `Failed to fetch media from https://example.com/photo.png: payload exceeds maxBytes ${MAX_IMAGE_BYTES}`,
      ),
    );

    const result = await downloadMessageImages([
      { block: { image: { src: "https://example.com/photo.png" } } },
    ]);

    expect(result).toEqual([]);
    expect(readRemoteMediaBufferMock).not.toHaveBeenCalled();
  });
});
