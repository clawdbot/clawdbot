import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  convertHeicToJpeg,
  getImageMetadata,
  MAX_IMAGE_INPUT_PIXELS,
  resizeToJpeg,
} from "./image-ops.js";
import { createPngBufferWithDimensions } from "./test-helpers.js";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP8z8BQDwAFgwJ/lH3vWQAAAABJRU5ErkJggg==";

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
      expect(result.status, result.stderr || result.stdout).toBe(0);

      const jpeg = await convertHeicToJpeg(await fs.readFile(heicPath));

      expect(jpeg[0]).toBe(0xff);
      expect(jpeg[1]).toBe(0xd8);
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });
});
