import { describe, expect, it } from "vitest";
import { extractDocumentContent } from "../../../../src/media/document-extractors.runtime.js";
import { extractPdfContent } from "../../../../src/media/pdf-extract.js";
import { resolvePluginDocumentExtractors } from "../../../../src/plugins/document-extractors.runtime.js";

const SENTINEL = "OPENCLAW_PDF_DISPATCH_SENTINEL";

function createInlinePdf(text: string): Buffer {
  const escapedText = text.replace(/[\\()]/gu, "\\$&");
  const content = `BT
/F1 18 Tf
72 720 Td
(${escapedText}) Tj
ET
`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>
stream
${content}endstream`,
  ];

  let pdf = "%PDF-1.4\n% OpenClaw QA fixture\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj
${object}
endobj
`;
  }

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref
0 ${objects.length + 1}
`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer
<< /Size ${objects.length + 1} /Root 1 0 R >>
startxref
${xrefOffset}
%%EOF
`;
  return Buffer.from(pdf, "ascii");
}

describe("PDF document extraction dispatch", () => {
  it("uses the bundled PDF extractor and reports disabled extraction explicitly", async () => {
    const buffer = createInlinePdf(SENTINEL);
    const bundledPdfExtractor = resolvePluginDocumentExtractors().find(
      (extractor) => extractor.id === "pdf",
    );

    expect(bundledPdfExtractor).toMatchObject({
      id: "pdf",
      pluginId: "document-extract",
      mimeTypes: ["application/pdf"],
    });

    const extracted = await extractDocumentContent({
      buffer,
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 1_000_000,
      minTextChars: 1,
    });
    expect(extracted).toMatchObject({
      extractor: "pdf",
      text: SENTINEL,
      images: [],
    });

    await expect(
      extractPdfContent({
        buffer,
        maxPages: 1,
        maxPixels: 1_000_000,
        minTextChars: 1,
      }),
    ).resolves.toEqual({
      text: SENTINEL,
      images: [],
    });

    await expect(
      extractPdfContent({
        buffer,
        maxPages: 1,
        maxPixels: 1_000_000,
        minTextChars: 1,
        config: {
          plugins: {
            entries: {
              "document-extract": { enabled: false },
            },
          },
        },
      }),
    ).rejects.toThrow(
      "PDF extraction disabled or unavailable: enable the document-extract plugin to process application/pdf files.",
    );
  });
});
