// Tool image logging tests cover diagnostic context emitted while sanitizing
// oversized or transformed image payloads.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { imageResultFromFile } from "../plugin-sdk/channel-actions.js";

const { infoMock, resizeToJpegMock, warnMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  resizeToJpegMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => {
  const makeLogger = () => ({
    subsystem: "agents/tool-images",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: infoMock,
    warn: warnMock,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => makeLogger(),
  });
  return { createSubsystemLogger: () => makeLogger() };
});

vi.mock("../media/media-services.js", () => ({
  buildImageResizeSideGrid: () => [2000],
  getImageMetadata: vi.fn(),
  IMAGE_REDUCE_QUALITY_STEPS: [85],
  isImageProcessorUnavailableError: () => false,
  MAX_IMAGE_INPUT_PIXELS: 25_000_000,
  readImageMetadataFromHeader: () => ({ width: 2001, height: 8 }),
  resizeToJpeg: resizeToJpegMock,
}));

import { sanitizeContentBlocksImages } from "./tool-images.js";

async function createLargePng(): Promise<Buffer> {
  return createSolidPngBuffer(2001, 8, { r: 0x7f, g: 0x7f, b: 0x7f });
}

describe("tool-images log context", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let png: Buffer;

  beforeAll(async () => {
    png = await createLargePng();
  });

  beforeEach(() => {
    infoMock.mockClear();
    resizeToJpegMock.mockReset();
    resizeToJpegMock.mockResolvedValue(Buffer.alloc(100, 2));
    warnMock.mockClear();
  });

  it.each([
    { maxBytes: 512, outputBytes: 768, limit: "512B", actual: "768B" },
    { maxBytes: 256 * 1024, outputBytes: 512 * 1024, limit: "256.0KB", actual: "512.0KB" },
    {
      maxBytes: 1.5 * 1024 * 1024,
      outputBytes: 2 * 1024 * 1024,
      limit: "1.50MB",
      actual: "2.00MB",
    },
  ])(
    "reports the effective SDK image cap of $limit",
    async ({ maxBytes, outputBytes, limit, actual }) => {
      const filePath = path.join(tempDirs.make("tool-image-cap-"), "sample.png");
      await writeFile(filePath, png);
      resizeToJpegMock.mockResolvedValue(Buffer.alloc(outputBytes, 2));

      const result = await imageResultFromFile({
        label: "sdk:image",
        path: filePath,
        extraText: "image caption",
        details: { media: { outbound: false } },
        imageSanitization: { maxBytes },
      });

      expect(result.content).toEqual([
        { type: "text", text: "image caption" },
        {
          type: "text",
          text: `[sdk:image] omitted image payload: Error: Image could not be reduced below ${limit} (got ${actual})`,
        },
      ]);
      expect(result.details).toMatchObject({
        path: filePath,
        media: { outbound: false, mediaUrl: filePath },
      });
    },
  );

  it("includes filename from read label", async () => {
    const blocks = [
      { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
    ];
    await sanitizeContentBlocksImages(blocks, "read:/tmp/images/sample-diagram.png");
    const messages = infoMock.mock.calls.map((call) => String(call[0] ?? ""));
    expect(messages.join("\n")).toContain("sample-diagram.png");
  });

  it.each([
    { sourceBytes: 200, outputBytes: 150, pct: 25, label: "-25%" },
    { sourceBytes: 200, outputBytes: 200, pct: 0, label: "0%" },
    { sourceBytes: 200, outputBytes: 250, pct: -25, label: "+25%" },
    { sourceBytes: 3, outputBytes: 2, pct: 33.3, label: "-33.3%" },
  ])("logs the signed byte delta for $label", async ({ sourceBytes, outputBytes, pct, label }) => {
    resizeToJpegMock.mockResolvedValue(Buffer.alloc(outputBytes, 2));
    const blocks = [
      {
        type: "image" as const,
        data: Buffer.alloc(sourceBytes, 1).toString("base64"),
        mimeType: "image/png",
      },
    ];
    await sanitizeContentBlocksImages(blocks, "read:/tmp/images/sample-diagram.png");
    const [message, context] = infoMock.mock.calls.at(-1) ?? [];
    expect(message).toContain(`sample-diagram.png 2001x8px`);
    expect(message).toContain(`(${label})`);
    expect(message).not.toContain("(--");
    expect(context).toMatchObject({
      fileName: "sample-diagram.png",
      sourceBytes,
      outputBytes,
      byteReductionPct: pct,
    });
  });
});
