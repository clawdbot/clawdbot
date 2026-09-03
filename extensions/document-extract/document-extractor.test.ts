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

function extractionResult(text: string, pagesProcessed = [1, 2]) {
  return {
    text,
    images: [],
    pagesProcessed,
    truncated: { text: false, images: false },
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
      .mockResolvedValueOnce(extractionResult(""))
      .mockResolvedValueOnce({
        text: "",
        pagesProcessed: [1],
        truncated: { text: false, images: false },
        images: [
          {
            type: "image",
            bytes: Uint8Array.from(Buffer.from("!png1?")).subarray(1, 5),
            mimeType: "image/png",
            page: 1,
            width: 5,
            height: 10,
          },
        ],
      })
      .mockResolvedValueOnce({
        text: "",
        pagesProcessed: [2],
        truncated: { text: false, images: false },
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

    const input = request({ buffer: Buffer.from("!%PDF-1.4?").subarray(1, -1) });
    const result = await extractor.extract(input);

    if (!result) {
      throw new Error("Expected PDF extraction result");
    }
    expect(openPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(Buffer.from(openPdfMock.mock.calls[0]?.[0] ?? [])).toEqual(input.buffer);
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
      metadata: {
        pages: {
          processed: [1, 2],
          total: 2,
          selection: "automatic",
          truncated: false,
        },
        textTruncated: false,
        imagesTruncated: false,
      },
    });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("skips image fallback when enough text is extracted", async () => {
    pdfDocument.pageCount = 21;
    pdfDocument.extract.mockResolvedValueOnce({
      text: "enough text",
      images: [],
      pagesProcessed: Array.from({ length: 20 }, (_, index) => index + 1),
      truncated: { text: true, images: false },
    });
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request({ minTextChars: 5 }));

    expect(result).toEqual({
      text: "enough text",
      images: [],
      metadata: {
        pages: {
          total: 21,
          processed: Array.from({ length: 20 }, (_, index) => index + 1),
          selection: "automatic",
          truncated: true,
        },
        textTruncated: true,
        imagesTruncated: false,
      },
    });
    expect(pdfDocument.extract).toHaveBeenCalledTimes(1);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("opens encrypted PDFs with the request password", async () => {
    pdfDocument.extract.mockResolvedValueOnce(extractionResult("enough text"));
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
      .mockResolvedValueOnce(extractionResult("", [2, 1]))
      .mockResolvedValueOnce(extractionResult("", [2]))
      .mockResolvedValueOnce(extractionResult("", [1]));
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request({ pageNumbers: [3, 2, 0, 1], maxPages: 2 }));

    expect(result).toMatchObject({
      text: "",
      images: [],
      metadata: { pages: { processed: [2, 1], selection: "explicit", truncated: true } },
    });
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

  it("rejects selected pages outside the PDF page count before extraction", async () => {
    pdfDocument.pageCount = 1;
    pdfDocument.extract.mockResolvedValueOnce(extractionResult("", [1]));
    const extractor = createPdfDocumentExtractor();

    await expect(extractor.extract(request({ pageNumbers: [2] }))).rejects.toThrow(
      "No requested PDF pages exist in this 1-page document.",
    );
    expect(pdfDocument.extract).not.toHaveBeenCalled();
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);

    await expect(extractor.extract(request({ pageNumbers: [] }))).resolves.toEqual({
      text: "",
      images: [],
      metadata: {
        pages: {
          processed: [1],
          total: 1,
          selection: "explicit",
          truncated: false,
        },
        textTruncated: false,
        imagesTruncated: false,
      },
    });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(2);
  });

  it("reports image fallback failures and returns extracted text", async () => {
    const onImageExtractionError = vi.fn();
    const failure = new Error("render failed");
    pdfDocument.extract
      .mockResolvedValueOnce(extractionResult("short"))
      .mockRejectedValueOnce(failure);
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request({ onImageExtractionError }));

    expect(result).toMatchObject({
      text: "short",
      images: [],
      metadata: { imagesTruncated: true },
    });
    expect(onImageExtractionError).toHaveBeenCalledWith(failure);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("records when the aggregate pixel budget stops image rendering early", async () => {
    pdfDocument.extract.mockResolvedValueOnce(extractionResult("short")).mockResolvedValueOnce({
      text: "",
      pagesProcessed: [1],
      truncated: { text: false, images: false },
      images: [
        {
          type: "image",
          bytes: Uint8Array.from(Buffer.from("page-one")),
          mimeType: "image/png",
          page: 1,
          width: 10,
          height: 10,
        },
      ],
    });

    const result = await createPdfDocumentExtractor().extract(request());

    expect(pdfDocument.extract).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      images: [{ type: "image", data: "cGFnZS1vbmU=", mimeType: "image/png" }],
      metadata: { imagesTruncated: true },
    });
  });

  it.each([
    { label: "empty", text: "", reportError: true },
    { label: "whitespace-only", text: " \t\n", reportError: false },
  ])("surfaces image fallback failures for $label PDF text", async ({ text, reportError }) => {
    const { PdfBudgetError } = await vi.importActual<typeof import("clawpdf")>("clawpdf");
    const onImageExtractionError = vi.fn();
    const failure = new PdfBudgetError("renderPixels", 100);
    pdfDocument.extract
      .mockResolvedValueOnce(extractionResult(text))
      .mockRejectedValueOnce(failure);
    const overrides = reportError ? { onImageExtractionError } : {};

    await expect(createPdfDocumentExtractor().extract(request(overrides))).rejects.toMatchObject({
      message: "PDF image extraction failed with no extractable text.",
      cause: failure,
    });
    expect(onImageExtractionError).toHaveBeenCalledTimes(reportError ? 1 : 0);
    if (reportError) {
      expect(onImageExtractionError).toHaveBeenCalledWith(failure);
    }
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });
});
