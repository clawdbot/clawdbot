import { beforeEach, describe, expect, it, vi } from "vitest";

const { canvasSizes, pdfDocument } = vi.hoisted(() => ({
  canvasSizes: [] as Array<{ width: number; height: number }>,
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
  getDocument: vi.fn(() => ({ promise: Promise.resolve(pdfDocument) })),
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

describe("PDF document extractor", () => {
  beforeEach(() => {
    canvasSizes.length = 0;
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
});
