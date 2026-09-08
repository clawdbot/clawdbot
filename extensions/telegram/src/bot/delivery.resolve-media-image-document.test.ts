import fs from "node:fs/promises";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it } from "vitest";
import { resolveMedia } from "./delivery.resolve-media.js";
import type { TelegramContext } from "./types.js";

// Complete 1x1 images, not just MIME signatures: the store must inspect real bytes.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");

describe("Telegram downloaded image documents", () => {
  it.each([
    {
      label: "a PNG document",
      bytes: PNG,
      fileName: "diagram.png",
      mimeType: "image/png",
      contentType: "image/png",
      kind: "image",
    },
    {
      label: "a JPEG document with generic metadata",
      bytes: JPEG,
      fileName: "upload.bin",
      mimeType: "application/octet-stream",
      contentType: "image/jpeg",
      kind: "image",
    },
    {
      label: "a PDF document",
      bytes: PDF,
      fileName: "report.pdf",
      mimeType: "application/pdf",
      contentType: "application/pdf",
      kind: "document",
    },
    {
      label: "a plain-text document",
      bytes: Buffer.from("These are document notes.\n"),
      fileName: "notes.txt",
      mimeType: "text/plain",
      contentType: "text/plain",
      kind: "document",
    },
    {
      label: "PDF bytes mislabeled as an image",
      bytes: PDF,
      fileName: "report.png",
      mimeType: "image/png",
      contentType: "application/pdf",
      kind: "document",
    },
  ])("preserves the detected media kind for $label", async (fixture) => {
    await withOpenClawTestState({ label: "telegram-image-document" }, async (state) => {
      const sourcePath = state.path(fixture.fileName);
      await fs.writeFile(sourcePath, fixture.bytes);
      const fileId = "document-fixture";
      const ctx: TelegramContext = {
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 1, type: "private", first_name: "Fixture" },
          document: {
            file_id: fileId,
            file_unique_id: fileId,
            file_name: fixture.fileName,
            mime_type: fixture.mimeType,
          },
        },
        getFile: async () => ({
          file_id: fileId,
          file_unique_id: fileId,
          file_path: sourcePath,
        }),
      };
      const result = await resolveMedia({
        ctx,
        token: "12345:fixture-token",
        maxBytes: 1_024,
        trustedLocalFileRoots: [state.root],
      });

      expect(result).not.toBeNull();
      if (!result) {
        throw new Error("Expected the document to be saved");
      }
      expect(result.path).not.toBe(sourcePath);
      expect(await fs.readFile(result.path)).toEqual(fixture.bytes);
      expect(result).toMatchObject({
        contentType: fixture.contentType,
        fileName: fixture.fileName,
        size: fixture.bytes.length,
        kind: fixture.kind,
      });
    });
  });
});
