import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  fetchMedia: vi.fn(),
}));

vi.mock("../adapter/index.js", () => ({
  getPlatformAdapter: () => ({
    fetchMedia: (...args: unknown[]) => adapterMocks.fetchMedia(...args),
  }),
}));

import { getImageSizeFromUrl, parseImageSize } from "./image-size.js";

/** Build a minimal valid PNG header with the given dimensions. */
function buildPngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  // PNG signature
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  buf[4] = 0x0d;
  buf[5] = 0x0a;
  buf[6] = 0x1a;
  buf[7] = 0x0a;
  // IHDR chunk length
  buf.writeUInt32BE(13, 8);
  // "IHDR"
  buf.write("IHDR", 12, "ascii");
  // Width and height
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe("getImageSizeFromUrl", () => {
  beforeEach(() => {
    adapterMocks.fetchMedia.mockReset();
  });

  describe("fetchMedia options contract", () => {
    it("passes maxBytes, maxRedirects, ssrfPolicy, and headers", async () => {
      adapterMocks.fetchMedia.mockResolvedValueOnce({
        buffer: buildPngHeader(800, 600),
        contentType: "image/png",
      });

      await getImageSizeFromUrl("https://cdn.example.com/photo.png");

      expect(adapterMocks.fetchMedia).toHaveBeenCalledOnce();
      const opts = adapterMocks.fetchMedia.mock.calls.at(0)?.[0];

      expect(opts.url).toBe("https://cdn.example.com/photo.png");
      expect(opts.maxBytes).toBe(65_536);
      expect(opts.maxRedirects).toBe(0);
      // Generic public-network-only policy: no hostname allowlist
      expect(opts.ssrfPolicy).toStrictEqual({});
      expect(opts.requestInit.headers).toEqual({
        Range: "bytes=0-65535",
        "User-Agent": "QQBot-Image-Size-Detector/1.0",
      });
    });

    it("threads caller abort signal through requestInit", async () => {
      adapterMocks.fetchMedia.mockResolvedValueOnce({
        buffer: buildPngHeader(100, 100),
      });

      await getImageSizeFromUrl("https://cdn.example.com/img.png", 3000);

      const opts = adapterMocks.fetchMedia.mock.calls.at(0)?.[0];
      expect(opts.requestInit.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("SSRF blocking (adapter.fetchMedia rejects)", () => {
    it("returns null when adapter.fetchMedia throws for loopback", async () => {
      adapterMocks.fetchMedia.mockRejectedValueOnce(new Error("SSRF blocked: loopback address"));

      const result = await getImageSizeFromUrl("https://127.0.0.1/img.png");

      expect(result).toBeNull();
    });

    it("returns null when adapter.fetchMedia throws for IPv6 loopback", async () => {
      adapterMocks.fetchMedia.mockRejectedValueOnce(new Error("SSRF blocked: loopback address"));

      const result = await getImageSizeFromUrl("https://[::1]/img.png");

      expect(result).toBeNull();
    });

    it("returns null when adapter.fetchMedia throws for link-local/metadata", async () => {
      adapterMocks.fetchMedia.mockRejectedValueOnce(new Error("SSRF blocked: link-local address"));

      const result = await getImageSizeFromUrl("https://169.254.169.254/latest/meta-data/");

      expect(result).toBeNull();
    });

    it("returns null when adapter.fetchMedia throws for RFC1918 addresses", async () => {
      adapterMocks.fetchMedia.mockRejectedValueOnce(new Error("SSRF blocked: private address"));

      const result = await getImageSizeFromUrl("https://10.0.0.1/img.png");

      expect(result).toBeNull();
    });

    it("returns null on http error from adapter.fetchMedia", async () => {
      adapterMocks.fetchMedia.mockRejectedValueOnce(new Error("HTTP 403 Forbidden"));

      const result = await getImageSizeFromUrl("https://cdn.example.com/forbidden.png");

      expect(result).toBeNull();
    });
  });

  describe("happy path", () => {
    it("returns parsed dimensions for a valid PNG", async () => {
      adapterMocks.fetchMedia.mockResolvedValueOnce({
        buffer: buildPngHeader(1920, 1080),
        contentType: "image/png",
      });

      const size = await getImageSizeFromUrl("https://cdn.example.com/banner.png");

      expect(size).toEqual({ width: 1920, height: 1080 });
    });

    it("returns null when the buffer is not a recognized image format", async () => {
      adapterMocks.fetchMedia.mockResolvedValueOnce({
        buffer: Buffer.from("not an image"),
        contentType: "text/html",
      });

      const size = await getImageSizeFromUrl("https://cdn.example.com/notimage.html");

      expect(size).toBeNull();
    });
  });
});

describe("parseImageSize", () => {
  it("parses PNG dimensions", () => {
    const size = parseImageSize(buildPngHeader(640, 480));
    expect(size).toEqual({ width: 640, height: 480 });
  });

  it("returns null for unrecognized data", () => {
    expect(parseImageSize(Buffer.from("hello"))).toBeNull();
  });

  it("returns null for empty buffer", () => {
    expect(parseImageSize(Buffer.alloc(0))).toBeNull();
  });
});
