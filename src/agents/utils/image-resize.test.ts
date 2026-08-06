// Image resize utility tests cover Rastermill probing/encoding decisions,
// base64 byte budgets, and coordinate notes for resized inline images.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  convertImageToPng: vi.fn(),
  encode: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("../../media/image-ops.js", () => ({
  convertImageToPng: mocks.convertImageToPng,
  createImageProcessor: () => ({
    encode: mocks.encode,
    probe: mocks.probe,
  }),
}));

import { processImage } from "./image-resize.js";

describe("image resize utility", () => {
  beforeEach(() => {
    mocks.convertImageToPng.mockReset();
    mocks.encode.mockReset();
    mocks.probe.mockReset();
  });

  it("keeps images that exactly fit the inline limits", async () => {
    const input = "a".repeat(4.5 * 1024 * 1024);
    mocks.probe.mockResolvedValue({
      bytes: Buffer.byteLength(input, "base64"),
      format: "png",
      hasAlpha: false,
      height: 20,
      orientation: null,
      width: 10,
    });

    const result = await processImage(
      { type: "image", data: input, mimeType: "image/png" },
      { autoResizeImages: true },
    );

    expect(result).toStrictEqual({
      ok: true,
      image: { type: "image", data: input, mimeType: "image/png" },
      hints: [],
    });
    expect(mocks.encode).not.toHaveBeenCalled();
  });

  it("uses Rastermill limits, base64 budget, and orientation-aware source dimensions", async () => {
    // EXIF orientation swaps source dimensions before coordinate mapping so UI
    // click coordinates can be translated back to the original image.
    const inputBuffer = Buffer.from("large image");
    const outputBuffer = Buffer.from("jpeg output");
    mocks.probe.mockResolvedValue({
      bytes: inputBuffer.byteLength,
      format: "jpeg",
      hasAlpha: false,
      height: 1200,
      orientation: 6,
      width: 3000,
    });
    mocks.encode.mockResolvedValue({
      base64Bytes: Buffer.byteLength(outputBuffer.toString("base64"), "utf8"),
      bytes: outputBuffer.byteLength,
      chosen: { format: "jpeg", quality: 70 },
      data: outputBuffer,
      format: "jpeg",
      height: 1600,
      metadata: "stripped",
      mimeType: "image/jpeg",
      resized: true,
      width: 640,
      withinBudget: true,
    });

    const result = await processImage(
      { type: "image", data: inputBuffer.toString("base64"), mimeType: "image/jpeg" },
      { autoResizeImages: true },
    );

    expect(mocks.encode).toHaveBeenCalledWith(inputBuffer, {
      format: "auto",
      limits: {
        maxHeight: 2_000,
        maxWidth: 2_000,
      },
      maxBase64Bytes: 4.5 * 1024 * 1024,
      opaque: { format: "jpeg", quality: 80 },
      search: {
        compressionLevel: [6, 9],
        quality: [80, 85, 70, 55, 40, 35],
      },
      transparent: { format: "png" },
    });
    expect(result).toStrictEqual({
      ok: true,
      image: {
        type: "image",
        data: outputBuffer.toString("base64"),
        mimeType: "image/jpeg",
      },
      hints: [
        "[Image: original 1200x3000, displayed at 640x1600. Multiply coordinates by 1.88 to map to original image.]",
      ],
    });
  });

  it("omits images when Rastermill cannot satisfy the base64 budget", async () => {
    const inputBuffer = Buffer.from("too large");
    mocks.probe.mockResolvedValue({
      bytes: inputBuffer.byteLength,
      format: "png",
      hasAlpha: false,
      height: 4000,
      orientation: null,
      width: 4000,
    });
    mocks.encode.mockResolvedValue({
      base64Bytes: 120,
      bytes: 90,
      chosen: { format: "png" },
      data: Buffer.alloc(90),
      format: "png",
      height: 1,
      metadata: "stripped",
      mimeType: "image/png",
      resized: true,
      width: 1,
      withinBudget: false,
    });

    await expect(
      processImage(
        { type: "image", data: inputBuffer.toString("base64"), mimeType: "image/png" },
        { autoResizeImages: true },
      ),
    ).resolves.toStrictEqual({
      ok: false,
      message: "[Image omitted: could not be resized below the inline image size limit.]",
    });
  });

  it("does not add coordinate hints when Rastermill only re-encodes the image", async () => {
    const input = "a".repeat(4.5 * 1024 * 1024 + 1);
    const outputBuffer = Buffer.from("re-encoded");
    mocks.probe.mockResolvedValue({
      bytes: Buffer.byteLength(input, "base64"),
      format: "png",
      hasAlpha: false,
      height: 20,
      orientation: null,
      width: 10,
    });
    mocks.encode.mockResolvedValue({
      base64Bytes: Buffer.byteLength(outputBuffer.toString("base64"), "utf8"),
      bytes: outputBuffer.byteLength,
      chosen: { format: "jpeg", quality: 80 },
      data: outputBuffer,
      format: "jpeg",
      height: 20,
      metadata: "stripped",
      mimeType: "image/jpeg",
      resized: false,
      width: 10,
      withinBudget: true,
    });

    await expect(
      processImage(
        { type: "image", data: input, mimeType: "image/png" },
        { autoResizeImages: true },
      ),
    ).resolves.toStrictEqual({
      ok: true,
      image: {
        type: "image",
        data: outputBuffer.toString("base64"),
        mimeType: "image/jpeg",
      },
      hints: [],
    });
  });
});
