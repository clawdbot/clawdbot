import { beforeEach, describe, expect, it, vi } from "vitest";

const { convertImageToJpegMock, convertImageToPngMock, detectMimeMock } = vi.hoisted(() => ({
  convertImageToJpegMock: vi.fn(),
  convertImageToPngMock: vi.fn(),
  detectMimeMock: vi.fn(),
}));

vi.mock("@openclaw/media-core/mime", () => ({
  detectMime: detectMimeMock,
  normalizeMimeType: (value?: string | null) => value?.split(";", 1)[0]?.trim().toLowerCase(),
}));

vi.mock("./image-ops.js", () => ({
  convertImageToJpeg: convertImageToJpegMock,
  convertImageToPng: convertImageToPngMock,
}));

import { normalizeAnthropicInlineContentBlocks } from "./anthropic-inline-images.js";

describe("normalizeAnthropicInlineContentBlocks", () => {
  beforeEach(() => {
    convertImageToJpegMock.mockReset();
    convertImageToJpegMock.mockResolvedValue(Buffer.from("converted-jpeg"));
    convertImageToPngMock.mockReset();
    convertImageToPngMock.mockResolvedValue(Buffer.from("converted-png"));
    detectMimeMock.mockReset();
  });

  it("converts detected unsupported bytes despite a supported declaration", async () => {
    detectMimeMock.mockResolvedValue("image/tiff");
    const tiffData = Buffer.from("tiff-bytes").toString("base64");

    await expect(
      normalizeAnthropicInlineContentBlocks([
        { type: "image", data: tiffData, mimeType: "image/jpeg" },
      ]),
    ).resolves.toEqual([
      {
        type: "image",
        data: Buffer.from("converted-jpeg").toString("base64"),
        mimeType: "image/jpeg",
      },
    ]);
    expect(convertImageToJpegMock).toHaveBeenCalledOnce();
  });

  it("uses a supported declaration when byte detection is inconclusive", async () => {
    detectMimeMock.mockResolvedValue(undefined);
    const opaqueData = Buffer.from("not-a-recognized-image-header").toString("base64");

    await expect(
      normalizeAnthropicInlineContentBlocks([
        { type: "image", data: opaqueData, mimeType: "image/png" },
      ]),
    ).resolves.toEqual([{ type: "image", data: opaqueData, mimeType: "image/png" }]);
    expect(convertImageToJpegMock).not.toHaveBeenCalled();
  });

  it("rejects oversized image data before MIME detection or decoding", async () => {
    const maxBytes = 10 * 1024 * 1024;
    const encodedLength = Math.ceil(((maxBytes + 1) * 4) / 3);

    await expect(
      normalizeAnthropicInlineContentBlocks([
        { type: "image", data: "A".repeat(encodedLength), mimeType: "image/tiff" },
      ]),
    ).rejects.toThrow("10 MB decoded safety limit");
    expect(detectMimeMock).not.toHaveBeenCalled();
    expect(convertImageToJpegMock).not.toHaveBeenCalled();
  });

  it("routes detected BMP bytes through the fallback-capable PNG converter", async () => {
    detectMimeMock.mockResolvedValue("image/bmp");
    const bmpData = Buffer.from("bmp-bytes").toString("base64");

    await expect(
      normalizeAnthropicInlineContentBlocks([
        { type: "image", data: bmpData, mimeType: "image/bmp" },
      ]),
    ).resolves.toEqual([
      {
        type: "image",
        data: Buffer.from("converted-png").toString("base64"),
        mimeType: "image/png",
      },
    ]);
    expect(convertImageToPngMock).toHaveBeenCalledOnce();
    expect(convertImageToJpegMock).not.toHaveBeenCalled();
  });

  it("rejects converted images that exceed the outgoing size limit", async () => {
    detectMimeMock.mockResolvedValue("image/tiff");
    convertImageToJpegMock.mockResolvedValue(Buffer.alloc(10 * 1024 * 1024 + 1));

    await expect(
      normalizeAnthropicInlineContentBlocks([
        {
          type: "image",
          data: Buffer.from("small-tiff").toString("base64"),
          mimeType: "image/tiff",
        },
      ]),
    ).rejects.toThrow("Normalized Anthropic inline image exceeds the 10 MB decoded safety limit");
  });
});
