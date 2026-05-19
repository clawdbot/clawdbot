import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { normalizeBrowserScreenshot } from "./screenshot.js";

describe("browser screenshot normalization", () => {
  const unavailableImageBackend = process.platform === "win32" ? "sips" : "windows-native";

  async function withUnavailableImageBackend<T>(fn: () => Promise<T>): Promise<T> {
    const previousBackend = process.env.OPENCLAW_IMAGE_BACKEND;
    process.env.OPENCLAW_IMAGE_BACKEND = unavailableImageBackend;
    try {
      return await fn();
    } finally {
      if (previousBackend === undefined) {
        delete process.env.OPENCLAW_IMAGE_BACKEND;
      } else {
        process.env.OPENCLAW_IMAGE_BACKEND = previousBackend;
      }
    }
  }

  it("shrinks oversized images to <=2000x2000 and <=5MB", async () => {
    const bigPng = await sharp({
      create: {
        width: 2100,
        height: 2100,
        channels: 3,
        background: { r: 12, g: 34, b: 56 },
      },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const normalized = await normalizeBrowserScreenshot(bigPng, {
      maxSide: 2000,
      maxBytes: 5 * 1024 * 1024,
    });

    expect(normalized.buffer.byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
    const meta = await sharp(normalized.buffer).metadata();
    expect(meta.width).toBeLessThanOrEqual(2000);
    expect(meta.height).toBeLessThanOrEqual(2000);
    expect(normalized.buffer[0]).toBe(0xff);
    expect(normalized.buffer[1]).toBe(0xd8);
  }, 120_000);

  it("keeps already-small screenshots unchanged", async () => {
    const jpeg = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    const normalized = await normalizeBrowserScreenshot(jpeg, {
      maxSide: 2000,
      maxBytes: 5 * 1024 * 1024,
    });

    expect(normalized.buffer.equals(jpeg)).toBe(true);
  });

  it("rejects screenshots above max side when no image processor is available", async () => {
    const png = await sharp({
      create: {
        width: 420,
        height: 120,
        channels: 3,
        background: { r: 12, g: 34, b: 56 },
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(png.byteLength).toBeLessThan(5 * 1024 * 1024);

    await withUnavailableImageBackend(async () => {
      await expect(
        normalizeBrowserScreenshot(png, {
          maxSide: 120,
          maxBytes: 5 * 1024 * 1024,
        }),
      ).rejects.toThrow(/image processor unavailable/i);
    });
  });
});
