import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  encode: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("../../media/image-ops.js", () => ({
  createImageProcessor: () => ({
    encode: mocks.encode,
    probe: mocks.probe,
  }),
  isImageProcessorUnavailableError: (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "IMAGE_PROCESSOR_UNAVAILABLE",
}));

import { formatDimensionNote, resizeImage } from "./image-resize.js";

describe("image resize utility", () => {
  beforeEach(() => {
    mocks.encode.mockReset();
    mocks.probe.mockReset();
  });

  it("keeps images that already fit the inline limits", async () => {
    const input = Buffer.from("small image").toString("base64");
    mocks.probe.mockResolvedValue({
      bytes: 11,
      format: "png",
      hasAlpha: false,
      height: 20,
      orientation: null,
      width: 10,
    });

    const resized = await resizeImage(
      { type: "image", data: input, mimeType: "image/png" },
      { maxWidth: 100, maxHeight: 100, maxBytes: 1_000 },
    );

    expect(resized).toMatchObject({
      data: input,
      height: 20,
      mimeType: "image/png",
      originalHeight: 20,
      originalWidth: 10,
      wasResized: false,
      width: 10,
    });
    expect(mocks.encode).not.toHaveBeenCalled();
  });

  it("uses Rastermill limits, base64 budget, and orientation-aware source dimensions", async () => {
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

    const resized = await resizeImage(
      { type: "image", data: inputBuffer.toString("base64"), mimeType: "image/jpeg" },
      { maxWidth: 2_000, maxHeight: 2_000, maxBytes: 4_000, jpegQuality: 70 },
    );

    expect(mocks.encode).toHaveBeenCalledWith(inputBuffer, {
      format: "auto",
      limits: {
        maxHeight: 2_000,
        maxWidth: 2_000,
      },
      maxBytes: 3_000,
      opaque: { format: "jpeg", quality: 70 },
      search: {
        compressionLevel: [6, 9],
        quality: [70, 85, 55, 40, 35],
      },
      transparent: { format: "png" },
    });
    expect(resized).toMatchObject({
      data: outputBuffer.toString("base64"),
      height: 1600,
      mimeType: "image/jpeg",
      originalHeight: 3000,
      originalWidth: 1200,
      wasResized: true,
      width: 640,
    });
    expect(formatDimensionNote(resized!)).toBe(
      "[Image: original 1200x3000, displayed at 640x1600. Multiply coordinates by 1.88 to map to original image.]",
    );
  });

  it("returns null when Rastermill cannot satisfy the base64 budget", async () => {
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
      resizeImage(
        { type: "image", data: inputBuffer.toString("base64"), mimeType: "image/png" },
        { maxWidth: 100, maxHeight: 100, maxBytes: 50 },
      ),
    ).resolves.toBeNull();
  });
});
