import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import {
  convertHeicToJpeg,
  getImageMetadata,
  hasAlphaChannel,
  ImageProcessorUnavailableError,
  isImageProcessorUnavailableError,
  MAX_IMAGE_INPUT_PIXELS,
  resizeToJpeg,
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
        new Error("Optional dependency sharp is required for image attachment processing"),
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

  const itIfFfmpeg = resolveSystemBin("ffmpeg", { trust: "standard" }) ? it : it.skip;

  itIfFfmpeg("honors enlargement when the ffmpeg fallback is selected", async () => {
    const previousBackend = process.env.OPENCLAW_IMAGE_BACKEND;
    process.env.OPENCLAW_IMAGE_BACKEND = "ffmpeg";
    try {
      const out = await resizeToJpeg({
        buffer: Buffer.from(PNG_1X1_BASE64, "base64"),
        maxSide: 4,
        quality: 90,
        withoutEnlargement: false,
      });

      await expect(getImageMetadata(out)).resolves.toEqual({ width: 4, height: 4 });
    } finally {
      if (previousBackend === undefined) {
        delete process.env.OPENCLAW_IMAGE_BACKEND;
      } else {
        process.env.OPENCLAW_IMAGE_BACKEND = previousBackend;
      }
    }
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
