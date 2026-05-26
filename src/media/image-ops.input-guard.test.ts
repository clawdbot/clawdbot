import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGrayscaleAlphaPngBuffer } from "../../test/helpers/image-fixtures.js";
import {
  convertHeicToJpeg,
  getImageMetadata,
  hasAlphaChannel,
  ImageProcessorUnavailableError,
  isImageProcessorUnavailableError,
  MAX_IMAGE_INPUT_PIXELS,
  normalizeExifOrientation,
  resizeToJpeg,
  resizeToPng,
  testing,
} from "./image-ops.js";
import { createPngBufferWithDimensions } from "./test-helpers.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function isoBox(type: string, payload: Buffer): Buffer {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, "ascii");
  payload.copy(box, 8);
  return box;
}

function createHeifLikeBuffer(...sizes: Array<{ width: number; height: number }>): Buffer {
  const ftypPayload = Buffer.alloc(8);
  ftypPayload.write("heic", 0, "ascii");
  const ispeBoxes = sizes.map(({ width, height }) => {
    const ispePayload = Buffer.alloc(12);
    ispePayload.writeUInt32BE(width, 4);
    ispePayload.writeUInt32BE(height, 8);
    return isoBox("ispe", ispePayload);
  });
  const ipco = isoBox("ipco", Buffer.concat(ispeBoxes));
  const iprp = isoBox("iprp", ipco);
  const meta = isoBox("meta", Buffer.concat([Buffer.alloc(4), iprp]));
  return Buffer.concat([isoBox("ftyp", ftypPayload), meta]);
}

function createBmpHeaderBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(26);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  return buffer;
}

function createTiffHeaderBuffer(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(38);
  buffer.write("II", 0, "ascii");
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(8, 4);
  buffer.writeUInt16LE(2, 8);
  buffer.writeUInt16LE(256, 10);
  buffer.writeUInt16LE(4, 12);
  buffer.writeUInt32LE(1, 14);
  buffer.writeUInt32LE(width, 18);
  buffer.writeUInt16LE(257, 22);
  buffer.writeUInt16LE(4, 24);
  buffer.writeUInt32LE(1, 26);
  buffer.writeUInt32LE(height, 30);
  return buffer;
}

describe("image input pixel guard", () => {
  const oversizedPng = createPngBufferWithDimensions({ width: 8_000, height: 4_000 });
  const overflowedPng = createPngBufferWithDimensions({
    width: 4_294_967_295,
    height: 4_294_967_295,
  });

  it("returns null metadata for images above the pixel limit", async () => {
    await expect(getImageMetadata(oversizedPng)).resolves.toBeNull();
    expect(8_000 * 4_000).toBeGreaterThan(MAX_IMAGE_INPUT_PIXELS);
  });

  it("rejects oversized images before resize work starts", async () => {
    await expect(
      resizeToJpeg({
        buffer: oversizedPng,
        maxSide: 2_048,
        quality: 80,
      }),
    ).rejects.toThrow(/pixel input limit/i);
  });

  it("rejects oversized images before EXIF normalization returns unchanged bytes", async () => {
    await expect(normalizeExifOrientation(oversizedPng)).rejects.toThrow(/pixel input limit/i);
  });

  it("rejects unreadable images before EXIF normalization returns unchanged bytes", async () => {
    await expect(normalizeExifOrientation(Buffer.from("not-an-image"))).rejects.toThrow(
      /unable to determine image dimensions/i,
    );
  });

  it("rejects overflowed pixel counts before resize work starts", async () => {
    await expect(
      resizeToJpeg({
        buffer: overflowedPng,
        maxSide: 2_048,
        quality: 80,
      }),
    ).rejects.toThrow(/pixel input limit/i);
  });

  it("reads HEIF-style ISO BMFF dimensions without loading an image processor", async () => {
    await expect(
      getImageMetadata(createHeifLikeBuffer({ width: 640, height: 480 })),
    ).resolves.toEqual({
      width: 640,
      height: 480,
    });
  });

  it("reads BMP and TIFF dimensions before selecting an image backend", async () => {
    await expect(getImageMetadata(createBmpHeaderBuffer(640, 480))).resolves.toEqual({
      width: 640,
      height: 480,
    });
    await expect(getImageMetadata(createTiffHeaderBuffer(320, 240))).resolves.toEqual({
      width: 320,
      height: 240,
    });
  });

  it("rejects oversized HEIF-style ISO BMFF images before fallback tools run", async () => {
    const oversizedHeif = createHeifLikeBuffer(
      { width: 64, height: 64 },
      { width: 8_000, height: 4_000 },
    );
    await expect(getImageMetadata(oversizedHeif)).resolves.toBeNull();
    await expect(
      resizeToJpeg({
        buffer: oversizedHeif,
        maxSide: 2_048,
        quality: 80,
      }),
    ).rejects.toThrow(/pixel input limit/i);
  });

  it("fails closed when sips cannot determine image dimensions", async () => {
    const previousBackend = process.env.OPENCLAW_IMAGE_BACKEND;
    process.env.OPENCLAW_IMAGE_BACKEND = "sips";
    try {
      await expect(
        resizeToJpeg({
          buffer: Buffer.from("not-an-image"),
          maxSide: 2_048,
          quality: 80,
        }),
      ).rejects.toThrow(/unable to determine image dimensions/i);
    } finally {
      if (previousBackend === undefined) {
        delete process.env.OPENCLAW_IMAGE_BACKEND;
      } else {
        process.env.OPENCLAW_IMAGE_BACKEND = previousBackend;
      }
    }
  });

  it("classifies image processor availability errors centrally", () => {
    expect(
      isImageProcessorUnavailableError(new ImageProcessorUnavailableError("resizeToJpeg")),
    ).toBe(true);
    expect(
      isImageProcessorUnavailableError(
        new Error("Photon did not expose the required image processor API"),
      ),
    ).toBe(true);
  });

  it("detects PNG alpha from headers without loading an image processor", async () => {
    const alphaPng = createPngBufferWithDimensions({ width: 1, height: 1 });
    const opaquePng = Buffer.from(alphaPng);
    opaquePng[25] = 2;

    await expect(hasAlphaChannel(alphaPng)).resolves.toBe(true);
    await expect(hasAlphaChannel(opaquePng)).resolves.toBe(false);
  });

  it("returns opaque when header-unknown alpha cannot be decoded", async () => {
    await expect(hasAlphaChannel(createHeifLikeBuffer({ width: 1, height: 1 }))).resolves.toBe(
      false,
    );
  });

  it("rejects oversized alpha checks before returning a safe default", async () => {
    await expect(hasAlphaChannel(oversizedPng)).rejects.toThrow(/pixel input limit/i);
  });

  it("resizes grayscale alpha PNGs through the Photon backend", async () => {
    const source = createGrayscaleAlphaPngBuffer(64, 32);

    await expect(hasAlphaChannel(source)).resolves.toBe(true);
    const jpeg = await resizeToJpeg({
      buffer: source,
      maxSide: 16,
      quality: 80,
      withoutEnlargement: true,
    });

    await expect(getImageMetadata(jpeg)).resolves.toEqual({ width: 16, height: 8 });
  });

  it("honors PNG compression levels in the Photon backend", async () => {
    const source = createGrayscaleAlphaPngBuffer(128, 128);
    const uncompressed = await resizeToPng({
      buffer: source,
      maxSide: 128,
      compressionLevel: 0,
      withoutEnlargement: true,
    });
    const compressed = await resizeToPng({
      buffer: source,
      maxSide: 128,
      compressionLevel: 9,
      withoutEnlargement: true,
    });

    expect(compressed.length).toBeLessThan(uncompressed.length);
    await expect(getImageMetadata(compressed)).resolves.toEqual({ width: 128, height: 128 });
  });

  it("allows enlargement when building the ffmpeg resize filter", () => {
    expect(testing.buildFfmpegResizeFilter(4, false)).toBe(
      "scale=w=4:h=4:force_original_aspect_ratio=decrease",
    );
    expect(testing.buildFfmpegResizeFilter(4, true)).toBe(
      "scale=w='min(4,iw)':h='min(4,ih)':force_original_aspect_ratio=decrease",
    );
  });

  const itIfMac = process.platform === "darwin" ? it : it.skip;

  itIfMac("converts macOS-generated HEIC images to JPEG", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heic-convert-"));
    try {
      const pngPath = path.join(tempDir, "input.png");
      const heicPath = path.join(tempDir, "input.heic");
      await fs.writeFile(pngPath, Buffer.from(PNG_1X1_BASE64, "base64"));
      const result = spawnSync(
        "/usr/bin/sips",
        ["-s", "format", "heic", pngPath, "--out", heicPath],
        {
          encoding: "utf8",
        },
      );
      if (result.status !== 0) {
        console.warn(`Skipping HEIC conversion fixture: ${result.stderr || result.stdout}`);
        return;
      }

      const jpeg = await convertHeicToJpeg(await fs.readFile(heicPath));

      expect(jpeg[0]).toBe(0xff);
      expect(jpeg[1]).toBe(0xd8);
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });
});
