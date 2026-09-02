// Whatsapp tests cover document filename plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveWhatsAppDocumentFileName } from "./document-filename.js";

describe("resolveWhatsAppDocumentFileName", () => {
  it("strips CRLF injection sequences from fileName", () => {
    expect(
      resolveWhatsAppDocumentFileName({
        fileName: "evil.pdf\r\nX-Injected: bad",
        mimetype: "application/pdf",
      }),
    ).toBe("evil.pdfX-Injected: bad");
  });

  it("strips C0 control characters and DEL from fileName", () => {
    expect(
      resolveWhatsAppDocumentFileName({
        fileName: "\x00evil\x1f\x7f.pdf",
        mimetype: "application/pdf",
      }),
    ).toBe("evil.pdf");
  });

  it("falls back to MIME-derived default when fileName collapses to empty after strip", () => {
    expect(
      resolveWhatsAppDocumentFileName({
        fileName: "\r\n\x00",
        mimetype: "application/pdf",
      }),
    ).toBe("file.pdf");
  });

  it("returns plain filename unchanged when no control characters present", () => {
    expect(
      resolveWhatsAppDocumentFileName({
        fileName: "document.pdf",
        mimetype: "application/pdf",
      }),
    ).toBe("document.pdf");
  });

  it("falls back to MIME-derived default when fileName is undefined", () => {
    expect(
      resolveWhatsAppDocumentFileName({
        mimetype: "application/pdf",
      }),
    ).toBe("file.pdf");
  });

  it("falls back to bare default when both fileName and mimetype are absent", () => {
    expect(resolveWhatsAppDocumentFileName({})).toBe("file");
  });
});
