// Outbound attachment tests cover media loading rules for outgoing messages.
import { afterEach, describe, expect, it, vi } from "vitest";

const loadWebMedia = vi.hoisted(() => vi.fn());
const markTrustedGeneratedHtmlPath = vi.hoisted(() => vi.fn());
const saveMediaBuffer = vi.hoisted(() => vi.fn());
const rm = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("node:fs/promises", () => ({ rm }));

vi.mock("./web-media.js", () => ({
  loadWebMedia,
  markTrustedGeneratedHtmlPath,
}));

vi.mock("./store.js", () => ({
  saveMediaBuffer,
}));

const { resolveOutboundAttachmentFromBuffer, resolveOutboundAttachmentFromUrl } =
  await import("./outbound-attachment.js");

afterEach(() => vi.clearAllMocks());

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
    expect(markTrustedGeneratedHtmlPath).not.toHaveBeenCalled();
  });

  it("marks staged trusted HTML with its exact bytes", async () => {
    const buffer = Buffer.from("<!doctype html><title>report</title>");
    loadWebMedia.mockResolvedValueOnce({
      buffer,
      contentType: "text/html",
      fileName: "report.html",
      trustedGeneratedHtmlSource: true,
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/media/outbound/report---uuid.html",
      contentType: "text/html",
    });

    await resolveOutboundAttachmentFromUrl("/tmp/openclaw/report.html", 1024);

    expect(markTrustedGeneratedHtmlPath).toHaveBeenCalledWith(
      "/tmp/media/outbound/report---uuid.html",
      buffer,
    );
  });

  it("removes the staged file and propagates marker write failures", async () => {
    const buffer = Buffer.from("<!doctype html><title>report</title>");
    const stagedPath = "/tmp/media/outbound/report---uuid.html";
    loadWebMedia.mockResolvedValueOnce({
      buffer,
      contentType: "text/html",
      trustedGeneratedHtmlSource: true,
    });
    saveMediaBuffer.mockResolvedValueOnce({ path: stagedPath, contentType: "text/html" });
    markTrustedGeneratedHtmlPath.mockRejectedValueOnce(new Error("marker write failed"));

    await expect(
      resolveOutboundAttachmentFromUrl("/tmp/openclaw/report.html", 1024),
    ).rejects.toThrow("marker write failed");
    expect(rm).toHaveBeenCalledWith(stagedPath, { force: true });
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
