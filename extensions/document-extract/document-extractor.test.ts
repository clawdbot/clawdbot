import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { canvasSizes, getDocumentMock, pdfDocument } = vi.hoisted(() => ({
  canvasSizes: [] as Array<{ width: number; height: number }>,
  getDocumentMock: vi.fn(),
  pdfDocument: {
    numPages: 2,
    getPage: vi.fn(async () => ({
      getTextContent: vi.fn(async () => ({ items: [] })),
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 1000 * scale,
        height: 1000 * scale,
      })),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
    })),
  },
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: getDocumentMock,
}));

vi.mock("@napi-rs/canvas", () => ({
  createCanvas: vi.fn((width: number, height: number) => {
    canvasSizes.push({ width, height });
    return {
      toBuffer: vi.fn(() => Buffer.from("png")),
    };
  }),
}));

import { createPdfDocumentExtractor } from "./document-extractor.js";

const require = createRequire(import.meta.url);

describe("PDF document extractor", () => {
  afterAll(() => {
    vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
    vi.doUnmock("@napi-rs/canvas");
    vi.resetModules();
  });

  beforeEach(() => {
    canvasSizes.length = 0;
    getDocumentMock.mockReset();
    getDocumentMock.mockReturnValue({ promise: Promise.resolve(pdfDocument) });
    pdfDocument.getPage.mockClear();
  });

  it("declares PDF support", () => {
    const extractor = createPdfDocumentExtractor();
    expect(extractor).toMatchObject({
      id: "pdf",
      label: "PDF",
      mimeTypes: ["application/pdf"],
    });
  });

  it("treats maxPixels as a hard total image rendering budget", async () => {
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract({
      buffer: Buffer.from("%PDF-1.4"),
      mimeType: "application/pdf",
      maxPages: 2,
      maxPixels: 100,
      minTextChars: 10,
    });

    expect(result?.images).toHaveLength(1);
    expect(canvasSizes).toEqual([{ width: 10, height: 10 }]);
  });

  it("passes standardFontDataUrl to pdfjs getDocument as a package-root filesystem path", async () => {
    const extractor = createPdfDocumentExtractor();

    await extractor.extract({
      buffer: Buffer.from("%PDF-1.4"),
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 4_000_000,
      minTextChars: 200,
    });

    expect(getDocumentMock).toHaveBeenCalledTimes(1);
    const [params] = getDocumentMock.mock.calls[0] ?? [];
    expect(params).toMatchObject({
      disableWorker: true,
    });
    expect(typeof params.standardFontDataUrl).toBe("string");

    const expectedStandardFontDataUrl =
      path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + "/";
    expect(params.standardFontDataUrl).toBe(expectedStandardFontDataUrl);
    expect(path.isAbsolute(params.standardFontDataUrl)).toBe(true);
    expect(params.standardFontDataUrl.endsWith("/")).toBe(true);
    expect(params.standardFontDataUrl.startsWith("file://")).toBe(false);
    expect(existsSync(params.standardFontDataUrl)).toBe(true);
    expect(existsSync(path.join(params.standardFontDataUrl, "LiberationSans-Regular.ttf"))).toBe(
      true,
    );
  });
});
