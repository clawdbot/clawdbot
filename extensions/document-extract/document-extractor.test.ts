// Document Extract tests cover document extractor plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { createEngineMock, openPdfMock, pdfDocument } = vi.hoisted(() => ({
  createEngineMock: vi.fn(),
  openPdfMock: vi.fn(),
  pdfDocument: {
    pageCount: 2,
    extract: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("clawpdf", () => ({
  createEngine: createEngineMock,
}));

import { createPdfDocumentExtractor } from "./document-extractor.js";

function request(overrides = {}) {
  return {
    buffer: Buffer.from("%PDF-1.4"),
    mimeType: "application/pdf",
    maxPages: 2,
    maxPixels: 100,
    minTextChars: 10,
    ...overrides,
  };
}

describe("PDF document extractor", () => {
  afterAll(() => {
    vi.doUnmock("clawpdf");
    vi.resetModules();
  });

  beforeEach(() => {
    createEngineMock.mockResolvedValue({ open: openPdfMock });
    openPdfMock.mockReset();
    openPdfMock.mockResolvedValue(pdfDocument);
    pdfDocument.pageCount = 2;
    pdfDocument.extract.mockReset();
    pdfDocument.destroy.mockReset();
  });

  it("declares PDF support", () => {
    const extractor = createPdfDocumentExtractor();
    const { extract, ...descriptor } = extractor;
    expect(extract).toBeInstanceOf(Function);
    expect(descriptor).toEqual({
      id: "pdf",
      label: "PDF",
      mimeTypes: ["application/pdf"],
      autoDetectOrder: 10,
    });
  });

  it("extracts text first and renders each fallback page with its own pixel budget", async () => {
    pdfDocument.extract
      .mockResolvedValueOnce({ text: "", images: [] })
      .mockResolvedValueOnce({
        text: "",
        images: [
          {
            type: "image",
            bytes: Uint8Array.from(Buffer.from("png1")),
            mimeType: "image/png",
            page: 1,
            width: 5,
            height: 10,
          },
        ],
      })
      .mockResolvedValueOnce({
        text: "",
        images: [
          {
            type: "image",
            bytes: Uint8Array.from(Buffer.from("png2")),
            mimeType: "image/png",
            page: 2,
            width: 5,
            height: 10,
          },
        ],
      });
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request());

    if (!result) {
      throw new Error("Expected PDF extraction result");
    }
    expect(openPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(1, {
      mode: "text",
      maxPages: 2,
      maxTextChars: 200_000,
    });
    // Each page renders in its own extract() call, with the aggregate pixel cap
    // allocated across selected pages so later pages are not starved.
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(2, {
      mode: "images",
      pages: [1],
      image: { maxDimension: 10_000, maxPixels: 50, forms: true },
    });
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(3, {
      mode: "images",
      pages: [2],
      image: { maxDimension: 10_000, maxPixels: 50, forms: true },
    });
    expect(result).toEqual({
      text: "",
      images: [
        { type: "image", data: "cG5nMQ==", mimeType: "image/png" },
        { type: "image", data: "cG5nMg==", mimeType: "image/png" },
      ],
    });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("skips image fallback when enough text is extracted", async () => {
    pdfDocument.extract.mockResolvedValueOnce({ text: "enough text", images: [] });
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request({ minTextChars: 5 }));

    expect(result).toEqual({ text: "enough text", images: [] });
    expect(pdfDocument.extract).toHaveBeenCalledTimes(1);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("opens encrypted PDFs with the request password", async () => {
    pdfDocument.extract.mockResolvedValueOnce({ text: "enough text", images: [] });
    const extractor = createPdfDocumentExtractor();

    await extractor.extract(request({ password: "secret" }));

    expect(openPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array), { password: "secret" });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("normalizes clawpdf password errors", async () => {
    openPdfMock.mockRejectedValueOnce(
      Object.assign(new Error("bad password"), { code: "password" }),
    );
    const extractor = createPdfDocumentExtractor();

    await expect(extractor.extract(request({ password: "wrong" }))).rejects.toThrow(
      "PDF requires a password or password is incorrect.",
    );
    expect(pdfDocument.destroy).not.toHaveBeenCalled();
  });

  it("filters selected pages and renders them one page per image call", async () => {
    pdfDocument.extract
      .mockResolvedValueOnce({ text: "", images: [] })
      .mockResolvedValueOnce({ text: "", images: [] })
      .mockResolvedValueOnce({ text: "", images: [] });
    const extractor = createPdfDocumentExtractor();

    await extractor.extract(request({ pageNumbers: [3, 2, 0, 1], maxPages: 2 }));

    expect(pdfDocument.extract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mode: "text", pages: [2, 1] }),
    );
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: "images", pages: [2] }),
    );
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ mode: "images", pages: [1] }),
    );
  });

  it("reports image fallback failures and returns extracted text", async () => {
    const onImageExtractionError = vi.fn();
    const failure = new Error("render failed");
    pdfDocument.extract
      .mockResolvedValueOnce({ text: "short", images: [] })
      .mockRejectedValueOnce(failure);
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request({ onImageExtractionError }));

    expect(result).toEqual({ text: "short", images: [] });
    expect(onImageExtractionError).toHaveBeenCalledWith(failure);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });
});
