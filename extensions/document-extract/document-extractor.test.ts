// Document Extract tests cover document extractor plugin behavior.
import JSZip from "jszip";
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

import {
  createDocxDocumentExtractor,
  createPdfDocumentExtractor,
  createPptxDocumentExtractor,
  createXlsxDocumentExtractor,
} from "./document-extractor.js";

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

    const result = await extractor.extract(request({ pageNumbers: [3, 2, 0, 1], maxPages: 2 }));

    expect(result).toEqual({ text: "", images: [] });
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
    pdfDocument.extract.mockResolvedValueOnce({ text: "", images: [] });
    const extractor = createPdfDocumentExtractor();

    await expect(extractor.extract(request({ pageNumbers: [2] }))).rejects.toThrow(
      "No requested PDF pages exist in this 1-page document.",
    );
    expect(pdfDocument.extract).not.toHaveBeenCalled();
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);

    await expect(extractor.extract(request({ pageNumbers: [] }))).resolves.toEqual({
      text: "",
      images: [],
    });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(2);
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

  it.each([
    { label: "empty", text: "", reportError: true },
    { label: "whitespace-only", text: " \t\n", reportError: false },
  ])("surfaces image fallback failures for $label PDF text", async ({ text, reportError }) => {
    const { PdfBudgetError } = await vi.importActual<typeof import("clawpdf")>("clawpdf");
    const onImageExtractionError = vi.fn();
    const failure = new PdfBudgetError("renderPixels", 100);
    pdfDocument.extract.mockResolvedValueOnce({ text, images: [] }).mockRejectedValueOnce(failure);
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

describe("Office document extractors", () => {
  async function createDocx(parts: Record<string, string>): Promise<Buffer> {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    for (const [name, content] of Object.entries(parts)) {
      zip.file(name, content);
    }
    return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
  }

  it("declares DOCX support", () => {
    const extractor = createDocxDocumentExtractor();
    const { extract, ...descriptor } = extractor;
    expect(extract).toBeInstanceOf(Function);
    expect(descriptor).toEqual({
      id: "docx",
      label: "DOCX",
      mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      autoDetectOrder: 20,
    });
  });

  it("extracts paragraph and table text from a DOCX package", async () => {
    const buffer = await createDocx({
      "word/document.xml": [
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
        "<w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r><w:r><w:tab/><w:t>Debra</w:t></w:r></w:p>",
        "<w:p><w:r><w:t>Katherine homework</w:t></w:r><w:r><w:br/><w:t>page two</w:t></w:r></w:p>",
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Score</w:t></w:r></w:p></w:tc></w:tr>",
        "<w:tr><w:tc><w:p><w:r><w:t>Katherine</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
        "</w:body></w:document>",
      ].join(""),
    });

    await expect(
      createDocxDocumentExtractor().extract(
        request({
          buffer,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      ),
    ).resolves.toEqual({
      text: "Hello & welcome\tDebra\nKatherine homework\npage two\nTable\nName\tScore\nKatherine\t100",
      images: [],
    });
  });

  it("extracts worksheet rows from an XLSX package", async () => {
    const buffer = await createDocx({
      "xl/workbook.xml": [
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>',
        '<sheet name="Meal Plan" r:id="rId1"/>',
        "</sheets></workbook>",
      ].join(""),
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml": [
        "<sst><si><t>Item</t></si><si><t>Count</t></si><si><t>Muffins</t></si></sst>",
      ].join(""),
      "xl/worksheets/sheet1.xml": [
        "<worksheet><sheetData>",
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>',
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>12</v></c></row>',
        "</sheetData></worksheet>",
      ].join(""),
    });

    await expect(
      createXlsxDocumentExtractor().extract(
        request({
          buffer,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      ),
    ).resolves.toEqual({
      text: "Meal Plan\nrow\tvalues\n1\tItem\t\tCount\n2\tMuffins\t\t12",
      images: [],
    });
  });

  it("extracts slide and speaker-note text from a PPTX package", async () => {
    const drawing = (text: string) =>
      `<p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
    const buffer = await createDocx({
      "ppt/slides/slide1.xml": drawing("Lesson &amp; practice"),
      "ppt/notesSlides/notesSlide1.xml": drawing("Teacher note"),
    });

    await expect(
      createPptxDocumentExtractor().extract(
        request({
          buffer,
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }),
      ),
    ).resolves.toEqual({
      text: "Slide 1 (ppt/slides/slide1.xml)\nLesson & practice\n\nNotes 1 (ppt/notesSlides/notesSlide1.xml)\nTeacher note",
      images: [],
    });
  });

  it("includes comments, footnotes, endnotes, headers, and footers", async () => {
    const xml = (text: string) =>
      `<w:root xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:root>`;
    const buffer = await createDocx({
      "word/document.xml": xml("body"),
      "word/footnotes.xml": xml("footnote"),
      "word/endnotes.xml": xml("endnote"),
      "word/comments.xml": xml("comment"),
      "word/header2.xml": xml("header"),
      "word/footer1.xml": xml("footer"),
    });

    await expect(
      createDocxDocumentExtractor().extract(
        request({
          buffer,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      ),
    ).resolves.toEqual({
      text: "body\nfootnote\nendnote\ncomment\nfooter\nheader",
      images: [],
    });
  });
});
