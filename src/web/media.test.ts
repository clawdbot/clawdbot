import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { optimizeImageToPng } from "../media/image-ops.js";
import { loadWebMedia, optimizeImageToJpeg } from "./media.js";

const tmpFiles: string[] = [];

async function writeTempFile(buffer: Buffer, ext: string): Promise<string> {
  const file = path.join(
    os.tmpdir(),
    `moltbot-media-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`,
  );
  tmpFiles.push(file);
  await fs.writeFile(file, buffer);
  return file;
}

function buildDeterministicBytes(length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let seed = 0x12345678;
  for (let i = 0; i < length; i++) {
    seed = (1103515245 * seed + 12345) & 0x7fffffff;
    buffer[i] = seed & 0xff;
  }
  return buffer;
}

afterEach(async () => {
  await Promise.all(tmpFiles.map((file) => fs.rm(file, { force: true })));
  tmpFiles.length = 0;
});

describe("web media loading", () => {
  it("compresses large local images under the provided cap", async () => {
    const buffer = await sharp({
      create: {
        width: 1600,
        height: 1600,
        channels: 3,
        background: "#ff0000",
      },
    })
      .jpeg({ quality: 95 })
      .toBuffer();

    const file = await writeTempFile(buffer, ".jpg");

    const cap = Math.floor(buffer.length * 0.8);
    const result = await loadWebMedia(file, cap);

    expect(result.kind).toBe("image");
    expect(result.buffer.length).toBeLessThanOrEqual(cap);
    expect(result.buffer.length).toBeLessThan(buffer.length);
  });

  it("sniffs mime before extension when loading local files", async () => {
    const pngBuffer = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#00ff00" },
    })
      .png()
      .toBuffer();
    const wrongExt = await writeTempFile(pngBuffer, ".bin");

    const result = await loadWebMedia(wrongExt, 1024 * 1024);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/jpeg");
  });

  it("adds extension to URL fileName when missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: true,
      arrayBuffer: async () => Buffer.from("%PDF-1.4").buffer,
      headers: { get: () => "application/pdf" },
      status: 200,
    } as Response);

    const result = await loadWebMedia("https://example.com/download", 1024 * 1024);

    expect(result.kind).toBe("document");
    expect(result.contentType).toBe("application/pdf");
    expect(result.fileName).toBe("download.pdf");

    fetchMock.mockRestore();
  });

  it("includes URL + status in fetch errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      body: true,
      text: async () => "Not Found",
      headers: { get: () => null },
      status: 404,
      statusText: "Not Found",
      url: "https://example.com/missing.jpg",
    } as Response);

    await expect(loadWebMedia("https://example.com/missing.jpg", 1024 * 1024)).rejects.toThrow(
      /Failed to fetch media from https:\/\/example\.com\/missing\.jpg.*HTTP 404/i,
    );

    fetchMock.mockRestore();
  });

  it("uses content-disposition filename when available", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: true,
      arrayBuffer: async () => Buffer.from("%PDF-1.4").buffer,
      headers: {
        get: (name: string) => {
          if (name === "content-disposition") {
            return 'attachment; filename="report.pdf"';
          }
          if (name === "content-type") return "application/pdf";
          return null;
        },
      },
      status: 200,
    } as Response);

    const result = await loadWebMedia("https://example.com/download?id=1", 1024 * 1024);

    expect(result.kind).toBe("document");
    expect(result.fileName).toBe("report.pdf");

    fetchMock.mockRestore();
  });

  it("preserves GIF animation by skipping JPEG optimization", async () => {
    // Create a minimal valid GIF (1x1 pixel)
    // GIF89a header + minimal image data
    const gifBuffer = Buffer.from([
      0x47,
      0x49,
      0x46,
      0x38,
      0x39,
      0x61, // GIF89a
      0x01,
      0x00,
      0x01,
      0x00, // 1x1 dimensions
      0x00,
      0x00,
      0x00, // no global color table
      0x2c,
      0x00,
      0x00,
      0x00,
      0x00, // image descriptor
      0x01,
      0x00,
      0x01,
      0x00,
      0x00, // 1x1 image
      0x02,
      0x01,
      0x44,
      0x00,
      0x3b, // minimal LZW data + trailer
    ]);

    const file = await writeTempFile(gifBuffer, ".gif");

    const result = await loadWebMedia(file, 1024 * 1024);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/gif");
    // GIF should NOT be converted to JPEG
    expect(result.buffer.slice(0, 3).toString()).toBe("GIF");
  });

  it("preserves GIF from URL without JPEG conversion", async () => {
    const gifBytes = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x01, 0x44, 0x00, 0x3b,
    ]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      body: true,
      arrayBuffer: async () =>
        gifBytes.buffer.slice(gifBytes.byteOffset, gifBytes.byteOffset + gifBytes.byteLength),
      headers: { get: () => "image/gif" },
      status: 200,
    } as Response);

    const result = await loadWebMedia("https://example.com/animation.gif", 1024 * 1024);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/gif");
    expect(result.buffer.slice(0, 3).toString()).toBe("GIF");

    fetchMock.mockRestore();
  });

  it("preserves PNG alpha when under the cap", async () => {
    const buffer = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();

    const file = await writeTempFile(buffer, ".png");

    const result = await loadWebMedia(file, 1024 * 1024);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/png");
    const meta = await sharp(result.buffer).metadata();
    expect(meta.hasAlpha).toBe(true);
  });

  it("falls back to JPEG when PNG alpha cannot fit under cap", async () => {
    const sizes = [512, 768, 1024];
    let pngBuffer: Buffer | null = null;
    let smallestPng: Awaited<ReturnType<typeof optimizeImageToPng>> | null = null;
    let jpegOptimized: Awaited<ReturnType<typeof optimizeImageToJpeg>> | null = null;
    let cap = 0;

    for (const size of sizes) {
      const raw = buildDeterministicBytes(size * size * 4);
      pngBuffer = await sharp(raw, { raw: { width: size, height: size, channels: 4 } })
        .png()
        .toBuffer();
      smallestPng = await optimizeImageToPng(pngBuffer, 1);
      cap = Math.max(1, smallestPng.optimizedSize - 1);
      jpegOptimized = await optimizeImageToJpeg(pngBuffer, cap);
      if (jpegOptimized.buffer.length < smallestPng.optimizedSize) {
        break;
      }
    }

    if (!pngBuffer || !smallestPng || !jpegOptimized) {
      throw new Error("PNG fallback setup failed");
    }

    if (jpegOptimized.buffer.length >= smallestPng.optimizedSize) {
      throw new Error(
        `JPEG fallback did not shrink below PNG (jpeg=${jpegOptimized.buffer.length}, png=${smallestPng.optimizedSize})`,
      );
    }

    const file = await writeTempFile(pngBuffer, ".png");

    const result = await loadWebMedia(file, cap);

    expect(result.kind).toBe("image");
    expect(result.contentType).toBe("image/jpeg");
    expect(result.buffer.length).toBeLessThanOrEqual(cap);
  });
});
