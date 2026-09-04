import { describe, expect, it } from "vitest";
import { createPdfDocumentExtractor } from "./document-extractor.js";

function createPdf(pageTexts: string[]): Buffer {
  const pageObjects = pageTexts.map((_, index) => 4 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageObjects.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, rawText] of pageTexts.entries()) {
    const pageObject = pageObjects[index];
    if (!pageObject) {
      throw new Error("missing page object");
    }
    const contentObject = pageObject + 1;
    const content = `BT\n/F1 12 Tf\n72 720 Td\n(${rawText.replace(/[\\()]/gu, "\\$&")}) Tj\nET\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObject} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

describe("PDF document extractor completeness", () => {
  it("reports pages omitted by the automatic page budget", async () => {
    const result = await createPdfDocumentExtractor().extract({
      buffer: createPdf(
        Array.from({ length: 21 }, (_, index) =>
          index === 20 ? "CORRECTION: REJECTED" : `PAGE ${index + 1}`,
        ),
      ),
      mimeType: "application/pdf",
      maxPages: 20,
      maxPixels: 1_000_000,
      minTextChars: 1,
    });

    expect(result).toMatchObject({
      text: expect.not.stringContaining("CORRECTION: REJECTED"),
      metadata: {
        pages: {
          processed: Array.from({ length: 20 }, (_, index) => index + 1),
          total: 21,
          selection: "automatic",
          truncated: true,
        },
        textTruncated: false,
      },
    });
  });

  it("extracts page 21 when the page budget is one selected page", async () => {
    const result = await createPdfDocumentExtractor().extract({
      buffer: createPdf(Array.from({ length: 21 }, (_, index) => `PAGE ${index + 1}`)),
      mimeType: "application/pdf",
      pageNumbers: [21],
      maxPages: 1,
      maxPixels: 1_000_000,
      minTextChars: 1,
    });

    expect(result).toMatchObject({
      text: "PAGE 21",
      metadata: {
        pages: {
          processed: [21],
          total: 21,
          selection: "explicit",
          truncated: false,
        },
        textTruncated: false,
      },
    });
  });
});
