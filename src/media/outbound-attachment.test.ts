// Outbound attachment tests cover media loading rules for outgoing messages.
import { describe, expect, it, vi } from "vitest";

const loadWebMedia = vi.hoisted(() => vi.fn());
const saveMediaBuffer = vi.hoisted(() => vi.fn());

vi.mock("./web-media.js", () => ({
  loadWebMedia,
}));

vi.mock("./store.js", () => ({
  saveMediaBuffer,
}));

const { resolveOutboundAttachmentFromBuffer, resolveOutboundAttachmentFromUrl } =
  await import("./outbound-attachment.js");

describe("resolveOutboundAttachmentFromUrl", () => {
  it("preserves the loaded file name when staging outbound media", async () => {
    const buffer = Buffer.from("pdf");
    loadWebMedia.mockResolvedValueOnce({
      buffer,
      contentType: "application/pdf",
      fileName: "report.pdf",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/media/outbound/report---uuid.pdf",
      contentType: "application/pdf",
    });

    await resolveOutboundAttachmentFromUrl("./report.pdf", 1024);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      buffer,
      "application/pdf",
      "outbound",
      1024,
      "report.pdf",
    );
  });
});

describe("resolveOutboundAttachmentFromBuffer", () => {
  it("stages outbound buffers with filename and content type metadata", async () => {
    const buffer = Buffer.from("hello");
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/media/outbound/note---uuid.txt",
      contentType: "text/plain",
    });

    const result = await resolveOutboundAttachmentFromBuffer(buffer, 1024, {
      contentType: "text/plain",
      filename: "note.txt",
    });

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      buffer,
      "text/plain",
      "outbound",
      1024,
      "note.txt",
    );
    expect(result).toEqual({
      path: "/tmp/media/outbound/note---uuid.txt",
      contentType: "text/plain",
    });
  });
});
