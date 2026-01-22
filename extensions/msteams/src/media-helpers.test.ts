import { describe, expect, it } from "vitest";

import { extractFilename, extractMessageId, getMimeType, isLocalPath } from "./media-helpers.js";

describe("msteams media-helpers", () => {
  describe("getMimeType", () => {
    it("detects png from URL", async () => {
      expect(await getMimeType("https://example.com/image.png")).toBe("image/png");
    });

    it("detects jpeg from URL (both extensions)", async () => {
      expect(await getMimeType("https://example.com/photo.jpg")).toBe("image/jpeg");
      expect(await getMimeType("https://example.com/photo.jpeg")).toBe("image/jpeg");
    });

    it("detects gif from URL", async () => {
      expect(await getMimeType("https://example.com/anim.gif")).toBe("image/gif");
    });

    it("detects webp from URL", async () => {
      expect(await getMimeType("https://example.com/modern.webp")).toBe("image/webp");
    });

    it("handles URLs with query strings", async () => {
      expect(await getMimeType("https://example.com/image.png?v=123")).toBe("image/png");
    });

    it("handles data URLs", async () => {
      expect(await getMimeType("data:image/png;base64,iVBORw0KGgo=")).toBe("image/png");
      expect(await getMimeType("data:image/jpeg;base64,/9j/4AAQ")).toBe("image/jpeg");
      expect(await getMimeType("data:image/gif;base64,R0lGOD")).toBe("image/gif");
    });

    it("handles data URLs without base64", async () => {
      expect(await getMimeType("data:image/svg+xml,%3Csvg")).toBe("image/svg+xml");
    });

    it("handles local paths", async () => {
      expect(await getMimeType("/tmp/image.png")).toBe("image/png");
      expect(await getMimeType("/Users/test/photo.jpg")).toBe("image/jpeg");
    });

    it("handles tilde paths", async () => {
      expect(await getMimeType("~/Downloads/image.gif")).toBe("image/gif");
    });

    it("defaults to application/octet-stream for unknown extensions", async () => {
      expect(await getMimeType("https://example.com/image")).toBe("application/octet-stream");
      expect(await getMimeType("https://example.com/image.unknown")).toBe("application/octet-stream");
    });

    it("is case-insensitive", async () => {
      expect(await getMimeType("https://example.com/IMAGE.PNG")).toBe("image/png");
      expect(await getMimeType("https://example.com/Photo.JPEG")).toBe("image/jpeg");
    });

    it("detects document types", async () => {
      expect(await getMimeType("https://example.com/doc.pdf")).toBe("application/pdf");
      expect(await getMimeType("https://example.com/doc.docx")).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      expect(await getMimeType("https://example.com/spreadsheet.xlsx")).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    });
  });

  describe("extractFilename", () => {
    it("extracts filename from URL with extension", async () => {
      expect(await extractFilename("https://example.com/photo.jpg")).toBe("photo.jpg");
    });

    it("extracts filename from URL with path", async () => {
      expect(await extractFilename("https://example.com/images/2024/photo.png")).toBe("photo.png");
    });

    it("handles URLs without extension by deriving from MIME", async () => {
      // Now defaults to application/octet-stream → .bin fallback
      expect(await extractFilename("https://example.com/images/photo")).toBe("photo.bin");
    });

    it("handles data URLs", async () => {
      expect(await extractFilename("data:image/png;base64,iVBORw0KGgo=")).toBe("image.png");
      expect(await extractFilename("data:image/jpeg;base64,/9j/4AAQ")).toBe("image.jpg");
    });

    it("handles document data URLs", async () => {
      expect(await extractFilename("data:application/pdf;base64,JVBERi0")).toBe("file.pdf");
    });

    it("handles local paths", async () => {
      expect(await extractFilename("/tmp/screenshot.png")).toBe("screenshot.png");
      expect(await extractFilename("/Users/test/photo.jpg")).toBe("photo.jpg");
    });

    it("handles tilde paths", async () => {
      expect(await extractFilename("~/Downloads/image.gif")).toBe("image.gif");
    });

    it("returns fallback for empty URL", async () => {
      expect(await extractFilename("")).toBe("file.bin");
    });

    it("extracts original filename from embedded pattern", async () => {
      // Pattern: {original}---{uuid}.{ext}
      expect(
        await extractFilename("/media/inbound/report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf"),
      ).toBe("report.pdf");
    });

    it("extracts original filename with uppercase UUID", async () => {
      expect(
        await extractFilename("/media/inbound/Document---A1B2C3D4-E5F6-7890-ABCD-EF1234567890.docx"),
      ).toBe("Document.docx");
    });

    it("falls back to UUID filename for legacy paths", async () => {
      // UUID-only filename (legacy format, no embedded name)
      expect(
        await extractFilename("/media/inbound/a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf"),
      ).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf");
    });

    it("handles --- in filename without valid UUID pattern", async () => {
      // foo---bar.txt (bar is not a valid UUID)
      expect(await extractFilename("/media/inbound/foo---bar.txt")).toBe("foo---bar.txt");
    });
  });

  describe("isLocalPath", () => {
    it("returns true for file:// URLs", () => {
      expect(isLocalPath("file:///tmp/image.png")).toBe(true);
      expect(isLocalPath("file://localhost/tmp/image.png")).toBe(true);
    });

    it("returns true for absolute paths", () => {
      expect(isLocalPath("/tmp/image.png")).toBe(true);
      expect(isLocalPath("/Users/test/photo.jpg")).toBe(true);
    });

    it("returns true for tilde paths", () => {
      expect(isLocalPath("~/Downloads/image.png")).toBe(true);
    });

    it("returns false for http URLs", () => {
      expect(isLocalPath("http://example.com/image.png")).toBe(false);
      expect(isLocalPath("https://example.com/image.png")).toBe(false);
    });

    it("returns false for data URLs", () => {
      expect(isLocalPath("data:image/png;base64,iVBORw0KGgo=")).toBe(false);
    });
  });

  describe("extractMessageId", () => {
    it("extracts id from valid response", () => {
      expect(extractMessageId({ id: "msg123" })).toBe("msg123");
    });

    it("returns null for missing id", () => {
      expect(extractMessageId({ foo: "bar" })).toBeNull();
    });

    it("returns null for empty id", () => {
      expect(extractMessageId({ id: "" })).toBeNull();
    });

    it("returns null for non-string id", () => {
      expect(extractMessageId({ id: 123 })).toBeNull();
      expect(extractMessageId({ id: null })).toBeNull();
    });

    it("returns null for null response", () => {
      expect(extractMessageId(null)).toBeNull();
    });

    it("returns null for undefined response", () => {
      expect(extractMessageId(undefined)).toBeNull();
    });

    it("returns null for non-object response", () => {
      expect(extractMessageId("string")).toBeNull();
      expect(extractMessageId(123)).toBeNull();
    });
  });
});
