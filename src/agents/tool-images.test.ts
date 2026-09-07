// Tool image tests cover image payload sanitization before tool outputs are
// returned to model-visible content blocks.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createNoisyPngBuffer,
  createSolidPngBuffer,
  createTinyJpegBuffer,
} from "../../test/helpers/image-fixtures.js";
import { getImageMetadata } from "../media/image-ops.js";
import {
  sanitizeContentBlocksImages,
  sanitizeImageBlocks,
  sanitizeToolResultImages,
} from "./tool-images.js";

describe("tool image sanitizing", () => {
  const getImageBlock = (
    blocks: Awaited<ReturnType<typeof sanitizeContentBlocksImages>>,
  ): (typeof blocks)[number] & { type: "image"; data: string; mimeType?: string } => {
    const image = blocks.find((block) => block.type === "image");
    if (!image || image.type !== "image") {
      throw new Error("expected image block");
    }
    return image;
  };

  const createWidePng = async () => {
    return createSolidPngBuffer(420, 120, { r: 0x7f, g: 0x7f, b: 0x7f });
  };

  it("shrinks oversized images to the configured byte limit", async () => {
    const maxBytes = 64 * 1024;
    const width = 300;
    const height = 300;
    const bigPng = createNoisyPngBuffer(width, height);
    expect(bigPng.byteLength).toBeGreaterThan(maxBytes);

    const blocks = [
      {
        type: "image" as const,
        data: bigPng.toString("base64"),
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test", { maxBytes });
    const image = getImageBlock(out);
    const size = Buffer.from(image.data, "base64").byteLength;
    expect(size).toBeLessThanOrEqual(maxBytes);
    expect(image.mimeType).toBe("image/jpeg");
  }, 20_000);

  it("sanitizes image arrays and reports drops", async () => {
    const png = await createWidePng();

    const images = [
      { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
    ];
    const { images: out, dropped } = await sanitizeImageBlocks(images, "test", {
      maxDimensionPx: 120,
    });
    expect(dropped).toBe(0);
    expect(out.length).toBe(1);
    const meta = await getImageMetadata(
      Buffer.from(expectDefined(out[0], "out[0] test invariant").data, "base64"),
    );
    expect(meta?.width).toBeLessThanOrEqual(120);
    expect(meta?.height).toBeLessThanOrEqual(120);
  }, 20_000);

  it("shrinks images that exceed max dimension even if size is small", async () => {
    const png = await createWidePng();

    const blocks = [
      {
        type: "image" as const,
        data: png.toString("base64"),
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test", { maxDimensionPx: 120 });
    const image = getImageBlock(out);
    const meta = await getImageMetadata(Buffer.from(image.data, "base64"));
    expect(meta?.width).toBeLessThanOrEqual(120);
    expect(meta?.height).toBeLessThanOrEqual(120);
    expect(image.mimeType).toBe("image/jpeg");
  }, 20_000);

  it("corrects mismatched jpeg mimeType", async () => {
    const jpeg = createTinyJpegBuffer();

    const blocks = [
      {
        type: "image" as const,
        data: jpeg.toString("base64"),
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    const image = getImageBlock(out);
    expect(image.mimeType).toBe("image/jpeg");
  });

  it("uses default image limits for non-finite options", async () => {
    const jpeg = createTinyJpegBuffer();

    const out = await sanitizeContentBlocksImages(
      [
        {
          type: "image" as const,
          data: jpeg.toString("base64"),
          mimeType: "image/jpeg",
        },
      ],
      "test",
      { maxDimensionPx: Number.NaN, maxBytes: Number.NaN },
    );

    const image = getImageBlock(out);
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.data).toBe(jpeg.toString("base64"));
  });

  it("preserves data and mimeType on no-resize path", async () => {
    const png = createSolidPngBuffer(10, 10, { r: 0, g: 0, b: 255 });
    const base64 = png.toString("base64");

    const blocks = [{ type: "image" as const, data: base64, mimeType: "image/png" }];
    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toHaveLength(1);
    const image = getImageBlock(out);
    expect(typeof image.data).toBe("string");
    expect(image.data.length).toBeGreaterThan(0);
    expect(typeof image.mimeType).toBe("string");
    expect(image.mimeType).toBe("image/png");
  });

  it("preserves data and mimeType on resize path", async () => {
    const png = createSolidPngBuffer(2600, 400, { r: 255, g: 0, b: 0 });
    const base64 = png.toString("base64");

    const blocks = [{ type: "image" as const, data: base64, mimeType: "image/png" }];
    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toHaveLength(1);
    const image = getImageBlock(out);
    expect(typeof image.data).toBe("string");
    expect(image.data.length).toBeGreaterThan(0);
    expect(typeof image.mimeType).toBe("string");
  }, 20_000);

  it("converts image blocks with missing data/mimeType to text", async () => {
    const blocks = [
      {
        type: "image" as const,
        data: undefined as unknown as string,
        mimeType: undefined as unknown as string,
      },
    ];
    const out = await sanitizeContentBlocksImages(blocks, "browser:screenshot");
    expect(out).toHaveLength(1);
    expect(expectDefined(out[0], "out[0] test invariant").type).toBe("text");
    expect((out[0] as { type: "text"; text: string }).text).toContain("missing data or mimeType");
  });

  it("screenshot-shaped tool result round-trips with valid image block", async () => {
    const png = createSolidPngBuffer(100, 100, { r: 0, g: 128, b: 0 });
    const base64 = png.toString("base64");

    const result = {
      content: [{ type: "image" as const, data: base64, mimeType: "image/png" }],
      details: { path: "/tmp/screenshot.png" },
    };
    const sanitized = await sanitizeToolResultImages(result, "browser:screenshot");
    const imageBlock = sanitized.content.find((b) => b.type === "image");
    expect(imageBlock).toBeDefined();
    expect(typeof (imageBlock as { data: string }).data).toBe("string");
    expect((imageBlock as { data: string }).data.length).toBeGreaterThan(0);
    expect(typeof (imageBlock as { mimeType: string }).mimeType).toBe("string");
  });

  it("screenshot-shaped tool result with malformed image produces text fallback", async () => {
    const result = {
      content: [
        {
          type: "image" as const,
          data: undefined as unknown as string,
          mimeType: undefined as unknown as string,
        },
      ],
      details: {},
    };
    const sanitized = await sanitizeToolResultImages(result, "browser:screenshot");
    const imageBlocks = sanitized.content.filter((b) => b.type === "image");
    expect(imageBlocks).toHaveLength(0);
    const textFallback = sanitized.content.find(
      (b) => b.type === "text" && (b as { text: string }).text.includes("missing data or mimeType"),
    );
    expect(textFallback).toBeDefined();
  });

  it("drops malformed image base64 payloads", async () => {
    // Invalid base64 is replaced with text so malformed payloads cannot smuggle
    // attributes or script-like text through image blocks.
    const blocks = [
      {
        type: "image" as const,
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2N4j8AAAAASUVORK5CYII=" onerror="alert(1)',
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toEqual([
      {
        type: "text",
        text: "[test] omitted image payload: invalid base64",
      },
    ]);
  });
});
